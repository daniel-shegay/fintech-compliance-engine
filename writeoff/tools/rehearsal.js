#!/usr/bin/env node
'use strict';

// ----------------------------------------------------------------------------
// Репетиция без сети. Прогоняет те же кодовые пути, что и CLI, но с подставным
// fetch — чтобы увидеть формат вывода и поведение гардов, не трогая прод.
//
//   node tools/rehearsal.js
//
// Это инструмент разработчика, а не часть модуля: боевой код его не требует.
// ----------------------------------------------------------------------------

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { normalize } = require('../src/exportReader');
const { buildBalance, listDebtors } = require('../src/balance');
const { computePlan } = require('../src/plan');
const { applyPlan } = require('../src/apply');
const { formatPlan, formatProbe, formatApply } = require('../src/report');
const { toMinor, fromMinor } = require('../src/money');
const { config } = require('../src/config');
const { assocEnvelope, fakeFetch } = require('../test/fixtures');

const cfg = { ...config, API_KEY: 'rehearsal-key' };

// Кредит 1026701: долг разложен по корзинам так, что сумма сходится с debt.
const LIVE_CREDIT = {
  id: '1026701',
  l_tax10: '1500.00',
  l_tax8: '2000.00',
  l_tax6: '1500.00',
  l_tax5: '500.00',
  l_tax4: '500.00',
  l_tax3: '500.00',
  l_tax2: '500.00',
  l_cinterest: '705.33',
  l_late_fee: '2208.00',
  l_interest: '1798.00',        // остаток Cena
  r_charge: '1798.00',          // начисленная Cena, справочно
  l_amount: '22500.00',
  writeoff: '28836.67',
};

const OTHER_CREDIT = { id: '1012471', l_amount: '0.00' };

function head(title) {
  console.log(`\n${'═'.repeat(74)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(74)}\n`);
}

function balanceOf(overrides) {
  return buildBalance(normalize(assocEnvelope([overrides]).data)[0]);
}

async function main() {
  const auditDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehearsal-audit-'));

  // ── 1. probe без --credit ────────────────────────────────────────────────
  head('probe --customer 189463');
  const rows = normalize(assocEnvelope([OTHER_CREDIT, LIVE_CREDIT]).data);
  const debtors = listDebtors(rows);
  console.log(`Клиент 189463: строк в экспорте ${rows.length}, с долгом ${debtors.length}`);
  for (const entry of debtors) {
    console.log(`  кредит ${entry.creditId}  долг ${fromMinor(entry.debt)}`);
  }

  // ── 2. probe с --credit ──────────────────────────────────────────────────
  head('probe --customer 189463 --credit 1026701');
  const balance = balanceOf(LIVE_CREDIT);
  console.log(formatProbe(balance));

  // ── 3. preview ───────────────────────────────────────────────────────────
  head('preview --customer 189463 --credit 1026701 --target 25000');
  const plan = computePlan({
    balance,
    target: toMinor('25000'),
    notes: '2026-09-03 - mam DoN, splatkovy kalendar',
  });
  console.log(formatPlan(plan));

  // ── 4. apply без --live ──────────────────────────────────────────────────
  head('apply ... --target 25000        (без --live)');
  const dry = await applyPlan(plan, { cfg, auditDir, fetchImpl: fakeFetch([]) });
  console.log(formatApply(dry));

  // ── 5. apply --live ──────────────────────────────────────────────────────
  head('apply ... --target 25000 --live');
  const afterOk = assocEnvelope([{ ...LIVE_CREDIT, ...zeroed(), l_amount: '25000.00' }]);
  const live = await applyPlan(plan, {
    cfg,
    auditDir,
    live: true,
    actor: 'demo_operator',
    fetchImpl: fakeFetch([
      { status: 200, data: { writeoffId: '81495', status: 'success' } },
      afterOk,
    ]),
  });
  console.log(formatApply(live));

  // ── 6. повторный запуск того же ──────────────────────────────────────────
  head('apply ... --live        (повторно, тот же план — по умолчанию проходит)');
  const again = await applyPlan(plan, {
    cfg,
    auditDir,
    live: true,
    fetchImpl: fakeFetch([
      { status: 200, data: { writeoffId: '81496', status: 'success' } },
      afterOk,
    ]),
  });
  console.log(formatApply(again));
  console.log('\nОтказ по идемпотентности выключен: CRM сам не даёт');
  console.log('провести один и тот же отпис дважды, ответит invalidAmount.');

  // ── 6b. то же, но с включённым флагом ────────────────────────────────────
  head('apply ... --live        (повторно, CREDITGO_IDEMPOTENCY_GUARD=true)');
  const refused = await applyPlan(plan, {
    cfg, auditDir, live: true, idempotencyGuard: true, fetchImpl: fakeFetch([]),
  });
  console.log(formatApply(refused));

  // ── 7. заблокированный план ──────────────────────────────────────────────
  head('preview на кредите, где сумма корзин не сходится с debt');
  const broken = balanceOf({ id: '999', l_amount: '10000.00', l_interest: '480.00', debt: '10480.00' });
  console.log(formatPlan(computePlan({ balance: broken, target: toMinor('5000') })));

  // ── 8. апи сказал success, а долг не сошёлся ─────────────────────────────
  head('apply --live, но после проводки долг не равен target');
  const planB = computePlan({ balance: balanceOf({ ...LIVE_CREDIT, id: '777' }), target: toMinor('25000') });
  const afterBad = assocEnvelope([{ ...LIVE_CREDIT, id: '777', ...zeroed(), l_amount: '26000.00' }]);
  const bad = await applyPlan(planB, {
    cfg,
    auditDir,
    live: true,
    fetchImpl: fakeFetch([
      { status: 200, data: { writeoffId: '81496', status: 'success' } },
      afterBad,
    ]),
  });
  console.log(formatApply(bad));

  // ── 9. аудит-лог ─────────────────────────────────────────────────────────
  head('аудит-лог за всю репетицию');
  const log = await fsp.readFile(path.join(auditDir, 'writeoff.jsonl'), 'utf8');
  for (const line of log.trim().split('\n')) {
    const e = JSON.parse(line);
    console.log(`${e.ts}  ${String(e.event).padEnd(9)} credit=${e.creditId} ` +
      `amount=${e.amount !== undefined ? fromMinor(e.amount) : '—'} ` +
      `${e.writeoffId ? `writeoffId=${e.writeoffId}` : ''}` +
      `${e.debtAfter !== undefined ? ` debtAfter=${fromMinor(e.debtAfter)}` : ''}`);
  }

  await fsp.rm(auditDir, { recursive: true, force: true });
}

// После отписа все корзины кроме тела гасятся. r_charge при этом НЕ меняется —
// он начисленная сумма, а не остаток (см. комментарий в src/buckets.js).
function zeroed() {
  const out = {};
  for (let i = 1; i <= 12; i += 1) out[`l_tax${i}`] = '0.00';
  out.l_cinterest = '0.00';
  out.l_late_fee = '0.00';
  out.l_interest = '0.00';
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

'use strict';

// ----------------------------------------------------------------------------
// Текстовый вывод. Вынесен отдельно, чтобы plan/apply возвращали данные,
// а не строки: тот же план потом отрисует веб-интерфейс.
// ----------------------------------------------------------------------------

const { fromMinor } = require('./money');
const { ORDER, SOURCE_COLUMN } = require('./buckets');

const SEVERITY_MARK = { error: '✗', warning: '!' };

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(text, width) {
  const s = String(text);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function formatFindings(findings) {
  if (!findings.length) return ['Гарды: чисто'];
  const lines = ['Гарды:'];
  for (const f of findings) {
    lines.push(`  ${SEVERITY_MARK[f.severity] || '·'} [${f.code}] ${f.message}`);
  }
  return lines;
}

function formatPlan(plan) {
  const lines = [];
  lines.push(`Клиент ${plan.customerId}, кредит ${plan.creditId}`);
  lines.push(`Долг сейчас:      ${padLeft(fromMinor(plan.debtBefore), 12)}`);
  lines.push(`Целевой остаток:  ${padLeft(fromMinor(plan.target), 12)}`);
  lines.push(`К отпису:         ${padLeft(fromMinor(plan.amount), 12)}`);
  lines.push(`Ёмкость корзин:   ${padLeft(fromMinor(plan.capacity), 12)}`);
  if (plan.shortfall > 0) {
    lines.push(`НЕ РАЗЛОЖЕНО:     ${padLeft(fromMinor(plan.shortfall), 12)}`);
  }
  lines.push('');
  lines.push(`${pad('корзина', 12)}${pad('столбец', 22)}${padLeft('остаток', 12)}${padLeft('к отпису', 12)}${padLeft('останется', 12)}`);
  lines.push('-'.repeat(70));

  for (const bucket of ORDER) {
    const available = plan.buckets[bucket] ?? 0;
    const taken = plan.allocation[bucket] ?? 0;
    if (available === 0 && taken === 0) continue;
    lines.push(
      pad(bucket, 12) +
      pad(SOURCE_COLUMN[bucket], 22) +
      padLeft(fromMinor(available), 12) +
      padLeft(taken ? fromMinor(taken) : '—', 12) +
      padLeft(fromMinor(available - taken), 12),
    );
  }

  lines.push('-'.repeat(70));
  lines.push(
    pad('итого', 34) +
    padLeft(fromMinor(plan.capacity), 12) +
    padLeft(fromMinor(plan.allocated), 12) +
    padLeft(fromMinor(plan.debtAfterExpected), 12),
  );
  lines.push('');
  lines.push(...formatFindings(plan.findings));
  lines.push('');
  lines.push(`Ключ идемпотентности: ${plan.idempotencyKey}`);
  lines.push(plan.ok ? 'Статус: план можно применять' : 'Статус: ПРИМЕНЕНИЕ ЗАБЛОКИРОВАНО');
  return lines.join('\n');
}

function formatApply(result) {
  const lines = [`Результат: ${result.status}`];
  if (result.message) lines.push(result.message);
  if (result.writeoffId) lines.push(`writeoffId: ${result.writeoffId}`);
  if (result.payload) {
    lines.push('');
    lines.push('Отправленные поля:');
    for (const [key, value] of Object.entries(result.payload)) {
      lines.push(`  ${pad(key, 20)} ${value}`);
    }
  }
  return lines.join('\n');
}

// probe печатает всё, из чего можно собрать долг — чтобы сверить карту
// столбцов глазами до первой боевой проводки.
function formatProbe(balance) {
  const lines = [];
  lines.push(`Клиент ${balance.customerId}, кредит ${balance.creditId}`);
  lines.push(`debt = ${fromMinor(balance.debt)}   (r_debt = ${balance.meta.r_debt ?? '—'})`);
  lines.push('');
  lines.push('Корзины водопада:');
  for (const bucket of ORDER) {
    lines.push(`  ${pad(bucket, 12)}${pad(SOURCE_COLUMN[bucket], 22)}${padLeft(fromMinor(balance.buckets[bucket] ?? 0), 12)}`);
  }
  lines.push(`  ${pad('СУММА', 34)}${padLeft(fromMinor(balance.bucketSum), 12)}`);
  lines.push(`  ${pad('debt', 34)}${padLeft(fromMinor(balance.debt), 12)}`);
  lines.push(`  ${pad('расхождение', 34)}${padLeft(fromMinor(balance.bucketSum - balance.debt), 12)}`);

  const diag = Object.entries(balance.diagnostics || {});
  if (diag.length) {
    lines.push('');
    lines.push('Справочно (в водопад и сверку НЕ входят):');
    for (const [column, value] of diag) {
      lines.push(`  ${pad(column, 34)}${padLeft(value.raw, 12)}`);
    }
    lines.push('  r_charge — начисленная Cena, при отписе не уменьшается.');
    lines.push('  Остаток Cena берётся из l_interest (корзина charge выше).');
  }

  const out = Object.entries(balance.outOfWaterfall);
  lines.push('');
  if (out.length === 0) {
    lines.push('Остатков вне водопада нет.');
  } else {
    lines.push('Остатки ВНЕ водопада (в отпис не попадут):');
    for (const [column, value] of out) {
      lines.push(`  ${pad(column, 34)}${padLeft(fromMinor(value), 12)}`);
    }
  }

  if (balance.missingColumns.length) {
    lines.push('');
    lines.push(`Столбцов нет в экспорте: ${balance.missingColumns.map((m) => m.column).join(', ')}`);
  }

  lines.push('');
  lines.push('Служебные поля:');
  for (const [key, value] of Object.entries(balance.meta)) {
    lines.push(`  ${pad(key, 20)} ${value}`);
  }
  return lines.join('\n');
}

module.exports = { formatPlan, formatApply, formatProbe, formatFindings };

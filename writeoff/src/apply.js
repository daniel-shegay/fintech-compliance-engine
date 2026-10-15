'use strict';

// ----------------------------------------------------------------------------
// Единственное место в модуле, которое отправляет POST и двигает деньги.
//
// Правила, зашитые намеренно жёстко:
//   * dry-run по умолчанию. Реальная отправка только при live: true.
//   * план с блокирующим гардом не отправляется; часть гардов не снимается
//     даже force (см. guards.HARD_CODES).
//   * повторная проводка с тем же ключом идемпотентности не отправляется.
//   * после успеха баланс перечитывается и сверяется с target. Апи может
//     ответить success и при этом применить не то, что мы просили —
//     верификация превращает «надеемся» в «проверили».
// ----------------------------------------------------------------------------

const { config } = require('./config');
const { call } = require('./client');
const { buildPayload } = require('./plan');
const { fromMinor } = require('./money');
const { hasBlocking, hasUnforgivable } = require('./guards');
const { fetchCreditRows } = require('./exportReader');
const { buildBalance, selectCreditRow } = require('./balance');
const audit = require('./audit');

const WRITEOFF_PATH = '/api/v1.0/special/writeoff';

class WriteoffError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WriteoffError';
    Object.assign(this, details);
  }
}

async function postWriteoff(payload, { cfg = config, ...rest } = {}) {
  const options = { method: 'POST', cfg, ...rest };
  if (cfg.WRITEOFF_TRANSPORT === 'query') options.query = payload;
  else options.body = payload;

  const envelope = await call(WRITEOFF_PATH, options);
  const data = envelope.data || {};

  if (data.status !== 'success') {
    // errors — объект вида { amount: "invalidAmount", charge: "invalidAmount" }
    const perField = data.errors
      ? Object.entries(data.errors).map(([field, keyword]) => `${field}: ${keyword}`).join(', ')
      : '';
    throw new WriteoffError(
      `отпис не применён: status=${data.status}` +
      `${data.error ? ` error=${data.error}` : ''}` +
      `${perField ? ` (${perField})` : ''}`,
      { data, envelope },
    );
  }

  return { writeoffId: data.writeoffId ?? null, data, envelope };
}

// Перечитывает баланс и сверяет с ожиданием.
async function verify({ customerId, creditId, expectedDebt, cfg = config, ...rest }) {
  const { rows } = await fetchCreditRows({ customerId, creditId, cfg, ...rest });
  const balance = buildBalance(selectCreditRow(rows, creditId));
  return {
    ok: balance.debt === expectedDebt,
    debtAfter: balance.debt,
    expectedDebt,
    delta: balance.debt - expectedDebt,
    balance,
  };
}

async function applyPlan(plan, options = {}) {
  const {
    live = false,
    force = false,
    actor = config.ACTOR,
    notes = plan.notes,
    date = null,
    cfg = config,
    auditDir = cfg.AUDIT_DIR,
    skipVerify = false,
    idempotencyGuard = cfg.IDEMPOTENCY_GUARD,
    ...rest
  } = options;

  if (hasUnforgivable(plan.findings)) {
    throw new WriteoffError(
      'план содержит гарды, которые не снимаются force: ' +
      plan.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', '),
      { findings: plan.findings },
    );
  }
  if (hasBlocking(plan.findings) && !force) {
    throw new WriteoffError(
      'план заблокирован гардами: ' +
      plan.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', ') +
      ' (осознанно снять — force: true)',
      { findings: plan.findings },
    );
  }
  if (plan.amount === 0) {
    throw new WriteoffError('нечего отписывать: amount = 0', { plan });
  }

  // Отказ при повторе — отдельный флаг, а не часть force. force снимает
  // гарды данных, и смешивать это с идемпотентностью нельзя: получилось бы,
  // что «дай повторить» незаметно означает ещё и «игнорируй проверки».
  // По умолчанию выключен, см. config.IDEMPOTENCY_GUARD.
  if (idempotencyGuard) {
    const already = await audit.findApplied(plan.idempotencyKey, { dir: auditDir });
    if (already && !force) {
      return {
        status: 'already_applied',
        idempotencyKey: plan.idempotencyKey,
        previous: already,
        message: `эта проводка уже проведена ${already.ts} (writeoffId=${already.writeoffId ?? '?'})`,
      };
    }

    const dangling = await audit.findDangling(plan.idempotencyKey, { dir: auditDir });
    if (dangling && !force) {
      return {
        status: 'dangling_intent',
        idempotencyKey: plan.idempotencyKey,
        previous: dangling,
        message:
          `в аудите есть незакрытая попытка от ${dangling.ts}: запрос был отправлен, ` +
          `а результат не записан. Проверьте кредит в CRM вручную, прежде чем повторять.`,
      };
    }
  }

  const payload = buildPayload({
    customerId: plan.customerId,
    creditId: plan.creditId,
    allocation: plan.allocation,
    notes,
    date,
  });

  const base = {
    idempotencyKey: plan.idempotencyKey,
    actor,
    customerId: plan.customerId,
    creditId: plan.creditId,
    target: plan.target,
    debtBefore: plan.debtBefore,
    amount: plan.amount,
    allocation: plan.allocation,
  };

  if (!live) {
    return {
      status: 'dry_run',
      idempotencyKey: plan.idempotencyKey,
      payload,
      path: WRITEOFF_PATH,
      transport: cfg.WRITEOFF_TRANSPORT,
      message: `dry-run: запрос НЕ отправлен. Сумма к отпису ${fromMinor(plan.amount)}.`,
    };
  }

  await audit.append({ event: 'intent', ...base, payload }, { dir: auditDir });

  let result;
  try {
    result = await postWriteoff(payload, { cfg, ...rest });
  } catch (err) {
    await audit.append(
      { event: 'failed', ...base, error: err.message, data: err.data ?? null },
      { dir: auditDir },
    );
    throw err;
  }

  await audit.append(
    { event: 'applied', ...base, writeoffId: result.writeoffId },
    { dir: auditDir },
  );

  if (skipVerify) {
    return { status: 'applied', writeoffId: result.writeoffId, verification: null, payload };
  }

  const verification = await verify({
    customerId: plan.customerId,
    creditId: plan.creditId,
    expectedDebt: plan.target,
    cfg,
    ...rest,
  });

  await audit.append(
    {
      event: verification.ok ? 'verified' : 'mismatch',
      ...base,
      writeoffId: result.writeoffId,
      debtAfter: verification.debtAfter,
      delta: verification.delta,
    },
    { dir: auditDir },
  );

  return {
    status: verification.ok ? 'applied' : 'applied_unverified',
    writeoffId: result.writeoffId,
    payload,
    verification,
    message: verification.ok
      ? `отпис проведён, долг стал ${fromMinor(verification.debtAfter)} — совпадает с target`
      : `отпис проведён (writeoffId=${result.writeoffId}), но долг стал ` +
        `${fromMinor(verification.debtAfter)} вместо ${fromMinor(plan.target)} ` +
        `(расхождение ${fromMinor(verification.delta)}) — разберитесь вручную`,
  };
}

module.exports = { applyPlan, postWriteoff, verify, WriteoffError, WRITEOFF_PATH };

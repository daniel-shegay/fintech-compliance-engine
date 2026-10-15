'use strict';

// ----------------------------------------------------------------------------
// План отписа = ответ на вопрос «что именно мы спишем и почему».
//
// Строится в два шага, и это разделение принципиально:
//   computePlan()  — чистая функция от Balance. Ни сети, ни времени, ни файлов.
//   buildPlan()    — читает экспорт и вызывает computePlan().
//
// Отправки здесь нет ни в каком виде: план можно смотреть, логировать
// и хранить, не рискуя ничем.
// ----------------------------------------------------------------------------

const crypto = require('node:crypto');

const { config } = require('./config');
const { ORDER, SOURCE_COLUMN, PAYLOAD_FIELD } = require('./buckets');
const { allocate } = require('./waterfall');
const { evaluate, hasBlocking, hasUnforgivable } = require('./guards');
const { fromMinor, toMinor } = require('./money');
const exportReader = require('./exportReader');
const { buildBalance, selectCreditRow } = require('./balance');

// Ключ идемпотентности: одна и та же проводка по одному кредиту не должна
// уйти дважды. В хэш входит всё, что определяет проводку по деньгам —
// но НЕ notes и НЕ дата, иначе повтор с другой познамкой пройдёт как новый.
function idempotencyKey({ customerId, creditId, debt, target, allocation }) {
  const canonical = JSON.stringify({
    customerId: String(customerId),
    creditId: String(creditId),
    debt,
    target,
    allocation: Object.fromEntries(
      Object.entries(allocation).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// Тело запроса к special/writeoff. Отдельная функция, чтобы её можно было
// проверить тестом, не отправляя ничего.
function buildPayload({ customerId, creditId, allocation, notes, date }) {
  const payload = {
    customerId: Number(customerId),
    creditId: Number(creditId),
  };

  // Тело собирается обходом ORDER, поэтому корзина, которой в ORDER нет,
  // молча не попала бы в запрос — и проводка ушла бы на меньшую сумму,
  // чем показано в плане. Проверяем явно.
  const unknown = Object.keys(allocation).filter((bucket) => !ORDER.includes(bucket));
  if (unknown.length) {
    throw new Error(`в раскладке есть корзины вне иерархии: ${unknown.join(', ')}`);
  }

  for (const bucket of ORDER) {
    const minor = allocation[bucket] ?? 0;
    if (minor === 0) continue;
    const field = PAYLOAD_FIELD[bucket];
    if (field === undefined) {
      // до этого не дойдёт: guard api_unsupported_bucket ловит раньше.
      // Но пусть падает громко, а не отправляет проводку без части суммы.
      throw new Error(`корзина ${bucket} не имеет поля в контракте writeoff`);
    }
    payload[field] = fromMinor(minor);
  }

  if (notes) payload.notes = notes;
  if (date) payload.date = date;
  return payload;
}

// target — целое в haléřích (сколько долга должно ОСТАТЬСЯ).
function computePlan({ balance, target, notes = '', tolerance = config.DEBT_TOLERANCE_MINOR }) {
  const amount = Math.max(balance.debt - target, 0);
  const { allocation, allocated, shortfall, steps, capacity } = allocate({
    buckets: balance.buckets,
    order: ORDER,
    amount,
  });

  const findings = evaluate({ balance, target, allocation, shortfall, tolerance });

  return {
    customerId: balance.customerId,
    creditId: balance.creditId,
    debtBefore: balance.debt,
    target,
    amount,
    allocated,
    shortfall,
    capacity,
    debtAfterExpected: balance.debt - allocated,
    allocation,
    steps,
    buckets: balance.buckets,
    sourceColumns: SOURCE_COLUMN,
    notes,
    findings,
    ok: !hasBlocking(findings),
    fatal: hasUnforgivable(findings),
    idempotencyKey: idempotencyKey({
      customerId: balance.customerId,
      creditId: balance.creditId,
      debt: balance.debt,
      target,
      allocation,
    }),
  };
}

// target задаётся в korunách — строкой ("25000", "25000.00") или числом (25000).
// Если нужно передать уже пересчитанное значение, используйте targetMinor:
// смешивать koruny и haléře в одном параметре — верный способ отписать
// в сто раз больше, чем собирались.
async function buildPlan({
  customerId, creditId, target, targetMinor, notes = '', cfg = config, ...rest
} = {}) {
  if ((target === undefined) === (targetMinor === undefined)) {
    throw new Error('укажите ровно одно: target (в Kč) либо targetMinor (в haléřích)');
  }
  const resolvedTarget = targetMinor === undefined ? toMinor(target, 'target') : targetMinor;
  if (!Number.isInteger(resolvedTarget)) {
    throw new Error(`targetMinor должен быть целым, получено ${targetMinor}`);
  }

  const { rows } = await exportReader.fetchCreditRows({ customerId, creditId, cfg, ...rest });
  const row = selectCreditRow(rows, creditId);
  const balance = buildBalance(row);

  return computePlan({
    balance,
    target: resolvedTarget,
    notes,
    tolerance: cfg.DEBT_TOLERANCE_MINOR,
  });
}

module.exports = { buildPlan, computePlan, buildPayload, idempotencyKey };

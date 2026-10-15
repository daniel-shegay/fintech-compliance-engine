'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize } = require('../src/exportReader');
const { buildBalance, selectCreditRow, listDebtors } = require('../src/balance');
const { computePlan, buildPayload, idempotencyKey } = require('../src/plan');
const { ORDER, PAYLOAD_FIELD, API_UNSUPPORTED } = require('../src/buckets');
const { toMinor, fromMinor } = require('../src/money');
const { assocEnvelope } = require('./fixtures');

function balanceOf(overrides) {
  const rows = normalize(assocEnvelope([overrides]).data);
  return buildBalance(rows[0]);
}

function codes(plan) {
  return plan.findings.map((f) => f.code);
}

test('баланс собирает корзины и сходится с debt', () => {
  const balance = balanceOf({
    l_tax8: '2000.00', l_tax6: '1500.00', l_late_fee: '2208.00', l_amount: '10000.00',
  });

  assert.equal(fromMinor(balance.buckets.tax8), '2000.00');
  assert.equal(fromMinor(balance.buckets.late_fee), '2208.00');
  assert.equal(fromMinor(balance.bucketSum), '15708.00');
  assert.equal(balance.bucketSum, balance.debt);
  assert.equal(balance.creditId, '1026701');
  assert.equal(balance.customerId, '189463');
});

test('план раскладывает (debt - target) сверху вниз', () => {
  const balance = balanceOf({
    l_tax8: '2000.00', l_late_fee: '2208.00', l_cinterest: '705.33', l_amount: '20000.00',
  });
  // debt = 24913.33, оставить хотим 20000.00 -> отписать 4913.33
  const plan = computePlan({ balance, target: toMinor('20000.00') });

  assert.equal(fromMinor(plan.amount), '4913.33');
  assert.equal(fromMinor(plan.allocation.tax8), '2000.00');
  assert.equal(fromMinor(plan.allocation.cinterest), '705.33');
  assert.equal(fromMinor(plan.allocation.late_fee), '2208.00');
  assert.equal(plan.allocation.amount, undefined);
  assert.equal(fromMinor(plan.debtAfterExpected), '20000.00');
  assert.equal(plan.ok, true);
  assert.deepEqual(codes(plan), []);
});

test('дойдя до тела, режет его частично', () => {
  const balance = balanceOf({ l_tax2: '500.00', l_amount: '30000.00' });
  const plan = computePlan({ balance, target: toMinor('25000.00') });

  assert.equal(fromMinor(plan.amount), '5500.00');
  assert.equal(fromMinor(plan.allocation.tax2), '500.00');
  assert.equal(fromMinor(plan.allocation.amount), '5000.00');
  assert.equal(fromMinor(plan.debtAfterExpected), '25000.00');
  assert.equal(plan.ok, true);
});

test('расхождение суммы корзин с debt блокирует наглухо', () => {
  // 480.00 сидит в l_administrative_fee — в водопад он не входит
  const balance = balanceOf({
    l_amount: '10000.00', l_administrative_fee: '480.00', debt: '10480.00',
  });
  const plan = computePlan({ balance, target: toMinor('5000.00') });

  assert.ok(codes(plan).includes('debt_mismatch'));
  assert.equal(plan.ok, false);
  assert.equal(plan.fatal, true);
  const finding = plan.findings.find((f) => f.code === 'debt_mismatch');
  assert.match(finding.message, /l_administrative_fee=480\.00/);
});

test('tax11/tax12 проводятся — поля включены на инсталляции', () => {
  const balance = balanceOf({ l_tax12: '654.00', l_tax11: '400.00', l_amount: '10000.00' });
  const plan = computePlan({ balance, target: toMinor('10000.00') });

  assert.equal(fromMinor(plan.allocation.tax12), '654.00');
  assert.equal(fromMinor(plan.allocation.tax11), '400.00');
  assert.ok(!codes(plan).includes('api_unsupported_bucket'));
  assert.equal(plan.ok, true);

  const payload = buildPayload({ customerId: 1, creditId: 2, allocation: plan.allocation });
  assert.equal(payload.tax12, '654.00');
  assert.equal(payload.tax11, '400.00');
});

test('каждая корзина иерархии имеет поле в контракте writeoff', () => {
  // Инвариант: ORDER и PAYLOAD_FIELD не расходятся. Если однажды разойдутся,
  // guard api_unsupported_bucket включится сам — но пусть об этом скажет тест,
  // а не боевая проводка.
  assert.deepEqual(API_UNSUPPORTED, []);
  for (const bucket of ORDER) {
    assert.ok(PAYLOAD_FIELD[bucket], `у корзины ${bucket} нет поля в PAYLOAD_FIELD`);
  }
});

test('корзина вне иерархии не может тихо выпасть из запроса', () => {
  assert.throws(
    () => buildPayload({ customerId: 1, creditId: 2, allocation: { tax13: 100 } }),
    /вне иерархии: tax13/,
  );
});

test('недостижимый target ловится до отправки', () => {
  const balance = balanceOf({ l_amount: '1000.00' });
  const plan = computePlan({ balance, target: 0 });
  assert.equal(plan.shortfall, 0);
  assert.equal(plan.ok, true);

  // Корзины меньше долга — значит, они описывают его не полностью.
  // Такой случай ловится сразу двумя гардами: и по ёмкости, и по сверке с debt.
  const broken = balanceOf({ l_amount: '1000.00', debt: '5000.00' });
  const brokenPlan = computePlan({ balance: broken, target: 0 });
  assert.ok(codes(brokenPlan).includes('insufficient_capacity'));
  assert.ok(codes(brokenPlan).includes('debt_mismatch'));
  assert.equal(brokenPlan.ok, false);
});

test('долг не больше target — отписывать нечего', () => {
  const balance = balanceOf({ l_amount: '20000.00' });
  const plan = computePlan({ balance, target: toMinor('25000.00') });

  assert.equal(plan.amount, 0);
  assert.ok(codes(plan).includes('nothing_to_write_off'));
  assert.equal(plan.ok, false);
});

test('судебные расходы отписываются, но с предупреждением', () => {
  const balance = balanceOf({ l_tax10: '1500.00', l_tax9: '2000.00', l_amount: '5000.00' });
  const plan = computePlan({ balance, target: toMinor('5000.00') });

  assert.equal(fromMinor(plan.allocation.tax10), '1500.00');
  assert.equal(fromMinor(plan.allocation.tax9), '2000.00');
  const warn = plan.findings.find((f) => f.code === 'court_costs_included');
  assert.equal(warn.severity, 'warning');
  assert.equal(plan.ok, true);            // предупреждение не блокирует
});

test('остаток Cena больше начисленного — источник столбца под вопросом', () => {
  // l_interest (остаток) = 1798, r_charge (начислено) = 0 — так быть не может
  const balance = balanceOf({ l_amount: '5000.00', l_interest: '1798.00', r_charge: '0.00' });
  const plan = computePlan({ balance, target: toMinor('1000.00') });
  assert.ok(codes(plan).includes('charge_source_suspicious'));

  // а нормальная ситуация «часть Cena погашена» подозрений не вызывает
  const healthy = balanceOf({ l_amount: '5000.00', l_interest: '300.00', r_charge: '500.00' });
  const healthyPlan = computePlan({ balance: healthy, target: toMinor('1000.00') });
  assert.ok(!codes(healthyPlan).includes('charge_source_suspicious'));
  assert.ok(!codes(healthyPlan).includes('debt_mismatch'));
});

test('регрессия: три исторических состояния займа сходятся с debt', () => {
  // Проводки от 2026-09-03. На r_charge как источнике charge третье состояние
  // давало расхождение +500.00 — из-за него и нашлась ошибка в карте столбцов.
  const states = [
    {
      label: 'до первой проводки (debt 9470.26)',
      columns: {
        l_tax12: '653.00', l_tax11: '400.00', l_tax10: '1000.00', l_tax5: '1000.00',
        l_tax2: '500.00', l_cinterest: '197.26', l_late_fee: '220.00',
        l_interest: '500.00', r_charge: '500.00', l_amount: '5000.00', writeoff: '1.00',
      },
      debt: '9470.26',
    },
    {
      label: 'после отписа 2000.00 (debt 7470.26)',
      columns: {
        l_tax10: '53.00', l_tax5: '1000.00', l_tax2: '500.00',
        l_cinterest: '197.26', l_late_fee: '220.00',
        l_interest: '500.00', r_charge: '500.00', l_amount: '5000.00', writeoff: '2001.00',
      },
      debt: '7470.26',
    },
    {
      label: 'после отписа 5000.00 (debt 2470.26) — r_charge не уменьшился',
      columns: {
        l_interest: '0.00', r_charge: '500.00', l_amount: '2470.26', writeoff: '7001.00',
      },
      debt: '2470.26',
    },
  ];

  for (const state of states) {
    const balance = balanceOf(state.columns);
    assert.equal(fromMinor(balance.debt), state.debt, state.label);
    assert.equal(balance.bucketSum, balance.debt, `${state.label}: сумма корзин не сошлась`);
    const plan = computePlan({ balance, target: 0 });
    assert.ok(!codes(plan).includes('debt_mismatch'), `${state.label}: debt_mismatch`);
  }

  // последнее состояние: target 0 отписывает ровно тело и ничего больше
  const last = computePlan({ balance: balanceOf(states[2].columns), target: 0 });
  assert.equal(fromMinor(last.amount), '2470.26');
  assert.deepEqual(Object.keys(last.allocation), ['amount']);
  assert.equal(last.ok, true);
});

test('уже проведённые отписы попадают в предупреждения', () => {
  const balance = balanceOf({ l_amount: '10000.00', writeoff: '28836.67' });
  const plan = computePlan({ balance, target: toMinor('5000.00') });
  const warn = plan.findings.find((f) => f.code === 'prior_writeoff');
  assert.equal(warn.severity, 'warning');
  assert.equal(plan.ok, true);
});

test('payload содержит только непустые корзины и Decimal-строки', () => {
  const balance = balanceOf({ l_tax8: '2000.00', l_amount: '20000.00' });
  const plan = computePlan({ balance, target: toMinor('20000.00') });
  const payload = buildPayload({
    customerId: plan.customerId,
    creditId: plan.creditId,
    allocation: plan.allocation,
    notes: 'DoN 2026-09-03',
  });

  assert.deepEqual(payload, {
    customerId: 189463,
    creditId: 1026701,
    tax8: '2000.00',
    notes: 'DoN 2026-09-03',
  });
  assert.equal(payload.tax1, undefined);
  assert.equal(payload.amount, undefined);
});

test('ключ идемпотентности зависит от денег, но не от познамки', () => {
  const balance = balanceOf({ l_tax8: '2000.00', l_amount: '20000.00' });
  const a = computePlan({ balance, target: toMinor('20000.00'), notes: 'первая попытка' });
  const b = computePlan({ balance, target: toMinor('20000.00'), notes: 'вторая попытка' });
  const c = computePlan({ balance, target: toMinor('19000.00') });

  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.idempotencyKey, c.idempotencyKey);
  assert.equal(a.idempotencyKey.length, 32);
});

test('ключ не зависит от порядка ключей в allocation', () => {
  const one = idempotencyKey({
    customerId: '1', creditId: '2', debt: 100, target: 0,
    allocation: { tax8: 50, amount: 50 },
  });
  const two = idempotencyKey({
    customerId: '1', creditId: '2', debt: 100, target: 0,
    allocation: { amount: 50, tax8: 50 },
  });
  assert.equal(one, two);
});

test('выбор кредита не доверяет фильтру', () => {
  const rows = normalize(assocEnvelope([
    { id: '1012471', l_amount: '0.00' },
    { id: '1026701', l_amount: '22834.66' },
  ]).data);

  assert.equal(buildBalance(selectCreditRow(rows, '1026701')).creditId, '1026701');
  assert.throws(() => selectCreditRow(rows, '999999'), /не найден/);
  assert.deepEqual(
    listDebtors(rows).map((d) => d.creditId),
    ['1026701'],
  );
});

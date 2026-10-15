'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { allocate } = require('../src/waterfall');
const { ORDER } = require('../src/buckets');
const { toMinor, fromMinor } = require('../src/money');

function buckets(spec) {
  const out = {};
  for (const bucket of ORDER) out[bucket] = 0;
  for (const [bucket, value] of Object.entries(spec)) out[bucket] = toMinor(value);
  return out;
}

test('иерархия соблюдается: сверху tax12, снизу тело', () => {
  const result = allocate({
    buckets: buckets({ tax12: '100.00', tax1: '100.00', amount: '100.00' }),
    order: ORDER,
    amount: toMinor('150.00'),
  });

  assert.equal(fromMinor(result.allocation.tax12), '100.00');
  assert.equal(fromMinor(result.allocation.tax1), '50.00');
  assert.equal(result.allocation.amount, undefined);   // тело не тронуто
  assert.equal(result.shortfall, 0);
});

test('последняя задетая корзина гасится частично', () => {
  const result = allocate({
    buckets: buckets({ tax8: '2000.00', late_fee: '2208.00', amount: '10000.00' }),
    order: ORDER,
    amount: toMinor('3000.00'),
  });

  assert.equal(fromMinor(result.allocation.tax8), '2000.00');
  assert.equal(fromMinor(result.allocation.late_fee), '1000.00');
  assert.equal(result.allocation.amount, undefined);

  const lateFeeStep = result.steps.find((s) => s.bucket === 'late_fee');
  assert.equal(lateFeeStep.partial, true);
});

test('порядок именно tax12..tax1, а не лексический', () => {
  // при лексической сортировке tax10 шёл бы раньше tax9 — проверяем, что нет
  const result = allocate({
    buckets: buckets({ tax9: '10.00', tax10: '10.00' }),
    order: ORDER,
    amount: toMinor('10.00'),
  });
  assert.equal(fromMinor(result.allocation.tax10), '10.00');
  assert.equal(result.allocation.tax9, undefined);
});

test('порядок именно tax12..tax6, затем tax2..tax5, tax1', () => {
  const result = allocate({
    buckets: buckets({
      tax6: '10.00', tax2: '10.00', tax3: '10.00', tax4: '10.00', tax5: '10.00', tax1: '10.00',
      charge: '10.00', cinterest: '10.00', late_fee: '10.00', amount: '10.00',
    }),
    order: ORDER,
    amount: toMinor('35.00'),
  });
  assert.equal(fromMinor(result.allocation.tax6), '10.00');
  assert.equal(fromMinor(result.allocation.tax2), '10.00');
  assert.equal(fromMinor(result.allocation.tax3), '10.00');
  assert.equal(fromMinor(result.allocation.tax4), '5.00');
  assert.equal(result.allocation.tax5, undefined);
  assert.equal(result.allocation.tax1, undefined);
  assert.equal(result.allocation.charge, undefined);
  assert.equal(result.allocation.cinterest, undefined);
  assert.equal(result.allocation.late_fee, undefined);
  assert.equal(result.allocation.amount, undefined);
});

test('charge гасится раньше cinterest и late_fee', () => {
  const result = allocate({
    buckets: buckets({
      charge: '100.00', cinterest: '100.00', late_fee: '100.00',
    }),
    order: ORDER,
    amount: toMinor('150.00'),
  });
  assert.equal(fromMinor(result.allocation.charge), '100.00');
  assert.equal(fromMinor(result.allocation.cinterest), '50.00');
  assert.equal(result.allocation.late_fee, undefined);
});

test('никогда не берёт больше остатка корзины', () => {
  const spec = buckets({ tax5: '50.00', amount: '30.00' });
  const result = allocate({ buckets: spec, order: ORDER, amount: toMinor('1000.00') });

  for (const [bucket, taken] of Object.entries(result.allocation)) {
    assert.ok(taken <= spec[bucket], `${bucket}: взято больше остатка`);
  }
  assert.equal(fromMinor(result.allocated), '80.00');
  assert.equal(fromMinor(result.shortfall), '920.00');
});

test('нулевая сумма ничего не распределяет', () => {
  const result = allocate({ buckets: buckets({ amount: '100.00' }), order: ORDER, amount: 0 });
  assert.deepEqual(result.allocation, {});
  assert.equal(result.allocated, 0);
});

test('отказывается работать с float и отрицательными', () => {
  assert.throws(() => allocate({ buckets: buckets({}), order: ORDER, amount: 10.5 }), TypeError);
  assert.throws(() => allocate({ buckets: buckets({}), order: ORDER, amount: -100 }), RangeError);
  assert.throws(
    () => allocate({ buckets: { ...buckets({}), amount: -5 }, order: ORDER, amount: 100 }),
    RangeError,
  );
});

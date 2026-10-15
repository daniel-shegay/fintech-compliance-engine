'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize, pick, hasColumn, ExportError } = require('../src/exportReader');
const { assocEnvelope, positionalEnvelope } = require('./fixtures');

test('assoc и позиционный формат дают одинаковые строки', () => {
  const overrides = [{ l_amount: '22834.66' }];
  const fromAssoc = normalize(assocEnvelope(overrides).data);
  const fromPositional = normalize(positionalEnvelope(overrides).data);

  assert.equal(fromAssoc.length, 1);
  assert.equal(fromPositional.length, 1);
  assert.equal(pick(fromAssoc[0], 'l_amount'), '22834.66');
  assert.equal(pick(fromPositional[0], 'l_amount'), '22834.66');
  assert.equal(pick(fromAssoc[0], 'debt'), pick(fromPositional[0], 'debt'));
});

test('позиционный формат падает при расхождении длины строки и names', () => {
  const payload = positionalEnvelope([{}]).data;
  payload.data[0].pop();                        // потеряли один столбец

  assert.throws(() => normalize(payload), (err) => {
    assert.ok(err instanceof ExportError);
    assert.match(err.message, /против .* имён/);
    return true;
  });
});

test('пустой ответ — это пустой массив, а не ошибка', () => {
  const payload = assocEnvelope([]).data;
  assert.deepEqual(normalize(payload), []);
});

test('ответ без names отвергается', () => {
  assert.throws(() => normalize({ data: [] }), ExportError);
  assert.throws(() => normalize({ names: {} }), ExportError);
});

test('столбец резолвится с суффиксом индекса', () => {
  const row = { debt_21: '100.00', l_tax8_44: '2000.00' };
  assert.equal(pick(row, 'debt'), '100.00');
  assert.equal(pick(row, 'l_tax8'), '2000.00');
  assert.equal(hasColumn(row, 'debt'), true);
  assert.equal(hasColumn(row, 'l_tax9'), false);
  assert.equal(pick(row, 'l_tax9'), undefined);
});

test('tax1 не путается с tax10..tax12', () => {
  const row = { tax1_33: '1.00', tax10_42: '10.00', tax11_43: '11.00', tax12_44: '12.00' };
  assert.equal(pick(row, 'tax1'), '1.00');
  assert.equal(pick(row, 'tax10'), '10.00');
  assert.equal(pick(row, 'tax11'), '11.00');
  assert.equal(pick(row, 'tax12'), '12.00');
});

test('l_tax1 не хватает значение l_tax12', () => {
  const row = { l_tax1_35: '1.00', l_tax12_46: '12.00' };
  assert.equal(pick(row, 'l_tax1'), '1.00');
  assert.equal(pick(row, 'l_tax12'), '12.00');
});

test('неоднозначный столбец — ошибка, а не первое совпадение', () => {
  const row = { debt_21: '100.00', debt_99: '200.00' };
  assert.throws(() => pick(row, 'debt'), (err) => {
    assert.ok(err instanceof ExportError);
    assert.match(err.message, /неоднозначно/);
    return true;
  });
});

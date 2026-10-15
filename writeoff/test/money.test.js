'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toMinor, toMinorOrZero, fromMinor, sumMinor, MoneyError } = require('../src/money');

test('парсит строки экспорта', () => {
  assert.equal(toMinor('22834.66'), 2283466);
  assert.equal(toMinor('0.00'), 0);
  assert.equal(toMinor('1798'), 179800);
  assert.equal(toMinor('1798.5'), 179850);
  assert.equal(toMinor('1 798,00'), 179800);      // пробел-разделитель и запятая
  assert.equal(toMinor(25000), 2500000);
});

test('отказывается угадывать', () => {
  assert.throws(() => toMinor(''), MoneyError);
  assert.throws(() => toMinor(null), MoneyError);
  assert.throws(() => toMinor('0000-00-00'), MoneyError);
  assert.throws(() => toMinor('abc'), MoneyError);
  // третий знак после запятой — это не наша точность, молча округлять нельзя
  assert.throws(() => toMinor('10.005'), MoneyError);
  // а незначащие нули в третьем знаке допустимы
  assert.equal(toMinor('10.500'), 1050);
});

test('toMinorOrZero отличает «нет столбца» от «ноль»', () => {
  assert.equal(toMinorOrZero(undefined), 0);
  assert.equal(toMinorOrZero(''), 0);
  assert.equal(toMinorOrZero('0.00'), 0);
  assert.throws(() => toMinorOrZero('нет'), MoneyError);
});

test('round-trip не теряет копейки', () => {
  for (const value of ['0.00', '0.01', '22834.66', '1165.34', '28836.67', '99999999.99']) {
    assert.equal(fromMinor(toMinor(value)), value);
  }
});

test('сумма считается целыми, без float-дрейфа', () => {
  // 0.1 + 0.2 в float даёт 0.30000000000000004
  const parts = ['0.10', '0.20'].map((v) => toMinor(v));
  assert.equal(fromMinor(sumMinor(parts)), '0.30');

  // реальный набор корзин
  const buckets = ['500.00', '500.00', '500.00', '500.00', '1500.00', '2000.00', '2208.00', '705.33'];
  assert.equal(fromMinor(sumMinor(buckets.map((v) => toMinor(v)))), '8413.33');
});

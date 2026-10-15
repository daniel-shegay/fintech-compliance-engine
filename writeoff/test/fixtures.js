'use strict';

// ----------------------------------------------------------------------------
// Фикстуры собираются программно из одного источника — объекта столбцов.
// Это сознательно: позиционный вариант экспорта получается зипом того же
// объекта, поэтому в тестах не может появиться сдвиг, которого нет в коде.
// Ровно та ошибка, из-за которой позиционный формат и признан опасным.
// ----------------------------------------------------------------------------

const { ORDER, SOURCE_COLUMN } = require('../src/buckets');

// Порядок здесь повторяет реальный export 229 в той части, что нас касается.
const COLUMN_ORDER = [
  'id', 'customer_id', 'charge', 'amount', 'debt', 'r_debt',
  'writeoff', 'writeoff_a', 'writeoff_l', 'writeoff_p',
  'penalty', 'late_fee',
  'tax1', 'tax2', 'tax3', 'tax4', 'tax5', 'tax6', 'tax7', 'tax8', 'tax9', 'tax10', 'tax11', 'tax12',
  'court_date', 'cfg_court', 'sold', 'archive', 'important', 'current_delay',
  'l_amount', 'l_interest', 'l_cinterest', 'l_late_fee', 'l_percent',
  'l_tax1', 'l_tax2', 'l_tax3', 'l_tax4', 'l_tax5', 'l_tax6',
  'l_tax7', 'l_tax8', 'l_tax9', 'l_tax10', 'l_tax11', 'l_tax12',
  'l_administrative_fee', 'l_penalty',
  'cinterest', 'r_charge',
];

const DEFAULTS = {
  id: '1026701',
  customer_id: '189463',
  charge: '24000.00',
  amount: '24000.00',
  debt: '0.00',
  r_debt: '0.00',
  writeoff: '0.00',
  writeoff_a: '0.00',
  writeoff_l: '0.00',
  writeoff_p: '0.00',
  penalty: '0.00',
  late_fee: '0.00',
  court_date: '0000-00-00',
  cfg_court: '0',
  sold: '0000-00-00',
  archive: '0',
  important: '155',
  current_delay: '294',
  l_percent: '0.00',
  l_interest: '0.00',
  l_administrative_fee: '0.00',
  l_penalty: '0.00',
  cinterest: '0.00',
};

for (let i = 1; i <= 12; i += 1) {
  DEFAULTS[`tax${i}`] = '0.00';
  DEFAULTS[`l_tax${i}`] = '0.00';
}
for (const column of ['l_amount', 'l_cinterest', 'l_late_fee', 'r_charge']) {
  DEFAULTS[column] = '0.00';
}

// Плоская строка со всеми столбцами. debt по умолчанию считается как сумма
// корзин водопада, чтобы фикстура была самосогласованной и guard debt_mismatch
// не срабатывал там, где мы его не проверяем.
function makeColumns(overrides = {}) {
  const columns = { ...DEFAULTS, ...overrides };

  if (overrides.debt === undefined) {
    // Список берём из самого модуля, а не копией: иначе фикстуры разойдутся
    // с картой столбцов — а это ровно та ошибка, которую тесты и ловят.
    const waterfall = ORDER.map((bucket) => SOURCE_COLUMN[bucket]);
    const sum = waterfall.reduce(
      (acc, column) => acc + Math.round(Number(columns[column] || 0) * 100),
      0,
    );
    columns.debt = (sum / 100).toFixed(2);
  }
  if (overrides.r_debt === undefined) columns.r_debt = columns.debt;

  return columns;
}

// Формат assoc: ключи приходят с индексом столбца в суффиксе.
function assocRow(overrides = {}) {
  const columns = makeColumns(overrides);
  const row = {};
  COLUMN_ORDER.forEach((column, index) => {
    row[`${column}_${index}`] = columns[column];
  });
  return row;
}

// Ответ API целиком: конверт + names + строки.
function assocEnvelope(rowsOverrides = [{}]) {
  const names = {};
  COLUMN_ORDER.forEach((column, index) => { names[`${column}_${index}`] = column; });
  return {
    status: 200,
    data: { names, data: rowsOverrides.map((o) => assocRow(o)) },
  };
}

// Тот же набор, но позиционными массивами — как отдаёт export без format.
function positionalEnvelope(rowsOverrides = [{}]) {
  const names = {};
  COLUMN_ORDER.forEach((column, index) => { names[`${column}_${index}`] = column; });
  return {
    status: 200,
    data: {
      names,
      data: rowsOverrides.map((o) => {
        const columns = makeColumns(o);
        return COLUMN_ORDER.map((column) => columns[column]);
      }),
    },
  };
}

// Подменяет fetch: отдаёт заранее заданные конверты по порядку вызовов
// и записывает, что именно у него просили.
function fakeFetch(envelopes) {
  const queue = [...envelopes];
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`неожиданный запрос: ${url}`);
    const body = typeof next === 'function' ? next({ url: String(url), init }) : next;
    return {
      status: 200,
      async text() { return JSON.stringify(body); },
    };
  };
  impl.calls = calls;
  return impl;
}

module.exports = {
  COLUMN_ORDER, DEFAULTS, makeColumns, assocRow, assocEnvelope, positionalEnvelope, fakeFetch,
};

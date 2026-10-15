'use strict';

// ----------------------------------------------------------------------------
// Чтение export/export и превращение ответа в строки, из которых можно
// безопасно достать столбец ПО ИМЕНИ.
//
// Почему это отдельный файл с гардами, а не три строки inline:
//
// export/export умеет два формата, и они принципиально разные по риску.
//   * format=assoc  -> data.data = [ { "l_amount_93": "22834.66", ... } ]
//                      ключи приходят с индексом столбца в суффиксе
//   * без format    -> data.data = [ [ "1026701", "189463", ... ] ]
//                      плоские массивы, соответствие держится ТОЛЬКО на
//                      порядке ключей в data.names
//
// Второй формат для модуля, который двигает деньги, опасен: сдвиг на один
// элемент даёт тихо неверную сумму в правильно выглядящем отчёте. Поэтому
// позиционный режим поддержан, но с жёсткой проверкой длины строки против
// числа имён — при любом расхождении бросаем, а не «дочитываем что есть».
//
// По умолчанию модуль просит assoc.
// ----------------------------------------------------------------------------

const { call } = require('./client');
const { config } = require('./config');

class ExportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExportError';
    Object.assign(this, details);
  }
}

// Столбец приходит либо ровно как `debt`, либо как `debt_21` (индекс в экспорте).
// Ищем сначала точное совпадение, потом по шаблону — и ловим неоднозначность.
function resolveKey(row, column) {
  if (Object.prototype.hasOwnProperty.call(row, column)) return column;

  const re = new RegExp(`^${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_\\d+)?$`);
  const hits = Object.keys(row).filter((k) => re.test(k));

  if (hits.length === 0) return undefined;
  if (hits.length > 1) {
    throw new ExportError(
      `столбец «${column}» разрешается неоднозначно: ${hits.join(', ')} — ` +
      `уточните имя в src/buckets.js`,
      { column, candidates: hits },
    );
  }
  return hits[0];
}

// Достаёт значение столбца. undefined = столбца в экспорте нет
// (это не то же самое, что "" или "0.00" — их вернём как есть).
function pick(row, column) {
  const key = resolveKey(row, column);
  return key === undefined ? undefined : row[key];
}

function hasColumn(row, column) {
  return resolveKey(row, column) !== undefined;
}

// Приводит любой из двух форматов к массиву объектов.
function normalize(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ExportError('в ответе нет data', { payload });
  }
  const { names, data } = payload;
  if (!names || typeof names !== 'object') {
    throw new ExportError('в ответе нет data.names', { keys: Object.keys(payload) });
  }
  if (!Array.isArray(data)) {
    throw new ExportError('data.data не массив', { got: typeof data });
  }
  if (data.length === 0) return [];

  // assoc: строки уже объекты
  if (!Array.isArray(data[0])) {
    for (const [i, row] of data.entries()) {
      if (Array.isArray(row) || row === null || typeof row !== 'object') {
        throw new ExportError(`строка ${i}: смешанные форматы в data.data`, { index: i });
      }
    }
    return data;
  }

  // позиционный: зипуем по порядку ключей names, но только при полном совпадении длин
  const columns = Object.keys(names);
  return data.map((row, i) => {
    if (!Array.isArray(row)) {
      throw new ExportError(`строка ${i}: смешанные форматы в data.data`, { index: i });
    }
    if (row.length !== columns.length) {
      throw new ExportError(
        `строка ${i}: ${row.length} значений против ${columns.length} имён в data.names — ` +
        `позиционное сопоставление ненадёжно, запросите format=assoc`,
        { index: i, values: row.length, names: columns.length },
      );
    }
    const obj = {};
    for (let c = 0; c < columns.length; c += 1) obj[columns[c]] = row[c];
    return obj;
  });
}

async function fetchExport({ id, filter, format = 'assoc', limit = 0, cfg = config, ...rest } = {}) {
  const envelope = await call('/api/v1.0/export/export', {
    query: { id, filter, format, limit },
    cfg,
    ...rest,
  });
  return { rows: normalize(envelope.data), names: envelope.data.names, envelope };
}

// Строки одного кредита. creditId необязателен: без него вернутся все
// кредиты клиента (нужно, чтобы показать оператору выбор).
async function fetchCreditRows({ customerId, creditId, cfg = config, ...rest } = {}) {
  if (customerId === undefined || customerId === null || customerId === '') {
    throw new ExportError('customerId обязателен');
  }

  const filter = [
    {
      name: cfg.FILTER_CUSTOMER_FIELD,
      act: '=',
      value: String(customerId),
      operator: 'and',
    },
  ];
  if (creditId !== undefined && creditId !== null && creditId !== '') {
    filter.push({
      name: cfg.FILTER_CREDIT_FIELD,
      act: '=',
      value: String(creditId),
      operator: 'and',
    });
  }

  return fetchExport({ id: cfg.EXPORT_ID, filter, cfg, ...rest });
}

module.exports = { fetchExport, fetchCreditRows, normalize, pick, hasColumn, resolveKey, ExportError };

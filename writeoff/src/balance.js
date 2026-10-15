'use strict';

// ----------------------------------------------------------------------------
// Строка экспорта -> объект Balance: остатки по корзинам в haléřích плюс всё,
// что нужно гардам. Чистая функция, сети здесь нет.
// ----------------------------------------------------------------------------

const { pick, hasColumn, ExportError } = require('./exportReader');
const { toMinorOrZero, sumMinor } = require('./money');
const {
  ORDER, SOURCE_COLUMN, DEBT_COLUMN, OUT_OF_WATERFALL_COLUMNS,
  DIAGNOSTIC_COLUMNS, META_COLUMNS,
} = require('./buckets');

function buildBalance(row) {
  if (!row || typeof row !== 'object') throw new ExportError('buildBalance: строка не объект');

  if (!hasColumn(row, DEBT_COLUMN)) {
    throw new ExportError(
      `в экспорте нет столбца «${DEBT_COLUMN}» — без системного итога долга сверить отпис нечем`,
    );
  }

  const buckets = {};
  const missingColumns = [];

  for (const bucket of ORDER) {
    const column = SOURCE_COLUMN[bucket];
    if (!hasColumn(row, column)) {
      // столбца нет вообще -> корзина недоступна. Считаем её нулём, но
      // помним об этом: если из-за неё не сойдётся debt, guard объяснит причину.
      missingColumns.push({ bucket, column });
      buckets[bucket] = 0;
      continue;
    }
    buckets[bucket] = toMinorOrZero(pick(row, column), column);
  }

  // остатки вне водопада — только для объяснения расхождений
  const outOfWaterfall = {};
  for (const column of OUT_OF_WATERFALL_COLUMNS) {
    if (!hasColumn(row, column)) continue;
    const value = toMinorOrZero(pick(row, column), column);
    if (value !== 0) outOfWaterfall[column] = value;
  }

  // справочные столбцы: и сырое значение, и разобранное (если разбирается)
  const diagnostics = {};
  for (const column of DIAGNOSTIC_COLUMNS) {
    if (!hasColumn(row, column)) continue;
    const raw = pick(row, column);
    let minor = null;
    try {
      minor = toMinorOrZero(raw, column);
    } catch {
      minor = null;                     // не число — покажем как есть
    }
    diagnostics[column] = { raw, minor };
  }

  const meta = {};
  for (const column of META_COLUMNS) {
    if (hasColumn(row, column)) meta[column] = pick(row, column);
  }

  return {
    customerId: String(pick(row, 'customer_id') ?? ''),
    creditId: String(pick(row, 'id') ?? ''),
    debt: toMinorOrZero(pick(row, DEBT_COLUMN), DEBT_COLUMN),
    buckets,
    bucketSum: sumMinor(ORDER.map((b) => buckets[b])),
    missingColumns,
    outOfWaterfall,
    diagnostics,
    meta,
    // сырую строку не тащим целиком в аудит (там ПДн клиента),
    // но оставляем доступной вызывающему коду для probe
    raw: row,
  };
}

// Выбор нужного кредита из ответа экспорта.
// Не доверяем фильтру: сверяем столбец id сами. Если фильтр по credits.id
// вдруг не сработал, лучше упасть, чем отписать не тот кредит.
function selectCreditRow(rows, creditId) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ExportError('экспорт не вернул ни одной строки — проверьте customerId/creditId');
  }

  const wanted = String(creditId);
  const matches = rows.filter((row) => String(pick(row, 'id') ?? '') === wanted);

  if (matches.length === 0) {
    const seen = rows.map((row) => String(pick(row, 'id') ?? '?')).join(', ');
    throw new ExportError(
      `кредит ${wanted} не найден у этого клиента. В экспорте есть: ${seen}`,
      { wanted, available: rows.map((row) => String(pick(row, 'id') ?? '?')) },
    );
  }
  if (matches.length > 1) {
    throw new ExportError(
      `экспорт вернул ${matches.length} строк для кредита ${wanted} — ожидалась одна`,
      { wanted, count: matches.length },
    );
  }
  return matches[0];
}

// Список кредитов клиента с ненулевым долгом — чтобы оператор выбрал creditId.
function listDebtors(rows) {
  return rows
    .map((row) => ({
      creditId: String(pick(row, 'id') ?? ''),
      debt: toMinorOrZero(pick(row, DEBT_COLUMN), DEBT_COLUMN),
    }))
    .filter((entry) => entry.debt > 0);
}

module.exports = { buildBalance, selectCreditRow, listDebtors };

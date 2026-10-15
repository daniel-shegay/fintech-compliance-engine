'use strict';

// ----------------------------------------------------------------------------
// Деньги. Внутри модуля НЕТ float — все суммы это целые haléře (minor units).
//
// Причина простая: 0.1 + 0.2 !== 0.3, а мы складываем и вычитаем остатки по
// 16 корзинам и потом сверяем итог с системным debt. Одна ошибка округления
// в последнем разряде превращается в «отпис не сошёлся» на боевой проводке.
//
// Экспорт CRM отдаёт суммы строками ("22834.66"), API отписа ждёт
// Decimal — поэтому конвертация ровно на границах: parse на входе,
// format на выходе.
// ----------------------------------------------------------------------------

const SCALE = 2;                 // haléře
const FACTOR = 100;
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

class MoneyError extends TypeError {}

// "22834.66" | "1 798,00" | 24000 -> 2283466 | 179800 | 2400000
function toMinor(value, field = 'value') {
  if (value === undefined || value === null) {
    throw new MoneyError(`${field}: пустое значение (${value})`);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`${field}: не число (${value})`);
    return toMinor(value.toFixed(SCALE), field);
  }

  // пробелы (в т.ч. NBSP как разделитель тысяч) и запятая как десятичный знак
  const raw = String(value).replace(/[\s ]/g, '').replace(',', '.');
  if (raw === '') throw new MoneyError(`${field}: пустая строка`);

  const m = /^([+-])?(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!m) throw new MoneyError(`${field}: не похоже на сумму: ${JSON.stringify(value)}`);

  const [, sign, intPart, fracPart = ''] = m;

  // Молча отбрасывать разряды нельзя: "0.005" это либо ошибка данных,
  // либо чужая точность, и в обоих случаях лучше упасть, чем округлить.
  if (fracPart.length > SCALE && /[1-9]/.test(fracPart.slice(SCALE))) {
    throw new MoneyError(`${field}: точнее ${SCALE} знаков не поддерживается: ${value}`);
  }

  const frac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  const minor = Number(intPart) * FACTOR + Number(frac);

  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) {
    throw new MoneyError(`${field}: сумма вне безопасного диапазона: ${value}`);
  }
  return sign === '-' ? -minor : minor;
}

// то же, но пустое/отсутствующее значение считаем нулём (для необязательных столбцов)
function toMinorOrZero(value, field = 'value') {
  if (value === undefined || value === null) return 0;
  const raw = String(value).replace(/[\s ]/g, '');
  if (raw === '') return 0;
  return toMinor(value, field);
}

// 2283466 -> "22834.66"  (формат, который ждёт Decimal в API)
function fromMinor(minor) {
  if (!Number.isInteger(minor)) throw new MoneyError(`fromMinor: не целое: ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const int = Math.trunc(abs / FACTOR);
  const frac = String(abs % FACTOR).padStart(SCALE, '0');
  return `${sign}${int}.${frac}`;
}

function sumMinor(values) {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new MoneyError(`sumMinor: не целое: ${v}`);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new MoneyError('sumMinor: переполнение');
  return total;
}

module.exports = { SCALE, MoneyError, toMinor, toMinorOrZero, fromMinor, sumMinor };

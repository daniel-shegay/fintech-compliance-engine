'use strict';

// ----------------------------------------------------------------------------
// Гарды. Каждый — небольшая проверка, возвращающая находку с кодом.
//
// severity:
//   'error'   — apply запрещён (без --force, а часть не снимается и им)
//   'warning' — apply разрешён, но оператор должен это увидеть в отчёте
//
// Главный из них — debt_mismatch. Он и есть страховка от неверной карты
// столбцов: если сумма остатков по нашим 16 корзинам не равна системному
// debt, значит модуль понимает долг не так, как его понимает CRM,
// и никакой отпис отправлять нельзя, как бы красиво ни выглядела раскладка.
// ----------------------------------------------------------------------------

const { fromMinor } = require('./money');
const { API_UNSUPPORTED, SOURCE_COLUMN } = require('./buckets');

const HARD_CODES = new Set(['debt_mismatch', 'api_unsupported_bucket', 'target_invalid']);

function finding(code, severity, message, data = {}) {
  return { code, severity, message, data };
}

function evaluate({ balance, target, allocation, shortfall, tolerance = 0 }) {
  const out = [];
  const alloc = allocation || {};

  // --- вход -----------------------------------------------------------------
  if (!Number.isInteger(target) || target < 0) {
    out.push(finding('target_invalid', 'error',
      `target должен быть целым неотрицательным числом haléřů, получено ${target}`));
  }

  // --- сверка с системным долгом -------------------------------------------
  const delta = balance.bucketSum - balance.debt;
  if (Math.abs(delta) > tolerance) {
    const parts = [];
    for (const [column, value] of Object.entries(balance.outOfWaterfall)) {
      parts.push(`${column}=${fromMinor(value)}`);
    }
    const hint = parts.length
      ? ` Вне водопада есть остатки: ${parts.join(', ')} — похоже, долг состоит не только из наших корзин.`
      : ' Остатков вне водопада не нашлось — вероятно, карта столбцов в src/buckets.js неполная.';

    out.push(finding('debt_mismatch', 'error',
      `сумма остатков по корзинам ${fromMinor(balance.bucketSum)} не равна системному debt ` +
      `${fromMinor(balance.debt)} (расхождение ${fromMinor(delta)}).${hint}`,
      { bucketSum: balance.bucketSum, debt: balance.debt, delta, outOfWaterfall: balance.outOfWaterfall }));
  }

  if (balance.missingColumns.length) {
    out.push(finding('missing_columns', 'warning',
      `в экспорте нет столбцов: ${balance.missingColumns.map((m) => m.column).join(', ')} — ` +
      `соответствующие корзины считаются нулевыми`,
      { missing: balance.missingColumns }));
  }

  // --- сколько вообще надо списать -----------------------------------------
  if (balance.debt <= target) {
    out.push(finding('nothing_to_write_off', 'error',
      `долг ${fromMinor(balance.debt)} уже не больше target ${fromMinor(target)} — отписывать нечего`,
      { debt: balance.debt, target }));
  }

  if (shortfall > 0) {
    out.push(finding('insufficient_capacity', 'error',
      `корзин не хватает: не удалось разложить ${fromMinor(shortfall)} — ` +
      `target ${fromMinor(target)} этим кредитом недостижим`,
      { shortfall, target }));
  }

  // --- ограничения самого API ----------------------------------------------
  const blocked = API_UNSUPPORTED.filter((bucket) => (alloc[bucket] ?? 0) > 0);
  if (blocked.length) {
    out.push(finding('api_unsupported_bucket', 'error',
      `водопад распределил суммы в корзины, которых нет в контракте special/writeoff: ` +
      `${blocked.map((b) => `${b}=${fromMinor(alloc[b])}`).join(', ')}. ` +
      `Спека postWriteoff() принимает только tax1..tax10, поэтому такую проводку отправить нельзя.`,
      { buckets: blocked }));
  }

  // --- вещи, о которых оператор должен знать -------------------------------
  const court = ['tax9', 'tax10'].filter((bucket) => (alloc[bucket] ?? 0) > 0);
  if (court.length) {
    out.push(finding('court_costs_included', 'warning',
      `в отпис попали судебные расходы: ${court.map((b) => `${b}=${fromMinor(alloc[b])}`).join(', ')}`,
      { buckets: court }));
  }

  // Инвариант по Cena: остаток не может превышать начисленное. Именно на этом
  // ловится подмена столбца — r_charge выглядел остатком, пока по Cena ничего
  // не было погашено, и разошёлся только после первой частичной оплаты.
  const chargeRemaining = balance.buckets.charge ?? 0;
  const chargeTotal = balance.diagnostics?.r_charge?.minor;
  if (chargeTotal !== null && chargeTotal !== undefined && chargeRemaining > chargeTotal) {
    out.push(finding('charge_source_suspicious', 'warning',
      `остаток Cena (${SOURCE_COLUMN.charge} = ${fromMinor(chargeRemaining)}) больше начисленного ` +
      `(r_charge = ${fromMinor(chargeTotal)}). Похоже, столбец-источник для charge выбран неверно — ` +
      `сверьтесь через probe, прежде чем отправлять проводку.`,
      { chargeColumn: SOURCE_COLUMN.charge, chargeRemaining, chargeTotal }));
  }

  const priorWriteoff = String(balance.meta.writeoff ?? '0');
  if (priorWriteoff && Number(priorWriteoff) > 0) {
    out.push(finding('prior_writeoff', 'warning',
      `по кредиту уже есть отписы (writeoff=${priorWriteoff}) — убедитесь, что это не повтор`,
      { writeoff: priorWriteoff }));
  }

  const rDebt = balance.meta.r_debt;
  if (rDebt !== undefined && String(rDebt) !== '' && Number(rDebt) !== Number(fromMinor(balance.debt))) {
    out.push(finding('debt_r_debt_mismatch', 'warning',
      `debt=${fromMinor(balance.debt)} и r_debt=${rDebt} расходятся`,
      { debt: fromMinor(balance.debt), rDebt }));
  }

  for (const [column, label] of [['sold', 'кредит продан'], ['archive', 'кредит в архиве']]) {
    const value = balance.meta[column];
    if (value === undefined) continue;
    const isSet = !(value === '' || value === '0' || value === 0 || /^0000-00-00/.test(String(value)));
    if (isSet) {
      out.push(finding(`flag_${column}`, 'warning', `${label} (${column}=${value})`, { [column]: value }));
    }
  }

  return out;
}

function hasBlocking(findings) {
  return findings.some((f) => f.severity === 'error');
}

// Гарды, которые не снимаются даже --force: они означают, что модуль
// не понимает данные, а не что оператор берёт риск на себя.
function hasUnforgivable(findings) {
  return findings.some((f) => f.severity === 'error' && HARD_CODES.has(f.code));
}

module.exports = { evaluate, hasBlocking, hasUnforgivable, HARD_CODES };

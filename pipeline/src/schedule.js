'use strict';

// ----------------------------------------------------------------------------
// Jediny zdroj pravdy pro vypocet splatkoveho grafiku.
//
// Puvodne byl vypocet zdvojeny: el4/electron3/src/calendar.js volal
// require('./schedule') (computeSchedule), ktery v repozitari fyzicky
// neexistuje, a el4/electron3/renderer/index.html mel vlastni JS implementaci
// (calcSchedule()) primo v prohlizeci. Tady je jedna implementace a bezi na
// serveru — stejny princip jako u odpisu (server.js: "Planu z prohlizece
// duverovat nelze", plan se pocita znovu). Klient smi jen ukazat nahled.
// ----------------------------------------------------------------------------

function guard(code, message, data = {}) {
  return { code, message, data };
}

function daysInMonth(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function pp(n) { return String(n).padStart(2, '0'); }

function addMonths(year, monthIndex0, day, offset) {
  const idx = monthIndex0 + offset;
  const y = year + Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  const d = Math.min(day, daysInMonth(y, m));
  return { year: y, monthIndex0: m, day: d };
}

function toIso(year, monthIndex0, day) {
  return `${year}-${pp(monthIndex0 + 1)}-${pp(day)}`;
}

function toCzech(year, monthIndex0, day) {
  return `${pp(day)}.${pp(monthIndex0 + 1)}.${year}`;
}

// Vstup: startDate 'YYYY-MM-DD', total (Kc), a bud perPayment, nebo months.
// Vystup: { ok, guards, months, perPayment, lastAmount, total, startDate,
//           endDate, fmtStart, fmtEnd, rows: [{n, date, amount}] }
function computeSchedule({ startDate, total, perPayment, months } = {}) {
  const guards = [];

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startDate || ''));
  if (!m) {
    guards.push(guard('start_date_invalid',
      `startDate musi byt ve tvaru YYYY-MM-DD, prislo ${JSON.stringify(startDate)}`));
  }

  const totalNum = Number(total);
  if (!Number.isFinite(totalNum) || totalNum <= 0) {
    guards.push(guard('total_invalid', `total musi byt kladne cislo, prislo ${JSON.stringify(total)}`));
  }

  let perPaymentNum;
  let monthsNum;
  const hasPerPayment = perPayment !== undefined && perPayment !== null && perPayment !== '';
  const hasMonths = months !== undefined && months !== null && months !== '';

  if (hasPerPayment) {
    perPaymentNum = Number(perPayment);
    if (!Number.isFinite(perPaymentNum) || perPaymentNum <= 0) {
      guards.push(guard('per_payment_invalid',
        `perPayment musi byt kladne cislo, prislo ${JSON.stringify(perPayment)}`));
    }
  } else if (hasMonths) {
    monthsNum = Number(months);
    if (!Number.isInteger(monthsNum) || monthsNum <= 0) {
      guards.push(guard('months_invalid', `months musi byt kladne cele cislo, prislo ${JSON.stringify(months)}`));
    }
  } else {
    guards.push(guard('missing_input', 'zadejte perPayment nebo months'));
  }

  if (guards.length) return { ok: false, guards };

  const [, yStr, moStr, dStr] = m;
  const year = Number(yStr);
  const monthIndex0 = Number(moStr) - 1;
  const day = Number(dStr);

  if (monthsNum === undefined) {
    monthsNum = (perPaymentNum >= totalNum) ? 1 : Math.ceil(totalNum / perPaymentNum);
  }
  if (perPaymentNum === undefined) {
    perPaymentNum = Math.ceil(totalNum / monthsNum);
  }

  const rows = [];
  let remaining = totalNum;
  for (let i = 0; i < monthsNum; i += 1) {
    const isLast = i === monthsNum - 1;
    const amount = isLast ? remaining : perPaymentNum;
    const { year: ry, monthIndex0: rm, day: rd } = addMonths(year, monthIndex0, day, i);
    rows.push({ n: i + 1, date: toIso(ry, rm, rd), amount: Math.round(amount) });
    remaining -= amount;
  }

  const last = rows[rows.length - 1];
  const [lastY, lastMo, lastD] = last.date.split('-').map(Number);

  return {
    ok: true,
    guards: [],
    months: monthsNum,
    perPayment: perPaymentNum,
    lastAmount: last.amount,
    total: totalNum,
    startDate: toIso(year, monthIndex0, day),
    endDate: last.date,
    fmtStart: toCzech(year, monthIndex0, day),
    fmtEnd: toCzech(lastY, lastMo - 1, lastD),
    rows,
  };
}

module.exports = { computeSchedule };

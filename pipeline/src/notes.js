'use strict';

// ----------------------------------------------------------------------------
// Poznamky pipeline. Dva rozdilne texty podle kroku:
//
//  - buildScheduleNote(): dlouhy text s casovym razitkem, jde do Google
//    Sheets (krok 2), do poznamky klienta a pujcky (krok 10) a do samotneho
//    formulare kalendare (schedule_notes, kroky 7-8). Priklad ze zadani:
//      "2026-07-08 15:33 - mám DoN, Klient platí 3000 po 500 od 08.07.2026 do 08.12.2026"
//
//  - writeoffNote(): kratky text jen "DoN" nebo "EPR" pro odpis (krok 6) —
//    operator to vyslovne oddelil od dlouhe poznamky.
// ----------------------------------------------------------------------------

const { config } = require('./config');

const stampFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: config.NOTE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

function noteStamp(date = new Date()) {
  return stampFmt.format(date).replace(',', '');
}

function assertType(type) {
  if (type !== 'DON' && type !== 'EPR') {
    throw new Error(`neznamy typ dohody ${JSON.stringify(type)}, ocekavano DON|EPR`);
  }
}

function buildScheduleNote({ type, schedule, date = new Date() }) {
  assertType(type);
  const label = type === 'DON' ? 'mám DoN' : 'EPR';
  return `${noteStamp(date)} - ${label}, Klient platí ${schedule.total} po ${schedule.perPayment}`
    + ` od ${schedule.fmtStart} do ${schedule.fmtEnd}`;
}

function writeoffNote(type) {
  assertType(type);
  return type === 'DON' ? 'DoN' : 'EPR';
}

module.exports = { buildScheduleNote, writeoffNote, noteStamp };

'use strict';

// ----------------------------------------------------------------------------
// Zapis poznamky do Google Sheets, list "Datová schránka reklamace" (krok 2).
//
// Hledame radek podle ID klienta ve sloupci A a zapisujeme do prvni prazdne
// bunky od sloupce X (index 23) doprava — kazda bunka v radku od X je
// "Poznámka o průběhu řešení".
//
// Rozhodnuti (potvrzeno operatorem): pipeline bezi az na uplnem konci, kdyz
// je komunikace s klientem uz uzavrena — pokud klient v teto tabulce vubec
// neni, jde o chybu dat, a krok se natvrdo zastavi s chybovou hláškou, misto
// aby tise vytvarel novy radek nebo pokracoval dal.
// ----------------------------------------------------------------------------

const { google } = require('googleapis');
const { config } = require('./config');

let sheetsClientPromise = null;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.GOOGLE_CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClientPromise = auth.getClient()
      .then((authClient) => google.sheets({ version: 'v4', auth: authClient }));
  }
  return sheetsClientPromise;
}

// 0-based index sloupce -> pismeno (0 -> A, 23 -> X, 26 -> AA, ...).
function colToLetter(index0) {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function resolveSheetTitle(sheets) {
  if (config.SHEET_NAME) return config.SHEET_NAME;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.SHEET_ID,
    fields: 'sheets.properties',
  });
  const match = (meta.data.sheets || []).find(
    (s) => String(s.properties.sheetId) === String(config.SHEET_GID),
  );
  if (!match) {
    throw new Error(`List s gid=${config.SHEET_GID} v tabulce nenalezen (zkontrolujte CREDITGO_SHEET_GID).`);
  }
  return match.properties.title;
}

async function writeScheduleNote({ customerId, note }) {
  const sheets = await getSheetsClient();
  const title = await resolveSheetTitle(sheets);

  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: `'${title}'!A:A`,
  });
  const rows = colA.data.values || [];
  const rowIndex0 = rows.findIndex((r) => String((r && r[0]) || '').trim() === String(customerId).trim());

  if (rowIndex0 === -1) {
    const err = new Error(
      `Klient ${customerId} nebyl nalezen ve sloupci A tabulky "Datová schránka reklamace". ` +
      'Pipeline se v tomto kroku zastavuje — pokud pipeline běží, komunikace by měla být ' +
      'uzavřená a klient by v tabulce měl existovat. Zkontrolujte prosím ID klienta a tabulku ručně.',
    );
    err.code = 'sheet_row_not_found';
    throw err;
  }
  const rowNumber1 = rowIndex0 + 1;

  const startLetter = colToLetter(config.SHEET_NOTE_START_COL);
  const rowRange = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: `'${title}'!${startLetter}${rowNumber1}:ZZ${rowNumber1}`,
  });
  const existing = (rowRange.data.values && rowRange.data.values[0]) || [];
  const firstEmptyOffset = existing.findIndex((cell) => String(cell || '').trim() === '');
  const targetOffset = firstEmptyOffset === -1 ? existing.length : firstEmptyOffset;
  const targetColIndex0 = config.SHEET_NOTE_START_COL + targetOffset;
  const targetLetter = colToLetter(targetColIndex0);
  const targetCell = `'${title}'!${targetLetter}${rowNumber1}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.SHEET_ID,
    range: targetCell,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[note]] },
  });

  return { row: rowNumber1, cell: `${targetLetter}${rowNumber1}` };
}

module.exports = { writeScheduleNote, resolveSheetTitle, colToLetter };

'use strict';

// ----------------------------------------------------------------------------
// Konfigurace modulu "Splátkový kalendář" (pipeline).
//
// CRM API klíč a doménu NEDUPLIKUJEME — bereme je z už nakonfigurovaného
// modulu odpisu (writeoff/src/config.js), stejně jako to dělá
// writeoff-bridge.js pro server.js. Nový klíč jen tehdy, když pipeline
// potřebuje něco, co odpis nepotřebuje (Playwright login, Google Sheets).
// ----------------------------------------------------------------------------

const { config: writeoffConfig } = require('../../writeoff/src/config');

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name}: ocekavalo se cele cislo, prislo ${JSON.stringify(v)}`);
  return n;
}

const config = {
  // Sdilene s modulem odpisu.
  BASE_URL: writeoffConfig.BASE_URL,
  API_KEY: writeoffConfig.API_KEY,
  AUTH_MODE: writeoffConfig.AUTH_MODE,
  HTTP_TIMEOUT_MS: writeoffConfig.HTTP_TIMEOUT_MS,

  // Login do webove administrace CRM (admin.php) — API klic tam neplati,
  // formular kalendare zije za beznou session prohlizece. Krok 7 (Playwright).
  ADMIN_USER: process.env.CREDITGO_ADMIN_USER || '',
  ADMIN_PASS: process.env.CREDITGO_ADMIN_PASS || '',

  // Kategorie (kroky 3-4). Vychozi hodnoty odpovidaji tomu, co uz je
  // napsane v el4/electron3/src/config.js (CATEGORY_SPLATKOVY=21) a v
  // popisu procesu (credits/category -> 155).
  CATEGORY_CUSTOMER: envInt('CREDITGO_PIPELINE_CUSTOMER_CATEGORY', 21),
  CATEGORY_CREDIT: envInt('CREDITGO_PIPELINE_CREDIT_CATEGORY', 155),

  // Duvody blacklistu — vybira operator na zacatku (spolu s ID klienta),
  // ne uprostred pipeline jako v el4/electron3 UI.
  BLACKLIST_REASONS: {
    16: 'EPR',
    3: 'Client',
    5: 'Financial Arbitrator',
    4: 'Attorney',
    6: 'Attorney and Financial Arbitrator',
  },
  // Fixni text poznamky pro blacklist (krok 9) — podle zadani vzdy stejny.
  BLACKLIST_NOTE: 'Splátkový kalendář',

  // Google Sheets (krok 2) — "Datová schránka reklamace".
  SHEET_ID: process.env.CREDITGO_SHEET_ID || '',
  SHEET_GID: process.env.CREDITGO_SHEET_GID || '',
  SHEET_NAME: process.env.CREDITGO_SHEET_NAME || '',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  // Sloupec A = ID klienta. Poznamka jde do prvni prazdne bunky od tohoto
  // sloupce doprava. Index 0-based, 23 = sloupec "X" (presne jak v zadani).
  SHEET_NOTE_START_COL: envInt('CREDITGO_SHEET_NOTE_START_COL', 23),

  ACTOR: process.env.CREDITGO_ACTOR || '',
  NOTE_TZ: process.env.NOTE_TIMEZONE || 'Europe/Prague',

  CALENDAR_TIMEOUT_MS: envInt('CREDITGO_CALENDAR_TIMEOUT_MS', 60000),
};

// Volitelna kontrola pred spustenim pipeline — ukazuje operatorovi/adminovi
// srozumitelnou chybu misto tajemneho selhani uprostred kroku 2 nebo 7.
function assertPipelineUsable(cfg = config) {
  const missing = [];
  if (!cfg.API_KEY) missing.push('CREDITGO_API_KEY');
  if (!cfg.ADMIN_USER) missing.push('CREDITGO_ADMIN_USER');
  if (!cfg.ADMIN_PASS) missing.push('CREDITGO_ADMIN_PASS');
  if (!cfg.SHEET_ID) missing.push('CREDITGO_SHEET_ID');
  if (!cfg.GOOGLE_CREDENTIALS_PATH) missing.push('GOOGLE_APPLICATION_CREDENTIALS');
  if (missing.length) {
    throw new Error(`Pipeline neni nakonfigurovana — chybi promenne: ${missing.join(', ')}`);
  }
  return cfg;
}

module.exports = { config, assertPipelineUsable };

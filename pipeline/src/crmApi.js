'use strict';

// ----------------------------------------------------------------------------
// Tenke obalky nad CRM API, ktere modul odpisu nema: zmena kategorii,
// poznamky, blacklist. Prevzato z el4/electron3/src/api.js — stejny kontrakt
// (HTTP 200 != uspech, skutecny vysledek je v envelope.status, klic v hlavicce
// x-api-key). BASE_URL/API_KEY bereme z pipeline/src/config.js, ktery je
// zase bere z jiz nakonfigurovaneho modulu odpisu — jedno misto pravdy.
//
// POZOR na dve neoverene veci (oznaceno i u prislusnych funkci nize):
//  - putCreditCategory: endpoint /api/v1.0/credits/category nebyl v puvodnim
//    kodu pouzit, nazvy parametru (creditId/categoryId) jsou odhad podle
//    sesterskeho customers/category. Overit prvnim skutecnym volanim.
//  - postBlacklist: OPRAVENO 2026-09-04 podle crm_api.pdf (customer
//    function postBlacklist()) po realnem selhani "InvalidArgument: No
//    unique fields provided". CRM tento endpoint VUBEC nezna pole
//    "customerId" ani "notes" — bere jen: personCode, idNumber,
//    accountNumber, ip, description, fullName, phone, phone2, email,
//    email2, source, adminId, reasonId, date, a vyzaduje aspon JEDNO z
//    "unikatnich" poli (personCode/idNumber/accountNumber/phone/phone2/
//    email/email2/ip) — bez nich vraci prave tuto chybu. Puvodni kod
//    posilal jen customerId+reasonId+notes, coz CRM tise ignorovalo jako
//    neznama pole, a bez jedineho unikatniho pole vzdy selhalo.
// ----------------------------------------------------------------------------

const { config } = require('./config');

class PipelineApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PipelineApiError';
    Object.assign(this, details);
  }
}

async function call(path, { method = 'GET', query = {}, body = null } = {}) {
  const url = new URL(config.BASE_URL.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }

  const headers = { 'x-api-key': config.API_KEY, Accept: 'application/json' };
  const init = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.HTTP_TIMEOUT_MS);
  init.signal = ac.signal;

  let res;
  let text;
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new PipelineApiError(`timeout ${config.HTTP_TIMEOUT_MS}ms: ${method} ${path}`, { path, method });
    }
    throw new PipelineApiError(`sitova chyba: ${method} ${path}: ${err.message}`, { path, method, cause: err });
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PipelineApiError(
      `odpoved neni JSON (HTTP ${res.status}) na ${method} ${path}: ${text.slice(0, 300)}`,
      { httpStatus: res.status, path, method },
    );
  }

  if (json.status !== 200) {
    throw new PipelineApiError(
      `API vratilo status=${json.status} na ${method} ${path}${json.message ? `: ${json.message}` : ''}`,
      { apiStatus: json.status, apiMessage: json.message, path, method },
    );
  }
  return json;
}

// Krok 3: kategorie klienta (vychozi 21 — splátkový kalendář).
async function putCategory({ customerId, categoryId }) {
  return call('/api/v1.0/customers/category', {
    method: 'PUT',
    query: { customerId: Number(customerId), categoryId: Number(categoryId) },
  });
}

// Krok 4: kategorie pujcky (vychozi 155). NEOVERENO — viz poznamka nahore.
async function putCreditCategory({ creditId, categoryId }) {
  return call('/api/v1.0/credits/category', {
    method: 'PUT',
    query: { creditId: Number(creditId), categoryId: Number(categoryId) },
  });
}

// Krok 10a: poznamka do profilu klienta.
async function postCustomerNotes({ customerId, notes }) {
  return call('/api/v1.0/special/customer-notes', {
    method: 'POST',
    query: { customerId: Number(customerId), notes },
  });
}

// Krok 10b: poznamka do pujcky.
async function postLoanNotes({ loanId, notes, userName }) {
  const query = { loanId: Number(loanId), notes };
  if (userName) query.userName = userName;
  return call('/api/v1.0/special/loan-notes', { method: 'POST', query });
}

// Krok 9: blacklist. Podle crm_api.pdf CRM vyzaduje aspon jedno
// "unikatni" identifikacni pole klienta (personCode/idNumber/
// accountNumber/phone/phone2/email/email2/ip) — customerId tento endpoint
// vubec nezna. Ktera pole u konkretniho klienta mame, zjisti volajici
// (orchestrator) z exportu (krok 1, read_balance) pomoci
// resolveBlacklistUniqueFields nize a preda je sem uz vyresene.
async function postBlacklist({
  reasonId, description,
  personCode, idNumber, accountNumber, ip, phone, phone2, email, email2,
  fullName, source, adminId, date,
} = {}) {
  const unique = { personCode, idNumber, accountNumber, ip, phone, phone2, email, email2 };
  const hasUnique = Object.values(unique).some((v) => v !== undefined && v !== null && String(v).trim() !== '');
  if (!hasUnique) {
    throw new PipelineApiError(
      'postBlacklist: nebylo nalezeno zadne unikatni identifikacni pole klienta '
      + '(personCode/idNumber/accountNumber/phone/phone2/email/email2/ip) — CRM API '
      + '(customers/blacklist) bez nich vzdy vraci "InvalidArgument: No unique fields provided".',
      { code: 'no_unique_field' },
    );
  }

  const query = { reasonId: Number(reasonId) };
  if (description) query.description = description;
  for (const [k, v] of Object.entries({
    personCode, idNumber, accountNumber, ip, phone, phone2, email, email2, fullName, source,
  })) {
    if (v !== undefined && v !== null && String(v).trim() !== '') query[k] = v;
  }
  if (adminId !== undefined && adminId !== null && adminId !== '') query.adminId = Number(adminId);
  if (date) query.date = date;

  return call('/api/v1.0/customers/blacklist', { method: 'POST', query });
}

// Z "raw" radky exportu (id 229, viz writeoff/src/exportReader.js:pick) se
// pokusi vytahnout unikatni identifikacni pole klienta pro postBlacklist.
// Nazvy sloupcu v tomto konkretnim exportu nejsou jiste (nebyly overeny
// proti zivym datum), proto zkousime nekolik pravdepodobnych variant pro
// kazde pole pres stejne "pick" pravidlo, jake pouziva zbytek modulu odpisu
// (presna shoda, nebo shoda_s_indexem typu "phone_12"). Kdyz se nenajde
// vubec nic, vyhodime chybu VCETNE seznamu vsech sloupcu, ktere export
// skutecne vratil — aby bylo hned videt, jak se dany sloupec doopravdy
// jmenuje, a priste uz jen doplnime spravny nazev do CANDIDATES.
function resolveBlacklistUniqueFields(raw, { pick, hasColumn }) {
  const CANDIDATES = {
    phone: ['phone', 'customer_phone', 'customers.phone', 'tel', 'telephone'],
    phone2: ['phone2', 'customer_phone2', 'customers.phone2'],
    email: ['email', 'customer_email', 'customers.email', 'mail'],
    email2: ['email2', 'customer_email2', 'customers.email2'],
    personCode: ['person_code', 'personCode', 'customers.person_code', 'birth_number', 'rodne_cislo'],
    idNumber: ['id_number', 'idNumber', 'customers.id_number', 'identity_card'],
    accountNumber: ['account_number', 'accountNumber', 'customers.account_number', 'bank_account'],
  };

  const found = {};
  for (const [field, columns] of Object.entries(CANDIDATES)) {
    for (const column of columns) {
      if (hasColumn(raw, column)) {
        const value = pick(raw, column);
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          found[field] = value;
          break;
        }
      }
    }
  }

  if (Object.keys(found).length === 0) {
    const err = new PipelineApiError(
      'V exportu klienta se nenasel zadny sloupec s telefonem/e-mailem/rodnym cislem/'
      + 'cislem uctu, ktery by CRM prijalo jako "unikatni pole" pro blacklist. '
      + `Skutecne sloupce v exportu: ${Object.keys(raw || {}).join(', ') || '(zadne)'}. `
      + 'Opravte CANDIDATES v resolveBlacklistUniqueFields (pipeline/src/crmApi.js) '
      + 'podle spravneho nazvu sloupce.',
      { code: 'no_unique_field', rawColumns: Object.keys(raw || {}) },
    );
    throw err;
  }
  return found;
}

module.exports = {
  call, PipelineApiError,
  putCategory, putCreditCategory, postCustomerNotes, postLoanNotes, postBlacklist,
  resolveBlacklistUniqueFields,
};

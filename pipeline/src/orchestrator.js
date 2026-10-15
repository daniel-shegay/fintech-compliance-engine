'use strict';

// ----------------------------------------------------------------------------
// Orchestrator pipeline "Splátkový kalendář" — kroky 1-10.
//
// Stav operace drzime v pameti procesu (rozhodnuto vedome: modul pouziva
// jeden clovek najednou, pretrvani restartu kontejneru neni potreba — na
// rozdil od audit-logu odpisu, ktery MUSI prezit, protoze resi idempotenci
// penez). Kazda operace je objekt v Map, pipeline bezi krok za krokem a
// zastavuje se na rucnich checkpointech (pause_reminders, calendar_confirm),
// dokud operator nezavola confirmStep().
//
// Vyber kategorie blacklistu a typu dohody (DON/EPR) se deje NA ZACATKU,
// spolu s ID klienta/pujcky — na rozdil od el4/electron3 UI, kde se
// kategorie blacklistu vybirala uprostred pipeline. Prepinace jednotlivych
// kroku (TOGGLEABLE v el4) zustavaji zachovany.
// ----------------------------------------------------------------------------

const crypto = require('node:crypto');
const writeoff = require('../../writeoff-bridge');
const { pick, hasColumn } = require('../../writeoff/src/exportReader');
const crmApi = require('./crmApi');
const sheets = require('./sheets');
const calendarForm = require('./calendarForm');
const { computeSchedule } = require('./schedule');
const { buildScheduleNote, writeoffNote } = require('./notes');
const { config } = require('./config');

const operations = new Map();

// --- definice kroku ----------------------------------------------------------
//
// toggleKey: null      -> krok je povinny, nelze vypnout (jen read_balance).
// toggleKey: 'x'        -> krok patri pod prepinac 'x' (calendar_launch i
//                          calendar_confirm sdileji jeden prepinac 'calendar',
//                          presne jako TOGGLEABLE.calendar v el4).
// manual: true          -> krok ceka na potvrzeni operatora (confirmStep).

const STEP_DEFS = [
  {
    name: 'read_balance', label: 'Čtení zůstatků', toggleKey: null,
    async run(op) {
      const { rows } = await writeoff.fetchCreditRows({
        customerId: op.input.customerId, creditId: op.input.creditId,
      });
      const balance = writeoff.buildBalance(writeoff.selectCreditRow(rows, op.input.creditId));
      op.balance = balance;
      return { debt: balance.debt };
    },
  },
  {
    name: 'sheets_write', label: 'Zápis do Google Sheets', toggleKey: 'sheets_write',
    async run(op) {
      return sheets.writeScheduleNote({ customerId: op.input.customerId, note: op.input.note });
    },
  },
  {
    name: 'category', label: `Kategorie klienta → ${config.CATEGORY_CUSTOMER}`, toggleKey: 'category',
    async run(op) {
      return crmApi.putCategory({ customerId: op.input.customerId, categoryId: config.CATEGORY_CUSTOMER });
    },
  },
  {
    name: 'credit_category', label: `Kategorie půjčky → ${config.CATEGORY_CREDIT}`, toggleKey: 'credit_category',
    async run(op) {
      return crmApi.putCreditCategory({ creditId: op.input.creditId, categoryId: config.CATEGORY_CREDIT });
    },
  },
  {
    name: 'pause_reminders', label: 'Pauza upomínek', toggleKey: 'pause_reminders', manual: true,
    prompt: 'Poznamenejte upomínky na pauzu v CRM ručně, poté potvrďte zde.',
    async run() { return { manual: true }; },
  },
  {
    name: 'writeoff', label: 'Odpis dluhu', toggleKey: 'writeoff',
    async run(op) {
      const plan = await writeoff.buildPlan({
        customerId: op.input.customerId, creditId: op.input.creditId, target: op.input.targetTotal,
      });
      if (!plan.ok) {
        const err = new Error('Odpis zablokovaly kontroly dat (viz findings).');
        err.code = 'writeoff_blocked';
        err.findings = plan.findings;
        throw err;
      }
      const result = await writeoff.applyPlan(plan, {
        live: true,
        actor: op.actor,
        notes: writeoffNote(op.input.type),
      });
      return { writeoffId: result.writeoffId || null, status: result.status };
    },
  },
  {
    name: 'calendar_launch', label: 'Formulář kalendáře', toggleKey: 'calendar',
    async run(op) {
      const { screenshot } = await calendarForm.fillCalendarForm(op.operationId, {
        customerId: op.input.customerId,
        creditId: op.input.creditId,
        startDate: op.input.schedule.startDate,
        schedule: op.input.schedule,
        note: op.input.note,
      });
      op.calendarScreenshot = screenshot;
      return { screenshotReady: true };
    },
  },
  {
    name: 'calendar_confirm', label: 'Potvrzení kalendáře', toggleKey: 'calendar', manual: true,
    prompt: 'Zkontrolujte screenshot vyplněného formuláře a potvrďte, že údaje souhlasí.',
    async run(op) {
      await calendarForm.confirmCalendarForm(op.operationId);
      op.calendarScreenshot = null;
      return { confirmed: true };
    },
  },
  {
    name: 'blacklist', label: 'Blacklist', toggleKey: 'blacklist',
    async run(op) {
      // CRM (customers/blacklist) nezna "customerId" jako identifikator —
      // vyzaduje aspon jedno "unikatni" pole klienta (telefon/e-mail/rodne
      // cislo/cislo uctu apod, viz crm_api.pdf). Bereme je ze
      // "syrove" radky exportu, ktera se ulozila uz v kroku read_balance
      // (op.balance.raw) — zadny dalsi HTTP volani netreba.
      const uniqueFields = crmApi.resolveBlacklistUniqueFields(op.balance && op.balance.raw, { pick, hasColumn });
      return crmApi.postBlacklist({
        ...uniqueFields,
        reasonId: op.input.blacklistReasonId,
        description: config.BLACKLIST_NOTE,
      });
    },
  },
  {
    name: 'notes_final', label: 'Finální poznámky', toggleKey: 'notes_final',
    async run(op) {
      const customer = await crmApi.postCustomerNotes({ customerId: op.input.customerId, notes: op.input.note });
      const loan = await crmApi.postLoanNotes({ loanId: op.input.creditId, notes: op.input.note, userName: op.actor });
      return { customer, loan };
    },
  },
];

// --- pomocne funkce ------------------------------------------------------------

function newOperationId() { return crypto.randomUUID(); }

function serialize(op) {
  const steps = {};
  for (const def of STEP_DEFS) steps[def.name] = op.steps[def.name];
  return {
    operationId: op.operationId,
    status: op.status,
    waitingFor: op.waitingFor || null,
    prompt: op.prompt || null,
    failedAt: op.failedAt || null,
    error: op.error || null,
    steps,
    hasCalendarScreenshot: Boolean(op.calendarScreenshot),
  };
}

function markSkippedSteps(op) {
  for (const def of STEP_DEFS) {
    if (def.toggleKey && op.skipped.has(def.toggleKey)) {
      op.steps[def.name] = { status: 'skipped' };
    }
  }
}

// --- sestaveni a spusteni operace ----------------------------------------------

function buildOperation({
  customerId, creditId, type, blacklistReasonId, targetTotal,
  calStartDate, calPerPayment, calTotal, skippedSteps, actor,
}) {
  if (!Object.prototype.hasOwnProperty.call(config.BLACKLIST_REASONS, Number(blacklistReasonId))) {
    const err = new Error(`Neplatné ID kategorie blacklistu: ${blacklistReasonId}`);
    err.code = 'reason_invalid';
    throw err;
  }

  const schedule = computeSchedule({ startDate: calStartDate, total: calTotal, perPayment: calPerPayment });
  if (!schedule.ok) {
    const err = new Error(`Chyba výpočtu harmonogramu: ${schedule.guards.map((g) => g.message).join('; ')}`);
    err.code = 'schedule_invalid';
    throw err;
  }
  const note = buildScheduleNote({ type, schedule });

  const op = {
    operationId: newOperationId(),
    createdAt: new Date().toISOString(),
    actor,
    input: {
      customerId: String(customerId), creditId: String(creditId), type,
      blacklistReasonId: Number(blacklistReasonId), targetTotal, schedule, note,
    },
    skipped: new Set(skippedSteps || []),
    steps: {},
    status: 'running',
    waitingFor: null,
    prompt: null,
    cursor: 0,
    calendarScreenshot: null,
  };
  for (const def of STEP_DEFS) op.steps[def.name] = { status: 'pending' };
  markSkippedSteps(op);
  operations.set(op.operationId, op);
  return op;
}

async function advance(op) {
  while (op.cursor < STEP_DEFS.length) {
    const def = STEP_DEFS[op.cursor];
    if (op.steps[def.name].status === 'skipped') { op.cursor += 1; continue; }

    if (def.manual && !op.steps[def.name].confirmed) {
      op.status = 'paused';
      op.waitingFor = def.name;
      op.prompt = def.prompt;
      op.steps[def.name] = { ...op.steps[def.name], status: 'active' };
      return;
    }

    op.steps[def.name] = { ...op.steps[def.name], status: 'active' };
    try {
      const result = await def.run(op);
      op.steps[def.name] = { status: 'done', result };
    } catch (err) {
      op.steps[def.name] = { status: 'failed', error: err.message, findings: err.findings || null };
      op.status = 'failed';
      op.failedAt = def.name;
      op.error = err.message;
      // Krok kalendare pri chybe muze prinest screenshot stranky, na ktere
      // se Playwright ve skutecnosti ocitl — ulozime ho, aby ho operator
      // videl stejnym /calendar-preview.png, jakym by videl uspesny nahled.
      if (err.debugScreenshot) op.calendarScreenshot = err.debugScreenshot;
      return;
    }
    op.cursor += 1;
  }
  op.status = 'complete';
  op.waitingFor = null;
  op.prompt = null;
}

async function start(input) {
  const op = buildOperation(input);
  await advance(op);
  return serialize(op);
}

async function confirmStep(operationId, stepName) {
  const op = operations.get(operationId);
  if (!op) {
    const err = new Error('Operace nenalezena (stav pipeline se nepamatuje na disk, po restartu serveru mizí).');
    err.code = 'operation_not_found';
    throw err;
  }
  if (op.status !== 'paused' || op.waitingFor !== stepName) {
    const err = new Error(`Krok "${stepName}" teď nečeká na potvrzení (aktuální stav: ${op.status}/${op.waitingFor}).`);
    err.code = 'step_not_waiting';
    throw err;
  }
  op.steps[stepName] = { ...op.steps[stepName], confirmed: true };
  await advance(op);
  return serialize(op);
}

function getStatus(operationId) {
  const op = operations.get(operationId);
  return op ? serialize(op) : null;
}

function getCalendarScreenshot(operationId) {
  const op = operations.get(operationId);
  return op ? op.calendarScreenshot : null;
}

module.exports = { start, confirmStep, getStatus, getCalendarScreenshot, STEP_DEFS };

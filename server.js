require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const access = require('./access');
const writeoff = require('./writeoff-bridge');
const pipeline = require('./pipeline/src/orchestrator');
const mockCrm = require('./mock-crm');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');
const API_BASE = process.env.API_BASE_URL
  || 'https://api.crm-lending.example/api/v1.0/export/export';
const JWT_SECRET = process.env.JWT_SECRET || (mockCrm.isMockMode() ? 'demo-secret-key-min-32-chars-long-for-local-testing' : null);
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const PORT = process.env.PORT || 3000;

// Status keywords that flag a loan as "sold / assigned to collection"
const SOLD_KEYWORDS = (
  process.env.SOLD_STATUS_KEYWORDS || 'prodán,prodáno,prodana,sold,postoupeno,postoupená'
).split(',').map(s => s.trim().toLowerCase());

// ── Field-name mapping (configurable via .env) ────────────────────────────────
// Table 234 — loans export (assoc field aliases)
const F_LOAN = {
  id: process.env.F_LOAN_ID || 'id_0',
  typ: process.env.F_LOAN_TYP || 'typ_produktu',
  status: process.env.F_LOAN_STATUS || 'credit_status',
  customerId: process.env.F_LOAN_CUSTOMER || 'customer_id_3',
  origin: process.env.F_LOAN_ORIGIN || 'origin_id_4',
  created: process.env.F_LOAN_CREATED || 'created_5',
  expire: process.env.F_LOAN_EXPIRE || 'expire_6',
  amount: process.env.F_LOAN_AMOUNT || 'amount_7',
  delay: process.env.F_LOAN_DELAY || 'delay_8',
  tax7: process.env.F_LOAN_TAX7 || 'tax7_9',      // castka_na_prodlouzeni
  charge: process.env.F_LOAN_CHARGE || 'charge_10',   // naklady_na_pujcku
  lateFee: process.env.F_LOAN_LATE_FEE || 'late_fee_11', // smluvni_pokuta
  cinterest: process.env.F_LOAN_CINTEREST || 'cinterest_12',// kompenzacni_urok
  upominky: process.env.F_LOAN_UPOMINKY || 'upominky',
  tax6: process.env.F_LOAN_TAX6 || 'tax6_14',     // inkasni_agentura
  tax8: process.env.F_LOAN_TAX8 || 'tax8_15',     // vymahani_ia
  debt: process.env.F_LOAN_DEBT || 'debt_16',
};

// Table 230 — detailed payments export (one row per payment transaction)
// Unlike table 233, ALL financial fields here are per-row incremental — sum them.
// writeoff_30 is a credit-level field (credits.writeoff) — overwrite, not sum.
const F_PAY = {
  creditId: process.env.F_PAY_CREDIT_ID || 'credit_id_1',
  // Payment allocation fields (all incremental — SUM across rows)
  jistina: process.env.F_PAY_JISTINA || 'amount_4',
  prodlouzeni: process.env.F_PAY_PRODL || 'tax7_18',
  naklady: process.env.F_PAY_NAKLADY || 'charge_5',
  pokuta: process.env.F_PAY_POKUTA || 'late_fee_10',
  kompUrk: process.env.F_PAY_KOMP_URK || 'cinterest_7',
  // upominky = tax2 + tax3 + tax4 + tax5 (handled separately in loop)
  upominky1: process.env.F_PAY_UPOM1 || 'tax2_13',
  upominky2: process.env.F_PAY_UPOM2 || 'tax3_14',
  upominky3: process.env.F_PAY_UPOM3 || 'tax4_15',
  upominky4: process.env.F_PAY_UPOM4 || 'tax5_16',
  inkasni: process.env.F_PAY_INKASNI || 'tax6_17',
  vymahani: process.env.F_PAY_VYMAHANI || 'tax8_19',
  // Credit-level field (overwrite, not sum)
  writeoff: process.env.F_PAY_WRITEOFF || 'writeoff_30',
};

// All financial fields in table 230 — used to compute total platba per row
const ALL_FINANCIAL_INDICES = [
  'amount_4', 'charge_5', 'administrative_fee_6', 'cinterest_7', 'interest_8',
  'insurance_9', 'late_fee_10', 'penalty_11',
  'tax1_12', 'tax2_13', 'tax3_14', 'tax4_15', 'tax5_16', 'tax6_17', 'tax7_18',
  'tax8_19', 'tax9_20', 'tax10_21', 'tax11_22', 'tax12_23',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch { return []; }
}

/**
 * Safely extract the rows array from a CRM API response.
 * Handles multiple known response shapes.
 */
function extractRows(apiResponse) {
  const d = apiResponse?.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.rows)) return d.rows;
  if (d.data && Array.isArray(d.data)) return d.data;
  for (const key of Object.keys(d)) {
    if (Array.isArray(d[key]) && key !== 'names') return d[key];
  }
  return [];
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);

    // Роль берём из users.json, а НЕ из токена, хотя она там лежит.
    //
    // Токен живёт 8 часов. Если доверять роли внутри него, снятие прав
    // вступит в силу только когда токен истечёт — то есть у разжалованного
    // оператора останется доступ к отпису почти на рабочий день. Для системы,
    // которая двигает деньги, отзыв прав должен действовать сразу.
    //
    // Файл маленький и уже читается при каждом логине, так что чтение на
    // запрос ничего не стоит. Побочный плюс: удаление строки из users.json
    // немедленно выкидывает человека из системы.
    const user = loadUsers().find((u) => String(u.id) === String(payload.id));
    if (!user) return res.status(401).json({ error: 'Uživatel již neexistuje' });

    req.user = {
      id: user.id,
      username: user.username,
      role: access.normalizeRole(user.role),
    };
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

// ── Права ─────────────────────────────────────────────────────────────────────
// Проверяется на каждом роуте. Скрытая вкладка в интерфейсе — удобство,
// а не защита: без этой прослойки роль mail дойдёт до отписа через curl.
function requireCap(cap) {
  return function (req, res, next) {
    if (!access.can(req.user && req.user.role, cap)) {
      return res.status(403).json({ error: 'K této akci nemáte oprávnění' });
    }
    next();
  };
}

// ── Rate limiting on login ────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho pokusů o přihlášení. Zkuste to znovu za 15 minut.' },
});

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /auth/login
app.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Vyplňte uživatelské jméno a heslo' });
  }
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Nesprávné přihlašovací údaje' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Nesprávné přihlašovací údaje' });

  const role = access.normalizeRole(user.role);
  const token = jwt.sign(
    { id: user.id, username: user.username, role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
  res.json({ token, username: user.username, role, caps: access.capsOf(role) });
});

// GET /auth/me — кто я и что мне можно. Фронт рисует вкладки по этому ответу,
// а не по собственной таблице ролей: два источника правды рано или поздно
// разойдутся, и разойдутся именно в сторону лишнего доступа.
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    caps: access.capsOf(req.user.role),
  });
});

// GET /api/client/:customerId
app.get('/api/client/:customerId', requireAuth, requireCap(access.CAPS.PREHLED), async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Neplatné ID klienta' });
  }

  if (mockCrm.isMockMode()) {
    return res.json(mockCrm.getMockClientData(customerId));
  }

  const filter = JSON.stringify([
    { name: 'customers.customer_id', act: '=', value: customerId }
  ]);
  const reqParams = { apiKey: process.env.API_KEY, filter, format: 'assoc' };

  try {
    const [loansRes, paymentsRes] = await Promise.all([
      axios.get(API_BASE, { params: { ...reqParams, id: 234 }, timeout: 15000 }),
      axios.get(API_BASE, { params: { ...reqParams, id: 230 }, timeout: 15000 }),
    ]);

    if (loansRes.data?.status && loansRes.data.status !== 200) {
      return res.status(502).json({
        error: `CRM API vrátilo chybu: ${loansRes.data.message || 'neznámá'}`,
      });
    }

    const result = mergeData(loansRes.data, paymentsRes.data, customerId);
    res.json(result);

  } catch (err) {
    console.error('[API Error]', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Chyba při načítání dat z CRM', details: err.message });
  }
});

// ── Data merge ────────────────────────────────────────────────────────────────

// (ALLOC_FIELDS removed — table 230 uses direct per-row summation, see payMap loop)

function mergeData(loansRaw, paymentsRaw, customerId) {
  const loanRows = extractRows(loansRaw);
  const paymentRows = extractRows(paymentsRaw);

  // ── Aggregate payment rows by credit_id (table 230) ─────────────────────────
  // Table 230 has one row per payment transaction. ALL financial fields are
  // incremental — each row represents a distinct payment event, so we SUM them.
  // Exception: writeoff_30 is credits.writeoff (credit-level) — OVERWRITE.
  const payMap = {};

  for (const row of paymentRows) {
    const cid = String(row[F_PAY.creditId] ?? '');
    if (!cid) continue;

    if (!payMap[cid]) {
      payMap[cid] = {
        platba: 0, uhrJist: 0, prodlouzeni: 0, naklady: 0,
        pokuta: 0, kompUrk: 0, upominky: 0, inkasni: 0, vymahani: 0,
        writeoff: 0,
      };
    }

    // platba = sum of ALL financial fields in this row
    payMap[cid].platba += ALL_FINANCIAL_INDICES.reduce(
      (s, f) => s + Number(row[f] || 0), 0
    );

    // Individual breakdown fields — SUM across rows
    payMap[cid].uhrJist += Number(row[F_PAY.jistina] || 0);
    payMap[cid].prodlouzeni += Number(row[F_PAY.prodlouzeni] || 0);
    payMap[cid].naklady += Number(row[F_PAY.naklady] || 0);
    payMap[cid].pokuta += Number(row[F_PAY.pokuta] || 0);
    payMap[cid].kompUrk += Number(row[F_PAY.kompUrk] || 0);
    payMap[cid].upominky += Number(row[F_PAY.upominky1] || 0)
      + Number(row[F_PAY.upominky2] || 0)
      + Number(row[F_PAY.upominky3] || 0)
      + Number(row[F_PAY.upominky4] || 0);
    payMap[cid].inkasni += Number(row[F_PAY.inkasni] || 0);
    payMap[cid].vymahani += Number(row[F_PAY.vymahani] || 0);

    // writeoff is a credit-level field — OVERWRITE
    payMap[cid].writeoff = Number(row[F_PAY.writeoff] || 0);
  }

  // ── Map loan rows ──────────────────────────────────────────────────────────
  const loans = loanRows.map(l => {
    const cid = String(l[F_LOAN.id] ?? '');
    const paid = payMap[cid] ?? {
      platba: 0, uhrJist: 0, prodlouzeni: 0, naklady: 0,
      pokuta: 0, kompUrk: 0, upominky: 0, inkasni: 0, vymahani: 0, writeoff: 0,
    };

    // Extension loans: origin_id is non-zero / non-empty
    const originRaw = l[F_LOAN.origin];
    const isExtension = originRaw !== null && originRaw !== undefined
      && String(originRaw).trim() !== ''
      && String(originRaw).trim() !== '0';

    // "Sold to collection" detection
    const statusStr = String(l[F_LOAN.status] ?? '');
    const prodan = SOLD_KEYWORDS.some(kw => statusStr.toLowerCase().includes(kw));

    // platba = how much was actually applied to this credit's components.
    // payment_amount_2 is the FULL transaction size and gets recorded against
    // multiple credits simultaneously — summing it per credit double-counts.
    // The _pokryto fields (allocSum) are the correct per-credit paid amount.
    const platba = paid.platba || 0;

    return {
      id: cid,
      product: String(l[F_LOAN.typ] ?? '—'),
      status: statusStr,
      prodan,
      klient: Number(l[F_LOAN.customerId] ?? customerId),
      origin: isExtension ? String(originRaw) : null,
      schval: String(l[F_LOAN.created] ?? '—'),
      splatn: String(l[F_LOAN.expire] ?? '—'),
      vprodl: Number(l[F_LOAN.delay] || 0),
      jistina: Number(l[F_LOAN.amount] || 0),
      platba,
      uhrJist: paid.uhrJist || 0,
      writeoff: paid.writeoff || 0,
      // ── Pair columns (issued / paid) ──
      castProd: Number(l[F_LOAN.tax7] || 0),
      castProdU: paid.prodlouzeni || 0,
      naklPujc: Number(l[F_LOAN.charge] || 0),
      naklPujcU: paid.naklady || 0,
      smlPok: Number(l[F_LOAN.lateFee] || 0),
      smlPokU: paid.pokuta || 0,
      kompUrk: Number(l[F_LOAN.cinterest] || 0),
      kompUrkU: paid.kompUrk || 0,
      upomink: Number(l[F_LOAN.upominky] || 0),
      upominkU: paid.upominky || 0,
      inkasni: Number(l[F_LOAN.tax6] || 0),
      inkasniU: paid.inkasni || 0,
      vymah: Number(l[F_LOAN.tax8] || 0),
      vymahU: paid.vymahani || 0,
      dluh: Number(l[F_LOAN.debt] || 0),
    };
  });

  const totalJistina = loans.filter(l => !l.origin).reduce((s, l) => s + l.jistina, 0);
  const hasWriteoff = loans.some(l => l.writeoff > 0);

  // Mark original loans whose chain still has outstanding debt.
  // naklPujc (charge_10) is the contracted fee — it belongs to the total only
  // once the chain is closed (fee has been applied / loan repaid).
  const originOf = Object.fromEntries(loans.filter(l => l.origin).map(l => [l.id, l.origin]));
function findRoot(id) { while (originOf[id]) id = originOf[id]; return id; }
const openRootIds = new Set(loans.filter(l => l.dluh > 0).map(l => findRoot(l.id)));
// hasChildren: originals that actually have extensions (real chain parents)
const hasChildren = new Set(loans.filter(l => l.origin).map(l => l.origin));
for (const l of loans) l.chainOpen = openRootIds.has(l.id) && hasChildren.has(l.id);

  return {
    customerId,
    loans,
    totalJistina,
    hasWriteoff,
    meta: { loanCount: loans.length },
  };
}

// ── Uživatelé ─────────────────────────────────────────────────────────────────
// Только чтение и смена роли. Создание пользователя и смена пароля остаются
// в `npm run add-user`: чтобы завести человека, всё равно нужен доступ к серверу,
// а пароли тогда вообще не проходят через браузер.

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n');
}

app.get('/api/users', requireAuth, requireCap(access.CAPS.USERS), (req, res) => {
  const users = loadUsers().map((u) => {
    const role = access.normalizeRole(u.role);
    return {
      id: u.id,
      username: u.username,
      role,
      caps: access.capsOf(role),
      createdAt: u.createdAt || null,
      roleMissing: !u.role,
    };
  });
  res.json({ users, roles: access.ROLES, roleCaps: access.ROLE_CAPS, me: req.user.username });
});

app.patch('/api/users/:id/role', requireAuth, requireCap(access.CAPS.USERS), (req, res) => {
  const { role } = req.body || {};
  if (!access.ROLES.includes(role)) {
    return res.status(400).json({ error: `Neznámá role. Povolené: ${access.ROLES.join(', ')}` });
  }

  const users = loadUsers();
  const target = users.find((u) => String(u.id) === String(req.params.id));
  if (!target) return res.status(404).json({ error: 'Uživatel nenalezen' });

  const previous = access.normalizeRole(target.role);
  if (previous === role) return res.json({ ok: true, unchanged: true, role });

  // Защита от самоблокировки: если это последний администратор, снимать
  // с него роль нельзя — иначе управлять правами станет некому, и починить
  // это можно будет только правкой users.json на сервере руками.
  const adminsAfter = users.filter((u) => {
    const r = String(u.id) === String(target.id) ? role : access.normalizeRole(u.role);
    return r === 'admin';
  }).length;
  if (adminsAfter === 0) {
    return res.status(409).json({
      error: 'Nelze odebrat roli poslednímu administrátorovi — nikdo by pak nemohl spravovat práva.',
    });
  }

  target.role = role;
  saveUsers(users);

  console.log(`[users] ${req.user.username} změnil roli ${target.username}: ${previous} -> ${role}`);
  res.json({ ok: true, role, previous, username: target.username });
});

// ══════════════════════════════════════════════════════════════════════════════
// Odpis dluhu — единственная часть сайта, которая пишет в CRM.
//
// Три правила, из которых сделаны эти роуты:
//
//  1. Плану из браузера доверять нельзя. apply получает только ID, целевой
//     остаток и ключ идемпотентности, который видел оператор. План собирается
//     на сервере заново из живого экспорта, и если ключи разошлись — значит
//     остатки изменились с момента просмотра, и мы отвечаем 409, а не проводим
//     устаревшую раскладку из зависшей вкладки.
//
//  2. Оператор берётся из токена, а не из тела запроса. Иначе аудит-лог
//     ничего не доказывает.
//
//  3. Гарды модуля — это отказ, а не предупреждение. Здесь нет никакого force:
//     если план заблокирован, роут возвращает 409 с находками, и оператор
//     разбирается через probe. Снятие гардов остаётся только в CLI, под рукой
//     того, кто понимает, что снимает.
// ══════════════════════════════════════════════════════════════════════════════

const { money } = writeoff;

// Отпис — операция с деньгами, ей свой лимит, а не общий с логином.
const writeoffLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho požadavků. Zkuste to za minutu.' },
});

function isId(value) {
  return /^\d+$/.test(String(value || ''));
}

// Суммы наружу отдаём двумя видами: minor для логики и строку для показа.
// Клиент не должен считать деньги сам — ни во float, ни в чём-либо ещё.
function kc(minor) {
  return { minor, text: money.fromMinor(minor) };
}

function serializeBalance(balance) {
  const buckets = {};
  for (const bucket of writeoff.buckets.ORDER) {
    buckets[bucket] = {
      column: writeoff.buckets.SOURCE_COLUMN[bucket],
      remaining: kc(balance.buckets[bucket] || 0),
    };
  }
  const diagnostics = {};
  for (const [column, value] of Object.entries(balance.diagnostics || {})) {
    diagnostics[column] = value.raw;
  }
  const outOfWaterfall = {};
  for (const [column, value] of Object.entries(balance.outOfWaterfall || {})) {
    outOfWaterfall[column] = kc(value);
  }
  return {
    customerId: balance.customerId,
    creditId: balance.creditId,
    debt: kc(balance.debt),
    bucketSum: kc(balance.bucketSum),
    delta: kc(balance.bucketSum - balance.debt),
    reconciled: balance.bucketSum === balance.debt,
    buckets,
    order: writeoff.buckets.ORDER,
    diagnostics,
    outOfWaterfall,
    missingColumns: balance.missingColumns,
    meta: balance.meta,
  };
}

function serializePlan(plan) {
  const rows = writeoff.buckets.ORDER.map((bucket) => {
    const remaining = plan.buckets[bucket] || 0;
    const take = plan.allocation[bucket] || 0;
    return {
      bucket,
      column: writeoff.buckets.SOURCE_COLUMN[bucket],
      remaining: kc(remaining),
      take: take ? kc(take) : null,
      rest: kc(remaining - take),
    };
  });
  return {
    customerId: plan.customerId,
    creditId: plan.creditId,
    debtBefore: kc(plan.debtBefore),
    target: kc(plan.target),
    amount: kc(plan.amount),
    capacity: kc(plan.capacity),
    shortfall: kc(plan.shortfall),
    debtAfterExpected: kc(plan.debtAfterExpected),
    rows,
    findings: plan.findings,
    ok: plan.ok,
    fatal: plan.fatal,
    idempotencyKey: plan.idempotencyKey,
  };
}

// Познамка в CRM. Имя оператора подставляется здесь, из токена: в карточке
// кредита должно быть видно, кто отписал, а не только в нашем логе.
// Часовой пояс познамки. Явно, а не через локальное время процесса:
// в контейнере TZ не задана, поэтому «локальное» время там — UTC, и оператор
// в Праze читал бы штамп на два часа назад. Intl сам разбирается с переходом
// на летнее время, так что CEST/CET не надо помнить руками.
const NOTE_TZ = process.env.NOTE_TIMEZONE || 'Europe/Prague';

// sv-SE даёт формат «2026-09-03 23:54» — тот же вид, что в прежних познамках.
const noteStampFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: NOTE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

function noteStamp(date = new Date()) {
  return noteStampFmt.format(date).replace(',', '');
}

// Суммы в чешском виде: «6 971,26». Неразрывный пробел, который добавляет
// cs-CZ, заменяем обычным — познамка уезжает в легаси-PHP, и лишние
// экзотические символы в текстовом поле ни к чему.
function fmtKc(minor) {
  return (minor / 100)
    .toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ /g, ' ');
}

function buildNotes(plan, actor, custom) {
  const head = `${noteStamp()} - odpis ${fmtKc(plan.amount)} Kč,`
    + ` zůstatek ${fmtKc(plan.target)} Kč`;
  const middle = custom ? ` · ${String(custom).slice(0, 200)}` : '';
  const tail = actor ? ` [${actor}]` : '';
  return `${head}${middle}${tail}`;
}

function sendWriteoffError(res, err) {
  const name = err && err.name;
  if (name === 'MoneyError' || name === 'TypeError') {
    return res.status(400).json({ error: err.message });
  }
  if (name === 'ExportError') {
    // «не найдено», «вернулось две строки», «столбец неоднозначен» —
    // все они означают, что данные не такие, как мы думаем.
    return res.status(409).json({ error: err.message });
  }
  if (name === 'WriteoffError') {
    return res.status(409).json({ error: err.message, findings: err.findings || null });
  }
  if (name === 'ApiError') {
    return res.status(502).json({ error: `CRM API: ${err.message}` });
  }
  console.error('[writeoff]', err);
  return res.status(500).json({ error: 'Neočekávaná chyba při odpisu' });
}

// GET /api/writeoff/credits/:customerId
// Кредиты клиента с ненулевым долгом. Роль CC не видит Přehled půjček,
// поэтому кредит она выбирает здесь, а не глазами по таблице.
app.get('/api/writeoff/credits/:customerId', requireAuth, requireCap(access.CAPS.WRITEOFF),
  writeoffLimiter, async (req, res) => {
    const { customerId } = req.params;
    if (!isId(customerId)) return res.status(400).json({ error: 'Neplatné ID klienta' });
    try {
      const { rows } = await writeoff.fetchCreditRows({ customerId });
      const credits = writeoff.listDebtors(rows)
        .map((entry) => ({ creditId: entry.creditId, debt: kc(entry.debt) }))
        .sort((a, b) => b.debt.minor - a.debt.minor);
      res.json({ customerId, credits, total: rows.length });
    } catch (err) {
      sendWriteoffError(res, err);
    }
  });

// GET /api/writeoff/balance/:customerId/:creditId
// probe: остатки по корзинам, сверка суммы с системным долгом, диагностика.
app.get('/api/writeoff/balance/:customerId/:creditId', requireAuth,
  requireCap(access.CAPS.WRITEOFF), writeoffLimiter, async (req, res) => {
    const { customerId, creditId } = req.params;
    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    try {
      const { rows } = await writeoff.fetchCreditRows({ customerId, creditId });
      const balance = writeoff.buildBalance(writeoff.selectCreditRow(rows, creditId));
      res.json(serializeBalance(balance));
    } catch (err) {
      sendWriteoffError(res, err);
    }
  });

// POST /api/writeoff/preview { customerId, creditId, target }
// Побочек нет: можно нажимать сколько угодно.
app.post('/api/writeoff/preview', requireAuth, requireCap(access.CAPS.WRITEOFF),
  writeoffLimiter, async (req, res) => {
    const { customerId, creditId, target } = req.body || {};
    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    if (target === undefined || target === null || target === '') {
      return res.status(400).json({ error: 'Zadejte cílový zůstatek' });
    }
    try {
      const plan = await writeoff.buildPlan({ customerId, creditId, target });
      res.json(serializePlan(plan));
    } catch (err) {
      sendWriteoffError(res, err);
    }
  });

// POST /api/writeoff/apply { customerId, creditId, target, idempotencyKey, notes? }
// Единственный роут сайта, который двигает деньги.
app.post('/api/writeoff/apply', requireAuth, requireCap(access.CAPS.WRITEOFF),
  writeoffLimiter, async (req, res) => {
    const { customerId, creditId, target, idempotencyKey, notes } = req.body || {};
    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Chybí idempotencyKey z náhledu' });
    }

    try {
      // План собираем заново — тому, что прислал браузер, не верим.
      const plan = await writeoff.buildPlan({ customerId, creditId, target });

      if (plan.idempotencyKey !== idempotencyKey) {
        return res.status(409).json({
          error: 'Zůstatky se od náhledu změnily. Zkontrolujte nový návrh a potvrďte znovu.',
          code: 'plan_changed',
          plan: serializePlan(plan),
        });
      }
      if (!plan.ok) {
        return res.status(409).json({
          error: 'Odpis zablokovaly kontroly dat.',
          code: 'blocked',
          plan: serializePlan(plan),
        });
      }

      const result = await writeoff.applyPlan(plan, {
        live: true,
        actor: req.user.username,
        notes: buildNotes(plan, req.user.username, notes),
      });

      const payload = {
        status: result.status,
        message: result.message || null,
        writeoffId: result.writeoffId || null,
        plan: serializePlan(plan),
        verification: result.verification
          ? {
            ok: result.verification.ok,
            debtAfter: kc(result.verification.debtAfter),
            expectedDebt: kc(result.verification.expectedDebt),
            delta: kc(result.verification.delta),
          }
          : null,
        previous: result.previous || null,
      };

      // applied_unverified и dangling_intent — это «человек, посмотри».
      // Отдаём 409, чтобы фронт не покрасил их зелёным как успех.
      const needsHuman = ['applied_unverified', 'dangling_intent'].includes(result.status);
      res.status(needsHuman ? 409 : 200).json(payload);

    } catch (err) {
      sendWriteoffError(res, err);
    }
  });


// ══════════════════════════════════════════════════════════════════════════════
// Splátkový kalendář — pipeline (kroky 1-10).
//
// Autosearch pujcek s dluhem pouziva stejnou routu jako zalozka Odpis dluhu
// (GET /api/writeoff/credits/:customerId) — kdo ma cap PIPELINE, ma podle
// access.js vzdy i cap WRITEOFF, takze samostatna kopie routy by jen
// duplikovala kod bez duvodu.
//
// Stav operace zije v pameti procesu (pipeline/src/orchestrator.js) — pri
// restartu serveru operace mizi, viz komentar tamtez.
// ══════════════════════════════════════════════════════════════════════════════

const pipelineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho požadavků. Zkuste to za minutu.' },
});

function sendPipelineError(res, err) {
  const code = err && err.code;
  if (code === 'schedule_invalid' || code === 'reason_invalid') {
    return res.status(400).json({ error: err.message, code });
  }
  if (code === 'sheet_row_not_found' || code === 'writeoff_blocked'
    || code === 'operation_not_found' || code === 'step_not_waiting') {
    return res.status(409).json({ error: err.message, code, findings: err.findings || null });
  }
  console.error('[pipeline]', err);
  res.status(500).json({ error: err && err.message ? err.message : 'Neočekávaná chyba v pipeline' });
}

// POST /api/pipeline/start
app.post('/api/pipeline/start', requireAuth, requireCap(access.CAPS.PIPELINE), pipelineLimiter,
  async (req, res) => {
    const {
      customerId, creditId, type, blacklistReasonId,
      targetTotal, calStartDate, calPerPayment, calTotal, skippedSteps,
    } = req.body || {};

    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    if (type !== 'DON' && type !== 'EPR') {
      return res.status(400).json({ error: 'type musí být DON nebo EPR' });
    }

    try {
      const result = await pipeline.start({
        customerId, creditId, type,
        blacklistReasonId, targetTotal, calStartDate, calPerPayment, calTotal,
        skippedSteps: Array.isArray(skippedSteps) ? skippedSteps : [],
        actor: req.user.username,
      });
      res.json(result);
    } catch (err) {
      sendPipelineError(res, err);
    }
  });

// POST /api/pipeline/:operationId/confirm { step }
app.post('/api/pipeline/:operationId/confirm', requireAuth, requireCap(access.CAPS.PIPELINE), pipelineLimiter,
  async (req, res) => {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'Chybí step' });
    try {
      const result = await pipeline.confirmStep(req.params.operationId, step);
      res.json(result);
    } catch (err) {
      sendPipelineError(res, err);
    }
  });

// GET /api/pipeline/:operationId/status — obnoveni stavu po reloadu stranky.
app.get('/api/pipeline/:operationId/status', requireAuth, requireCap(access.CAPS.PIPELINE),
  (req, res) => {
    const result = pipeline.getStatus(req.params.operationId);
    if (!result) return res.status(404).json({ error: 'Operace nenalezena' });
    res.json(result);
  });

// GET /api/pipeline/:operationId/calendar-preview.png — screenshot vyplneneho
// formulare pro rucni potvrzeni kroku calendar_confirm.
app.get('/api/pipeline/:operationId/calendar-preview.png', requireAuth, requireCap(access.CAPS.PIPELINE),
  (req, res) => {
    const screenshot = pipeline.getCalendarScreenshot(req.params.operationId);
    if (!screenshot) return res.status(404).end();
    res.type('png').send(screenshot);
  });

// ── Start ─────────────────────────────────────────────────────────────────────
if (!JWT_SECRET) {
  console.error('❌  JWT_SECRET is not set in .env — server cannot start safely.');
  process.exit(1);
}

// Debug endpoint — returns raw CRM response for a customer.
// Отдаёт сырой ответ CRM вместе с картой полей, поэтому доступен только
// админу: обычному оператору внутренние имена столбцов не нужны.
app.get('/debug/:customerId', requireAuth, requireCap(access.CAPS.USERS), async (req, res) => {
  const filter = JSON.stringify([
    { name: 'customers.customer_id', act: '=', value: req.params.customerId }
  ]);
  const params = { apiKey: process.env.API_KEY, filter, format: 'assoc' };
  try {
    const [a, b] = await Promise.all([
      axios.get(API_BASE, { params: { ...params, id: 234 }, timeout: 15000 }),
      axios.get(API_BASE, { params: { ...params, id: 230 }, timeout: 15000 }),
    ]);
    // Also expose which field-name mappings are active so you can verify them
    res.json({
      fieldMapping: { F_LOAN, F_PAY },
      table234_loans: a.data,
      table230_payments: b.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅  Fintech Compliance Platform → http://localhost:${PORT}`);
  if (mockCrm.isMockMode()) {
    console.log('ℹ️   Running in MOCK MODE (Offline). Demo clients: 1001, 1002');
  }
});
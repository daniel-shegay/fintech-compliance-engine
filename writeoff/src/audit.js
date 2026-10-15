'use strict';

// ----------------------------------------------------------------------------
// Аудит — append-only JSONL. Одна операция даёт несколько записей:
//   intent   -> собираемся отправить (пишется ДО запроса)
//   applied  -> апи ответил success
//   failed   -> апи ответил failed / упал запрос
//   verified -> перечитали баланс, долг стал равен target
//   mismatch -> перечитали баланс, долг НЕ равен target
//
// Запись intent до запроса — не формальность: если процесс умрёт между
// отправкой и ответом, в логе останется след, и повторный запуск увидит
// незакрытую операцию, а не «ничего не было».
//
// Идемпотентность держится здесь же, потому что в export 229 нет поля,
// по которому можно надёжно понять «этот конкретный отпис уже проведён».
// ----------------------------------------------------------------------------

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { config } = require('./config');

const FILE = 'writeoff.jsonl';

function auditPath(dir) {
  return path.join(dir, FILE);
}

async function append(entry, { dir = config.AUDIT_DIR } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    host: os.hostname(),
    pid: process.pid,
    ...entry,
  };
  // flag 'a' + одна строка = атомарная дозапись в пределах пишущего процесса
  await fsp.appendFile(auditPath(dir), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

async function readAll({ dir = config.AUDIT_DIR } = {}) {
  const file = auditPath(dir);
  if (!fs.existsSync(file)) return [];
  const text = await fsp.readFile(file, 'utf8');
  const out = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // битую строку не роняем весь лог, но и не прячем
      out.push({ ts: null, event: 'corrupt_line', line: i + 1, raw: line.slice(0, 500) });
    }
  }
  return out;
}

// Всё, что известно про этот ключ идемпотентности.
async function history(key, opts = {}) {
  const all = await readAll(opts);
  return all.filter((entry) => entry.idempotencyKey === key);
}

// Была ли уже успешная проводка с этим ключом.
async function findApplied(key, opts = {}) {
  const entries = await history(key, opts);
  return entries.find((entry) => entry.event === 'applied') || null;
}

// Есть ли незакрытый intent (отправили и не узнали результат).
async function findDangling(key, opts = {}) {
  const entries = await history(key, opts);
  const intents = entries.filter((entry) => entry.event === 'intent');
  if (intents.length === 0) return null;
  const closed = entries.some((entry) => ['applied', 'failed'].includes(entry.event));
  return closed ? null : intents[intents.length - 1];
}

module.exports = { append, readAll, history, findApplied, findDangling, auditPath };

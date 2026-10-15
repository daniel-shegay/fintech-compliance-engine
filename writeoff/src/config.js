'use strict';

// ----------------------------------------------------------------------------
// Конфигурация только из окружения. Ключ в код не зашивается никогда.
// ----------------------------------------------------------------------------

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name}: ожидалось целое, получено ${JSON.stringify(v)}`);
  return n;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name}: ожидалось true/false, получено ${JSON.stringify(v)}`);
}

function envEnum(name, allowed, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (!allowed.includes(v)) {
    throw new Error(`${name}: допустимые значения ${allowed.join('|')}, получено ${JSON.stringify(v)}`);
  }
  return v;
}

const config = {
  BASE_URL: (process.env.CREDITGO_BASE_URL || 'https://api.crm-lending.example').replace(/\/+$/, ''),
  API_KEY: process.env.CREDITGO_API_KEY || '',

  // Спека postWriteoff() просит передавать ключ заголовком x-api-key
  // ("for better security"), но принимает и query-параметр apiKey.
  AUTH_MODE: envEnum('CREDITGO_AUTH_MODE', ['header', 'query'], 'header'),

  // export с остатками по кредитам (l_*, r_*). 229 — тот, что подтверждён.
  EXPORT_ID: envInt('CREDITGO_EXPORT_ID', 229),

  // Имя поля кредита в фильтрах экспорта. Экспорт отдаёт столбец `id`,
  // а фильтровать надо по имени таблицы.
  FILTER_CREDIT_FIELD: process.env.CREDITGO_FILTER_CREDIT_FIELD || 'credits.id',
  FILTER_CUSTOMER_FIELD: process.env.CREDITGO_FILTER_CUSTOMER_FIELD || 'customers.customer_id',

  // Как отправлять параметры отписа. Спека таблицей не различает query и body;
  // рабочий вариант из прежнего кода — JSON body. Оставлено переключателем,
  // чтобы не переписывать модуль, если окажется наоборот.
  WRITEOFF_TRANSPORT: envEnum('CREDITGO_WRITEOFF_TRANSPORT', ['body', 'query'], 'body'),

  // Кто выполняет операцию — пойдёт в notes отписа и в аудит-лог.
  ACTOR: process.env.CREDITGO_ACTOR || '',

  // Допустимое расхождение «сумма корзин vs системный debt», в haléřích.
  // По умолчанию 0: любое расхождение = отказ, потому что оно означает,
  // что карта столбцов не описывает долг целиком.
  DEBT_TOLERANCE_MINOR: envInt('CREDITGO_DEBT_TOLERANCE', 0),

  AUDIT_DIR: process.env.CREDITGO_AUDIT_DIR || './audit',

  // Отказ при повторной проводке (already_applied / dangling_intent).
  // ВЫКЛЮЧЕН по умолчанию — сознательно:
  //
  //   * CRM сам не даёт провести один и тот же отпис дважды:
  //     компоненты уже погашены, и API отвечает invalidAmount. Верхняя
  //     система здесь авторитет, дублировать её отказ незачем.
  //   * ключ идемпотентности считается от долга и раскладки, поэтому после
  //     настоящей проводки он меняется сам. Совпасть он может только если
  //     кредит вернули в прежнее состояние — то есть на тестах, где эта
  //     проверка мешает и ничего не защищает.
  //
  // Аудит-лог пишется независимо от флага: он остаётся записью того, что
  // произошло, и отключение отказа его не касается.
  IDEMPOTENCY_GUARD: envBool('CREDITGO_IDEMPOTENCY_GUARD', false),

  HTTP_TIMEOUT_MS: envInt('CREDITGO_HTTP_TIMEOUT_MS', 30000),
  API_LAN: process.env.CREDITGO_API_LAN || '',
};

function assertUsable(cfg = config) {
  if (!cfg.API_KEY) {
    throw new Error('CREDITGO_API_KEY не задан — задайте переменную окружения');
  }
  return cfg;
}

module.exports = { config, assertUsable };

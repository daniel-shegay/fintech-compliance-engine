'use strict';

// Публичный интерфейс модуля. Ровно это и будет вызывать пайплайн и веб-роут.

const { config, assertUsable } = require('./config');
const buckets = require('./buckets');
const money = require('./money');
const { call, ApiError } = require('./client');
const {
  fetchExport, fetchCreditRows, normalize, pick, hasColumn, ExportError,
} = require('./exportReader');
const { buildBalance, selectCreditRow, listDebtors } = require('./balance');
const { allocate } = require('./waterfall');
const guards = require('./guards');
const { buildPlan, computePlan, buildPayload, idempotencyKey } = require('./plan');
const { applyPlan, postWriteoff, verify, WriteoffError, WRITEOFF_PATH } = require('./apply');
const audit = require('./audit');
const { formatPlan, formatApply, formatProbe } = require('./report');

module.exports = {
  // конфиг
  config,
  assertUsable,

  // предметная модель
  buckets,
  money,

  // чтение
  fetchExport,
  fetchCreditRows,
  normalize,
  pick,
  hasColumn,
  buildBalance,
  selectCreditRow,
  listDebtors,

  // расчёт
  allocate,
  guards,
  buildPlan,
  computePlan,
  buildPayload,
  idempotencyKey,

  // проводка
  applyPlan,
  postWriteoff,
  verify,
  WRITEOFF_PATH,

  // аудит и вывод
  audit,
  formatPlan,
  formatApply,
  formatProbe,

  // ошибки
  ApiError,
  ExportError,
  WriteoffError,
  MoneyError: money.MoneyError,
};

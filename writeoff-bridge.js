'use strict';

// ----------------------------------------------------------------------------
// Мост между настройками compliance-сайта и модулем отписа.
//
// Зачем отдельный файл, а не пара строк в server.js: модуль читает окружение
// в момент require (см. writeoff/src/config.js), поэтому переменные должны быть
// выведены ДО того, как он подключится. Отдельный модуль делает этот порядок
// невозможным нарушить — как бы ни переставляли require в server.js.
//
// Новых секретов не вводим. Ключ и домен берутся из того, что у сайта уже есть:
//   API_KEY      -> CREDITGO_API_KEY
//   API_BASE_URL -> CREDITGO_BASE_URL, но только origin: у сайта в этой
//                   переменной лежит полный путь до export/export, а модуль
//                   добавляет пути сам (/api/v1.0/export/export и
//                   /api/v1.0/special/writeoff). Если передать полный URL,
//                   получится .../export/export/api/v1.0/special/writeoff.
//
// Второй копии ключа в .env быть не должно: одна переменная — одно место,
// где её нужно менять при ротации.
// ----------------------------------------------------------------------------

const path = require('node:path');

// Загружаем .env сами. server.js делает это первой строкой, но мост может
// понадобиться и служебному скрипту — а без .env он бы вывел настройки
// из пустого окружения и молча пошёл на дефолтный домен без ключа.
// Повторный вызов безопасен: dotenv не перезаписывает уже заданные переменные.
require('dotenv').config();

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

if (!process.env.CREDITGO_API_KEY && process.env.API_KEY) {
  process.env.CREDITGO_API_KEY = process.env.API_KEY;
}

if (!process.env.CREDITGO_BASE_URL) {
  const derived = originOf(process.env.API_BASE_URL || '');
  if (derived) {
    // Схему поднимаем до https и НИКОГДА не наследуем http.
    //
    // Дашборд исторически читает экспорты по http, и для чтения это работает.
    // Метод записи по plaintext CRM не отдаёт: POST /api/v1.0/special/writeoff
    // по http отвечает 500 MethodAccessDenied, причём с именем метода
    // getWriteoff вместо postWriteoff — то есть запрос даже не доходит до
    // нужного обработчика. Те же проводки по https проходят (writeoffId
    // 770169 и 770170, 3.9.2026). Проверено 3.9.2026.
    //
    // Отдельно: API-ключ не должен ходить в открытом виде на запросе,
    // который двигает деньги.
    const secure = derived.replace(/^http:\/\//i, 'https://');
    if (secure !== derived) {
      console.warn(`[writeoff] API_BASE_URL задан по http — для отписа используется ${secure}`);
    }
    process.env.CREDITGO_BASE_URL = secure;
  }
  // если не вывелось — у модуля свой дефолт на тот же домен по https
} else if (/^http:\/\//i.test(process.env.CREDITGO_BASE_URL)) {
  console.warn('[writeoff] CREDITGO_BASE_URL задан по http — метод записи по plaintext CRM,'
    + ' скорее всего, отклонит (MethodAccessDenied)');
}

// Аудит-лог. В контейнере это /app/audit и он ОБЯЗАН быть томом:
// в нём живёт идемпотентность и записи о незакрытых попытках, и без тома
// они исчезают при первой пересборке образа. См. docker-compose.yml.
if (!process.env.CREDITGO_AUDIT_DIR) {
  process.env.CREDITGO_AUDIT_DIR = path.join(__dirname, 'audit');
}

const writeoff = require('./writeoff');
const mockCrm = require('./mock-crm');

if (mockCrm.isMockMode()) {
  console.log('[writeoff] Mock mode enabled: using synthetic fixtures for debt write-off.');

  const exportReader = require('./writeoff/src/exportReader');
  const mockFetch = async function (opts = {}) {
    const rows = mockCrm.getMockCreditRows(opts);
    return { rows, raw: { mock: true } };
  };

  exportReader.fetchCreditRows = mockFetch;
  writeoff.fetchCreditRows = mockFetch;

  writeoff.applyPlan = async function (plan, opts = {}) {
    const key = plan.idempotencyKey;
    const writeoffId = 'MOCK-' + Math.floor(100000 + Math.random() * 900000);
    const ts = new Date().toISOString();

    if (writeoff.audit && typeof writeoff.audit.append === 'function') {
      try {
        await writeoff.audit.append({
          ts,
          event: 'intent',
          idempotencyKey: key,
          actor: opts.actor || 'demo',
          customerId: plan.customerId,
          creditId: plan.creditId,
          target: plan.target,
          debtBefore: plan.debtBefore,
          amount: plan.amount,
          allocation: plan.allocation,
          payload: writeoff.buildPayload(plan, opts.notes),
        });

        await writeoff.audit.append({
          ts: new Date().toISOString(),
          event: 'applied',
          idempotencyKey: key,
          actor: opts.actor || 'demo',
          customerId: plan.customerId,
          creditId: plan.creditId,
          writeoffId,
        });
      } catch (err) {
        console.warn('[mock-writeoff] could not write audit log:', err.message);
      }
    }

    return {
      status: 'applied',
      writeoffId,
      appliedAt: ts,
      plan,
    };
  };
}

module.exports = writeoff;


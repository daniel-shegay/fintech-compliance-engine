'use strict';

// ----------------------------------------------------------------------------
// Права доступа. Единственное место, где записано, кто что может.
//
// Роль -> список возможностей. Проверяем возможность, а не роль: когда
// появится четвёртая роль или отпис разделится на «предложить» и «провести»,
// правится эта таблица, а не десяток условий по коду.
//
// Фронт получает свой список из GET /api/me и рисует вкладки по нему —
// поэтому интерфейс не может разойтись с сервером.
//
// Скрытая вкладка не является защитой. Каждый роут проверяет возможность
// сам, иначе роль mail дойдёт до отписа обычным curl со своим же токеном.
// ----------------------------------------------------------------------------

const CAPS = {
  PREHLED: 'prehled',     // просмотр займов клиента (read-only)
  WRITEOFF: 'writeoff',   // отпис долга — запись в CRM
  PIPELINE: 'pipeline',   // сплатковый календарь (в разработке)
  USERS: 'users',         // управление пользователями и debug-роут
};

const ROLE_CAPS = {
  admin: [CAPS.PREHLED, CAPS.WRITEOFF, CAPS.PIPELINE, CAPS.USERS],
  cc: [CAPS.WRITEOFF, CAPS.PIPELINE],
  mail: [CAPS.PREHLED],
};

const ROLES = Object.keys(ROLE_CAPS);

// Роль по умолчанию — самая слабая. Пользователь без поля role в users.json
// не должен случайно получить админа, поэтому именно mail, а не admin.
const DEFAULT_ROLE = 'mail';

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_CAPS[value] ? value : DEFAULT_ROLE;
}

function capsOf(role) {
  return ROLE_CAPS[normalizeRole(role)].slice();
}

function can(role, cap) {
  return ROLE_CAPS[normalizeRole(role)].includes(cap);
}

module.exports = { CAPS, ROLES, ROLE_CAPS, DEFAULT_ROLE, normalizeRole, capsOf, can };

'use strict';

// ----------------------------------------------------------------------------
// Тонкий клиент CRM API.
//
// Два правила, из которых растёт весь остальной код:
//   1. HTTP 200 != успех. Настоящий результат лежит в конверте:
//        { status, error, message, data: { status: "success"|"failed", ... } }
//   2. Ключ по умолчанию идёт заголовком x-api-key (так просит спека),
//      но апи принимает и ?apiKey= — переключается через CREDITGO_AUTH_MODE.
// ----------------------------------------------------------------------------

const { config } = require('./config');

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, details);
  }
}

function buildUrl(baseUrl, path, query, authMode, apiKey) {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (authMode === 'query') url.searchParams.set('apiKey', apiKey);
  return url;
}

// Возвращает распарсенный конверт целиком — интерпретация выше, в вызывающем коде.
async function call(path, options = {}) {
  const {
    method = 'GET',
    query = {},
    body = null,
    cfg = config,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new ApiError('fetch недоступен — нужен Node 18+ или передайте fetchImpl');
  }

  const url = buildUrl(cfg.BASE_URL, path, query, cfg.AUTH_MODE, cfg.API_KEY);

  const headers = { Accept: 'application/json' };
  if (cfg.AUTH_MODE === 'header') headers['x-api-key'] = cfg.API_KEY;

  const init = { method, headers };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.HTTP_TIMEOUT_MS);
  init.signal = ac.signal;

  let res;
  let text;
  try {
    res = await fetchImpl(url, init);
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError(`таймаут ${cfg.HTTP_TIMEOUT_MS} мс: ${method} ${path}`, { path, method });
    }
    throw new ApiError(`сетевая ошибка: ${method} ${path}: ${err.message}`, { path, method, cause: err });
  } finally {
    clearTimeout(timer);
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new ApiError(
      `ответ не JSON (HTTP ${res.status}) на ${method} ${path}: ${text.slice(0, 300)}`,
      { httpStatus: res.status, path, method, raw: text.slice(0, 2000) },
    );
  }

  if (envelope.status !== 200) {
    throw new ApiError(
      `API вернул status=${envelope.status} на ${method} ${path}` +
      `${envelope.error ? ` (${envelope.error})` : ''}` +
      `${envelope.message ? `: ${envelope.message}` : ''}`,
      { apiStatus: envelope.status, apiError: envelope.error, apiMessage: envelope.message, path, method },
    );
  }

  return envelope;
}

module.exports = { call, buildUrl, ApiError };

'use strict';
const HOST = 'validect-email-verification-v1.p.rapidapi.com';
const positive = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
function normalize(data, email) {
  const item = data?.data && typeof data.data === 'object' ? data.data : data;
  const raw = typeof item?.status === 'string' ? item.status.toLowerCase().replace(/[ _-]/g, '') : '';
  const status = ({ valid: 'Valid', invalid: 'Invalid', acceptall: 'Catch-All', catchall: 'Catch-All', unknown: 'Unknown' })[raw];
  if (!status || (item.email && String(item.email).toLowerCase() !== email)) {
    return failure(email, 'Unexpected Validect response; no mailbox verdict was accepted.');
  }
  const valid = status === 'Valid' ? true : status === 'Invalid' ? false : null;
  return { email, domain: email.split('@')[1], status, valid, syntaxValid: true,
    confidence: valid === true ? 90 : valid === false ? 95 : 40,
    deliverabilityScore: valid === true ? 90 : valid === false ? 0 : 40,
    catchAll: status === 'Catch-All' ? true : null,
    mailboxStatus: status === 'Valid' ? 'API Verified' : status,
    verificationLevel: 'Validect API assessment', verificationOutcome: `validect_${raw}`,
    externalApiProvider: 'Validect', externalApiChecked: true, externalApiLive: true,
    externalApiDeliverable: valid === true, externalApiCached: false,
    disposable: item.disposable === true, roleBased: item.role === true,
    reason: `Validect: ${status}${typeof item.reason === 'string' ? ` — ${item.reason.slice(0, 250)}` : ''}`,
    externalApiReason: `Validect returned ${status}` };
}
function failure(email, reason, httpStatus) {
  return { email, domain: email.split('@')[1], status: 'Unknown', valid: null,
    syntaxValid: true, confidence: 0, deliverabilityScore: 0, catchAll: null,
    mailboxStatus: 'Not Verified', verificationOutcome: 'api_unavailable',
    externalApiProvider: 'Validect', externalApiChecked: false,
    externalApiReason: reason, reason, ...(httpStatus ? { apiHttpStatus: httpStatus } : {}) };
}
function createValidectClient(options = {}) {
  const key = options.key ?? process.env.RAPIDAPI_KEY;
  const fetcher = options.fetcher || globalThis.fetch;
  const interval = options.interval ?? positive(process.env.VALIDECT_INTERVAL_MS, 1100);
  const timeout = options.timeout ?? positive(process.env.VALIDECT_TIMEOUT_MS, 20000);
  const ttl = options.ttl ?? positive(process.env.VALIDECT_CACHE_TTL_MS, 1800000);
  const cache = new Map(), inflight = new Map();
  let queue = Promise.resolve(), nextStart = 0, blockedUntil = 0, blockedReason = '';
  async function request(email) {
    if (Date.now() < blockedUntil) return failure(email, blockedReason);
    const delay = Math.max(0, nextStart - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    nextStart = Date.now() + interval;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const url = new URL(`https://${HOST}/v1/verify`);
      url.searchParams.set('email', email);
      const response = await fetcher(url, { method: 'GET', redirect: 'error',
        headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST, Accept: 'application/json' },
        signal: controller.signal });
      if (!response.ok) {
        const messages = {401: 'RapidAPI key was rejected.', 403: 'RapidAPI access denied. Check your key and Validect subscription.',
          429: 'RapidAPI rate limit or quota reached. Check your plan and retry later.'};
        const reason = messages[response.status] || `Validect returned HTTP ${response.status}. Retry later.`;
        if ([401, 403, 429].includes(response.status)) {
          const retry = response.headers?.get('retry-after');
          const retryMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          blockedUntil = Date.now() + Math.max(60000, Number.isFinite(retryMs) ? retryMs : 60000);
          blockedReason = reason;
        }
        return failure(email, reason, response.status);
      }
      const result = normalize(await response.json(), email);
      if (result.externalApiChecked && result.status !== 'Unknown') {
        if (cache.size >= 10000) cache.delete(cache.keys().next().value);
        cache.set(email, { at: Date.now(), result });
      }
      return result;
    } catch (error) {
      return failure(email, error.name === 'AbortError' ? 'Validect request timed out. Retry later.' : 'Validect connection or response failed. Retry later.');
    } finally { clearTimeout(timer); }
  }
  async function verify(email) {
    email = String(email).trim().toLowerCase();
    if (!key || key === 'YOUR_RAPIDAPI_KEY_HERE') return failure(email, 'Set RAPIDAPI_KEY in .env and restart the backend.');
    const hit = cache.get(email);
    if (hit && Date.now() - hit.at < ttl) return { ...hit.result, externalApiCached: true };
    if (inflight.has(email)) return inflight.get(email);
    // Serial requests avoid bursts and keep API usage bounded for bulk jobs.
    const task = queue.then(() => request(email));
    queue = task.catch(() => {});
    inflight.set(email, task);
    try { return await task; } finally { inflight.delete(email); }
  }
  return { verify };
}
module.exports = { createValidectClient, normalize };

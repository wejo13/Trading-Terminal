// oi-exhaustion-render.test.js — UI-independent logic only (no DOM, no network).
'use strict';

const R = require('./oi-exhaustion-render.js');

let passed = 0, failed = 0;
const asyncTests = []; // collects promises from async test IIFEs so the summary waits for them
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

const T0 = 1750000000000;
const FIVE_MIN = 5 * 60 * 1000;

// ── validateSettings ─────────────────────────────────────────────────────

section('validateSettings: fills in defaults for missing/undefined fields');
(function () {
  const s = R.validateSettings({});
  assert('lookbackDays defaults to 90', s.lookbackDays === 90);
  assert('entryPercentile defaults to 95', s.entryPercentile === 95);
  assert('rearmPercentile defaults to 80', s.rearmPercentile === 80);
  assert('baselineLookbackCandles defaults to 8640', s.baselineLookbackCandles === 8640);
})();

section('validateSettings: clamps out-of-range values instead of accepting garbage');
(function () {
  const s = R.validateSettings({ lookbackDays: -5, entryPercentile: 500, rearmPercentile: -10 });
  assert('negative lookbackDays clamped to minimum 1', s.lookbackDays === 1);
  assert('entryPercentile clamped to max 100', s.entryPercentile === 100);
  assert('rearmPercentile clamped to min 0', s.rearmPercentile === 0);
})();

section('validateSettings: rearmPercentile cannot exceed entryPercentile');
(function () {
  const s = R.validateSettings({ entryPercentile: 90, rearmPercentile: 95 });
  assert('rearmPercentile clamped down to entryPercentile', s.rearmPercentile === 90);
})();

section('validateSettings: non-numeric input falls back to default rather than NaN');
(function () {
  const s = R.validateSettings({ lookbackDays: 'not-a-number', entryPercentile: undefined });
  assert('garbage string falls back to default', s.lookbackDays === 90);
  assert('undefined falls back to default', s.entryPercentile === 95);
})();

section('validateSettings: accepts string-numeric input from form fields (values arrive as strings)');
(function () {
  const s = R.validateSettings({ lookbackDays: '30', entryPercentile: '97' });
  assert('string "30" parsed to number 30', s.lookbackDays === 30);
  assert('string "97" parsed to number 97', s.entryPercentile === 97);
})();

section('validateSettings: alertModel defaults to netProgress (UI default), accepts strict explicitly');
(function () {
  const s1 = R.validateSettings({});
  assert('default alertModel is netProgress', s1.alertModel === 'netProgress');
  const s2 = R.validateSettings({ alertModel: 'strict' });
  assert('explicit strict selection preserved', s2.alertModel === 'strict');
  const s3 = R.validateSettings({ alertModel: 'garbage-value' });
  assert('unrecognized alertModel falls back to the default rather than passing through garbage', s3.alertModel === 'netProgress');
})();

// ── levelToBoundedZone ───────────────────────────────────────────────────

section('levelToBoundedZone: converts level+tolerance into top/bottom');
(function () {
  const z = R.levelToBoundedZone({ type: 'level', level: 100000, tolerance: 500 });
  assert('top = level + tolerance', z.top === 100500);
  assert('bottom = level - tolerance', z.bottom === 99500);
})();

section('levelToBoundedZone: range-type zones pass through unchanged');
(function () {
  const z = R.levelToBoundedZone({ type: 'range', top: 90000, bottom: 80000 });
  assert('top unchanged', z.top === 90000);
  assert('bottom unchanged', z.bottom === 80000);
})();

section('levelToBoundedZone: missing tolerance defaults to 0 (zero-width band)');
(function () {
  const z = R.levelToBoundedZone({ type: 'level', level: 50000 });
  assert('top === bottom === level when no tolerance given', z.top === 50000 && z.bottom === 50000);
})();

section('levelToBoundedZone: does not mutate the input object');
(function () {
  const input = { type: 'level', level: 100, tolerance: 5 };
  const copy = Object.assign({}, input);
  R.levelToBoundedZone(input);
  assert('input object unchanged after conversion', JSON.stringify(input) === JSON.stringify(copy));
})();

// ── normalizeZone ────────────────────────────────────────────────────────

section('normalizeZone: level row produces bounded zone with all engine-required fields');
(function () {
  const z = R.normalizeZone({ label: 'ATH level', type: 'level', level: 110000, tolerance: 1000, availableAtTs: T0 });
  assert('has id', typeof z.id === 'string' && z.id.length > 0);
  assert('top/bottom derived correctly', z.top === 111000 && z.bottom === 109000);
  assert('active true by default', z.active === true);
  assert('availableAtTs preserved', z.availableAtTs === T0);
  assert('inactiveAtTs null by default', z.inactiveAtTs === null);
})();

section('normalizeZone: enabled:false / active:false both suppress the zone');
(function () {
  const z1 = R.normalizeZone({ type: 'range', top: 100, bottom: 90, enabled: false });
  const z2 = R.normalizeZone({ type: 'range', top: 100, bottom: 90, active: false });
  assert('enabled:false -> active:false', z1.active === false);
  assert('active:false -> active:false', z2.active === false);
})();

section('normalizeZone: empty-string timestamps treated as null, not 0');
(function () {
  const z = R.normalizeZone({ type: 'range', top: 100, bottom: 90, availableAtTs: '', inactiveAtTs: '' });
  assert('empty string availableAtTs -> null (not epoch 0)', z.availableAtTs === null);
  assert('empty string inactiveAtTs -> null', z.inactiveAtTs === null);
})();

// ── serializeZones / deserializeZones ────────────────────────────────────

section('serializeZones + deserializeZones: round-trip preserves data');
(function () {
  const zones = [
    { id: 'z1', label: 'Test', type: 'range', top: 100, bottom: 90, active: true, availableAtTs: T0, inactiveAtTs: null },
    { id: 'z2', label: 'Level', type: 'level', level: 50000, tolerance: 200, active: false },
  ];
  const str = R.serializeZones(zones);
  const roundTripped = R.deserializeZones(str);
  assert('round-trip preserves array length', roundTripped.length === 2);
  assert('round-trip preserves values', roundTripped[0].top === 100 && roundTripped[1].level === 50000);
})();

section('deserializeZones: malformed JSON returns empty array, does not throw');
(function () {
  assert('invalid JSON -> []', Array.isArray(R.deserializeZones('{not valid json')) && R.deserializeZones('{not valid json').length === 0);
  assert('null input -> []', Array.isArray(R.deserializeZones(null)) && R.deserializeZones(null).length === 0);
  assert('non-array JSON -> []', Array.isArray(R.deserializeZones('{"not":"an array"}')) && R.deserializeZones('{"not":"an array"}').length === 0);
})();

// ── mapAlertToChartPoint / buildBinanceCandleIndex ──────────────────────

section('buildBinanceCandleIndex + mapAlertToChartPoint: exact-timestamp match');
(function () {
  const candles = [{ ts: T0, close: 100 }, { ts: T0 + FIVE_MIN, close: 101 }];
  const index = R.buildBinanceCandleIndex(candles);
  const alert = { timestamp: T0 + FIVE_MIN, price: 999 }; // Bybit price intentionally different from Binance close
  const point = R.mapAlertToChartPoint(alert, index);
  assert('point found at matching timestamp', point !== null);
  assert('chart Y position uses the BINANCE close, not the Bybit alert price', point.chartPrice === 101);
  assert('alert object preserved on the point for tooltip use', point.alert === alert);
})();

section('mapAlertToChartPoint: no matching Binance candle -> null, not a guessed nearest');
(function () {
  const candles = [{ ts: T0, close: 100 }];
  const index = R.buildBinanceCandleIndex(candles);
  const alert = { timestamp: T0 + FIVE_MIN }; // no Binance candle at this exact ts
  const point = R.mapAlertToChartPoint(alert, index);
  assert('unmatched alert timestamp maps to null', point === null);
})();

// ── findContainingCandleIndex / mapAlertToContainingChartPoint (4h chart) ──

section('findContainingCandleIndex: 5m-aligned alert timestamp falls inside a 4h candle');
(function () {
  const FOUR_H = 4 * 60 * 60 * 1000;
  const candles = [
    { ts: T0, close: 100 },
    { ts: T0 + FOUR_H, close: 101 },
    { ts: T0 + 2 * FOUR_H, close: 102 },
  ];
  const alertTs = T0 + FOUR_H + 37 * FIVE_MIN; // well inside the second 4h candle
  const idx = R.findContainingCandleIndex(alertTs, candles, FOUR_H);
  assert('alert maps into the containing 4h candle, not the nearest boundary', idx === 1);
})();

section('findContainingCandleIndex: exact candle-open timestamp maps to that candle');
(function () {
  const FOUR_H = 4 * 60 * 60 * 1000;
  const candles = [{ ts: T0, close: 100 }, { ts: T0 + FOUR_H, close: 101 }];
  assert('exact open-time match', R.findContainingCandleIndex(T0 + FOUR_H, candles, FOUR_H) === 1);
})();

section('findContainingCandleIndex: timestamp before the first candle or in a trailing gap -> -1');
(function () {
  const FOUR_H = 4 * 60 * 60 * 1000;
  const candles = [{ ts: T0, close: 100 }, { ts: T0 + FOUR_H, close: 101 }];
  assert('before first candle -> -1', R.findContainingCandleIndex(T0 - FIVE_MIN, candles, FOUR_H) === -1);
  assert('past the last candle\'s coverage window -> -1', R.findContainingCandleIndex(T0 + 2 * FOUR_H + FIVE_MIN, candles, FOUR_H) === -1);
})();

section('findContainingCandleIndex: empty candle array never throws');
(function () {
  assert('empty array -> -1', R.findContainingCandleIndex(T0, [], 1000) === -1);
})();

section('mapAlertToContainingChartPoint: uses the containing 4h candle\'s own timestamp and close, not the raw alert timestamp');
(function () {
  const FOUR_H = 4 * 60 * 60 * 1000;
  const candles = [{ ts: T0, close: 100 }, { ts: T0 + FOUR_H, close: 150 }];
  const alert = { timestamp: T0 + FOUR_H + 10 * FIVE_MIN, price: 999 }; // Bybit price, intentionally different
  const point = R.mapAlertToContainingChartPoint(alert, candles, FOUR_H);
  assert('point ts is the CANDLE open time, not the raw alert timestamp', point.ts === T0 + FOUR_H);
  assert('chart price is the Binance candle close, not the Bybit alert price', point.chartPrice === 150);
})();

section('mapAlertToContainingChartPoint: alert outside fetched chart range maps to null');
(function () {
  const FOUR_H = 4 * 60 * 60 * 1000;
  const candles = [{ ts: T0, close: 100 }];
  const alert = { timestamp: T0 - FOUR_H };
  assert('alert before chart data -> null', R.mapAlertToContainingChartPoint(alert, candles, FOUR_H) === null);
})();

// ── latestCompletedCandleStart ──────────────────────────────────────────

section('latestCompletedCandleStart: excludes the still-forming current candle');
(function () {
  const currentCandleStart = Math.floor(T0 / FIVE_MIN) * FIVE_MIN;
  const nowInsideThatCandle = currentCandleStart + 2 * 60 * 1000; // 2 min into the current candle
  const result = R.latestCompletedCandleStart(nowInsideThatCandle);
  assert('returns the PREVIOUS candle start, not the in-progress one', result === currentCandleStart - FIVE_MIN);
})();

section('latestCompletedCandleStart: exactly on a candle boundary still excludes it (still forming)');
(function () {
  const boundary = T0 - (T0 % FIVE_MIN); // exact 5m boundary
  const result = R.latestCompletedCandleStart(boundary);
  assert('at the exact boundary, the candle just starting is still excluded', result === boundary - FIVE_MIN);
})();

// ── Fetch reliability: rate-limit retry, backoff, cache ──────────────────

function mockResponse({ status, retCode, retMsg, list, headers }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { entries: () => (headers || []) },
    json: async () => ({ retCode: retCode != null ? retCode : 0, retMsg: retMsg || '', result: { list: list || [], nextPageCursor: null } }),
  };
}

section('isRateLimitedResponse: detects HTTP 429 and Bybit retCode 10006, nothing else');
(function () {
  assert('HTTP 429 is rate-limited', R.isRateLimitedResponse(429, null) === true);
  assert('retCode 10006 is rate-limited', R.isRateLimitedResponse(200, { retCode: 10006 }) === true);
  assert('normal 200/retCode 0 is not rate-limited', R.isRateLimitedResponse(200, { retCode: 0 }) === false);
  assert('other error codes are not treated as rate-limited', R.isRateLimitedResponse(500, { retCode: 10001 }) === false);
  assert('null json with non-429 status is not rate-limited', R.isRateLimitedResponse(200, null) === false);
})();

section('computeBackoffDelayMs: follows the 1s/2s/4s/8s/16s schedule, capped at 30s, with jitter bounded');
(function () {
  const noJitter = () => 0.5; // midpoint -> jitterFactor exactly 1.0
  assert('attempt 0 -> 1000ms at no-jitter midpoint', R.computeBackoffDelayMs(0, noJitter) === 1000);
  assert('attempt 1 -> 2000ms', R.computeBackoffDelayMs(1, noJitter) === 2000);
  assert('attempt 2 -> 4000ms', R.computeBackoffDelayMs(2, noJitter) === 4000);
  assert('attempt 3 -> 8000ms', R.computeBackoffDelayMs(3, noJitter) === 8000);
  assert('attempt 4 -> 16000ms', R.computeBackoffDelayMs(4, noJitter) === 16000);
  assert('attempt 5+ (beyond schedule) caps at 30000ms', R.computeBackoffDelayMs(5, noJitter) === 30000);
  assert('attempt 10 still caps at 30000ms', R.computeBackoffDelayMs(10, noJitter) === 30000);

  const maxJitter = () => 1; // jitterFactor = 1.25
  assert('jitter never pushes attempt 4 (16s) past the 30s cap', R.computeBackoffDelayMs(4, maxJitter) <= 30000);
  const minJitter = () => 0; // jitterFactor = 0.75
  assert('jitter can reduce attempt 0 below 1000ms (0.75x)', R.computeBackoffDelayMs(0, minJitter) === 750);
})();

section('parseRateLimitResetWaitMs: case-insensitive header read, safety buffer applied');
(function () {
  const now = 1000000;
  const headers = [['X-Bapi-Limit-Reset-Timestamp', String(now + 5000)]];
  assert('exact-case header parsed correctly with buffer', R.parseRateLimitResetWaitMs(headers, now, 500) === 5500);

  const lowerHeaders = [['x-bapi-limit-reset-timestamp', String(now + 2000)]];
  assert('lowercase header still matches (case-insensitive)', R.parseRateLimitResetWaitMs(lowerHeaders, now, 500) === 2500);

  const mixedHeaders = [['X-BAPI-Limit-Reset-Timestamp', String(now + 1000)]];
  assert('mixed-case header still matches', R.parseRateLimitResetWaitMs(mixedHeaders, now, 500) === 1500);
})();

section('parseRateLimitResetWaitMs: absent/unparseable header returns null (caller falls back to backoff)');
(function () {
  assert('no headers at all -> null', R.parseRateLimitResetWaitMs(null, 1000, 500) === null);
  assert('empty header list -> null', R.parseRateLimitResetWaitMs([], 1000, 500) === null);
  assert('unrelated headers only -> null', R.parseRateLimitResetWaitMs([['Content-Type', 'application/json']], 1000, 500) === null);
  assert('non-numeric header value -> null', R.parseRateLimitResetWaitMs([['X-Bapi-Limit-Reset-Timestamp', 'not-a-number']], 1000, 500) === null);
})();

section('parseRateLimitResetWaitMs: never returns negative — floors at 0 if reset time already passed');
(function () {
  const now = 1000000;
  const headers = [['X-Bapi-Limit-Reset-Timestamp', String(now - 5000)]]; // already in the past
  assert('past reset time floors to 0, not negative', R.parseRateLimitResetWaitMs(headers, now, 500) === 0);
})();

section('getCachedRawData: hit when lookbackDays matches and cache is still fresh');
(function () {
  const now = 1000000;
  const cache = { lookbackDays: 90, startTime: 1, endTime: 2, oiRows: [1], bybitCandles: [2], binanceCandles: [3], cachedAt: now - 1000 };
  assert('matching lookbackDays + fresh cache -> hit', R.getCachedRawData(cache, 90, now, 15 * 60 * 1000) === cache);
  assert('different lookbackDays -> miss (null) even if fresh', R.getCachedRawData(cache, 30, now, 15 * 60 * 1000) === null);
  assert('null cache -> miss', R.getCachedRawData(null, 90, now, 15 * 60 * 1000) === null);
})();

section('getCachedRawData: TTL freshness — expired cache misses even with matching lookbackDays');
(function () {
  const ttl = 15 * 60 * 1000;
  const now = 1000000;
  const freshCache = { lookbackDays: 90, cachedAt: now - (ttl - 1000) }; // 1s inside the window
  const expiredCache = { lookbackDays: 90, cachedAt: now - (ttl + 1000) }; // 1s past the window
  assert('just inside TTL -> hit', R.getCachedRawData(freshCache, 90, now, ttl) === freshCache);
  assert('just past TTL -> miss', R.getCachedRawData(expiredCache, 90, now, ttl) === null);
})();

section('getCachedRawData: exact TTL boundary is inclusive (age === ttl still hits)');
(function () {
  const ttl = 15 * 60 * 1000;
  const now = 1000000;
  const boundaryCache = { lookbackDays: 90, cachedAt: now - ttl };
  assert('age exactly equal to ttl still counts as fresh', R.getCachedRawData(boundaryCache, 90, now, ttl) === boundaryCache);
})();

section('getCachedRawData: missing cachedAt is treated as stale, not assumed fresh');
(function () {
  const now = 1000000;
  const cache = { lookbackDays: 90 }; // no cachedAt at all
  assert('no cachedAt -> always a miss', R.getCachedRawData(cache, 90, now, 15 * 60 * 1000) === null);
})();

section('getCachedRawData: defaults (no nowMs/ttlMs passed) use the real clock and 15-minute TTL');
(function () {
  const justFetched = { lookbackDays: 90, cachedAt: Date.now() - 1000 }; // 1s ago
  assert('a cache from 1 second ago hits using real-clock defaults', R.getCachedRawData(justFetched, 90) === justFetched);
  const longAgo = { lookbackDays: 90, cachedAt: Date.now() - 20 * 60 * 1000 }; // 20 min ago > default 15-min TTL
  assert('a cache from 20 minutes ago misses using the default 15-minute TTL', R.getCachedRawData(longAgo, 90) === null);
})();

section('RAW_DATA_CACHE_TTL_MS: default constant is exactly 15 minutes');
(function () {
  assert('15 * 60 * 1000 ms', R.RAW_DATA_CACHE_TTL_MS === 15 * 60 * 1000);
})();

section('fetchWithRateLimitRetry: retCode 10006 retries the EXACT SAME url and eventually succeeds');
asyncTests.push((async function () {
  let calls = [];
  let sleepCalls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (calls.length <= 2) return mockResponse({ status: 200, retCode: 10006, retMsg: 'Too many visits!' });
    return mockResponse({ status: 200, retCode: 0, list: [{ ts: '1', openInterest: '100' }] });
  };
  const sleepFn = async (ms) => { sleepCalls.push(ms); };

  const { res, json } = await R.fetchWithRateLimitRetry(fetchFn, sleepFn, 'https://example.com/page?cursor=abc', {
    maxRetries: 6,
  });

  assert('fetch was called 3 times (2 rate-limited + 1 success)', calls.length === 3);
  assert('every call used the IDENTICAL url (same page/cursor, not restarted)', calls.every(u => u === calls[0]));
  assert('eventually returns the successful response', json.retCode === 0);
  assert('slept between each retry (2 sleeps for 2 rate-limit hits)', sleepCalls.length === 2);
})());

section('fetchWithRateLimitRetry: HTTP 429 also triggers retry (not just retCode 10006)');
asyncTests.push((async function () {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls === 1) return mockResponse({ status: 429, retCode: 0 });
    return mockResponse({ status: 200, retCode: 0, list: [] });
  };
  const sleepFn = async () => {};
  const { json } = await R.fetchWithRateLimitRetry(fetchFn, sleepFn, 'https://example.com/x', { maxRetries: 6 });
  assert('recovered after a 429', json.retCode === 0);
  assert('exactly 2 calls (1 rate-limited + 1 success)', calls === 2);
})());

section('fetchWithRateLimitRetry: exhausting retries throws cleanly, never returns partial data');
asyncTests.push((async function () {
  let calls = 0;
  const fetchFn = async () => { calls++; return mockResponse({ status: 200, retCode: 10006, retMsg: 'Too many visits!' }); };
  const sleepFn = async () => {};

  let threw = false;
  let result = undefined;
  try {
    result = await R.fetchWithRateLimitRetry(fetchFn, sleepFn, 'https://example.com/x', { maxRetries: 3 });
  } catch (e) {
    threw = true;
    assert('error message mentions rate limiting', /rate-limited/i.test(e.message));
  }
  assert('throws rather than returning a value', threw === true);
  assert('function never resolved a value', result === undefined);
  assert('made exactly maxRetries+1 attempts (1 initial + 3 retries)', calls === 4);
})());

section('fetchWithRateLimitRetry: prefers the reset-timestamp header over backoff when present');
asyncTests.push((async function () {
  let sleepCalls = [];
  let callCount = 0;
  const now = 5000000;
  const fetchFn = async () => {
    callCount++;
    if (callCount === 1) {
      return mockResponse({
        status: 200, retCode: 10006,
        headers: [['X-Bapi-Limit-Reset-Timestamp', String(now + 3000)]],
      });
    }
    return mockResponse({ status: 200, retCode: 0, list: [] });
  };
  const sleepFn = async (ms) => { sleepCalls.push(ms); };
  await R.fetchWithRateLimitRetry(fetchFn, sleepFn, 'https://example.com/x', {
    maxRetries: 6, nowFn: () => now,
  });
  assert('waited exactly the header-derived time (3000 + 500 safety buffer), not a generic backoff value', sleepCalls[0] === 3500);
})());

section('fetchBybitOI (integration): retries a rate-limited page via the shared retry path, does not restart pagination');
asyncTests.push((async function () {
  let pageRequests = [];
  const fetchFn = async (url) => {
    pageRequests.push(url);
    const isFirstPageFirstAttempt = pageRequests.filter(u => !u.includes('cursor')).length === 1;
    if (!url.includes('cursor') && isFirstPageFirstAttempt) {
      return mockResponse({ status: 200, retCode: 10006, retMsg: 'Too many visits!' });
    }
    if (!url.includes('cursor')) {
      return mockResponse({ status: 200, retCode: 0, list: [{ timestamp: '1000', openInterest: '50' }], });
    }
    return mockResponse({ status: 200, retCode: 0, list: [] }); // terminate pagination
  };
  const sleepFn = async () => {};
  const progressEvents = [];

  const rows = await R.fetchBybitOI(0, 1000, {
    fetchFn, sleepFn,
    onProgress: (evt) => progressEvents.push(evt),
    pageDelayMs: 0,
  });

  assert('eventually returns rows despite the initial rate limit', rows.length === 1);
  assert('a rate_limited progress event was reported', progressEvents.some(e => e.type === 'rate_limited'));
  assert('a page progress event was also reported after recovery', progressEvents.some(e => e.type === 'page'));
})());

section('fetchBybitOI (integration): retry exhaustion throws before returning any rows — nothing downstream (e.g. the event-study report) can be built from partial data');
asyncTests.push((async function () {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    return mockResponse({ status: 200, retCode: 10006, retMsg: 'Too many visits!' });
  };
  const sleepFn = async () => {};

  let threw = false;
  let rows = undefined;
  try {
    rows = await R.fetchBybitOI(0, 1000, { fetchFn, sleepFn, maxRetries: 3, pageDelayMs: 0 });
  } catch (e) {
    threw = true;
  }
  assert('fetchBybitOI throws on retry exhaustion rather than resolving with a (partial) array', threw === true);
  assert('rows variable was never assigned — no partial data escapes to a caller that might build a report from it', rows === undefined);
})());

// ── summary ───────────────────────────────────────────────────────────────

(async () => {
  await Promise.all(asyncTests);
  console.log('\n────────────────────────────────────────');
  console.log('oi-exhaustion-render: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();

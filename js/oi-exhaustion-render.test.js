// oi-exhaustion-render.test.js — UI-independent logic only (no DOM, no network).
'use strict';

const R = require('./oi-exhaustion-render.js');
const fs = require('fs');

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

// ── migrateStaleCadenceSettings (one-time localStorage migration) ────────

section('migrateStaleCadenceSettings: replaces EXACT old 5m-era defaults with the new 15m-era defaults');
(function () {
  const stale = { signalWindow: 144, baselineLookbackCandles: 8640, entryPercentile: 95 };
  const migrated = R.migrateStaleCadenceSettings(stale);
  assert('signalWindow 144 -> 48', migrated.signalWindow === 48);
  assert('baselineLookbackCandles 8640 -> 2880', migrated.baselineLookbackCandles === 2880);
  assert('unrelated fields untouched', migrated.entryPercentile === 95);
})();

section('migrateStaleCadenceSettings: does NOT touch a value that is not exactly the old default (a deliberate user choice)');
(function () {
  const deliberate = { signalWindow: 96, baselineLookbackCandles: 5000 };
  const migrated = R.migrateStaleCadenceSettings(deliberate);
  assert('a deliberately different signalWindow is left alone', migrated.signalWindow === 96);
  assert('a deliberately different baselineLookbackCandles is left alone', migrated.baselineLookbackCandles === 5000);
})();

section('migrateStaleCadenceSettings: a user who deliberately re-sets a value BACK to the old number (144/8640) after migration is not the concern of this pure function — that is handled by the one-time localStorage gate in loadSettings, not here');
(function () {
  // This function is deliberately unconditional/stateless — it always
  // converts an exact-144/8640 match. The "only once, ever" guarantee
  // comes from the SETTINGS_MIGRATION_KEY flag checked by loadSettings
  // before calling this, not from this function itself.
  const stale = { signalWindow: 144 };
  const migrated = R.migrateStaleCadenceSettings(stale);
  assert('144 always maps to 48 when this function is actually invoked', migrated.signalWindow === 48);
})();

section('migrateStaleCadenceSettings: does not mutate the input, handles null/non-object gracefully');
(function () {
  const original = { signalWindow: 144 };
  const originalCopy = Object.assign({}, original);
  R.migrateStaleCadenceSettings(original);
  assert('input object unchanged after migration call', JSON.stringify(original) === JSON.stringify(originalCopy));
  assert('null input returns null, no throw', R.migrateStaleCadenceSettings(null) === null);
  assert('non-object input returned as-is, no throw', R.migrateStaleCadenceSettings('garbage') === 'garbage');
})();

section('validateSettings: fills in defaults for missing/undefined fields');
(function () {
  const s = R.validateSettings({});
  assert('lookbackDays defaults to 90', s.lookbackDays === 90);
  assert('entryPercentile defaults to 95', s.entryPercentile === 95);
  assert('rearmPercentile defaults to 80', s.rearmPercentile === 80);
  assert('baselineLookbackCandles defaults to 2880 (30d at 15m, was 8640 at 5m)', s.baselineLookbackCandles === 2880);
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

section('validateSettings: cryptoHftApiKey passthrough — trimmed string, defaults to empty');
(function () {
  const s1 = R.validateSettings({});
  assert('default cryptoHftApiKey is empty string', s1.cryptoHftApiKey === '');
  const s2 = R.validateSettings({ cryptoHftApiKey: '  abc123  ' });
  assert('cryptoHftApiKey is trimmed', s2.cryptoHftApiKey === 'abc123');
  const s3 = R.validateSettings({ cryptoHftApiKey: 42 });
  assert('non-string cryptoHftApiKey falls back to default', s3.cryptoHftApiKey === '');
})();

section('validateSettings: directional-impulse fields default correctly and off by default');
(function () {
  const s = R.validateSettings({});
  assert('directionalImpulseEnabled defaults to false', s.directionalImpulseEnabled === false);
  assert('directionalImpulseWindow defaults to 15m', s.directionalImpulseWindow === '15m');
  assert('directionalPriceEntryPercentile defaults to 95', s.directionalPriceEntryPercentile === 95);
  assert('directionalOiEntryPercentile defaults to 95', s.directionalOiEntryPercentile === 95);
  assert('directionalImpulseRearmPercentile defaults to 90', s.directionalImpulseRearmPercentile === 90);
  assert('directionalMinRawOiIncreasePct defaults to 1', s.directionalMinRawOiIncreasePct === 1);
})();

section('validateSettings: directional-impulse fields validate/clamp/coerce correctly');
(function () {
  const s1 = R.validateSettings({ directionalImpulseEnabled: 'true' });
  assert('string "true" coerces to boolean true', s1.directionalImpulseEnabled === true);

  const s2 = R.validateSettings({ directionalImpulseWindow: 'garbage' });
  assert('invalid window falls back to default (15m)', s2.directionalImpulseWindow === '15m');
  const s3 = R.validateSettings({ directionalImpulseWindow: '2h' });
  assert('valid window (2h) accepted', s3.directionalImpulseWindow === '2h');

  const s4 = R.validateSettings({ directionalPriceEntryPercentile: 30, directionalOiEntryPercentile: 200 });
  assert('price entry percentile clamped to >=50', s4.directionalPriceEntryPercentile === 50);
  assert('OI entry percentile clamped to <=100', s4.directionalOiEntryPercentile === 100);

  const s5 = R.validateSettings({ directionalPriceEntryPercentile: 90, directionalOiEntryPercentile: 92, directionalImpulseRearmPercentile: 95 });
  assert('rearm percentile cannot exceed the LOWER of the two entry percentiles', s5.directionalImpulseRearmPercentile <= 90);

  const s6 = R.validateSettings({ directionalMinRawOiIncreasePct: -5 });
  assert('negative raw OI floor clamped to >=0', s6.directionalMinRawOiIncreasePct === 0);
})();

// ── fetchCryptoHFTAggregateOI (dependency-injected) ─────────────────────

function mockCryptoHFTResponse({ status, rows }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, // decodeZst mock ignores actual bytes
    text: async () => '',
    headers: { entries: () => [] },
    __rows: rows, // stashed for the mock decoder to read back out
  };
}

section('fetchCryptoHFTAggregateOI: requires an API key');
asyncTests.push((async function () {
  let threw = false;
  try {
    await R.fetchCryptoHFTAggregateOI(0, 1000, '', { decodeZst: () => new Uint8Array(), parseParquet: async () => [] });
  } catch (e) {
    threw = true;
    assert('error mentions API key', /API key/i.test(e.message));
  }
  assert('throws without an API key', threw === true);
})());

section('fetchCryptoHFTAggregateOI: requires decodeZst and parseParquet to be provided');
asyncTests.push((async function () {
  let threw = false;
  try {
    await R.fetchCryptoHFTAggregateOI(0, 1000, 'fake-key', {});
  } catch (e) {
    threw = true;
  }
  assert('throws without decode functions', threw === true);
})());

section('fetchCryptoHFTAggregateOI: injects `exchange` from the requested venue into every row, aggregates via bucketAndAggregateOI');
asyncTests.push((async function () {
  const bucketMs = 15 * 60 * 1000;
  const baseTs = Math.floor(Date.now() / bucketMs) * bucketMs - 6 * 60 * 60 * 1000;

  const fetchFn = async (url) => {
    // Every request "succeeds" with one row for whichever venue is in the URL.
    return mockCryptoHFTResponse({ status: 200, rows: [{ timestamp: String(baseTs), sum_open_interest: '1', sum_open_interest_value: '100' }] });
  };
  const decodeZst = (bytes) => bytes; // pass-through mock
  const parseParquet = async (bytes) => {
    // The mock fetchFn above doesn't actually carry rows through arrayBuffer,
    // so this test only needs to prove exchange injection + no-throw behavior
    // via a fixed single row per call.
    return [{ timestamp: String(baseTs), sum_open_interest: '1', sum_open_interest_value: '100' }];
  };
  const sleepFn = async () => {};

  const result = await R.fetchCryptoHFTAggregateOI(baseTs, baseTs + bucketMs, 'fake-key', {
    fetchFn, decodeZst, parseParquet, sleepFn, hourStepHours: 24, pageDelayMs: 0,
  });

  assert('produced at least one aggregate bucket (all 3 canonical venues reported the same bucket)', result.oiRows.length >= 1);
  assert('oi sums to 300 (3 venues * 100 each — Bitget excluded from the canonical basket)', result.oiRows.some(r => Math.abs(r.oi - 300) < 1e-9));
  assert('coverage reports all 3 venues seen', result.coverage.venuesSeen.length === 3);
  assert('totalRequests > 0 and is a multiple of 3 (3 canonical venues)', result.totalRequests > 0 && result.totalRequests % 3 === 0);
})());

section('fetchCryptoHFTAggregateOI: a 404 for one venue/hour is skipped (not fatal), other venues still aggregate');
asyncTests.push((async function () {
  const bucketMs = 15 * 60 * 1000;
  const baseTs = Math.floor(Date.now() / bucketMs) * bucketMs - 6 * 60 * 60 * 1000;

  const fetchFn = async (url) => {
    if (url.includes('okx_futures')) return mockCryptoHFTResponse({ status: 404 });
    return mockCryptoHFTResponse({ status: 200 });
  };
  const decodeZst = (bytes) => bytes;
  const parseParquet = async () => [{ timestamp: String(baseTs), sum_open_interest: '1', sum_open_interest_value: '50' }];
  const sleepFn = async () => {};

  const result = await R.fetchCryptoHFTAggregateOI(baseTs, baseTs + bucketMs, 'fake-key', {
    fetchFn, decodeZst, parseParquet, sleepFn, hourStepHours: 24, pageDelayMs: 0,
  });

  assert('404 does not throw', true); // reaching this line at all proves it
  assert('okx_futures missing -> no complete bucket (2 of 3 required venues only)', result.oiRows.length === 0);
  assert('coverage shows only 2 venues seen', result.coverage.venuesSeen.length === 2);
  assert('skipped404Count > 0', result.skipped404Count > 0);
})());

section('fetchCryptoHFTAggregateOI: a non-404 HTTP error is fatal, throws with the failing path in the message');
asyncTests.push((async function () {
  const bucketMs = 15 * 60 * 1000;
  const baseTs = Math.floor(Date.now() / bucketMs) * bucketMs - 6 * 60 * 60 * 1000;

  const fetchFn = async () => mockCryptoHFTResponse({ status: 401 });
  const decodeZst = (bytes) => bytes;
  const parseParquet = async () => [];
  const sleepFn = async () => {};

  let threw = false;
  try {
    await R.fetchCryptoHFTAggregateOI(baseTs, baseTs + bucketMs, 'bad-key', {
      fetchFn, decodeZst, parseParquet, sleepFn, hourStepHours: 24, pageDelayMs: 0,
    });
  } catch (e) {
    threw = true;
    assert('error mentions the httpStatus', /401/.test(e.message));
  }
  assert('non-404 error is fatal (throws)', threw === true);
})());

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
  const FIFTEEN_MIN = R.CHART_INTERVAL_MS;
  const currentCandleStart = Math.floor(T0 / FIFTEEN_MIN) * FIFTEEN_MIN;
  const nowInsideThatCandle = currentCandleStart + 2 * 60 * 1000; // 2 min into the current candle
  const result = R.latestCompletedCandleStart(nowInsideThatCandle);
  assert('returns the PREVIOUS candle start, not the in-progress one', result === currentCandleStart - FIFTEEN_MIN);
})();

section('latestCompletedCandleStart: exactly on a candle boundary still excludes it (still forming)');
(function () {
  const FIFTEEN_MIN = R.CHART_INTERVAL_MS;
  const boundary = T0 - (T0 % FIFTEEN_MIN); // exact 15m boundary
  const result = R.latestCompletedCandleStart(boundary);
  assert('at the exact boundary, the candle just starting is still excluded', result === boundary - FIFTEEN_MIN);
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

section('getCachedRawData: hit when the cache CONTAINS the requested range and is still fresh');
(function () {
  const now = 1000000;
  const cache = { lookbackDays: 90, startTime: 100, endTime: 200, oiRows: [{ ts: 100 }, { ts: 150 }, { ts: 200 }], binanceCandles: [{ ts: 100 }, { ts: 150 }, { ts: 200 }], cachedAt: now - 1000 };
  const hit = R.getCachedRawData(cache, 100, 200, now, 15 * 60 * 1000);
  assert('exact-range request against a matching cache -> hit', hit !== null);
  const narrower = R.getCachedRawData(cache, 150, 200, now, 15 * 60 * 1000);
  assert('a NARROWER request fully contained in a wider cache also hits (the actual bug fix)', narrower !== null);
  const wider = R.getCachedRawData(cache, 50, 200, now, 15 * 60 * 1000);
  assert('a request extending BEFORE the cached start is a miss (not contained)', wider === null);
  assert('null cache -> miss', R.getCachedRawData(null, 100, 200, now, 15 * 60 * 1000) === null);
})();

section('getCachedRawData: a cache hit SLICES candles/OI down to exactly the requested range, never returning extra history');
(function () {
  const now = 1000000;
  const cache = {
    startTime: 0, endTime: 300,
    binanceCandles: [{ ts: 0 }, { ts: 100 }, { ts: 200 }, { ts: 300 }],
    oiRows: [{ ts: 0 }, { ts: 100 }, { ts: 200 }, { ts: 300 }],
    coverage: { fake: true },
    cachedAt: now - 1000,
  };
  const result = R.getCachedRawData(cache, 100, 200, now, 15 * 60 * 1000);
  assert('sliced binanceCandles only includes the requested range', result.binanceCandles.length === 2 && result.binanceCandles.every(c => c.ts >= 100 && c.ts <= 200));
  assert('sliced oiRows only includes the requested range', result.oiRows.length === 2);
  assert('returned startTime/endTime reflect the REQUEST, not the wider cache', result.startTime === 100 && result.endTime === 200);
  assert('coverage is carried through from the cache', result.coverage === cache.coverage);
})();

section('getCachedRawData: TTL freshness — expired cache misses even when the range is contained');
(function () {
  const ttl = 15 * 60 * 1000;
  const now = 1000000;
  const base = { startTime: 0, endTime: 1000, binanceCandles: [], oiRows: [] };
  const freshCache = Object.assign({}, base, { cachedAt: now - (ttl - 1000) }); // 1s inside the window
  const expiredCache = Object.assign({}, base, { cachedAt: now - (ttl + 1000) }); // 1s past the window
  assert('just inside TTL -> hit', R.getCachedRawData(freshCache, 0, 1000, now, ttl) !== null);
  assert('just past TTL -> miss', R.getCachedRawData(expiredCache, 0, 1000, now, ttl) === null);
})();

section('getCachedRawData: exact TTL boundary is inclusive (age === ttl still hits)');
(function () {
  const ttl = 15 * 60 * 1000;
  const now = 1000000;
  const boundaryCache = { startTime: 0, endTime: 1000, binanceCandles: [], oiRows: [], cachedAt: now - ttl };
  assert('age exactly equal to ttl still counts as fresh', R.getCachedRawData(boundaryCache, 0, 1000, now, ttl) !== null);
})();

section('getCachedRawData: missing cachedAt is treated as stale, not assumed fresh');
(function () {
  const now = 1000000;
  const cache = { startTime: 0, endTime: 1000, binanceCandles: [], oiRows: [] }; // no cachedAt at all
  assert('no cachedAt -> always a miss', R.getCachedRawData(cache, 0, 1000, now, 15 * 60 * 1000) === null);
})();

section('getCachedRawData: defaults (no nowMs/ttlMs passed) use the real clock and 15-minute TTL');
(function () {
  const justFetched = { startTime: 0, endTime: 1000, binanceCandles: [], oiRows: [], cachedAt: Date.now() - 1000 }; // 1s ago
  assert('a cache from 1 second ago hits using real-clock defaults', R.getCachedRawData(justFetched, 0, 1000) !== null);
  const longAgo = { startTime: 0, endTime: 1000, binanceCandles: [], oiRows: [], cachedAt: Date.now() - 20 * 60 * 1000 }; // 20 min ago > default 15-min TTL
  assert('a cache from 20 minutes ago misses using the default 15-minute TTL', R.getCachedRawData(longAgo, 0, 1000) === null);
})();

section('getCachedRawData: the exact reported scenario — a completed 30-day cache satisfies a subsequent 28-day request');
(function () {
  const now = Date.UTC(2026, 6, 1);
  const dayMs = 24 * 60 * 60 * 1000;
  const cacheEnd = now;
  const cacheStart = cacheEnd - 30 * dayMs;
  // A realistic-shaped 30-day cache: one candle/OI row per day for simplicity.
  const binanceCandles = [];
  const oiRows = [];
  for (let t = cacheStart; t <= cacheEnd; t += dayMs) {
    binanceCandles.push({ ts: t, close: 100 });
    oiRows.push({ ts: t, oi: 1000 });
  }
  const cache30d = { lookbackDays: 30, startTime: cacheStart, endTime: cacheEnd, binanceCandles, oiRows, coverage: { ok: true }, cachedAt: now - 1000 };

  // User switches Lookback days from 30 to 28 — the new request window:
  const requestEnd = cacheEnd; // "latest completed candle" doesn't move within the same session
  const requestStart = requestEnd - 28 * dayMs;

  const result = R.getCachedRawData(cache30d, requestStart, requestEnd, now, 15 * 60 * 1000);
  assert('the 28-day request is satisfied by the 30-day cache (no null miss)', result !== null);
  assert('no candle before the newly requested (28-day) start leaks through', result.binanceCandles.every(c => c.ts >= requestStart));
  assert('no OI row before the newly requested (28-day) start leaks through', result.oiRows.every(r => r.ts >= requestStart));
  assert('the returned window reflects the NEW 28-day request, not the original 30', result.startTime === requestStart && result.endTime === requestEnd);

  // And switching back to 30 immediately re-hits the same original cache, unsliced.
  const backTo30 = R.getCachedRawData(cache30d, cacheStart, cacheEnd, now, 15 * 60 * 1000);
  assert('switching back to 30 days still hits the same cache instantly', backTo30 !== null && backTo30.binanceCandles.length === binanceCandles.length);
})();

section('classifyCryptoHFTCacheAction: completed IndexedDB cache survives reload and satisfies an identical request (contained_slice)');
(function () {
  const entry = { startTime: 1000, endTime: 2000, updatedAt: Date.now() };
  const result = R.classifyCryptoHFTCacheAction(entry, true, 1000, 2000);
  assert('exact-range match against a complete entry -> contained_slice', result.action === 'contained_slice');
})();

section('classifyCryptoHFTCacheAction: a wider completed cache satisfies a smaller contained request (e.g. 30-day cache, 28-day request)');
(function () {
  const dayMs = 24 * 60 * 60 * 1000;
  const cacheEnd = 30 * dayMs;
  const cacheStart = 0;
  const entry = { startTime: cacheStart, endTime: cacheEnd, updatedAt: Date.now() };
  const requestStart = cacheEnd - 28 * dayMs;
  const result = R.classifyCryptoHFTCacheAction(entry, true, requestStart, cacheEnd);
  assert('28-day request inside a 30-day cache -> contained_slice, not a fetch', result.action === 'contained_slice');
})();

section('classifyCryptoHFTCacheAction: THE ACTUAL BUG — a cache missing only the newest 15m candle(s) must trigger tail_refresh, not full_fetch');
(function () {
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const cachedStart = 0;
  const cachedEnd = 30 * 24 * 60 * 60 * 1000; // a completed 30-day cache
  const entry = { startTime: cachedStart, endTime: cachedEnd, updatedAt: Date.now() };
  // The request's endTime has moved forward by exactly one completed 15m
  // candle since the cache was built — e.g. hard-refreshed and rerun a
  // few minutes later with otherwise identical settings. This is EXACTLY
  // the reported regression: cacheContainsRange alone would reject this
  // (idbEntry.endTime < endTime) and fall through to a full refetch.
  const newEndTime = cachedEnd + FIFTEEN_MIN;
  const newStartTime = newEndTime - 30 * 24 * 60 * 60 * 1000; // same 30-day lookback, just shifted forward
  const result = R.classifyCryptoHFTCacheAction(entry, true, newStartTime, newEndTime);
  assert('missing only the newest tail -> tail_refresh, NOT full_fetch', result.action === 'tail_refresh');
  assert('reports the correct (small) gap size', result.gapMs === FIFTEEN_MIN);
})();

section('classifyCryptoHFTCacheAction: a cache range that misses the requested HEAD is rejected safely (full_fetch, never merged)');
(function () {
  const entry = { startTime: 1000, endTime: 2000, updatedAt: Date.now() };
  // Request starts BEFORE the cache does — a missing head, not a missing tail.
  const result = R.classifyCryptoHFTCacheAction(entry, true, 500, 2000);
  assert('missing head -> full_fetch (never treated as a tail gap)', result.action === 'full_fetch');
  assert('reason correctly identifies the head-coverage failure', result.reason === 'complete_cache_does_not_cover_requested_head');
})();

section('classifyCryptoHFTCacheAction: a tail gap larger than the safety ceiling falls back to full_fetch, not an unbounded incremental fetch');
(function () {
  const entry = { startTime: 0, endTime: 1000, updatedAt: Date.now() };
  const hugeGap = R.DEFAULT_MAX_TAIL_GAP_MS + 1;
  const result = R.classifyCryptoHFTCacheAction(entry, true, 500, 1000 + hugeGap);
  assert('an oversized tail gap is NOT incrementally refreshed', result.action === 'full_fetch');
  assert('reason explains why', result.reason === 'tail_gap_exceeds_incremental_refresh_ceiling');
})();

section('classifyCryptoHFTCacheAction: no cache entry at all -> full_fetch');
(function () {
  const result = R.classifyCryptoHFTCacheAction(null, false, 0, 1000);
  assert('null entry -> full_fetch', result.action === 'full_fetch');
  assert('reason is explicit', result.reason === 'no_cache_entry');
})();

section('classifyCryptoHFTCacheAction: an incomplete entry only resumes when its range EXACTLY matches the new request');
(function () {
  const incompleteExact = { startTime: 1000, endTime: 2000, updatedAt: Date.now() };
  const exactMatch = R.classifyCryptoHFTCacheAction(incompleteExact, false, 1000, 2000);
  assert('incomplete entry, exact range match -> resume', exactMatch.action === 'resume');

  const incompleteMismatched = { startTime: 1000, endTime: 1900, updatedAt: Date.now() };
  const mismatch = R.classifyCryptoHFTCacheAction(incompleteMismatched, false, 1000, 2000);
  assert('incomplete entry with a DIFFERENT range -> full_fetch, never merged as if resumable', mismatch.action === 'full_fetch');
  assert('reason is explicit', mismatch.reason === 'incomplete_entry_does_not_match_requested_range');
})();

section('mergeTimestampedRows: merges two arrays, de-dupes by exact timestamp (new wins), sorts ascending');
(function () {
  const old = [{ ts: 0, v: 'old0' }, { ts: 100, v: 'old100' }, { ts: 200, v: 'old200' }];
  const fresh = [{ ts: 200, v: 'new200' }, { ts: 300, v: 'new300' }];
  const merged = R.mergeTimestampedRows(old, fresh);
  assert('4 unique timestamps after merging (200 deduped, not doubled)', merged.length === 4);
  assert('sorted ascending', merged.every((r, i) => i === 0 || r.ts > merged[i - 1].ts));
  assert('on a timestamp collision, the NEW row wins', merged.find(r => r.ts === 200).v === 'new200');
  assert('old-only and new-only rows both survive', merged.some(r => r.ts === 0) && merged.some(r => r.ts === 300));
})();

section('mergeTimestampedRows: empty/garbage input never throws');
(function () {
  assert('both empty -> []', R.mergeTimestampedRows([], []).length === 0);
  assert('null old -> just the new rows', R.mergeTimestampedRows(null, [{ ts: 1 }]).length === 1);
  assert('null new -> just the old rows', R.mergeTimestampedRows([{ ts: 1 }], null).length === 1);
  assert('garbage entries without a numeric ts are skipped, not thrown on', R.mergeTimestampedRows([{ ts: 1 }, 'garbage', null], [{ noTs: true }]).length === 1);
})();

section('cacheContainsRange: pure containment check');
(function () {
  assert('cache exactly matching the request contains it', R.cacheContainsRange({ startTime: 0, endTime: 100 }, 0, 100) === true);
  assert('wider cache contains a narrower request', R.cacheContainsRange({ startTime: 0, endTime: 100 }, 20, 80) === true);
  assert('cache starting after the request does not contain it', R.cacheContainsRange({ startTime: 50, endTime: 100 }, 0, 100) === false);
  assert('cache ending before the request does not contain it', R.cacheContainsRange({ startTime: 0, endTime: 50 }, 0, 100) === false);
  assert('null cache never contains anything', R.cacheContainsRange(null, 0, 100) === false);
})();

section('sliceRawDataToRange: pure slicing, inclusive boundaries, empty/garbage input never throws');
(function () {
  const candles = [{ ts: 0 }, { ts: 50 }, { ts: 100 }, { ts: 150 }];
  const oi = [{ ts: 0 }, { ts: 50 }, { ts: 100 }, { ts: 150 }];
  const sliced = R.sliceRawDataToRange(candles, oi, 50, 100);
  assert('inclusive on both boundaries', sliced.binanceCandles.length === 2 && sliced.oiRows.length === 2);
  assert('empty arrays -> empty result, no throw', R.sliceRawDataToRange([], [], 0, 100).binanceCandles.length === 0);
  assert('null arrays -> empty result, no throw', R.sliceRawDataToRange(null, null, 0, 100).binanceCandles.length === 0);
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

// ── Safe formatting (defense against undefined/missing values in status/UI) ──

section('safeNumber: valid finite numbers format normally');
(function () {
  assert('plain integer', R.safeNumber(1234) === (1234).toLocaleString());
  assert('with options (maximumFractionDigits)', R.safeNumber(1234.5, { maximumFractionDigits: 0 }) === (1234.5).toLocaleString(undefined, { maximumFractionDigits: 0 }));
})();

section('safeNumber: undefined/null/NaN/non-number all return "unknown" instead of throwing');
(function () {
  assert('undefined -> unknown', R.safeNumber(undefined) === 'unknown');
  assert('null -> unknown', R.safeNumber(null) === 'unknown');
  assert('NaN -> unknown', R.safeNumber(NaN) === 'unknown');
  assert('Infinity -> unknown', R.safeNumber(Infinity) === 'unknown');
  assert('a string -> unknown (never calls toLocaleString on a non-number)', R.safeNumber('binance-candles') === 'unknown');
  assert('an object -> unknown', R.safeNumber({}) === 'unknown');
})();

section('safeUtcDateString: valid epoch-ms timestamp formats correctly');
(function () {
  const ts = Date.UTC(2026, 5, 30, 0, 40); // 2026-06-30 00:40 UTC
  assert('formats as YYYY-MM-DD HH:MM UTC', R.safeUtcDateString(ts) === '2026-06-30 00:40 UTC');
})();

section('safeUtcDateString: missing/invalid input returns "unknown", never throws or renders "Invalid Date"');
(function () {
  assert('undefined -> unknown', R.safeUtcDateString(undefined) === 'unknown');
  assert('null -> unknown', R.safeUtcDateString(null) === 'unknown');
  assert('NaN -> unknown', R.safeUtcDateString(NaN) === 'unknown');
  assert('a string -> unknown', R.safeUtcDateString('2026-06-30') === 'unknown');
})();

section('REGRESSION: a wrong-shaped progress event (old positional-args style) does not crash — this was the actual June/July bug');
(function () {
  // This mirrors exactly what happened: fetchBinanceCandles used to call
  // onProgress('binance-candles', pageIndex, rows) — a bare string, not the
  // {type, source, page, rowsSoFar} object every other caller sends. The
  // status formatter did `evt.rowsSoFar.toLocaleString()` and blew up on
  // undefined the instant Binance's concurrent fetch reported progress
  // before Bybit even started. Simulates that exact malformed event shape
  // reaching the safe formatter and confirms it degrades gracefully.
  const malformedEvent = 'binance-candles'; // what the old buggy call effectively passed as "evt"
  let threw = false;
  let formatted = null;
  try {
    // this is the same expression pattern used in the status formatter
    formatted = `rows collected: ${R.safeNumber(malformedEvent.rowsSoFar)}`;
  } catch (e) {
    threw = true;
  }
  assert('does not throw on a malformed/string event', threw === false);
  assert('renders "unknown" rather than a number', formatted === 'rows collected: unknown');
})();

// ── REGRESSION: empty initial state / failed first run with no cache ────

section('REGRESSION: initial empty state — no cache, no prior run — cache lookup is a clean miss and touches no formatting');
(function () {
  // Mirrors app startup / a first run that fails before any successful
  // fetch ever completed: state.rawDataCache is null, so getCachedRawData
  // must return null cleanly (no cache-window/timestamp formatting is ever
  // attempted, since that code path is gated behind a truthy cache).
  const emptyCache = null;
  const result = R.getCachedRawData(emptyCache, 90, Date.now(), R.RAW_DATA_CACHE_TTL_MS);
  assert('null cache -> clean miss, not a throw', result === null);

  // Even if some future caller mistakenly tried to format an empty cache's
  // fields directly, the safe formatters must degrade rather than crash —
  // this is the actual guarantee requirement #4 depends on.
  const fakeEmptyCacheFields = { startTime: undefined, endTime: undefined, cachedAt: undefined };
  assert('startTime on an empty cache formats as unknown, not a throw', R.safeUtcDateString(fakeEmptyCacheFields.startTime) === 'unknown');
  assert('endTime on an empty cache formats as unknown, not a throw', R.safeUtcDateString(fakeEmptyCacheFields.endTime) === 'unknown');
  assert('cachedAt on an empty cache formats as unknown, not a throw', R.safeUtcDateString(fakeEmptyCacheFields.cachedAt) === 'unknown');
})();

// ── REGRESSION: fetchBinanceCandles page-delay ReferenceError ────────────

section('REGRESSION: fetchBinanceCandles requests interval=15m, matching CHART_INTERVAL_MS — a stale interval=4h silently produced 16x too few candles and was only caught by a real user run');
asyncTests.push((async function () {
  const requestedUrls = [];
  const fetchFn = async (url) => {
    requestedUrls.push(url);
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const sleepFn = async () => {};
  await R.fetchBinanceCandles(0, 1000, { fetchFn, sleepFn, pageDelayMs: 0 });

  assert('at least one request was made', requestedUrls.length > 0);
  assert('every request uses interval=15m, matching the shared signal/chart candle series', requestedUrls.every(u => u.includes('interval=15m')));
  assert('no request uses a stale interval=4h', requestedUrls.every(u => !u.includes('interval=4h')));
})());

section('REGRESSION: fetchBinanceCandles executes a multi-page fetch with an injected sleepFn — no ReferenceError on the page-delay constant');
asyncTests.push((async function () {
  // This is the exact bug: fetchBinanceCandles used to call
  // sleep(REQUEST_DELAY_MS), but REQUEST_DELAY_MS was never defined in
  // scope (it was removed during an earlier refactor). That line only
  // executes on the SECOND page of a multi-page pull, so a single-page
  // fetch would never have caught it — this test deliberately forces two
  // pages so the page-delay line actually runs.
  const T0 = Date.UTC(2026, 0, 1);
  const FOUR_H = 4 * 60 * 60 * 1000;
  const startTime = T0;
  const endTime = T0 + 3 * FOUR_H;

  let pageCount = 0;
  const sleepCalls = [];
  const fetchFn = async (url) => {
    pageCount++;
    if (pageCount === 1) {
      // First page: exactly 1000 rows worth isn't necessary — return 2
      // candles ending before endTime so the loop continues to a second page.
      const list = [
        [T0, '100', '101', '99', '100.5', '10'],
        [T0 + FOUR_H, '100.5', '102', '100', '101', '12'],
      ];
      return { ok: true, status: 200, json: async () => list, text: async () => '' };
    }
    // Second page: covers the rest, then the loop should terminate.
    const list = [
      [T0 + 2 * FOUR_H, '101', '103', '100.5', '102', '9'],
      [T0 + 3 * FOUR_H, '102', '104', '101.5', '103', '11'],
    ];
    return { ok: true, status: 200, json: async () => list, text: async () => '' };
  };
  const sleepFn = async (ms) => { sleepCalls.push(ms); };

  let threw = false;
  let candles = null;
  try {
    candles = await R.fetchBinanceCandles(startTime, endTime, { fetchFn, sleepFn, pageDelayMs: 50 });
  } catch (e) {
    threw = true;
    console.error('  (unexpected throw): ' + e.message);
  }

  assert('no ReferenceError (or any error) during a multi-page fetch', threw === false);
  assert('fetched across multiple pages', pageCount >= 2);
  assert('candles were collected from both pages', candles && candles.length === 4);
  assert('the injected sleepFn was actually called with the configured delay (proves the constant resolved, not skipped)', sleepCalls.length >= 1 && sleepCalls[0] === 50);
})());

section('BINANCE_PAGE_DELAY_MS: a real, defined constant (not the removed REQUEST_DELAY_MS)');
(function () {
  assert('BINANCE_PAGE_DELAY_MS is a positive finite number', typeof R.BINANCE_PAGE_DELAY_MS === 'number' && R.BINANCE_PAGE_DELAY_MS > 0);
})();

// ── Chart display resampling (UTC-aligned) ──────────────────────────────
// getUtcBucketStart / resampleCandlesForDisplay / buildDisplayCandleIndex /
// findDisplayCandleForAlert — replaces the old fixed-count chunking, which
// grouped every N candles from the first FETCHED candle rather than real
// UTC clock boundaries.

const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

function mkCandle(ts, base) {
  return { ts, open: base, close: base + 0.5, high: base + 1, low: base - 1 };
}

section('getUtcBucketStart: buckets align to real UTC clock boundaries, not fetch start');
(function () {
  const unaligned = Date.UTC(2026, 0, 1, 23, 47, 0); // 23:47 UTC — deliberately not on any boundary
  assert('1h bucket floors to the hour', R.getUtcBucketStart(unaligned, '1h') === Date.UTC(2026, 0, 1, 23, 0, 0));
  assert('4h bucket floors to 20:00 UTC (00/04/08/12/16/20 grid)', R.getUtcBucketStart(unaligned, '4h') === Date.UTC(2026, 0, 1, 20, 0, 0));
  assert('1d bucket floors to UTC midnight', R.getUtcBucketStart(unaligned, '1d') === Date.UTC(2026, 0, 1, 0, 0, 0));
  assert('15m bucket is the identity (already 15m-aligned)', R.getUtcBucketStart(Date.UTC(2026, 0, 1, 23, 45, 0), '15m') === Date.UTC(2026, 0, 1, 23, 45, 0));
})();

section('resampleCandlesForDisplay(15m): identity OHLC, normalized to {timestamp,...} shape');
(function () {
  const candles = [mkCandle(T0, 100), mkCandle(T0 + FIVE_MIN * 3, 101)];
  const out = R.resampleCandlesForDisplay(candles, '15m');
  assert('same candle count', out.length === candles.length);
  assert('timestamp field populated from ts', out[0].timestamp === T0);
  assert('OHLC values unchanged', out[0].open === 100 && out[0].close === 100.5 && out[0].high === 101 && out[0].low === 99);
})();

section('resampleCandlesForDisplay(1h): unaligned 23:45 UTC fetch start still buckets on real hour boundaries');
(function () {
  // 12 fifteen-minute candles starting 23:45 UTC 2026-01-01, running through
  // 02:30 UTC 2026-01-02. Real hour buckets: [23:00]=1 candle, [00:00]=4,
  // [01:00]=4, [02:00]=3 (partial, series just ends there) — NOT four
  // neat groups of 3 counted from the fetch start, which is what the old
  // fixed-count chunking would have produced.
  const start = Date.UTC(2026, 0, 1, 23, 45, 0);
  const candles = [];
  for (let i = 0; i < 12; i++) candles.push(mkCandle(start + i * FIFTEEN_MIN(), 100 + i));

  const out = R.resampleCandlesForDisplay(candles, '1h');
  assert('4 real hour buckets produced (1 + 4 + 4 + 3), not 3 fixed-count groups of 4', out.length === 4);
  assert('first bucket is the 23:00 UTC hour (contains only the 23:45 candle)', out[0].timestamp === Date.UTC(2026, 0, 1, 23, 0, 0));
  assert('first bucket OHLC = just candle 0 (100/100.5/101/99)', out[0].open === 100 && out[0].close === 100.5 && out[0].high === 101 && out[0].low === 99);
  assert('second bucket is 00:00 UTC Jan 2', out[1].timestamp === Date.UTC(2026, 0, 2, 0, 0, 0));
  assert('second bucket aggregates candles 1-4: open=101, close=104.5, high=105, low=100', out[1].open === 101 && out[1].close === 104.5 && out[1].high === 105 && out[1].low === 100);
  assert('third bucket is 01:00 UTC: open=105, close=108.5, high=109, low=104', out[2].timestamp === Date.UTC(2026, 0, 2, 1, 0, 0) && out[2].open === 105 && out[2].close === 108.5 && out[2].high === 109 && out[2].low === 104);
  assert('fourth (partial) bucket is 02:00 UTC: open=109, close=111.5, high=112, low=108', out[3].timestamp === Date.UTC(2026, 0, 2, 2, 0, 0) && out[3].open === 109 && out[3].close === 111.5 && out[3].high === 112 && out[3].low === 108);
  assert('buckets strictly ascending', out.every((b, i) => i === 0 || b.timestamp > out[i - 1].timestamp));
})();
function FIFTEEN_MIN() { return 15 * 60 * 1000; }

section('resampleCandlesForDisplay(4h/1d): exact OHLC aggregation over an aligned full day, no candle split across buckets');
(function () {
  // A full UTC day, 96 candles at 15m, starting exactly at midnight — the
  // clean case, used to check the aggregation MATH precisely (open=first,
  // close=last, high=max, low=min) once boundary-finding itself is already
  // covered by the unaligned-start test above.
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0); // 2026-03-10 UTC
  const candles = [];
  for (let i = 0; i < 96; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i));

  const h4 = R.resampleCandlesForDisplay(candles, '4h');
  assert('exactly 6 four-hour buckets (00/04/08/12/16/20 UTC)', h4.length === 6);
  for (let k = 0; k < 6; k++) {
    const expectedTs = dayStart + k * FOUR_HOUR_MS;
    const firstIdx = k * 16, lastIdx = k * 16 + 15;
    assert(`4h bucket ${k} timestamp on the real 4h grid`, h4[k].timestamp === expectedTs);
    assert(`4h bucket ${k} open = first candle's open`, h4[k].open === 1000 + firstIdx);
    assert(`4h bucket ${k} close = last candle's close`, h4[k].close === 1000 + lastIdx + 0.5);
    assert(`4h bucket ${k} high = max of the 16`, h4[k].high === 1000 + lastIdx + 1);
    assert(`4h bucket ${k} low = min of the 16`, h4[k].low === 1000 + firstIdx - 1);
  }

  const d1 = R.resampleCandlesForDisplay(candles, '1d');
  assert('exactly 1 daily bucket', d1.length === 1);
  assert('1d bucket timestamp is UTC midnight', d1[0].timestamp === dayStart);
  assert('1d bucket open = candle 0 open', d1[0].open === 1000);
  assert('1d bucket close = candle 95 close', d1[0].close === 1095.5);
  assert('1d bucket high = max of all 96', d1[0].high === 1096);
  assert('1d bucket low = min of all 96', d1[0].low === 999);
})();

section('resampleCandlesForDisplay: empty/garbage input never throws');
(function () {
  assert('empty array -> []', R.resampleCandlesForDisplay([], '1h').length === 0);
  assert('null -> []', R.resampleCandlesForDisplay(null, '1h').length === 0);
  assert('unknown timeframe falls back to 15m identity', R.resampleCandlesForDisplay([mkCandle(T0, 5)], 'bogus').length === 1);
})();

section('findDisplayCandleForAlert: correctly places an alert on its containing displayed candle at every timeframe');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 96; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i));
  // Alert sits inside 15m candle index 37 (00:00 + 9h15m) — not on any
  // coarser boundary itself, which is exactly the case that broke overlay
  // placement before this fix.
  const alertTs = dayStart + 37 * FIFTEEN_MIN();

  const h1Candles = R.resampleCandlesForDisplay(candles, '1h');
  const h1Index = R.buildDisplayCandleIndex(h1Candles);
  const h1Match = R.findDisplayCandleForAlert(alertTs, h1Index, '1h');
  assert('1h: alert maps to the 09:00 UTC hour candle', h1Match && h1Match.timestamp === dayStart + 9 * HOUR_MS);
  assert('1h: mapped candle covers candle indices 36-39 (open=1036, close=1039.5)', h1Match.open === 1036 && h1Match.close === 1039.5);

  const h4Candles = R.resampleCandlesForDisplay(candles, '4h');
  const h4Index = R.buildDisplayCandleIndex(h4Candles);
  const h4Match = R.findDisplayCandleForAlert(alertTs, h4Index, '4h');
  assert('4h: alert maps to the 08:00 UTC 4h candle', h4Match && h4Match.timestamp === dayStart + 2 * FOUR_HOUR_MS);
  assert('4h: mapped candle covers candle indices 32-47 (open=1032, close=1047.5)', h4Match.open === 1032 && h4Match.close === 1047.5);

  const d1Candles = R.resampleCandlesForDisplay(candles, '1d');
  const d1Index = R.buildDisplayCandleIndex(d1Candles);
  const d1Match = R.findDisplayCandleForAlert(alertTs, d1Index, '1d');
  assert('1d: alert maps to the single daily candle at UTC midnight', d1Match && d1Match.timestamp === dayStart);

  assert('findDisplayCandleForAlert returns null for a bucket with no displayed candle', R.findDisplayCandleForAlert(dayStart - HOUR_MS, h1Index, '1h') === null);
})();

section('mergeBinanceOIOntoDisplayCandles(15m): attaches degenerate {close,high,low} from the {ts,value} line series');
(function () {
  const displayCandles = [{ timestamp: 1000 }, { timestamp: 2000 }, { timestamp: 3000 }];
  const binanceSeries = [{ ts: 1000, value: 50 }, { ts: 2000, value: 55 }];
  const merged = R.mergeBinanceOIOntoDisplayCandles(displayCandles, binanceSeries, '15m');
  assert('matched candle gets close/high/low all equal to the single reading', merged[0].binanceOI.close === 50 && merged[0].binanceOI.high === 50 && merged[0].binanceOI.low === 50);
  assert('second matched candle correct', merged[1].binanceOI.close === 55);
  assert('unmatched candle gets null (a real gap), not a guessed/carried-over value', merged[2].binanceOI === null);
})();

section('mergeBinanceOIOntoDisplayCandles(1h/2h/4h): attaches real OHLC close/high/low from the aggregated series');
(function () {
  const displayCandles = [{ timestamp: 1000 }, { timestamp: 2000 }];
  const binanceSeries = [{ timestamp: 1000, open: 10, high: 20, low: 5, close: 15 }];
  const merged = R.mergeBinanceOIOntoDisplayCandles(displayCandles, binanceSeries, '1h');
  assert('matched candle carries close/high/low from the aggregated bucket', merged[0].binanceOI.close === 15 && merged[0].binanceOI.high === 20 && merged[0].binanceOI.low === 5);
  assert('unmatched candle gets null', merged[1].binanceOI === null);
})();

section('mergeBinanceOIOntoDisplayCandles: does not mutate the original price candle objects');
(function () {
  const original = { timestamp: 1000, close: 999 };
  const merged = R.mergeBinanceOIOntoDisplayCandles([original], [{ ts: 1000, value: 1 }], '15m');
  assert('original object is untouched (no binanceOI field added to it)', !('binanceOI' in original));
  assert('merged result is a new object', merged[0] !== original);
  assert('merged result still has the original price fields', merged[0].close === 999);
})();

section('computeBinanceOIReferenceRange: visible window under 30 days is used as-is, unclamped');
(function () {
  const visibleStart = Date.UTC(2026, 5, 1);
  const visibleEnd = visibleStart + 10 * 24 * 60 * 60 * 1000; // 10 days
  const range = R.computeBinanceOIReferenceRange(visibleStart, visibleEnd);
  assert('effectiveStart equals the visible start (no clamping needed)', range.effectiveStart === visibleStart);
  assert('effectiveEnd equals the visible end', range.effectiveEnd === visibleEnd);
  assert('wasClamped is false', range.wasClamped === false);
})();

section('computeBinanceOIReferenceRange: 30-day internal strategy coverage (with room for baseline/warmup) still derives from the VISIBLE range only, and clamps under 30 days');
(function () {
  // Simulates the exact reported bug: a 30-day lookback plus internal
  // baseline/warmup could make the underlying dataset spans wider than
  // "visible" — but analysisStartTime/analysisEndTime (what this function
  // takes) is ALWAYS the true visible window regardless of that, so a
  // clean 30-day visible window must clamp to just under 30 days, not
  // silently balloon to ~30.2 days from unrelated internal buffers.
  const visibleEnd = Date.UTC(2026, 6, 1);
  const visibleStart = visibleEnd - 30 * 24 * 60 * 60 * 1000; // exactly 30 days
  const range = R.computeBinanceOIReferenceRange(visibleStart, visibleEnd);
  assert('clamping occurred (visible window is exactly 30 days, over the safe ceiling)', range.wasClamped === true);
  assert('effectiveStart is LATER than visibleStart (clamped inward)', range.effectiveStart > visibleStart);
  const spanMs = range.effectiveEnd - range.effectiveStart;
  assert('effective span is under 30 days', spanMs < 30 * 24 * 60 * 60 * 1000);
  assert('effective span reserves exactly 15 minutes of headroom (29d23h45m) for the endTime pad', spanMs === R.BINANCE_OI_MAX_LOOKBACK_MS);
  assert('effectiveEnd always equals the visible end — clamping only ever moves the START inward', range.effectiveEnd === visibleEnd);
})();

section('computeBinanceOIReferenceRange: never influenced by anything other than its two explicit inputs (no hidden baseline/warmup coupling)');
(function () {
  // Same visible window, called twice — must be byte-identical regardless
  // of call order/context, proving there is no hidden global state (like
  // a raw-data cache's wider bounds) leaking into the computation.
  const visibleStart = Date.UTC(2026, 5, 15);
  const visibleEnd = visibleStart + 5 * 24 * 60 * 60 * 1000;
  const r1 = R.computeBinanceOIReferenceRange(visibleStart, visibleEnd);
  const r2 = R.computeBinanceOIReferenceRange(visibleStart, visibleEnd);
  assert('pure function — identical inputs always produce identical output', JSON.stringify(r1) === JSON.stringify(r2));
})();

section('mergeBinanceOIOntoDisplayCandles: empty/garbage input never throws');
(function () {
  assert('empty candles -> []', R.mergeBinanceOIOntoDisplayCandles([], [{ ts: 1, value: 1 }], '15m').length === 0);
  assert('null series -> all null binanceOI, no throw', R.mergeBinanceOIOntoDisplayCandles([{ timestamp: 1 }], null, '15m')[0].binanceOI === null);
  assert('null candles -> []', R.mergeBinanceOIOntoDisplayCandles(null, [], '15m').length === 0);
})();

section('Cache-classifier fix (tail refresh) is structurally isolated from V1/V2, directional OI chase, zones, and strategy outputs');
(function () {
  const src = fs.readFileSync(__dirname + '/oi-exhaustion-render.js', 'utf8');
  const callStart = src.indexOf('Backtest.runEventStudy(binanceCandles');
  const callEnd = src.indexOf(');', callStart);
  const callBlock = src.slice(callStart, callEnd);
  assert('runEventStudy call site exists', callStart !== -1);
  assert('runEventStudy call passes no cache-classification internals (binanceCandles/oiRows/zones/settings only, as before)', !callBlock.includes('classifyCryptoHFTCacheAction') && !callBlock.includes('mergeTimestampedRows') && !callBlock.includes('idbEntry'));

  const backtestSrc = fs.readFileSync(__dirname + '/oi-exhaustion-backtest.js', 'utf8');
  const engineSrc = fs.readFileSync(__dirname + '/oi-exhaustion-engine.js', 'utf8');
  assert('oi-exhaustion-backtest.js (V1/V2/directional/zones) has no knowledge of the cache classifier at all', !backtestSrc.includes('classifyCryptoHFTCacheAction') && !backtestSrc.includes('mergeTimestampedRows'));
  assert('oi-exhaustion-engine.js has no knowledge of the cache classifier at all', !engineSrc.includes('classifyCryptoHFTCacheAction') && !engineSrc.includes('mergeTimestampedRows'));
})();

section('Binance OI reference layer: structurally isolated from strategy inputs (source-level guard)');
(function () {
  const src = fs.readFileSync(__dirname + '/oi-exhaustion-render.js', 'utf8');
  const callStart = src.indexOf('Backtest.runEventStudy(binanceCandles');
  const callEnd = src.indexOf(');', callStart);
  const callBlock = src.slice(callStart, callEnd);
  assert('the actual runEventStudy call site exists', callStart !== -1);
  assert('runEventStudy call passes NO binanceOI-derived field', !callBlock.includes('binanceOI') && !callBlock.includes('BinanceOI'));

  const idbCacheSrc = fs.readFileSync(__dirname + '/oi-exhaustion-idb-cache.js', 'utf8');
  assert('the IndexedDB raw-data cache module has no knowledge of Binance OI reference data at all', !idbCacheSrc.includes('binanceOI') && !idbCacheSrc.includes('BinanceOI'));

  assert('state.binanceOI is a distinct top-level state key, not nested inside settings/lastRun', /binanceOI:\s*\{[\s\S]{0,120}enabled: false/.test(src));
})();

section('nextHelpTooltipState: only one tooltip open at a time');
(function () {
  assert('opening from closed returns the clicked id', R.nextHelpTooltipState(null, 'a') === 'a');
  assert('clicking the already-open icon closes it (returns null)', R.nextHelpTooltipState('a', 'a') === null);
  assert('clicking a different icon switches to it (closes the old one)', R.nextHelpTooltipState('a', 'b') === 'b');
})();

section('createOverlaySafely: passes points directly at creation time (no overrideOverlay call)');
(function () {
  function makeFakeChart() {
    const calls = { createOverlay: [] };
    let nextId = 1;
    return {
      calls,
      createOverlay(config) {
        calls.createOverlay.push(config);
        return 'overlay_' + (nextId++);
      },
      overrideOverlay() {
        throw new Error('overrideOverlay should never be called by createOverlaySafely');
      },
    };
  }

  const chart = makeFakeChart();
  const points = [{ timestamp: 123, value: 456 }];
  const id = R.createOverlaySafely(chart, { name: 'verticalStraightLine', lock: true }, points);

  assert('returns the id from createOverlay', id === 'overlay_1');
  assert('createOverlay was called exactly once', chart.calls.createOverlay.length === 1);
  assert('createOverlay received the points directly', chart.calls.createOverlay[0].points === points);
  assert('createOverlay still received the rest of the config (name, lock)', chart.calls.createOverlay[0].name === 'verticalStraightLine' && chart.calls.createOverlay[0].lock === true);
})();

section('createOverlaySafely: regression — creating several overlays in sequence must not lose earlier ones');
(function () {
  // The prior "create empty, then overrideOverlay" approach was confirmed
  // broken in the browser: creating N alert-marker overlays in a loop left
  // only the LAST one visible. Passing points directly avoids the
  // "overlay left mid-draw" state that caused that, so every overlay in a
  // sequence must independently retain its own points — this is the exact
  // scenario that broke before.
  const created = [];
  const chart = {
    createOverlay(config) {
      const id = 'overlay_' + (created.length + 1);
      created.push({ id, points: config.points });
      return id;
    },
  };
  const groups = [
    [{ timestamp: 100, value: 10 }],
    [{ timestamp: 200, value: 20 }],
    [{ timestamp: 300, value: 30 }],
  ];
  const ids = groups.map(pts => R.createOverlaySafely(chart, { name: 'verticalStraightLine' }, pts));

  assert('3 distinct overlay ids returned', new Set(ids).size === 3);
  assert('all 3 overlays were created (not just the last)', created.length === 3);
  assert('each overlay retains its OWN points, not overwritten by a later call', created.every((c, i) => c.points === groups[i]));
})();

section('createOverlaySafely: handles an array return from createOverlay (klinecharts returns an array for array input)');
(function () {
  const chart = { createOverlay: () => ['overlay_arr_1'] };
  assert('unwraps the first id from an array return', R.createOverlaySafely(chart, { name: 'x' }, []) === 'overlay_arr_1');
})();

section('createOverlaySafely: optional paneId targets a specific pane (e.g. the Binance OI reference pane)');
(function () {
  const calls = [];
  const chart = { createOverlay: (config, paneId) => { calls.push({ config, paneId }); return 'ov1'; } };
  R.createOverlaySafely(chart, { name: 'x' }, [], 'some-pane-id');
  assert('paneId passed through as createOverlay\'s second positional argument', calls[0].paneId === 'some-pane-id');

  const calls2 = [];
  const chart2 = { createOverlay: (config, paneId) => { calls2.push({ config, paneId }); return 'ov2'; } };
  R.createOverlaySafely(chart2, { name: 'x' }, []);
  assert('omitting paneId calls createOverlay with only one argument (default candle pane)', calls2[0].paneId === undefined);
})();

section('createOverlaySafely: returns null (not throw) if createOverlay fails');
(function () {
  const chart = { createOverlay: () => null };
  const result = R.createOverlaySafely(chart, { name: 'x' }, []);
  assert('returns null when createOverlay fails', result === null);
})();

// ── reconcileChartMarkers / formatChartMarkerDiagnosticLine ──────────────
// "Not every valid alert appears as a marker" — root cause was multiple
// alerts sharing one displayed candle drawing perfectly-overlapping,
// visually-indistinguishable overlays. These tests cover the reconciliation
// (every alert accounted for exactly once: mapped-into-a-group XOR
// excluded-with-a-reason) that the fix is built on.

function mkAlert(ts, price, overrides) {
  return Object.assign({
    timestamp: ts,
    price: price,
    score: 1,
    alertModel: 'netProgress',
    contextDirection: 'bearish-exhaustion',
    zoneBounds: { label: 'test-zone', id: 'zone-1' },
    zoneId: 'zone-1',
  }, overrides || {});
}

section('reconcileChartMarkers: every 15m alert maps to its exact raw candle (1:1, no grouping)');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 20; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i));
  const displayCandles = R.resampleCandlesForDisplay(candles, '15m');

  const alerts = [
    mkAlert(dayStart + 2 * FIFTEEN_MIN(), 1002),
    mkAlert(dayStart + 5 * FIFTEEN_MIN(), 1005),
    mkAlert(dayStart + 19 * FIFTEEN_MIN(), 1019),
  ];
  const r = R.reconcileChartMarkers(alerts, candles, displayCandles, '15m');

  assert('all 3 alerts mapped', r.mappedCount === 3);
  assert('none excluded', r.outsideRangeCount === 0);
  assert('none grouped (each on its own distinct candle)', r.groupedAlertCount === 0);
  assert('3 distinct single-alert groups', r.groups.length === 3 && r.groups.every(g => g.alerts.length === 1));
  assert('each group timestamp equals the alert\'s own raw candle ts (exact 1:1 at 15m)', r.groups[0].timestamp === dayStart + 2 * FIFTEEN_MIN());
})();

section('reconcileChartMarkers: alerts at the very start and very end of the visible range');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i));
  const displayCandles = R.resampleCandlesForDisplay(candles, '15m');

  const firstAlert = mkAlert(dayStart, 1000); // exact first candle
  const lastAlert = mkAlert(dayStart + 9 * FIFTEEN_MIN(), 1009); // exact last candle
  const r = R.reconcileChartMarkers([firstAlert, lastAlert], candles, displayCandles, '15m');

  assert('both boundary alerts mapped', r.mappedCount === 2);
  assert('none excluded', r.outsideRangeCount === 0);
  assert('first alert maps to the first candle', r.groups.some(g => g.timestamp === dayStart));
  assert('last alert maps to the last candle', r.groups.some(g => g.timestamp === dayStart + 9 * FIFTEEN_MIN()));
})();

section('reconcileChartMarkers: multiple alerts sharing one 1H candle are grouped, not dropped');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 8; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i)); // 2 hours
  const displayCandles = R.resampleCandlesForDisplay(candles, '1h');

  // 3 alerts (different zones) all inside the FIRST hour (candles 0-3)
  const alerts = [
    mkAlert(dayStart + 0 * FIFTEEN_MIN(), 1000, { zoneId: 'zone-a' }),
    mkAlert(dayStart + 1 * FIFTEEN_MIN(), 1001, { zoneId: 'zone-b' }),
    mkAlert(dayStart + 3 * FIFTEEN_MIN(), 1003, { zoneId: 'zone-c' }),
    // 1 alert in the second hour, alone
    mkAlert(dayStart + 4 * FIFTEEN_MIN(), 1004, { zoneId: 'zone-a' }),
  ];
  const r = R.reconcileChartMarkers(alerts, candles, displayCandles, '1h');

  assert('all 4 alerts mapped', r.mappedCount === 4);
  assert('none excluded', r.outsideRangeCount === 0);
  assert('exactly 2 groups (one per hour)', r.groups.length === 2);
  const hour0 = r.groups.find(g => g.timestamp === dayStart);
  const hour1 = r.groups.find(g => g.timestamp === dayStart + HOUR_MS);
  assert('first hour group has all 3 alerts', hour0 && hour0.alerts.length === 3);
  assert('second hour group has the 1 remaining alert', hour1 && hour1.alerts.length === 1);
  assert('groupedAlertCount counts only alerts in groups of 2+ (the 3, not the lone 1)', r.groupedAlertCount === 3);
  assert('grouped alerts keep their own distinct raw timestamps/prices (not overwritten)', hour0.alerts.map(a => a.price).sort().join(',') === '1000,1001,1003');
})();

section('reconcileChartMarkers: multiple alerts sharing one 4H candle are grouped, not dropped');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 32; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i)); // 8 hours
  const displayCandles = R.resampleCandlesForDisplay(candles, '4h');

  // 4 alerts scattered across the first 4h bucket (candles 0-15), 1 in the second
  const alerts = [
    mkAlert(dayStart + 0 * FIFTEEN_MIN(), 1000, { zoneId: 'zone-a' }),
    mkAlert(dayStart + 5 * FIFTEEN_MIN(), 1005, { zoneId: 'zone-b' }),
    mkAlert(dayStart + 10 * FIFTEEN_MIN(), 1010, { zoneId: 'zone-c' }),
    mkAlert(dayStart + 15 * FIFTEEN_MIN(), 1015, { zoneId: 'zone-d' }),
    mkAlert(dayStart + 20 * FIFTEEN_MIN(), 1020, { zoneId: 'zone-a' }),
  ];
  const r = R.reconcileChartMarkers(alerts, candles, displayCandles, '4h');

  assert('all 5 alerts mapped', r.mappedCount === 5);
  assert('exactly 2 groups (one per 4h bucket)', r.groups.length === 2);
  const bucket0 = r.groups.find(g => g.timestamp === dayStart);
  assert('first 4h bucket has all 4 scattered alerts', bucket0 && bucket0.alerts.length === 4);
  assert('groupedAlertCount reflects the 4-alert group only', r.groupedAlertCount === 4);
})();

section('reconcileChartMarkers: an alert outside the loaded candle range is explicitly excluded with a reason');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i));
  const displayCandles = R.resampleCandlesForDisplay(candles, '15m');

  const inRange = mkAlert(dayStart + 3 * FIFTEEN_MIN(), 1003);
  const beforeRange = mkAlert(dayStart - HOUR_MS, 999); // well before the first candle
  const afterRange = mkAlert(dayStart + 100 * FIFTEEN_MIN(), 1100); // well after the last candle
  const r = R.reconcileChartMarkers([inRange, beforeRange, afterRange], candles, displayCandles, '15m');

  assert('only the in-range alert is mapped', r.mappedCount === 1);
  assert('both out-of-range alerts are excluded', r.outsideRangeCount === 2);
  assert('excluded list has an explicit reason for each', r.excluded.every(x => typeof x.reason === 'string' && x.reason.length > 0));
  assert('excluded entries retain the original alert object', r.excluded.every(x => x.alert && typeof x.alert.timestamp === 'number'));
  assert('reason correctly identifies "before range"/"after range" as the same raw-range-exclusion reason', r.excluded.every(x => x.reason === 'OUTSIDE_RAW_CANDLE_RANGE'));
})();

section('reconcileChartMarkers: reconciliation invariant — mapped + excluded === total, always');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const candles = [];
  for (let i = 0; i < 40; i++) candles.push(mkCandle(dayStart + i * FIFTEEN_MIN(), 1000 + i));
  const displayCandles4h = R.resampleCandlesForDisplay(candles, '4h');

  const alerts = [
    mkAlert(dayStart + 0 * FIFTEEN_MIN(), 1000),
    mkAlert(dayStart + 1 * FIFTEEN_MIN(), 1001),
    mkAlert(dayStart + 2 * FIFTEEN_MIN(), 1002),
    mkAlert(dayStart + 20 * FIFTEEN_MIN(), 1020),
    mkAlert(dayStart - HOUR_MS, 998), // out of range
    mkAlert(dayStart + 500 * FIFTEEN_MIN(), 1500), // out of range
  ];

  ['15m', '1h', '4h', '1d'].forEach(tf => {
    const dc = R.resampleCandlesForDisplay(candles, tf);
    const r = R.reconcileChartMarkers(alerts, candles, dc, tf);
    assert(`[${tf}] mappedCount + outsideRangeCount === totalAlerts`, r.mappedCount + r.outsideRangeCount === r.totalAlerts);
    assert(`[${tf}] totalAlerts matches input length`, r.totalAlerts === alerts.length);
    const groupSum = r.groups.reduce((s, g) => s + g.alerts.length, 0);
    assert(`[${tf}] sum of group sizes equals mappedCount (no alert lost or duplicated across groups)`, groupSum === r.mappedCount);
  });

  assert('unused var silences lint (displayCandles4h referenced)', Array.isArray(displayCandles4h));
})();

section('reconcileChartMarkers: empty/garbage input never throws');
(function () {
  const r1 = R.reconcileChartMarkers([], [], [], '15m');
  assert('no alerts -> all zeros, empty groups', r1.totalAlerts === 0 && r1.mappedCount === 0 && r1.outsideRangeCount === 0 && r1.groups.length === 0);
  const r2 = R.reconcileChartMarkers(null, null, null, '15m');
  assert('null inputs -> no throw, all zeros', r2.totalAlerts === 0 && r2.mappedCount === 0);
})();

section('formatChartMarkerDiagnosticLine: exact required format');
(function () {
  const line = R.formatChartMarkerDiagnosticLine({ mappedCount: 8, totalAlerts: 10, outsideRangeCount: 2, groupedAlertCount: 3 });
  assert('matches the exact required format', line === 'Chart markers: 8/10 alerts mapped &middot; 2 outside visible range &middot; 3 grouped into shared candles');
})();

section('describeChartLibLoadFailure: reports every source attempted with its outcome');
(function () {
  const msg = R.describeChartLibLoadFailure([
    { url: 'js/vendor/klinecharts-9.8.10.min.js', ok: false },
    { url: 'https://cdn.jsdelivr.net/npm/klinecharts@9.8.10/dist/umd/klinecharts.min.js', ok: false },
    { url: 'https://unpkg.com/klinecharts@9.8.10/dist/umd/klinecharts.min.js', ok: false },
  ]);
  assert('mentions all 3 sources tried', msg.includes('3 source(s)'));
  assert('includes the local vendor path', msg.includes('js/vendor/klinecharts-9.8.10.min.js'));
  assert('includes the jsdelivr URL', msg.includes('cdn.jsdelivr.net'));
  assert('includes the unpkg URL', msg.includes('unpkg.com'));
  assert('marks failures as FAILED', (msg.match(/FAILED/g) || []).length === 3);
})();

section('describeChartLibLoadFailure: empty/garbage input never throws');
(function () {
  assert('empty array -> explanatory fallback message, no throw', R.describeChartLibLoadFailure([]).length > 0);
  assert('null -> explanatory fallback message, no throw', R.describeChartLibLoadFailure(null).length > 0);
})();


section('CAUSE_STYLES / causeBadgeHtml: all four alert causes have a distinct, valid style');
(function () {
  const causes = ['V1_EXHAUSTION', 'V2_EXHAUSTION', 'DOWNSIDE_OI_CHASE', 'UPSIDE_OI_CHASE'];
  causes.forEach(c => assert(c + ' has a defined style', !!R.CAUSE_STYLES[c]));
  const colors = causes.map(c => R.CAUSE_STYLES[c].color);
  assert('all 4 causes use distinct colors (no two causes look alike)', new Set(colors).size === 4);
  causes.forEach(c => {
    const html = R.causeBadgeHtml(c);
    assert(c + ' badge includes its own color', html.includes(R.CAUSE_STYLES[c].color));
    assert(c + ' badge includes its own label', html.includes(R.CAUSE_STYLES[c].label));
  });
})();

section('causeBadgeHtml: unknown/missing cause degrades gracefully rather than throwing');
(function () {
  assert('unknown cause renders as plain text, not a styled badge', !R.causeBadgeHtml('SOMETHING_ELSE').includes('oix-ctx-badge'));
  assert('null cause does not throw and shows a placeholder', R.causeBadgeHtml(null).includes('—'));
})();


section('portable raw-data pack: export/import preserves usable derived data and excludes credentials');
(function () {
  const start = 1750000000000;
  const end = start + 2 * 15 * 60 * 1000;
  const raw = {
    startTime: start,
    endTime: end,
    lookbackDays: 30,
    cryptoHftApiKey: 'must-never-export',
    binanceCandles: [
      { ts: start, open: 100, high: 102, low: 99, close: 101 },
      { ts: start + 15 * 60 * 1000, open: 101, high: 104, low: 100, close: 103 },
      { ts: end, open: 103, high: 105, low: 102, close: 104 },
    ],
    oiRows: [
      { ts: start, oi: 1000 },
      { ts: start + 15 * 60 * 1000, oi: 1010 },
      { ts: end, oi: 1020 },
    ],
    coverage: { completeBuckets: 3, totalBucketsSeen: 3, venuesSeen: ['binance_futures', 'bybit', 'okx_futures'] },
  };
  const pack = R.createRawDataPack(raw);
  const serialized = JSON.stringify(pack);
  const imported = R.parseRawDataPack(serialized);
  assert('pack uses the expected schema and version', pack.schema === R.RAW_DATA_PACK_SCHEMA && pack.version === R.RAW_DATA_PACK_VERSION);
  assert('pack does not serialize an API key from the raw-cache object', !serialized.includes('must-never-export') && !serialized.includes('cryptoHftApiKey'));
  assert('import preserves declared coverage range', imported.startTime === start && imported.endTime === end);
  assert('import preserves Binance candles', imported.binanceCandles.length === 3 && imported.binanceCandles[2].close === 104);
  assert('import preserves aggregate OI rows', imported.oiRows.length === 3 && imported.oiRows[1].oi === 1010);
  assert('import marks data as imported-pack', imported.source === 'imported-pack');
  assert('pack filename is BTCUSDT JSON', R.rawDataPackFilename(raw).startsWith('oix-btcusdt-15m-') && R.rawDataPackFilename(raw).endsWith('.json'));
})();

section('portable raw-data pack: rejects wrong schema, malformed JSON, and invalid rows');
(function () {
  let malformed = false;
  try { R.parseRawDataPack('{bad json'); } catch (e) { malformed = /valid JSON/.test(e.message); }
  assert('malformed JSON is rejected clearly', malformed);
  let wrongSchema = false;
  try { R.parseRawDataPack({ schema: 'other', version: 1 }); } catch (e) { wrongSchema = /compatible/.test(e.message); }
  assert('wrong schema is rejected clearly', wrongSchema);
  let invalidRow = false;
  try {
    R.parseRawDataPack({
      schema: R.RAW_DATA_PACK_SCHEMA,
      version: R.RAW_DATA_PACK_VERSION,
      symbol: 'BTCUSDT', bucketMs: R.CHART_INTERVAL_MS,
      data: { startTime: 1, endTime: 2, binanceCandles: [{ ts: 1, open: 1, high: 1, low: 1, close: 'bad' }], oiRows: [{ ts: 1, oi: 1 }] },
    });
  } catch (e) { invalidRow = /invalid Binance candle/.test(e.message); }
  assert('invalid candle row is rejected', invalidRow);
})();

section('portable raw-data pack: deduplicates and sorts imported rows without accepting out-of-range data');
(function () {
  const t = 1750000000000;
  const pack = {
    schema: R.RAW_DATA_PACK_SCHEMA,
    version: R.RAW_DATA_PACK_VERSION,
    symbol: 'BTCUSDT', bucketMs: R.CHART_INTERVAL_MS,
    data: {
      startTime: t,
      endTime: t + 15 * 60 * 1000,
      binanceCandles: [
        { ts: t + 15 * 60 * 1000, open: 2, high: 3, low: 1, close: 2 },
        { ts: t, open: 1, high: 2, low: 0.5, close: 1.5 },
        { ts: t, open: 1, high: 2.1, low: 0.5, close: 1.6 },
        { ts: t + 30 * 60 * 1000, open: 3, high: 4, low: 2, close: 3 },
      ],
      oiRows: [
        { ts: t + 15 * 60 * 1000, oi: 20 }, { ts: t, oi: 10 }, { ts: t, oi: 11 }, { ts: t + 30 * 60 * 1000, oi: 30 },
      ],
    },
  };
  const imported = R.parseRawDataPack(pack);
  assert('out-of-range rows are removed on import', imported.binanceCandles.length === 2 && imported.oiRows.length === 2);
  assert('remaining rows are sorted ascending', imported.binanceCandles[0].ts === t && imported.oiRows[0].ts === t);
  assert('duplicate timestamps are deterministically last-write-wins', imported.binanceCandles[0].close === 1.6 && imported.oiRows[0].oi === 11);
})();

// ── main/staging two-key cache persistence ───────────────────────────────
// Simulated store: exactly how the orchestration uses IndexedDB — a plain
// key -> entry map with put(entry) keyed by entry.key and delete(key).

section('staging cache #1: complete cache exists -> a NEW fetch starts -> the complete entry remains available (staged writes never touch the main key)');
(function () {
  const IdbCache = require('./oi-exhaustion-idb-cache.js');
  const VENUES = ['binance_futures', 'bybit', 'okx'];
  const mainKey = IdbCache.buildCacheKey({ venues: VENUES, bucketMs: 900000 });
  const stagingKey = R.stagingCacheKeyFor(mainKey);
  const store = {};
  const complete = {
    key: mainKey, status: 'complete', startTime: 1000, endTime: 2000,
    binanceCandles: [{ ts: 1000 }], aggregateOI: [{ ts: 1000, oi: 1 }],
    perVenueOI: { binance_futures: [{ ts: 1000, oi: 1 }], bybit: [{ ts: 1000, oi: 1 }], okx: [{ ts: 1000, oi: 1 }] },
  };
  store[mainKey] = complete;
  // New non-servable request (head before the cache) -> full_fetch, staged working entry
  const decision = R.resolveCryptoHFTCacheDecision(store[mainKey], true, store[stagingKey] || null, 500, 2000);
  assert('decision is full_fetch (main cannot serve, no staging)', decision.action === 'full_fetch' && decision.source === null);
  const working = IdbCache.makeEmptyEntry(stagingKey, { startTime: 500, endTime: 2000 });
  store[working.key] = working; // every in-progress put lands on the staging key
  assert('staging key differs from main key', stagingKey !== mainKey);
  assert('main complete entry is untouched by starting the fetch', store[mainKey] === complete && IdbCache.isCacheEntryComplete(store[mainKey], VENUES));
})();

section('staging cache #2: new fetch is interrupted -> reload -> the prior complete cache is still used (contained_slice / tail_refresh from main)');
(function () {
  const IdbCache = require('./oi-exhaustion-idb-cache.js');
  const mainKey = 'oix_v1_test_900000_na';
  const stagingKey = R.stagingCacheKeyFor(mainKey);
  const complete = { key: mainKey, status: 'complete', startTime: 1000, endTime: 2000 };
  const interruptedStaging = { key: stagingKey, status: 'pending', startTime: 900, endTime: 2100, perVenueOI: {} };
  // Reload: identical request fully inside the complete range
  const d1 = R.resolveCryptoHFTCacheDecision(complete, true, interruptedStaging, 1200, 1900);
  assert('contained request served from main despite interrupted staging', d1.action === 'contained_slice' && d1.source === 'main');
  // Reload a bit later: end drifted forward -> tail_refresh from main, still not full_fetch
  const d2 = R.resolveCryptoHFTCacheDecision(complete, true, interruptedStaging, 1000, 2000 + 15 * 60 * 1000);
  assert('drifted-end request is a tail_refresh from main, never a full refetch', d2.action === 'tail_refresh' && d2.source === 'main');
})();

section('staging cache #3: a successful new fetch atomically replaces the prior complete cache (single put on main key, then staging deleted)');
(function () {
  const IdbCache = require('./oi-exhaustion-idb-cache.js');
  const VENUES = ['binance_futures', 'bybit', 'okx'];
  const mainKey = IdbCache.buildCacheKey({ venues: VENUES, bucketMs: 900000 });
  const stagingKey = R.stagingCacheKeyFor(mainKey);
  const store = {};
  store[mainKey] = { key: mainKey, status: 'complete', startTime: 1000, endTime: 2000, binanceCandles: [{ ts: 1000 }], aggregateOI: [{ ts: 1000, oi: 1 }], perVenueOI: { binance_futures: [{ ts: 1000, oi: 1 }], bybit: [{ ts: 1000, oi: 1 }], okx: [{ ts: 1000, oi: 1 }] } };
  const working = { key: stagingKey, status: 'pending', startTime: 500, endTime: 3000, perVenueOI: { binance_futures: [{ ts: 500, oi: 2 }], bybit: [{ ts: 500, oi: 2 }], okx: [{ ts: 500, oi: 2 }] } };
  store[stagingKey] = working;
  const promoted = R.buildPromotedCompleteEntry(working, mainKey, {
    startTime: 500, endTime: 3000,
    binanceCandles: [{ ts: 500 }, { ts: 2900 }],
    aggregateOI: [{ ts: 500, oi: 2 }, { ts: 2900, oi: 3 }],
    coverage: { completeBuckets: 2 },
  });
  store[promoted.key] = promoted; // the single atomic put
  delete store[stagingKey];        // only after the put succeeded
  assert('promoted entry landed on the main key', store[mainKey] === promoted && promoted.key === mainKey);
  assert('promoted entry is a valid complete entry', IdbCache.isCacheEntryComplete(store[mainKey], VENUES));
  assert('promoted entry carries the new range', store[mainKey].startTime === 500 && store[mainKey].endTime === 3000);
  assert('staging entry removed after promotion', store[stagingKey] === undefined);
})();

section('staging cache #4: a pending entry NEVER causes a valid completed entry to be ignored (even an exact-range resume candidate)');
(function () {
  const complete = { key: 'k', status: 'complete', startTime: 1000, endTime: 2000 };
  // Staging pending entry exactly matches the request — main still wins.
  const staging = { key: 'k_staging', status: 'pending', startTime: 1200, endTime: 1900 };
  const d = R.resolveCryptoHFTCacheDecision(complete, true, staging, 1200, 1900);
  assert('main complete entry outranks an exact-range pending staging entry', d.action === 'contained_slice' && d.source === 'main');
  // And when main truly cannot serve, staging resume is only used on an exact range match.
  const d2 = R.resolveCryptoHFTCacheDecision(complete, true, { key: 'k_staging', status: 'pending', startTime: 500, endTime: 2500 }, 500, 2500);
  assert('staging resume used only when main cannot serve and range matches exactly', d2.action === 'resume' && d2.source === 'staging');
  const d3 = R.resolveCryptoHFTCacheDecision(null, false, { key: 'k_staging', status: 'pending', startTime: 500, endTime: 2500 }, 400, 2500);
  assert('non-matching staging range falls to full_fetch, never a bogus resume', d3.action === 'full_fetch');
})();

(async () => {
  await Promise.all(asyncTests);
  console.log('\n────────────────────────────────────────');
  console.log('oi-exhaustion-render: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();

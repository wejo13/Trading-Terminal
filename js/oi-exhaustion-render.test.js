// oi-exhaustion-render.test.js — UI-independent logic only (no DOM, no network).
'use strict';

const R = require('./oi-exhaustion-render.js');

let passed = 0, failed = 0;
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

// ── summary ───────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-render: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

// oi-exhaustion-engine.test.js — pure math/state-machine tests, no network.
'use strict';

const E = require('./oi-exhaustion-engine.js');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 1e-9); }
function section(name) { console.log('\n' + name); }

const FIVE_MIN = 5 * 60 * 1000;
const T0 = 1750000000000;

// ── computeExhaustionReading ────────────────────────────────────────────────

section('computeExhaustionReading: hand-computed example');
(function () {
  // close 100 -> 102 (+2%), oi 1000 -> 1050 (+5%)
  const r = E.computeExhaustionReading(100, 102, 1000, 1050);
  assert('priceMovePct = 2', approx(r.priceMovePct, 2));
  assert('oiChangePct = 5', approx(r.oiChangePct, 5));
  assert('exhaustionReading = 5 - 2 = 3', approx(r.exhaustionReading, 3));
})();

section('computeExhaustionReading: signed OI change matters, price move is abs');
(function () {
  // price falls 2%, OI falls 1% -> reading = -1 - 2 = -3
  const r = E.computeExhaustionReading(100, 98, 1000, 990);
  assert('priceMovePct is abs (2, not -2)', approx(r.priceMovePct, 2));
  assert('oiChangePct is signed (-1)', approx(r.oiChangePct, -1));
  assert('exhaustionReading = -1 - 2 = -3', approx(r.exhaustionReading, -3));
})();

section('computeExhaustionReading: guards against zero/invalid denominators');
(function () {
  assert('prevClose = 0 -> null', E.computeExhaustionReading(0, 100, 1000, 1000) === null);
  assert('prevOI = 0 -> null', E.computeExhaustionReading(100, 100, 0, 1000) === null);
  assert('NaN input -> null', E.computeExhaustionReading(100, NaN, 1000, 1000) === null);
  assert('undefined input -> null', E.computeExhaustionReading(100, undefined, 1000, 1000) === null);
})();

// ── computeExhaustionSeries: window boundaries ──────────────────────────────

section('computeExhaustionSeries: no score before window fills (off-by-one)');
(function () {
  const n = 150;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = Array.from({ length: n }, () => 100);
  const ois = Array.from({ length: n }, () => 1000);
  const series = E.computeExhaustionSeries(timestamps, closes, ois);

  assert('index 143 (144th candle, 0-indexed) invalid — window not yet full', series[143].valid === false);
  assert('index 144 valid — exactly 144 readings available', series[144].valid === true);
  assert('flat price/OI series scores exactly 0', approx(series[144].score, 0));
})();

section('computeExhaustionSeries: hand-computed score over a small constant-delta window');
(function () {
  // Build exactly 144 readings each with reading = 3 (from the hand example above),
  // by holding price +2%/oi +5% every candle. Score should be mean = 3.
  const n = 145;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    closes.push(closes[i - 1] * 1.02);
    ois.push(ois[i - 1] * 1.05);
  }
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  assert('score at index 144 ≈ 3 (5% - 2%)', approx(series[144].score, 3, 1e-6));
})();

section('computeExhaustionSeries: invalid candle inside window invalidates whole score (strict gap policy)');
(function () {
  const n = 220;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = Array.from({ length: n }, () => 100);
  const ois = Array.from({ length: n }, () => 1000);
  const validFlags = Array.from({ length: n }, () => true);
  validFlags[70] = false; // one bad candle inside the window ending at 144

  const series = E.computeExhaustionSeries(timestamps, closes, ois, { validFlags });
  assert('score at 144 invalidated by the gap at index 70', series[144].valid === false);
  // once the bad candle rolls out of the trailing window, scores should resume
  assert('score at 215 valid again once gap has rolled out', series[215].valid === true);
})();

// ── computeChangeOverCandles / linearRegressionSlope (pure helpers) ────────

section('computeChangeOverCandles: hand-computed signed percent change');
(function () {
  const values = [100, 100, 100, 100, 100, 110]; // index 5 vs index 0 (5 candles back)
  assert('5-candle-back change = +10%', approx(E.computeChangeOverCandles(values, 5, 5), 10, 1e-9));
})();

section('computeChangeOverCandles: guards out-of-range lookback and zero base');
(function () {
  assert('lookback before array start -> null', E.computeChangeOverCandles([1, 2, 3], 1, 5) === null);
  assert('zero base value -> null', E.computeChangeOverCandles([0, 5], 1, 1) === null);
})();

section('linearRegressionSlope: perfectly linear series gives exact slope');
(function () {
  const values = [10, 20, 30, 40, 50, 60]; // slope = 10 per step
  assert('slope over full 6-point window = 10', approx(E.linearRegressionSlope(values, 5, 6), 10, 1e-9));
})();

section('linearRegressionSlope: flat series gives slope 0; declining series gives negative slope');
(function () {
  const flat = [5, 5, 5, 5, 5];
  assert('flat series slope = 0', approx(E.linearRegressionSlope(flat, 4, 5), 0, 1e-9));
  const declining = [50, 40, 30, 20, 10];
  assert('declining series slope < 0', E.linearRegressionSlope(declining, 4, 5) < 0);
})();

section('linearRegressionSlope: window not fully available -> null');
(function () {
  assert('insufficient history -> null', E.linearRegressionSlope([1, 2, 3], 2, 5) === null);
})();

// ── OI-recency diagnostic fields on computeExhaustionSeries ────────────────

section('computeExhaustionSeries: OI-recency fields computed correctly (hand-checked)');
(function () {
  const n = 150;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = Array.from({ length: n }, () => 100);
  const ois = Array.from({ length: n }, (_, i) => 1000 + i * 2); // steady linear OI growth, +2/candle
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  const s = series[144];

  assert('oiChange1hPct positive on rising OI', s.oiChange1hPct > 0);
  assert('oiChange4hPct > oiChange1hPct in magnitude (longer window, same steady growth)', s.oiChange4hPct > s.oiChange1hPct);
  assert('oiSlopeRecent is positive and close to the known per-candle increment (2)', approx(s.oiSlopeRecent, 2, 1e-9));
  assert('priceChange1hPct is 0 on flat price', approx(s.priceChange1hPct, 0, 1e-9));
})();

// ── REGRESSION FIXTURE: OI built earlier, stalled/declining in the final
// hour, price breaks lower late — netProgressScore stays positive, but the
// OI-recency filter must reject it (this is exactly the June 30 00:40 case).

section('OI-RECENCY REGRESSION FIXTURE: netProgressScore positive, but recent OI has stalled/declined and price just broke lower');
(function () {
  const n = 145;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [];
  const ois = [];
  let close = 100, oi = 1000;
  for (let i = 0; i < n; i++) {
    closes.push(close);
    ois.push(oi);
    if (i < 132) {
      // first ~11h: OI builds strongly, price drifts gently
      oi *= 1.01;
      close *= 1.0002;
    } else {
      // final 1h (last 12 candles): OI stalls/declines, price breaks lower
      oi *= 0.999;
      close *= 0.9975; // ~-3% per candle compounding over the final hour
    }
  }
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  const s = series[144];

  assert('netProgressScore is positive (large earlier OI build still dominates net-12h view)', s.netProgressScore > 0);
  assert('oiSlopeRecent (last 1h) is negative — OI is no longer expanding right now', s.oiSlopeRecent < 0);
  assert('oiChange1hPct is negative — OI declined over the last hour specifically', s.oiChange1hPct < 0);
  assert('priceChange1hPct is negative — price broke lower in that same final hour', s.priceChange1hPct < 0);
  assert('oiChange12hPct (whole window) is still strongly positive, unlike the last-hour view', s.oiChange12hPct > 0);
})();

section('computeExhaustionSeries: 12h diagnostics computed correctly');
(function () {
  const n = 145;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = Array.from({ length: n }, (_, i) => 100 + i); // rising
  const ois = Array.from({ length: n }, (_, i) => 1000 + i * 2); // rising
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  const s = series[144];
  assert('priceChange12hPct positive for rising price', s.priceChange12hPct > 0);
  assert('oiChange12hPct positive for rising OI', s.oiChange12hPct > 0);
  assert('direction12h = up', s.direction12h === 'up');
  assert('priceTravel12hAbsPct > 0', s.priceTravel12hAbsPct > 0);
})();

// ── netProgressScore / priceChopRatio (diagnostic-only, does not affect score) ──

section('netProgressScore: hand-computed, matches oiChange12hPct - abs(priceChange12hPct)');
(function () {
  const n = 145;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = Array.from({ length: n }, (_, i) => 100 + i); // net +44 over the window
  const ois = Array.from({ length: n }, (_, i) => 1000 + i * 5); // net OI up more, proportionally
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  const s = series[144];
  assert('netProgressScore equals oiChange12hPct - |priceChange12hPct|', approx(s.netProgressScore, s.oiChange12hPct - Math.abs(s.priceChange12hPct), 1e-9));
  assert('netPriceMove12hPct equals abs(priceChange12hPct)', approx(s.netPriceMove12hPct, Math.abs(s.priceChange12hPct), 1e-9));
})();

section('CHOPPY-BUT-FLAT FIXTURE: strictPathScore negative, netProgressScore positive, same window');
(function () {
  // Construct a 144-candle window where price oscillates up/down every
  // candle (lots of path length) but ends almost exactly where it started
  // (near-zero net displacement), while OI grows steadily throughout.
  // strictPathScore penalizes the large cumulative |5m move| every candle;
  // netProgressScore only sees the (near-zero) net 12h price change, so OI
  // growth dominates and it comes out positive. This is the core scenario
  // WEJO flagged strictPathScore as blind to.
  const n = 145;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    // alternate +3% / -3% roughly, so consecutive moves largely cancel,
    // leaving price choppy but close to flat over the full window
    const wiggle = (i % 2 === 0) ? 1.03 : (1 / 1.03);
    closes.push(closes[i - 1] * wiggle);
    ois.push(ois[i - 1] * 1.002); // steady OI growth throughout, ~34% over 144 candles
  }
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  const s = series[144];

  assert('price ended up choppy but close to its starting point (small net move)', Math.abs(s.priceChange12hPct) < 5);
  assert('cumulative path length is large (lots of 5m chop)', s.priceTravel12hAbsPct > 100);
  assert('strictPathScore (score) is negative — the large path length dominates', s.score < 0);
  assert('netProgressScore is positive — OI growth outweighs the small NET price move', s.netProgressScore > 0);
  assert('priceChopRatio is large — cumulative travel far exceeds net displacement', s.priceChopRatio > E.DIAGNOSTIC_CHOP_RATIO_THRESHOLD);
})();

section('priceChopRatio: near-zero net move does not produce Infinity/NaN (epsilon floor holds)');
(function () {
  const n = 145;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    // perfectly alternating, exact round-trip -> net price move ~0
    closes.push(i % 2 === 0 ? 100 : 103);
    ois.push(ois[i - 1] * 1.001);
  }
  const series = E.computeExhaustionSeries(timestamps, closes, ois);
  const s = series[144];
  assert('priceChopRatio is finite, not Infinity', isFinite(s.priceChopRatio));
  assert('priceChopRatio is not NaN', !isNaN(s.priceChopRatio));
})();

// ── Baseline: percentile + z-score ──────────────────────────────────────────

section('createBaselineLog: percentileRank against a known distribution (mean-rank, no ties)');
(function () {
  const log = E.createBaselineLog();
  for (let i = 1; i <= 100; i++) log.insert(i); // 1..100, all unique — mean-rank == naive rank here
  assert('percentile of 50 ≈ 49.5 (mean rank: 49 below + 0.5 tie)', approx(log.percentileRank(50), 49.5, 0.01));
  assert('percentile of 95 ≈ 94.5', approx(log.percentileRank(95), 94.5, 0.01));
  assert('percentile of 0 (below all) is 0', log.percentileRank(0) === 0);
  assert('percentile of 101 (above all) is 100', log.percentileRank(101) === 100);
})();

section('createBaselineLog: tie-safe percentile — flat baseline must NOT rank a matching value at 100');
(function () {
  const log = E.createBaselineLog();
  for (let i = 0; i < 200; i++) log.insert(0); // flat baseline of all zeros
  const p = log.percentileRank(0);
  assert('flat baseline + matching value ranks at 50, not 100', approx(p, 50, 0.01));
})();

section('createBaselineLog: empty log returns null percentile');
(function () {
  const log = E.createBaselineLog();
  assert('empty baseline percentile is null', log.percentileRank(5) === null);
  assert('empty baseline zScore is null', log.zScore(5) === null);
})();

section('createBaselineLog: trailing window evicts old scores past baselineLookbackCandles');
(function () {
  const log = E.createBaselineLog({ baselineLookbackCandles: 100 });
  log.insert(1000); // one extreme old value, will be evicted
  for (let i = 0; i < 100; i++) log.insert(1); // 100 more inserts pushes the extreme out (size caps at 100)
  assert('log size capped at lookback', log.size() === 100);
  // 1000 should have been evicted already — a query near it should not
  // reflect its presence at all (percentile of 1000 should be 100, but
  // more importantly it must not still count as an extra element)
  const p = log.percentileRank(1);
  assert('flat post-eviction baseline ranks its own value at 50 (extreme fell out)', approx(p, 50, 0.01));
})();

section('createBaselineLog: old extreme score no longer affects percentile once evicted (explicit before/after)');
(function () {
  const log = E.createBaselineLog({ baselineLookbackCandles: 50 });
  log.insert(9999); // extreme outlier, inserted first (oldest)
  for (let i = 0; i < 49; i++) log.insert(5); // fill to capacity (50 total) — outlier still present
  const beforeEviction = log.percentileRank(6);
  for (let i = 0; i < 5; i++) log.insert(5); // pushes 5 more, evicting the outlier (FIFO) plus 4 more 5s
  const afterEviction = log.percentileRank(6);
  assert('percentile of 6 rises once the 9999 outlier is evicted (query ranks higher among smaller numbers)', afterEviction > beforeEviction);
})();

section('createBaselineLog: zScore matches manual calculation');
(function () {
  const log = E.createBaselineLog();
  [2, 4, 4, 4, 5, 5, 7, 9].forEach(v => log.insert(v)); // mean=5, sample std=2.138...
  const mean = 5;
  const z = log.zScore(9);
  assert('zScore(9) is positive and finite', z > 0 && isFinite(z));
})();

// ── Zones ────────────────────────────────────────────────────────────────

section('isPriceInZone: inclusive boundaries');
(function () {
  const zone = { bottom: 100, top: 110, active: true };
  assert('price at bottom is inside (inclusive)', E.isPriceInZone(100, zone) === true);
  assert('price at top is inside (inclusive)', E.isPriceInZone(110, zone) === true);
  assert('price inside range', E.isPriceInZone(105, zone) === true);
  assert('price below range', E.isPriceInZone(99.9, zone) === false);
  assert('price above range', E.isPriceInZone(110.1, zone) === false);
  assert('inactive zone never contains price', E.isPriceInZone(105, { bottom: 100, top: 110, active: false }) === false);
})();

section('zoneRangeThird: lower/middle/upper classification');
(function () {
  const zone = { bottom: 0, top: 90 };
  assert('price at 10 -> lower', E.zoneRangeThird(10, zone) === 'lower');
  assert('price at 45 -> middle', E.zoneRangeThird(45, zone) === 'middle');
  assert('price at 80 -> upper', E.zoneRangeThird(80, zone) === 'upper');
})();

section('classifyContextDirection: sign mapping per locked decision');
(function () {
  assert('up move -> bearish-exhaustion', E.classifyContextDirection(2.5) === 'bearish-exhaustion');
  assert('down move -> bullish-exhaustion', E.classifyContextDirection(-2.5) === 'bullish-exhaustion');
  assert('flat -> neutral', E.classifyContextDirection(0) === 'neutral');
  assert('null input -> null', E.classifyContextDirection(null) === null);
})();

// ── State machine ────────────────────────────────────────────────────────

section('stepZoneState: no alert outside zone, regardless of percentile/score');
(function () {
  const r = E.stepZoneState(false, false, 99, false, 5);
  assert('armed stays false outside zone', r.armed === false);
  assert('no alert outside zone', r.alertFired === false);
})();

section('stepZoneState: entry fires only on false->true crossing (with positive score)');
(function () {
  const r1 = E.stepZoneState(false, true, 96, false, 2.5);
  assert('first candle above threshold with positive score fires alert', r1.alertFired === true && r1.armed === true);

  const r2 = E.stepZoneState(true, true, 97, false, 2.5); // still above threshold, already armed
  assert('staying above threshold does not re-fire', r2.alertFired === false && r2.armed === true);
})();

section('stepZoneState: rearm requires dropping below exit percentile (hysteresis)');
(function () {
  const midBand = E.stepZoneState(true, true, 85, false, 2.5); // between 80 and 95, armed
  assert('armed persists in hysteresis band', midBand.armed === true && midBand.alertFired === false);

  const rearmed = E.stepZoneState(true, true, 75, false, 2.5); // below 80
  assert('drops below rearm threshold', rearmed.armed === false);

  const refire = E.stepZoneState(false, true, 96, false, 2.5);
  assert('can fire again after rearm', refire.alertFired === true);
})();

section('stepZoneState: warmingUp suppresses alerts even if score would qualify');
(function () {
  const r = E.stepZoneState(false, true, 99, true, 5);
  assert('no alert while warming up', r.alertFired === false);
  assert('armed state held, not force-set', r.armed === false);
})();

section('stepZoneState: leaving zone resets armed immediately, independent of percentile/score');
(function () {
  const r = E.stepZoneState(true, false, 99, false, 5);
  assert('armed resets to false on zone exit', r.armed === false);
  assert('no alert on exit', r.alertFired === false);
})();

section('stepZoneState: null percentile treated like warming up (no alert, no crash)');
(function () {
  const r = E.stepZoneState(false, true, null, false, 5);
  assert('null percentile does not fire', r.alertFired === false);
})();

section('stepZoneState: score>0 qualification gate — high percentile alone is not enough');
(function () {
  const zeroScore = E.stepZoneState(false, true, 99, false, 0);
  assert('score of exactly 0 does not fire even at 99th percentile', zeroScore.alertFired === false);

  const negativeScore = E.stepZoneState(false, true, 99, false, -1.5);
  assert('negative score does not fire even at a high percentile', negativeScore.alertFired === false);

  const missingScore = E.stepZoneState(false, true, 99, false, undefined);
  assert('missing/non-numeric score does not fire, does not crash', missingScore.alertFired === false);

  const positiveScore = E.stepZoneState(false, true, 99, false, 0.01);
  assert('a genuinely positive score at high percentile still fires', positiveScore.alertFired === true);
})();

// ── Zone temporal validity ──────────────────────────────────────────────

section('isZoneTemporallyActive: availableAtTs / inactiveAtTs gating');
(function () {
  const zone = { active: true, availableAtTs: T0 + 100 * FIVE_MIN, inactiveAtTs: T0 + 200 * FIVE_MIN };
  assert('before availableAtTs -> not active', E.isZoneTemporallyActive(zone, T0) === false);
  assert('at availableAtTs -> active', E.isZoneTemporallyActive(zone, T0 + 100 * FIVE_MIN) === true);
  assert('between bounds -> active', E.isZoneTemporallyActive(zone, T0 + 150 * FIVE_MIN) === true);
  assert('at inactiveAtTs -> no longer active (exclusive upper bound)', E.isZoneTemporallyActive(zone, T0 + 200 * FIVE_MIN) === false);
  assert('after inactiveAtTs -> not active', E.isZoneTemporallyActive(zone, T0 + 300 * FIVE_MIN) === false);
})();

section('isZoneTemporallyActive: zones with no temporal bounds are always active (until active:false)');
(function () {
  const zone = { active: true };
  assert('no bounds set -> always active', E.isZoneTemporallyActive(zone, T0) === true && E.isZoneTemporallyActive(zone, T0 + 999999) === true);
  assert('active:false overrides regardless of temporal bounds', E.isZoneTemporallyActive({ active: false }, T0) === false);
})();

section('stepZoneState: additionalGatePassed=false blocks arming even when score/percentile otherwise qualify');
(function () {
  const blocked = E.stepZoneState(false, true, 99, false, 5, { additionalGatePassed: false });
  assert('arming blocked when additionalGatePassed is explicitly false', blocked.alertFired === false && blocked.armed === false);

  const allowed = E.stepZoneState(false, true, 99, false, 5, { additionalGatePassed: true });
  assert('arming proceeds when additionalGatePassed is explicitly true', allowed.alertFired === true);
})();

section('stepZoneState: additionalGatePassed defaults to true when omitted — no behavior change for existing callers');
(function () {
  const noOptsAtAll = E.stepZoneState(false, true, 99, false, 5);
  assert('omitting opts entirely still fires (default true)', noOptsAtAll.alertFired === true);

  const optsWithoutFlag = E.stepZoneState(false, true, 99, false, 5, { entryPercentile: 95, rearmPercentile: 80 });
  assert('opts present but flag omitted still fires (default true)', optsWithoutFlag.alertFired === true);
})();

section('stepZoneState: additionalGatePassed does not affect rearm/exit logic, only arming');
(function () {
  // Already armed, percentile drops below rearm threshold — should still
  // rearm normally regardless of additionalGatePassed, since that gate
  // only restricts NEW arming, not exit.
  const rearmed = E.stepZoneState(true, true, 70, false, 5, { rearmPercentile: 80, additionalGatePassed: false });
  assert('rearm still happens even with additionalGatePassed false', rearmed.armed === false);
})();

// ── summary ───────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-engine: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

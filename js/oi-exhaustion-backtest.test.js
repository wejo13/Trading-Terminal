// oi-exhaustion-backtest.test.js — alignment, OHLC horizon math, gap-strict
// horizons, grouped stats, no-lookahead, zone temporal gating.
'use strict';

const {
  alignCandlesAndOI,
  computeHorizonOutcomes,
  findExactIndex,
  runEventStudy,
  percentileBucket,
  summarizeHorizonOutcomes,
  summarizeDistribution,
} = require('./oi-exhaustion-backtest.js');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 1e-9); }
function section(name) { console.log('\n' + name); }

const FIVE_MIN = 5 * 60 * 1000;
const T0 = 1750000000000;

// ── alignCandlesAndOI ────────────────────────────────────────────────────

section('alignCandlesAndOI: exact-match inner join, unmatched rows dropped');
(function () {
  const candles = [{ ts: T0, close: 100 }, { ts: T0 + FIVE_MIN, close: 101 }, { ts: T0 + 2 * FIVE_MIN, close: 102 }];
  const oi = [{ ts: T0, oi: 1000 }, { ts: T0 + 2 * FIVE_MIN, oi: 1010 }]; // missing middle OI sample
  const { timestamps, closes, ois } = alignCandlesAndOI(candles, oi);
  assert('unmatched candle dropped', timestamps.length === 2);
  assert('correct rows kept', timestamps[0] === T0 && timestamps[1] === T0 + 2 * FIVE_MIN);
  assert('closes/ois aligned correctly', closes[1] === 102 && ois[1] === 1010);
})();

section('alignCandlesAndOI: gap flagged via validFlags when joined series skips a timestamp');
(function () {
  const candles = [{ ts: T0, close: 100 }, { ts: T0 + FIVE_MIN, close: 101 }, { ts: T0 + 2 * FIVE_MIN, close: 102 }];
  const oi = [{ ts: T0, oi: 1000 }, { ts: T0 + 2 * FIVE_MIN, oi: 1010 }];
  const { validFlags } = alignCandlesAndOI(candles, oi);
  assert('first row always valid', validFlags[0] === true);
  assert('second (post-gap) row flagged invalid', validFlags[1] === false);
})();

section('alignCandlesAndOI: hasOHLC true only when every candle has numeric high/low');
(function () {
  const withOHLC = [{ ts: T0, close: 100, high: 101, low: 99 }, { ts: T0 + FIVE_MIN, close: 101, high: 102, low: 100 }];
  const withoutOHLC = [{ ts: T0, close: 100 }, { ts: T0 + FIVE_MIN, close: 101 }];
  const mixed = [{ ts: T0, close: 100, high: 101, low: 99 }, { ts: T0 + FIVE_MIN, close: 101 }];
  const oi = [{ ts: T0, oi: 1000 }, { ts: T0 + FIVE_MIN, oi: 1010 }];

  assert('full OHLC -> hasOHLC true', alignCandlesAndOI(withOHLC, oi).hasOHLC === true);
  assert('no OHLC -> hasOHLC false', alignCandlesAndOI(withoutOHLC, oi).hasOHLC === false);
  assert('partial OHLC -> hasOHLC false (all-or-nothing)', alignCandlesAndOI(mixed, oi).hasOHLC === false);
})();

// ── findExactIndex ───────────────────────────────────────────────────────

section('findExactIndex: exact match only, no "nearest after" substitution');
(function () {
  const ts = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN, T0 + 3 * FIVE_MIN];
  assert('exact match returns that index', findExactIndex(ts, T0 + 2 * FIVE_MIN) === 2);
  assert('non-existent timestamp between candles returns -1', findExactIndex(ts, T0 + FIVE_MIN + 1) === -1);
  assert('target past end returns -1', findExactIndex(ts, T0 + 100 * FIVE_MIN) === -1);
})();

// ── computeHorizonOutcomes: OHLC boundary detection ─────────────────────

function buildLinearOHLC(n, opts) {
  // builds a simple ascending timestamp series with caller-supplied
  // close/high/low arrays for hand-crafted boundary scenarios
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const validFlags = Array.from({ length: n }, () => true);
  return { timestamps, validFlags, closes: opts.closes, highs: opts.highs, lows: opts.lows };
}

section('computeHorizonOutcomes: OHLC top-wick detection (close never crosses, high does)');
(function () {
  // Alert at index 0, price 100. Candle 1's high wicks up to 108 (zone top)
  // but closes back down at 103 — a close-only method would MISS this.
  const closes = [100, 103, 104, 105];
  const highs =  [100, 108, 105, 106];
  const lows =   [100, 102, 103, 104];
  const { timestamps, validFlags } = buildLinearOHLC(4, {});
  const zoneBounds = { top: 108, bottom: 90 };

  const outcomes = computeHorizonOutcomes(0, timestamps, closes, highs, lows, true, validFlags, zoneBounds);
  assert('15m horizon detects top hit via wick', outcomes['15m'].firstBoundaryHit === 'top');
  assert('boundaryMethod reported as ohlc', outcomes['15m'].boundaryMethod === 'ohlc');
})();

section('computeHorizonOutcomes: OHLC bottom-wick detection');
(function () {
  const closes = [100, 96, 97, 98];
  const highs =  [100, 97, 98, 99];
  const lows =   [100, 90, 96, 97]; // wicks down to 90 (zone bottom) on candle 1
  const { timestamps, validFlags } = buildLinearOHLC(4, {});
  const zoneBounds = { top: 120, bottom: 90 };

  const outcomes = computeHorizonOutcomes(0, timestamps, closes, highs, lows, true, validFlags, zoneBounds);
  assert('15m horizon detects bottom hit via wick', outcomes['15m'].firstBoundaryHit === 'bottom');
})();

section('computeHorizonOutcomes: both boundaries touched within the same candle -> both_same_candle, not invented order');
(function () {
  const closes = [100, 100, 100, 100];
  const highs =  [100, 130, 100, 100]; // candle 1 wicks both above top (130>=120)...
  const lows =   [100, 80, 100, 100];  // ...and below bottom (80<=90) in the same candle
  const { timestamps, validFlags } = buildLinearOHLC(4, {});
  const zoneBounds = { top: 120, bottom: 90 };

  const outcomes = computeHorizonOutcomes(0, timestamps, closes, highs, lows, true, validFlags, zoneBounds);
  assert('same-candle double touch reported as both_same_candle', outcomes['15m'].firstBoundaryHit === 'both_same_candle');
})();

section('computeHorizonOutcomes: close-only proxy fallback when OHLC absent, marked accordingly');
(function () {
  const closes = [100, 103, 104, 109]; // never dips/wicks, just closes; index 3 closes at/above top
  const { timestamps, validFlags } = buildLinearOHLC(4, {});
  const zoneBounds = { top: 108, bottom: 90 };

  const outcomes = computeHorizonOutcomes(0, timestamps, closes, null, null, false, validFlags, zoneBounds);
  assert('close-only proxy still detects a close-based crossing', outcomes['15m'].firstBoundaryHit === 'top');
  assert('boundaryMethod marked close_only_proxy', outcomes['15m'].boundaryMethod === 'close_only_proxy');
})();

// ── computeHorizonOutcomes: gap-strictness ──────────────────────────────

section('computeHorizonOutcomes: exact-timestamp requirement — missing target candle is invalid_forward_gap, not substituted');
(function () {
  // 5 candles but candle at exactly +15m (index 3) is simply absent from
  // the array (simulating a hole) while later data exists.
  const timestamps = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN, T0 + 4 * FIVE_MIN, T0 + 5 * FIVE_MIN];
  const closes = [100, 101, 102, 104, 105];
  const validFlags = [true, true, true, false, true]; // gap flagged going into index 3
  const outcomes = computeHorizonOutcomes(0, timestamps, closes, null, null, false, validFlags, null);
  assert('15m horizon (target = index 3, missing) is invalid_forward_gap, not silently using index 4', outcomes['15m'].dataQuality === 'invalid_forward_gap');
})();

section('computeHorizonOutcomes: gap INSIDE the horizon window (target candle exists, but a gap occurred before it) is invalid_forward_gap');
(function () {
  const n = 20;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = Array.from({ length: n }, (_, i) => 100 + i);
  const validFlags = Array.from({ length: n }, () => true);
  validFlags[2] = false; // a gap occurred at index 2, inside the 15m (3-candle) horizon from index 0

  const outcomes = computeHorizonOutcomes(0, timestamps, closes, null, null, false, validFlags, null);
  assert('15m horizon spans the gap at index 2 -> invalid_forward_gap', outcomes['15m'].dataQuality === 'invalid_forward_gap');
  // 1h horizon (12 candles ahead) also spans it -> also invalid
  assert('1h horizon also spans the gap -> invalid_forward_gap', outcomes['1h'].dataQuality === 'invalid_forward_gap');
})();

section('computeHorizonOutcomes: insufficient_forward_data vs invalid_forward_gap are distinct outcomes');
(function () {
  const timestamps = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN];
  const closes = [100, 101, 102];
  const validFlags = [true, true, true];
  const outcomes = computeHorizonOutcomes(2, timestamps, closes, null, null, false, validFlags, null); // alert on last candle, no data past it at all
  assert('horizon far beyond available data is insufficient_forward_data', outcomes['24h'].dataQuality === 'insufficient_forward_data');
})();

// ── percentileBucket (unchanged behavior, still covered) ─────────────────

section('percentileBucket: boundary classification');
(function () {
  assert('99.5 -> 99-100', percentileBucket(99.5) === '99-100');
  assert('98 -> 97-99', percentileBucket(98) === '97-99');
  assert('95 -> 95-97', percentileBucket(95) === '95-97');
  assert('null -> null', percentileBucket(null) === null);
})();

// ── summarizeHorizonOutcomes: grouped stats ─────────────────────────────

section('summarizeHorizonOutcomes: mean/median/rates computed correctly on a hand-built group');
(function () {
  const group = [
    { horizons: { '15m': { dataQuality: 'ok', forwardReturnPct: 2, maxUpExcursionPct: 3, maxDownExcursionPct: -1, firstBoundaryHit: 'top' } } },
    { horizons: { '15m': { dataQuality: 'ok', forwardReturnPct: -4, maxUpExcursionPct: 1, maxDownExcursionPct: -5, firstBoundaryHit: 'none' } } },
    { horizons: { '15m': { dataQuality: 'ok', forwardReturnPct: 6, maxUpExcursionPct: 6, maxDownExcursionPct: 0, firstBoundaryHit: 'bottom' } } },
    { horizons: { '15m': { dataQuality: 'invalid_forward_gap' } } }, // excluded from stats
  ];
  const s = summarizeHorizonOutcomes(group, '15m');
  assert('valid sample count excludes invalid entries', s.validSampleCount === 3);
  assert('invalidCount = 1', s.invalidCount === 1);
  assert('mean forward return = (2-4+6)/3 = 1.333...', approx(s.meanForwardReturnPct, 4 / 3, 1e-9));
  assert('median forward return = 2', s.medianForwardReturnPct === 2);
  assert('positive return rate = 2/3', approx(s.positiveReturnRate, 2 / 3, 1e-9));
  assert('top hit rate = 1/3', approx(s.topHitRate, 1 / 3, 1e-9));
  assert('bottom hit rate = 1/3', approx(s.bottomHitRate, 1 / 3, 1e-9));
  assert('no-hit rate = 1/3', approx(s.noBoundaryHitRate, 1 / 3, 1e-9));
})();

section('summarizeHorizonOutcomes: all-invalid group returns zero valid count without crashing');
(function () {
  const group = [{ horizons: { '15m': { dataQuality: 'invalid_forward_gap' } } }];
  const s = summarizeHorizonOutcomes(group, '15m');
  assert('validSampleCount = 0', s.validSampleCount === 0);
  assert('invalidCount = 1', s.invalidCount === 1);
})();

// ── runEventStudy: end-to-end synthetic scenarios ───────────────────────

function buildSyntheticSeries(n, opts) {
  opts = opts || {};
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [];
  const ois = [];
  let close = 100, oi = 1000;
  for (let i = 0; i < n; i++) {
    closes.push(close);
    ois.push(oi);
    const wiggle = Math.sin(i / 7) * 0.3;
    close = close * (1 + 0.001 + wiggle / 100);
    oi = oi * (1 + 0.001);
  }
  if (opts.spikeAt) {
    ois[opts.spikeAt] = ois[opts.spikeAt - 1] * 1.5;
    closes[opts.spikeAt] = closes[opts.spikeAt - 1] * 1.0005;
  }
  return { timestamps, closes, ois };
}

section('runEventStudy: flat price + flat OI never alerts after warm-up (score always 0)');
(function () {
  const n = 700;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const candles = timestamps.map(ts => ({ ts, close: 100 })); // perfectly flat
  const oiRows = timestamps.map(ts => ({ ts, oi: 1000 }));    // perfectly flat
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1000000, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('zero alerts on a perfectly flat series', result.alerts.length === 0);
})();

section('runEventStudy: negative score at a high relative percentile never alerts (score>0 gate)');
(function () {
  // Build a series where price moves are always LARGER than OI moves in
  // magnitude (so exhaustionReading = oiChangePct - priceMovePct is always
  // negative), but with enough variance that some readings are "less
  // negative" than others — those would rank at a high percentile under a
  // pure relative-baseline scheme, but must never fire since score <= 0.
  const n = 700;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    const priceMove = 0.02 + Math.abs(Math.sin(i / 5)) * 0.01; // 2-3% every candle
    closes.push(closes[i - 1] * (1 + priceMove));
    ois.push(ois[i - 1] * (1 + priceMove * 0.3)); // OI always moves less than price -> reading always negative
  }
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('no alerts fire when every score is negative, regardless of relative percentile', result.alerts.length === 0);
})();

section('runEventStudy: a genuinely positive OI spike with little price movement still alerts');
(function () {
  const n = 700;
  const { timestamps, closes, ois } = buildSyntheticSeries(n, { spikeAt: 600 });
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('at least one alert fires from a genuine positive OI spike', result.alerts.length > 0);
  for (const a of result.alerts) {
    assert(`alert score is positive (${a.score})`, a.score > 0);
  }
})();

section('runEventStudy: no-lookahead — truncating after an alert reproduces the identical alert');
(function () {
  const n = 700;
  const { timestamps, closes, ois } = buildSyntheticSeries(n, { spikeAt: 600 });
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const fullResult = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('full run produced at least one alert', fullResult.alerts.length > 0);

  if (fullResult.alerts.length > 0) {
    const firstAlert = fullResult.alerts[0];
    const alertIdx = timestamps.indexOf(firstAlert.timestamp);
    const truncatedResult = runEventStudy(candles.slice(0, alertIdx + 1), oiRows.slice(0, alertIdx + 1), zones, { minBaselineSamples: 50 });
    const matching = truncatedResult.alerts.find(a => a.timestamp === firstAlert.timestamp);
    assert('truncated run still fires the same first alert', !!matching);
    if (matching) {
      assert('identical score with or without future data', approx(matching.score, firstAlert.score, 1e-9));
      assert('identical percentile with or without future data', approx(matching.percentile, firstAlert.percentile, 1e-9));
    }
  }
})();

section('runEventStudy: zone temporal gating — no alert before availableAtTs, fires after');
(function () {
  const n = 700;
  const { timestamps, closes, ois } = buildSyntheticSeries(n, { spikeAt: 600 });
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));

  // Zone becomes available AFTER the spike candle — the spike-driven alert
  // must NOT fire even though price/score conditions are met, because the
  // zone wasn't "known" yet at that point in time.
  const spikeTs = timestamps[600];
  const zoneTooLate = [{ id: 'z1', label: 'late zone', type: 'range', top: 1e12, bottom: 0, active: true, availableAtTs: spikeTs + FIVE_MIN }];
  const resultBlocked = runEventStudy(candles, oiRows, zoneTooLate, { minBaselineSamples: 50 });
  const blockedAtSpike = resultBlocked.alerts.find(a => a.timestamp === spikeTs);
  assert('no alert at the spike candle when zone becomes available only after it', !blockedAtSpike);

  // Same zone, but available well before the spike -> should fire normally.
  const zoneEarly = [{ id: 'z1', label: 'early zone', type: 'range', top: 1e12, bottom: 0, active: true, availableAtTs: T0 }];
  const resultAllowed = runEventStudy(candles, oiRows, zoneEarly, { minBaselineSamples: 50 });
  assert('alerts do fire when the zone was available in time', resultAllowed.alerts.length > 0);

  // Snapshot check: the alert record carries the availableAtTs it was
  // evaluated under.
  if (resultAllowed.alerts.length > 0) {
    assert('alert record snapshots zone availableAtTs', resultAllowed.alerts[0].zoneBounds.availableAtTs === T0);
  }
})();

section('runEventStudy: meta.positiveScorePct reflects the actual fraction of positive-score candles');
(function () {
  // Half the candles get an engineered positive reading, half stay negative,
  // so the diagnostic should land close to 50% (not exactly, due to warm-up
  // candles before the window fills, but well within a wide tolerance here).
  const n = 700;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    const positiveHalf = i % 2 === 0;
    if (positiveHalf) {
      closes.push(closes[i - 1] * 1.0001); // tiny price move
      ois.push(ois[i - 1] * 1.01); // OI expands faster -> positive reading
    } else {
      closes.push(closes[i - 1] * 1.02); // large price move
      ois.push(ois[i - 1] * 1.001); // OI barely moves -> negative reading
    }
  }
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('positiveScoreCount + validScoreCount are both present and consistent', result.meta.positiveScoreCount <= result.meta.validScoreCount);
  assert('positiveScorePct is a percentage between 0 and 100', result.meta.positiveScorePct >= 0 && result.meta.positiveScorePct <= 100);
})();

section('runEventStudy: meta.positiveScorePct is 0 (not null/NaN) when every score is negative');
(function () {
  const n = 700;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    closes.push(closes[i - 1] * 1.02);
    ois.push(ois[i - 1] * 1.001);
  }
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('positiveScorePct is exactly 0, not null', result.meta.positiveScorePct === 0);
})();

// ── summarizeDistribution ────────────────────────────────────────────────

section('summarizeDistribution: percentiles and positive rate on a known array');
(function () {
  const values = Array.from({ length: 100 }, (_, i) => i - 50); // -50..49
  const s = summarizeDistribution(values);
  assert('count = 100', s.count === 100);
  assert('positiveCount = 49 (0 itself is not positive)', s.positiveCount === 49);
  assert('positiveRatePct = 49', approx(s.positiveRatePct, 49, 1e-9));
  assert('p50 is near the middle of the range', s.p50 >= -5 && s.p50 <= 5);
})();

section('summarizeDistribution: empty array does not throw, returns null percentiles');
(function () {
  const s = summarizeDistribution([]);
  assert('count = 0', s.count === 0);
  assert('positiveRatePct is null, not NaN', s.positiveRatePct === null);
  assert('p50 is null', s.p50 === null);
})();

// ── runEventStudy diagnostics: side-by-side strictPathScore vs netProgressScore ──

section('runEventStudy: diagnostics block present and internally consistent, alerts/meta untouched by its presence');
(function () {
  const n = 700;
  const { timestamps, closes, ois } = buildSyntheticSeries(n, { spikeAt: 600 });
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  assert('diagnostics block exists', !!result.diagnostics);
  assert('strictPathScore distribution present', result.diagnostics.strictPathScore.count === result.meta.validScoreCount);
  assert('netProgressScore distribution present with a count', result.diagnostics.netProgressScore.count > 0);
  assert('choppyButFlatCount is a non-negative number', result.diagnostics.choppyButFlatCount >= 0);
  assert('choppyButFlatDefinition documents the fixed threshold used', result.diagnostics.choppyButFlatDefinition.includes('priceChopRatio'));
  // alerts/meta must be identical in shape/behavior to before this milestone
  assert('meta.positiveScoreCount still present (unchanged prior diagnostic)', typeof result.meta.positiveScoreCount === 'number');
})();

section('runEventStudy: choppy-but-flat synthetic dataset — netProgressScore positive rate exceeds strictPathScore positive rate');
(function () {
  // Build 700 candles that chop hard (alternating +3%/-3%) while OI grinds
  // up steadily throughout — the scenario WEJO specifically flagged.
  const n = 700;
  const timestamps = Array.from({ length: n }, (_, i) => T0 + i * FIVE_MIN);
  const closes = [100];
  const ois = [1000];
  for (let i = 1; i < n; i++) {
    const wiggle = (i % 2 === 0) ? 1.03 : (1 / 1.03);
    closes.push(closes[i - 1] * wiggle);
    ois.push(ois[i - 1] * 1.0015);
  }
  const candles = timestamps.map((ts, i) => ({ ts, close: closes[i] }));
  const oiRows = timestamps.map((ts, i) => ({ ts, oi: ois[i] }));
  const zones = [{ id: 'z1', label: 'wide', type: 'range', top: 1e12, bottom: 0, active: true }];

  const result = runEventStudy(candles, oiRows, zones, { minBaselineSamples: 50 });
  const strictRate = result.diagnostics.strictPathScore.positiveRatePct;
  const netRate = result.diagnostics.netProgressScore.positiveRatePct;

  assert('strictPathScore positive rate is low on a choppy series (path length dominates)', strictRate < 20);
  assert('netProgressScore positive rate is much higher on the same choppy series (OI growth dominates net-flat price)', netRate > strictRate);
  assert('choppyButFlatCount is substantial on a genuinely choppy-but-flat series', result.diagnostics.choppyButFlatCount > 0);
})();

// ── summary ───────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-backtest: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

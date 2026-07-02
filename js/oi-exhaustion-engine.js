/**
 * oi-exhaustion-engine.js
 * Pure functions only — no fetch, no DOM, no localStorage. Powers both the
 * live module (later) and the event-study backtest, so detection logic is
 * identical in both places by construction.
 *
 * Locked design decisions (from prior review rounds):
 *  - priceMovePct uses close-to-close only (no high/low), abs value.
 *  - oiChangePct is signed.
 *  - score[t] = mean(exhaustionReading[t-143..t]) — 144-candle (12h) window.
 *  - Baseline/threshold: rolling percentile is the primary trigger; z-score
 *    is a diagnostic field only, never gates the alert.
 *  - Entry: percentile crosses from below to >= 95 (false -> true transition).
 *  - Rearm: percentile must drop below 80 before the zone can alert again.
 *  - Leaving a zone resets that zone's armed state immediately; re-entering
 *    starts clean.
 *  - Zone bounds are inclusive: bottom <= price <= top.
 *  - contextDirection: OI growth during an UP 12h move = 'bearish-exhaustion'
 *    (potential long-side crowding); OI growth during a DOWN 12h move =
 *    'bullish-exhaustion' (potential short-side crowding); flat = 'neutral'.
 *    This is context, not a trade direction.
 */
'use strict';

(function (root) {

  var SIGNAL_WINDOW = 144; // 12h of 5m candles

  // Trailing baseline window: 30 days of valid 5m scores. The baseline log
  // now evicts scores older than this many *valid* insertions — it is a
  // trailing window, not an ever-expanding history. This matches "calibrate
  // against the score's own trailing history."
  var DEFAULT_BASELINE_LOOKBACK_CANDLES = 8640; // 30d * 288/day

  // Minimum baseline sample count before alerts are eligible to fire at all.
  // Rationale: at the 95th percentile, reliably resolving that tail needs
  // enough samples that "top 5%" isn't just 1-2 noisy points. With n=500,
  // the top 5% is ~25 samples — enough for a stable rank estimate without
  // waiting for the full 30-day (8640-sample) target. Below this, the module
  // reports warmingUp=true and suppresses all alerts rather than firing on
  // an unreliable percentile.
  var MIN_BASELINE_SAMPLES = 500;

  var DEFAULT_ENTRY_PERCENTILE = 95;
  var DEFAULT_REARM_PERCENTILE = 80;

  // Alert model selector. STRICT is the unchanged v1 signal (score = OI
  // expansion vs cumulative absolute path length). NET_PROGRESS is the v2
  // diagnostic-turned-selectable model (score = OI expansion vs NET 12h
  // price displacement). Function-level default stays STRICT so that any
  // caller (tests, CLI, direct API use) that doesn't explicitly pass
  // alertModel reproduces the original v1 behavior exactly, unchanged.
  // The UI's own default (netProgress) is a render-layer choice, applied
  // explicitly when it calls into the backtest — it does not change this.
  var ALERT_MODEL_STRICT = 'strict';
  var ALERT_MODEL_NET_PROGRESS = 'netProgress';
  var DEFAULT_ALERT_MODEL = ALERT_MODEL_STRICT;

  /**
   * Returns the score value to use for percentile ranking / gating / the
   * state machine, given a computeExhaustionSeries entry and the selected
   * alert model. Any unrecognized model value falls back to strict (safe
   * default, matches DEFAULT_ALERT_MODEL) rather than silently returning
   * something unexpected.
   */
  function getModelScore(entry, alertModel) {
    if (!entry || !entry.valid) return null;
    if (alertModel === ALERT_MODEL_NET_PROGRESS) return entry.netProgressScore;
    return entry.score;
  }

  // Diagnostic-only constants (netProgressScore / priceChopRatio / choppy-
  // but-flat counting). Not tunable alert parameters — these exist only to
  // make the diagnostic comparison well-defined and reproducible.
  var DIAGNOSTIC_SMALL_EPSILON = 1e-6; // floor for priceChopRatio's denominator, avoids /~0 blowups on a truly flat 12h window
  var DIAGNOSTIC_CHOP_RATIO_THRESHOLD = 2; // "choppy" == cumulative path length at least 2x net displacement

  // ── Core math ──────────────────────────────────────────────────────────

  /**
   * One candle's exhaustion reading. Returns null (invalidating) on a
   * zero/invalid denominator rather than fabricating a spike.
   */
  function computeExhaustionReading(prevClose, close, prevOI, oi) {
    if (!isFinite(prevClose) || !isFinite(close) || !isFinite(prevOI) || !isFinite(oi)) return null;
    if (prevClose === 0 || prevOI === 0) return null;
    var priceMovePct = Math.abs((close - prevClose) / prevClose) * 100;
    var oiChangePct = ((oi - prevOI) / prevOI) * 100;
    return {
      priceMovePct: priceMovePct,
      oiChangePct: oiChangePct,
      priceChangePctSigned: ((close - prevClose) / prevClose) * 100,
      exhaustionReading: oiChangePct - priceMovePct,
    };
  }

  /**
   * Builds the full aligned exhaustion + rolling-score series for a candle
   * array. Inputs must already be aligned 1:1 by timestamp (same length,
   * same order) — alignment/gap-detection is a data-layer concern, not
   * this engine's. `validFlags[i]` (optional, default all true) marks
   * candles known to be gap-free/complete; any false candle inside a
   * window invalidates that window's score.
   *
   * Returns array of length candles.length, each entry either:
   *   { valid: false } — window incomplete/invalid
   *   { valid: true, score, oiChange12hPct, priceChange12hPct, priceTravel12hAbsPct, direction12h }
   */
  function computeExhaustionSeries(timestamps, closes, ois, opts) {
    opts = opts || {};
    var windowSize = opts.windowSize || SIGNAL_WINDOW;
    var validFlags = opts.validFlags || timestamps.map(function () { return true; });
    var n = timestamps.length;

    var readings = new Array(n).fill(null);
    for (var i = 1; i < n; i++) {
      if (!validFlags[i] || !validFlags[i - 1]) continue;
      readings[i] = computeExhaustionReading(closes[i - 1], closes[i], ois[i - 1], ois[i]);
    }

    var out = new Array(n).fill(null).map(function () { return { valid: false }; });

    for (var t = windowSize; t < n; t++) {
      var windowStart = t - windowSize + 1; // readings[windowStart..t] = windowSize readings
      var sum = 0;
      var ok = true;
      for (var k = windowStart; k <= t; k++) {
        if (!validFlags[k] || readings[k] === null) { ok = false; break; }
        sum += readings[k].exhaustionReading;
      }
      if (!ok) continue;

      var score = sum / windowSize;

      // 12h diagnostics — window spans candle (t-windowSize) .. t inclusive (windowSize+1 candles)
      var baseIdx = t - windowSize;
      var oiChange12hPct = (ois[baseIdx] !== 0 && isFinite(ois[baseIdx]))
        ? ((ois[t] - ois[baseIdx]) / ois[baseIdx]) * 100
        : null;
      var priceChange12hPct = (closes[baseIdx] !== 0 && isFinite(closes[baseIdx]))
        ? ((closes[t] - closes[baseIdx]) / closes[baseIdx]) * 100
        : null;

      var travelSum = 0;
      for (var k2 = windowStart; k2 <= t; k2++) travelSum += readings[k2].priceMovePct;

      // ── Diagnostic-only second score, added per explicit request. Does
      // NOT replace or feed into `score` (strictPathScore) above, and does
      // NOT gate any alert — it's a separate lens on the same window.
      //
      // strictPathScore (the `score` field, unchanged): OI expansion vs
      // cumulative absolute 5m price travel (path length / volatility).
      // netProgressScore: OI expansion vs NET 12h price displacement — this
      // can stay positive through a choppy, range-bound 12h stretch where
      // strictPathScore goes deeply negative, because chop racks up path
      // length without net progress.
      var netPriceMove12hPct = priceChange12hPct === null ? null : Math.abs(priceChange12hPct);
      var netProgressScore = (oiChange12hPct === null || netPriceMove12hPct === null)
        ? null
        : oiChange12hPct - netPriceMove12hPct;
      var priceChopRatio = netPriceMove12hPct === null
        ? null
        : travelSum / Math.max(netPriceMove12hPct, DIAGNOSTIC_SMALL_EPSILON);

      out[t] = {
        valid: true,
        score: score, // strictPathScore — unchanged, still the only score that gates alerts
        oiChange12hPct: oiChange12hPct,
        priceChange12hPct: priceChange12hPct,
        priceTravel12hAbsPct: travelSum,
        direction12h: priceChange12hPct === null ? null : (priceChange12hPct > 0 ? 'up' : (priceChange12hPct < 0 ? 'down' : 'flat')),
        netPriceMove12hPct: netPriceMove12hPct,
        netProgressScore: netProgressScore,
        priceChopRatio: priceChopRatio,
      };
    }

    return out;
  }

  // ── Baseline: rolling percentile (primary) + z-score (diagnostic) ──────

  /**
   * Sorted-array baseline log with O(log n) lookup, now a TRAILING window
   * (default 8640 valid scores = 30 days), not an ever-expanding history.
   * Maintains both insertion order (FIFO, for eviction) and a sorted array
   * (for percentile/z-score queries). When size exceeds the configured
   * lookback, the oldest inserted value is evicted from both structures.
   *
   * Percentile uses MEAN RANK for ties: percentile = (countLess + 0.5 *
   * countEqual) / n * 100. This is deliberate — with the naive "<=" rank,
   * a flat baseline (e.g. all zeros) makes a new value of exactly 0 rank at
   * the 100th percentile, which would falsely qualify as "unusually high."
   * Mean rank puts an exact tie at the middle of its tied group instead.
   *
   * Values are inserted causally by the caller (chronological order only,
   * never a future score before querying) — this class does not enforce
   * time ordering itself.
   */
  function createBaselineLog(opts) {
    opts = opts || {};
    var lookback = opts.baselineLookbackCandles || DEFAULT_BASELINE_LOOKBACK_CANDLES;

    var insertionOrder = []; // FIFO of raw values, oldest first
    var sorted = [];         // ascending

    function lowerBound(value) {
      var lo = 0, hi = sorted.length;
      while (lo < hi) {
        var mid = (lo + hi) >>> 1;
        if (sorted[mid] < value) lo = mid + 1; else hi = mid;
      }
      return lo;
    }
    function upperBound(value) {
      var lo = 0, hi = sorted.length;
      while (lo < hi) {
        var mid = (lo + hi) >>> 1;
        if (sorted[mid] <= value) lo = mid + 1; else hi = mid;
      }
      return lo;
    }
    function removeOneValue(value) {
      var idx = lowerBound(value);
      // sorted[idx] should equal value here (it was inserted, so it must be present)
      sorted.splice(idx, 1);
    }

    return {
      size: function () { return insertionOrder.length; },
      lookback: lookback,
      insert: function (value) {
        insertionOrder.push(value);
        var idx = lowerBound(value);
        sorted.splice(idx, 0, value);
        if (insertionOrder.length > lookback) {
          var evicted = insertionOrder.shift();
          removeOneValue(evicted);
        }
      },
      /** Mean-rank percentile of `value` against the current trailing baseline: 0-100. */
      percentileRank: function (value) {
        var n = sorted.length;
        if (n === 0) return null;
        var countLess = lowerBound(value);
        var countLessOrEqual = upperBound(value);
        var countEqual = countLessOrEqual - countLess;
        return ((countLess + 0.5 * countEqual) / n) * 100;
      },
      zScore: function (value) {
        var n = sorted.length;
        if (n === 0) return null;
        var mean = sorted.reduce(function (a, b) { return a + b; }, 0) / n;
        if (n < 2) return 0;
        var variance = sorted.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1);
        var std = Math.sqrt(variance);
        if (std === 0) return 0;
        return (value - mean) / std;
      },
    };
  }

  // ── Zones ────────────────────────────────────────────────────────────────

  function isPriceInZone(price, zone) {
    if (!zone || zone.active === false) return false;
    return price >= zone.bottom && price <= zone.top;
  }

  /**
   * Temporal gating, independent of price containment. A zone can only
   * participate in detection once it's actually known/active in real time
   * (`availableAtTs`), and stops once retired (`inactiveAtTs`, exclusive
   * upper bound). Both are optional; omitting them means "always available"
   * / "never retired" respectively — existing `active: true/false` still
   * works as an immediate on/off switch on top of this.
   */
  function isZoneTemporallyActive(zone, ts) {
    if (!zone || zone.active === false) return false;
    if (zone.availableAtTs != null && ts < zone.availableAtTs) return false;
    if (zone.inactiveAtTs != null && ts >= zone.inactiveAtTs) return false;
    return true;
  }

  function zoneRangeThird(price, zone) {
    var span = zone.top - zone.bottom;
    if (span <= 0) return 'middle';
    var frac = (price - zone.bottom) / span;
    if (frac < 1 / 3) return 'lower';
    if (frac < 2 / 3) return 'middle';
    return 'upper';
  }

  function classifyContextDirection(priceChange12hPct) {
    if (priceChange12hPct === null || priceChange12hPct === undefined) return null;
    if (priceChange12hPct > 0) return 'bearish-exhaustion';
    if (priceChange12hPct < 0) return 'bullish-exhaustion';
    return 'neutral';
  }

  // ── Alert state machine (per zone) ──────────────────────────────────────

  /**
   * One causal step of the per-zone armed/alert state machine.
   * `prevArmed` is null on first-ever evaluation of a zone (treated as false).
   *
   * Qualification gate: a candle can only ARM/fire if score > 0. This matches
   * the strategy definition — OI must be genuinely expanding faster than
   * price travelled, not merely "less negative than usual." Without this
   * gate, a flat/negative baseline can rank a non-positive score at a high
   * percentile purely by relative comparison, which is not the condition
   * the strategy describes.
   */
  function stepZoneState(prevArmed, inZone, percentile, warmingUp, score, opts) {
    opts = opts || {};
    var entryPct = opts.entryPercentile || DEFAULT_ENTRY_PERCENTILE;
    var exitPct = opts.rearmPercentile || DEFAULT_REARM_PERCENTILE;

    if (!inZone) {
      return { armed: false, alertFired: false };
    }
    if (warmingUp || percentile === null || percentile === undefined) {
      return { armed: !!prevArmed, alertFired: false };
    }
    var qualifies = (typeof score === 'number') && score > 0 && percentile >= entryPct;
    if (!prevArmed && qualifies) {
      return { armed: true, alertFired: true };
    }
    if (prevArmed && percentile < exitPct) {
      return { armed: false, alertFired: false };
    }
    return { armed: !!prevArmed, alertFired: false };
  }

  function buildAlertRecord(fields) {
    return {
      timestamp: fields.timestamp,
      zoneId: fields.zone.id,
      zoneBounds: {
        top: fields.zone.top, bottom: fields.zone.bottom, type: fields.zone.type, label: fields.zone.label || null,
        availableAtTs: fields.zone.availableAtTs != null ? fields.zone.availableAtTs : null,
        inactiveAtTs: fields.zone.inactiveAtTs != null ? fields.zone.inactiveAtTs : null,
      },
      price: fields.price,
      score: fields.score,
      alertModel: fields.alertModel,
      percentile: fields.percentile,
      zScore: fields.zScore,
      oiChange12hPct: fields.oiChange12hPct,
      priceTravel12hAbsPct: fields.priceTravel12hAbsPct,
      direction12h: fields.direction12h,
      contextDirection: fields.contextDirection,
      rangeThird: fields.rangeThird,
      baselineSampleCount: fields.baselineSampleCount,
    };
  }

  // ── Exports ──────────────────────────────────────────────────────────────

  var OIExhaustionEngine = {
    SIGNAL_WINDOW: SIGNAL_WINDOW,
    DEFAULT_BASELINE_LOOKBACK_CANDLES: DEFAULT_BASELINE_LOOKBACK_CANDLES,
    MIN_BASELINE_SAMPLES: MIN_BASELINE_SAMPLES,
    DEFAULT_ENTRY_PERCENTILE: DEFAULT_ENTRY_PERCENTILE,
    DEFAULT_REARM_PERCENTILE: DEFAULT_REARM_PERCENTILE,
    DIAGNOSTIC_SMALL_EPSILON: DIAGNOSTIC_SMALL_EPSILON,
    DIAGNOSTIC_CHOP_RATIO_THRESHOLD: DIAGNOSTIC_CHOP_RATIO_THRESHOLD,
    ALERT_MODEL_STRICT: ALERT_MODEL_STRICT,
    ALERT_MODEL_NET_PROGRESS: ALERT_MODEL_NET_PROGRESS,
    DEFAULT_ALERT_MODEL: DEFAULT_ALERT_MODEL,
    getModelScore: getModelScore,
    computeExhaustionReading: computeExhaustionReading,
    computeExhaustionSeries: computeExhaustionSeries,
    createBaselineLog: createBaselineLog,
    isPriceInZone: isPriceInZone,
    isZoneTemporallyActive: isZoneTemporallyActive,
    zoneRangeThird: zoneRangeThird,
    classifyContextDirection: classifyContextDirection,
    stepZoneState: stepZoneState,
    buildAlertRecord: buildAlertRecord,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionEngine;
  } else {
    root.OIExhaustionEngine = OIExhaustionEngine;
  }

})(typeof window !== 'undefined' ? window : globalThis);

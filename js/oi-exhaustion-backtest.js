/**
 * oi-exhaustion-backtest.js
 * Event-study runner for the OI Exhaustion module. Node-only (uses fs for
 * output). Completely independent of the existing EMA backtest.js — no
 * shared code, no shared state.
 *
 * This is an event-study, not a trading strategy backtest: it measures what
 * happens AFTER each alert, at fixed horizons. It does not simulate
 * positions, P&L, or execution.
 *
 * No-lookahead guarantee: the baseline log used to compute percentile/z-score
 * at candle t is built ONLY from scores at indices < t (strictly causal), and
 * is now a TRAILING window (default 8640 valid scores / 30 days), not an
 * ever-expanding history. Horizon outcome metrics are computed only from
 * candles strictly after the alert's timestamp — that's legitimate ex-post
 * measurement, not detection.
 *
 * Usage:
 *   node oi-exhaustion-backtest.js --candles path/to/candles.json \
 *                                  --oi path/to/oi.json \
 *                                  --zones path/to/zones.json \
 *                                  --out path/to/report.json
 *
 * Input shapes:
 *   candles: [{ ts, close }] or [{ ts, open, high, low, close }] — ascending,
 *            5m-aligned. OHLC is optional; when high/low are present,
 *            boundary-hit detection uses them. When absent, boundary
 *            detection falls back to close-only and is marked as such.
 *   oi:      [{ ts, oi }]  ascending, 5m-aligned
 *   zones:   [{ id, label, type, top, bottom, active, availableAtTs, inactiveAtTs }]
 */
'use strict';

const Engine = (typeof module !== 'undefined' && module.exports)
  ? require('./oi-exhaustion-engine.js')
  : window.OIExhaustionEngine;

const HORIZONS_MINUTES = [15, 60, 240, 720, 1440, 4320]; // 15m, 1h, 4h, 12h, 24h, 3d
const FIFTEEN_MIN_MS = 15 * 60 * 1000; // candle/OI-bucket interval — switched from 5m (Bybit) to 15m (CryptoHFT aggregate + matching Binance price candles)

// ── Alignment (causal-safe: just a join + gap flagging, no lookahead risk) ──

/**
 * Inner-join candles and OI rows by exact timestamp match. Returns
 * { timestamps, closes, ois, highs, lows, hasOHLC, validFlags }.
 * validFlags[i] is false if this candle's timestamp isn't exactly one
 * interval after the previous one (i.e. a gap was skipped by the join), so
 * both scoring and horizon measurement correctly refuse to bridge across it.
 * `highs`/`lows` are null (not filled with a fake proxy) when the input
 * candles didn't include OHLC — callers must check `hasOHLC` explicitly
 * rather than assume presence.
 */
function alignCandlesAndOI(candles, oiRows) {
  const oiByTs = new Map(oiRows.map(r => [r.ts, r.oi]));
  const timestamps = [];
  const closes = [];
  const ois = [];
  const highs = [];
  const lows = [];
  const hasOHLC = candles.length > 0 && candles.every(c => typeof c.high === 'number' && typeof c.low === 'number');

  for (const c of candles) {
    if (!oiByTs.has(c.ts)) continue; // no matching OI sample — excluded, not fabricated
    timestamps.push(c.ts);
    closes.push(c.close);
    ois.push(oiByTs.get(c.ts));
    highs.push(hasOHLC ? c.high : null);
    lows.push(hasOHLC ? c.low : null);
  }

  const validFlags = timestamps.map((ts, i) => {
    if (i === 0) return true;
    return ts - timestamps[i - 1] === FIFTEEN_MIN_MS;
  });

  return { timestamps, closes, ois, highs, lows, hasOHLC, validFlags };
}

// ── Horizon outcome measurement (ex-post, forward-only from alert time) ────

/** Exact-timestamp lookup only — no "nearest after" substitution. */
function findExactIndex(timestamps, targetTs) {
  // Binary search since timestamps are ascending.
  let lo = 0, hi = timestamps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] === targetTs) return mid;
    if (timestamps[mid] < targetTs) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

function computeHorizonOutcomes(alertIdx, timestamps, closes, highs, lows, hasOHLC, validFlags, zoneBounds) {
  const alertPrice = closes[alertIdx];
  const alertTs = timestamps[alertIdx];
  const lastTs = timestamps[timestamps.length - 1];
  const outcomes = {};

  for (const minutes of HORIZONS_MINUTES) {
    const targetTs = alertTs + minutes * 60 * 1000;
    const key = minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;

    if (targetTs > lastTs) {
      outcomes[key] = { dataQuality: 'insufficient_forward_data' };
      continue;
    }

    const horizonEndIdx = findExactIndex(timestamps, targetTs);
    if (horizonEndIdx === -1 || horizonEndIdx <= alertIdx) {
      // Data exists past this point in time generally, but not the exact
      // candle this horizon needs — do not substitute the next available
      // candle, that would silently misstate the horizon length.
      outcomes[key] = { dataQuality: 'invalid_forward_gap' };
      continue;
    }

    // Require every candle from alertIdx+1..horizonEndIdx to be gap-free
    // (validFlags true) — a single skipped 5m interval anywhere inside the
    // horizon invalidates it, per spec.
    let gapFound = false;
    for (let i = alertIdx + 1; i <= horizonEndIdx; i++) {
      if (!validFlags[i]) { gapFound = true; break; }
    }
    if (gapFound) {
      outcomes[key] = { dataQuality: 'invalid_forward_gap' };
      continue;
    }

    let maxUp = 0, maxDown = 0;
    let firstBoundaryHit = 'none';
    let timeToFirstBoundaryHit = null;

    for (let i = alertIdx + 1; i <= horizonEndIdx; i++) {
      const pct = ((closes[i] - alertPrice) / alertPrice) * 100;
      if (pct > maxUp) maxUp = pct;
      if (pct < maxDown) maxDown = pct;

      if (firstBoundaryHit === 'none' && zoneBounds) {
        if (hasOHLC) {
          const hitTop = highs[i] >= zoneBounds.top;
          const hitBottom = lows[i] <= zoneBounds.bottom;
          if (hitTop && hitBottom) {
            firstBoundaryHit = 'both_same_candle';
            timeToFirstBoundaryHit = timestamps[i] - alertTs;
          } else if (hitTop) {
            firstBoundaryHit = 'top';
            timeToFirstBoundaryHit = timestamps[i] - alertTs;
          } else if (hitBottom) {
            firstBoundaryHit = 'bottom';
            timeToFirstBoundaryHit = timestamps[i] - alertTs;
          }
        } else {
          // close-only proxy — cannot detect intra-candle wicks, and
          // cannot detect a same-candle double touch at all.
          if (closes[i] >= zoneBounds.top) {
            firstBoundaryHit = 'top';
            timeToFirstBoundaryHit = timestamps[i] - alertTs;
          } else if (closes[i] <= zoneBounds.bottom) {
            firstBoundaryHit = 'bottom';
            timeToFirstBoundaryHit = timestamps[i] - alertTs;
          }
        }
      }
    }

    const forwardReturnPct = ((closes[horizonEndIdx] - alertPrice) / alertPrice) * 100;

    outcomes[key] = {
      forwardReturnPct,
      maxUpExcursionPct: maxUp,
      maxDownExcursionPct: maxDown,
      firstBoundaryHit,
      timeToFirstBoundaryHit,
      boundaryMethod: hasOHLC ? 'ohlc' : 'close_only_proxy',
      dataQuality: 'ok',
    };
  }

  return outcomes;
}

// ── Main run: causal detection pass, then ex-post horizon measurement ──────

function runEventStudy(candles, oiRows, zones, opts) {
  opts = opts || {};
  const entryPercentile = opts.entryPercentile || Engine.DEFAULT_ENTRY_PERCENTILE;
  const rearmPercentile = opts.rearmPercentile || Engine.DEFAULT_REARM_PERCENTILE;
  const minBaselineSamples = opts.minBaselineSamples || Engine.MIN_BASELINE_SAMPLES;
  const baselineLookbackCandles = opts.baselineLookbackCandles || Engine.DEFAULT_BASELINE_LOOKBACK_CANDLES;
  // BUG FIX: signalWindow was captured from the UI (Parameters -> "Signal
  // window (candles)") and displayed, but never actually reached the
  // engine — computeExhaustionSeries was always called without a
  // windowSize option, silently falling back to Engine.SIGNAL_WINDOW no
  // matter what the field showed. Now actually threaded through.
  const signalWindow = opts.signalWindow || Engine.SIGNAL_WINDOW;
  // Backward-compatible default: any caller that doesn't pass alertModel
  // (existing tests, CLI, direct API use) gets exactly the original v1
  // strict-score behavior, unchanged.
  const alertModel = opts.alertModel || Engine.DEFAULT_ALERT_MODEL;

  // OI-recency eligibility filter — V2-only, optional, disabled by default.
  // When enabled, an alert may only ARM if OI is still actively expanding
  // right now (not just earlier in the 12h window) — see the June 30 00:40
  // case that motivated this. Never applies to V1 (strict), regardless of
  // these settings, and never affects rearm/exit — only new arming.
  const oiRecencyFilterEnabled = opts.oiRecencyFilterEnabled === true && alertModel === Engine.ALERT_MODEL_NET_PROGRESS;
  const minimumRecentOIChangePct = opts.minimumRecentOIChangePct !== undefined ? opts.minimumRecentOIChangePct : 0;
  const oiRecencyWindow = Engine.OI_RECENCY_WINDOW_CANDLES[opts.oiRecencyWindow] ? opts.oiRecencyWindow : '1h';
  const oiRecencyWindowCandles = Engine.OI_RECENCY_WINDOW_CANDLES[oiRecencyWindow];

  // "Include fast directional OI builds" — optional, disabled by default,
  // entirely separate from V1/V2 score math (see oi-exhaustion-engine.js
  // for why: independent percentile checks, never subtracted). Every
  // option below only has any effect when directionalImpulseEnabled is
  // true — when false, this whole block is skipped and V1/V2 behavior is
  // byte-for-byte what it was before this feature existed.
  const directionalImpulseEnabled = opts.directionalImpulseEnabled === true;
  const directionalImpulseWindow = Engine.IMPULSE_WINDOW_CANDLES[opts.directionalImpulseWindow]
    ? opts.directionalImpulseWindow : Engine.DEFAULT_IMPULSE_WINDOW;
  const directionalImpulseWindowCandles = Engine.IMPULSE_WINDOW_CANDLES[directionalImpulseWindow];
  const directionalPriceEntryPercentile = opts.directionalPriceEntryPercentile != null
    ? opts.directionalPriceEntryPercentile : Engine.DEFAULT_DIRECTIONAL_ENTRY_PERCENTILE;
  const directionalOiEntryPercentile = opts.directionalOiEntryPercentile != null
    ? opts.directionalOiEntryPercentile : Engine.DEFAULT_DIRECTIONAL_ENTRY_PERCENTILE;
  const directionalImpulseRearmPercentile = opts.directionalImpulseRearmPercentile != null
    ? opts.directionalImpulseRearmPercentile : Engine.DEFAULT_DIRECTIONAL_REARM_PERCENTILE;
  const directionalMinRawOiIncreasePct = opts.directionalMinRawOiIncreasePct != null
    ? opts.directionalMinRawOiIncreasePct : Engine.DEFAULT_MIN_RAW_OI_INCREASE_PCT;

  const { timestamps, closes, ois, highs, lows, hasOHLC, validFlags } = alignCandlesAndOI(candles, oiRows);
  const series = Engine.computeExhaustionSeries(timestamps, closes, ois, { validFlags, windowSize: signalWindow });

  const baseline = Engine.createBaselineLog({ baselineLookbackCandles });
  const zoneStates = new Map(zones.map(z => [z.id, false])); // armed state per zone
  const alerts = [];
  let positiveScoreCount = 0;

  // Directional-impulse: two INDEPENDENT causal baselines — never the V1/V2
  // score distribution. priceImpulseBaseline tracks abs(priceReturnPct)
  // over every valid impulse window; oiImpulseBaseline tracks ONLY
  // positive oiReturnPct observations (a falling-OI candle is never
  // inserted here at all, so it can never later be compared against this
  // distribution). Armed state is tracked per zone AND per direction —
  // upside and downside never share or block each other.
  const priceImpulseBaseline = Engine.createBaselineLog({ baselineLookbackCandles });
  const oiImpulseBaseline = Engine.createBaselineLog({ baselineLookbackCandles });
  const directionalZoneStates = new Map(zones.map(z => [z.id, { upsideArmed: false, downsideArmed: false }]));
  const directionalAlertCounts = { DOWNSIDE_OI_CHASE: 0, UPSIDE_OI_CHASE: 0 };

  // Diagnostic-only accumulation (per explicit milestone: compare
  // strictPathScore vs netProgressScore side-by-side, without touching
  // alert logic, chart markers, or backtest behavior above).
  const strictScoreValues = [];
  const netProgressScoreValues = [];
  let positiveNetProgressCount = 0;
  let choppyButFlatCount = 0;

  for (let t = 0; t < series.length; t++) {
    const entry = series[t];
    const ts = timestamps[t];
    const price = closes[t];

    if (entry.valid) {
      // Diagnostics always track BOTH scores regardless of which model is
      // selected for alerting — this comparison must stay available no
      // matter what the operator picks below.
      if (entry.score > 0) positiveScoreCount++;
      strictScoreValues.push(entry.score);
      if (entry.netProgressScore !== null) {
        netProgressScoreValues.push(entry.netProgressScore);
        if (entry.netProgressScore > 0) positiveNetProgressCount++;
        // Fixed diagnostic definition, not a tunable alert parameter:
        // OI grew, net 12h price progress was small/near-flat, but
        // cumulative path length was large relative to that net move.
        if (entry.oiChange12hPct !== null && entry.oiChange12hPct > 0 &&
            entry.priceChopRatio !== null && entry.priceChopRatio >= Engine.DIAGNOSTIC_CHOP_RATIO_THRESHOLD) {
          choppyButFlatCount++;
        }
      }

      // Everything below this point — baseline, percentile, gating, the
      // state machine, and the alert record itself — uses ONLY the
      // selected model's score. The two models' scores are never mixed
      // into the same baseline distribution.
      const selectedScore = Engine.getModelScore(entry, alertModel);

      if (selectedScore !== null) {
        const warmingUp = baseline.size() < minBaselineSamples;
        const percentile = warmingUp ? null : baseline.percentileRank(selectedScore);
        const zScore = warmingUp ? null : baseline.zScore(selectedScore);

        // OI-recency gate — computed once per candle (same for every zone),
        // not tied to any particular zone's state.
        let additionalGatePassed = true;
        let recentOIChangePct = null;
        let oiRecencyFilterMeta = null;
        if (oiRecencyFilterEnabled) {
          recentOIChangePct = Engine.computeChangeOverCandles(ois, t, oiRecencyWindowCandles);
          const slopeOk = entry.oiSlopeRecent !== null && entry.oiSlopeRecent >= 0;
          const recentChangeOk = recentOIChangePct !== null && recentOIChangePct > minimumRecentOIChangePct;
          additionalGatePassed = slopeOk && recentChangeOk;
          oiRecencyFilterMeta = {
            enabled: true,
            window: oiRecencyWindow,
            minimumRecentOIChangePct,
            recentOIChangePct,
            oiSlopeRecent: entry.oiSlopeRecent,
          };
        }

        for (const zone of zones) {
          const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
          const prevArmed = zoneStates.get(zone.id);
          const step = Engine.stepZoneState(prevArmed, inZone, percentile, warmingUp, selectedScore, {
            entryPercentile, rearmPercentile, additionalGatePassed,
          });
          zoneStates.set(zone.id, step.armed);

          if (step.alertFired) {
            const contextDirection = Engine.classifyContextDirection(entry.priceChange12hPct);
            const rangeThird = Engine.zoneRangeThird(price, zone);
            const record = Engine.buildAlertRecord({
              timestamp: ts,
              zone, price,
              score: selectedScore,
              alertModel,
              percentile, zScore,
              oiChange12hPct: entry.oiChange12hPct,
              priceTravel12hAbsPct: entry.priceTravel12hAbsPct,
              direction12h: entry.direction12h,
              oiChange30mPct: entry.oiChange30mPct,
              oiChange1hPct: entry.oiChange1hPct,
              oiChange2hPct: entry.oiChange2hPct,
              oiChange4hPct: entry.oiChange4hPct,
              oiChangeLast3CandlesPct: entry.oiChangeLast3CandlesPct,
              oiSlopeRecent: entry.oiSlopeRecent,
              priceChange1hPct: entry.priceChange1hPct,
              priceChange4hPct: entry.priceChange4hPct,
              oiRecencyFilter: oiRecencyFilterMeta,
              contextDirection, rangeThird,
              baselineSampleCount: baseline.size(),
            });
            alerts.push({ ...record, candleIndex: t, percentileBucket: percentileBucket(percentile) });
          }
        }

        // Insert AFTER this candle's decisions are final — next candle's
        // baseline query will see this score, this candle's never sees itself.
        baseline.insert(selectedScore);
      } else {
        // Selected model's score is null for this candle (e.g. netProgress
        // requested but its 12h base candle was itself invalid) — nothing
        // to rank or insert. Still honor zone-exit resets so a zone doesn't
        // stay stuck armed indefinitely through a stretch of null scores.
        for (const zone of zones) {
          const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
          if (!inZone) zoneStates.set(zone.id, false);
        }
      }
    } else {
      // invalid window: still must reset any zone whose price/temporal
      // condition changed, but with no score there is nothing to evaluate.
      for (const zone of zones) {
        const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
        if (!inZone) zoneStates.set(zone.id, false);
      }
    }

    // ── Directional-impulse: entirely independent of V1/V2 validity above
    // (it has its own, shorter window requirement) — runs every t when
    // enabled, regardless of whether the V1/V2 signalWindow itself was
    // valid at this candle.
    if (directionalImpulseEnabled) {
      const impulseGapFree = Engine.isImpulseWindowGapFree(validFlags, t, directionalImpulseWindowCandles);
      let priceReturnPct = null, oiReturnPct = null;
      if (impulseGapFree) {
        priceReturnPct = Engine.computeChangeOverCandles(closes, t, directionalImpulseWindowCandles);
        oiReturnPct = Engine.computeChangeOverCandles(ois, t, directionalImpulseWindowCandles);
      }

      // Warms up on BOTH baselines independently — the OI baseline only
      // grows on positive observations, so it will typically warm up
      // slower than the price baseline (which grows on every valid
      // candle). Per spec: the first candidate is only evaluated once
      // there's enough data for the impulse window AND the full percentile
      // baseline AND the configured minimum sample count, on both axes.
      const directionalWarmingUp = priceImpulseBaseline.size() < minBaselineSamples || oiImpulseBaseline.size() < minBaselineSamples;

      let pricePercentile = null, oiPercentile = null;
      if (impulseGapFree && !directionalWarmingUp) {
        if (priceReturnPct !== null) pricePercentile = priceImpulseBaseline.percentileRank(Math.abs(priceReturnPct));
        // Only a POSITIVE OI return ever gets a percentile at all — a
        // falling/flat OI reading is compared against nothing and so can
        // never qualify, regardless of its magnitude (see engine.js).
        if (oiReturnPct !== null && oiReturnPct > 0) oiPercentile = oiImpulseBaseline.percentileRank(oiReturnPct);
      }

      const evalResult = (impulseGapFree && !directionalWarmingUp)
        ? Engine.evaluateDirectionalImpulse(priceReturnPct, pricePercentile, oiReturnPct, oiPercentile, {
            priceEntryPercentile: directionalPriceEntryPercentile,
            oiEntryPercentile: directionalOiEntryPercentile,
            minRawOiIncreasePct: directionalMinRawOiIncreasePct,
          })
        : { qualifies: false, cause: null, direction: null, failReasons: [impulseGapFree ? 'baseline_warming_up' : 'impulse_window_gap_or_insufficient_history'] };

      for (const zone of zones) {
        const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
        const zState = directionalZoneStates.get(zone.id);

        const downQualifies = evalResult.qualifies && evalResult.cause === Engine.ALERT_CAUSE_DOWNSIDE_OI_CHASE;
        const upQualifies = evalResult.qualifies && evalResult.cause === Engine.ALERT_CAUSE_UPSIDE_OI_CHASE;

        const downStep = Engine.stepDirectionalImpulseState(zState.downsideArmed, inZone, downQualifies, pricePercentile, oiPercentile, { rearmPercentile: directionalImpulseRearmPercentile });
        const upStep = Engine.stepDirectionalImpulseState(zState.upsideArmed, inZone, upQualifies, pricePercentile, oiPercentile, { rearmPercentile: directionalImpulseRearmPercentile });
        zState.downsideArmed = downStep.armed;
        zState.upsideArmed = upStep.armed;

        if (downStep.alertFired || upStep.alertFired) {
          const cause = downStep.alertFired ? Engine.ALERT_CAUSE_DOWNSIDE_OI_CHASE : Engine.ALERT_CAUSE_UPSIDE_OI_CHASE;
          const rangeThird = Engine.zoneRangeThird(price, zone);
          const record = Engine.buildDirectionalAlertRecord({
            timestamp: ts, zone, price, cause,
            impulseWindow: directionalImpulseWindow,
            priceReturnPct, oiReturnPct, pricePercentile, oiPercentile,
            rangeThird,
            priceBaselineSampleCount: priceImpulseBaseline.size(),
            oiBaselineSampleCount: oiImpulseBaseline.size(),
          });
          const relevantPercentile = Math.max(pricePercentile || 0, oiPercentile || 0);
          alerts.push({ ...record, candleIndex: t, percentileBucket: percentileBucket(relevantPercentile) });
          directionalAlertCounts[cause]++;
        }
      }

      // Insert AFTER this candle's decisions — never sees itself, matches
      // the same causal-insert-after-use pattern as the V1/V2 baseline.
      if (impulseGapFree) {
        if (priceReturnPct !== null) priceImpulseBaseline.insert(Math.abs(priceReturnPct));
        if (oiReturnPct !== null && oiReturnPct > 0) oiImpulseBaseline.insert(oiReturnPct);
      }
    }
  }

  // Ex-post horizon measurement — legitimate forward-looking, not detection.
  for (const alert of alerts) {
    alert.horizons = computeHorizonOutcomes(alert.candleIndex, timestamps, closes, highs, lows, hasOHLC, validFlags, alert.zoneBounds);
    delete alert.candleIndex; // internal only, not part of the reported record
  }

  const validScoreCount = series.filter(s => s.valid).length;

  return {
    alerts,
    summary: buildGroupedSummaries(alerts),
    diagnostics: {
      strictPathScore: summarizeDistribution(strictScoreValues),
      netProgressScore: summarizeDistribution(netProgressScoreValues),
      choppyButFlatCount,
      choppyButFlatDefinition: `oiChange12hPct > 0 AND priceChopRatio >= ${Engine.DIAGNOSTIC_CHOP_RATIO_THRESHOLD} (fixed diagnostic constant, not a tunable parameter)`,
    },
    meta: {
      totalCandles: timestamps.length,
      alertModel,
      signalWindow,
      oiRecencyFilterEnabled,
      minimumRecentOIChangePct,
      oiRecencyWindow,
      validScoreCount,
      positiveScoreCount,
      positiveScorePct: validScoreCount > 0 ? (positiveScoreCount / validScoreCount) * 100 : null,
      finalBaselineSize: baseline.size(),
      baselineLookbackCandles,
      minBaselineSamples,
      entryPercentile,
      rearmPercentile,
      hasOHLC,
      directionalImpulse: {
        enabled: directionalImpulseEnabled,
        impulseWindow: directionalImpulseWindow,
        priceEntryPercentile: directionalPriceEntryPercentile,
        oiEntryPercentile: directionalOiEntryPercentile,
        rearmPercentile: directionalImpulseRearmPercentile,
        minRawOiIncreasePct: directionalMinRawOiIncreasePct,
        downsideChaseCount: directionalAlertCounts.DOWNSIDE_OI_CHASE,
        upsideChaseCount: directionalAlertCounts.UPSIDE_OI_CHASE,
        priceBaselineSize: priceImpulseBaseline.size(),
        oiBaselineSize: oiImpulseBaseline.size(),
      },
    },
  };
}

function percentileBucket(p) {
  if (p === null || p === undefined) return null;
  if (p >= 99) return '99-100';
  if (p >= 97) return '97-99';
  return '95-97';
}

/**
 * Diagnostic-only distribution summary over a full array of score values
 * (NOT the causal trailing baseline used for live alerting — this is a
 * post-hoc, whole-dataset view for comparison purposes only).
 */
function summarizeDistribution(values) {
  if (!values.length) {
    return { count: 0, positiveCount: 0, positiveRatePct: null, p50: null, p90: null, p95: null, p99: null };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const positiveCount = values.filter(v => v > 0).length;
  return {
    count: values.length,
    positiveCount,
    positiveRatePct: (positiveCount / values.length) * 100,
    p50: pct(50), p90: pct(90), p95: pct(95), p99: pct(99),
  };
}

// ── Grouped, per-horizon statistics ─────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function summarizeHorizonOutcomes(outcomesForGroup, horizonKey) {
  const all = outcomesForGroup.map(o => o.horizons[horizonKey]).filter(Boolean);
  const valid = all.filter(o => o.dataQuality === 'ok');
  const invalidCount = all.length - valid.length;

  if (valid.length === 0) {
    return { validSampleCount: 0, invalidCount };
  }

  const returns = valid.map(o => o.forwardReturnPct);
  const ups = valid.map(o => o.maxUpExcursionPct);
  const downs = valid.map(o => o.maxDownExcursionPct);
  const topHits = valid.filter(o => o.firstBoundaryHit === 'top' || o.firstBoundaryHit === 'both_same_candle').length;
  const bottomHits = valid.filter(o => o.firstBoundaryHit === 'bottom' || o.firstBoundaryHit === 'both_same_candle').length;
  const noHits = valid.filter(o => o.firstBoundaryHit === 'none').length;

  return {
    validSampleCount: valid.length,
    invalidCount,
    meanForwardReturnPct: mean(returns),
    medianForwardReturnPct: median(returns),
    positiveReturnRate: valid.filter(o => o.forwardReturnPct > 0).length / valid.length,
    meanMaxUpExcursionPct: mean(ups),
    meanMaxDownExcursionPct: mean(downs),
    topHitRate: topHits / valid.length,
    bottomHitRate: bottomHits / valid.length,
    noBoundaryHitRate: noHits / valid.length,
  };
}

function buildGroupedSummaries(alerts) {
  function groupBy(keyFn) {
    const groups = new Map();
    for (const a of alerts) {
      const key = keyFn(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const out = {};
    for (const [key, group] of groups) {
      const perHorizon = {};
      for (const minutes of HORIZONS_MINUTES) {
        const hKey = minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
        perHorizon[hKey] = summarizeHorizonOutcomes(group, hKey);
      }
      out[key] = { count: group.length, horizons: perHorizon };
    }
    return out;
  }

  return {
    byContextDirection: groupBy(a => a.contextDirection),
    byZoneType: groupBy(a => a.zoneBounds.type),
    byPercentileBucket: groupBy(a => a.percentileBucket),
    byRangeThird: groupBy(a => a.rangeThird),
    byCause: groupBy(a => a.cause),
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const args = parseArgs(process.argv.slice(2));
  if (!args.candles || !args.oi || !args.zones) {
    console.error('Usage: node oi-exhaustion-backtest.js --candles <file> --oi <file> --zones <file> [--out <file>]');
    process.exit(1);
  }
  const candles = JSON.parse(fs.readFileSync(args.candles, 'utf8'));
  const oiRows = JSON.parse(fs.readFileSync(args.oi, 'utf8'));
  const zones = JSON.parse(fs.readFileSync(args.zones, 'utf8'));

  const result = runEventStudy(candles, oiRows, zones, {
    alertModel: args.alertModel,
    entryPercentile: args.entryPercentile !== undefined ? Number(args.entryPercentile) : undefined,
    rearmPercentile: args.rearmPercentile !== undefined ? Number(args.rearmPercentile) : undefined,
    minBaselineSamples: args.minBaselineSamples !== undefined ? Number(args.minBaselineSamples) : undefined,
    baselineLookbackCandles: args.baselineLookbackCandles !== undefined ? Number(args.baselineLookbackCandles) : undefined,
    oiRecencyFilterEnabled: args.oiRecencyFilterEnabled === 'true',
    minimumRecentOIChangePct: args.minimumRecentOIChangePct !== undefined ? Number(args.minimumRecentOIChangePct) : undefined,
    oiRecencyWindow: args.oiRecencyWindow,
  });
  const outPath = args.out || path.join(__dirname, 'oi-exhaustion-backtest-report.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`Alert model: ${result.meta.alertModel}`);
  console.log(`Alerts found: ${result.alerts.length}`);
  console.log(`Valid scored candles: ${result.meta.validScoreCount} / ${result.meta.totalCandles}`);
  console.log(`Positive scores: ${result.meta.positiveScorePct != null ? result.meta.positiveScorePct.toFixed(1) + '%' : 'n/a'} of valid candles`);
  console.log(`Final baseline size: ${result.meta.finalBaselineSize} (lookback cap: ${result.meta.baselineLookbackCandles})`);
  console.log(`OHLC boundary detection: ${result.meta.hasOHLC ? 'yes' : 'no (close-only proxy)'}`);
  console.log(`Report written to: ${outPath}`);
}

const OIExhaustionBacktest = {
  alignCandlesAndOI,
  computeHorizonOutcomes,
  findExactIndex,
  runEventStudy,
  percentileBucket,
  buildGroupedSummaries,
  summarizeHorizonOutcomes,
  summarizeDistribution,
  HORIZONS_MINUTES,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OIExhaustionBacktest;
} else {
  window.OIExhaustionBacktest = OIExhaustionBacktest;
}

// oi-exhaustion-study.js — V2 parameter study (research), pure math only.
//
// Implements the LOCKED research spec agreed in chat (candidate comparison,
// not winner selection). Everything here is retrospective research labeling
// — NONE of it is a live/tradable rule, and nothing here feeds back into
// the engine, backtest, cache, zones, or alert infrastructure. This module
// never fetches anything; callers hand it in-memory candles/alerts.
//
// LOCKED SPEC (fixed before any parameter was run — do not tune to results):
//   Event:        max absolute close-to-close excursion >= 2.0% within the
//                 fixed [base, base + 12h] horizon (48 x 15m candles).
//                 Sensitivity views (report-only): 1.5% / 2.5%.
//   Base:         earliest anchor of a merged qualifying-anchor run
//                 (anchors merge across gaps <= 4 candles). Anchors without
//                 a FULL 48-candle forward horizon never qualify.
//   Horizon:      dominant excursion and ignition are measured strictly
//                 inside the base's own [base, base+48] window — a merged
//                 event never extends the effective horizon past 12h.
//   Dominant:     side with the larger max excursion from the BASE CLOSE
//                 within the horizon. Two-sided when both sides >= 1.0% or
//                 exact tie.
//   Ignition:     first candle CLOSE moved >= 0.75% from base close in the
//                 dominant direction (sensitivity 0.5%, report-only).
//                 Two-sided/tied: first close reaching EITHER +/-0.75%;
//                 the two-sided label is retained separately.
//   Match window: cluster primary ts in [ignition - 4h, ignition + 30m].
//   Lead band:    preferred lead = 30m..3h BEFORE ignition.
//   Clusters:     alerts <= 2h apart chain into one cluster; the cluster's
//                 primary timestamp is its FIRST alert.
//   Credit:       one primary cluster per event, one event per cluster
//                 (nearest ignition). Later timely clusters for the same
//                 event are confirmations/duplicates — they inflate NOTHING.
//   Denominators: recall    = events with a timely primary cluster / eligible events
//                 precision = primary matched clusters / total clusters
//                 bandShare = primary matched clusters with lead in the
//                             preferred band / primary matched clusters
//   Baseline:     random draws of the SAME deduplicated cluster count from
//                 the SAME fixed eligible timestamp pool, re-clustered with
//                 the SAME 2h rule, matched with the SAME rules. Lift =
//                 combo metric minus baseline mean (percentage points).
//   Dependence:   share of recall attributable to any single event is
//                 1/matchedEvents; flagged when matchedEvents <= 2.
'use strict';

(function (root) {

  const CANDLE_MS = 15 * 60 * 1000;

  const STUDY_SPEC = {
    eventThresholdPct: 2.0,
    eventThresholdSensitivityPct: [1.5, 2.5],
    horizonCandles: 48,               // 12h of 15m candles
    mergeGapCandles: 4,
    twoSidedMinPct: 1.0,
    ignitionPct: 0.75,
    ignitionSensitivityPct: 0.5,
    matchWindowBeforeMs: 4 * 3600 * 1000,
    matchWindowAfterMs: 30 * 60 * 1000,
    preferredLeadMinMs: 30 * 60 * 1000,
    preferredLeadMaxMs: 3 * 3600 * 1000,
    clusterDedupeMs: 2 * 3600 * 1000,
    baselineDraws: 1000,
  };

  // ── Event labeling ──────────────────────────────────────────────────────

  /**
   * Max up/down close-to-close excursion (in %) from candle `baseIdx`'s
   * close over the fixed forward horizon (baseIdx+1 .. baseIdx+horizon).
   * Pure; assumes candles sorted ascending with numeric `close`.
   */
  function forwardExcursions(candles, baseIdx, horizonCandles) {
    const basePrice = candles[baseIdx].close;
    let maxUpPct = 0, maxDownPct = 0;
    const last = Math.min(candles.length - 1, baseIdx + horizonCandles);
    for (let i = baseIdx + 1; i <= last; i++) {
      const pct = ((candles[i].close - basePrice) / basePrice) * 100;
      if (pct > maxUpPct) maxUpPct = pct;
      if (pct < maxDownPct) maxDownPct = pct;
    }
    return { maxUpPct, maxDownPct };
  }

  /**
   * Labels expansion events on the candle series per the locked spec.
   * Returns events sorted by baseTs:
   *   { baseIdx, baseTs, ignitionIdx, ignitionTs, direction ('up'|'down'|'two_sided'),
   *     maxUpPct, maxDownPct, dominantExcursionPct }
   * Retrospective and symmetric — identical for every parameter combo.
   */
  function labelExpansionEvents(candles, opts) {
    const o = opts || {};
    const thresholdPct = o.eventThresholdPct != null ? o.eventThresholdPct : STUDY_SPEC.eventThresholdPct;
    const horizon = o.horizonCandles != null ? o.horizonCandles : STUDY_SPEC.horizonCandles;
    const mergeGap = o.mergeGapCandles != null ? o.mergeGapCandles : STUDY_SPEC.mergeGapCandles;
    const ignitionPct = o.ignitionPct != null ? o.ignitionPct : STUDY_SPEC.ignitionPct;
    const twoSidedMinPct = o.twoSidedMinPct != null ? o.twoSidedMinPct : STUDY_SPEC.twoSidedMinPct;
    const list = Array.isArray(candles) ? candles : [];

    // 1) Qualifying anchors — FULL forward horizon required, so events near
    //    the dataset end are excluded rather than partially measured.
    const anchorIdxs = [];
    for (let i = 0; i + horizon < list.length; i++) {
      const exc = forwardExcursions(list, i, horizon);
      if (Math.max(exc.maxUpPct, Math.abs(exc.maxDownPct)) >= thresholdPct) anchorIdxs.push(i);
    }

    // 2) Merge anchor runs across gaps <= mergeGap candles — one continuous
    //    impulse becomes ONE event; base = earliest anchor of the run.
    const events = [];
    let runStart = null, prev = null;
    const flush = () => { if (runStart !== null) events.push(runStart); runStart = null; };
    for (const idx of anchorIdxs) {
      if (runStart === null) { runStart = idx; }
      else if (idx - prev > mergeGap + 1) { flush(); runStart = idx; }
      prev = idx;
    }
    flush();

    // 3) Per event: dominant side + ignition, measured STRICTLY inside the
    //    base's own [base, base+horizon] window.
    return events.map(baseIdx => {
      const basePrice = list[baseIdx].close;
      const exc = forwardExcursions(list, baseIdx, horizon);
      const up = exc.maxUpPct, down = Math.abs(exc.maxDownPct);
      const tied = up === down;
      const twoSided = tied || (up >= twoSidedMinPct && down >= twoSidedMinPct);
      const direction = twoSided ? 'two_sided' : (up > down ? 'up' : 'down');
      const dominantSign = up > down ? 1 : (down > up ? -1 : 0);

      let ignitionIdx = null;
      const last = Math.min(list.length - 1, baseIdx + horizon);
      for (let i = baseIdx + 1; i <= last; i++) {
        const pct = ((list[i].close - basePrice) / basePrice) * 100;
        const hit = twoSided
          ? Math.abs(pct) >= ignitionPct                          // either side
          : (dominantSign > 0 ? pct >= ignitionPct : pct <= -ignitionPct); // dominant side only
        if (hit) { ignitionIdx = i; break; }
      }
      // Guaranteed to exist when ignitionPct < thresholdPct; guard anyway.
      if (ignitionIdx === null) ignitionIdx = last;

      return {
        baseIdx,
        baseTs: list[baseIdx].ts,
        ignitionIdx,
        ignitionTs: list[ignitionIdx].ts,
        direction,
        maxUpPct: exc.maxUpPct,
        maxDownPct: exc.maxDownPct,
        dominantExcursionPct: Math.max(up, down),
      };
    });
  }

  // ── Eligibility ─────────────────────────────────────────────────────────

  /**
   * Fixed, combo-independent eligible timestamp pool: candles where an
   * alert could legally have triggered — inside an active zone AND past the
   * (conservative, combo-independent) warm-up. Zone predicates are injected
   * so this module stays engine-free and Node-testable.
   */
  function computeEligibleTimestamps(candles, zones, deps) {
    const d = deps || {};
    const inZone = d.isPriceInZone, activeAt = d.isZoneTemporallyActive;
    const minIndex = d.minIndex != null ? d.minIndex : 0;
    const list = Array.isArray(candles) ? candles : [];
    const zs = Array.isArray(zones) ? zones : [];
    const out = [];
    for (let i = minIndex; i < list.length; i++) {
      const c = list[i];
      for (const z of zs) {
        if (inZone(c.close, z) && activeAt(z, c.ts)) { out.push(c.ts); break; }
      }
    }
    return out;
  }

  /**
   * An event counts toward recall's denominator only if an alert COULD have
   * legally fired in its match window: at least one eligible timestamp in
   * [ignition - before, ignition + after].
   */
  function filterEligibleEvents(events, eligibleTimestamps, opts) {
    const o = opts || {};
    const before = o.matchWindowBeforeMs != null ? o.matchWindowBeforeMs : STUDY_SPEC.matchWindowBeforeMs;
    const after = o.matchWindowAfterMs != null ? o.matchWindowAfterMs : STUDY_SPEC.matchWindowAfterMs;
    const pool = Array.isArray(eligibleTimestamps) ? eligibleTimestamps : [];
    return (Array.isArray(events) ? events : []).filter(ev =>
      pool.some(ts => ts >= ev.ignitionTs - before && ts <= ev.ignitionTs + after));
  }

  // ── Clustering & matching ───────────────────────────────────────────────

  /**
   * Chains alert timestamps <= dedupeMs apart into clusters. The cluster's
   * PRIMARY timestamp is its first alert. Input need not be sorted.
   */
  function clusterAlertTimestamps(timestamps, dedupeMs) {
    const gap = dedupeMs != null ? dedupeMs : STUDY_SPEC.clusterDedupeMs;
    const sorted = (Array.isArray(timestamps) ? timestamps.slice() : []).sort((a, b) => a - b);
    const clusters = [];
    for (const ts of sorted) {
      const cur = clusters[clusters.length - 1];
      if (cur && ts - cur.memberTs[cur.memberTs.length - 1] <= gap) cur.memberTs.push(ts);
      else clusters.push({ primaryTs: ts, memberTs: [ts] });
    }
    return clusters;
  }

  /**
   * Matches clusters to events per the locked credit rules:
   *  - a cluster is TIMELY for an event when its primary ts falls in
   *    [ignition - before, ignition + after];
   *  - each cluster matches at most ONE event (nearest ignition);
   *  - the FIRST timely cluster per event is the PRIMARY match; later
   *    timely clusters for the same event are duplicates (confirmations)
   *    and inflate neither recall nor precision.
   * leadMs > 0 means the cluster fired BEFORE ignition.
   */
  function matchClustersToEvents(clusters, events, opts) {
    const o = opts || {};
    const before = o.matchWindowBeforeMs != null ? o.matchWindowBeforeMs : STUDY_SPEC.matchWindowBeforeMs;
    const after = o.matchWindowAfterMs != null ? o.matchWindowAfterMs : STUDY_SPEC.matchWindowAfterMs;
    const evs = Array.isArray(events) ? events : [];
    const cls = Array.isArray(clusters) ? clusters : [];
    const primaryByEvent = new Map(); // eventIdx -> {clusterIdx, leadMs}
    const primaries = [];
    const duplicates = [];
    const unmatched = [];

    cls.forEach((cluster, clusterIdx) => {
      let bestEvent = -1, bestDist = Infinity;
      evs.forEach((ev, eventIdx) => {
        const ts = cluster.primaryTs;
        if (ts >= ev.ignitionTs - before && ts <= ev.ignitionTs + after) {
          const dist = Math.abs(ev.ignitionTs - ts);
          if (dist < bestDist) { bestDist = dist; bestEvent = eventIdx; }
        }
      });
      if (bestEvent === -1) { unmatched.push(clusterIdx); return; }
      const leadMs = evs[bestEvent].ignitionTs - cluster.primaryTs;
      if (!primaryByEvent.has(bestEvent)) {
        primaryByEvent.set(bestEvent, { clusterIdx, leadMs });
        primaries.push({ eventIdx: bestEvent, clusterIdx, leadMs });
      } else {
        duplicates.push({ eventIdx: bestEvent, clusterIdx, leadMs });
      }
    });

    return { primaries, duplicates, unmatchedClusterIdxs: unmatched };
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * All locked-spec metrics for one combo's clusters against the eligible
   * events. Explicit denominators (see file header). Pure.
   */
  function computeComboMetrics(clusters, eligibleEvents, opts) {
    const o = opts || {};
    const bandMin = o.preferredLeadMinMs != null ? o.preferredLeadMinMs : STUDY_SPEC.preferredLeadMinMs;
    const bandMax = o.preferredLeadMaxMs != null ? o.preferredLeadMaxMs : STUDY_SPEC.preferredLeadMaxMs;
    const m = matchClustersToEvents(clusters, eligibleEvents, o);
    const eligibleEventCount = eligibleEvents.length;
    const matchedEventCount = m.primaries.length;
    const totalClusters = clusters.length;

    const leads = m.primaries.map(p => p.leadMs);
    const inBand = m.primaries.filter(p => p.leadMs >= bandMin && p.leadMs <= bandMax).length;

    const outcomeMix = { up: 0, down: 0, two_sided: 0 };
    for (const p of m.primaries) outcomeMix[eligibleEvents[p.eventIdx].direction]++;

    return {
      eligibleEventCount,
      matchedEventCount,
      recall: eligibleEventCount > 0 ? matchedEventCount / eligibleEventCount : null,
      totalClusters,
      primaryMatchedClusters: matchedEventCount,
      precision: totalClusters > 0 ? matchedEventCount / totalClusters : null,
      preferredBandShare: matchedEventCount > 0 ? inBand / matchedEventCount : null,
      medianLeadMs: median(leads),
      duplicateClusterCount: m.duplicates.length,
      unmatchedClusterCount: m.unmatchedClusterIdxs.length,
      outcomeMix,
      // Single-event dependence: every matched event contributes equally to
      // recall, so the strongest event's share is 1/matchedEventCount.
      singleEventDependenceShare: matchedEventCount > 0 ? 1 / matchedEventCount : null,
      singleEventDependenceFlag: matchedEventCount > 0 && matchedEventCount <= 2,
      matches: m,
    };
  }

  // ── Random baseline ─────────────────────────────────────────────────────

  /** Deterministic seeded PRNG (mulberry32) so baseline runs are reproducible/testable. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Random baseline per the locked spec, MATCHED ON FINAL CLUSTER COUNT.
   * Naively sampling N raw timestamps then applying the 2h rule can merge
   * nearby picks into fewer than N clusters, unfairly deflating baseline
   * recall (inflating lift). So each draw walks a full shuffle of the SAME
   * fixed eligible pool and greedily accepts picks that are STRICTLY more
   * than clusterDedupeMs from every accepted pick — the exact complement
   * of clusterAlertTimestamps' chaining condition (which merges on
   * `gap <= dedupeMs`, equality included), so the 2h rule then provably
   * changes nothing and each draw ends with exactly N final clusters. The
   * accepted picks are still passed through clusterAlertTimestamps so
   * scoring uses the identical production code path.
   * If the pool cannot support N spaced clusters, the draw keeps its
   * achieved count and the result reports matchedClusterCount: false with
   * achieved-count stats — never silently treated as matched.
   * Memoizable by cluster count ONLY under the same-pool/same-rule
   * assumption (caller states it in the console detail object).
   */
  function runRandomBaseline(eligibleTimestamps, clusterCount, eligibleEvents, opts) {
    const o = opts || {};
    const draws = o.draws != null ? o.draws : STUDY_SPEC.baselineDraws;
    const dedupeMs = o.clusterDedupeMs != null ? o.clusterDedupeMs : STUDY_SPEC.clusterDedupeMs;
    const rng = o.rng || mulberry32(o.seed != null ? o.seed : 1337);
    const pool = Array.isArray(eligibleTimestamps) ? eligibleTimestamps : [];
    if (!pool.length || clusterCount <= 0) {
      return { meanRecall: 0, meanPrecision: 0, draws, requestedClusterCount: clusterCount, matchedClusterCount: false, minAchievedClusters: 0, maxAchievedClusters: 0 };
    }

    let recallSum = 0, precisionSum = 0;
    let minAchieved = Infinity, maxAchieved = -Infinity;
    let allMatched = true;
    for (let d = 0; d < draws; d++) {
      // Full Fisher-Yates shuffle of pool indexes, then greedy spaced picks.
      const idx = pool.map((_, i) => i);
      for (let k = idx.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        const tmp = idx[k]; idx[k] = idx[j]; idx[j] = tmp;
      }
      const accepted = [];
      for (let k = 0; k < idx.length && accepted.length < clusterCount; k++) {
        const ts = pool[idx[k]];
        let spaced = true;
        for (const a of accepted) {
          if (Math.abs(ts - a) <= dedupeMs) { spaced = false; break; } // strict complement of the merge rule
        }
        if (spaced) accepted.push(ts);
      }
      if (accepted.length < clusterCount) allMatched = false;
      if (accepted.length < minAchieved) minAchieved = accepted.length;
      if (accepted.length > maxAchieved) maxAchieved = accepted.length;

      const clusters = clusterAlertTimestamps(accepted, dedupeMs);
      const metrics = computeComboMetrics(clusters, eligibleEvents, o);
      recallSum += metrics.recall !== null ? metrics.recall : 0;
      precisionSum += metrics.precision !== null ? metrics.precision : 0;
    }
    return {
      meanRecall: recallSum / draws,
      meanPrecision: precisionSum / draws,
      draws,
      requestedClusterCount: clusterCount,
      matchedClusterCount: allMatched,
      minAchievedClusters: minAchieved,
      maxAchievedClusters: maxAchieved,
    };
  }

  // ── Parameter grid ──────────────────────────────────────────────────────

  /**
   * The locked 54-combo V2 grid. Everything else stays pinned to the
   * current fixed values (lookback 30d, baseline 2880, min samples 500,
   * V2 model, directional chase excluded).
   * NOTE on rearm: it mostly controls repeat-alert suppression/clustering,
   * not the underlying V2 detection state — row differences across rearm
   * values may reflect duplicate suppression, not better detection. The
   * table labels this.
   */
  function buildParameterGrid() {
    const grid = [];
    for (const entryPercentile of [90, 95, 97.5]) {
      for (const rearmPercentile of [75, 80, 85]) {
        for (const signalWindow of [12, 16, 24]) {
          for (const recency of [false, true]) {
            grid.push({
              entryPercentile,
              rearmPercentile,
              signalWindow,
              oiRecencyFilterEnabled: recency,
              oiRecencyWindow: '1h',
              minimumRecentOIChangePct: 1,
            });
          }
        }
      }
    }
    return grid;
  }

  /**
   * Locked default sort — a CANDIDATE COMPARISON order, not a winner pick:
   * recall-lift desc, then precision-lift desc, then preferred-band share
   * desc, then LOWER cluster count. Pure comparator over result rows.
   */
  function compareStudyRows(a, b) {
    const num = v => (v === null || v === undefined || isNaN(v)) ? -Infinity : v;
    if (num(b.recallLift) !== num(a.recallLift)) return num(b.recallLift) - num(a.recallLift);
    if (num(b.precisionLift) !== num(a.precisionLift)) return num(b.precisionLift) - num(a.precisionLift);
    if (num(b.preferredBandShare) !== num(a.preferredBandShare)) return num(b.preferredBandShare) - num(a.preferredBandShare);
    return a.totalClusters - b.totalClusters;
  }

  const OIExhaustionStudy = {
    STUDY_SPEC,
    CANDLE_MS,
    forwardExcursions,
    labelExpansionEvents,
    computeEligibleTimestamps,
    filterEligibleEvents,
    clusterAlertTimestamps,
    matchClustersToEvents,
    computeComboMetrics,
    median,
    mulberry32,
    runRandomBaseline,
    buildParameterGrid,
    compareStudyRows,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionStudy;
  }
  root.OIExhaustionStudy = OIExhaustionStudy;

})(typeof window !== 'undefined' ? window : globalThis);

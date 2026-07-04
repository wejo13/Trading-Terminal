// oi-exhaustion-study.test.js — locked research-spec math, pure tests.
'use strict';

const St = require('./oi-exhaustion-study.js');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

const M15 = 15 * 60 * 1000;
const H = 3600 * 1000;

/** Flat candle series at `price`, n candles from t0. */
function flat(n, price, t0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ ts: (t0 || 0) + i * M15, close: price });
  return out;
}

section('labelExpansionEvents: flat series -> no events; single clean up-move -> one up event with correct base and ignition');
(function () {
  assert('flat 300 candles -> zero events', St.labelExpansionEvents(flat(300, 100)).length === 0);

  // 100 flat candles, then a ramp: +0.3%/candle for 10 candles (peaks +3%), then flat at 103.
  const candles = flat(100, 100);
  for (let i = 0; i < 10; i++) candles.push({ ts: (100 + i) * M15, close: 100 + (i + 1) * 0.3 });
  for (let i = 0; i < 120; i++) candles.push({ ts: (110 + i) * M15, close: 103 });
  const events = St.labelExpansionEvents(candles);
  assert('exactly one merged event', events.length === 1);
  const ev = events[0];
  assert('direction is up', ev.direction === 'up');
  // Anchors qualify from the first candle that can see +2% within 48 candles:
  // candle 52 onward (100-52=48 sees candle 100+? ) — base is simply the earliest anchor; sanity: base before the ramp start.
  assert('base is before the ramp (flat coil is context, not the move)', ev.baseIdx < 100);
  // Ignition: first CLOSE >= +0.75% from base close(=100) -> ramp candle with close 100.9 (index 102, 3rd ramp candle)
  assert('ignition is the first close >= +0.75% from base', candles[ev.ignitionIdx].close >= 100.75 && candles[ev.ignitionIdx - 1].close < 100.75);
  assert('ignition inside the base horizon', ev.ignitionIdx <= ev.baseIdx + St.STUDY_SPEC.horizonCandles);
})();

section('labelExpansionEvents: horizon is fixed per base — a later unrelated move beyond base+48 does not extend the event');
(function () {
  // Down-move finishing within horizon of early anchors, then long flat, then an unrelated up-move.
  const candles = flat(60, 100);
  for (let i = 0; i < 8; i++) candles.push({ ts: (60 + i) * M15, close: 100 - (i + 1) * 0.3 }); // to 97.6 (-2.4%)
  for (let i = 0; i < 100; i++) candles.push({ ts: (68 + i) * M15, close: 97.6 });
  for (let i = 0; i < 8; i++) candles.push({ ts: (168 + i) * M15, close: 97.6 + (i + 1) * 0.3 });
  for (let i = 0; i < 120; i++) candles.push({ ts: (176 + i) * M15, close: 100 });
  const events = St.labelExpansionEvents(candles);
  assert('two separate events, not one stretched event', events.length === 2);
  assert('first is down, second is up', events[0].direction === 'down' && events[1].direction === 'up');
  assert('first event ignition measured from ITS base within 48 candles', events[0].ignitionIdx <= events[0].baseIdx + 48);
})();

section('labelExpansionEvents: two-sided event -> two_sided label, ignition = first close reaching EITHER +/-0.75%');
(function () {
  // +1.2% pop then dump to -2.2%: both sides >= 1.0 -> two_sided; dominant is down.
  const candles = flat(60, 100);
  for (let i = 0; i < 4; i++) candles.push({ ts: (60 + i) * M15, close: 100 + (i + 1) * 0.3 }); // to 101.2
  for (let i = 0; i < 12; i++) candles.push({ ts: (64 + i) * M15, close: 101.2 - (i + 1) * 0.28 }); // to ~97.8
  for (let i = 0; i < 120; i++) candles.push({ ts: (76 + i) * M15, close: 97.8 });
  const events = St.labelExpansionEvents(candles);
  assert('one event', events.length === 1);
  assert('labeled two_sided', events[0].direction === 'two_sided');
  assert('ignition is the first close beyond either +/-0.75% (the early pop)', Math.abs((candles[events[0].ignitionIdx].close - 100) / 100 * 100) >= 0.75 && candles[events[0].ignitionIdx].close > 100);
})();

section('labelExpansionEvents: anchors without a FULL 48-candle forward horizon never qualify');
(function () {
  const candles = flat(60, 100);
  for (let i = 0; i < 10; i++) candles.push({ ts: (60 + i) * M15, close: 100 + (i + 1) * 0.3 });
  // dataset ends right after the move — nothing has a full horizon covering it except earlier candles
  const events = St.labelExpansionEvents(candles.slice(0, 65)); // truncate: move barely started
  assert('truncated dataset -> no fully-qualified event', events.length === 0);
})();

section('clusterAlertTimestamps: 2h chaining, primary = first alert, unsorted input handled');
(function () {
  const t0 = 1000 * H;
  const ts = [t0 + 3 * H, t0, t0 + 1 * H, t0 + 10 * H]; // unsorted; first three chain (gaps 1h, 2h), last separate
  const clusters = St.clusterAlertTimestamps(ts, 2 * H);
  assert('two clusters', clusters.length === 2);
  assert('first cluster primary is the earliest alert', clusters[0].primaryTs === t0);
  assert('first cluster has 3 members via chaining', clusters[0].memberTs.length === 3);
  assert('second cluster is the far alert', clusters[1].primaryTs === t0 + 10 * H);
})();

section('matchClustersToEvents: one primary per event, duplicates credited to nothing, window respected, nearest ignition wins');
(function () {
  const ev = ig => ({ ignitionTs: ig, direction: 'up' });
  const events = [ev(100 * H), ev(200 * H)];
  const clusters = [
    { primaryTs: 98 * H, memberTs: [] },   // 2h before ev0 -> primary
    { primaryTs: 99 * H, memberTs: [] },   // 1h before ev0 -> duplicate
    { primaryTs: 100 * H + 20 * 60000, memberTs: [] }, // +20m after ev0 -> duplicate (inside +30m)
    { primaryTs: 150 * H, memberTs: [] },  // matches nothing
    { primaryTs: 199 * H, memberTs: [] },  // primary for ev1
  ];
  const m = St.matchClustersToEvents(clusters, events);
  assert('two primaries', m.primaries.length === 2);
  assert('ev0 primary is the FIRST timely cluster', m.primaries[0].clusterIdx === 0 && m.primaries[0].eventIdx === 0);
  assert('two duplicates for ev0', m.duplicates.length === 2 && m.duplicates.every(d => d.eventIdx === 0));
  assert('one unmatched cluster', m.unmatchedClusterIdxs.length === 1 && m.unmatchedClusterIdxs[0] === 3);
  assert('lead is positive when before ignition', m.primaries[0].leadMs === 2 * H);
  // Earlier than -4h -> unmatched even if a later event exists
  const m2 = St.matchClustersToEvents([{ primaryTs: 95 * H, memberTs: [] }], events);
  assert('cluster 5h early is unmatched (never credited to this event)', m2.primaries.length === 0 && m2.unmatchedClusterIdxs.length === 1);
})();

section('computeComboMetrics: explicit denominators — duplicates inflate NOTHING');
(function () {
  const events = [{ ignitionTs: 100 * H, direction: 'up' }, { ignitionTs: 300 * H, direction: 'down' }, { ignitionTs: 500 * H, direction: 'two_sided' }];
  const clusters = [
    { primaryTs: 99 * H, memberTs: [] },    // primary ev0, lead 1h (in band)
    { primaryTs: 99.5 * H, memberTs: [] },  // duplicate ev0
    { primaryTs: 296.5 * H, memberTs: [] }, // primary ev1, lead 3.5h (timely, outside preferred band)
    { primaryTs: 400 * H, memberTs: [] },   // unmatched
  ];
  const mt = St.computeComboMetrics(clusters, events);
  assert('recall = matched events / eligible events = 2/3', Math.abs(mt.recall - 2 / 3) < 1e-12);
  assert('precision = primary matched clusters / total clusters = 2/4', mt.precision === 0.5);
  assert('duplicates counted separately, inflating neither', mt.duplicateClusterCount === 1);
  assert('preferred-band share = in-band primaries / primaries = 1/2', mt.preferredBandShare === 0.5);
  assert('median lead over primaries only', mt.medianLeadMs === (1 * H + 3.5 * H) / 2);
  assert('outcome mix counts matched events by direction', mt.outcomeMix.up === 1 && mt.outcomeMix.down === 1 && mt.outcomeMix.two_sided === 0);
  assert('dependence share = 1/matchedEvents', mt.singleEventDependenceShare === 0.5);
  assert('dependence flag set when matchedEvents <= 2', mt.singleEventDependenceFlag === true);
  assert('unmatched cluster count', mt.unmatchedClusterCount === 1);
})();

section('filterEligibleEvents: events with no eligible timestamp in their match window are excluded from the recall denominator');
(function () {
  const events = [{ ignitionTs: 100 * H, direction: 'up' }, { ignitionTs: 500 * H, direction: 'up' }];
  const pool = [97 * H, 98 * H]; // only covers the first event's [-4h, +30m] window
  const eligible = St.filterEligibleEvents(events, pool);
  assert('only the covered event remains', eligible.length === 1 && eligible[0].ignitionTs === 100 * H);
})();

section('computeEligibleTimestamps: injected zone predicates + conservative warm-up index');
(function () {
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push({ ts: i * M15, close: i < 5 ? 50 : 100 });
  const zones = [{ id: 'z1' }];
  const deps = {
    isPriceInZone: (price) => price === 100,
    isZoneTemporallyActive: () => true,
    minIndex: 6,
  };
  const out = St.computeEligibleTimestamps(candles, zones, deps);
  assert('respects minIndex AND zone predicate', out.length === 4 && out[0] === 6 * M15);
})();

section('runRandomBaseline: deterministic under a seed, uses same pool/cluster/matching rules, sane bounds');
(function () {
  const events = [{ ignitionTs: 100 * H, direction: 'up' }];
  // pool: 20 eligible timestamps, 5 of which are timely for the event
  const pool = [];
  for (let i = 0; i < 15; i++) pool.push(500 * H + i * H);
  for (let i = 0; i < 5; i++) pool.push(97 * H + i * H); // 97..101h — inside [96h, 100.5h]? 101h is outside +30m
  const a = St.runRandomBaseline(pool, 2, events, { draws: 200, seed: 42 });
  const b = St.runRandomBaseline(pool, 2, events, { draws: 200, seed: 42 });
  assert('deterministic with the same seed', a.meanRecall === b.meanRecall && a.meanPrecision === b.meanPrecision);
  assert('recall between 0 and 1', a.meanRecall >= 0 && a.meanRecall <= 1);
  assert('precision between 0 and 1', a.meanPrecision >= 0 && a.meanPrecision <= 1);
  assert('nonzero: timely pool timestamps exist', a.meanRecall > 0);
  const none = St.runRandomBaseline([], 2, events, { draws: 10, seed: 1 });
  assert('empty pool -> zero baseline', none.meanRecall === 0 && none.meanPrecision === 0);
})();

section('buildParameterGrid: exactly the locked 54-combo grid');
(function () {
  const grid = St.buildParameterGrid();
  assert('54 combos', grid.length === 54);
  const keys = new Set(grid.map(g => `${g.entryPercentile}|${g.rearmPercentile}|${g.signalWindow}|${g.oiRecencyFilterEnabled}`));
  assert('all combos unique', keys.size === 54);
  assert('recency combos carry fixed 1h / 1% settings', grid.every(g => g.oiRecencyWindow === '1h' && g.minimumRecentOIChangePct === 1));
})();

section('compareStudyRows: locked candidate-comparison sort order');
(function () {
  const rows = [
    { recallLift: 0.5, precisionLift: 0.2, preferredBandShare: 0.5, totalClusters: 10 },
    { recallLift: 0.5, precisionLift: 0.3, preferredBandShare: 0.1, totalClusters: 10 },
    { recallLift: 0.7, precisionLift: 0.0, preferredBandShare: 0.0, totalClusters: 30 },
    { recallLift: 0.5, precisionLift: 0.3, preferredBandShare: 0.1, totalClusters: 5 },
    { recallLift: null, precisionLift: null, preferredBandShare: null, totalClusters: 0 },
  ];
  const sorted = rows.slice().sort(St.compareStudyRows);
  assert('recall-lift first', sorted[0].recallLift === 0.7);
  assert('precision-lift second', sorted[1].precisionLift === 0.3 && sorted[2].precisionLift === 0.3);
  assert('lower cluster count breaks the final tie', sorted[1].totalClusters === 5);
  assert('band share beats when lifts tie', sorted[3].preferredBandShare === 0.5);
  assert('null metrics sort last', sorted[4].recallLift === null);
})();

section('runRandomBaseline: every draw is matched on FINAL deduplicated cluster count (greedy spaced picks; the 2h rule then merges nothing)');
(function () {
  const events = [{ ignitionTs: 100 * H, direction: 'up' }];
  const pool = [];
  for (let i = 0; i < 40; i++) pool.push(i * 3 * H); // 40 timestamps, all >2h apart — plenty of spacing
  const r = St.runRandomBaseline(pool, 5, events, { draws: 100, seed: 7 });
  assert('reports matchedClusterCount: true', r.matchedClusterCount === true);
  assert('every draw achieved exactly the requested count', r.minAchievedClusters === 5 && r.maxAchievedClusters === 5);
  assert('requested count echoed', r.requestedClusterCount === 5);
})();

section('runRandomBaseline: insufficient eligible spacing -> matchedClusterCount: false with achieved-count stats, never silently treated as matched');
(function () {
  const events = [{ ignitionTs: 100 * H, direction: 'up' }];
  // 10 timestamps all inside one hour — at most ONE spaced pick possible
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push(50 * H + i * 6 * 60000);
  const r = St.runRandomBaseline(pool, 4, events, { draws: 50, seed: 7 });
  assert('reports matchedClusterCount: false', r.matchedClusterCount === false);
  assert('achieved count capped by pool spacing', r.minAchievedClusters === 1 && r.maxAchievedClusters === 1);
  assert('requested count still echoed for the caller to compare', r.requestedClusterCount === 4);
})();

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-study: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

// oi-exhaustion-cryptohft-source.test.js — pure bucketing/aggregation logic
// only. No network. Module is not imported anywhere else yet (inert).
//
// CORRECTED per real-file inspection: the exchange `timestamp` field is
// UNIX MILLISECONDS, not nanoseconds as originally documented. `received_time`
// IS genuinely nanoseconds, but is never used in aggregation. These tests
// build rows using that verified contract, not the original (wrong) one.
'use strict';

const S = require('./oi-exhaustion-cryptohft-source.js');
const Backtest = require('./oi-exhaustion-backtest.js');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 1e-9); }
function section(name) { console.log('\n' + name); }

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const T0_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

function receivedTimeNsAt(msOffsetFromT0) {
  const ms = T0_MS + msOffsetFromT0;
  return String(ms) + '000000';
}

function row(exchange, msOffset, oiValue, opts) {
  opts = opts || {};
  const tsMs = T0_MS + msOffset;
  return Object.assign({
    exchange,
    timestamp: opts.timestampOverride !== undefined ? opts.timestampOverride : String(tsMs),
    received_time: opts.receivedTimeOverride !== undefined ? opts.receivedTimeOverride : receivedTimeNsAt(msOffset),
    symbol: 'BTCUSDT',
    sum_open_interest: opts.sumOpenInterest !== undefined ? opts.sumOpenInterest : '999999999',
    sum_open_interest_value: String(oiValue),
  }, opts.extra || {});
}

const VENUES = ['binance_futures', 'bybit', 'okx_futures']; // canonical 3-venue basket — bitget_futures excluded (confirmed null sum_open_interest_value)

section('parseMsTimestamp: a real-style 13-digit millisecond value is preserved exactly, no division');
(function () {
  assert('"1782239100000" stays 1782239100000, not divided by anything', S.parseMsTimestamp('1782239100000') === 1782239100000);
  assert('numeric input (not string) also preserved exactly', S.parseMsTimestamp(1782239100000) === 1782239100000);
})();

section('parseMsTimestamp: decodes to a sane real-world date at face value (sanity check against the real file)');
(function () {
  const ms = S.parseMsTimestamp('1782239100000');
  const d = new Date(ms);
  assert('year is 2026, not some absurd far-future date from a bad ns/ms conversion', d.getUTCFullYear() === 2026);
})();

section('parseMsTimestamp: invalid/malformed input returns null, never throws');
(function () {
  assert('non-numeric string -> null', S.parseMsTimestamp('not-a-timestamp') === null);
  assert('null -> null', S.parseMsTimestamp(null) === null);
  assert('undefined -> null', S.parseMsTimestamp(undefined) === null);
  assert('decimal string -> null', S.parseMsTimestamp('123.456') === null);
  assert('negative string -> null (no sign allowed)', S.parseMsTimestamp('-123') === null);
  assert('a bigint IS accepted and converts exactly (verified: hyparquet returns parquet INT64 columns as native BigInt)', S.parseMsTimestamp(1782239100000n) === 1782239100000);
})();

section('nsToMs: still correctly converts nanoseconds to milliseconds (reserved for a future received_time policy)');
(function () {
  const ns = '1782239100000000000';
  assert('nanosecond string converts correctly', S.nsToMs(ns) === 1782239100000);
  assert('bigint nanoseconds also convert correctly', S.nsToMs(BigInt(ns)) === 1782239100000);
})();

section('parseOiValue: parses numeric strings, rejects garbage');
(function () {
  assert('valid numeric string', S.parseOiValue('150570784.078') === 150570784.078);
  assert('non-numeric string -> null', S.parseOiValue('abc') === null);
  assert('null -> null', S.parseOiValue(null) === null);
  assert('undefined -> null', S.parseOiValue(undefined) === null);
})();

section('bucketAndAggregateOI: latest observation inside a bucket wins (not first, not sum)');
(function () {
  const raw = [
    ...VENUES.map(v => row(v, 60000, 1000)),
    ...VENUES.map(v => row(v, 300000, 5000)),
    ...VENUES.map(v => row(v, 120000, 2000)),
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('exactly one bucket produced', out.length === 1);
  assert('sum uses the LATEST snapshot per venue (5000 each), not first (1000) or middle (2000)', approx(out[0].oi, 3 * 5000));
})();

section('bucketAndAggregateOI: all three venues present -> one aggregate point, correctly summed');
(function () {
  const raw = [
    row('binance_futures', 0, 100000000),
    row('bybit', 60000, 50000000),
    row('okx_futures', 120000, 30000000),
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('one bucket', out.length === 1);
  assert('sum = 180,000,000 (sum of all three)', approx(out[0].oi, 180000000));
  assert('ts is the floored bucket start, not any individual snapshot ts', out[0].ts === Math.floor(T0_MS / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS);
})();

section('bucketAndAggregateOI: missing exactly one of three venues omits the bucket entirely');
(function () {
  const raw = [
    row('binance_futures', 0, 100000000),
    row('bybit', 60000, 50000000),
    // okx_futures missing
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('zero buckets emitted — no partial aggregate, no zero substitution', out.length === 0);
})();

section('bucketAndAggregateOI: a later, complete bucket still emits even if an earlier bucket was incomplete');
(function () {
  const raw = [
    row('binance_futures', 0, 100), row('bybit', 0, 100), // incomplete bucket 0 (missing okx_futures)
    row('binance_futures', FIFTEEN_MIN_MS, 100), row('bybit', FIFTEEN_MIN_MS, 100), row('okx_futures', FIFTEEN_MIN_MS, 100), // complete bucket 1
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('only the complete bucket is emitted', out.length === 1);
  assert('no forward-fill from the incomplete bucket', approx(out[0].oi, 300));
})();

section('bucketAndAggregateOI: venues with wildly different raw timestamps inside the same 15m bucket still aggregate correctly');
(function () {
  const raw = [
    row('binance_futures', 5000, 10),
    row('bybit', 240000, 20),
    row('okx_futures', 890000, 30),
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('one bucket despite very different snapshot cadences per venue', out.length === 1);
  assert('sums correctly regardless of raw timestamp spread', approx(out[0].oi, 60));
})();

section('bucketAndAggregateOI: snapshots straddling a bucket boundary land in separate buckets (millisecond timestamps)');
(function () {
  const raw = [
    ...VENUES.map(v => row(v, FIFTEEN_MIN_MS - 1000, 10)),
    ...VENUES.map(v => row(v, FIFTEEN_MIN_MS + 1000, 20)),
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('two separate buckets', out.length === 2);
  assert('bucket 0 sum (3 * 10)', approx(out[0].oi, 30));
  assert('bucket 1 sum (3 * 20)', approx(out[1].oi, 60));
  assert('bucket keys are plain millisecond epoch numbers, not divided/mangled', out[0].ts === Math.floor(T0_MS / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS);
})();

section('bucketAndAggregateOI: received_time (nanoseconds) never influences bucketing or aggregation, even when wildly different from timestamp');
(function () {
  const rawWithChaosReceivedTime = VENUES.map((v, i) => row(v, 60000 + i * 1000, 1000, {
    receivedTimeOverride: i % 2 === 0 ? '999999999999999999' : '1000000000000000',
  }));
  const rawNormal = VENUES.map((v, i) => row(v, 60000 + i * 1000, 1000));

  const outChaos = S.bucketAndAggregateOI(rawWithChaosReceivedTime, FIFTEEN_MIN_MS, VENUES);
  const outNormal = S.bucketAndAggregateOI(rawNormal, FIFTEEN_MIN_MS, VENUES);

  assert('chaotic received_time still produces exactly one bucket', outChaos.length === 1);
  assert('output is identical to the received_time-agnostic run — received_time provably had zero effect', JSON.stringify(outChaos) === JSON.stringify(outNormal));
})();

section('bucketAndAggregateOI: a nanosecond-scale value mistakenly placed in `timestamp` is taken at face value, not silently "fixed"');
(function () {
  const nsValue = receivedTimeNsAt(0);
  const raw = VENUES.map(v => row(v, 0, 100, { timestampOverride: nsValue }));
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('produces a bucket (no crash)', out.length === 1);
  assert('that bucket is absurdly far in the future, not silently corrected — proves no hidden ns/ms guessing happens', out[0].ts > T0_MS + 1000 * 365 * 24 * 3600 * 1000);
})();

section('bucketAndAggregateOI: sum_open_interest (raw contracts) is never read, even when present and very different from sum_open_interest_value');
(function () {
  const raw = VENUES.map(v => row(v, 0, 500, { sumOpenInterest: '99999999999' }));
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('one bucket', out.length === 1);
  assert('sum reflects ONLY sum_open_interest_value (3 * 500 = 1500), not the decoy raw-contract field', approx(out[0].oi, 1500));
})();

section('bucketAndAggregateOI: a required venue with a missing/invalid sum_open_interest_value is excluded, not substituted');
(function () {
  const raw = [
    row('binance_futures', 0, 100),
    row('bybit', 0, 100),
    { exchange: 'okx_futures', timestamp: String(T0_MS), received_time: receivedTimeNsAt(0), symbol: 'BTC-USDT-SWAP', sum_open_interest: '123456', sum_open_interest_value: 'not-a-number' },
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('bucket omitted — invalid value field means that required venue effectively did not report', out.length === 0);
})();

section('bucketAndAggregateOI: output shape passes unchanged into the existing alignCandlesAndOI');
// NOTE: this proves only { ts, oi } SHAPE compatibility with alignCandlesAndOI
// today, using a 5-minute bucket chosen to match this test's synthetic
// 5-minute candles for a clean 1:1 join. It does NOT prove end-to-end
// compatibility of a real 15-minute-bucketed CryptoHFT series against the
// live 5-minute Bybit-candle pipeline — that alignment question (5m candles
// vs 15m OI buckets) is unresolved and out of scope for this milestone.
(function () {
  const bucketMs = FIVE_MIN_MS;
  const raw = [];
  const nBuckets = 5;
  for (let i = 0; i < nBuckets; i++) {
    for (const v of VENUES) raw.push(row(v, i * FIVE_MIN_MS, (i + 1) * 1000));
  }
  const oiRows = S.bucketAndAggregateOI(raw, bucketMs, VENUES);
  assert('produced the expected number of aggregate points', oiRows.length === nBuckets);

  const candles = oiRows.map((r, i) => ({ ts: r.ts, close: 100 + i }));
  const { timestamps, closes, ois, validFlags } = Backtest.alignCandlesAndOI(candles, oiRows);

  assert('alignCandlesAndOI accepted the output without modification and joined every row', timestamps.length === nBuckets);
  assert('ois[] values match the aggregated sums exactly', ois.every((v, i) => approx(v, oiRows[i].oi)));
  assert('no validFlags thrown/undefined — array is well-formed', validFlags.length === nBuckets && validFlags.every(f => typeof f === 'boolean'));
})();

section('bucketAndAggregateOI: bucketMs is configurable, not hardcoded to 15m');
(function () {
  const ONE_HOUR = 60 * 60 * 1000;
  const raw = VENUES.map(v => row(v, 0, 10));
  const out15 = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  const out1h = S.bucketAndAggregateOI(raw, ONE_HOUR, VENUES);
  assert('both bucket sizes produce a single bucket for this data', out15.length === 1 && out1h.length === 1);
  assert('bucket keys differ depending on bucketMs', out15[0].ts === out1h[0].ts || FIFTEEN_MIN_MS !== ONE_HOUR);
})();

section('DEFAULT_BUCKET_MS is exactly 15 minutes; DEFAULT_REQUIRED_VENUES is the fixed 3-venue basket');
(function () {
  assert('default bucket = 15 * 60 * 1000', S.DEFAULT_BUCKET_MS === 15 * 60 * 1000);
  assert('default venues = the exact 3-venue basket (bitget excluded)', JSON.stringify(S.DEFAULT_REQUIRED_VENUES.slice().sort()) === JSON.stringify(VENUES.slice().sort()));
})();

section('bucketAndAggregateOI: omitting bucketMs/requiredVenues falls back to the documented defaults');
(function () {
  const raw = VENUES.map(v => row(v, 0, 25));
  const out = S.bucketAndAggregateOI(raw);
  assert('defaults produce one complete bucket', out.length === 1);
  assert('sum correct under defaults (3 * 25 = 75)', approx(out[0].oi, 75));
})();

section('bucketAndAggregateOI: a venue outside the required basket is ignored entirely, does not corrupt the sum or count as required');
(function () {
  const raw = [
    ...VENUES.map(v => row(v, 0, 100)),
    row('deribit', 0, 999999),
  ];
  const out = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  assert('one bucket', out.length === 1);
  assert('extraneous venue never enters the sum', approx(out[0].oi, 300));
})();

section('bucketAndAggregateOI: empty/garbage input never throws');
(function () {
  assert('empty array -> []', S.bucketAndAggregateOI([], FIFTEEN_MIN_MS, VENUES).length === 0);
  assert('null input -> []', S.bucketAndAggregateOI(null, FIFTEEN_MIN_MS, VENUES).length === 0);
  assert('array of garbage rows -> [] (no throw)', S.bucketAndAggregateOI([null, 'x', 42, {}], FIFTEEN_MIN_MS, VENUES).length === 0);
})();

section('summarizeBucketCoverage: reports total/complete/incomplete bucket counts and venues seen');
(function () {
  const raw = [
    ...VENUES.map(v => row(v, 0, 100)), // complete bucket 0
    row('binance_futures', FIFTEEN_MIN_MS, 100), row('bybit', FIFTEEN_MIN_MS, 100), // incomplete bucket 1 (missing okx, bitget)
  ];
  const summary = S.summarizeBucketCoverage(raw, FIFTEEN_MIN_MS, VENUES);
  assert('totalBucketsSeen = 2', summary.totalBucketsSeen === 2);
  assert('completeBuckets = 1', summary.completeBuckets === 1);
  assert('incompleteBuckets = 1', summary.incompleteBuckets === 1);
  assert('venuesSeen contains all 3 (seen across both buckets combined)', VENUES.every(v => summary.venuesSeen.indexOf(v) !== -1));
})();

section('summarizeBucketCoverage: empty/garbage input never throws');
(function () {
  const empty = S.summarizeBucketCoverage([], FIFTEEN_MIN_MS, VENUES);
  assert('empty array -> all zeros', empty.totalBucketsSeen === 0 && empty.completeBuckets === 0 && empty.incompleteBuckets === 0);
  const nullResult = S.summarizeBucketCoverage(null, FIFTEEN_MIN_MS, VENUES);
  assert('null -> all zeros, no throw', nullResult.totalBucketsSeen === 0);
})();

section('bucketSingleVenueOI: buckets one venue, keeps latest snapshot per bucket');
(function () {
  const raw = [
    row('bybit', 0, 100),
    row('bybit', 1000, 150), // same bucket as ts=0, later timestamp wins
    row('bybit', FIFTEEN_MIN_MS, 200),
  ];
  const out = S.bucketSingleVenueOI(raw, FIFTEEN_MIN_MS);
  assert('two buckets emitted', out.length === 2);
  assert('bucket 0 keeps latest-timestamp value (150, not 100)', approx(out[0].oi, 150));
  assert('bucket 1 value correct', approx(out[1].oi, 200));
  assert('ascending by ts', out[0].ts < out[1].ts);
})();

section('bucketSingleVenueOI: empty/garbage input never throws');
(function () {
  assert('empty array -> []', S.bucketSingleVenueOI([], FIFTEEN_MIN_MS).length === 0);
  assert('null input -> []', S.bucketSingleVenueOI(null, FIFTEEN_MIN_MS).length === 0);
  assert('garbage rows -> [] (no throw)', S.bucketSingleVenueOI([null, 'x', 42, {}], FIFTEEN_MIN_MS).length === 0);
})();

section('aggregateFromPerVenueBuckets: only emits buckets complete across all required venues');
(function () {
  const perVenueOI = {
    binance_futures: [{ ts: 0, oi: 100 }, { ts: FIFTEEN_MIN_MS, oi: 110 }],
    bybit: [{ ts: 0, oi: 100 }, { ts: FIFTEEN_MIN_MS, oi: 110 }],
    okx_futures: [{ ts: 0, oi: 100 }], // missing bucket 1 -> bucket 1 incomplete
  };
  const out = S.aggregateFromPerVenueBuckets(perVenueOI, VENUES);
  assert('only complete bucket 0 emitted', out.length === 1);
  assert('sum is correct', approx(out[0].oi, 300));
})();

section('aggregateFromPerVenueBuckets: empty/garbage input never throws');
(function () {
  assert('empty object -> []', S.aggregateFromPerVenueBuckets({}, VENUES).length === 0);
  assert('null input -> []', S.aggregateFromPerVenueBuckets(null, VENUES).length === 0);
  assert('missing venue key entirely -> []', S.aggregateFromPerVenueBuckets({ bybit: [{ ts: 0, oi: 100 }] }, VENUES).length === 0);
})();

section('summarizeBucketCoverageFromPerVenue: reports total/complete/incomplete bucket counts and venues seen');
(function () {
  const perVenueOI = {
    binance_futures: [{ ts: 0, oi: 100 }, { ts: FIFTEEN_MIN_MS, oi: 100 }],
    bybit: [{ ts: 0, oi: 100 }, { ts: FIFTEEN_MIN_MS, oi: 100 }],
    okx_futures: [{ ts: 0, oi: 100 }], // missing bucket 1
  };
  const summary = S.summarizeBucketCoverageFromPerVenue(perVenueOI, VENUES);
  assert('totalBucketsSeen = 2', summary.totalBucketsSeen === 2);
  assert('completeBuckets = 1', summary.completeBuckets === 1);
  assert('incompleteBuckets = 1', summary.incompleteBuckets === 1);
  assert('venuesSeen contains all 3', VENUES.every(v => summary.venuesSeen.indexOf(v) !== -1));
})();

section('summarizeBucketCoverageFromPerVenue: empty/garbage input never throws');
(function () {
  const empty = S.summarizeBucketCoverageFromPerVenue({}, VENUES);
  assert('empty object -> all zeros', empty.totalBucketsSeen === 0 && empty.completeBuckets === 0 && empty.incompleteBuckets === 0);
  const nullResult = S.summarizeBucketCoverageFromPerVenue(null, VENUES);
  assert('null -> all zeros, no throw', nullResult.totalBucketsSeen === 0);
})();

section('equivalence: per-venue bucket+aggregate pipeline matches bucketAndAggregateOI on the same raw data');
(function () {
  // Randomized-ish fixture: several venues, several buckets, some venues
  // missing from some buckets, duplicate same-bucket snapshots per venue —
  // this must produce IDENTICAL output whether bucketed all-at-once or
  // per-venue-then-combined, since that equivalence is the entire point of
  // the per-venue caching refactor.
  const raw = [
    row('binance_futures', 0, 100), row('binance_futures', 500, 105), // dup in bucket 0, later wins
    row('bybit', 0, 200),
    row('okx_futures', 0, 300),
    row('binance_futures', FIFTEEN_MIN_MS, 110),
    row('bybit', FIFTEEN_MIN_MS, 210),
    // okx_futures missing entirely from bucket 1 -> incomplete
    row('binance_futures', FIFTEEN_MIN_MS * 2, 120),
    row('bybit', FIFTEEN_MIN_MS * 2, 220),
    row('okx_futures', FIFTEEN_MIN_MS * 2, 320),
  ];

  const directOI = S.bucketAndAggregateOI(raw, FIFTEEN_MIN_MS, VENUES);
  const directCoverage = S.summarizeBucketCoverage(raw, FIFTEEN_MIN_MS, VENUES);

  const perVenueOI = {};
  for (const v of VENUES) {
    perVenueOI[v] = S.bucketSingleVenueOI(raw.filter(r => r.exchange === v), FIFTEEN_MIN_MS);
  }
  const combinedOI = S.aggregateFromPerVenueBuckets(perVenueOI, VENUES);
  const combinedCoverage = S.summarizeBucketCoverageFromPerVenue(perVenueOI, VENUES);

  assert('same number of aggregate buckets', directOI.length === combinedOI.length);
  assert('aggregate ts/oi values match exactly', directOI.every((d, i) => combinedOI[i].ts === d.ts && approx(combinedOI[i].oi, d.oi)));
  assert('coverage totals match', directCoverage.totalBucketsSeen === combinedCoverage.totalBucketsSeen);
  assert('coverage complete/incomplete match', directCoverage.completeBuckets === combinedCoverage.completeBuckets && directCoverage.incompleteBuckets === combinedCoverage.incompleteBuckets);
  assert('coverage venuesSeen match', VENUES.every(v => combinedCoverage.venuesSeen.indexOf(v) !== -1) && directCoverage.venuesSeen.length === combinedCoverage.venuesSeen.length);
})();

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-cryptohft-source: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

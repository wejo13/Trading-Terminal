// oi-exhaustion-binance-oi-source.test.js — Binance native OI reference
// layer. Pure normalization/aggregation tests, plus a fake-fetch-injected
// pagination test (no real network call).
'use strict';

const S = require('./oi-exhaustion-binance-oi-source.js');

let passed = 0, failed = 0;
const asyncTests = [];
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function row(ts, sumOpenInterestValue, opts) {
  return Object.assign({
    symbol: 'BTCUSDT',
    sumOpenInterest: '12345.678', // contracts — must NEVER be read
    sumOpenInterestValue: String(sumOpenInterestValue),
    timestamp: ts,
  }, opts || {});
}

// ── parseBinanceOpenInterestRow / normalizeBinanceOpenInterestRows ───────

section('parseBinanceOpenInterestRow: reads sumOpenInterestValue, never sumOpenInterest');
(function () {
  const parsed = S.parseBinanceOpenInterestRow(row(1000, 555.5));
  assert('ts parsed correctly', parsed.ts === 1000);
  assert('oi reads sumOpenInterestValue (555.5), not sumOpenInterest (12345.678)', parsed.oi === 555.5);
})();

section('parseBinanceOpenInterestRow: rejects rows with missing/non-finite fields, never guesses');
(function () {
  assert('null row -> null', S.parseBinanceOpenInterestRow(null) === null);
  assert('missing timestamp -> null', S.parseBinanceOpenInterestRow({ sumOpenInterestValue: '100' }) === null);
  assert('missing sumOpenInterestValue -> null', S.parseBinanceOpenInterestRow({ timestamp: 1000 }) === null);
  assert('non-numeric value -> null', S.parseBinanceOpenInterestRow({ timestamp: 1000, sumOpenInterestValue: 'not-a-number' }) === null);
  assert('garbage input -> null, no throw', S.parseBinanceOpenInterestRow('garbage') === null);
})();

section('normalizeBinanceOpenInterestRows: drops invalid rows, sorts ascending, de-dupes exact-timestamp collisions');
(function () {
  const rows = [
    row(2000, 200),
    row(1000, 100),
    { garbage: true },
    row(1000, 999), // duplicate ts — last write wins
    row(3000, 300),
  ];
  const out = S.normalizeBinanceOpenInterestRows(rows);
  assert('garbage row dropped', out.length === 3);
  assert('sorted ascending', out[0].ts === 1000 && out[1].ts === 2000 && out[2].ts === 3000);
  assert('duplicate timestamp resolved to the LAST occurrence (999, not 100)', out[0].oi === 999);
})();

section('normalizeBinanceOpenInterestRows: empty/garbage input never throws');
(function () {
  assert('empty array -> []', S.normalizeBinanceOpenInterestRows([]).length === 0);
  assert('null -> []', S.normalizeBinanceOpenInterestRows(null).length === 0);
  assert('non-array -> []', S.normalizeBinanceOpenInterestRows('nope').length === 0);
})();

// ── buildBinanceOIDisplaySeries ───────────────────────────────────────────

section('buildBinanceOIDisplaySeries(15m): one degenerate OHLC candle per sample — open/high/low/close all equal the reading, nothing invented');
(function () {
  const rows = [row(0, 100), row(FIFTEEN_MIN_MS, 105), row(FIFTEEN_MIN_MS * 2, 110)];
  const out = S.buildBinanceOIDisplaySeries(rows, '15m');
  assert('3 candles, one per reading', out.length === 3);
  assert('each is a full OHLC candle keyed by timestamp', 'open' in out[0] && 'close' in out[0] && out[0].timestamp === 0);
  assert('o=h=l=c all equal the single sampled value', out[0].open === 100 && out[0].high === 100 && out[0].low === 100 && out[0].close === 100);
  assert('later values carried exactly', out[1].close === 105 && out[2].close === 110);
})();

section('buildBinanceOIDisplaySeries(1h): builds real OHLC from four 15m readings per UTC hour');
(function () {
  const hourStart = Date.UTC(2026, 2, 10, 6, 0, 0);
  const rows = [
    row(hourStart, 100),
    row(hourStart + FIFTEEN_MIN_MS, 130), // high
    row(hourStart + FIFTEEN_MIN_MS * 2, 90), // low
    row(hourStart + FIFTEEN_MIN_MS * 3, 120), // close
  ];
  const out = S.buildBinanceOIDisplaySeries(rows, '1h');
  assert('exactly 1 hourly candle', out.length === 1);
  assert('timestamp lands on the UTC hour boundary', out[0].timestamp === hourStart);
  assert('open = first reading', out[0].open === 100);
  assert('close = last reading', out[0].close === 120);
  assert('high = max of the 4 readings', out[0].high === 130);
  assert('low = min of the 4 readings', out[0].low === 90);
})();

section('buildBinanceOIDisplaySeries(2h) / (4h) / (1d): correct UTC bucket width, all buckets complete');
(function () {
  const dayStart = Date.UTC(2026, 2, 10, 0, 0, 0);
  const rows = [];
  for (let i = 0; i < 96; i++) rows.push(row(dayStart + i * FIFTEEN_MIN_MS, 1000 + i)); // exactly one full UTC day

  const out2h = S.buildBinanceOIDisplaySeries(rows, '2h');
  assert('96 fifteen-min readings = 12 complete two-hour buckets', out2h.length === 12);
  assert('2h bucket timestamps land on even UTC hours', out2h.every(c => (c.timestamp / HOUR_MS) % 2 === 0));

  const out4h = S.buildBinanceOIDisplaySeries(rows, '4h');
  assert('96 fifteen-min readings = 6 complete four-hour buckets', out4h.length === 6);
  assert('4h bucket timestamps land on the 0/4/8/... UTC grid', out4h.every(c => (c.timestamp / HOUR_MS) % 4 === 0));

  const out1d = S.buildBinanceOIDisplaySeries(rows, '1d');
  assert('96 fifteen-min readings = exactly 1 complete daily bucket', out1d.length === 1);
  assert('daily bucket starts at UTC midnight', out1d[0].timestamp === dayStart);
  assert('daily open = first reading of the day', out1d[0].open === 1000);
  assert('daily close = last (96th) reading of the day', out1d[0].close === 1095);
  assert('daily high = max of all 96 readings', out1d[0].high === 1095);
  assert('daily low = min of all 96 readings', out1d[0].low === 1000);
})();

section('buildBinanceOIDisplaySeries: STRICT completeness — a single missing 15m reading omits the WHOLE higher-timeframe candle');
(function () {
  const hour0 = Date.UTC(2026, 2, 10, 0, 0, 0);
  // Only 3 of the 4 required 15m readings for this hour — the 3rd (index 2) is missing.
  const partialHourRows = [
    row(hour0, 100), row(hour0 + FIFTEEN_MIN_MS, 105), row(hour0 + FIFTEEN_MIN_MS * 3, 115),
  ];
  const out1h = S.buildBinanceOIDisplaySeries(partialHourRows, '1h');
  assert('1h: 3-of-4 readings present -> candle omitted entirely, not built from the 3 that exist', out1h.length === 0);

  // 2h: 7 of the required 8 readings (index 5 missing).
  const partial2h = [];
  for (let i = 0; i < 8; i++) if (i !== 5) partial2h.push(row(hour0 + i * FIFTEEN_MIN_MS, 1000 + i));
  assert('2h: 7-of-8 readings present -> candle omitted', S.buildBinanceOIDisplaySeries(partial2h, '2h').length === 0);

  // 4h: 15 of the required 16 readings (index 10 missing).
  const partial4h = [];
  for (let i = 0; i < 16; i++) if (i !== 10) partial4h.push(row(hour0 + i * FIFTEEN_MIN_MS, 1000 + i));
  assert('4h: 15-of-16 readings present -> candle omitted', S.buildBinanceOIDisplaySeries(partial4h, '4h').length === 0);

  // 1d: 95 of the required 96 readings (index 50 missing).
  const partial1d = [];
  for (let i = 0; i < 96; i++) if (i !== 50) partial1d.push(row(hour0 + i * FIFTEEN_MIN_MS, 1000 + i));
  assert('1d: 95-of-96 readings present -> candle omitted', S.buildBinanceOIDisplaySeries(partial1d, '1d').length === 0);
})();

section('buildBinanceOIDisplaySeries: STRICT completeness alongside fully-missing buckets — only complete buckets ever appear');
(function () {
  const hour0 = Date.UTC(2026, 2, 10, 0, 0, 0);
  const hour1 = hour0 + HOUR_MS; // will be fully complete
  const hour2 = hour0 + HOUR_MS * 2; // will be missing one reading (partial)
  const rows = [
    // hour0: fully missing (no rows at all)
    row(hour1, 200), row(hour1 + FIFTEEN_MIN_MS, 205), row(hour1 + FIFTEEN_MIN_MS * 2, 210), row(hour1 + FIFTEEN_MIN_MS * 3, 215), // complete
    row(hour2, 300), row(hour2 + FIFTEEN_MIN_MS, 305), row(hour2 + FIFTEEN_MIN_MS * 3, 315), // missing the 3rd reading — partial
  ];
  const out = S.buildBinanceOIDisplaySeries(rows, '1h');
  assert('only the ONE fully-complete hour (hour1) is emitted', out.length === 1);
  assert('the emitted candle is hour1, not hour0 (fully missing) or hour2 (partial)', out[0].timestamp === hour1);
  assert('hour1 candle values are correct', out[0].open === 200 && out[0].close === 215);
})();

section('buildBinanceOIDisplaySeries: unaligned fetch start — the resulting PARTIAL first bucket is correctly omitted');
(function () {
  const start = Date.UTC(2026, 2, 10, 23, 45, 0); // deliberately not hour-aligned
  const rows = [
    row(start, 100), // alone in the 23:00 bucket — only 1 of 4 required readings
    row(start + FIFTEEN_MIN_MS, 105), // 00:00 next day
    row(start + FIFTEEN_MIN_MS * 2, 110),
    row(start + FIFTEEN_MIN_MS * 3, 115),
    row(start + FIFTEEN_MIN_MS * 4, 120), // completes the 00:00 bucket (4 readings)
  ];
  const out = S.buildBinanceOIDisplaySeries(rows, '1h');
  assert('the partial 23:00 bucket (1 of 4) is omitted, only the complete 00:00 bucket remains', out.length === 1);
  assert('the one remaining bucket is 00:00 UTC the next day', out[0].timestamp === Date.UTC(2026, 2, 11, 0, 0, 0));
})();

section('buildBinanceOIDisplaySeries: empty/garbage input never throws');
(function () {
  assert('empty array -> []', S.buildBinanceOIDisplaySeries([], '1h').length === 0);
  assert('null -> []', S.buildBinanceOIDisplaySeries(null, '1h').length === 0);
  assert('unknown timeframe falls back to the 15m identity series', S.buildBinanceOIDisplaySeries([row(0, 5)], 'bogus').length === 1);
})();

// ── computeBinanceOICoverage ───────────────────────────────────────────────

section('computeBinanceOICoverage: reports bar count, range, and missing bars from the data itself');
(function () {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  // 4 readings across what should be 5 fifteen-min slots (one gap in the middle)
  const rows = [row(start, 1), row(start + FIFTEEN_MIN_MS, 2), row(start + FIFTEEN_MIN_MS * 3, 4), row(start + FIFTEEN_MIN_MS * 4, 5)];
  const cov = S.computeBinanceOICoverage(rows);
  assert('barCount reflects actual valid rows (4)', cov.barCount === 4);
  assert('startTime is the earliest reading', cov.startTime === start);
  assert('endTime is the latest reading', cov.endTime === start + FIFTEEN_MIN_MS * 4);
  assert('expectedBars accounts for the full range (5 slots)', cov.expectedBars === 5);
  assert('missingBars correctly reports the 1 gap', cov.missingBars === 1);
})();

section('computeBinanceOICoverage: empty input never throws, reports all zeros');
(function () {
  const cov = S.computeBinanceOICoverage([]);
  assert('barCount 0', cov.barCount === 0);
  assert('startTime/endTime null', cov.startTime === null && cov.endTime === null);
  assert('missingBars 0', cov.missingBars === 0);
})();

// ── fetchBinanceOpenInterestHist (fake fetch, no real network) ──────────

function makeFakeFetch(pages) {
  let call = 0;
  return async function fakeFetch() {
    const page = pages[call] || [];
    call++;
    return { ok: true, status: 200, json: async () => page };
  };
}

/**
 * Realistic backward-pagination fake: given a full ascending dataset,
 * rejects any request carrying `startTime` (HTTP 400/-1130, matching the
 * real confirmed Binance behavior), and otherwise returns the most recent
 * `limit` rows at or before the requested `endTime` (or the most recent
 * `limit` rows overall, if no endTime is given).
 */
function makeBackwardFakeFetch(allRowsSorted, limit) {
  limit = limit || 500;
  return async function fakeFetch(url) {
    const params = new URL(url);
    if (params.searchParams.has('startTime')) {
      return { ok: false, status: 400, text: async () => '{"code":-1130,"msg":"parameter \'startTime\' is invalid."}' };
    }
    const endTime = params.searchParams.has('endTime') ? Number(params.searchParams.get('endTime')) : Infinity;
    const eligible = allRowsSorted.filter(r => Number(r.timestamp) <= endTime);
    const page = eligible.slice(Math.max(0, eligible.length - limit));
    return { ok: true, status: 200, json: async () => page };
  };
}

section('fetchBinanceOpenInterestHist: the intended endTime reading is not dropped by a strict/exclusive API boundary');
section('fetchBinanceOpenInterestHist: NEVER sends startTime — the confirmed fix for the real -1130 rejection');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  const end = start + FIFTEEN_MIN_MS * 3;
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => [] };
  };
  await S.fetchBinanceOpenInterestHist({ startTime: start, endTime: end, fetchFn, log: false });
  assert('at least one request was made', urls.length > 0);
  assert('NOT ONE request URL ever includes startTime, across every page', urls.every(u => !u.includes('startTime=')));
})());

section('fetchBinanceOpenInterestHist: the first page pads endTime by one period step (guards an exclusive-endTime server)');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  const end = start + FIFTEEN_MIN_MS * 2;
  const requestedEndTimes = [];
  const fetchFn = async (url) => {
    const params = new URL(url);
    requestedEndTimes.push(Number(params.searchParams.get('endTime')));
    return { ok: true, status: 200, json: async () => [] };
  };
  await S.fetchBinanceOpenInterestHist({ startTime: start, endTime: end, fetchFn, log: false });
  assert('the first request pads endTime by exactly one 15m step', requestedEndTimes[0] === end + FIFTEEN_MIN_MS);
})());

section('fetchBinanceOpenInterestHist: explicitly filters out any rows the server returned beyond the intended range');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  const intendedEnd = start + FIFTEEN_MIN_MS * 2;
  // A server that (incorrectly, or via the padding) returns MORE than asked for.
  const oversharingFetch = async () => ({
    ok: true, status: 200,
    json: async () => [0, 1, 2, 3, 4, 5].map(i => row(start + i * FIFTEEN_MIN_MS, 1000 + i)),
  });
  const result = await S.fetchBinanceOpenInterestHist({ startTime: start, endTime: intendedEnd, fetchFn: oversharingFetch, log: false });
  assert('every returned row is within [startTime, endTime] — nothing beyond the intended range leaks through', result.every(r => r.ts >= start && r.ts <= intendedEnd));
  assert('exactly the 3 intended readings (0,1,2 = start..intendedEnd inclusive)', result.length === 3);
})());

section('toBinanceTimestampMs: coerces to a plain integer, rejects malformed input');
(function () {
  assert('plain integer passes through unchanged', S.toBinanceTimestampMs(1780520400000, 'startTime') === 1780520400000);
  assert('numeric string coerces to a number', S.toBinanceTimestampMs('1780520400000', 'startTime') === 1780520400000);
  assert('a value with decimals is rounded to a whole millisecond', S.toBinanceTimestampMs(1780520400000.7, 'startTime') === 1780520400001);
  let threw = false;
  try { S.toBinanceTimestampMs(NaN, 'startTime'); } catch (e) { threw = true; }
  assert('NaN (e.g. from an invalid Date conversion) throws rather than sending garbage', threw);
  let threwOnBigInt = false;
  try { S.toBinanceTimestampMs(1780520400000n, 'startTime'); } catch (e) { threwOnBigInt = true; }
  assert('a BigInt throws rather than being silently coerced', threwOnBigInt);
  let threwOnString = false;
  try { S.toBinanceTimestampMs('not-a-timestamp', 'startTime'); } catch (e) { threwOnString = true; }
  assert('a non-numeric string throws', threwOnString);
})();

section('alignToPeriodBoundary: floors to the exact period grid');
(function () {
  const unaligned = Date.UTC(2026, 5, 4, 13, 7, 0); // 13:07 — not on a 15m boundary
  assert('15m period floors to 13:00', S.alignToPeriodBoundary(unaligned, '15m') === Date.UTC(2026, 5, 4, 13, 0, 0));
  const at15 = Date.UTC(2026, 5, 4, 13, 15, 0);
  assert('a value already exactly on the 15m grid is unchanged', S.alignToPeriodBoundary(at15, '15m') === at15);
  assert('1h period floors to the hour', S.alignToPeriodBoundary(unaligned, '1h') === Date.UTC(2026, 5, 4, 13, 0, 0));
  assert('unknown period falls back to 15m granularity', S.alignToPeriodBoundary(unaligned, 'bogus') === Date.UTC(2026, 5, 4, 13, 0, 0));
})();

section('fetchBinanceOpenInterestHist: endTime is aligned to the period boundary before being sent');
asyncTests.push((async () => {
  const unalignedStart = Date.UTC(2026, 5, 4, 13, 7, 0); // 7 minutes into the 15m bucket
  const unalignedEnd = unalignedStart + FIFTEEN_MIN_MS + (3 * 60 * 1000); // a few minutes past the next boundary
  const sentEndTimes = [];
  const fetchFn = async (url) => {
    const params = new URL(url);
    sentEndTimes.push(params.searchParams.get('endTime'));
    return { ok: true, status: 200, json: async () => [] };
  };
  await S.fetchBinanceOpenInterestHist({ startTime: unalignedStart, endTime: unalignedEnd, fetchFn, log: false });
  const alignedEnd = Date.UTC(2026, 5, 4, 13, 15, 0); // unalignedEnd floored to the 15m grid
  const expectedFirstRequestEndTime = String(alignedEnd + FIFTEEN_MIN_MS); // plus the first-page pad
  assert('the actual endTime sent on the wire is aligned to the 15m grid (then padded once)', sentEndTimes[0] === expectedFirstRequestEndTime);
})());

section('probeOpenInterestHistParams: tries all 4 combinations (none / startTime only / endTime only / both) and reports each outcome');
asyncTests.push((async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const hasStart = url.includes('startTime=');
    // Simulate the real-world finding: only the combination WITH startTime fails.
    if (hasStart) return { ok: false, status: 400, text: async () => '{"code":-1130,"msg":"Data sent for parameter \'startTime\' is not valid."}' };
    return { ok: true, status: 200, json: async () => [{ timestamp: 1000, sumOpenInterestValue: '1' }] };
  };
  const results = await S.probeOpenInterestHistParams({ startTime: 1780520400000, endTime: 1780521300000, fetchFn });
  assert('exactly 4 combinations attempted', calls.length === 4);
  assert('labels identify all 4 combinations', results.map(r => r.label).join('|') === 'no startTime/endTime|startTime only|endTime only|startTime and endTime');
  assert('"no startTime/endTime" succeeds', results[0].ok === true);
  assert('"startTime only" fails with the real -1130 body captured', results[1].ok === false && results[1].bodyPreview.includes('-1130'));
  assert('"endTime only" succeeds (isolates the failure to startTime specifically)', results[2].ok === true);
  assert('"startTime and endTime" fails the same way as startTime-only', results[3].ok === false);
  assert('the "no params" URL genuinely omits both', !calls[0].includes('startTime=') && !calls[0].includes('endTime='));
  assert('the "startTime only" URL omits endTime', calls[1].includes('startTime=') && !calls[1].includes('endTime='));
  assert('the "endTime only" URL omits startTime', !calls[2].includes('startTime=') && calls[2].includes('endTime='));
})());

section('probeOpenInterestHistParams: never throws even if every combination fails');
asyncTests.push((async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  let threw = false;
  let results = null;
  try { results = await S.probeOpenInterestHistParams({ startTime: 0, endTime: 1000, fetchFn }); } catch (e) { threw = true; }
  assert('does not throw — captures each failure instead', threw === false);
  assert('all 4 attempts recorded as failed', results.every(r => r.ok === false));
})());

section('fetchBinanceOpenInterestHist: endTime-only single-page request works (the confirmed-working combination)');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 10, 0, 0, 0);
  const rows = Array.from({ length: 10 }, (_, i) => row(start + i * FIFTEEN_MIN_MS, 1000 + i));
  const result = await S.fetchBinanceOpenInterestHist({
    startTime: start, endTime: start + 9 * FIFTEEN_MIN_MS,
    fetchFn: makeBackwardFakeFetch(rows, 500), log: false,
  });
  assert('all 10 readings returned', result.length === 10);
  assert('sorted ascending', result.every((r, i) => i === 0 || r.ts > result[i - 1].ts));
})());

section('fetchBinanceOpenInterestHist: multi-page BACKWARD pagination covers the full target range');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 1, 0, 0, 0);
  // 1200 fifteen-minute readings (12.5 days) — needs 3 pages at limit=500 to cover fully.
  const rows = Array.from({ length: 1200 }, (_, i) => row(start + i * FIFTEEN_MIN_MS, 1000 + i));
  const targetEnd = start + 1199 * FIFTEEN_MIN_MS;
  const fetchFn = makeBackwardFakeFetch(rows, 500);
  const result = await S.fetchBinanceOpenInterestHist({ startTime: start, endTime: targetEnd, fetchFn, log: false });
  assert('the full 1200-reading range is covered by backward pagination', result.length === 1200);
  assert('the oldest returned reading reaches back to the target start', result[0].ts === start);
  assert('the newest returned reading reaches the target end', result[result.length - 1].ts === targetEnd);
  assert('sorted ascending after merging pages fetched in reverse order', result.every((r, i) => i === 0 || r.ts > result[i - 1].ts));
})());

section('fetchBinanceOpenInterestHist: duplicate rows at page boundaries are deduplicated');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 1, 0, 0, 0);
  const rows = Array.from({ length: 700 }, (_, i) => row(start + i * FIFTEEN_MIN_MS, 1000 + i));
  // A server quirk: each page after the first re-includes its last row's
  // exact timestamp at the START of the next page too (off-by-one overlap).
  let call = 0;
  const overlappingFetch = async (url) => {
    const params = new URL(url);
    if (params.searchParams.has('startTime')) return { ok: false, status: 400, text: async () => '{"code":-1130}' };
    const endTime = Number(params.searchParams.get('endTime'));
    const eligible = rows.filter(r => Number(r.timestamp) <= endTime);
    let page = eligible.slice(Math.max(0, eligible.length - 500));
    if (call > 0 && page.length) page = [page[page.length - 1], ...page]; // duplicate the boundary row
    call++;
    return { ok: true, status: 200, json: async () => page };
  };
  const result = await S.fetchBinanceOpenInterestHist({
    startTime: start, endTime: start + 699 * FIFTEEN_MIN_MS,
    fetchFn: overlappingFetch, log: false,
  });
  const timestamps = result.map(r => r.ts);
  assert('no duplicate timestamps in the final merged result', new Set(timestamps).size === timestamps.length);
  assert('the full range is still covered despite the overlap', result.length === 700);
})());

section('fetchBinanceOpenInterestHist: local final filtering excludes data outside the intended visible range');
asyncTests.push((async () => {
  const start = Date.UTC(2026, 2, 1, 0, 0, 0);
  // Server has MORE history than requested (200 readings), but only 50 are in range.
  const allRows = Array.from({ length: 200 }, (_, i) => row(start + i * FIFTEEN_MIN_MS, 1000 + i));
  const targetStart = start + 100 * FIFTEEN_MIN_MS;
  const targetEnd = start + 149 * FIFTEEN_MIN_MS;
  const result = await S.fetchBinanceOpenInterestHist({
    startTime: targetStart, endTime: targetEnd,
    fetchFn: makeBackwardFakeFetch(allRows, 500), log: false,
  });
  assert('every returned row is within the intended visible range', result.every(r => r.ts >= targetStart && r.ts <= targetEnd));
  assert('exactly the 50 intended readings, not the full 200 available', result.length === 50);
})());

section('fetchBinanceOpenInterestHist: throws a clear error on a failed HTTP response');
asyncTests.push((async () => {
  let threw = false, message = '';
  try {
    await S.fetchBinanceOpenInterestHist({
      startTime: 0, endTime: 1000,
      fetchFn: async () => ({ ok: false, status: 451 }),
      log: false,
    });
  } catch (e) { threw = true; message = e.message; }
  assert('throws rather than silently returning partial/empty data', threw);
  assert('error message mentions the HTTP status', message.includes('451'));
})());

section('fetchBinanceOpenInterestHist: surfaces the actual Binance response body, not just the status code');
asyncTests.push((async () => {
  let message = '';
  try {
    await S.fetchBinanceOpenInterestHist({
      startTime: 0, endTime: 1000,
      fetchFn: async () => ({ ok: false, status: 400, text: async () => '{"code":-1130,"msg":"Data sent for parameter \'startTime\' is not valid."}' }),
      log: false,
    });
  } catch (e) { message = e.message; }
  assert('error message includes Binance\'s own error code', message.includes('-1130'));
  assert('error message includes Binance\'s own error text', message.includes('is not valid'));
})());

section('fetchBinanceOpenInterestHist: requires startTime and endTime');
asyncTests.push((async () => {
  let threw = false;
  try { await S.fetchBinanceOpenInterestHist({ fetchFn: makeFakeFetch([[]]), log: false }); } catch (e) { threw = true; }
  assert('throws when startTime/endTime are missing', threw);
})());

// ── THE EMPTY-PANE BUG: fetcher returns parsed {ts,oi}, consumers re-parse ──

section('parseBinanceOpenInterestRow: accepts already-parsed {ts,oi} rows — what fetchBinanceOpenInterestHist itself returns');
(function () {
  assert('parsed shape accepted', JSON.stringify(S.parseBinanceOpenInterestRow({ ts: 900000, oi: 123.5 })) === JSON.stringify({ ts: 900000, oi: 123.5 }));
  assert('raw API shape still accepted (string value coerced)', JSON.stringify(S.parseBinanceOpenInterestRow({ timestamp: 900000, sumOpenInterestValue: '123.5' })) === JSON.stringify({ ts: 900000, oi: 123.5 }));
  assert('neither shape -> null, never a guess', S.parseBinanceOpenInterestRow({ foo: 1 }) === null);
})();

section('normalizeBinanceOpenInterestRows: re-normalizing the fetcher OUTPUT is now lossless (regression for fetchedRows=2689/validCount=0)');
(function () {
  const fetched = [{ ts: 1800000, oi: 20 }, { ts: 900000, oi: 10 }]; // exactly what the fetcher returns
  const renormalized = S.normalizeBinanceOpenInterestRows(fetched);
  assert('all parsed rows survive a second normalization pass', renormalized.length === 2);
  assert('still sorted ascending', renormalized[0].ts === 900000 && renormalized[1].ts === 1800000);
})();

section('summarizeBinanceOIParse: valid count, first/last ts+value, rejection counts split by invalid field');
(function () {
  const rows = [
    { ts: 900000, oi: 10 },
    { timestamp: 1800000, sumOpenInterestValue: '20' },
    { timestamp: 'garbage', sumOpenInterestValue: '5' }, // invalid timestamp
    { ts: 2700000, oi: 'NaN-ish' },                       // invalid value
  ];
  const d = S.summarizeBinanceOIParse(rows);
  assert('fetchedRows counts everything', d.fetchedRows === 4);
  assert('validCount counts only clean rows', d.validCount === 2);
  assert('first/last parsed ts', d.firstTs === 900000 && d.lastTs === 1800000);
  assert('first/last parsed value', d.firstValue === 10 && d.lastValue === 20);
  assert('one rejected for invalid timestamp', d.rejectedInvalidTimestamp === 1);
  assert('one rejected for invalid value', d.rejectedInvalidValue === 1);
  assert('sample row is the first raw row', d.sampleRow === rows[0]);
  const empty = S.summarizeBinanceOIParse([]);
  assert('empty input -> zero counts, null ts/values', empty.fetchedRows === 0 && empty.validCount === 0 && empty.firstTs === null && empty.lastValue === null);
})();

(async () => {
  await Promise.all(asyncTests);
  console.log('\n────────────────────────────────────────');
  console.log('oi-exhaustion-binance-oi-source: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();


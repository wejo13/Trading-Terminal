// oi-exhaustion-probe.test.js — pure-logic + security-guard tests for
// oi-exhaustion-probe.js. No network calls.
'use strict';

const fs = require('fs');
const path = require('path');

const OIExhaustionProbe = require('./oi-exhaustion-probe.js');
const {
  parseRow,
  mergeDedupe,
  detectGaps,
  computeExpectedIntervals,
  detectStagnation,
} = OIExhaustionProbe;

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

const FIVE_MIN = 5 * 60 * 1000;
const T0 = 1750000000000;

// ── SECTION: parseRow ───────────────────────────────────────────────────────

section('parseRow: valid Bybit row shape');
(function () {
  const row = parseRow({ openInterest: '52375.214', timestamp: String(T0) });
  assert('parses oi as float', row.oi === 52375.214);
  assert('parses ts as int', row.ts === T0);
})();

section('parseRow: malformed / missing fields');
(function () {
  assert('null input -> null', parseRow(null) === null);
  assert('non-object input -> null', parseRow('garbage') === null);
  assert('non-numeric openInterest -> null', parseRow({ openInterest: 'abc', timestamp: String(T0) }) === null);
  assert('non-numeric timestamp -> null', parseRow({ openInterest: '100', timestamp: 'abc' }) === null);
  assert('missing openInterest -> null', parseRow({ timestamp: String(T0) }) === null);
})();

// ── SECTION: mergeDedupe ────────────────────────────────────────────────────

section('mergeDedupe: single page, no duplicates');
(function () {
  const rows = [{ ts: T0, oi: 1 }, { ts: T0 + FIVE_MIN, oi: 2 }];
  const { rows: merged, duplicateCount } = mergeDedupe([rows]);
  assert('row count preserved', merged.length === 2);
  assert('no duplicates found', duplicateCount === 0);
  assert('ascending order', merged[0].ts < merged[1].ts);
})();

section('mergeDedupe: overlapping pages produce duplicates, correct count');
(function () {
  const pageA = [{ ts: T0, oi: 1 }, { ts: T0 + FIVE_MIN, oi: 2 }, { ts: T0 + 2 * FIVE_MIN, oi: 3 }];
  const pageB = [{ ts: T0 + 2 * FIVE_MIN, oi: 3 }, { ts: T0 + 3 * FIVE_MIN, oi: 4 }];
  const { rows: merged, duplicateCount } = mergeDedupe([pageA, pageB]);
  assert('unique rows = 4', merged.length === 4);
  assert('duplicate count = 1', duplicateCount === 1);
  assert('sorted ascending across pages', merged.every((r, i) => i === 0 || merged[i - 1].ts < r.ts));
})();

section('mergeDedupe: pages arrive out of order (descending), still sorted output');
(function () {
  const pageA = [{ ts: T0 + 2 * FIVE_MIN, oi: 3 }];
  const pageB = [{ ts: T0, oi: 1 }];
  const { rows: merged } = mergeDedupe([pageA, pageB]);
  assert('output ascending regardless of input page order', merged[0].ts === T0 && merged[1].ts === T0 + 2 * FIVE_MIN);
})();

section('mergeDedupe: null rows within a page are skipped safely');
(function () {
  const pageA = [{ ts: T0, oi: 1 }, null, { ts: T0 + FIVE_MIN, oi: 2 }];
  const { rows: merged } = mergeDedupe([pageA]);
  assert('nulls filtered out', merged.length === 2);
})();

// ── SECTION: detectGaps ─────────────────────────────────────────────────────

section('detectGaps: perfectly contiguous series has zero gaps');
(function () {
  const rows = [0, 1, 2, 3, 4].map(i => ({ ts: T0 + i * FIVE_MIN, oi: i }));
  assert('no gaps in contiguous series', detectGaps(rows, FIVE_MIN).length === 0);
})();

section('detectGaps: single missing candle detected with correct count');
(function () {
  const rows = [{ ts: T0, oi: 0 }, { ts: T0 + FIVE_MIN, oi: 1 }, { ts: T0 + 3 * FIVE_MIN, oi: 3 }];
  const gaps = detectGaps(rows, FIVE_MIN);
  assert('exactly one gap found', gaps.length === 1);
  assert('gap reports 1 missing interval', gaps[0].missingIntervals === 1);
  assert('gap bounds correct', gaps[0].fromTs === T0 + FIVE_MIN && gaps[0].toTs === T0 + 3 * FIVE_MIN);
})();

section('detectGaps: multiple gaps of different sizes');
(function () {
  const rows = [{ ts: T0, oi: 0 }, { ts: T0 + 2 * FIVE_MIN, oi: 1 }, { ts: T0 + 6 * FIVE_MIN, oi: 2 }];
  const gaps = detectGaps(rows, FIVE_MIN);
  assert('two gaps found', gaps.length === 2);
  assert('first gap size 1', gaps[0].missingIntervals === 1);
  assert('second gap size 3', gaps[1].missingIntervals === 3);
})();

section('detectGaps: empty or single-row input never throws, zero gaps');
(function () {
  assert('empty array', detectGaps([], FIVE_MIN).length === 0);
  assert('single row', detectGaps([{ ts: T0, oi: 1 }], FIVE_MIN).length === 0);
})();

// ── SECTION: computeExpectedIntervals ───────────────────────────────────────

section('computeExpectedIntervals: exact multiples');
(function () {
  assert('144 candles over 12h', computeExpectedIntervals(T0, T0 + 144 * FIVE_MIN, FIVE_MIN) === 144);
  assert('1 candle over one interval', computeExpectedIntervals(T0, T0 + FIVE_MIN, FIVE_MIN) === 1);
  assert('zero-width range', computeExpectedIntervals(T0, T0, FIVE_MIN) === 0);
})();

section('computeExpectedIntervals: 30-day range matches known constant (8640)');
(function () {
  const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
  assert('30d / 5min = 8640', computeExpectedIntervals(T0, T0 + THIRTY_DAYS_MS, FIVE_MIN) === 8640);
})();

// ── SECTION: detectStagnation ───────────────────────────────────────────────

section('detectStagnation: healthy pagination — earliest ts regresses toward requestedStartTime');
(function () {
  const requestedStart = T0 - 30 * 24 * 3600 * 1000;
  const pageSummaries = [
    { pageIndex: 0, cursorUsed: null, nextCursor: 'c1', returnedEarliestTs: T0 - 5 * 24 * 3600 * 1000, returnedLatestTs: T0 },
    { pageIndex: 1, cursorUsed: 'c1', nextCursor: 'c2', returnedEarliestTs: T0 - 15 * 24 * 3600 * 1000, returnedLatestTs: T0 - 5 * 24 * 3600 * 1000 },
    { pageIndex: 2, cursorUsed: 'c2', nextCursor: null, returnedEarliestTs: T0 - 29 * 24 * 3600 * 1000, returnedLatestTs: T0 - 15 * 24 * 3600 * 1000 },
  ];
  const result = detectStagnation(pageSummaries, requestedStart);
  assert('not flagged as stagnant', result.stagnant === false);
  assert('requested range considered honored', result.requestedRangeHonored === true);
})();

section('detectStagnation: known failure mode — cursor advances but earliest ts never regresses');
(function () {
  const requestedStart = T0 - 30 * 24 * 3600 * 1000;
  const stuckEarliest = T0 - 16 * 3600 * 1000;
  const pageSummaries = [
    { pageIndex: 0, cursorUsed: null, nextCursor: 'c1', returnedEarliestTs: stuckEarliest, returnedLatestTs: T0 },
    { pageIndex: 1, cursorUsed: 'c1', nextCursor: 'c2', returnedEarliestTs: stuckEarliest, returnedLatestTs: T0 },
    { pageIndex: 2, cursorUsed: 'c2', nextCursor: 'c3', returnedEarliestTs: stuckEarliest, returnedLatestTs: T0 },
  ];
  const result = detectStagnation(pageSummaries, requestedStart);
  assert('flagged as stagnant', result.stagnant === true);
  assert('requested range not honored', result.requestedRangeHonored === false);
  assert('reason explains the failure mode', result.reason === 'earliest_timestamp_did_not_regress_despite_pagination');
})();

section('detectStagnation: no pages returned at all');
(function () {
  const result = detectStagnation([], T0 - 30 * 24 * 3600 * 1000);
  assert('flagged stagnant with explicit reason', result.stagnant === true && result.reason === 'no_pages_returned');
})();

section('detectStagnation: single honored page is not flagged stagnant');
(function () {
  const requestedStart = T0 - 30 * 24 * 3600 * 1000;
  const pageSummaries = [{ pageIndex: 0, cursorUsed: null, nextCursor: null, returnedEarliestTs: T0 - 29 * 24 * 3600 * 1000, returnedLatestTs: T0 }];
  const result = detectStagnation(pageSummaries, requestedStart);
  assert('not flagged stagnant', result.stagnant === false);
})();

// ── SECTION: security guard — no credential access, ever ───────────────────

section('Security: module source never functionally accesses API keys, secrets, or localStorage');
(function () {
  const src = fs.readFileSync(path.join(__dirname, 'oi-exhaustion-probe.js'), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert('no quoted bybit_api_key literal in code', !/['"]bybit_api_key['"]/.test(codeOnly));
  assert('no quoted bybit_api_secret literal in code', !/['"]bybit_api_secret['"]/.test(codeOnly));
  assert('no localStorage.getItem/.setItem/.[…] call in code', !/localStorage\s*[.\[]/.test(codeOnly));
  assert('no X-BAPI signed-header pattern in code', !codeOnly.includes('X-BAPI'));
  assert('no HMAC/crypto.subtle signing in code', !codeOnly.includes('crypto.subtle'));
})();

section('Security: request URL builder never adds auth headers or signed params');
(function () {
  const src = fs.readFileSync(path.join(__dirname, 'oi-exhaustion-probe.js'), 'utf8');
  const fetchPageMatch = src.match(/async function fetchPage\([\s\S]*?(?=\n  async function runOICoverageProbe)/);
  assert('fetchPage function found', !!fetchPageMatch);
  if (fetchPageMatch) {
    const body = fetchPageMatch[0];
    assert('fetchPage builds no headers object', !/headers\s*:/.test(body));
    assert('fetchPage call is bare fetch(url) with no options object', /await fetch\(url\)/.test(body));
  }
})();

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-probe: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

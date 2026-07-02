/**
 * oi-exhaustion-fetch-real-data.js
 * Fetches real BTCUSDT linear 5m candles + 5m open interest from Bybit's
 * public REST API — same unauthenticated, public-endpoint transport family
 * already proven to work end-to-end via the browser coverage probe
 * (runOICoverageProbe). This is the Node-side counterpart: same domain,
 * same "no credentials, no signing" contract, just run from a machine/
 * network that isn't geo-blocked (this sandbox is — see console output
 * below if you run it here).
 *
 * Writes three files to --outDir (default ./real-data):
 *   candles.json  — [{ ts, open, high, low, close }]   (OHLC, for boundary detection)
 *   oi.json       — [{ ts, oi }]
 *   zones.json    — placeholder wide "always active" zone (see note below)
 *
 * Then optionally runs the event-study backtest immediately against them.
 *
 * IMPORTANT: no real zone definitions exist yet (WEJO's actual range/level
 * levels haven't been supplied). zones.json here is a deliberately wide,
 * clearly-labeled DEMO zone spanning the full price range, with
 * availableAtTs set to the start of the fetched data — this validates the
 * full real-data pipeline end-to-end, but is NOT a real trading zone. Real
 * zone levels with real availableAtTs timestamps are a separate input to
 * supply before the results mean anything as a trading signal.
 *
 * Usage:
 *   node oi-exhaustion-fetch-real-data.js [--days 90] [--outDir ./real-data] [--runBacktest]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { parseRow, mergeDedupe } = require('./oi-exhaustion-probe.js');

const SYMBOL = 'BTCUSDT';
const CATEGORY = 'linear';
const FIVE_MIN_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 200;
const REQUEST_DELAY_MS = 250;
const MAX_PAGES = 700; // generous cap: 90d * 288/day / 200 ≈ 130 for OI; kline similar

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── OI fetch (cursor-paginated, proven shape) ───────────────────────────

async function fetchOIHistory(startTime, endTime) {
  const base = 'https://api.bybit.com/v5/market/open-interest';

  let cursor, pageIndex = 0;
  let lastSuccessTs = null;
  const pagesOfRows = [];

  while (pageIndex < MAX_PAGES) {
    const params = new URLSearchParams({
      category: CATEGORY, symbol: SYMBOL, intervalTime: '5min',
      limit: String(PAGE_LIMIT), startTime: String(startTime), endTime: String(endTime),
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${base}?${params.toString()}`);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.retCode !== 0) {
      throw new Error(
        `[oi-fetch] failed at page ${pageIndex}: httpStatus=${res.status} ` +
        `retCode=${json && json.retCode} retMsg=${json && json.retMsg} ` +
        `lastSuccessTs=${lastSuccessTs !== null ? new Date(lastSuccessTs).toISOString() : 'none'}`
      );
    }
    const list = (json.result && json.result.list) || [];
    const rows = list.map(parseRow).filter(Boolean);
    pagesOfRows.push(rows);
    if (rows.length > 0) lastSuccessTs = Math.min(...rows.map(r => r.ts));
    console.log(`[oi-fetch] page ${pageIndex}: ${rows.length} rows`);

    pageIndex++;
    const nextCursor = json.result && json.result.nextPageCursor;
    if (!nextCursor || rows.length === 0) break;
    cursor = nextCursor;
    await sleep(REQUEST_DELAY_MS);
  }

  const { rows, duplicateCount } = mergeDedupe(pagesOfRows);
  console.log(`[oi-fetch] total unique rows: ${rows.length}, duplicates merged: ${duplicateCount}`);
  return rows; // [{ ts, oi }]
}

// ── Kline fetch (start/end-window paginated — no cursor on this endpoint) ──

function parseKlineRow(raw) {
  // Bybit kline row: [start, open, high, low, close, volume, turnover] as strings
  if (!Array.isArray(raw) || raw.length < 5) return null;
  const ts = parseInt(raw[0], 10);
  const open = parseFloat(raw[1]);
  const high = parseFloat(raw[2]);
  const low = parseFloat(raw[3]);
  const close = parseFloat(raw[4]);
  if (![ts, open, high, low, close].every(isFinite)) return null;
  return { ts, open, high, low, close };
}

async function fetchCandleHistory(startTime, endTime) {
  const base = 'https://api.bybit.com/v5/market/kline';

  let currentEnd = endTime;
  let pageIndex = 0;
  let lastSuccessTs = null;
  const pagesOfRows = [];

  while (pageIndex < MAX_PAGES && currentEnd > startTime) {
    const params = new URLSearchParams({
      category: CATEGORY, symbol: SYMBOL, interval: '5',
      start: String(startTime), end: String(currentEnd), limit: String(PAGE_LIMIT),
    });

    const res = await fetch(`${base}?${params.toString()}`);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.retCode !== 0) {
      throw new Error(
        `[candle-fetch] failed at page ${pageIndex}: httpStatus=${res.status} ` +
        `retCode=${json && json.retCode} retMsg=${json && json.retMsg} ` +
        `lastSuccessTs=${lastSuccessTs !== null ? new Date(lastSuccessTs).toISOString() : 'none'}`
      );
    }
    const list = (json.result && json.result.list) || [];
    const rows = list.map(parseKlineRow).filter(Boolean); // descending (newest first) per Bybit
    pagesOfRows.push(rows);
    if (rows.length > 0) lastSuccessTs = Math.min(...rows.map(r => r.ts));
    console.log(`[candle-fetch] page ${pageIndex}: ${rows.length} rows`);

    pageIndex++;
    if (rows.length === 0) break;
    const minTs = Math.min(...rows.map(r => r.ts));
    if (minTs <= startTime) break; // reached (or passed) the requested start
    currentEnd = minTs - 1;
    await sleep(REQUEST_DELAY_MS);
  }

  // dedupe/sort by timestamp ascending
  const byTs = new Map();
  for (const page of pagesOfRows) for (const r of page) byTs.set(r.ts, r);
  const rows = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  console.log(`[candle-fetch] total unique candles: ${rows.length}`);
  return rows; // [{ ts, open, high, low, close }]
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { days: 90, outDir: path.join(__dirname, 'real-data'), runBacktest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') out.days = parseInt(argv[++i], 10);
    else if (argv[i] === '--outDir') out.outDir = argv[++i];
    else if (argv[i] === '--runBacktest') out.runBacktest = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  // Shared, single source of truth for the fetch window. endTime is the
  // START timestamp of the latest FULLY COMPLETED 5m candle — the current,
  // still-forming candle is excluded so candles/OI don't disagree about
  // what "now" means depending on which endpoint is hit a few ms apart.
  const currentCandleStart = Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS;
  const endTime = currentCandleStart - FIVE_MIN_MS;
  const startTime = endTime - args.days * 24 * 3600 * 1000;

  console.log(`Fetching ${args.days}d of ${SYMBOL} ${CATEGORY} 5m candles + OI...`);
  console.log(`Window: ${new Date(startTime).toISOString()} -> ${new Date(endTime).toISOString()}`);
  const [oiRows, candles] = await Promise.all([
    fetchOIHistory(startTime, endTime),
    fetchCandleHistory(startTime, endTime),
  ]);

  if (oiRows.length === 0 || candles.length === 0) {
    console.error('FETCH FAILED — zero rows for candles and/or OI. Likely network/geo-block. Not writing partial/empty files.');
    process.exit(1);
  }

  const candlesPath = path.join(args.outDir, 'candles.json');
  const oiPath = path.join(args.outDir, 'oi.json');
  const zonesPath = path.join(args.outDir, 'zones.json');

  fs.writeFileSync(candlesPath, JSON.stringify(candles, null, 2));
  fs.writeFileSync(oiPath, JSON.stringify(oiRows, null, 2));

  // Placeholder demo zone — see file header note. Spans the full observed
  // price range with generous padding, available from the start of the
  // fetched data, so the pipeline can be exercised end-to-end.
  const prices = candles.map(c => c.close);
  const demoZone = [{
    id: 'demo-wide-range',
    label: 'DEMO — full-range placeholder, not a real trading zone',
    type: 'range',
    top: Math.max(...prices) * 1.05,
    bottom: Math.min(...prices) * 0.95,
    active: true,
    availableAtTs: candles[0].ts,
  }];
  fs.writeFileSync(zonesPath, JSON.stringify(demoZone, null, 2));

  console.log(`\nWrote: ${candlesPath}`);
  console.log(`Wrote: ${oiPath}`);
  console.log(`Wrote: ${zonesPath} (DEMO placeholder zone — replace with real levels)`);

  if (args.runBacktest) {
    const { runEventStudy } = require('./oi-exhaustion-backtest.js');
    console.log('\nRunning event-study backtest...');
    const result = runEventStudy(candles, oiRows, demoZone);
    const reportPath = path.join(args.outDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));

    console.log(`\nAlerts found: ${result.alerts.length}`);
    console.log(`Valid scored candles: ${result.meta.validScoreCount} / ${result.meta.totalCandles}`);
    console.log(`Final baseline size: ${result.meta.finalBaselineSize} (lookback cap: ${result.meta.baselineLookbackCandles})`);
    console.log(`OHLC boundary detection: ${result.meta.hasOHLC ? 'yes' : 'no (close-only proxy)'}`);
    console.log(`Report written to: ${reportPath}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

module.exports = { fetchOIHistory, fetchCandleHistory, parseKlineRow };

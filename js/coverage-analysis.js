'use strict';
const fzstd = require('fzstd');
const CryptoHFTSource = require('./oi-exhaustion-cryptohft-source.js');

const API_KEY = process.env.CRYPTOHFT_API_KEY;
if (!API_KEY) { console.error('Set CRYPTOHFT_API_KEY env var'); process.exit(1); }

const LOOKBACK_DAYS = Number(process.argv[2] || 90);
const HOUR_STEP_HOURS = Number(process.argv[3] || 12);
const VENUES = ['binance_futures', 'bybit', 'okx_futures'];
const SYMBOL_BY_VENUE = { binance_futures: 'BTCUSDT', bybit: 'BTCUSDT', okx_futures: 'BTC-USDT-SWAP' };
const BUCKET_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

async function decodeFile(url) {
  const res = await fetch(url);
  if (res.status === 404) return { status: 404, rows: [] };
  if (!res.ok) return { status: res.status, rows: [], error: await res.text().catch(() => '') };
  const buf = new Uint8Array(await res.arrayBuffer());
  const decompressed = fzstd.decompress(buf);
  const { parquetReadObjects } = await import('hyparquet');
  const arrayBuffer = decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
  const rows = await parquetReadObjects({ file: arrayBuffer });
  return { status: res.status, rows };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchVenueRaw(venue, startTime, endTime) {
  const symbol = SYMBOL_BY_VENUE[venue];
  const stepMs = HOUR_STEP_HOURS * HOUR_MS;
  const firstHour = Math.floor(startTime / HOUR_MS) * HOUR_MS;
  const rowsByTs = new Map();
  let requestCount = 0, notFoundCount = 0, errorCount = 0;

  for (let h = firstHour; h <= endTime; h += stepMs) {
    const d = new Date(h);
    const dateStr = d.toISOString().slice(0, 10);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const path = `${venue}/${dateStr}/${hh}/${symbol}_open_interest.parquet.zst`;
    const url = `https://api.cryptohftdata.com/download?file=${encodeURIComponent(path)}&api_key=${API_KEY}`;
    requestCount++;
    let result;
    try {
      result = await decodeFile(url);
    } catch (e) {
      errorCount++;
      await sleep(200);
      continue;
    }
    if (result.status === 404) { notFoundCount++; await sleep(150); continue; }
    if (result.status !== 200) { errorCount++; await sleep(150); continue; }

    for (const r of result.rows) {
      const tsMs = CryptoHFTSource.parseMsTimestamp(r.timestamp);
      const oiVal = CryptoHFTSource.parseOiValue(r.sum_open_interest_value);
      if (tsMs === null) continue;
      if (tsMs < startTime || tsMs > endTime) continue;
      rowsByTs.set(tsMs, oiVal);
    }
    if (requestCount % 20 === 0) console.log(`  [${venue}] ${requestCount} requests done, ${rowsByTs.size} unique timestamps so far`);
    await sleep(200);
  }

  return { venue, rowsByTs, requestCount, notFoundCount, errorCount };
}

function longestConsecutiveRun(sortedBucketKeys, bucketMs) {
  let longest = 0, current = 0, prev = null;
  for (const k of sortedBucketKeys) {
    if (prev !== null && k - prev === bucketMs) current++;
    else current = 1;
    if (current > longest) longest = current;
    prev = k;
  }
  return longest;
}

async function main() {
  const endTime = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS - BUCKET_MS;
  const startTime = endTime - LOOKBACK_DAYS * 24 * 3600 * 1000;
  console.log(`Window: ${new Date(startTime).toISOString()} -> ${new Date(endTime).toISOString()} (${LOOKBACK_DAYS}d, hourStepHours=${HOUR_STEP_HOURS})\n`);

  const perVenue = {};
  for (const venue of VENUES) {
    console.log(`=== Fetching ${venue} ===`);
    const result = await fetchVenueRaw(venue, startTime, endTime);
    perVenue[venue] = result;
    const tsSorted = Array.from(result.rowsByTs.keys()).sort((a, b) => a - b);
    const validValueCount = Array.from(result.rowsByTs.values()).filter(v => v !== null).length;
    console.log(`${venue}: raw rows (unique ts)=${result.rowsByTs.size}, valid sum_open_interest_value=${validValueCount}, ` +
      `first=${tsSorted.length ? new Date(tsSorted[0]).toISOString() : 'n/a'}, last=${tsSorted.length ? new Date(tsSorted[tsSorted.length - 1]).toISOString() : 'n/a'}, ` +
      `requests=${result.requestCount} (404s=${result.notFoundCount}, errors=${result.errorCount})\n`);
  }

  const bucketsByVenue = {};
  for (const venue of VENUES) {
    const buckets = new Map();
    for (const [tsMs, oiVal] of perVenue[venue].rowsByTs) {
      if (oiVal === null) continue;
      const bucketKey = Math.floor(tsMs / BUCKET_MS) * BUCKET_MS;
      const existing = buckets.get(bucketKey);
      if (!existing || tsMs >= existing.tsMs) buckets.set(bucketKey, { tsMs, oi: oiVal });
    }
    bucketsByVenue[venue] = buckets;
  }

  console.log('=== Per-venue 15m bucket coverage ===');
  for (const venue of VENUES) {
    console.log(`${venue}: ${bucketsByVenue[venue].size} 15m buckets with a valid value`);
  }

  const allBucketKeys = new Set();
  for (const venue of VENUES) for (const k of bucketsByVenue[venue].keys()) allBucketKeys.add(k);

  let completeCount = 0;
  const completeKeys = [];
  const missingReasonCounts = {};
  for (const k of allBucketKeys) {
    const missingVenues = VENUES.filter(v => !bucketsByVenue[v].has(k));
    if (missingVenues.length === 0) {
      completeCount++;
      completeKeys.push(k);
    } else {
      const reason = missingVenues.join('+') + ' missing';
      missingReasonCounts[reason] = (missingReasonCounts[reason] || 0) + 1;
    }
  }
  completeKeys.sort((a, b) => a - b);

  console.log(`\n=== 3-venue aggregate coverage ===`);
  console.log(`Total distinct 15m buckets seen across any venue: ${allBucketKeys.size}`);
  console.log(`Valid 3-venue complete buckets: ${completeCount}`);
  console.log(`Incomplete buckets: ${allBucketKeys.size - completeCount}`);
  console.log(`Longest consecutive valid 15m run: ${longestConsecutiveRun(completeKeys, BUCKET_MS)} buckets (${longestConsecutiveRun(completeKeys, BUCKET_MS) * 15} minutes)`);
  console.log('\nMissing-bucket reasons (which venue(s) absent), by frequency:');
  const sortedReasons = Object.entries(missingReasonCounts).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) console.log(`  ${reason}: ${count} buckets`);

  require('fs').writeFileSync('/tmp/coverage-analysis.json', JSON.stringify({
    window: { startTime, endTime, lookbackDays: LOOKBACK_DAYS, hourStepHours: HOUR_STEP_HOURS },
    perVenue: VENUES.map(v => ({
      venue: v,
      rawRows: perVenue[v].rowsByTs.size,
      validValueRows: Array.from(perVenue[v].rowsByTs.values()).filter(x => x !== null).length,
      firstTs: perVenue[v].rowsByTs.size ? Math.min(...perVenue[v].rowsByTs.keys()) : null,
      lastTs: perVenue[v].rowsByTs.size ? Math.max(...perVenue[v].rowsByTs.keys()) : null,
      bucketsSeen: bucketsByVenue[v].size,
      requestCount: perVenue[v].requestCount,
      notFoundCount: perVenue[v].notFoundCount,
      errorCount: perVenue[v].errorCount,
    })),
    totalBucketsSeen: allBucketKeys.size,
    completeBuckets: completeCount,
    incompleteBuckets: allBucketKeys.size - completeCount,
    longestConsecutiveRunBuckets: longestConsecutiveRun(completeKeys, BUCKET_MS),
    missingReasonCounts,
  }, null, 2));
  console.log('\nWrote /tmp/coverage-analysis.json');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });

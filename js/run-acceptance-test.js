'use strict';
const fzstd = require('fzstd');
const R = require('./oi-exhaustion-render.js');
const Engine = require('./oi-exhaustion-engine.js');
const Backtest = require('./oi-exhaustion-backtest.js');

const API_KEY = process.env.CRYPTOHFT_API_KEY;
if (!API_KEY) { console.error('Set CRYPTOHFT_API_KEY env var'); process.exit(1); }

const LOOKBACK_DAYS = Number(process.argv[2] || 10);
const HOUR_STEP_HOURS = Number(process.argv[3] || 1); // corrected default — see oi-exhaustion-render.js comment for why 6/8/12 undersample bybit/okx_futures
const VENUES = process.argv[4] ? process.argv[4].split(',') : R.CRYPTOHFT_REQUIRED_VENUES;

function decodeZst(compressedBytes) {
  return fzstd.decompress(compressedBytes);
}
async function parseParquet(decompressedBytes) {
  const { parquetReadObjects } = await import('hyparquet');
  const arrayBuffer = decompressedBytes.buffer.slice(decompressedBytes.byteOffset, decompressedBytes.byteOffset + decompressedBytes.byteLength);
  return parquetReadObjects({ file: arrayBuffer });
}

function latestCompletedCandleStart(nowMs) {
  const FIVE = 15 * 60 * 1000;
  return Math.floor(nowMs / FIVE) * FIVE - FIVE;
}

async function main() {
  const endTime = latestCompletedCandleStart(Date.now());
  const startTime = endTime - LOOKBACK_DAYS * 24 * 3600 * 1000;
  console.log(`Window: ${new Date(startTime).toISOString()} -> ${new Date(endTime).toISOString()} (${LOOKBACK_DAYS}d, hourStepHours=${HOUR_STEP_HOURS})`);

  let lastLog = 0;
  const progress = (evt) => {
    const now = Date.now();
    if (now - lastLog < 2000 && evt.requestIndex !== evt.totalRequests) return;
    lastLog = now;
    if (evt.source === 'cryptohft') {
      console.log(`  [cryptohft] ${evt.venue} ${evt.requestIndex}/${evt.totalRequests} rowsSoFar=${evt.rowsSoFar}`);
    } else if (evt.type === 'page') {
      console.log(`  [${evt.source}] page ${evt.page} rowsSoFar=${evt.rowsSoFar}`);
    } else if (evt.type === 'rate_limited') {
      console.log(`  [rate_limited] ${evt.source} attempt ${evt.attempt} wait=${evt.waitMs}ms`);
    }
  };

  console.log('\n=== Binance is geo-blocked from this sandbox (verified, HTTP 451) — substituting a synthetic 15m price series aligned to the real OI timestamps, ONLY to prove V1/V2 execute against real OI data. NOT a real backtest result. ===');

  console.log(`\n=== Fetching CryptoHFT aggregate OI (venues: ${VENUES.join(', ')}) ===`);
  const cryptoHftResult = await R.fetchCryptoHFTAggregateOI(startTime, endTime, API_KEY, {
    onProgress: progress,
    decodeZst,
    parseParquet,
    hourStepHours: HOUR_STEP_HOURS,
    pageDelayMs: 250,
    venues: VENUES,
  });

  console.log('\n=== Coverage ===');
  console.log('Raw rows collected:', cryptoHftResult.rawRowCount);
  console.log('Total requests:', cryptoHftResult.totalRequests, '  Skipped 404s:', cryptoHftResult.skipped404Count);
  console.log('Venues seen:', cryptoHftResult.coverage.venuesSeen);
  console.log('Total 15m buckets seen:', cryptoHftResult.coverage.totalBucketsSeen);
  console.log('Complete (valid aggregate) buckets:', cryptoHftResult.coverage.completeBuckets);
  console.log('Incomplete buckets excluded:', cryptoHftResult.coverage.incompleteBuckets);
  console.log('Final oiRows length:', cryptoHftResult.oiRows.length);

  const binanceCandles = cryptoHftResult.oiRows.map((r, i) => {
    const wiggle = Math.sin(i / 11) * 0.4;
    return { ts: r.ts, close: 60000 * (1 + wiggle / 100 + i * 0.00001) };
  });
  console.log('Synthetic price candles built (aligned to real OI bucket timestamps):', binanceCandles.length);

  if (binanceCandles.length === 0 || cryptoHftResult.oiRows.length === 0) {
    console.error('\nZERO usable rows -- aborting before backtest (would run on partial data).');
    process.exit(1);
  }

  const zones = []; // no real zones defined by WEJO yet -- use a wide always-active demo zone for this acceptance run
  const prices = binanceCandles.map(c => c.close);
  const demoZone = [{
    id: 'acceptance-demo', label: 'ACCEPTANCE RUN DEMO ZONE', type: 'range',
    top: Math.max(...prices) * 1.05, bottom: Math.min(...prices) * 0.95,
    active: true, availableAtTs: binanceCandles[0].ts,
  }];

  console.log('\n=== Running V1 (strict) ===');
  const v1 = Backtest.runEventStudy(binanceCandles, cryptoHftResult.oiRows, demoZone, { alertModel: 'strict', minBaselineSamples: 500 });
  console.log('V1 alerts:', v1.alerts.length, ' validScoreCount:', v1.meta.validScoreCount, '/', v1.meta.totalCandles);

  console.log('\n=== Running V2 (netProgress) ===');
  const v2 = Backtest.runEventStudy(binanceCandles, cryptoHftResult.oiRows, demoZone, { alertModel: 'netProgress', minBaselineSamples: 500 });
  console.log('V2 alerts:', v2.alerts.length, ' validScoreCount:', v2.meta.validScoreCount, '/', v2.meta.totalCandles);

  require('fs').writeFileSync('/tmp/acceptance-result.json', JSON.stringify({
    window: { startTime, endTime, lookbackDays: LOOKBACK_DAYS, hourStepHours: HOUR_STEP_HOURS },
    binanceCandleCount: binanceCandles.length,
    cryptoHft: {
      rawRowCount: cryptoHftResult.rawRowCount,
      totalRequests: cryptoHftResult.totalRequests,
      skipped404Count: cryptoHftResult.skipped404Count,
      coverage: cryptoHftResult.coverage,
      oiRowCount: cryptoHftResult.oiRows.length,
    },
    v1: { alerts: v1.alerts.length, meta: v1.meta },
    v2: { alerts: v2.alerts.length, meta: v2.meta },
  }, null, 2));
  console.log('\nWrote /tmp/acceptance-result.json');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

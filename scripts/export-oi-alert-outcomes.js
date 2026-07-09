'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const Database = require(path.join(root, 'oi-radar', 'node_modules', 'better-sqlite3'));
const outcome = require(path.join(root, 'oi-radar', 'direct-feed', 'lib', 'outcome-tracker.js'));

const MINUTE_MS = 60 * 1000;
const SEND_HORIZONS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '2h', ms: 2 * 60 * 60 * 1000 },
  { label: '4h', ms: 4 * 60 * 60 * 1000 },
  { label: '12h', ms: 12 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 }
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      out.help = true;
      continue;
    }
    if (arg.indexOf('--') !== 0) throw new Error('unknown argument ' + arg);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.indexOf('--') === 0) throw new Error('--' + key + ' requires a value');
    out[key] = value;
    i++;
  }
  return out;
}

function usage() {
  return [
    'Export sent OI alert outcomes for the static website.',
    '',
    'Usage:',
    '  node scripts/export-oi-alert-outcomes.js',
    '',
    'Optional:',
    '  --db oi-radar/direct-feed/direct-feed.sqlite',
    '  --state oi-radar/direct-feed/observations/telegram-sent.json',
    '  --out data/oi-alert-outcomes.json',
    '  --skip-binance true'
  ].join('\n');
}

function floorMinute(ts) {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

function pctChange(nowValue, thenValue) {
  if (!Number.isFinite(nowValue) || !Number.isFinite(thenValue) || thenValue === 0) return null;
  return (nowValue - thenValue) / thenValue;
}

function aggregateAt(db, bucketTs) {
  const row = db.prepare(
    'SELECT * FROM strict_aggregates WHERE symbol = ? AND bucket_ts = ? ORDER BY feed_version ASC LIMIT 1'
  ).get('BTCUSDT', bucketTs);
  return row === undefined ? null : row;
}

function inferSignalBias(db, report) {
  const outcomes = Array.isArray(report && report.outcomes) ? report.outcomes : [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcomeRow = outcomes[i];
    const signal = outcomeRow && outcomeRow.signal ? outcomeRow.signal : {};
    if (signal.alert_bias && signal.direction) continue;

    if (signal.type === 'oi_expansion_with_price_up' || signal.type === 'upside_oi_flush') {
      signal.direction = 'up';
      signal.alert_bias = 'bullish';
      signal.direction_source = 'signal_type';
      continue;
    }
    if (signal.type === 'oi_expansion_with_price_down' || signal.type === 'downside_oi_flush') {
      signal.direction = 'down';
      signal.alert_bias = 'bearish';
      signal.direction_source = 'signal_type';
      continue;
    }
    if (!Number.isFinite(signal.bucket_ts) || !Number.isInteger(signal.horizon_buckets)) {
      signal.alert_bias = signal.alert_bias || 'neutral';
      signal.direction_source = signal.direction_source || 'unavailable';
      continue;
    }

    const base = aggregateAt(db, signal.bucket_ts);
    const previousTs = signal.bucket_ts - signal.horizon_buckets * 15 * MINUTE_MS;
    const previous = aggregateAt(db, previousTs);
    if (base === null || previous === null ||
        !Number.isFinite(base.conversion_price) ||
        !Number.isFinite(previous.conversion_price)) {
      signal.alert_bias = signal.alert_bias || 'neutral';
      signal.direction_source = signal.direction_source || 'unavailable';
      continue;
    }

    const detectionReturn = pctChange(base.conversion_price, previous.conversion_price);
    signal.direction = detectionReturn >= 0 ? 'up' : 'down';
    signal.alert_bias = signal.direction === 'up' ? 'bullish' : 'bearish';
    signal.direction_source = 'reconstructed_detection_window';
    signal.detection_price_return = detectionReturn;
    signal.previous_bucket_ts = previousTs;
    signal.previous_bucket_iso = new Date(previousTs).toISOString();
  }
}

async function fetchBinanceMinutePrice(cache, minuteTs) {
  const key = String(minuteTs);
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  const url = 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=' +
    encodeURIComponent(String(minuteTs)) + '&limit=1';
  const response = await fetch(url);
  if (!response.ok) throw new Error('Binance Futures klines HTTP ' + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
    cache[key] = null;
    return null;
  }
  const row = rows[0];
  if (Number(row[0]) !== minuteTs) {
    cache[key] = null;
    return null;
  }
  const item = {
    source: 'binance_futures_1m',
    symbol: 'BTCUSDT',
    interval: '1m',
    minute_ts: minuteTs,
    minute_iso: new Date(minuteTs).toISOString(),
    field: 'open',
    price: Number(row[1])
  };
  cache[key] = Number.isFinite(item.price) ? item : null;
  return cache[key];
}

async function enrichSendPriceOutcomes(report) {
  if (typeof fetch !== 'function') {
    report.send_price_enrichment = { ok: false, reason: 'global fetch is unavailable in this Node runtime' };
    return;
  }
  const cache = {};
  let complete = 0;
  let pending = 0;
  for (let i = 0; i < report.outcomes.length; i++) {
    const item = report.outcomes[i];
    const sentTs = item && item.signal ? item.signal.sent_ts : null;
    item.send_price_reference = null;
    item.send_horizons = SEND_HORIZONS.map(function (h) {
      return { label: h.label, target_ts: null, target_iso: null, status: 'missing_sent_ts' };
    });
    if (!Number.isFinite(sentTs)) {
      pending += item.send_horizons.length;
      continue;
    }

    const baseMinute = floorMinute(sentTs);
    const base = await fetchBinanceMinutePrice(cache, baseMinute);
    item.send_price_reference = base;
    if (base === null) {
      item.send_horizons = SEND_HORIZONS.map(function (h) {
        const targetTs = floorMinute(sentTs + h.ms);
        pending++;
        return {
          label: h.label,
          target_ts: targetTs,
          target_iso: new Date(targetTs).toISOString(),
          status: 'missing_sent_price'
        };
      });
      continue;
    }

    item.send_horizons = [];
    for (let j = 0; j < SEND_HORIZONS.length; j++) {
      const h = SEND_HORIZONS[j];
      const targetTs = floorMinute(sentTs + h.ms);
      const target = await fetchBinanceMinutePrice(cache, targetTs);
      const row = {
        label: h.label,
        target_ts: targetTs,
        target_iso: new Date(targetTs).toISOString(),
        status: target === null ? 'pending' : 'complete'
      };
      if (target === null) {
        pending++;
      } else {
        row.price = target.price;
        row.price_delta = target.price - base.price;
        row.price_return = pctChange(target.price, base.price);
        row.price_source = target.source;
        complete++;
      }
      item.send_horizons.push(row);
    }
  }
  report.send_price_enrichment = {
    ok: true,
    source: 'Binance USD-M Futures public klines',
    symbol: 'BTCUSDT',
    interval: '1m',
    price_field: 'open',
    note: 'Sent price is approximated by the open of the 1-minute candle containing sent_ts; exact message-send tick is not stored.',
    complete_horizons: complete,
    pending_horizons: pending
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const dbPath = path.resolve(root, args.db || path.join('oi-radar', 'direct-feed', 'direct-feed.sqlite'));
  const statePath = path.resolve(root, args.state || path.join('oi-radar', 'direct-feed', 'observations', 'telegram-sent.json'));
  const outPath = path.resolve(root, args.out || path.join('data', 'oi-alert-outcomes.json'));

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let report;
  try {
    report = outcome.buildOutcomeReport(db, { state_path: statePath });
    inferSignalBias(db, report);
  } finally {
    db.close();
  }

  if (args['skip-binance'] !== 'true') {
    try {
      await enrichSendPriceOutcomes(report);
    } catch (err) {
      report.send_price_enrichment = {
        ok: false,
        reason: err && err.message ? err.message : String(err),
        fallback: 'local 15m signal-bucket outcomes remain available in horizons'
      };
    }
  } else {
    report.send_price_enrichment = {
      ok: false,
      reason: 'skipped by --skip-binance true',
      fallback: 'local 15m signal-bucket outcomes remain available in horizons'
    };
  }

  report.exported_for_site = true;
  report.exported_path = path.relative(root, outPath).replace(/\\/g, '/');
  report.source_db = path.relative(root, dbPath).replace(/\\/g, '/');
  report.source_state = path.relative(root, statePath).replace(/\\/g, '/');
  report.state_path = report.source_state;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    tag: 'oi-alert-outcomes-export',
    out_path: outPath,
    signal_count: report.signal_count,
    complete_horizons: report.complete_horizons,
    pending_horizons: report.pending_horizons
  }, null, 2));
}

if (require.main === module) {
  main().catch(function (err) {
    console.error('[export-oi-alert-outcomes] FAILED: ' + err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs: parseArgs,
  usage: usage,
  main: main
};

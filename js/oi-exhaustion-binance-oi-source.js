/**
 * oi-exhaustion-binance-oi-source.js
 * Binance USD-M Futures native open interest — an EXTERNAL REFERENCE layer
 * only. This module has NO connection to strategy scoring: it never feeds
 * V1, V2, directional OI chase, zones, the IndexedDB raw-data cache, alert
 * eligibility, or backtest calculations. CryptoHFT major-venue aggregate OI
 * remains the sole strategy data source, unchanged by this file's
 * existence. This exists purely so a person can visually sanity-check
 * whether Binance's own OI moved the way a CryptoHFT-based alert implies,
 * without manually checking Velo/Binance by hand every time.
 *
 * Data source: GET /futures/data/openInterestHist (Binance USD-M Futures),
 * using sum_open_interest_value's Binance analogue `sumOpenInterestValue`
 * (never `sumOpenInterest`, which is contracts, not USD notional). Binance
 * only retains ~30 days of this endpoint's history — expected and fine,
 * this is a reference layer, not a backtest data source.
 */
(function (root) {
  'use strict';

  const BINANCE_OI_HIST_URL = 'https://fapi.binance.com/futures/data/openInterestHist';
  const DEFAULT_SYMBOL = 'BTCUSDT';
  const DEFAULT_PERIOD = '15m';
  const MAX_LIMIT_PER_REQUEST = 500; // Binance's own cap for this endpoint
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

  // Timeframes this reference layer can display. 15m is the identity/raw
  // case (a plain value series — see buildBinanceOIDisplaySeries); the
  // other four aggregate multiple 15m readings into real OHLC.
  const BUCKET_MS = {
    '15m': FIFTEEN_MIN_MS,
    '1h': 60 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };

  /** Parses one raw Binance openInterestHist row. Returns null (not a guess) if either field is missing/non-finite. */
  function parseBinanceOpenInterestRow(row) {
    if (!row || typeof row !== 'object') return null;
    const ts = Number(row.timestamp);
    const oi = Number(row.sumOpenInterestValue); // NEVER sumOpenInterest (contracts) — must be the USD notional value
    if (!Number.isFinite(ts) || !Number.isFinite(oi)) return null;
    return { ts, oi };
  }

  /** Parses, drops invalid rows, de-dupes exact-timestamp collisions (last write wins), sorts ascending. */
  function normalizeBinanceOpenInterestRows(rawRows) {
    if (!Array.isArray(rawRows)) return [];
    const byTs = new Map();
    for (const raw of rawRows) {
      const parsed = parseBinanceOpenInterestRow(raw);
      if (!parsed) continue;
      byTs.set(parsed.ts, parsed);
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }

  /** The UTC bucket-start timestamp (ms) `tsMs` falls into for the given display timeframe. */
  function getUtcBucketStart(tsMs, timeframe) {
    const bucketMs = BUCKET_MS[timeframe] || FIFTEEN_MIN_MS;
    return Math.floor(tsMs / bucketMs) * bucketMs;
  }

  /**
   * Builds the display series for a given timeframe from normalized 15m
   * Binance OI readings.
   *
   * 15m is the identity case: returned as a plain {ts, value} series (a
   * line/step chart) — deliberately NOT synthesized into OHLC candles,
   * since a single 15m reading has no open/high/low/close of its own.
   *
   * 1h/2h/4h/1d aggregate the underlying 15m readings into real OHLC using
   * real UTC bucket boundaries (epoch-aligned, so results don't depend on
   * where the fetched series happens to start): open = first reading in
   * the bucket, close = last, high/low = max/min across the bucket.
   *
   * STRICT completeness: a bucket is only emitted if EVERY expected
   * aligned 15m reading is present — 4 for 1h, 8 for 2h, 16 for 4h, 96 for
   * 1d. A single missing reading anywhere in the bucket omits the WHOLE
   * candle, not a partial one built from what happened to be there. This
   * is deliberately stricter than the price/CryptoHFT display resampling
   * elsewhere in the app (which shows partial buckets) — for this
   * reference layer, a partial OI bucket could visually misrepresent the
   * true high/low/close of that period, and the whole point is an honest
   * sanity check, not a best-effort approximation. A bucket with zero or
   * partial underlying readings simply does not appear in the output — no
   * forward-fill, no interpolation, no partial aggregation. Gaps in the
   * source data show as real gaps in the chart.
   *
   * @param {Array<object>} rows raw Binance openInterestHist rows (or already-parsed {ts,oi} pairs — both accepted)
   * @param {string} timeframe '15m' | '1h' | '2h' | '4h' | '1d'
   * @returns {Array<{ts:number, value:number}>} for 15m, ascending by ts
   *        | Array<{timestamp:number, open:number, high:number, low:number, close:number}> for 1h/2h/4h/1d, ascending by timestamp
   */
  function buildBinanceOIDisplaySeries(rows, timeframe) {
    const valid = normalizeBinanceOpenInterestRows(rows);
    if (!valid.length) return [];

    const bucketMs = BUCKET_MS[timeframe];
    if (!bucketMs || bucketMs <= FIFTEEN_MIN_MS) {
      return valid.map(r => ({ ts: r.ts, value: r.oi }));
    }

    const expectedReadingsPerBucket = Math.round(bucketMs / FIFTEEN_MIN_MS);

    const byBucket = new Map();
    for (const r of valid) {
      const bucketStart = Math.floor(r.ts / bucketMs) * bucketMs;
      let bucket = byBucket.get(bucketStart);
      if (!bucket) { bucket = []; byBucket.set(bucketStart, bucket); }
      bucket.push(r);
    }

    const out = [];
    for (const [bucketStart, readings] of byBucket) {
      if (readings.length !== expectedReadingsPerBucket) continue; // partial bucket — omit entirely, do not approximate
      readings.sort((a, b) => a.ts - b.ts);
      const values = readings.map(r => r.oi);
      out.push({
        timestamp: bucketStart,
        open: readings[0].oi,
        close: readings[readings.length - 1].oi,
        high: Math.max.apply(null, values),
        low: Math.min.apply(null, values),
      });
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /**
   * Coverage diagnostics for the status line: how many bars were actually
   * fetched, the real start/end of that range, and how many 15m slots
   * inside that range are missing (gaps) — computed from the data itself,
   * never assumed complete.
   */
  function computeBinanceOICoverage(rows) {
    const valid = normalizeBinanceOpenInterestRows(rows);
    if (!valid.length) return { barCount: 0, startTime: null, endTime: null, expectedBars: 0, missingBars: 0 };
    const startTime = valid[0].ts;
    const endTime = valid[valid.length - 1].ts;
    const expectedBars = Math.round((endTime - startTime) / FIFTEEN_MIN_MS) + 1;
    return {
      barCount: valid.length,
      startTime,
      endTime,
      expectedBars,
      missingBars: Math.max(0, expectedBars - valid.length),
    };
  }

  // Binance-documented periods for this endpoint and their millisecond
  // step — used only to align startTime/endTime to real period boundaries
  // before sending them, per the investigation requirement that a
  // misaligned boundary (not just an oversized range) could be behind a
  // "startTime is invalid" rejection.
  const PERIOD_STEP_MS = {
    '5m': 5 * 60 * 1000,
    '15m': FIFTEEN_MIN_MS,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };

  /**
   * Coerces a timestamp to a plain, finite integer millisecond value —
   * never a string, a value with decimals, a BigInt, or the result of an
   * invalid Date conversion (NaN). Throws rather than silently sending a
   * malformed value to Binance, since a bad timestamp TYPE is exactly one
   * of the failure modes under investigation here.
   */
  function toBinanceTimestampMs(value, label) {
    if (typeof value === 'bigint') throw new Error(`Binance ${label} must be a plain number, not a BigInt.`);
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`Binance ${label} is not a valid finite number: ${value}`);
    return Math.round(num); // strip any decimal remainder — Binance expects a whole-millisecond integer
  }

  /** Floors `tsMs` to the exact boundary of Binance's own period grid (e.g. every 15 minutes on the UTC clock for period='15m'). */
  function alignToPeriodBoundary(tsMs, period) {
    const stepMs = PERIOD_STEP_MS[period] || FIFTEEN_MIN_MS;
    return Math.floor(tsMs / stepMs) * stepMs;
  }

  /**
   * Paginated fetch of Binance's openInterestHist for the intended
   * [startTime, endTime] range (inclusive on both ends).
   *
   * Binance's own inclusive/exclusive boundary semantics for this
   * endpoint aren't something to take on faith — the request itself pads
   * `endTime` by one 15m step so a reading landing exactly on the
   * intended boundary is never silently dropped by an off-by-one on
   * Binance's side, and the padded/over-fetched result is then filtered
   * back to the CALLER's actual intended range explicitly before
   * returning.
   *
   * Every startTime/endTime sent on the wire is: coerced to a plain
   * integer ms value (toBinanceTimestampMs), aligned to the requested
   * period's real boundary (alignToPeriodBoundary), and logged (URL +
   * typeof) immediately before the request — per the investigation into
   * Binance's "-1130 parameter 'startTime' is invalid" rejection, which
   * is NOT a range-length error (a correctly-under-30-days request still
   * got it), so the value/type/alignment of the timestamp itself is what
   * this hardens against.
   *
   * `fetchFn` is dependency-injected (defaults to global `fetch`) so this
   * is testable in Node without a real network call.
   */
  async function fetchBinanceOpenInterestHist(options) {
    options = options || {};
    const symbol = options.symbol || DEFAULT_SYMBOL;
    const period = options.period || DEFAULT_PERIOD;
    const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    const maxPages = options.maxPages != null ? options.maxPages : 20;
    const log = options.log !== false; // set log:false in tests to keep output quiet

    if (!fetchFn) throw new Error('fetchBinanceOpenInterestHist requires a fetch function (none available in this environment).');
    if (options.startTime == null || options.endTime == null) throw new Error('fetchBinanceOpenInterestHist requires both startTime and endTime.');

    const startTime = alignToPeriodBoundary(toBinanceTimestampMs(options.startTime, 'startTime'), period);
    const endTime = alignToPeriodBoundary(toBinanceTimestampMs(options.endTime, 'endTime'), period);

    // Pad the actual HTTP request range — never assume endTime is
    // inclusive on Binance's side — but ONLY if doing so still keeps the
    // total requested span under Binance's own ~30-day retention ceiling.
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const paddedEndTime = endTime + FIFTEEN_MIN_MS;
    const requestEndTime = (paddedEndTime - startTime) < THIRTY_DAYS_MS ? paddedEndTime : endTime;

    const allRows = [];
    let cursor = startTime;
    let pages = 0;

    while (cursor < requestEndTime && pages < maxPages) {
      const cursorMs = toBinanceTimestampMs(cursor, 'startTime (cursor)');
      const endMs = toBinanceTimestampMs(requestEndTime, 'endTime');
      const url = `${BINANCE_OI_HIST_URL}?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}` +
        `&limit=${MAX_LIMIT_PER_REQUEST}&startTime=${cursorMs}&endTime=${endMs}`;

      if (log && typeof console !== 'undefined') {
        console.log('[BinanceOI] request', {
          url,
          startTime: cursorMs, startTimeType: typeof cursorMs, startTimeIsInteger: Number.isInteger(cursorMs),
          endTime: endMs, endTimeType: typeof endMs, endTimeIsInteger: Number.isInteger(endMs),
        });
      }

      const res = await fetchFn(url);
      if (!res || !res.ok) {
        const status = res ? res.status : 'no response';
        // Surface Binance's actual response body (usually a JSON error
        // object with a code/msg) rather than just the HTTP status — this
        // is what actually explains a 400 (e.g. "startTime is invalid")
        // instead of leaving it a mystery.
        let bodyText = '';
        if (res && typeof res.text === 'function') {
          try { bodyText = await res.text(); } catch (e) { bodyText = '(could not read response body)'; }
        }
        if (log && typeof console !== 'undefined') console.error('[BinanceOI] request failed', { url, status, body: bodyText });
        throw new Error(`Binance openInterestHist request failed (HTTP ${status}): ${bodyText || '(empty response body)'} — url: ${url}`);
      }
      const json = await res.json();
      if (!Array.isArray(json) || json.length === 0) break;

      allRows.push(...json);
      pages++;

      const lastTs = Number(json[json.length - 1].timestamp);
      if (!Number.isFinite(lastTs) || lastTs <= cursor) break; // non-advancing response — stop rather than loop forever
      cursor = lastTs + FIFTEEN_MIN_MS;

      if (json.length < MAX_LIMIT_PER_REQUEST) break; // short page = reached the end of what Binance has
    }

    // Explicit filter back to the caller's ACTUAL intended range — never
    // trust that the padded over-fetch didn't also pull in rows outside
    // [startTime, endTime].
    return normalizeBinanceOpenInterestRows(allRows).filter(r => r.ts >= startTime && r.ts <= endTime);
  }

  /**
   * Isolated diagnostic: tries openInterestHist with (1) no startTime/
   * endTime, (2) startTime only, (3) endTime only, (4) both — so a real
   * -1130 rejection can be attributed to the timestamp value itself, the
   * requested range, or this endpoint's handling of startTime/endTime at
   * all, rather than guessed at. Returns every attempt's outcome; never
   * throws itself (each combination's failure is captured, not fatal to
   * the others). `fetchFn` dependency-injected — real usage should NOT
   * pass one, so it hits the real network.
   */
  async function probeOpenInterestHistParams(options) {
    options = options || {};
    const symbol = options.symbol || DEFAULT_SYMBOL;
    const period = options.period || DEFAULT_PERIOD;
    const limit = options.limit != null ? options.limit : 500;
    const startTime = options.startTime != null ? alignToPeriodBoundary(toBinanceTimestampMs(options.startTime, 'startTime'), period) : null;
    const endTime = options.endTime != null ? alignToPeriodBoundary(toBinanceTimestampMs(options.endTime, 'endTime'), period) : null;
    const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) throw new Error('probeOpenInterestHistParams requires a fetch function (none available in this environment).');

    const combinations = [
      { label: 'no startTime/endTime', includeStart: false, includeEnd: false },
      { label: 'startTime only', includeStart: true, includeEnd: false },
      { label: 'endTime only', includeStart: false, includeEnd: true },
      { label: 'startTime and endTime', includeStart: true, includeEnd: true },
    ];

    const results = [];
    for (const combo of combinations) {
      let url = `${BINANCE_OI_HIST_URL}?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${limit}`;
      if (combo.includeStart && startTime != null) url += `&startTime=${startTime}`;
      if (combo.includeEnd && endTime != null) url += `&endTime=${endTime}`;

      let outcome;
      try {
        const res = await fetchFn(url);
        let bodyText = '';
        if (res && typeof res.text === 'function') {
          try { bodyText = await res.text(); } catch (e) { bodyText = '(could not read response body)'; }
        }
        outcome = { label: combo.label, url, ok: !!(res && res.ok), status: res ? res.status : null, bodyPreview: bodyText.slice(0, 400) };
      } catch (err) {
        outcome = { label: combo.label, url, ok: false, status: null, bodyPreview: String((err && err.message) || err) };
      }
      if (typeof console !== 'undefined') {
        console.log(`[BinanceOI probe] ${combo.label}: ${outcome.ok ? 'OK' : 'FAILED'} (status ${outcome.status})`, outcome.url);
        if (!outcome.ok) console.log(`[BinanceOI probe]   body: ${outcome.bodyPreview}`);
      }
      results.push(outcome);
    }
    return results;
  }

  const OIExhaustionBinanceOISource = {
    BINANCE_OI_HIST_URL,
    DEFAULT_SYMBOL,
    DEFAULT_PERIOD,
    MAX_LIMIT_PER_REQUEST,
    BUCKET_MS,
    parseBinanceOpenInterestRow,
    normalizeBinanceOpenInterestRows,
    getUtcBucketStart,
    buildBinanceOIDisplaySeries,
    computeBinanceOICoverage,
    fetchBinanceOpenInterestHist,
    PERIOD_STEP_MS,
    toBinanceTimestampMs,
    alignToPeriodBoundary,
    probeOpenInterestHistParams,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionBinanceOISource;
  } else {
    root.OIExhaustionBinanceOISource = OIExhaustionBinanceOISource;
  }

})(typeof window !== 'undefined' ? window : globalThis);

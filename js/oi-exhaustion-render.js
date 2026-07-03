/**
 * oi-exhaustion-render.js
 * UI layer for the OI Exhaustion tab. Wires the pure engine/backtest modules
 * to the DOM — this file itself does no scoring/state-machine math, it only
 * fetches data, calls OIExhaustionEngine/OIExhaustionBacktest, and renders.
 *
 * Data source rule (REPLACED — Bybit-only OI is no longer the live source):
 *  - OI SIGNAL SOURCE: CryptoHFT major-venue aggregate (Binance Futures +
 *    Bybit + OKX + Bitget BTC perpetuals, sum_open_interest_value only),
 *    bucketed to 15m UTC. See oi-exhaustion-cryptohft-source.js for the
 *    aggregation rules (last-observation-per-bucket, all-four-venues
 *    required, no forward-fill, no partial aggregate).
 *  - PRICE SOURCE (both signal AND chart): Binance BTCUSDT spot candles,
 *    now fetched at 15m to match the OI bucket interval exactly — there is
 *    only one candle series now, used for both scoring and display.
 *  - Bybit fetch functions (fetchBybitOI/fetchBybitCandles) remain defined
 *    below with their existing tests intact, but are NOT called anywhere
 *    in the live pipeline — Bybit is not the default/live source anymore.
 *  - CryptoHFTData requires an API key (unlike the old Bybit/Binance public
 *    endpoints) — entered in Parameters, stored in localStorage alongside
 *    the rest of settings, never logged or sent anywhere except the
 *    CryptoHFTData download endpoint itself.
 */
'use strict';

(function (root) {

  const SETTINGS_KEY = 'oix_settings_v1';
  const ZONES_KEY = 'oix_zones_v1';

  const DEFAULT_SETTINGS = {
    lookbackDays: 90,
    signalWindow: 48, // 12h of 15m candles (was 144 * 5m under Bybit)
    baselineLookbackCandles: 2880, // 30d * 96/day at 15m (was 8640 * 5m)
    minBaselineSamples: 500,
    entryPercentile: 95,
    rearmPercentile: 80,
    alertModel: 'netProgress', // UI default per explicit request; engine/backtest default independently to 'strict' for backward compatibility
    oiRecencyFilterEnabled: false, // disabled by default, per explicit request — not auto-tuned
    minimumRecentOIChangePct: 0,
    oiRecencyWindow: '1h',
    cryptoHftApiKey: '', // required for the CryptoHFT aggregate OI source; never hardcoded, never logged
  };

  const VALID_ALERT_MODELS = ['strict', 'netProgress'];
  const VALID_OI_RECENCY_WINDOWS = ['30m', '1h', '2h', '4h'];

  const Probe = (typeof module !== 'undefined' && module.exports)
    ? require('./oi-exhaustion-probe.js')
    : window.OIExhaustionProbe;

  const CryptoHFTSource = (typeof module !== 'undefined' && module.exports)
    ? require('./oi-exhaustion-cryptohft-source.js')
    : window.OIExhaustionCryptoHFTSource;

  // ── Fetch reliability: rate-limit retry, backoff, and raw-data caching ──
  // (all pure / dependency-injected so they're testable in Node without a
  // real network or DOM — see fetchBybitOI/fetchBybitCandles below, which
  // are built on top of these and accept injectable fetchFn/sleepFn.)

  const SYMBOL = 'BTCUSDT';
  const CATEGORY = 'linear';
  const PAGE_LIMIT = 200;
  const MAX_PAGES = 700;
  const BYBIT_PAGE_DELAY_MS = 600; // conservative default, within the requested 500-750ms range
  const BINANCE_PAGE_DELAY_MS = 200; // separate exchange, separate rate-limit domain
  const CHART_INTERVAL_MS = 15 * 60 * 1000; // 15m — signal AND chart candles, same series now
  const CRYPTOHFT_BUCKET_MS = 15 * 60 * 1000;
  // Canonical 3-venue aggregate basket. bitget_futures is deliberately
  // EXCLUDED — confirmed (via real downloaded files across 3 different
  // dates spanning April-June 2026) that CryptoHFTData's bitget_futures
  // feed has sum_open_interest_value = null in 100% of rows. This is a
  // fixed exclusion, not dynamic coverage — the model never falls back to
  // a 4th venue and never tolerates a 2-of-3 partial aggregate either.
  const CRYPTOHFT_REQUIRED_VENUES = ['binance_futures', 'bybit', 'okx_futures'];
  const CRYPTOHFT_SYMBOL_BY_VENUE = {
    binance_futures: 'BTCUSDT',
    bybit: 'BTCUSDT',
    okx_futures: 'BTC-USDT-SWAP',
  };
  const CRYPTOHFT_PAGE_DELAY_MS = 300; // conservative default between CryptoHFTData requests
  const RATE_LIMIT_RETCODE = 10006;
  const DEFAULT_MAX_RATE_LIMIT_RETRIES = 6;
  const RATE_LIMIT_SAFETY_BUFFER_MS = 500;
  const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000];
  const BACKOFF_CAP_MS = 30000;

  function realSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  /** HTTP 429 or Bybit retCode 10006 — the two rate-limit signals we retry on. */
  function isRateLimitedResponse(httpStatus, json) {
    return httpStatus === 429 || !!(json && json.retCode === RATE_LIMIT_RETCODE);
  }

  /**
   * Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, then capped at 30s
   * for any further attempt. Jitter is +/-25% so simultaneous retries don't
   * all land on the exact same instant. `randomFn` is injectable so tests
   * can make this deterministic.
   */
  function computeBackoffDelayMs(attemptIndex, randomFn) {
    randomFn = randomFn || Math.random;
    const base = attemptIndex < BACKOFF_SCHEDULE_MS.length ? BACKOFF_SCHEDULE_MS[attemptIndex] : BACKOFF_CAP_MS;
    const capped = Math.min(BACKOFF_CAP_MS, base);
    const jitterFactor = 0.75 + randomFn() * 0.5; // 0.75x - 1.25x
    return Math.round(Math.min(BACKOFF_CAP_MS, capped * jitterFactor));
  }

  /**
   * Reads Bybit's `X-Bapi-Limit-Reset-Timestamp` header case-insensitively
   * from a Headers-entries-like iterable of [key, value] pairs, and returns
   * how long to wait (ms) until that reset time plus a small safety buffer.
   * Returns null if the header is absent/unparseable, so the caller falls
   * back to exponential backoff.
   */
  function parseRateLimitResetWaitMs(headerEntries, nowMs, safetyBufferMs) {
    if (!headerEntries) return null;
    let resetRaw = null;
    for (const entry of headerEntries) {
      const key = entry[0], value = entry[1];
      if (String(key).toLowerCase() === 'x-bapi-limit-reset-timestamp') { resetRaw = value; break; }
    }
    if (resetRaw == null) return null;
    const resetTs = parseInt(resetRaw, 10);
    if (!isFinite(resetTs)) return null;
    const buffer = safetyBufferMs != null ? safetyBufferMs : RATE_LIMIT_SAFETY_BUFFER_MS;
    return Math.max(0, resetTs - nowMs + buffer);
  }

  /**
   * Fetches a single URL, retrying the SAME url (same page/cursor — nothing
   * about the request changes between attempts) whenever the response is
   * rate-limited, up to `maxRetries` times. Prefers the server's own reset
   * timestamp when present, falls back to exponential backoff+jitter.
   * Throws (does not return partial/undefined data) once retries are
   * exhausted — callers must not catch-and-continue with a missing page.
   */
  async function fetchWithRateLimitRetry(fetchFn, sleepFn, url, opts) {
    opts = opts || {};
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : DEFAULT_MAX_RATE_LIMIT_RETRIES;
    const onRetry = opts.onRetry || null;
    const nowFn = opts.nowFn || (() => Date.now());
    const randomFn = opts.randomFn || Math.random;

    let attempt = 0;
    while (true) {
      const res = await fetchFn(url);
      let json = null;
      try { json = await res.json(); } catch (e) { /* leave json null, caller decides if that's fatal */ }

      if (!isRateLimitedResponse(res.status, json)) {
        return { res, json };
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Rate-limited (HTTP 429 / retCode ${RATE_LIMIT_RETCODE}) and exhausted ${maxRetries} retries`);
      }

      let waitMs = null;
      if (res.headers && typeof res.headers.entries === 'function') {
        waitMs = parseRateLimitResetWaitMs(Array.from(res.headers.entries()), nowFn(), RATE_LIMIT_SAFETY_BUFFER_MS);
      }
      if (waitMs === null) waitMs = computeBackoffDelayMs(attempt - 1, randomFn);

      if (onRetry) onRetry(attempt, waitMs);
      await sleepFn(waitMs);
      // loop retries the exact same `url` — same page/cursor, nothing skipped
    }
  }

  /**
   * Lightweight in-memory raw-data cache, keyed only by lookbackDays (the
   * one setting that actually changes the fetch window). A parameter-only
   * change (percentile, rearm, alert model, OI recency filter/threshold,
   * baseline settings) leaves lookbackDays untouched, so this returns the
   * same cached candles/OI and the caller can rerun analysis without
   * refetching. Returns null on any mismatch — caller then does a real fetch.
   */
  const RAW_DATA_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  /**
   * Cache hit requires BOTH: matching lookbackDays AND still within the
   * freshness TTL (default 15 minutes) measured from when it was fetched.
   * `nowMs`/`ttlMs` are injectable for testing; in normal use they default
   * to the real clock and the 15-minute default above. A cache with no
   * `cachedAt` is treated as stale (never hits) rather than assumed fresh.
   */
  /**
   * Safe wrapper around Number.prototype.toLocaleString — any non-finite
   * or non-numeric input (undefined, null, NaN, a wrong-shaped progress
   * event, a missing cache field) returns the literal string 'unknown'
   * instead of throwing. `opts` is passed through to toLocaleString for
   * numeric formatting (e.g. { maximumFractionDigits: 0 }).
   */
  function safeNumber(value, opts) {
    if (typeof value !== 'number' || !isFinite(value)) return 'unknown';
    return value.toLocaleString(undefined, opts);
  }

  /**
   * Safe UTC-date formatter for optional timestamp fields (cachedAt,
   * window start/end, etc). Returns 'unknown' for anything that isn't a
   * finite epoch-ms number or produces an invalid Date, rather than
   * throwing or silently rendering "Invalid Date".
   */
  function safeUtcDateString(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return 'unknown';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'unknown';
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function getCachedRawData(cache, lookbackDays, nowMs, ttlMs) {
    if (!cache || cache.lookbackDays !== lookbackDays) return null;
    if (typeof cache.cachedAt !== 'number') return null;
    const now = nowMs != null ? nowMs : Date.now();
    const ttl = ttlMs != null ? ttlMs : RAW_DATA_CACHE_TTL_MS;
    if (now - cache.cachedAt > ttl) return null; // expired
    return cache;
  }

  function parseBybitKlineRow(raw) {
    if (!Array.isArray(raw) || raw.length < 5) return null;
    const ts = parseInt(raw[0], 10);
    const open = parseFloat(raw[1]), high = parseFloat(raw[2]), low = parseFloat(raw[3]), close = parseFloat(raw[4]);
    if (![ts, open, high, low, close].every(isFinite)) return null;
    return { ts, open, high, low, close };
  }

  // ── Fetch: Bybit OI (signal source, public, no credentials) ────────────
  // Built on fetchWithRateLimitRetry so a 429/10006 mid-pagination retries
  // the SAME page rather than restarting the whole 90-day pull. fetchFn/
  // sleepFn default to real fetch/setTimeout in the browser, but are
  // injectable so this exact function is unit-testable in Node with mocks.

  async function fetchBybitOI(startTime, endTime, options) {
    options = options || {};
    const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    const sleepFn = options.sleepFn || realSleep;
    const onProgress = options.onProgress || null;
    const pageDelayMs = options.pageDelayMs != null ? options.pageDelayMs : BYBIT_PAGE_DELAY_MS;
    const maxRetries = options.maxRetries != null ? options.maxRetries : DEFAULT_MAX_RATE_LIMIT_RETRIES;

    const base = 'https://api.bybit.com/v5/market/open-interest';
    let cursor, pageIndex = 0;
    const pagesOfRows = [];
    let rowsSoFar = 0;

    while (pageIndex < MAX_PAGES) {
      const params = new URLSearchParams({
        category: CATEGORY, symbol: SYMBOL, intervalTime: '5min',
        limit: String(PAGE_LIMIT), startTime: String(startTime), endTime: String(endTime),
      });
      if (cursor) params.set('cursor', cursor);
      const url = `${base}?${params.toString()}`;

      const { res, json } = await fetchWithRateLimitRetry(fetchFn, sleepFn, url, {
        maxRetries,
        onRetry: (attempt, waitMs) => {
          if (onProgress) onProgress({ type: 'rate_limited', source: 'oi', page: pageIndex, attempt, maxRetries, waitMs });
        },
      });

      if (!res.ok || !json || json.retCode !== 0) {
        throw new Error(`Bybit OI fetch failed at page ${pageIndex}: httpStatus=${res.status} retCode=${json && json.retCode} retMsg=${json && json.retMsg}`);
      }
      const list = (json.result && json.result.list) || [];
      const rows = list.map(Probe.parseRow).filter(Boolean);
      pagesOfRows.push(rows);
      rowsSoFar += rows.length;
      if (onProgress) onProgress({ type: 'page', source: 'oi', page: pageIndex, rowsThisPage: rows.length, rowsSoFar });

      pageIndex++;
      const nextCursor = json.result && json.result.nextPageCursor;
      if (!nextCursor || rows.length === 0) break;
      cursor = nextCursor;
      await sleepFn(pageDelayMs);
    }
    return Probe.mergeDedupe(pagesOfRows).rows;
  }

  // ── Fetch: Bybit candles (signal source, paired with OI) ────────────────

  async function fetchBybitCandles(startTime, endTime, options) {
    options = options || {};
    const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    const sleepFn = options.sleepFn || realSleep;
    const onProgress = options.onProgress || null;
    const pageDelayMs = options.pageDelayMs != null ? options.pageDelayMs : BYBIT_PAGE_DELAY_MS;
    const maxRetries = options.maxRetries != null ? options.maxRetries : DEFAULT_MAX_RATE_LIMIT_RETRIES;

    const base = 'https://api.bybit.com/v5/market/kline';
    let currentEnd = endTime, pageIndex = 0;
    const pagesOfRows = [];
    let rowsSoFar = 0;

    while (pageIndex < MAX_PAGES && currentEnd > startTime) {
      const params = new URLSearchParams({
        category: CATEGORY, symbol: SYMBOL, interval: '5',
        start: String(startTime), end: String(currentEnd), limit: String(PAGE_LIMIT),
      });
      const url = `${base}?${params.toString()}`;

      const { res, json } = await fetchWithRateLimitRetry(fetchFn, sleepFn, url, {
        maxRetries,
        onRetry: (attempt, waitMs) => {
          if (onProgress) onProgress({ type: 'rate_limited', source: 'bybit-candles', page: pageIndex, attempt, maxRetries, waitMs });
        },
      });

      if (!res.ok || !json || json.retCode !== 0) {
        throw new Error(`Bybit candle fetch failed at page ${pageIndex}: httpStatus=${res.status} retCode=${json && json.retCode} retMsg=${json && json.retMsg}`);
      }
      const list = (json.result && json.result.list) || [];
      const rows = list.map(parseBybitKlineRow).filter(Boolean);
      pagesOfRows.push(rows);
      rowsSoFar += rows.length;
      if (onProgress) onProgress({ type: 'page', source: 'bybit-candles', page: pageIndex, rowsThisPage: rows.length, rowsSoFar });

      pageIndex++;
      if (rows.length === 0) break;
      const minTs = Math.min(...rows.map(r => r.ts));
      if (minTs <= startTime) break;
      currentEnd = minTs - 1;
      await sleepFn(pageDelayMs);
    }
    const byTs = new Map();
    for (const page of pagesOfRows) for (const r of page) byTs.set(r.ts, r);
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }

  // ── Fetch: Binance candles (chart display only) ─────────────────────────
  // Separate exchange, separate rate-limit domain — no retry logic here by
  // design (not in scope; Bybit retry logic is untouched). Moved into this
  // shared/testable section (previously browser-only) purely so it can be
  // exercised in Node tests with an injected fetchFn/sleepFn, same pattern
  // as the two Bybit fetchers above.

  async function fetchBinanceCandles(startTime, endTime, options) {
    options = options || {};
    const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    const sleepFn = options.sleepFn || realSleep;
    const onProgress = options.onProgress || null;
    const pageDelayMs = options.pageDelayMs != null ? options.pageDelayMs : BINANCE_PAGE_DELAY_MS;

    const allCandles = [];
    let ts = startTime;
    let pageIndex = 0;
    while (ts <= endTime && pageIndex < MAX_PAGES) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=1000&startTime=${ts}&endTime=${endTime}`;
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`Binance candle fetch failed at page ${pageIndex}: httpStatus=${res.status} ${await res.text()}`);
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) break;
      for (const c of list) {
        allCandles.push({ ts: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
      }
      if (onProgress) onProgress({ type: 'page', source: 'binance-candles', page: pageIndex, rowsThisPage: list.length, rowsSoFar: allCandles.length });
      pageIndex++;
      const lastTs = list[list.length - 1][0];
      if (lastTs <= ts) break;
      ts = lastTs + CHART_INTERVAL_MS;
      await sleepFn(pageDelayMs);
    }
    return allCandles;
  }

  // ── Fetch: CryptoHFT major-venue aggregate OI (the live OI signal source) ──
  // Fetches one .parquet.zst object per venue per requested hour step,
  // decodes (outer Zstd via injected decodeZst, then Parquet via injected
  // parseParquet — real implementations wire fzstd + hyparquet, see the
  // browser section below), injects `exchange` from the requested path
  // (the parquet rows themselves don't carry it), then hands everything to
  // the already-proven bucketAndAggregateOI for the actual aggregation.
  //
  // `hourStepHours` defaults to 1, NOT a coarser value — CORRECTED after
  // measuring real per-venue coverage. binance_futures files do contain a
  // wide (~42.5h) overlapping window and tolerate sparse fetching fine, but
  // bybit and okx_futures do NOT share that behavior: a real 14-day, 3-venue
  // measurement at hourStepHours=8 produced only 165/1344 (12.3%) complete
  // 3-venue 15m buckets — bybit and okx_futures were the limiting factor
  // every time (confirmed: "bybit+okx_futures missing" was 100% of the
  // incomplete-bucket reasons). A targeted re-test of bybit alone at
  // hourStepHours=1 for one day reached 93/96 buckets (96.9%) — confirming
  // this is a FETCH-DENSITY problem, not a 15m-bucket-size problem. Do not
  // widen this back down without re-measuring bybit/okx_futures specifically.

  async function fetchCryptoHFTAggregateOI(startTime, endTime, apiKey, options) {
    options = options || {};
    const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    const sleepFn = options.sleepFn || realSleep;
    const onProgress = options.onProgress || null;
    const pageDelayMs = options.pageDelayMs != null ? options.pageDelayMs : CRYPTOHFT_PAGE_DELAY_MS;
    const decodeZst = options.decodeZst; // required: (Uint8Array) => Uint8Array
    const parseParquet = options.parseParquet; // required: (Uint8Array) => Promise<Array<object>>
    const venues = options.venues || CRYPTOHFT_REQUIRED_VENUES;
    const bucketMs = options.bucketMs != null ? options.bucketMs : CRYPTOHFT_BUCKET_MS;
    const hourStepHours = options.hourStepHours != null ? options.hourStepHours : 1;
    const symbolByVenue = options.symbolByVenue || CRYPTOHFT_SYMBOL_BY_VENUE;

    if (!apiKey) throw new Error('CryptoHFTData API key is required — enter it in Parameters before fetching.');
    if (typeof decodeZst !== 'function' || typeof parseParquet !== 'function') {
      throw new Error('fetchCryptoHFTAggregateOI requires decodeZst and parseParquet to be provided.');
    }

    const HOUR_MS = 60 * 60 * 1000;
    const stepMs = hourStepHours * HOUR_MS;
    const firstHour = Math.floor(startTime / HOUR_MS) * HOUR_MS;
    const hourStamps = [];
    for (let h = firstHour; h <= endTime; h += stepMs) hourStamps.push(h);
    const totalRequests = venues.length * hourStamps.length;

    const allRawRows = [];
    let requestIndex = 0;
    let skipped404Count = 0;

    for (const venue of venues) {
      const symbol = symbolByVenue[venue] || 'BTCUSDT';
      for (const hourStart of hourStamps) {
        requestIndex++;
        const d = new Date(hourStart);
        const dateStr = d.toISOString().slice(0, 10);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const path = `${venue}/${dateStr}/${hh}/${symbol}_open_interest.parquet.zst`;
        const url = `https://api.cryptohftdata.com/download?file=${encodeURIComponent(path)}&api_key=${encodeURIComponent(apiKey)}`;

        if (onProgress) onProgress({ type: 'page', source: 'cryptohft', venue, path, requestIndex, totalRequests, rowsSoFar: allRawRows.length });

        let res;
        try {
          res = await fetchFn(url);
        } catch (err) {
          throw new Error(`CryptoHFTData network error fetching ${path}: ${err.message}`);
        }

        if (res.status === 404) {
          skipped404Count++;
          // No file for this venue/hour — legitimate absence, not a fatal
          // error. bucketAndAggregateOI already handles missing coverage
          // transparently (fewer complete buckets), no fabrication needed.
        } else if (!res.ok) {
          throw new Error(`CryptoHFTData fetch failed for ${path}: httpStatus=${res.status}`);
        } else {
          let compressedBytes;
          try {
            const buf = await res.arrayBuffer();
            compressedBytes = new Uint8Array(buf);
          } catch (err) {
            throw new Error(`CryptoHFTData response read failed for ${path}: ${err.message}`);
          }

          let decompressedBytes;
          try {
            decompressedBytes = decodeZst(compressedBytes);
          } catch (err) {
            throw new Error(`Zstd decompression failed for ${path}: ${err.message}`);
          }

          let rows;
          try {
            rows = await parseParquet(decompressedBytes);
          } catch (err) {
            throw new Error(`Parquet parsing failed for ${path}: ${err.message}`);
          }

          for (const r of rows) {
            allRawRows.push(Object.assign({ exchange: venue }, r));
          }
        }

        await sleepFn(pageDelayMs);
      }
    }

    const oiRows = CryptoHFTSource.bucketAndAggregateOI(allRawRows, bucketMs, venues);
    const coverage = CryptoHFTSource.summarizeBucketCoverage(allRawRows, bucketMs, venues);

    return { oiRows, rawRowCount: allRawRows.length, coverage, skipped404Count, totalRequests };
  }

  // ── Pure logic (no DOM) — exported for Node tests ───────────────────────

  /** Fills in any missing fields with defaults; clamps obviously invalid values. */
  const SETTINGS_MIGRATION_KEY = 'oix_settings_migrated_15m_v1';
  // Exact pre-15m-migration defaults, used ONLY to detect "this is almost
  // certainly a stale untouched value from before the CryptoHFT/15m
  // migration," not to detect any value that happens to equal these numbers
  // for other reasons. This exists because DEFAULT_SETTINGS changed
  // (signalWindow 144->48, baselineLookbackCandles 8640->2880) but anyone
  // who already had settings saved in localStorage keeps their OLD saved
  // values forever otherwise — Object.assign(DEFAULT_SETTINGS, raw) always
  // lets a present raw value win, silently reintroducing the old 5m-era
  // window/baseline size under the hood while the rest of the app now
  // believes it's running on 15m candles.
  const PRE_15M_DEFAULTS = { signalWindow: 144, baselineLookbackCandles: 8640 };

  /**
   * Runs at most ONCE per browser (gated by SETTINGS_MIGRATION_KEY in
   * localStorage, checked by the caller). If a saved settings object still
   * has the exact old 5m-era default values, replaces them with the new
   * 15m-era defaults. Any value that ISN'T exactly the old default is left
   * untouched — this never overwrites a value the user deliberately chose,
   * before or after migration. Pure function; does not touch localStorage
   * itself. Returns a new object, does not mutate the input.
   */
  function migrateStaleCadenceSettings(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const migrated = Object.assign({}, raw);
    if (migrated.signalWindow === PRE_15M_DEFAULTS.signalWindow) {
      migrated.signalWindow = DEFAULT_SETTINGS.signalWindow;
    }
    if (migrated.baselineLookbackCandles === PRE_15M_DEFAULTS.baselineLookbackCandles) {
      migrated.baselineLookbackCandles = DEFAULT_SETTINGS.baselineLookbackCandles;
    }
    return migrated;
  }

  function validateSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.lookbackDays = clampNumber(s.lookbackDays, 1, 3650, DEFAULT_SETTINGS.lookbackDays);
    s.signalWindow = clampNumber(s.signalWindow, 1, 10000, DEFAULT_SETTINGS.signalWindow);
    s.baselineLookbackCandles = clampNumber(s.baselineLookbackCandles, 1, 100000, DEFAULT_SETTINGS.baselineLookbackCandles);
    s.minBaselineSamples = clampNumber(s.minBaselineSamples, 1, s.baselineLookbackCandles, DEFAULT_SETTINGS.minBaselineSamples);
    s.entryPercentile = clampNumber(s.entryPercentile, 50, 100, DEFAULT_SETTINGS.entryPercentile);
    s.rearmPercentile = clampNumber(s.rearmPercentile, 0, s.entryPercentile, DEFAULT_SETTINGS.rearmPercentile);
    s.alertModel = VALID_ALERT_MODELS.indexOf(s.alertModel) !== -1 ? s.alertModel : DEFAULT_SETTINGS.alertModel;
    s.oiRecencyFilterEnabled = s.oiRecencyFilterEnabled === true || s.oiRecencyFilterEnabled === 'true';
    s.minimumRecentOIChangePct = clampNumber(s.minimumRecentOIChangePct, -1000, 1000, DEFAULT_SETTINGS.minimumRecentOIChangePct);
    s.oiRecencyWindow = VALID_OI_RECENCY_WINDOWS.indexOf(s.oiRecencyWindow) !== -1 ? s.oiRecencyWindow : DEFAULT_SETTINGS.oiRecencyWindow;
    s.cryptoHftApiKey = typeof s.cryptoHftApiKey === 'string' ? s.cryptoHftApiKey.trim() : DEFAULT_SETTINGS.cryptoHftApiKey;
    return s;
  }

  function clampNumber(v, min, max, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Converts a 'level' zone row (a single price + tolerance) into the
   * internal bounded {top, bottom} representation the engine already uses.
   * 'range' rows pass through unchanged (top/bottom supplied directly).
   * Does not mutate the input.
   */
  function levelToBoundedZone(zone) {
    if (!zone || zone.type !== 'level') return Object.assign({}, zone);
    const level = Number(zone.level);
    const tolerance = Number(zone.tolerance) || 0;
    return Object.assign({}, zone, {
      top: level + tolerance,
      bottom: level - tolerance,
    });
  }

  /** Normalizes a raw zone-editor row into the shape the engine expects. */
  function normalizeZone(raw) {
    const base = {
      id: raw.id || ('zone-' + Math.random().toString(36).slice(2, 10)),
      label: raw.label || '',
      type: raw.type === 'level' ? 'level' : 'range',
      active: raw.enabled !== false && raw.active !== false,
      availableAtTs: raw.availableAtTs != null && raw.availableAtTs !== '' ? Number(raw.availableAtTs) : null,
      inactiveAtTs: raw.inactiveAtTs != null && raw.inactiveAtTs !== '' ? Number(raw.inactiveAtTs) : null,
    };
    if (base.type === 'level') {
      base.level = Number(raw.level);
      base.tolerance = Number(raw.tolerance) || 0;
    } else {
      base.top = Number(raw.top);
      base.bottom = Number(raw.bottom);
    }
    return levelToBoundedZone(base);
  }

  /** Serializes zone rows to a JSON string for localStorage. */
  function serializeZones(zones) {
    return JSON.stringify(zones);
  }

  /** Deserializes zones from localStorage; returns [] on any parse failure. */
  function deserializeZones(str) {
    if (!str) return [];
    try {
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Maps an alert (Bybit-timestamped, 5m-aligned) to the Binance candle used
   * for chart display at that same timestamp. Returns null if no exact-
   * timestamp Binance candle exists (chart simply won't plot that marker
   * rather than guessing a position). Used when the chart candle interval
   * matches the signal interval exactly (5m).
   */
  function mapAlertToChartPoint(alert, binanceCandlesByTs) {
    const candle = binanceCandlesByTs.get(alert.timestamp);
    if (!candle) return null;
    return {
      ts: alert.timestamp,
      chartPrice: candle.close,
      alert: alert,
    };
  }

  /**
   * Finds the index of the coarser-interval candle (e.g. 4h) that CONTAINS
   * a given 5m-aligned alert timestamp — i.e. the last candle whose open
   * time is <= alertTs and alertTs < that candle's open time + intervalMs.
   * Used when the chart is displayed at a coarser interval than the signal
   * (alert timestamps won't land on exact 4h boundaries). Binary search
   * over ascending candle timestamps. Returns -1 if no containing candle
   * exists (alert falls before the first candle or in a gap).
   */
  function findContainingCandleIndex(alertTs, sortedCandles, intervalMs) {
    if (!sortedCandles.length) return -1;
    let lo = 0, hi = sortedCandles.length - 1;
    if (alertTs < sortedCandles[0].ts) return -1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sortedCandles[mid].ts <= alertTs) lo = mid; else hi = mid - 1;
    }
    const candle = sortedCandles[lo];
    if (alertTs >= candle.ts && alertTs < candle.ts + intervalMs) return lo;
    return -1; // fell in a gap between candles
  }

  /**
   * Same as mapAlertToChartPoint but for a coarser chart interval — maps
   * the alert onto its CONTAINING candle rather than requiring an exact
   * timestamp match.
   */
  function mapAlertToContainingChartPoint(alert, sortedCandles, intervalMs) {
    const idx = findContainingCandleIndex(alert.timestamp, sortedCandles, intervalMs);
    if (idx === -1) return null;
    const candle = sortedCandles[idx];
    return {
      ts: candle.ts,
      chartPrice: candle.close,
      alert: alert,
    };
  }

  function buildBinanceCandleIndex(binanceCandles) {
    const map = new Map();
    for (const c of binanceCandles) map.set(c.ts, c);
    return map;
  }

  /** Start timestamp of the latest fully completed 15m candle, given "now". */
  function latestCompletedCandleStart(nowMs) {
    const currentCandleStart = Math.floor(nowMs / CHART_INTERVAL_MS) * CHART_INTERVAL_MS;
    return currentCandleStart - CHART_INTERVAL_MS;
  }

  const OIExhaustionRender = {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    ZONES_KEY,
    SETTINGS_MIGRATION_KEY,
    PRE_15M_DEFAULTS,
    migrateStaleCadenceSettings,
    CHART_INTERVAL_MS,
    validateSettings,
    clampNumber,
    levelToBoundedZone,
    normalizeZone,
    serializeZones,
    deserializeZones,
    mapAlertToChartPoint,
    findContainingCandleIndex,
    mapAlertToContainingChartPoint,
    buildBinanceCandleIndex,
    latestCompletedCandleStart,
    // Fetch reliability — exported for Node testing (all dependency-injected,
    // no real network/DOM required to exercise them).
    RATE_LIMIT_RETCODE,
    DEFAULT_MAX_RATE_LIMIT_RETRIES,
    BYBIT_PAGE_DELAY_MS,
    BINANCE_PAGE_DELAY_MS,
    isRateLimitedResponse,
    computeBackoffDelayMs,
    parseRateLimitResetWaitMs,
    fetchWithRateLimitRetry,
    RAW_DATA_CACHE_TTL_MS,
    getCachedRawData,
    safeNumber,
    safeUtcDateString,
    fetchBybitOI,
    fetchBybitCandles,
    fetchBinanceCandles,
    fetchCryptoHFTAggregateOI,
    CRYPTOHFT_BUCKET_MS,
    CRYPTOHFT_REQUIRED_VENUES,
    CRYPTOHFT_SYMBOL_BY_VENUE,
    parseBybitKlineRow,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionRender;
    return; // Node/test environment — stop here, no DOM code below.
  }

  // ── Everything below touches the DOM / network — browser only ──────────

  const Engine = window.OIExhaustionEngine;
  const Backtest = window.OIExhaustionBacktest;
  // Probe, CryptoHFTSource, fetchBybitOI, fetchBybitCandles, fetchBinanceCandles,
  // fetchCryptoHFTAggregateOI, parseBybitKlineRow, SYMBOL, CATEGORY, PAGE_LIMIT,
  // MAX_PAGES, BINANCE_PAGE_DELAY_MS, CHART_INTERVAL_MS, CRYPTOHFT_* are all
  // defined above (shared/testable section) and already in scope here via
  // closure — not redeclared.

  function sleep(ms) { return realSleep(ms); }

  // ── CryptoHFT decode wiring: fzstd (global, CDN <script>) + hyparquet
  // (dynamically imported ESM from CDN, cached after first load) ─────────

  let hyparquetModulePromise = null;
  function loadHyparquet() {
    if (!hyparquetModulePromise) {
      hyparquetModulePromise = import('https://cdn.jsdelivr.net/npm/hyparquet@1.26.2/src/index.js');
    }
    return hyparquetModulePromise;
  }

  function decodeZstBrowser(compressedBytes) {
    if (typeof fzstd === 'undefined') {
      throw new Error('fzstd is not loaded — check the <script src="...fzstd..."> tag in index.html.');
    }
    return fzstd.decompress(compressedBytes);
  }

  async function parseParquetBrowser(decompressedBytes) {
    const { parquetReadObjects } = await loadHyparquet();
    const arrayBuffer = decompressedBytes.buffer.slice(
      decompressedBytes.byteOffset,
      decompressedBytes.byteOffset + decompressedBytes.byteLength
    );
    return parquetReadObjects({ file: arrayBuffer });
  }

  // ── State ────────────────────────────────────────────────────────────

  const state = {
    settings: DEFAULT_SETTINGS,
    zones: [],
    lastRun: null, // { result, binanceCandles, binanceIndex, chartPoints }
    lastRunAt: null, // Date.now() of the last SUCCESSFUL run, for the stale-results banner
    lastRunFailed: false, // true when the most recent attempt failed — results shown (if any) are from an earlier run
    rawDataCache: null, // { lookbackDays, startTime, endTime, oiRows, binanceCandles, coverage, cachedAt }
    chart: { scale: 0.3, offsetX: 0, dragging: false },
  };

  function loadSettings() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) { /* ignore */ }

    let migrationAlreadyRan = false;
    try { migrationAlreadyRan = localStorage.getItem(SETTINGS_MIGRATION_KEY) === 'true'; } catch (e) { /* ignore */ }

    if (!migrationAlreadyRan) {
      raw = migrateStaleCadenceSettings(raw);
      try { localStorage.setItem(SETTINGS_MIGRATION_KEY, 'true'); } catch (e) { /* ignore */ }
    }

    state.settings = validateSettings(raw);
    if (!migrationAlreadyRan) saveSettings(); // persist the migrated values immediately, not just in memory
  }
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }
  function loadZones() {
    state.zones = deserializeZones(localStorage.getItem(ZONES_KEY));
  }
  function saveZones() {
    localStorage.setItem(ZONES_KEY, serializeZones(state.zones));
  }

  // ── UI: settings form ────────────────────────────────────────────────

  function renderSettingsForm() {
    const s = state.settings;
    const ids = ['lookbackDays', 'signalWindow', 'baselineLookbackCandles', 'minBaselineSamples', 'entryPercentile', 'rearmPercentile', 'alertModel', 'minimumRecentOIChangePct', 'oiRecencyWindow', 'cryptoHftApiKey'];
    ids.forEach(id => {
      const el = document.getElementById('oix-' + id);
      if (el) el.value = s[id];
    });
    const filterEl = document.getElementById('oix-oiRecencyFilterEnabled');
    if (filterEl) filterEl.checked = s.oiRecencyFilterEnabled;
  }

  function readSettingsFromForm() {
    const ids = ['lookbackDays', 'signalWindow', 'baselineLookbackCandles', 'minBaselineSamples', 'entryPercentile', 'rearmPercentile', 'alertModel', 'minimumRecentOIChangePct', 'oiRecencyWindow', 'cryptoHftApiKey'];
    const raw = {};
    ids.forEach(id => {
      const el = document.getElementById('oix-' + id);
      if (el) raw[id] = el.value;
    });
    const filterEl = document.getElementById('oix-oiRecencyFilterEnabled');
    raw.oiRecencyFilterEnabled = filterEl ? filterEl.checked : false;
    state.settings = validateSettings(raw);
    saveSettings();
    renderSettingsForm(); // reflect clamped values back
  }

  // ── UI: zone editor ──────────────────────────────────────────────────

  function renderZoneEditor() {
    const body = document.getElementById('oix-zones-body');
    if (!body) return;
    if (state.zones.length === 0) {
      body.innerHTML = '<div style="font-size:11px;color:var(--text-faint);padding:10px 0;">No zones yet — add one below. Alerts only fire while price is inside an active zone.</div>';
      return;
    }
    body.innerHTML = state.zones.map((z, i) => {
      const isLevel = z.type === 'level';
      return `
        <div class="oix-zone-row" data-idx="${i}">
          <input type="text" class="oix-input" placeholder="Label" value="${escapeHtml(z.label || '')}" oninput="OIExhaustionRender.updateZoneField(${i},'label',this.value)">
          <select class="oix-input" onchange="OIExhaustionRender.updateZoneField(${i},'type',this.value)">
            <option value="range" ${!isLevel ? 'selected' : ''}>Range</option>
            <option value="level" ${isLevel ? 'selected' : ''}>Level</option>
          </select>
          ${isLevel ? `
            <input type="number" class="oix-input" placeholder="Level" value="${z.level != null ? z.level : ''}" oninput="OIExhaustionRender.updateZoneField(${i},'level',this.value)">
            <input type="number" class="oix-input" placeholder="± Tolerance" value="${z.tolerance != null ? z.tolerance : ''}" oninput="OIExhaustionRender.updateZoneField(${i},'tolerance',this.value)">
          ` : `
            <input type="number" class="oix-input" placeholder="Top" value="${z.top != null ? z.top : ''}" oninput="OIExhaustionRender.updateZoneField(${i},'top',this.value)">
            <input type="number" class="oix-input" placeholder="Bottom" value="${z.bottom != null ? z.bottom : ''}" oninput="OIExhaustionRender.updateZoneField(${i},'bottom',this.value)">
          `}
          <input type="datetime-local" class="oix-input" value="${tsToLocalInput(z.availableAtTs)}" oninput="OIExhaustionRender.updateZoneField(${i},'availableAtTs',this.value?new Date(this.value).getTime():'')" title="Available from">
          <input type="datetime-local" class="oix-input" value="${tsToLocalInput(z.inactiveAtTs)}" oninput="OIExhaustionRender.updateZoneField(${i},'inactiveAtTs',this.value?new Date(this.value).getTime():'')" title="Inactive at (optional)">
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim);">
            <input type="checkbox" ${z.active !== false ? 'checked' : ''} onchange="OIExhaustionRender.updateZoneField(${i},'active',this.checked)">Enabled
          </label>
          <button class="oix-btn-icon" onclick="OIExhaustionRender.removeZone(${i})" title="Remove"><i class="ti ti-trash"></i></button>
        </div>`;
    }).join('');
  }

  function tsToLocalInput(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toISOString().slice(0, 16);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addZoneRow() {
    state.zones.push({ id: 'zone-' + Date.now().toString(36), label: '', type: 'range', top: '', bottom: '', active: true, availableAtTs: null, inactiveAtTs: null });
    saveZones();
    renderZoneEditor();
  }
  function removeZone(idx) {
    state.zones.splice(idx, 1);
    saveZones();
    renderZoneEditor();
  }
  function updateZoneField(idx, field, value) {
    if (!state.zones[idx]) return;
    state.zones[idx][field] = value;
    saveZones();
  }

  // ── Run orchestration ────────────────────────────────────────────────

  function setStatus(html) {
    const el = document.getElementById('oix-status');
    if (el) el.innerHTML = html;
  }

  async function runAnalysis(opts) {
    opts = opts || {};
    const forceRefresh = opts.forceRefresh === true;
    readSettingsFromForm();
    const s = state.settings;
    const runBtn = document.getElementById('oix-run-btn');
    const refreshBtn = document.getElementById('oix-refresh-btn');
    if (runBtn) runBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;

    try {
      if (!s.cryptoHftApiKey) {
        throw new Error('CryptoHFTData API key is required — enter it in Parameters before running.');
      }

      const endTime = latestCompletedCandleStart(Date.now());
      const startTime = endTime - s.lookbackDays * 24 * 3600 * 1000;

      const progress = (evt) => {
        if (evt.type === 'rate_limited') {
          setStatus(
            `<span style="color:var(--amber);">Rate limited</span> on ${escapeHtml(evt.source)} ` +
            `(page ${evt.page}) — retrying in ${Math.round(evt.waitMs / 1000)}s ` +
            `(attempt ${evt.attempt}/${evt.maxRetries})…`
          );
        } else if (evt.source === 'cryptohft') {
          setStatus(`Fetching CryptoHFT… ${escapeHtml(evt.venue)} request ${evt.requestIndex}/${evt.totalRequests} (${safeNumber(evt.rowsSoFar)} raw rows collected)`);
        } else {
          setStatus(`Fetching… ${escapeHtml(evt.source)} page ${evt.page} (${safeNumber(evt.rowsSoFar)} rows collected)`);
        }
      };

      let oiRows, binanceCandles, coverage;
      const cached = forceRefresh ? null : getCachedRawData(state.rawDataCache, s.lookbackDays);

      if (cached) {
        const cachedWindow = `${safeUtcDateString(cached.startTime)} → ${safeUtcDateString(cached.endTime)}`;
        const cachedAtStr = safeUtcDateString(cached.cachedAt);
        setStatus(
          `Reusing already-downloaded raw data (lookback days unchanged, cache still fresh) — rerunning analysis with current parameters, no new fetch. ` +
          `Cached window: ${cachedWindow} &middot; fetched at ${cachedAtStr}.`
        );
        ({ oiRows, binanceCandles, coverage } = cached);
      } else {
        setStatus('Fetching CryptoHFT 3-venue aggregate OI (Binance + Bybit + OKX; Bitget excluded — null OI data) and Binance 15m price candles…');

        const binancePromise = fetchBinanceCandles(startTime, endTime, { onProgress: progress, pageDelayMs: BINANCE_PAGE_DELAY_MS });
        const cryptoHftResult = await fetchCryptoHFTAggregateOI(startTime, endTime, s.cryptoHftApiKey, {
          onProgress: progress,
          decodeZst: decodeZstBrowser,
          parseParquet: parseParquetBrowser,
        });
        binanceCandles = await binancePromise;
        oiRows = cryptoHftResult.oiRows;
        coverage = cryptoHftResult.coverage;

        if (oiRows.length === 0 || binanceCandles.length === 0) {
          throw new Error(
            `Zero usable rows returned — CryptoHFT aggregate buckets: ${oiRows.length}, Binance candles: ${binanceCandles.length}. ` +
            `Raw rows collected: ${cryptoHftResult.rawRowCount}, complete buckets: ${coverage.completeBuckets}/${coverage.totalBucketsSeen} seen, ` +
            `venues seen: ${coverage.venuesSeen.join(', ') || 'none'}. Aborting rather than running on partial data.`
          );
        }

        // Only cache on a fully successful fetch — a failed/partial attempt
        // must never poison the cache with incomplete data.
        state.rawDataCache = { lookbackDays: s.lookbackDays, startTime, endTime, oiRows, binanceCandles, coverage, cachedAt: Date.now() };
      }

      const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));

      setStatus(`Running event-study… (${binanceCandles.length} Binance 15m candles, ${oiRows.length} CryptoHFT aggregate OI buckets, ${zones.length} active zone definitions)`);

      const result = Backtest.runEventStudy(binanceCandles, oiRows, zones, {
        entryPercentile: s.entryPercentile,
        rearmPercentile: s.rearmPercentile,
        minBaselineSamples: s.minBaselineSamples,
        baselineLookbackCandles: s.baselineLookbackCandles,
        signalWindow: s.signalWindow,
        alertModel: s.alertModel,
        oiRecencyFilterEnabled: s.oiRecencyFilterEnabled,
        minimumRecentOIChangePct: s.minimumRecentOIChangePct,
        oiRecencyWindow: s.oiRecencyWindow,
      });

      const binanceIndex = buildBinanceCandleIndex(binanceCandles);
      const chartPoints = result.alerts
        .map(a => mapAlertToContainingChartPoint(a, binanceCandles, CHART_INTERVAL_MS))
        .filter(Boolean);

      // Only now — after everything above succeeded — do we touch the
      // rendered state. Nothing partial ever reaches state.lastRun.
      state.lastRun = { result, binanceCandles, binanceIndex, chartPoints, coverage };
      state.lastRunAt = Date.now();
      state.lastRunFailed = false;
      renderStaleBanner();

      setStatus(
        `<span style="color:var(--teal);">Done.</span> ` +
        `Model: <b>${s.alertModel === 'netProgress' ? 'Net progress score (V2)' : 'Strict path score (V1)'}</b> &middot; ` +
        `Coverage: ${binanceCandles.length} Binance 15m candles / ${oiRows.length} CryptoHFT aggregate OI buckets &middot; ` +
        `Bucket completeness: ${coverage.completeBuckets} valid / ${coverage.incompleteBuckets} incomplete excluded (of ${coverage.totalBucketsSeen} seen) &middot; ` +
        `Venues seen: ${coverage.venuesSeen.length}/3 (${coverage.venuesSeen.join(', ') || 'none'}) &middot; ` +
        `Signal window: ${result.meta.signalWindow} candles (${result.meta.signalWindow * 15}min) &middot; ` +
        `Valid scored: ${result.meta.validScoreCount} / ${result.meta.totalCandles} &middot; ` +
        `Positive scores: ${result.meta.positiveScorePct != null ? result.meta.positiveScorePct.toFixed(1) + '%' : '—'} of valid candles &middot; ` +
        `Baseline: ${result.meta.finalBaselineSize} (cap ${result.meta.baselineLookbackCandles}) &middot; ` +
        `Alerts: ${result.alerts.length} &middot; ` +
        `Chart-mapped: ${chartPoints.length}/${result.alerts.length}` +
        (chartPoints.length < result.alerts.length ? ' <span style="color:var(--amber);">(some alerts fell outside the fetched Binance chart range)</span>' : '')
      );

      renderResultsTable();
      renderDiagnostics();
      initChart();
    } catch (err) {
      // Terminal failure: mark it clearly, do NOT touch state.lastRun (so
      // no partial/new data ever gets rendered), and if a prior successful
      // run exists, make sure it's visibly labeled as stale rather than
      // silently looking like it came from this failed attempt.
      state.lastRunFailed = true;
      renderStaleBanner();
      setStatus(`<span style="color:var(--red);">Run failed:</span> ${escapeHtml(err.message || String(err))}`);
      console.error(err);
    } finally {
      if (runBtn) runBtn.disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function renderStaleBanner() {
    const el = document.getElementById('oix-stale-banner');
    if (!el) return;
    if (state.lastRunFailed && state.lastRun) {
      const when = state.lastRunAt ? new Date(state.lastRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time';
      el.style.display = 'block';
      el.innerHTML = `<i class="ti ti-alert-triangle" style="margin-right:6px;"></i>Most recent run failed. Showing <b>previous successful run</b> from ${when} UTC — not the result of your latest parameter/fetch attempt.`;
    } else if (state.lastRunFailed && !state.lastRun) {
      el.style.display = 'block';
      el.innerHTML = `<i class="ti ti-alert-triangle" style="margin-right:6px;"></i>Run failed and no prior successful run exists — no results to show.`;
    } else {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  }

  // ── Diagnostics block (strictPathScore vs netProgressScore, compact) ────

  function renderDiagnostics() {
    const body = document.getElementById('oix-diagnostics-body');
    if (!body) return;
    const run = state.lastRun;
    if (!run || !run.result.diagnostics) { body.innerHTML = ''; return; }
    const d = run.result.diagnostics;

    function distRow(label, dist) {
      if (!dist.count) return `<tr><td>${escapeHtml(label)}</td><td colspan="6" style="color:var(--text-faint);">No valid samples</td></tr>`;
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td>${safeNumber(dist.count)}</td>
        <td>${dist.positiveRatePct.toFixed(1)}%</td>
        <td>${dist.p50.toFixed(4)}</td>
        <td>${dist.p90.toFixed(4)}</td>
        <td>${dist.p95.toFixed(4)}</td>
        <td>${dist.p99.toFixed(4)}</td>
      </tr>`;
    }

    body.innerHTML = `
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;padding-bottom:10px;border-bottom:0.5px solid var(--line-old);">
        <b style="color:var(--text);">OI source coverage:</b>
        venues seen ${run.coverage ? run.coverage.venuesSeen.length : 0}/3 (${run.coverage ? escapeHtml(run.coverage.venuesSeen.join(', ') || 'none') : 'n/a'}) &middot;
        valid aggregate buckets: ${run.coverage ? safeNumber(run.coverage.completeBuckets) : 'n/a'} &middot;
        incomplete buckets excluded: ${run.coverage ? safeNumber(run.coverage.incompleteBuckets) : 'n/a'}
        <span style="color:var(--text-faint);"> (of ${run.coverage ? safeNumber(run.coverage.totalBucketsSeen) : 'n/a'} 15m buckets seen)</span>
      </div>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;line-height:1.6;">
        Side-by-side comparison only — <b style="color:var(--text-dim);">strictPathScore</b> is the unchanged v1 signal (still the only score that gates alerts above). <b style="color:var(--text-dim);">netProgressScore</b> compares OI expansion against NET 12h price displacement instead of cumulative path length, so it can stay positive through a choppy, range-bound stretch that strictPathScore scores negative. Not wired to any alert yet.
      </div>
      <table class="oix-table" style="margin-bottom:10px;">
        <thead><tr><th>Score</th><th>Valid candles</th><th>Positive rate</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th></tr></thead>
        <tbody>
          ${distRow('strictPathScore (v1, unchanged)', d.strictPathScore)}
          ${distRow('netProgressScore (diagnostic)', d.netProgressScore)}
        </tbody>
      </table>
      <div style="font-size:11px;color:var(--text-dim);">
        <b style="color:var(--text);">Choppy-but-flat count:</b> ${safeNumber(d.choppyButFlatCount)} candles
        <span style="color:var(--text-faint);"> — ${escapeHtml(d.choppyButFlatDefinition)}</span>
      </div>`;
  }

  // ── Results table ────────────────────────────────────────────────────

  function renderResultsTable() {
    const body = document.getElementById('oix-results-body');
    if (!body) return;
    const run = state.lastRun;
    if (!run) return;

    if (run.result.alerts.length === 0) {
      const meta = run.result.meta;
      let reason = 'No alerts fired in this window.';
      if (meta.finalBaselineSize < meta.minBaselineSamples) {
        reason = `Baseline never warmed up (reached ${meta.finalBaselineSize} of ${meta.minBaselineSamples} minimum samples needed) — try a longer lookback.`;
      } else if (state.zones.length === 0) {
        reason = 'No zones are defined — the signal only evaluates while price is inside an active zone.';
      } else {
        reason = `No candle both sat inside an active zone and cleared the alert percentile threshold under the ${meta.alertModel === 'netProgress' ? 'Net progress score (V2)' : 'Strict path score (V1)'} model in this window.`;
      }
      body.innerHTML = `<div style="font-size:11px;color:var(--text-faint);padding:14px 0;">${escapeHtml(reason)}</div>`;
      return;
    }

    const rows = run.result.alerts.slice().sort((a, b) => b.timestamp - a.timestamp);
    const horizonCols = [
      { key: '1h', label: '1h' },
      { key: '4h', label: '4h' },
      { key: '12h', label: '12h' },
      { key: '24h', label: '24h' },
      { key: '72h', label: '3d' },
    ];
    function horizonCell(a, key) {
      const h = a.horizons && a.horizons[key];
      if (!h || h.dataQuality !== 'ok') {
        const reason = h ? h.dataQuality : 'n/a';
        return `<span style="color:var(--text-faint);" title="${escapeHtml(reason)}">—</span>`;
      }
      const pct = h.forwardReturnPct;
      const col = pct > 0 ? 'var(--green)' : (pct < 0 ? 'var(--red)' : 'var(--text-dim)');
      return `<span style="color:${col};">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
    }
    body.innerHTML = `
      <table class="oix-table">
        <thead><tr>
          <th>Time</th><th>Zone</th><th>Model</th><th>Price</th>
          <th>Percentile</th><th>Z</th><th>OI 12h</th><th>OI 1h</th><th>OI slope 1h</th><th>Travel 12h</th>
          ${horizonCols.map(h => `<th>${h.label}</th>`).join('')}
        </tr></thead>
        <tbody>${rows.map((a) => `
          <tr onclick="OIExhaustionRender.focusChartOnAlert(${run.result.alerts.indexOf(a)})" style="cursor:pointer;">
            <td>${new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td>${escapeHtml(a.zoneBounds.label || a.zoneId)}</td>
            <td><span class="oix-model-badge">${a.alertModel === 'netProgress' ? 'V2' : 'V1'}</span></td>
            <td>$${safeNumber(a.price, { maximumFractionDigits: 0 })}</td>
            <td>${a.percentile != null ? a.percentile.toFixed(1) : '—'}</td>
            <td>${a.zScore != null ? a.zScore.toFixed(2) : '—'}</td>
            <td>${a.oiChange12hPct != null ? a.oiChange12hPct.toFixed(1) + '%' : '—'}</td>
            <td>${a.oiChange1hPct != null ? a.oiChange1hPct.toFixed(2) + '%' : '—'}</td>
            <td style="color:${a.oiSlopeRecent != null ? (a.oiSlopeRecent >= 0 ? 'var(--green)' : 'var(--red)') : 'inherit'};">${a.oiSlopeRecent != null ? a.oiSlopeRecent.toFixed(2) : '—'}</td>
            <td>${a.priceTravel12hAbsPct != null ? a.priceTravel12hAbsPct.toFixed(1) + '%' : '—'}</td>
            ${horizonCols.map(h => `<td>${horizonCell(a, h.key)}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── Chart (canvas, reusing the EMA backtester's zoom/pan/tooltip pattern) ──

  const OIX_BASE_VISIBLE = 300;

  function initChart() {
    const canvas = document.getElementById('oix-price-canvas');
    if (!canvas) return;
    const wrap = document.getElementById('oix-price-chart-wrap');
    const newCanvas = canvas.cloneNode(false);
    wrap.replaceChild(newCanvas, canvas);

    const run = state.lastRun;
    state.chart.scale = run && run.binanceCandles && run.binanceCandles.length
      ? Math.max(0.05, Math.min(1, OIX_BASE_VISIBLE / run.binanceCandles.length))
      : 0.3;
    state.chart.offsetX = 0;

    newCanvas.addEventListener('wheel', chartWheel, { passive: false });
    newCanvas.addEventListener('mousedown', chartMouseDown);
    newCanvas.addEventListener('mousemove', chartMouseMove);
    newCanvas.addEventListener('mouseup', () => { state.chart.dragging = false; });
    newCanvas.addEventListener('mouseleave', () => {
      state.chart.dragging = false;
      const tt = document.getElementById('oix-chart-tooltip');
      if (tt) tt.style.display = 'none';
    });

    drawChart();
  }

  function chartWheel(e) {
    e.preventDefault();
    const cs = state.chart;
    const run = state.lastRun;
    if (!run) return;
    const delta = e.deltaY > 0 ? 0.85 : 1.18;
    const newScale = Math.max(0.1, Math.min(10, cs.scale * delta));
    const visible = OIX_BASE_VISIBLE / cs.scale;
    const centerCandle = cs.offsetX + visible / 2;
    cs.scale = newScale;
    const newVisible = OIX_BASE_VISIBLE / newScale;
    cs.offsetX = Math.max(0, Math.min(run.binanceCandles.length - 1, centerCandle - newVisible / 2));
    drawChart();
  }
  function chartMouseDown(e) {
    state.chart.dragging = true;
    state.chart.dragStartX = e.clientX;
    state.chart.dragStartOffset = state.chart.offsetX;
  }
  function chartMouseMove(e) {
    const cs = state.chart;
    const run = state.lastRun;
    const canvas = document.getElementById('oix-price-canvas');
    if (!canvas || !run) return;
    const W = canvas.offsetWidth;
    const visible = Math.round(OIX_BASE_VISIBLE / cs.scale);

    if (cs.dragging) {
      const dxPx = e.clientX - cs.dragStartX;
      const candlesPerPx = visible / W;
      cs.offsetX = Math.max(0, Math.min(run.binanceCandles.length - visible, cs.dragStartOffset - dxPx * candlesPerPx));
      drawChart();
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const padL = 8, padR = 60;
    const plotW = W - padL - padR;
    const candleW = plotW / visible;
    const tooltip = document.getElementById('oix-chart-tooltip');
    if (!run.chartPoints.length) { if (tooltip) tooltip.style.display = 'none'; return; }

    const startIdx = Math.max(0, Math.floor(cs.offsetX));
    const endIdx = Math.min(run.binanceCandles.length - 1, startIdx + visible);

    let nearest = null, nearestDist = Infinity;
    for (const p of run.chartPoints) {
      const ci = run.binanceCandles.findIndex(c => c.ts === p.ts);
      if (ci < startIdx || ci > endIdx) continue;
      const x = padL + (ci - startIdx + 0.5) * candleW;
      const dist = Math.abs(mx - x);
      if (dist < Math.max(6, candleW * 0.6) && dist < nearestDist) { nearest = p; nearestDist = dist; }
    }
    if (!nearest) { if (tooltip) tooltip.style.display = 'none'; return; }

    const a = nearest.alert;
    const html = `<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;">
      <span style="color:var(--text-faint);">Date</span><span>${new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ')}</span>
      <span style="color:var(--text-faint);">Model</span><span>${a.alertModel === 'netProgress' ? 'Net progress score (V2)' : 'Strict path score (V1)'}</span>
      <span style="color:var(--text-faint);">Price</span><span>$${safeNumber(a.price, { maximumFractionDigits: 0 })}</span>
      <span style="color:var(--text-faint);">Score</span><span>${a.score.toFixed(6)}</span>
      <span style="color:var(--text-faint);">Percentile</span><span>${a.percentile != null ? a.percentile.toFixed(1) : '—'}</span>
      <span style="color:var(--text-faint);">Z-score</span><span>${a.zScore != null ? a.zScore.toFixed(2) : '—'}</span>
      <span style="color:var(--text-faint);">OI Δ12h</span><span>${a.oiChange12hPct != null ? a.oiChange12hPct.toFixed(1) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">OI Δ1h</span><span>${a.oiChange1hPct != null ? a.oiChange1hPct.toFixed(2) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">OI Δ2h</span><span>${a.oiChange2hPct != null ? a.oiChange2hPct.toFixed(2) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">OI Δ4h</span><span>${a.oiChange4hPct != null ? a.oiChange4hPct.toFixed(2) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">OI Δ last 3 candles</span><span>${a.oiChangeLast3CandlesPct != null ? a.oiChangeLast3CandlesPct.toFixed(2) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">OI slope (1h)</span><span style="color:${a.oiSlopeRecent != null ? (a.oiSlopeRecent >= 0 ? 'var(--green)' : 'var(--red)') : 'inherit'};">${a.oiSlopeRecent != null ? a.oiSlopeRecent.toFixed(2) : '—'}</span>
      <span style="color:var(--text-faint);">Price Δ1h</span><span>${a.priceChange1hPct != null ? a.priceChange1hPct.toFixed(2) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">Price Δ4h</span><span>${a.priceChange4hPct != null ? a.priceChange4hPct.toFixed(2) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">Travel 12h</span><span>${a.priceTravel12hAbsPct != null ? a.priceTravel12hAbsPct.toFixed(1) + '%' : '—'}</span>
      <span style="color:var(--text-faint);">Context</span><span>${a.contextDirection}</span>
      <span style="color:var(--text-faint);">Zone</span><span>${escapeHtml(a.zoneBounds.label || a.zoneId)}</span>
      ${a.oiRecencyFilter ? `<span style="color:var(--text-faint);">Recency filter</span><span>${escapeHtml(a.oiRecencyFilter.window)} window, min ${a.oiRecencyFilter.minimumRecentOIChangePct}%</span>` : ''}
    </div>`;
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const tx = mx + 12 > rect.width - 200 ? mx - 195 : mx + 12;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = (my - 10) + 'px';
  }

  function focusChartOnAlert(alertIdx) {
    const run = state.lastRun;
    if (!run) return;
    const alert = run.result.alerts[alertIdx];
    if (!alert) return;
    const ci = run.binanceCandles.findIndex(c => c.ts === alert.timestamp);
    if (ci === -1) return;
    const visible = Math.round(OIX_BASE_VISIBLE / state.chart.scale);
    state.chart.offsetX = Math.max(0, Math.min(run.binanceCandles.length - visible, ci - visible / 2));
    drawChart();
  }

  function drawChart() {
    const cs = state.chart;
    const run = state.lastRun;
    const canvas = document.getElementById('oix-price-canvas');
    if (!canvas || !run || !run.binanceCandles.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth, H = canvas.offsetHeight || 340;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const visible = Math.round(OIX_BASE_VISIBLE / cs.scale);
    const startIdx = Math.max(0, Math.floor(cs.offsetX));
    const endIdx = Math.min(run.binanceCandles.length - 1, startIdx + visible);
    const slice = run.binanceCandles.slice(startIdx, endIdx + 1);
    if (!slice.length) return;

    const padL = 8, padR = 60, padT = 16, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    let minP = Math.min(...slice.map(c => c.low));
    let maxP = Math.max(...slice.map(c => c.high));
    const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));
    zones.forEach(z => { minP = Math.min(minP, z.bottom); maxP = Math.max(maxP, z.top); });
    const pRange = (maxP - minP) || 1;
    const pad5 = pRange * 0.05;
    minP -= pad5; maxP += pad5;
    const range = maxP - minP;
    const yOf = p => padT + plotH - ((p - minP) / range) * plotH;
    const candleW = plotW / slice.length;
    const bodyW = Math.max(1, candleW * 0.6);

    ctx.fillStyle = '#0a090f';
    ctx.fillRect(0, 0, W, H);

    // Zones (translucent bands)
    zones.forEach(z => {
      const yTop = yOf(z.top), yBot = yOf(z.bottom);
      ctx.fillStyle = 'rgba(40,215,200,0.06)';
      ctx.fillRect(padL, yTop, plotW, yBot - yTop);
      ctx.strokeStyle = 'rgba(40,215,200,0.25)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(padL, yTop, plotW, yBot - yTop);
      if (z.label) {
        ctx.fillStyle = 'rgba(40,215,200,0.6)';
        ctx.font = '9px Inter,sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(z.label, padL + 4, yTop + 10);
      }
    });

    // Grid + price labels
    for (let g = 0; g <= 5; g++) {
      const p = minP + (g / 5) * range;
      const y = yOf(p);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = 'rgba(155,160,166,0.5)'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('$' + safeNumber(p, { maximumFractionDigits: 0 }), W - padR + 4, y + 3);
    }

    // Candles
    slice.forEach((c, i) => {
      const x = padL + (i + 0.5) * candleW;
      const isBull = c.close >= c.open;
      const col = isBull ? '#3ddc97' : '#e2645f';
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(x, yOf(c.high)); ctx.lineTo(x, yOf(c.low)); ctx.stroke();
      const yTop = yOf(Math.max(c.open, c.close)), yBot = yOf(Math.min(c.open, c.close));
      const bodyH = Math.max(1, yBot - yTop);
      if (isBull) ctx.fillRect(x - bodyW / 2, yTop, bodyW, bodyH);
      else ctx.strokeRect(x - bodyW / 2, yTop, bodyW, bodyH);
    });

    // Alert markers — dashed vertical lines (easier to spot than dots on a
    // compressed multi-day chart), colored by context direction.
    cs._lastMarkerXByTs = {};
    run.chartPoints.forEach(p => {
      const ci = run.binanceCandles.findIndex(c => c.ts === p.ts);
      if (ci < startIdx || ci > endIdx) return;
      const i = ci - startIdx;
      const x = padL + (i + 0.5) * candleW;
      cs._lastMarkerXByTs[p.ts] = x;
      const isUp = p.alert.contextDirection === 'bearish-exhaustion'; // up-move-oi-expansion
      const col = isUp ? '#e2645f' : '#3ddc97';
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.restore();
      // small triangle flag at the top so the line is spottable even when
      // several sit close together at this zoom level
      ctx.beginPath();
      ctx.moveTo(x - 4, padT);
      ctx.lineTo(x + 4, padT);
      ctx.lineTo(x, padT + 7);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    });
  }

  // ── Public API + init ────────────────────────────────────────────────

  function init() {
    loadSettings();
    loadZones();
    renderSettingsForm();
    renderZoneEditor();
    renderStaleBanner();
    setStatus('Not yet run. Configure zones/parameters above, then Fetch data &amp; run analysis.');
  }

  function refreshRawData() {
    return runAnalysis({ forceRefresh: true });
  }

  // ── Console diagnostic: gate-by-gate breakdown at specific timestamps ────
  // Read-only. Uses whatever raw data is already cached in memory (run
  // "Fetch data & run analysis" at least once first) and the CURRENT UI
  // parameter values unless overridden. Does not change strategy math —
  // replays the exact same Engine/Backtest functions the live run uses.
  // The OI-recency gate snippet is copied verbatim from oi-exhaustion-
  // backtest.js's runEventStudy (it isn't separately exported) — if that
  // logic changes there, this copy needs updating too.
  //
  // Console usage:
  //   OIExhaustionRender.diagnoseAlert(['2026-06-25T13:30:00Z', '2026-06-25T15:30:00Z'])
  //   OIExhaustionRender.diagnoseAlert(['2026-06-25T15:30:00Z'], { entryPercentile: 95 })

  function diagnoseAlertFmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return 'n/a';
    return v.toFixed(digits != null ? digits : 4);
  }

  // ── Console diagnostic: raw Bybit OI/price dump, no strategy math ───────
  // Prints exactly what Bybit's own OI/price series did, candle by candle,
  // in a time window — no scoring, no filters, nothing derived. Useful to
  // sanity-check what the signal is "seeing" against an external chart
  // (e.g. an aggregated-OI chart from another source) that may include
  // other exchanges Bybit-only data won't match.
  //
  // Console usage:
  //   OIExhaustionRender.dumpRawOI('2026-06-25T12:00:00Z', '2026-06-25T17:00:00Z')

  // ── TEMPORARY console diagnostic: directionalOiShock (30m/1h/2h) ───────
  // Investigates whether a short-window analog of V2's own formula
  // (oiChangePct - abs(priceChangePct)) shows a spike that the 12h window
  // misses because an earlier decline elsewhere in the 12h period dragged
  // the net-12h OI change negative. This does NOT change V2, does NOT gate
  // any alert, and is not wired into the engine/backtest at all — it's a
  // read-only, same-formula-shorter-window investigation using only Bybit's
  // own already-cached data. Remove once the June 25 question is settled.
  //
  // Console usage:
  //   OIExhaustionRender.directionalOiShock('2026-06-25T12:00:00Z', '2026-06-25T17:00:00Z')

  function directionalOiShock(startIso, endIso) {
    const cache = state.rawDataCache;
    if (!cache) {
      console.warn('No raw data cached yet — click "Fetch data & run analysis" at least once first.');
      return;
    }
    const startTs = new Date(startIso).getTime();
    const endTs = new Date(endIso).getTime();
    if (!isFinite(startTs) || !isFinite(endTs)) {
      console.warn('Could not parse startIso/endIso — use ISO strings, e.g. "2026-06-25T12:00:00Z".');
      return;
    }

    const { timestamps, closes, ois, validFlags } = Backtest.alignCandlesAndOI(cache.binanceCandles, cache.oiRows);
    const series = Engine.computeExhaustionSeries(timestamps, closes, ois, { validFlags });

    const WINDOWS = { '30m': 6, '1h': 12, '2h': 24 }; // candle counts
    const rows = [];
    let peak = { '30m': null, '1h': null, '2h': null };

    for (let t = 0; t < series.length; t++) {
      const ts = timestamps[t];
      if (ts < startTs || ts > endTs) continue;
      const entry = series[t];
      if (!entry.valid) {
        rows.push({ time: new Date(ts).toISOString(), price: closes[t], note: 'window invalid (gap)' });
        continue;
      }

      const row = { time: new Date(ts).toISOString(), price: closes[t] };
      for (const [label, candles] of Object.entries(WINDOWS)) {
        // Reuse the already-computed 1h/2h OI-change fields where they
        // exist on the series entry; compute 30m directly since it's not
        // otherwise stored. Price-change windows aren't pre-computed for
        // 30m/2h at all, so those come straight from the exported pure
        // helper — same function the engine itself uses internally.
        const oiChangePct = label === '1h' ? entry.oiChange1hPct
          : label === '2h' ? entry.oiChange2hPct
          : entry.oiChange30mPct;
        const priceChangePct = Engine.computeChangeOverCandles(closes, t, candles);
        const shock = (oiChangePct !== null && priceChangePct !== null) ? oiChangePct - Math.abs(priceChangePct) : null;

        row[`oiChange${label}`] = oiChangePct !== null ? oiChangePct.toFixed(3) + '%' : 'n/a';
        row[`priceChange${label}`] = priceChangePct !== null ? priceChangePct.toFixed(3) + '%' : 'n/a';
        row[`shock${label}`] = shock !== null ? shock.toFixed(3) : 'n/a';

        if (shock !== null && (peak[label] === null || shock > peak[label].shock)) {
          peak[label] = { shock, ts, oiChangePct, priceChangePct };
        }
      }
      rows.push(row);
    }

    if (rows.length === 0) {
      console.warn('No cached candles fall inside that window. Cached window is: ' +
        `${safeUtcDateString(cache.startTime)} → ${safeUtcDateString(cache.endTime)}`);
      return;
    }

    console.log(`directionalOiShock (TEMPORARY diagnostic, does not affect V2) — ${startIso} → ${endIso}`);
    console.log('shockXm = oiChangeXm - abs(priceChangeXm)  — same formula V2 uses at 12h, applied at 30m/1h/2h instead.');
    console.table(rows);

    console.log('');
    for (const label of Object.keys(WINDOWS)) {
      const p = peak[label];
      if (!p) { console.log(`Peak ${label} shock: n/a`); continue; }
      console.log(`Peak ${label} shock: ${p.shock.toFixed(3)} at ${new Date(p.ts).toISOString()} ` +
        `(oiChange${label}=${p.oiChangePct.toFixed(3)}%, priceChange${label}=${p.priceChangePct.toFixed(3)}%)`);
    }
  }

  // ── TEMPORARY console diagnostic: directionalOiImpulse ─────────────────
  // Deliberately NOT a shorter-window version of V2. V2's formula
  // (oiChangePct - abs(priceChangePct)) structurally rejects any event
  // where price moves more than OI in percentage terms — which is exactly
  // the June 25 case. This diagnostic evaluates OI-change and price-move
  // as two INDEPENDENT percentile series against their own trailing
  // history (never subtracted from each other), then classifies the
  // quadrant of directional behavior. It is a directional-expansion
  // context model, not an exhaustion/reversal trigger, and is not wired
  // into V1/V2, any alert, or any UI element. Read-only, temporary.
  //
  // Console usage:
  //   OIExhaustionRender.directionalOiImpulse('2026-06-25T12:00:00Z', '2026-06-25T17:00:00Z')

  function directionalOiImpulse(startIso, endIso) {
    const cache = state.rawDataCache;
    if (!cache) {
      console.warn('No raw data cached yet — click "Fetch data & run analysis" at least once first.');
      return;
    }
    const startTs = new Date(startIso).getTime();
    const endTs = new Date(endIso).getTime();
    if (!isFinite(startTs) || !isFinite(endTs)) {
      console.warn('Could not parse startIso/endIso — use ISO strings, e.g. "2026-06-25T12:00:00Z".');
      return;
    }

    const { timestamps, closes, ois, validFlags } = Backtest.alignCandlesAndOI(cache.binanceCandles, cache.oiRows);
    const series = Engine.computeExhaustionSeries(timestamps, closes, ois, { validFlags });

    const WINDOWS = { '30m': 6, '1h': 12, '2h': 24 };
    const EPS = 1e-9; // treat exactly-zero as flat, not up/down

    // Pass 1: build the two INDEPENDENT full-dataset distributions per
    // window — oiChangePct values, and abs(priceChangePct) values — so
    // percentiles reflect "how extreme is this vs the whole fetched
    // history," not vs a live trailing alert baseline (this is offline
    // investigation, not a causal alerting simulation).
    const oiDist = {}, priceDist = {};
    for (const label of Object.keys(WINDOWS)) { oiDist[label] = Engine.createBaselineLog({ baselineLookbackCandles: series.length + 1 }); priceDist[label] = Engine.createBaselineLog({ baselineLookbackCandles: series.length + 1 }); }

    const perCandle = new Array(series.length).fill(null);
    for (let t = 0; t < series.length; t++) {
      if (!series[t].valid) continue;
      const row = {};
      for (const [label, candles] of Object.entries(WINDOWS)) {
        const oiChangePct = Engine.computeChangeOverCandles(ois, t, candles);
        const signedPriceChangePct = Engine.computeChangeOverCandles(closes, t, candles);
        const absPriceChangePct = signedPriceChangePct !== null ? Math.abs(signedPriceChangePct) : null;
        row[label] = { oiChangePct, signedPriceChangePct, absPriceChangePct };
        if (oiChangePct !== null) oiDist[label].insert(oiChangePct);
        if (absPriceChangePct !== null) priceDist[label].insert(absPriceChangePct);
      }
      perCandle[t] = row;
    }

    // Pass 2: for the requested window, compute percentiles (now that the
    // full distributions are built) and classify.
    function classify(oiChangePct, signedPriceChangePct) {
      const oiUp = oiChangePct > EPS, oiDown = oiChangePct < -EPS;
      const priceUp = signedPriceChangePct > EPS, priceDown = signedPriceChangePct < -EPS;
      if (priceDown && oiUp) return 'short-build selloff';
      if (priceUp && oiUp) return 'long-build rally';
      if (priceDown && oiDown) return 'long liquidation / deleveraging';
      if (priceUp && oiDown) return 'short covering / deleveraging';
      return 'flat/ambiguous';
    }

    const resultsByWindow = {};
    for (const label of Object.keys(WINDOWS)) {
      const rows = [];
      let firstQualifying = null, peakOiPercentile = null, peakPricePercentile = null;

      for (let t = 0; t < series.length; t++) {
        const ts = timestamps[t];
        if (ts < startTs || ts > endTs) continue;
        const c = perCandle[t];
        if (!c) continue;
        const { oiChangePct, signedPriceChangePct, absPriceChangePct } = c[label];
        if (oiChangePct === null || signedPriceChangePct === null) continue;

        const oiPercentile = oiDist[label].percentileRank(oiChangePct);
        const pricePercentile = priceDist[label].percentileRank(absPriceChangePct);
        const cls = classify(oiChangePct, signedPriceChangePct);

        rows.push({
          time: new Date(ts).toISOString(), price: closes[t],
          oiChangePct: oiChangePct.toFixed(3) + '%',
          signedPriceChangePct: signedPriceChangePct.toFixed(3) + '%',
          absPriceChangePct: absPriceChangePct.toFixed(3) + '%',
          oiPercentile: oiPercentile.toFixed(1),
          pricePercentile: pricePercentile.toFixed(1),
          classification: cls,
        });

        if (firstQualifying === null && oiPercentile >= 95 && pricePercentile >= 80) {
          firstQualifying = { ts, oiPercentile, pricePercentile, cls, t };
        }
        if (peakOiPercentile === null || oiPercentile > peakOiPercentile.value) peakOiPercentile = { value: oiPercentile, ts, t };
        if (peakPricePercentile === null || pricePercentile > peakPricePercentile.value) peakPricePercentile = { value: pricePercentile, ts, t };
      }

      resultsByWindow[label] = { rows, firstQualifying, peakOiPercentile, peakPricePercentile };
    }

    if (Object.values(resultsByWindow).every(r => r.rows.length === 0)) {
      console.warn('No cached candles fall inside that window. Cached window is: ' +
        `${safeUtcDateString(cache.startTime)} → ${safeUtcDateString(cache.endTime)}`);
      return;
    }

    console.log(`directionalOiImpulse (TEMPORARY diagnostic, independent from V1/V2, no subtraction) — ${startIso} → ${endIso}`);
    console.log('OI-change and price-move percentiles are each independent, vs the full cached dataset\'s own distribution for that window.');
    console.log('');

    for (const label of Object.keys(WINDOWS)) {
      const r = resultsByWindow[label];
      console.log(`── ${label} window ──────────────────────────`);
      if (r.rows.length === 0) { console.log('  (no valid candles in range)\n'); continue; }
      console.table(r.rows);

      function accelerationNote(targetT, refLabel) {
        const tRef = Math.max(0, targetT - 3);
        const cNow = perCandle[targetT] ? perCandle[targetT][label] : null;
        const cRef = perCandle[tRef] ? perCandle[tRef][label] : null;
        if (!cNow || !cRef || cNow.oiChangePct === null || cRef.oiChangePct === null || cNow.absPriceChangePct === null || cRef.absPriceChangePct === null) {
          return `insufficient data to assess (at ${refLabel})`;
        }
        const oiAccelerating = cNow.oiChangePct > cRef.oiChangePct;
        const priceAccelerating = cNow.absPriceChangePct > cRef.absPriceChangePct;
        return `OI ${oiAccelerating ? 'still accelerating' : 'had stalled/plateaued'}, price ${priceAccelerating ? 'still accelerating' : 'had stalled/plateaued'} (vs 15m earlier, evaluated at ${refLabel})`;
      }

      if (r.firstQualifying) {
        const fq = r.firstQualifying;
        console.log(`1. First timestamp OI percentile>=95 AND price-move percentile>=80: ${new Date(fq.ts).toISOString()} ` +
          `(oiPctile=${fq.oiPercentile.toFixed(1)}, pricePctile=${fq.pricePercentile.toFixed(1)}, class=${fq.cls})`);
        console.log(`5. ${accelerationNote(fq.t, 'the joint-qualifying candle')}`);
      } else {
        console.log('1. No candle in this window reached OI percentile>=95 AND price-move percentile>=80 simultaneously.');
        console.log(`5. ${accelerationNote(r.peakOiPercentile.t, 'the peak-OI-percentile candle, since no joint-qualifying candle existed')}`);
      }
      console.log(`2. Peak OI-change percentile: ${r.peakOiPercentile.value.toFixed(1)} at ${new Date(r.peakOiPercentile.ts).toISOString()}`);
      console.log(`3. Peak price-move percentile: ${r.peakPricePercentile.value.toFixed(1)} at ${new Date(r.peakPricePercentile.ts).toISOString()}`);
      const lastRow = r.rows[r.rows.length - 1];
      console.log(`4. Classification (at last candle in window): ${lastRow.classification}`);
      console.log('');
    }
  }

  function dumpRawOI(startIso, endIso) {
    const cache = state.rawDataCache;
    if (!cache) {
      console.warn('No raw data cached yet — click "Fetch data & run analysis" at least once first.');
      return;
    }
    const startTs = new Date(startIso).getTime();
    const endTs = new Date(endIso).getTime();
    if (!isFinite(startTs) || !isFinite(endTs)) {
      console.warn('Could not parse startIso/endIso — use ISO strings, e.g. "2026-06-25T12:00:00Z".');
      return;
    }

    const { timestamps, closes, ois, validFlags } = Backtest.alignCandlesAndOI(cache.binanceCandles, cache.oiRows);

    const rows = [];
    let prevClose = null, prevOI = null;
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      if (ts < startTs || ts > endTs) { prevClose = closes[i]; prevOI = ois[i]; continue; }
      rows.push({
        time: new Date(ts).toISOString(),
        close: closes[i],
        oi: ois[i],
        oiChangePct: (prevOI != null && prevOI !== 0) ? (((ois[i] - prevOI) / prevOI) * 100).toFixed(4) + '%' : 'n/a',
        priceChangePct: (prevClose != null && prevClose !== 0) ? (((closes[i] - prevClose) / prevClose) * 100).toFixed(4) + '%' : 'n/a',
        gapBeforeThis: validFlags[i] === false,
      });
      prevClose = closes[i];
      prevOI = ois[i];
    }

    if (rows.length === 0) {
      console.warn('No cached candles fall inside that window. Cached window is: ' +
        `${safeUtcDateString(cache.startTime)} → ${safeUtcDateString(cache.endTime)}`);
      return;
    }

    console.log(`CryptoHFT 3-venue aggregate OI (Binance+Bybit+OKX) + Binance price, ${rows.length} 15m buckets, ${startIso} → ${endIso}`);
    console.table(rows);

    const firstOI = rows[0].oi, lastOI = rows[rows.length - 1].oi;
    const firstClose = rows[0].close, lastClose = rows[rows.length - 1].close;
    console.log(`Net OI change over window: ${firstOI !== 0 ? (((lastOI - firstOI) / firstOI) * 100).toFixed(3) + '%' : 'n/a'} ` +
      `(${firstOI} -> ${lastOI})`);
    console.log(`Net price change over window: ${firstClose !== 0 ? (((lastClose - firstClose) / firstClose) * 100).toFixed(3) + '%' : 'n/a'} ` +
      `(${firstClose} -> ${lastClose})`);
    if (rows.some(r => r.gapBeforeThis)) {
      console.warn('One or more candles in this window are flagged as following a data gap (5m-alignment broke) — treat any single-candle OI jump right after a gap with caution.');
    }
  }

  function diagnoseAlert(isoTimestamps, overrides) {
    overrides = overrides || {};
    const cache = state.rawDataCache;
    if (!cache) {
      console.warn('No raw data cached yet — click "Fetch data & run analysis" (or Refresh raw data) at least once first, then re-run this.');
      return;
    }

    const s = state.settings;
    const alertModel = overrides.alertModel || s.alertModel;
    const entryPercentile = overrides.entryPercentile != null ? overrides.entryPercentile : s.entryPercentile;
    const rearmPercentile = overrides.rearmPercentile != null ? overrides.rearmPercentile : s.rearmPercentile;
    const minBaselineSamples = overrides.minBaselineSamples != null ? overrides.minBaselineSamples : s.minBaselineSamples;
    const baselineLookbackCandles = overrides.baselineLookbackCandles != null ? overrides.baselineLookbackCandles : s.baselineLookbackCandles;
    const oiRecencyFilterEnabled = overrides.oiRecencyFilterEnabled != null ? overrides.oiRecencyFilterEnabled : s.oiRecencyFilterEnabled;
    const oiRecencyWindow = Engine.OI_RECENCY_WINDOW_CANDLES[overrides.oiRecencyWindow] ? overrides.oiRecencyWindow : s.oiRecencyWindow;
    const oiRecencyWindowCandles = Engine.OI_RECENCY_WINDOW_CANDLES[oiRecencyWindow];
    const minimumRecentOIChangePct = overrides.minimumRecentOIChangePct != null ? overrides.minimumRecentOIChangePct : s.minimumRecentOIChangePct;

    const targetTimestamps = isoTimestamps.map(str => new Date(str).getTime());
    console.log(`Params: alertModel=${alertModel} entryPercentile=${entryPercentile} rearmPercentile=${rearmPercentile} ` +
      `minBaselineSamples=${minBaselineSamples} baselineLookbackCandles=${baselineLookbackCandles} ` +
      `oiRecencyFilterEnabled=${oiRecencyFilterEnabled} oiRecencyWindow=${oiRecencyWindow} minimumRecentOIChangePct=${minimumRecentOIChangePct}`);
    console.log(`Target timestamps: ${targetTimestamps.map(t => new Date(t).toISOString()).join(', ')}`);
    console.log(`Using cached raw data window: ${safeUtcDateString(cache.startTime)} → ${safeUtcDateString(cache.endTime)} (fetched ${safeUtcDateString(cache.cachedAt)})`);
    console.log('');

    const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));
    const { timestamps, closes, ois, validFlags } = Backtest.alignCandlesAndOI(cache.binanceCandles, cache.oiRows);
    const series = Engine.computeExhaustionSeries(timestamps, closes, ois, { validFlags });

    const targetSet = new Set(targetTimestamps);
    const baseline = Engine.createBaselineLog({ baselineLookbackCandles });
    const zoneStates = new Map(zones.map(z => [z.id, false]));
    let anyMatched = false;

    for (let t = 0; t < series.length; t++) {
      const entry = series[t];
      const ts = timestamps[t];
      const price = closes[t];
      const isTarget = targetSet.has(ts);

      if (!entry.valid) {
        for (const zone of zones) {
          const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
          if (!inZone) zoneStates.set(zone.id, false);
        }
        if (isTarget) { anyMatched = true; diagnoseAlertPrint(ts, price, null, zones, { invalidWindow: true }); }
        continue;
      }

      const warmingUp = baseline.size() < minBaselineSamples;
      const selectedScore = Engine.getModelScore(entry, alertModel);
      const percentile = (!warmingUp && selectedScore !== null) ? baseline.percentileRank(selectedScore) : null;

      let additionalGatePassed = true;
      let recentOIChangePct = null;
      if (oiRecencyFilterEnabled) {
        recentOIChangePct = Engine.computeChangeOverCandles(ois, t, oiRecencyWindowCandles);
        const slopeOk = entry.oiSlopeRecent !== null && entry.oiSlopeRecent >= 0;
        const recentChangeOk = recentOIChangePct !== null && recentOIChangePct > minimumRecentOIChangePct;
        additionalGatePassed = slopeOk && recentChangeOk;
      }

      const perZoneSnapshots = [];
      for (const zone of zones) {
        const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
        const prevArmed = zoneStates.get(zone.id);
        const step = (selectedScore !== null)
          ? Engine.stepZoneState(prevArmed, inZone, percentile, warmingUp, selectedScore, { entryPercentile, rearmPercentile, additionalGatePassed })
          : { armed: prevArmed, alertFired: false };
        if (selectedScore !== null) zoneStates.set(zone.id, step.armed);
        else if (!inZone) zoneStates.set(zone.id, false);
        perZoneSnapshots.push({ zone, inZone, prevArmed, armed: step.armed, alertFired: step.alertFired });
      }

      if (selectedScore !== null) baseline.insert(selectedScore);

      if (isTarget) {
        anyMatched = true;
        diagnoseAlertPrint(ts, price, entry, zones, {
          alertModel, selectedScore, percentile, warmingUp,
          entryPercentile, rearmPercentile,
          oiRecencyFilterEnabled, oiRecencyWindow, minimumRecentOIChangePct,
          recentOIChangePct, additionalGatePassed, perZoneSnapshots,
        });
      }
    }

    if (!anyMatched) {
      console.warn('None of the requested timestamps matched an exact 5m candle in the cached data — check the ISO strings are on a 5-minute boundary and within the cached window shown above.');
    }
  }

  function diagnoseAlertPrint(ts, price, entry, zones, ctx) {
    const f = diagnoseAlertFmt;
    console.log('════════════════════════════════════════════════════════');
    console.log(`Timestamp: ${new Date(ts).toISOString()}`);
    console.log(`Price: ${price != null ? price : 'n/a'}`);

    if (ctx.invalidWindow || !entry) {
      console.log('Window invalid at this candle (gap/missing data) — no score computed.');
      console.log('Final rejection reason: INVALID_WINDOW (144-candle score window not fully valid here)');
      console.log('════════════════════════════════════════════════════════\n');
      return;
    }

    console.log(`OI change 1h:  ${f(entry.oiChange1hPct, 3)}%`);
    console.log(`OI change 4h:  ${f(entry.oiChange4hPct, 3)}%`);
    console.log(`OI change 12h: ${f(entry.oiChange12hPct, 3)}%`);
    console.log(`Net 12h price move: ${f(entry.priceChange12hPct, 3)}%`);
    console.log(`netProgressScore: ${f(entry.netProgressScore, 4)}  (strictPathScore for reference: ${f(entry.score, 4)})`);
    console.log(`Selected model: ${ctx.alertModel}  Selected score used for gating: ${f(ctx.selectedScore, 4)}`);
    console.log(`Percentile (vs trailing baseline): ${ctx.warmingUp ? 'n/a (baseline warming up)' : f(ctx.percentile, 2)}`);
    console.log(`1h OI recency value: ${f(ctx.recentOIChangePct, 3)}%`);
    console.log(`Recent OI slope (last 1h, raw units/candle): ${f(entry.oiSlopeRecent, 4)}`);
    console.log('');

    const scorePassed = ctx.selectedScore !== null && ctx.selectedScore > 0;
    const percentilePassed = !ctx.warmingUp && ctx.percentile !== null && ctx.percentile >= ctx.entryPercentile;
    const recencyPassed = !ctx.oiRecencyFilterEnabled || ctx.additionalGatePassed;

    console.log(`Score > 0 passed:        ${scorePassed}`);
    console.log(`Percentile >= ${ctx.entryPercentile} passed: ${percentilePassed}`);
    console.log(`OI recency filter passed: ${ctx.oiRecencyFilterEnabled ? recencyPassed : 'n/a (filter disabled)'}`);
    console.log('');

    for (const snap of ctx.perZoneSnapshots) {
      console.log(`Zone "${snap.zone.label || snap.zone.id}": inZone=${snap.inZone} prevArmed=${snap.prevArmed} -> armed=${snap.armed} alertFired=${snap.alertFired}`);
      let reason;
      if (ctx.warmingUp) reason = 'BASELINE_WARMING_UP (not enough baseline samples yet)';
      else if (!snap.inZone) reason = 'ZONE_FAILED (price outside active zone, or zone not yet available/expired)';
      else if (!scorePassed) reason = 'SCORE_FAILED (selected-model score is not positive)';
      else if (!percentilePassed) reason = 'PERCENTILE_FAILED (below entry percentile threshold)';
      else if (ctx.oiRecencyFilterEnabled && !recencyPassed) reason = 'RECENCY_FAILED (OI recency filter rejected — stalled OI and/or negative recent slope)';
      else if (snap.prevArmed && !snap.alertFired) reason = 'ALREADY_ARMED (qualifies, but zone was already armed from an earlier candle — no re-fire until rearm)';
      else if (snap.alertFired) reason = 'ALERT_FIRED (all gates passed, this candle triggered the alert)';
      else reason = 'UNKNOWN (should not happen — check logic)';
      console.log(`  Final rejection reason: ${reason}`);
    }
    console.log('════════════════════════════════════════════════════════\n');
  }

  Object.assign(OIExhaustionRender, {
    init, runAnalysis, refreshRawData, diagnoseAlert, dumpRawOI, directionalOiShock, directionalOiImpulse, addZoneRow, removeZone, updateZoneField, readSettingsFromForm,
    focusChartOnAlert,
    fetchBybitOI, fetchBybitCandles, fetchBinanceCandles, // exposed for console debugging
  });

  window.OIExhaustionRender = OIExhaustionRender;

})(typeof window !== 'undefined' ? window : globalThis);

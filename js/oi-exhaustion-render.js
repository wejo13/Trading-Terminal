/**
 * oi-exhaustion-render.js
 * UI layer for the OI Exhaustion tab. Wires the pure engine/backtest modules
 * to the DOM — this file itself does no scoring/state-machine math, it only
 * fetches data, calls OIExhaustionEngine/OIExhaustionBacktest, and renders.
 *
 * Data source rule (REPLACED — Bybit-only OI is no longer the live source):
 *  - OI SIGNAL SOURCE: CryptoHFT major-venue aggregate (Binance Futures +
 *    Bybit + OKX BTC perpetuals, sum_open_interest_value only; Bitget is
 *    deliberately excluded — see CRYPTOHFT_REQUIRED_VENUES below), bucketed
 *    to 15m UTC. See oi-exhaustion-cryptohft-source.js for the aggregation
 *    rules (last-observation-per-bucket, all-three-venues required, no
 *    forward-fill, no partial aggregate).
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
    // "Include fast directional OI builds" — separate alert classification,
    // off by default, never touches V1/V2 score math (see engine.js).
    directionalImpulseEnabled: false,
    directionalImpulseWindow: '15m',
    directionalPriceEntryPercentile: 95,
    directionalOiEntryPercentile: 95,
    directionalImpulseRearmPercentile: 90,
    directionalMinRawOiIncreasePct: 1,
  };

  const VALID_ALERT_MODELS = ['strict', 'netProgress'];
  const VALID_OI_RECENCY_WINDOWS = ['30m', '1h', '2h', '4h'];
  const VALID_IMPULSE_WINDOWS = ['15m', '1h', '2h'];

  const Probe = (typeof module !== 'undefined' && module.exports)
    ? require('./oi-exhaustion-probe.js')
    : window.OIExhaustionProbe;

  const IdbCache = (typeof module !== 'undefined' && module.exports)
    ? require('./oi-exhaustion-idb-cache.js')
    : window.OIExhaustionIdbCache;

  const CryptoHFTSource = (typeof module !== 'undefined' && module.exports)
    ? require('./oi-exhaustion-cryptohft-source.js')
    : window.OIExhaustionCryptoHFTSource;

  const BinanceOISource = (typeof module !== 'undefined' && module.exports)
    ? require('./oi-exhaustion-binance-oi-source.js')
    : window.OIExhaustionBinanceOISource;

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


  // ── Portable raw-data pack (manual export/import fallback) ───────────
  // This bypasses the expensive CryptoHFT download when the browser cache is
  // unavailable or unreliable. Packs contain only derived Binance 15m candles
  // and the final CryptoHFT aggregate OI series used by the backtester — never
  // API keys, raw Parquet/Zstd payloads, or exchange secrets.
  const RAW_DATA_PACK_SCHEMA = 'oix-raw-data-pack';
  const RAW_DATA_PACK_VERSION = 1;
  const RAW_DATA_PACK_MAX_BYTES = 25 * 1024 * 1024;

  function isFiniteTimestamp(value) {
    return typeof value === 'number' && isFinite(value) && Number.isInteger(value) && value > 0;
  }

  function normalizeCandlesForRawDataPack(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Data pack has no Binance candles.');
    const byTs = new Map();
    for (const row of rows) {
      if (!row || !isFiniteTimestamp(row.ts) || ![row.open, row.high, row.low, row.close].every(v => typeof v === 'number' && isFinite(v))) {
        throw new Error('Data pack contains an invalid Binance candle.');
      }
      byTs.set(row.ts, { ts: row.ts, open: row.open, high: row.high, low: row.low, close: row.close });
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }

  function normalizeOIRowsForRawDataPack(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Data pack has no aggregate OI rows.');
    const byTs = new Map();
    for (const row of rows) {
      if (!row || !isFiniteTimestamp(row.ts) || typeof row.oi !== 'number' || !isFinite(row.oi)) {
        throw new Error('Data pack contains an invalid aggregate OI row.');
      }
      byTs.set(row.ts, { ts: row.ts, oi: row.oi });
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }

  function createRawDataPack(rawData) {
    if (!rawData || !isFiniteTimestamp(rawData.startTime) || !isFiniteTimestamp(rawData.endTime) || rawData.startTime > rawData.endTime) {
      throw new Error('No valid loaded raw data is available to export.');
    }
    const binanceCandles = normalizeCandlesForRawDataPack(rawData.binanceCandles);
    const oiRows = normalizeOIRowsForRawDataPack(rawData.oiRows);
    return {
      schema: RAW_DATA_PACK_SCHEMA,
      version: RAW_DATA_PACK_VERSION,
      exportedAt: Date.now(),
      source: 'CryptoHFT major-venue aggregate',
      symbol: SYMBOL,
      bucketMs: CRYPTOHFT_BUCKET_MS,
      data: {
        startTime: rawData.startTime,
        endTime: rawData.endTime,
        lookbackDays: typeof rawData.lookbackDays === 'number' ? rawData.lookbackDays : null,
        binanceCandles,
        oiRows,
        coverage: rawData.coverage || null,
      },
    };
  }

  function parseRawDataPack(input) {
    let pack = input;
    if (typeof input === 'string') {
      try { pack = JSON.parse(input); } catch (err) { throw new Error('Imported file is not valid JSON.'); }
    }
    if (!pack || typeof pack !== 'object' || pack.schema !== RAW_DATA_PACK_SCHEMA || pack.version !== RAW_DATA_PACK_VERSION) {
      throw new Error('This is not a compatible OI raw-data pack.');
    }
    if (pack.symbol !== SYMBOL || pack.bucketMs !== CRYPTOHFT_BUCKET_MS || !pack.data || typeof pack.data !== 'object') {
      throw new Error('This data pack does not match BTCUSDT 15m OI Backtester data.');
    }
    const d = pack.data;
    if (!isFiniteTimestamp(d.startTime) || !isFiniteTimestamp(d.endTime) || d.startTime > d.endTime) {
      throw new Error('Data pack has an invalid coverage range.');
    }
    const binanceCandles = normalizeCandlesForRawDataPack(d.binanceCandles);
    const oiRows = normalizeOIRowsForRawDataPack(d.oiRows);
    const inRangeCandles = binanceCandles.filter(c => c.ts >= d.startTime && c.ts <= d.endTime);
    const inRangeOI = oiRows.filter(r => r.ts >= d.startTime && r.ts <= d.endTime);
    if (inRangeCandles.length === 0 || inRangeOI.length === 0) throw new Error('Data pack has no usable rows inside its declared coverage range.');
    return {
      startTime: d.startTime,
      endTime: d.endTime,
      lookbackDays: typeof d.lookbackDays === 'number' ? d.lookbackDays : null,
      binanceCandles: inRangeCandles,
      oiRows: inRangeOI,
      coverage: d.coverage || null,
      cachedAt: Date.now(),
      importedAt: Date.now(),
      source: 'imported-pack',
    };
  }

  function rawDataPackFilename(rawData) {
    const end = rawData && isFiniteTimestamp(rawData.endTime) ? new Date(rawData.endTime).toISOString().slice(0, 10) : 'unknown-date';
    return `oix-btcusdt-15m-${end}.json`;
  }

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

  /**
   * True only if `cache` fully contains [startTime, endTime] — i.e. the
   * cached window starts at or before the requested start AND ends at or
   * after the requested end. This is the containment rule a completed
   * larger-lookback cache must satisfy for a smaller overlapping request
   * to reuse it, per the explicit fix requirement: a 30-day cache must
   * satisfy a 28-day request without a new download.
   */
  function cacheContainsRange(cache, startTime, endTime) {
    return !!cache && typeof cache.startTime === 'number' && typeof cache.endTime === 'number' &&
      cache.startTime <= startTime && cache.endTime >= endTime;
  }

  /**
   * Slices raw candle/OI arrays down to exactly [startTime, endTime] —
   * used when reusing a larger cached window for a smaller request, so
   * the returned dataset is indistinguishable from one fetched fresh at
   * exactly the requested window (same candles, same OI buckets, same
   * resulting scores/alerts). Never returns extra history beyond what was
   * actually requested, even if the cache has more.
   */
  function sliceRawDataToRange(binanceCandles, oiRows, startTime, endTime) {
    const candles = Array.isArray(binanceCandles) ? binanceCandles : [];
    const rows = Array.isArray(oiRows) ? oiRows : [];
    return {
      binanceCandles: candles.filter(c => c && c.ts >= startTime && c.ts <= endTime),
      oiRows: rows.filter(r => r && r.ts >= startTime && r.ts <= endTime),
    };
  }

  // Binance's openInterestHist only retains ~30 days of history and 400s
  // on a request spanning too much of it. 29d23h45m — 15 minutes under 30
  // days — is deliberately NOT a round 29 days: it reserves exactly the
  // 15-minute headroom that fetchBinanceOpenInterestHist's own endTime
  // padding needs, so a clamped request plus that padding still lands at
  // or under the real 30-day ceiling instead of tipping it over.
  const BINANCE_OI_MAX_LOOKBACK_MS = (29 * 24 * 60 * 60 * 1000) + (23 * 60 * 60 * 1000) + (45 * 60 * 1000);

  /**
   * Derives the Binance OI reference request range from the VISIBLE
   * analysis window ONLY (analysisStartTime/analysisEndTime as stored on
   * state.lastRun) — never from internal baseline/warmup/signal-window
   * buffers, and never from the raw binanceCandles array's own bounds
   * (which is what silently pulled in extra history before this fix).
   * Hard-clamps to just under 30 days if the visible window is wider than
   * that, per Binance's own retention limit.
   *
   * Pure — no fetch, no state — so this is fully unit-testable on its own,
   * separately from whatever the actual analysis window happens to be.
   *
   * @returns {{visibleStart:number, visibleEnd:number, effectiveStart:number, effectiveEnd:number, wasClamped:boolean}}
   */
  function computeBinanceOIReferenceRange(analysisStartTime, analysisEndTime) {
    const effectiveEnd = analysisEndTime;
    const clampedStart = effectiveEnd - BINANCE_OI_MAX_LOOKBACK_MS;
    const effectiveStart = Math.max(analysisStartTime, clampedStart);
    return {
      visibleStart: analysisStartTime,
      visibleEnd: analysisEndTime,
      effectiveStart,
      effectiveEnd,
      wasClamped: effectiveStart > analysisStartTime,
    };
  }

  /**
   * Cache hit requires the cached window to CONTAIN [startTime, endTime]
   * (not an exact lookbackDays match — a completed wider-lookback cache
   * must satisfy a narrower overlapping request) AND still be within the
   * freshness TTL (default 15 minutes) measured from when it was fetched.
   * On a hit, returns a NEW object with candles/OI sliced to exactly the
   * requested range — never the cache's full wider window.
   * `nowMs`/`ttlMs` are injectable for testing; in normal use they default
   * to the real clock and the 15-minute default above. A cache with no
   * `cachedAt` is treated as stale (never hits) rather than assumed fresh.
   */
  function getCachedRawData(cache, startTime, endTime, nowMs, ttlMs) {
    if (!cacheContainsRange(cache, startTime, endTime)) return null;
    if (typeof cache.cachedAt !== 'number') return null;
    const now = nowMs != null ? nowMs : Date.now();
    const ttl = ttlMs != null ? ttlMs : RAW_DATA_CACHE_TTL_MS;
    if (now - cache.cachedAt > ttl) return null; // expired
    const sliced = sliceRawDataToRange(cache.binanceCandles, cache.oiRows, startTime, endTime);
    return {
      startTime,
      endTime,
      binanceCandles: sliced.binanceCandles,
      oiRows: sliced.oiRows,
      coverage: cache.coverage,
      cachedAt: cache.cachedAt,
    };
  }

  function parseBybitKlineRow(raw) {
    if (!Array.isArray(raw) || raw.length < 5) return null;
    const ts = parseInt(raw[0], 10);
    const open = parseFloat(raw[1]), high = parseFloat(raw[2]), low = parseFloat(raw[3]), close = parseFloat(raw[4]);
    if (![ts, open, high, low, close].every(isFinite)) return null;
    return { ts, open, high, low, close };
  }

  // ── CryptoHFT IndexedDB cache: action classification ─────────────────────
  // The bug this fixes: cacheContainsRange requires idbEntry.endTime >=
  // requested endTime — but the requested endTime is ALWAYS "latest
  // completed candle right now" (recomputed every run), so it moves
  // forward every 15 minutes. A cache fetched even one tick ago fails
  // strict containment and fell straight through to a full multi-venue
  // refetch — exactly "hard refresh, rerun a few minutes later -> request
  // 1/2163 again". The fix: recognize this specific shape (cache covers
  // the requested HEAD, is just missing some newest TAIL candles) as its
  // own fast path — fetch only the missing tail, merge, persist — instead
  // of only ever accepting an exact/wider full match.

  /** Default ceiling on how large a "missing tail" gap can be before it's treated as a full fetch instead of an incremental one. 7 days keeps even an infrequently-reopened tab fast, without unboundedly growing the cache from a stale gap. */
  const DEFAULT_MAX_TAIL_GAP_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * Pure decision function for what to do with a CryptoHFT IndexedDB cache
   * entry, given the newly requested [startTime, endTime]. Returns
   * `{ action, reason, gapMs? }` where action is one of:
   *   'contained_slice' — cache fully covers the request; slice locally, no fetch.
   *   'tail_refresh'     — cache covers the head but is missing some newest
   *                         candles at the end; fetch ONLY that tail.
   *   'resume'           — an INCOMPLETE entry for this EXACT range exists
   *                         (interrupted previous fetch); resume it.
   *   'full_fetch'       — nothing usable is cached for this request; fetch
   *                         everything (reason explains why).
   *
   * Every branch is deliberately conservative: a complete entry that
   * doesn't cover the requested HEAD (e.g. genuinely wider/different
   * request, or a tail gap larger than the safety ceiling) is never
   * treated as partially reusable — that would risk silently merging
   * disjoint ranges. Pure — no fetch, no state — fully unit-testable.
   */
  function classifyCryptoHFTCacheAction(idbEntry, idbEntryIsComplete, startTime, endTime, opts) {
    opts = opts || {};
    const maxTailGapMs = opts.maxTailGapMs != null ? opts.maxTailGapMs : DEFAULT_MAX_TAIL_GAP_MS;

    if (!idbEntry) {
      return { action: 'full_fetch', reason: 'no_cache_entry' };
    }

    if (idbEntryIsComplete && cacheContainsRange(idbEntry, startTime, endTime)) {
      return { action: 'contained_slice', reason: 'cache_fully_contains_requested_range' };
    }

    if (idbEntryIsComplete && idbEntry.startTime <= startTime && idbEntry.endTime < endTime) {
      const gapMs = endTime - idbEntry.endTime;
      if (gapMs <= maxTailGapMs) {
        return { action: 'tail_refresh', reason: 'cache_covers_head_missing_recent_tail', gapMs };
      }
      return { action: 'full_fetch', reason: 'tail_gap_exceeds_incremental_refresh_ceiling', gapMs };
    }

    if (idbEntryIsComplete) {
      // Complete, but doesn't satisfy containment or the tail-refresh
      // shape — e.g. the request starts BEFORE the cache does (a missing
      // HEAD, not a missing tail). Never merged; a real gap at the head
      // can't be safely bridged the same way a trailing gap can.
      return { action: 'full_fetch', reason: 'complete_cache_does_not_cover_requested_head' };
    }

    if (idbEntry.startTime === startTime && idbEntry.endTime === endTime) {
      return { action: 'resume', reason: 'incomplete_entry_matches_exact_requested_range' };
    }

    return { action: 'full_fetch', reason: 'incomplete_entry_does_not_match_requested_range' };
  }

  /**
   * Merges two timestamp-keyed row arrays (candles or OI buckets, both
   * using a `.ts` field), de-duplicating by exact timestamp (new wins on
   * collision) and returning ascending by ts. Used to combine an existing
   * cached dataset with a freshly-fetched tail without needing to re-fetch
   * or discard anything already known-good.
   */
  function mergeTimestampedRows(oldRows, newRows) {
    const byTs = new Map();
    for (const r of (Array.isArray(oldRows) ? oldRows : [])) if (r && typeof r.ts === 'number') byTs.set(r.ts, r);
    for (const r of (Array.isArray(newRows) ? newRows : [])) if (r && typeof r.ts === 'number') byTs.set(r.ts, r);
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
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
    // Resume support: venues already present here (e.g. loaded from the
    // IndexedDB cache) are used as-is and never re-fetched.
    const existingPerVenueOI = options.existingPerVenueOI || {};
    // Called with (venue, bucketedOIForThatVenue) immediately after a venue
    // finishes fetching — lets the caller persist it right away, so a
    // crash/refresh mid-fetch never loses an already-completed venue.
    const onVenueComplete = options.onVenueComplete || null;

    if (!apiKey) throw new Error('CryptoHFTData API key is required — enter it in Parameters before fetching.');
    if (typeof decodeZst !== 'function' || typeof parseParquet !== 'function') {
      throw new Error('fetchCryptoHFTAggregateOI requires decodeZst and parseParquet to be provided.');
    }

    const HOUR_MS = 60 * 60 * 1000;
    const stepMs = hourStepHours * HOUR_MS;
    const firstHour = Math.floor(startTime / HOUR_MS) * HOUR_MS;
    const hourStamps = [];
    for (let h = firstHour; h <= endTime; h += stepMs) hourStamps.push(h);

    const venuesToFetch = venues.filter(v => !(Array.isArray(existingPerVenueOI[v]) && existingPerVenueOI[v].length > 0));
    const totalRequests = venuesToFetch.length * hourStamps.length;

    const perVenueOI = {};
    for (const v of venues) {
      if (Array.isArray(existingPerVenueOI[v]) && existingPerVenueOI[v].length > 0) {
        perVenueOI[v] = existingPerVenueOI[v]; // resumed from cache — no fetch at all
      }
    }

    let requestIndex = 0;
    let totalRawRowCount = 0;
    let skipped404Count = 0;

    for (const venue of venuesToFetch) {
      const symbol = symbolByVenue[venue] || 'BTCUSDT';
      const rawRowsForVenue = [];

      for (const hourStart of hourStamps) {
        requestIndex++;
        const d = new Date(hourStart);
        const dateStr = d.toISOString().slice(0, 10);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const path = `${venue}/${dateStr}/${hh}/${symbol}_open_interest.parquet.zst`;
        const url = `https://api.cryptohftdata.com/download?file=${encodeURIComponent(path)}&api_key=${encodeURIComponent(apiKey)}`;

        if (onProgress) onProgress({ type: 'page', source: 'cryptohft', venue, path, requestIndex, totalRequests, rowsSoFar: totalRawRowCount + rawRowsForVenue.length });

        let res;
        try {
          res = await fetchFn(url);
        } catch (err) {
          throw new Error(`CryptoHFTData network error fetching ${path}: ${err.message}`);
        }

        if (res.status === 404) {
          skipped404Count++;
          // No file for this venue/hour — legitimate absence, not a fatal
          // error. The aggregation step already handles missing coverage
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
            rawRowsForVenue.push(Object.assign({ exchange: venue }, r));
          }
        }

        await sleepFn(pageDelayMs);
      }

      totalRawRowCount += rawRowsForVenue.length;
      // Bucket THIS venue's data now, discard its raw rows immediately —
      // raw per-snapshot data is never retained across venues or returned.
      const bucketed = CryptoHFTSource.bucketSingleVenueOI(rawRowsForVenue, bucketMs);
      perVenueOI[venue] = bucketed;
      if (onVenueComplete) await onVenueComplete(venue, bucketed);
      if (onProgress) onProgress({ type: 'venue_complete', source: 'cryptohft', venue, bucketsForVenue: bucketed.length });
    }

    const oiRows = CryptoHFTSource.aggregateFromPerVenueBuckets(perVenueOI, venues);
    const coverage = CryptoHFTSource.summarizeBucketCoverageFromPerVenue(perVenueOI, venues);

    return { oiRows, perVenueOI, rawRowCount: totalRawRowCount, coverage, skipped404Count, totalRequests };
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
    s.directionalImpulseEnabled = s.directionalImpulseEnabled === true || s.directionalImpulseEnabled === 'true';
    s.directionalImpulseWindow = VALID_IMPULSE_WINDOWS.indexOf(s.directionalImpulseWindow) !== -1 ? s.directionalImpulseWindow : DEFAULT_SETTINGS.directionalImpulseWindow;
    s.directionalPriceEntryPercentile = clampNumber(s.directionalPriceEntryPercentile, 50, 100, DEFAULT_SETTINGS.directionalPriceEntryPercentile);
    s.directionalOiEntryPercentile = clampNumber(s.directionalOiEntryPercentile, 50, 100, DEFAULT_SETTINGS.directionalOiEntryPercentile);
    s.directionalImpulseRearmPercentile = clampNumber(s.directionalImpulseRearmPercentile, 0, Math.min(s.directionalPriceEntryPercentile, s.directionalOiEntryPercentile), DEFAULT_SETTINGS.directionalImpulseRearmPercentile);
    s.directionalMinRawOiIncreasePct = clampNumber(s.directionalMinRawOiIncreasePct, 0, 1000, DEFAULT_SETTINGS.directionalMinRawOiIncreasePct);
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
   * Maps an alert (CryptoHFT-signal-timestamped, 15m-aligned) to the
   * Binance candle used for chart display at that same timestamp. Returns
   * null if no exact-timestamp Binance candle exists (chart simply won't
   * plot that marker rather than guessing a position). Used when the chart
   * candle interval matches the signal interval exactly (15m).
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

  // ── Chart display resampling (UTC-aligned) ──────────────────────────────
  // The signal/backtest always runs on the raw 15m series (untouched by any
  // of this). These helpers only govern what the KLineChart widget DISPLAYS
  // when the person picks a coarser timeframe (1H/4H/1D), and how an
  // alert's raw 15m timestamp is mapped onto whichever displayed candle
  // actually contains it.
  //
  // Bucket width in ms per display timeframe. All three coarser buckets
  // are exact multiples of CHART_INTERVAL_MS (15m), so a single raw 15m
  // candle can never straddle two buckets. Epoch (1970-01-01T00:00:00Z) is
  // itself a 1h/4h/1d boundary, so floor(ts / bucketMs) * bucketMs lands
  // exactly on real UTC boundaries — hourly on the hour, 4h on
  // 00/04/08/12/16/20 UTC, daily on UTC midnight — regardless of where the
  // fetched candle series happens to start (e.g. an unaligned 23:45 UTC
  // first candle).
  const CHART_BUCKET_MS = {
    '15m': CHART_INTERVAL_MS,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };

  /** The UTC bucket-start timestamp (ms) that `tsMs` falls into for the given display timeframe. */
  function getUtcBucketStart(tsMs, timeframe) {
    const bucketMs = CHART_BUCKET_MS[timeframe] || CHART_INTERVAL_MS;
    return Math.floor(tsMs / bucketMs) * bucketMs;
  }

  /**
   * Resamples the raw 15m candle series for chart DISPLAY only, grouping by
   * each candle's own real UTC bucket (per getUtcBucketStart) rather than
   * by position/count from the first fetched candle. This is what makes an
   * unaligned fetch start, or a gap in the underlying series, bucket
   * correctly — every 15m candle is placed by its actual timestamp, so a
   * bucket only ever contains candles that genuinely share that UTC window,
   * and no candle is ever split across two buckets.
   *
   * '15m' is the identity case (no aggregation) but is still normalized to
   * the same {timestamp, open, high, low, close, volume} shape the
   * aggregated cases produce, since raw candles use a `ts` field rather
   * than `timestamp` and downstream chart code (zone overlays, alert
   * overlays) reads `.timestamp`.
   *
   * @param {Array<{ts:number, open:number, high:number, low:number, close:number}>} candles ascending by ts
   * @param {string} timeframe one of '15m' | '1h' | '4h' | '1d'
   * @returns {Array<{timestamp:number, open:number, high:number, low:number, close:number, volume:number}>} ascending by timestamp
   */
  function resampleCandlesForDisplay(candles, timeframe) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const bucketMs = CHART_BUCKET_MS[timeframe] || CHART_INTERVAL_MS;

    if (bucketMs <= CHART_INTERVAL_MS) {
      // 15m identity case — same OHLC values, normalized field name only.
      return candles.map(c => ({
        timestamp: c.ts,
        open: c.open != null ? c.open : c.close,
        high: c.high != null ? c.high : c.close,
        low: c.low != null ? c.low : c.close,
        close: c.close,
        volume: 0,
      }));
    }

    // Group by real UTC bucket, keyed by bucket start — NOT by position.
    const bucketByStart = new Map();
    for (const c of candles) {
      if (!c || typeof c.ts !== 'number') continue;
      const bucketStart = Math.floor(c.ts / bucketMs) * bucketMs;
      let bucket = bucketByStart.get(bucketStart);
      if (!bucket) { bucket = []; bucketByStart.set(bucketStart, bucket); }
      bucket.push(c);
    }

    const out = [];
    for (const [bucketStart, bucketCandles] of bucketByStart) {
      // Preserve real chronological order within the bucket regardless of
      // input order, so open/close pick the true first/last candle.
      bucketCandles.sort((a, b) => a.ts - b.ts);
      const first = bucketCandles[0];
      const last = bucketCandles[bucketCandles.length - 1];
      out.push({
        timestamp: bucketStart,
        open: first.open != null ? first.open : first.close,
        close: last.close,
        high: Math.max.apply(null, bucketCandles.map(c => (c.high != null ? c.high : c.close))),
        low: Math.min.apply(null, bucketCandles.map(c => (c.low != null ? c.low : c.close))),
        volume: 0,
      });
    }

    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /** Index of displayed candles by their `timestamp` field, for O(1) alert-to-candle lookup. */
  function buildDisplayCandleIndex(displayCandles) {
    const map = new Map();
    for (const c of displayCandles) map.set(c.timestamp, c);
    return map;
  }

  // ── Binance native OI reference layer ────────────────────────────────────
  // EXTERNAL REFERENCE ONLY — never read by V1/V2/directional-impulse
  // scoring, zones, cache, or backtest calculations (see
  // oi-exhaustion-binance-oi-source.js). This attaches the Binance OI
  // reference series onto the SAME price display-candle objects fed to
  // the chart, as an extra `binanceOI` field the custom reference-pane
  // indicator reads — piggy-backing on the main series is what makes the
  // reference pane's zoom/pan/crosshair/timeframe sync with the price
  // pane automatically (same instance, same x-axis), with no hand-rolled
  // cross-chart event wiring at all.
  /**
   * @param {Array<{timestamp:number}>} displayCandles the price series already built for the chart
   * @param {Array<object>} binanceOISeries output of BinanceOISource.buildBinanceOIDisplaySeries — either {ts,value} (15m) or {timestamp,open,high,low,close} (1h/2h/4h)
   * @param {string} timeframe '15m' | '1h' | '2h' | '4h'
   * @returns {Array<object>} displayCandles, each with an added `binanceOI: {close,high,low}|null` field (null where there's no matching Binance reading — a real gap, not a fill)
   */
  function mergeBinanceOIOntoDisplayCandles(displayCandles, binanceOISeries, timeframe) {
    const list = Array.isArray(displayCandles) ? displayCandles : [];
    const series = Array.isArray(binanceOISeries) ? binanceOISeries : [];
    const isLineSeries = timeframe === '15m';
    const index = new Map();
    for (const pt of series) {
      const key = isLineSeries ? pt.ts : pt.timestamp;
      index.set(key, pt);
    }
    return list.map(c => {
      const match = index.get(c.timestamp);
      if (!match) return Object.assign({}, c, { binanceOI: null });
      const binanceOI = isLineSeries
        ? { close: match.value, high: match.value, low: match.value }
        : { close: match.close, high: match.high, low: match.low };
      return Object.assign({}, c, { binanceOI });
    });
  }

  // ── Help tooltip ("?") system — shared across Parameters & Zones ────────
  // Pure state transition only one tooltip open at a time: clicking the
  // currently-open icon closes it; clicking a different icon closes
  // whichever was open and opens the new one instead. No DOM here — the
  // browser-only toggleHelpTooltip (below the Node/browser split) is a
  // thin wrapper around this.
  function nextHelpTooltipState(currentOpenId, clickedId) {
    return currentOpenId === clickedId ? null : clickedId;
  }

  /**
   * Creates a klinecharts overlay with its points supplied directly at
   * creation time — the officially documented usage. A prior version of
   * this function worked around a suspected "points may not render when
   * supplied at creation" library bug by creating with no points and
   * setting them via a separate overrideOverlay call instead. That
   * workaround was reverted after confirmed empirical breakage: creating
   * several such "empty then override" overlays in sequence (e.g. one per
   * alert) left only the LAST one visible — every earlier one silently
   * disappeared. This matches a different, also-documented klinecharts
   * bug ("overlays that are forced to end drawing cannot be restored") —
   * an overlay created with fewer points than its totalStep is left in an
   * interactive "still drawing" state, and only one such state can exist
   * at a time; starting a new one discards the previous, even after its
   * points were set via override. Supplying points immediately at
   * creation avoids that state entirely — the overlay is complete from
   * the moment it exists, never "still drawing".
   *
   * No real DOM/klinecharts dependency of its own — `chart` is just an
   * object with a createOverlay method, dependency-injected, so this is
   * testable in Node against a fake chart.
   */
  function createOverlaySafely(chart, overlayConfig, points, paneId) {
    const config = Object.assign({}, overlayConfig, { points });
    const created = paneId != null ? chart.createOverlay(config, paneId) : chart.createOverlay(config);
    const id = Array.isArray(created) ? created[0] : created;
    return id || null;
  }

  /**
   * Maps a raw alert timestamp (always 15m-aligned) onto the displayed
   * candle that actually contains it, for the given display timeframe —
   * i.e. the fix for "overlays/tooltip/focus used the raw 15m alert
   * timestamp even when the chart is showing 1H/4H/1D candles". Returns
   * null if that UTC bucket isn't present in the displayed series (e.g. a
   * gap in the underlying data), rather than guessing a nearby candle.
   *
   * @param {number} alertTs raw (15m-aligned) alert timestamp
   * @param {Map<number, object>} displayCandleIndex from buildDisplayCandleIndex
   * @param {string} timeframe one of '15m' | '1h' | '4h' | '1d'
   */
  function findDisplayCandleForAlert(alertTs, displayCandleIndex, timeframe) {
    const bucketStart = getUtcBucketStart(alertTs, timeframe);
    return displayCandleIndex.get(bucketStart) || null;
  }

  /** Start timestamp of the latest fully completed 15m candle, given "now". */
  function latestCompletedCandleStart(nowMs) {
    const currentCandleStart = Math.floor(nowMs / CHART_INTERVAL_MS) * CHART_INTERVAL_MS;
    return currentCandleStart - CHART_INTERVAL_MS;
  }

  // ── Chart marker reconciliation ──────────────────────────────────────────
  // Every alert the backtest returns should end up as a visible chart
  // marker, UNLESS its raw timestamp genuinely falls outside the loaded
  // candle range (rare — only possible with a stale/mismatched run). Two
  // or more alerts landing on the same DISPLAYED candle (normal: different
  // zones can both fire on the same candle, and coarser timeframes bucket
  // several raw candles together) is NOT an exclusion — it's a group that
  // must be rendered distinguishably rather than silently overlapping.

  /**
   * For every alert, determines whether it maps to a raw 15m candle AND a
   * displayed candle for the given timeframe, or is excluded with an
   * explicit reason — then groups every successfully-mapped alert by its
   * shared display-candle timestamp.
   *
   * Invariant: mappedCount + excluded.length === totalAlerts, always —
   * every alert lands in exactly one of the two buckets, never both, never
   * neither.
   *
   * @param {Array<object>} alerts result.alerts from the backtest (each has a `timestamp`)
   * @param {Array<{ts:number}>} rawCandles ascending — run.binanceCandles
   * @param {Array<{timestamp:number}>} displayCandles ascending — resampleCandlesForDisplay(...) output
   * @param {string} timeframe one of '15m' | '1h' | '4h' | '1d'
   * @returns {{
   *   totalAlerts: number,
   *   mappedCount: number,
   *   outsideRangeCount: number,
   *   groupedAlertCount: number,
   *   groups: Array<{timestamp:number, alerts: Array<object>}>,
   *   excluded: Array<{alert:object, reason:string}>,
   * }}
   */
  function reconcileChartMarkers(alerts, rawCandles, displayCandles, timeframe) {
    const alertList = Array.isArray(alerts) ? alerts : [];
    const displayCandleIndex = buildDisplayCandleIndex(Array.isArray(displayCandles) ? displayCandles : []);

    const excluded = [];
    const groupsByTs = new Map(); // display timestamp -> alerts[]

    for (const alert of alertList) {
      const rawIdx = findContainingCandleIndex(alert.timestamp, Array.isArray(rawCandles) ? rawCandles : [], CHART_INTERVAL_MS);
      if (rawIdx === -1) {
        excluded.push({ alert, reason: 'OUTSIDE_RAW_CANDLE_RANGE' });
        continue;
      }
      const displayCandle = findDisplayCandleForAlert(alert.timestamp, displayCandleIndex, timeframe);
      if (!displayCandle) {
        excluded.push({ alert, reason: 'OUTSIDE_DISPLAY_CANDLE_RANGE' });
        continue;
      }
      if (!groupsByTs.has(displayCandle.timestamp)) groupsByTs.set(displayCandle.timestamp, []);
      groupsByTs.get(displayCandle.timestamp).push(alert);
    }

    const groups = Array.from(groupsByTs.entries())
      .map(([timestamp, groupAlerts]) => ({ timestamp, alerts: groupAlerts }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const mappedCount = groups.reduce((sum, g) => sum + g.alerts.length, 0);
    const groupedAlertCount = groups.filter(g => g.alerts.length > 1).reduce((sum, g) => sum + g.alerts.length, 0);

    return {
      totalAlerts: alertList.length,
      mappedCount,
      outsideRangeCount: excluded.length,
      groupedAlertCount,
      groups,
      excluded,
    };
  }

  /** Pure formatter for the permanent chart-marker diagnostic line. */
  function formatChartMarkerDiagnosticLine(reconciliation) {
    const r = reconciliation || {};
    const mapped = r.mappedCount || 0;
    const total = r.totalAlerts || 0;
    const outside = r.outsideRangeCount || 0;
    const grouped = r.groupedAlertCount || 0;
    return `Chart markers: ${mapped}/${total} alerts mapped &middot; ${outside} outside visible range &middot; ${grouped} grouped into shared candles`;
  }

  /**
   * Builds a detailed error message from window.__oixChartLibAttempts (set
   * by the sequential local -> jsdelivr -> unpkg loading chain in
   * index.html), listing exactly which klinecharts sources were tried and
   * whether each one succeeded — so a load failure is never a bare
   * "undefined", per the requirement to retain the exact URLs attempted.
   */
  function describeChartLibLoadFailure(attempts) {
    const list = Array.isArray(attempts) ? attempts : [];
    if (!list.length) {
      return 'window.klinecharts is undefined and no load attempts were recorded — check the <script> tags in index.html.';
    }
    const lines = list.map(a => `${a && a.ok ? 'OK' : 'FAILED'}: ${a && a.url}`).join(' | ');
    return `window.klinecharts is undefined after trying ${list.length} source(s) — ${lines}`;
  }

  /**
   * Visual identity for each alert cause — shared by the alerts table
   * badge, chart marker color, and tooltip. V1/V2 keep their existing
   * red/teal exhaustion-context colors (contextDirection-based, unchanged
   * from before this feature); the two directional-impulse causes get
   * their own distinct colors so they're never confused with exhaustion
   * alerts or with each other.
   */
  const CAUSE_STYLES = {
    V1_EXHAUSTION: { color: '#9aa1ab', bg: 'rgba(154,161,171,0.1)', border: 'rgba(154,161,171,0.3)', label: 'V1 exhaustion' },
    V2_EXHAUSTION: { color: '#28d7c8', bg: 'rgba(40,215,200,0.1)', border: 'rgba(40,215,200,0.3)', label: 'V2 exhaustion' },
    DOWNSIDE_OI_CHASE: { color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', border: 'rgba(167,139,250,0.3)', label: 'Downside OI chase' },
    UPSIDE_OI_CHASE: { color: '#f0b559', bg: 'rgba(240,181,89,0.1)', border: 'rgba(240,181,89,0.3)', label: 'Upside OI chase' },
  };

  function causeBadgeHtml(cause) {
    const st = CAUSE_STYLES[cause];
    if (!st) return `<span style="color:var(--text-faint);">${escapeHtml(cause || '—')}</span>`;
    return `<span class="oix-ctx-badge" style="color:${st.color};background:${st.bg};border:1px solid ${st.border};">${escapeHtml(st.label)}</span>`;
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
    reconcileChartMarkers,
    formatChartMarkerDiagnosticLine,
    describeChartLibLoadFailure,
    CHART_BUCKET_MS,
    getUtcBucketStart,
    resampleCandlesForDisplay,
    buildDisplayCandleIndex,
    findDisplayCandleForAlert,
    mergeBinanceOIOntoDisplayCandles,
    nextHelpTooltipState,
    createOverlaySafely,
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
    cacheContainsRange,
    sliceRawDataToRange,
    DEFAULT_MAX_TAIL_GAP_MS,
    classifyCryptoHFTCacheAction,
    mergeTimestampedRows,
    BINANCE_OI_MAX_LOOKBACK_MS,
    computeBinanceOIReferenceRange,
    RAW_DATA_PACK_SCHEMA,
    RAW_DATA_PACK_VERSION,
    RAW_DATA_PACK_MAX_BYTES,
    createRawDataPack,
    parseRawDataPack,
    rawDataPackFilename,
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
    CAUSE_STYLES,
    causeBadgeHtml,
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
    importedDataPack: null, // manually imported portable raw-data pack; never auto-fetched or persisted
    chart: { instance: null, timeframe: '15m', displayIndex: null, markerGroups: [], focusTooltipHideTimer: null },
    // Binance native OI — external reference layer ONLY. Deliberately its
    // own top-level state key, never touched by anything under
    // Backtest.runEventStudy or the IndexedDB raw-data cache.
    binanceOI: {
      enabled: false, rawRows: null, fetching: false, error: null, rangeStart: null, rangeEnd: null,
      visibleStart: null, visibleEnd: null, effectiveStart: null, effectiveEnd: null, wasClamped: false,
    },
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
    const ids = ['lookbackDays', 'signalWindow', 'baselineLookbackCandles', 'minBaselineSamples', 'entryPercentile', 'rearmPercentile', 'alertModel', 'minimumRecentOIChangePct', 'oiRecencyWindow', 'cryptoHftApiKey',
      'directionalImpulseWindow', 'directionalPriceEntryPercentile', 'directionalOiEntryPercentile', 'directionalImpulseRearmPercentile', 'directionalMinRawOiIncreasePct'];
    ids.forEach(id => {
      const el = document.getElementById('oix-' + id);
      if (el) el.value = s[id];
    });
    const filterEl = document.getElementById('oix-oiRecencyFilterEnabled');
    if (filterEl) filterEl.checked = s.oiRecencyFilterEnabled;
    const directionalEl = document.getElementById('oix-directionalImpulseEnabled');
    if (directionalEl) directionalEl.checked = s.directionalImpulseEnabled;
  }

  function readSettingsFromForm() {
    const ids = ['lookbackDays', 'signalWindow', 'baselineLookbackCandles', 'minBaselineSamples', 'entryPercentile', 'rearmPercentile', 'alertModel', 'minimumRecentOIChangePct', 'oiRecencyWindow', 'cryptoHftApiKey',
      'directionalImpulseWindow', 'directionalPriceEntryPercentile', 'directionalOiEntryPercentile', 'directionalImpulseRearmPercentile', 'directionalMinRawOiIncreasePct'];
    const raw = {};
    ids.forEach(id => {
      const el = document.getElementById('oix-' + id);
      if (el) raw[id] = el.value;
    });
    const filterEl = document.getElementById('oix-oiRecencyFilterEnabled');
    raw.oiRecencyFilterEnabled = filterEl ? filterEl.checked : false;
    const directionalEl = document.getElementById('oix-directionalImpulseEnabled');
    raw.directionalImpulseEnabled = directionalEl ? directionalEl.checked : false;
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

  /**
   * Fetches Binance candles + CryptoHFT aggregate OI fresh, no caching at
   * all — used only as a fallback if the IndexedDB module itself failed to
   * load (e.g. script blocked), so the tab still functions without the
   * persistence layer rather than breaking outright.
   */
  async function fetchFreshDataset(startTime, endTime, s, progress) {
    const binancePromise = fetchBinanceCandles(startTime, endTime, { onProgress: progress, pageDelayMs: BINANCE_PAGE_DELAY_MS });
    const cryptoHftResult = await fetchCryptoHFTAggregateOI(startTime, endTime, s.cryptoHftApiKey, {
      onProgress: progress,
      decodeZst: decodeZstBrowser,
      parseParquet: parseParquetBrowser,
    });
    const binanceCandles = await binancePromise;
    const oiRows = cryptoHftResult.oiRows;
    const coverage = cryptoHftResult.coverage;

    if (oiRows.length === 0 || binanceCandles.length === 0) {
      throw new Error(
        `Zero usable rows returned — CryptoHFT aggregate buckets: ${oiRows.length}, Binance candles: ${binanceCandles.length}. ` +
        `Raw rows collected: ${cryptoHftResult.rawRowCount}, complete buckets: ${coverage.completeBuckets}/${coverage.totalBucketsSeen} seen, ` +
        `venues seen: ${coverage.venuesSeen.join(', ') || 'none'}. Aborting rather than running on partial data.`
      );
    }
    return { oiRows, binanceCandles, coverage };
  }

  async function runAnalysis(opts) {
    opts = opts || {};
    const forceRefresh = opts.forceRefresh === true;
    const rawDataOverride = opts.rawDataOverride || null;
    readSettingsFromForm();
    const s = state.settings;
    const runBtn = document.getElementById('oix-run-btn');
    const refreshBtn = document.getElementById('oix-refresh-btn');
    if (runBtn) runBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;

    try {
      if (!rawDataOverride && !s.cryptoHftApiKey) {
        throw new Error('CryptoHFTData API key is required — enter it in Parameters before running, or import a raw-data pack.');
      }

      const endTime = rawDataOverride ? rawDataOverride.endTime : latestCompletedCandleStart(Date.now());
      const startTime = rawDataOverride ? rawDataOverride.startTime : endTime - s.lookbackDays * 24 * 3600 * 1000;

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
      if (rawDataOverride) {
        oiRows = rawDataOverride.oiRows;
        binanceCandles = rawDataOverride.binanceCandles;
        coverage = rawDataOverride.coverage || null;
        setStatus(`<span style="color:var(--teal);">Using imported raw-data pack.</span> ${safeUtcDateString(startTime)} → ${safeUtcDateString(endTime)} &middot; ${safeNumber(oiRows.length)} OI buckets / ${safeNumber(binanceCandles.length)} candles &middot; no CryptoHFT fetch.`);
        console.log('[CryptoHFT cache] path=imported_data_pack', { startTime, endTime, startTimeStr: safeUtcDateString(startTime), endTimeStr: safeUtcDateString(endTime) });
      } else {
      const memCached = forceRefresh ? null : getCachedRawData(state.rawDataCache, startTime, endTime);

      console.log('[CryptoHFT cache] requested range', {
        startTime, endTime, startTimeStr: safeUtcDateString(startTime), endTimeStr: safeUtcDateString(endTime),
        forceRefresh,
        memCacheRange: state.rawDataCache ? { startTime: state.rawDataCache.startTime, endTime: state.rawDataCache.endTime } : null,
      });

      if (memCached) {
        const cachedWindow = `${safeUtcDateString(memCached.startTime)} → ${safeUtcDateString(memCached.endTime)}`;
        const cachedAtStr = safeUtcDateString(memCached.cachedAt);
        const wasWider = state.rawDataCache && (state.rawDataCache.startTime < startTime || state.rawDataCache.endTime > endTime);
        setStatus(
          (wasWider
            ? `Reusing the newest ${escapeHtml(String(s.lookbackDays))} days from a wider already-downloaded dataset — sliced locally, no new fetch. `
            : `Reusing already-downloaded raw data (lookback days unchanged, cache still fresh) — rerunning analysis with current parameters, no new fetch. `) +
          `Requested window: ${cachedWindow} &middot; originally fetched at ${cachedAtStr}.`
        );
        console.log('[CryptoHFT cache] path=memory_hit', { reason: wasWider ? 'wider_memory_cache_sliced' : 'exact_memory_cache_fresh' });
        ({ oiRows, binanceCandles, coverage } = memCached);
      } else if (!IdbCache) {
        // IndexedDB module didn't load (script missing/blocked) — degrade
        // to the old always-fetch behavior rather than failing outright.
        setStatus('Fetching CryptoHFT 3-venue aggregate OI and Binance 15m price candles (persistent cache unavailable this session)…');
        console.log('[CryptoHFT cache] path=full_fetch', { reason: 'idb_cache_module_unavailable' });
        const fetched = await fetchFreshDataset(startTime, endTime, s, progress);
        ({ oiRows, binanceCandles, coverage } = fetched);
        state.rawDataCache = { lookbackDays: s.lookbackDays, startTime, endTime, oiRows, binanceCandles, coverage, cachedAt: Date.now() };
      } else {
        // Key is deliberately independent of lookbackDays — venues+bucketMs
        // only — so there is exactly ONE persisted slot per venue-set,
        // always representing whatever the most recently fetched dataset
        // covers. A completed wider-lookback entry then satisfies any
        // smaller overlapping request via containment (below), instead of
        // requiring an exact lookbackDays match that previously forced a
        // full re-download for every different lookback value tried.
        const idbKey = IdbCache.buildCacheKey({ venues: CRYPTOHFT_REQUIRED_VENUES, bucketMs: CRYPTOHFT_BUCKET_MS });

        if (forceRefresh) {
          setStatus('Refresh requested — deleting the cached dataset and starting a full re-fetch…');
          try { await IdbCache.deleteCacheEntry(idbKey); } catch (e) { /* non-fatal */ }
        }

        let idbEntry = null;
        try { idbEntry = await IdbCache.getCacheEntry(idbKey); } catch (e) { idbEntry = null; }
        const idbEntryIsComplete = idbEntry && IdbCache.isCacheEntryComplete(idbEntry, CRYPTOHFT_REQUIRED_VENUES);
        const classification = classifyCryptoHFTCacheAction(idbEntry, idbEntryIsComplete, startTime, endTime);

        console.log('[CryptoHFT cache] IndexedDB lookup', {
          idbEntryExists: !!idbEntry,
          idbEntryStatus: idbEntry ? idbEntry.status : null,
          idbEntryRange: idbEntry ? { startTime: idbEntry.startTime, endTime: idbEntry.endTime, startTimeStr: safeUtcDateString(idbEntry.startTime), endTimeStr: safeUtcDateString(idbEntry.endTime) } : null,
          idbEntryIsComplete,
          chosenAction: classification.action,
          reason: classification.reason,
          tailGapMs: classification.gapMs != null ? classification.gapMs : undefined,
          tailGapMinutes: classification.gapMs != null ? Math.round(classification.gapMs / 60000) : undefined,
        });

        if (classification.action === 'contained_slice') {
          // Fast path: the persisted dataset already covers this request
          // (exactly, or with room to spare) — slice locally, no fetch at
          // all. This is what makes "30-day cache exists, 28-day request
          // arrives" instant instead of a fresh download.
          const sliced = sliceRawDataToRange(idbEntry.binanceCandles, idbEntry.aggregateOI, startTime, endTime);
          binanceCandles = sliced.binanceCandles;
          oiRows = sliced.oiRows;
          coverage = idbEntry.coverage;
          const wasWider = idbEntry.startTime < startTime || idbEntry.endTime > endTime;
          const ageMin = Math.round((Date.now() - idbEntry.updatedAt) / 60000);
          setStatus(
            (wasWider
              ? `<span style="color:var(--teal);">Reusing the newest ${escapeHtml(String(s.lookbackDays))} days from a wider cached dataset</span> (sliced locally, no fetch). `
              : `<span style="color:var(--teal);">Loaded cached data.</span> `) +
            `Cache age: ${ageMin} min &middot; original coverage: ${safeUtcDateString(idbEntry.startTime)} → ${safeUtcDateString(idbEntry.endTime)} &middot; ` +
            `serving: ${safeUtcDateString(startTime)} → ${safeUtcDateString(endTime)} &middot; ` +
            `${safeNumber(oiRows.length)} OI buckets / ${safeNumber(binanceCandles.length)} candles.`
          );

        } else if (classification.action === 'tail_refresh') {
          // The cache covers the requested HEAD but is missing some newest
          // candles at the end (the requested endTime moved forward since
          // this was cached — expected, since it's always "now"). Fetch
          // ONLY the missing tail, with a small safe overlap so there's
          // never an exact-boundary gap, then merge with what's already
          // cached, dedupe, and persist as the new (wider) entry. This is
          // what makes "hard refresh a few minutes later" fast instead of
          // re-triggering a full 30-day multi-venue refetch.
          const OVERLAP_CANDLES = 2;
          const tailFetchStart = Math.max(idbEntry.startTime, idbEntry.endTime - OVERLAP_CANDLES * CHART_INTERVAL_MS);
          setStatus(
            `Cache covers ${safeUtcDateString(idbEntry.startTime)} → ${safeUtcDateString(idbEntry.endTime)} already — ` +
            `fetching only the newest tail (${safeUtcDateString(tailFetchStart)} → ${safeUtcDateString(endTime)}), not a full refetch…`
          );

          const tailBinanceCandles = await fetchBinanceCandles(tailFetchStart, endTime, { onProgress: progress, pageDelayMs: BINANCE_PAGE_DELAY_MS });
          const tailCryptoHftResult = await fetchCryptoHFTAggregateOI(tailFetchStart, endTime, s.cryptoHftApiKey, {
            onProgress: progress,
            decodeZst: decodeZstBrowser,
            parseParquet: parseParquetBrowser,
            existingPerVenueOI: {}, // a fresh small tail pull — NOT resuming the old entry's (different-range) per-venue state
          });

          const mergedBinanceCandles = mergeTimestampedRows(idbEntry.binanceCandles, tailBinanceCandles);
          const mergedOiRows = mergeTimestampedRows(idbEntry.aggregateOI, tailCryptoHftResult.oiRows);

          const sliced = sliceRawDataToRange(mergedBinanceCandles, mergedOiRows, startTime, endTime);
          binanceCandles = sliced.binanceCandles;
          oiRows = sliced.oiRows;
          coverage = tailCryptoHftResult.coverage; // reflects the freshly-fetched tail's own coverage diagnostics

          const workingEntry = Object.assign({}, idbEntry, {
            binanceCandles: mergedBinanceCandles,
            aggregateOI: mergedOiRows,
            coverage,
            status: 'complete',
            startTime: idbEntry.startTime, // head is unchanged — only the tail was extended
            endTime,
          });
          try { await IdbCache.putCacheEntry(workingEntry); } catch (e) { /* non-fatal for this run, but future reruns won't get the extended tail persisted */ }

          setStatus(
            `<span style="color:var(--teal);">Tail refresh complete.</span> Fetched only the newest ${safeNumber(tailBinanceCandles.length)} candles ` +
            `(${safeUtcDateString(tailFetchStart)} → ${safeUtcDateString(endTime)}) instead of a full refetch &middot; ` +
            `${safeNumber(oiRows.length)} OI buckets / ${safeNumber(binanceCandles.length)} candles now serving this request.`
          );

        } else {
          // 'resume' or 'full_fetch' — nothing usable is cached for this
          // exact request. A COMPLETE entry that exists but doesn't
          // qualify for contained_slice or tail_refresh (e.g. missing the
          // requested HEAD, or a tail gap too large) is a mismatched
          // range, not a partial fetch of THIS range — it must never be
          // treated as resumable for a different window, which would
          // silently merge two unrelated date ranges. Resuming an
          // in-progress entry only applies when its own stored
          // startTime/endTime exactly match the current request.
          const resumableEntry = classification.action === 'resume' ? idbEntry : null;
          const resuming = resumableEntry && (IdbCache.completedVenues(resumableEntry, CRYPTOHFT_REQUIRED_VENUES).length > 0 ||
            (Array.isArray(resumableEntry.binanceCandles) && resumableEntry.binanceCandles.length > 0));
          setStatus(resuming
            ? 'Fetching missing data — resuming a previously interrupted pull, already-completed venues will not be re-fetched…'
            : `Fetching missing data — ${classification.reason.replace(/_/g, ' ')}, first pull may take a while…`);

          const workingEntry = resumableEntry || IdbCache.makeEmptyEntry(idbKey, { lookbackDays: s.lookbackDays, startTime, endTime });
          try { await IdbCache.putCacheEntry(workingEntry); } catch (e) { /* non-fatal — proceeds without persistence if IDB write fails */ }

          if (Array.isArray(workingEntry.binanceCandles) && workingEntry.binanceCandles.length > 0) {
            binanceCandles = workingEntry.binanceCandles;
          } else {
            binanceCandles = await fetchBinanceCandles(startTime, endTime, { onProgress: progress, pageDelayMs: BINANCE_PAGE_DELAY_MS });
            workingEntry.binanceCandles = binanceCandles;
            try { await IdbCache.putCacheEntry(workingEntry); } catch (e) { /* non-fatal */ }
          }

          const cryptoHftResult = await fetchCryptoHFTAggregateOI(startTime, endTime, s.cryptoHftApiKey, {
            onProgress: progress,
            decodeZst: decodeZstBrowser,
            parseParquet: parseParquetBrowser,
            existingPerVenueOI: workingEntry.perVenueOI || {},
            onVenueComplete: async (venue, bucketed) => {
              workingEntry.perVenueOI[venue] = bucketed;
              try { await IdbCache.putCacheEntry(workingEntry); } catch (e) { /* non-fatal — this venue's work is still in memory for this run */ }
            },
          });
          oiRows = cryptoHftResult.oiRows;
          coverage = cryptoHftResult.coverage;

          if (oiRows.length === 0 || binanceCandles.length === 0) {
            throw new Error(
              `Zero usable rows returned — CryptoHFT aggregate buckets: ${oiRows.length}, Binance candles: ${binanceCandles.length}. ` +
              `Raw rows collected this run: ${cryptoHftResult.rawRowCount}, complete buckets: ${coverage.completeBuckets}/${coverage.totalBucketsSeen} seen, ` +
              `venues seen: ${coverage.venuesSeen.join(', ') || 'none'}. Aborting rather than running on partial data — the cache entry stays marked incomplete, so nothing invalid can be reused.`
            );
          }

          workingEntry.aggregateOI = oiRows;
          workingEntry.coverage = coverage;
          workingEntry.status = 'complete';
          workingEntry.startTime = startTime;
          workingEntry.endTime = endTime;
          try { await IdbCache.putCacheEntry(workingEntry); } catch (e) { /* non-fatal for this run, but future reruns won't get the cache benefit */ }
          setStatus(`<span style="color:var(--teal);">Cached dataset complete.</span> ${safeNumber(oiRows.length)} OI buckets / ${safeNumber(binanceCandles.length)} candles saved for instant reruns.`);
        }

        // Populate the in-memory (session) cache too, for the fastest
        // possible immediate rerun — unchanged fast path.
        state.rawDataCache = { lookbackDays: s.lookbackDays, startTime, endTime, oiRows, binanceCandles, coverage, cachedAt: Date.now() };
      }
      }

      state.rawDataCache = { lookbackDays: s.lookbackDays, startTime, endTime, oiRows, binanceCandles, coverage, cachedAt: rawDataOverride ? (rawDataOverride.importedAt || Date.now()) : Date.now() };
      updateRawDataPackControls();

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
        directionalImpulseEnabled: s.directionalImpulseEnabled,
        directionalImpulseWindow: s.directionalImpulseWindow,
        directionalPriceEntryPercentile: s.directionalPriceEntryPercentile,
        directionalOiEntryPercentile: s.directionalOiEntryPercentile,
        directionalImpulseRearmPercentile: s.directionalImpulseRearmPercentile,
        directionalMinRawOiIncreasePct: s.directionalMinRawOiIncreasePct,
      });

      const binanceIndex = buildBinanceCandleIndex(binanceCandles);
      const chartPoints = result.alerts
        .map(a => mapAlertToContainingChartPoint(a, binanceCandles, CHART_INTERVAL_MS))
        .filter(Boolean);

      // Only now — after everything above succeeded — do we touch the
      // rendered state. Nothing partial ever reaches state.lastRun.
      state.lastRun = { result, binanceCandles, binanceIndex, chartPoints, coverage, analysisStartTime: startTime, analysisEndTime: endTime };
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
      </div>
      ${directionalImpulseDiagnosticsHtml(run.result.meta.directionalImpulse)}`;
  }

  /** "Include fast directional OI builds" diagnostics block — settings + counts for the run just completed. */
  function directionalImpulseDiagnosticsHtml(di) {
    if (!di) return '';
    if (!di.enabled) {
      return `<div style="font-size:11px;color:var(--text-faint);margin-top:10px;padding-top:10px;border-top:0.5px solid var(--line-old);">
        Include fast directional OI builds: <b style="color:var(--text-dim);">disabled</b> for this run.
      </div>`;
    }
    return `<div style="font-size:11px;color:var(--text-dim);margin-top:10px;padding-top:10px;border-top:0.5px solid var(--line-old);">
      <b style="color:var(--text);">Directional OI builds</b> — window ${escapeHtml(di.impulseWindow)},
      price/OI entry percentile ${di.priceEntryPercentile}/${di.oiEntryPercentile}, rearm ${di.rearmPercentile}, min raw OI floor ${di.minRawOiIncreasePct}%.
      <span style="color:var(--text-faint);">${causeBadgeHtml('DOWNSIDE_OI_CHASE')} ${safeNumber(di.downsideChaseCount)} &middot; ${causeBadgeHtml('UPSIDE_OI_CHASE')} ${safeNumber(di.upsideChaseCount)}</span>
      <div style="margin-top:4px;color:var(--text-faint);">
        Counts are for the ${escapeHtml(di.impulseWindow)} window only — run <code>OIExhaustionRender.compareDirectionalImpulseWindows()</code> in the console to compare 15m/1h/2h side by side on this same cached data.
      </div>
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
          <th>Time</th><th>Cause</th><th>Zone</th><th>Model</th><th>Price</th>
          <th>Percentile</th><th>Z</th><th>OI 12h</th><th>OI 1h</th><th>OI slope 1h</th><th>Travel 12h</th>
          <th>Price Δ (imp.)</th><th>OI Δ (imp.)</th>
          ${horizonCols.map(h => `<th>${h.label}</th>`).join('')}
        </tr></thead>
        <tbody>${rows.map((a) => `
          <tr onclick="OIExhaustionRender.focusChartOnAlert(${run.result.alerts.indexOf(a)})" style="cursor:pointer;">
            <td>${new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td>${causeBadgeHtml(a.cause)}</td>
            <td>${escapeHtml(a.zoneBounds.label || a.zoneId)}</td>
            <td>${a.alertModel != null ? `<span class="oix-model-badge">${a.alertModel === 'netProgress' ? 'V2' : 'V1'}</span>` : '—'}</td>
            <td>$${safeNumber(a.price, { maximumFractionDigits: 0 })}</td>
            <td>${a.percentile != null ? a.percentile.toFixed(1) : '—'}</td>
            <td>${a.zScore != null ? a.zScore.toFixed(2) : '—'}</td>
            <td>${a.oiChange12hPct != null ? a.oiChange12hPct.toFixed(1) + '%' : '—'}</td>
            <td>${a.oiChange1hPct != null ? a.oiChange1hPct.toFixed(2) + '%' : '—'}</td>
            <td style="color:${a.oiSlopeRecent != null ? (a.oiSlopeRecent >= 0 ? 'var(--green)' : 'var(--red)') : 'inherit'};">${a.oiSlopeRecent != null ? a.oiSlopeRecent.toFixed(2) : '—'}</td>
            <td>${a.priceTravel12hAbsPct != null ? a.priceTravel12hAbsPct.toFixed(1) + '%' : '—'}</td>
            <td title="${a.impulseWindow != null ? escapeHtml(a.impulseWindow) + ' impulse window' : ''}">${a.priceReturnPct != null ? (a.priceReturnPct >= 0 ? '+' : '') + a.priceReturnPct.toFixed(2) + '%' : '—'}</td>
            <td title="${a.impulseWindow != null ? escapeHtml(a.impulseWindow) + ' impulse window' : ''}">${a.oiReturnPct != null ? (a.oiReturnPct >= 0 ? '+' : '') + a.oiReturnPct.toFixed(2) + '%' : '—'}</td>
            ${horizonCols.map(h => `<td>${horizonCell(a, h.key)}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── Chart (KLineChart — real zoom/pan/timeframe, pinned v9.8.10) ────────
  // Candles are always computed/scored on the true 15m series (unchanged).
  // The chart DISPLAYS a resampled view (15m/1h/4h/1d) purely for visual
  // convenience — resampling here never touches V1/V2 math or alert data.
  // resampleCandlesForDisplay / CHART_BUCKET_MS / getUtcBucketStart /
  // buildDisplayCandleIndex / findDisplayCandleForAlert are defined above
  // in the shared/testable section (already in scope via closure).

  function chartError(context, err) {
    console.error(`[OI Exhaustion chart] ${context}:`, err);
    const wrap = document.getElementById('oix-price-chart-wrap');
    if (wrap) {
      const banner = document.createElement('div');
      banner.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:6px;background:rgba(226,100,95,0.12);color:#e2645f;font-size:11px;font-family:monospace;';
      banner.textContent = `Chart error (${context}): ${err && err.message ? err.message : String(err)}`;
      wrap.parentNode.insertBefore(banner, wrap);
    }
  }

  function initChart() {
    if (typeof klinecharts === 'undefined') {
      const attempts = (typeof window !== 'undefined' && window.__oixChartLibAttempts) || [];
      chartError('library load', new Error(describeChartLibLoadFailure(attempts)));
      return;
    }
    try {
      if (state.chart.instance) {
        klinecharts.dispose('oix-price-canvas');
        state.chart.instance = null;
      }
      const chart = klinecharts.init('oix-price-canvas');
      if (!chart) { chartError('init', new Error('klinecharts.init returned null')); return; }
      state.chart.instance = chart;

      chart.setStyles({
        grid: { horizontal: { color: 'rgba(255,255,255,0.05)' }, vertical: { show: false } },
        candle: { bar: { upColor: '#3ddc97', downColor: '#e2645f', noChangeColor: '#888', upBorderColor: '#3ddc97', downBorderColor: '#e2645f', upWickColor: '#3ddc97', downWickColor: '#e2645f' } },
      });

      applyChartData();
      wireChartTooltip(chart);
    } catch (err) {
      chartError('init', err);
    }
  }

  // v9's built-in overlay set does NOT include a plain shaded-rectangle
  // type (confirmed against the official overlay list: horizontalRayLine,
  // horizontalSegment, horizontalStraightLine, verticalRayLine,
  // verticalSegment, verticalStraightLine, rayLine, segment, straightLine,
  // priceLine, priceChannelLine, parallelStraightLine, simpleAnnotation,
  // simpleTag — no "rectangle"). Zone shading needs a small custom overlay
  // using the built-in 'polygon' FIGURE primitive, per the documented
  // registerOverlay/createPointFigures pattern.
  let zoneOverlayRegistered = false;
  function ensureZoneOverlayRegistered() {
    if (zoneOverlayRegistered || typeof klinecharts === 'undefined') return;
    try {
      klinecharts.registerOverlay({
        name: 'oixZoneBand',
        // Explicit — a 2-corner rectangle needs exactly 2 points before
        // it's considered "complete" and drawn. Left implicit, this has
        // been observed to leave the overlay stuck mid-draw and invisible.
        totalStep: 2,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        createPointFigures: ({ coordinates }) => {
          if (coordinates.length < 2) return [];
          const [p1, p2] = coordinates;
          return [{
            type: 'polygon',
            attrs: {
              coordinates: [
                { x: p1.x, y: p1.y },
                { x: p2.x, y: p1.y },
                { x: p2.x, y: p2.y },
                { x: p1.x, y: p2.y },
              ],
            },
            styles: { style: 'fill', color: 'rgba(40,215,200,0.07)' },
            ignoreEvent: true,
          }];
        },
      });
      zoneOverlayRegistered = true;
    } catch (err) {
      chartError('registerOverlay(oixZoneBand)', err);
    }
  }

  // Small "×N" badge drawn near the top of a shared display candle when 2+
  // alerts land on it — without this, N overlapping full-height vertical
  // lines at the exact same x are visually indistinguishable from 1, which
  // was the root cause of "the table has more alerts than the chart shows".
  let alertBadgeOverlayRegistered = false;
  function ensureAlertBadgeOverlayRegistered() {
    if (alertBadgeOverlayRegistered || typeof klinecharts === 'undefined') return;
    try {
      klinecharts.registerOverlay({
        name: 'oixAlertCountBadge',
        totalStep: 1,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        createPointFigures: ({ coordinates, overlay }) => {
          if (!coordinates.length) return [];
          const { x } = coordinates[0];
          const count = (overlay.extendData && overlay.extendData.count) || 0;
          const color = (overlay.extendData && overlay.extendData.color) || '#28d7c8';
          if (count < 2) return [];
          const y = 14;
          const r = 9;
          return [
            { type: 'circle', attrs: { x, y, r }, styles: { style: 'fill', color }, ignoreEvent: true },
            {
              type: 'text',
              attrs: { x, y, text: String(count), align: 'center', baseline: 'middle' },
              styles: { color: '#07060c', size: 10, family: undefined },
              ignoreEvent: true,
            },
          ];
        },
      });
      alertBadgeOverlayRegistered = true;
    } catch (err) {
      chartError('registerOverlay(oixAlertCountBadge)', err);
    }
  }

  /** Writes the permanent "Chart markers: X/Y mapped..." line near the chart. */
  function renderChartMarkerDiagnostic(reconciliation) {
    const el = document.getElementById('oix-chart-marker-diag');
    if (!el) return;
    el.innerHTML = formatChartMarkerDiagnosticLine(reconciliation);
  }

  // ── Binance native OI reference pane ─────────────────────────────────
  // EXTERNAL REFERENCE ONLY (see oi-exhaustion-binance-oi-source.js) — a
  // second pane of the SAME chart instance, not a second chart instance.
  // Sharing one instance means timeframe/zoom/pan/crosshair/scroll-to-
  // alert are synchronized with the price pane automatically (they share
  // one x-axis) — no hand-rolled cross-chart event wiring, and therefore
  // nothing that can drift out of sync or double-fire.
  const BINANCE_OI_PANE_ID = 'oix-binance-oi-pane';
  const BINANCE_OI_INDICATOR_NAME = 'OIX_BINANCE_OI_REF';
  let binanceOIIndicatorRegistered = false;
  function ensureBinanceOIIndicatorRegistered() {
    if (binanceOIIndicatorRegistered || typeof klinecharts === 'undefined') return;
    try {
      klinecharts.registerIndicator({
        name: BINANCE_OI_INDICATOR_NAME,
        shortName: 'Binance OI close w/ range',
        series: 'normal', // OI data, not price — uses the indicator's own precision, not the price pane's
        precision: 0,
        // close = prominent reference line; high/low = faint bounding
        // lines so an OHLC-aggregated bucket's range is still visible
        // even though this isn't a literal candle body (see chat notes —
        // true candle-body rendering inside a custom v9 indicator is
        // unverified API surface; this stays within confidently-known
        // figure primitives instead).
        figures: [
          { key: 'low', title: 'Low: ', type: 'line', styles: () => ({ style: 'dashed', color: 'rgba(154,161,171,0.5)', size: 1, dashedValue: [2, 2] }) },
          { key: 'high', title: 'High: ', type: 'line', styles: () => ({ style: 'dashed', color: 'rgba(154,161,171,0.5)', size: 1, dashedValue: [2, 2] }) },
          { key: 'close', title: 'OI: ', type: 'line', styles: () => ({ style: 'solid', color: '#f0b559', size: 1.5 }) },
        ],
        calc: (kLineDataList) => kLineDataList.map(d => {
          const ref = d.binanceOI;
          return {
            close: ref && ref.close != null ? ref.close : null,
            high: ref && ref.high != null ? ref.high : null,
            low: ref && ref.low != null ? ref.low : null,
          };
        }),
      });
      binanceOIIndicatorRegistered = true;
    } catch (err) {
      chartError('registerIndicator(OIX_BINANCE_OI_REF)', err);
    }
  }

  /** The "visible vs effective vs clamped" debug line — shown in every state (fetching/error/loaded) so range issues are visible even when a fetch fails. */
  function formatBinanceOIRangeDebugLine(b) {
    if (b.visibleStart == null || b.visibleEnd == null) return '';
    const visible = `${safeUtcDateString(b.visibleStart)} &rarr; ${safeUtcDateString(b.visibleEnd)}`;
    const effective = `${safeUtcDateString(b.effectiveStart)} &rarr; ${safeUtcDateString(b.effectiveEnd)}`;
    const clampedNote = b.wasClamped
      ? `<span style="color:var(--amber);">clamped — Binance only retains ~30 days</span>`
      : `<span style="color:var(--text-faint);">not clamped</span>`;
    return `<div style="color:var(--text-faint);margin-top:2px;">Visible analysis range: ${visible} &middot; ` +
      `Local target range (filter only — startTime is never sent to Binance): ${effective} &middot; ${clampedNote}</div>`;
  }

  function renderBinanceOIStatus() {
    const el = document.getElementById('oix-binance-oi-status');
    if (!el) return;
    const b = state.binanceOI;
    if (!b.enabled) { el.innerHTML = ''; return; }
    const debugLine = formatBinanceOIRangeDebugLine(b);
    if (b.fetching) { el.innerHTML = 'Fetching Binance native OI reference…' + debugLine; return; }
    if (b.error) { el.innerHTML = `<span style="color:var(--red);">Binance OI reference fetch failed: ${escapeHtml(b.error)}</span>` + debugLine; return; }
    if (!b.rawRows || !b.rawRows.length) { el.innerHTML = '<span style="color:var(--text-faint);">No Binance OI reference data loaded yet.</span>' + debugLine; return; }
    const cov = BinanceOISource.computeBinanceOICoverage(b.rawRows);
    el.innerHTML = `Binance OI reference: ${safeNumber(cov.barCount)} bars &middot; ` +
      `${safeUtcDateString(cov.startTime)} &rarr; ${safeUtcDateString(cov.endTime)} &middot; ` +
      `${safeNumber(cov.missingBars)} missing bars (no forward-fill — gaps are real)` + debugLine;
  }

  /** Fetches the Binance OI reference series for the currently loaded price range (capped to Binance's own ~30-day retention). External reference only — never touches state.lastRun, the IndexedDB cache, or anything scoring-related. */
  async function fetchBinanceOIReference() {
    const run = state.lastRun;
    if (!run || !run.binanceCandles.length) return;
    const b = state.binanceOI;
    b.fetching = true;
    b.error = null;
    renderBinanceOIStatus();
    try {
      // Derived ONLY from the visible analysis window (analysisStartTime/
      // analysisEndTime, stored on state.lastRun as exactly the
      // startTime/endTime the CryptoHFT/Binance candle fetch itself used)
      // — never from run.binanceCandles[0/length-1].ts, which can silently
      // include more history than the person actually requested, and
      // never from baseline/warmup/signalWindow buffers, which are purely
      // internal to scoring and have nothing to do with what's "visible".
      const range = computeBinanceOIReferenceRange(run.analysisStartTime, run.analysisEndTime);
      b.visibleStart = range.visibleStart;
      b.visibleEnd = range.visibleEnd;
      b.effectiveStart = range.effectiveStart;
      b.effectiveEnd = range.effectiveEnd;
      b.wasClamped = range.wasClamped;

      const rows = await BinanceOISource.fetchBinanceOpenInterestHist({ startTime: range.effectiveStart, endTime: range.effectiveEnd });
      b.rawRows = rows;
      b.rangeStart = range.effectiveStart;
      b.rangeEnd = range.effectiveEnd;
    } catch (err) {
      b.error = err.message || String(err);
      console.error('[Binance OI reference] fetch failed:', err);
    } finally {
      b.fetching = false;
      renderBinanceOIStatus();
      applyChartData();
    }
  }

  /**
   * Console diagnostic: runs the isolated 4-combination request test
   * (no params / startTime only / endTime only / both) against Binance's
   * REAL openInterestHist endpoint, using the actual current visible
   * analysis range (or an explicit override). Prints each attempt's URL,
   * status, and response body to the console and returns the results.
   *
   * Console usage: OIExhaustionRender.probeBinanceOI()
   */
  async function probeBinanceOI(overrideStart, overrideEnd) {
    const run = state.lastRun;
    let startTime = overrideStart, endTime = overrideEnd;
    if (startTime == null || endTime == null) {
      if (!run) { console.warn('No analysis run yet — run analysis first, or call probeBinanceOI(startTimeMs, endTimeMs) explicitly.'); return; }
      const range = computeBinanceOIReferenceRange(run.analysisStartTime, run.analysisEndTime);
      startTime = range.effectiveStart;
      endTime = range.effectiveEnd;
    }
    console.log(`probeBinanceOI — testing symbol=BTCUSDT period=15m limit=500 against startTime=${startTime} (${safeUtcDateString(startTime)}), endTime=${endTime} (${safeUtcDateString(endTime)})`);
    return BinanceOISource.probeOpenInterestHistParams({ startTime, endTime });
  }

  /** Toggles the Binance OI reference pane on/off. Purely visual — never touches strategy state. */
  async function toggleBinanceOIReference() {
    const b = state.binanceOI;
    b.enabled = !b.enabled;
    if (b.enabled && !b.rawRows && !b.fetching) {
      await fetchBinanceOIReference();
    } else {
      applyChartData();
    }
    renderBinanceOIStatus();
  }

  function applyChartData() {
    const chart = state.chart.instance;
    const run = state.lastRun;
    if (!chart || !run || !run.binanceCandles.length) return;

    try {
      const timeframe = state.chart.timeframe;
      let displayCandles = resampleCandlesForDisplay(run.binanceCandles, timeframe);
      if (!displayCandles.length) return;
      const displayIndex = buildDisplayCandleIndex(displayCandles);
      // Stashed for wireChartTooltip's hit-testing, which needs the same
      // alert -> displayed-candle mapping used here for overlay placement.
      state.chart.displayIndex = displayIndex;

      // Binance OI reference — attached onto the SAME candle objects the
      // chart receives (see mergeBinanceOIOntoDisplayCandles), purely so
      // the reference-pane indicator (below) can read it from the exact
      // series already loaded, which is what keeps the two panes in sync
      // for free. Attaching a null-filled field when disabled/unavailable
      // is harmless — the indicator simply draws nothing for those points.
      const binanceOIState = state.binanceOI;
      if (binanceOIState.enabled && binanceOIState.rawRows && binanceOIState.rawRows.length) {
        const binanceOISeries = BinanceOISource.buildBinanceOIDisplaySeries(binanceOIState.rawRows, timeframe);
        displayCandles = mergeBinanceOIOntoDisplayCandles(displayCandles, binanceOISeries, timeframe);
      }

      chart.applyNewData(displayCandles);

      if (binanceOIState.enabled) {
        ensureBinanceOIIndicatorRegistered();
        try {
          const existing = chart.getIndicatorByPaneId ? chart.getIndicatorByPaneId(BINANCE_OI_PANE_ID) : null;
          const hasIndicator = existing && (Array.isArray(existing) ? existing.length > 0 : Object.keys(existing).length > 0);
          if (!hasIndicator) {
            chart.createIndicator({ name: BINANCE_OI_INDICATOR_NAME, id: BINANCE_OI_INDICATOR_NAME }, false, { id: BINANCE_OI_PANE_ID, height: 140 });
          } else {
            chart.overrideIndicator({ name: BINANCE_OI_INDICATOR_NAME, id: BINANCE_OI_INDICATOR_NAME }, BINANCE_OI_PANE_ID);
          }
        } catch (err) {
          chartError('createIndicator(OIX_BINANCE_OI_REF)', err);
        }
      } else {
        try { chart.removeIndicator(BINANCE_OI_PANE_ID); } catch (err) { /* pane may not exist yet — non-fatal */ }
      }

      // #9: unconditional full clear before redrawing — every rerun/
      // timeframe switch fully replaces prior overlays, no stale/partial
      // marker state can survive between calls.
      chart.removeOverlay();
      ensureZoneOverlayRegistered();
      ensureAlertBadgeOverlayRegistered();

      const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));
      zones.forEach(z => {
        createOverlaySafely(chart, { name: 'oixZoneBand', lock: true }, [
          { timestamp: displayCandles[0].timestamp, value: z.top },
          { timestamp: displayCandles[displayCandles.length - 1].timestamp, value: z.bottom },
        ]);
      });

      const reconciliation = reconcileChartMarkers(run.result.alerts, run.binanceCandles, displayCandles, timeframe);
      // Stashed for wireChartTooltip and focusChartOnAlert — both need the
      // same per-display-candle grouping used to draw the markers, so
      // hovering/clicking finds ALL alerts sharing a candle, not just one.
      state.chart.markerGroups = reconciliation.groups;

      reconciliation.groups.forEach(group => {
        // Representative alert for the shared full-height line's color and
        // price anchor — arbitrary choice (first by time) when grouped;
        // each constituent alert's own raw timestamp/price is preserved
        // untouched in group.alerts for the tooltip.
        const rep = group.alerts[0];
        // Exhaustion causes (V1/V2) keep their EXACT prior coloring —
        // contextDirection-based (up-move vs down-move over the 12h
        // window), unchanged by this feature. Only the two new
        // directional-impulse causes get their own distinct colors
        // (CAUSE_STYLES) — they have no contextDirection at all.
        const isExhaustionCause = rep.cause === 'V1_EXHAUSTION' || rep.cause === 'V2_EXHAUSTION';
        const color = isExhaustionCause
          ? (rep.contextDirection === 'bearish-exhaustion' ? '#e2645f' : '#3ddc97') // up-move-oi-expansion : down-move-oi-expansion
          : ((CAUSE_STYLES[rep.cause] && CAUSE_STYLES[rep.cause].color) || '#8a8f98');
        // verticalStraightLine (not verticalRayLine — a ray needs 2 points
        // to define its direction; we only ever have one) — spans the full
        // chart height at this single timestamp, needs just 1 point.
        createOverlaySafely(chart, {
          name: 'verticalStraightLine',
          lock: true,
          styles: { line: { color, style: 'dashed', size: 1.4, dashedValue: [4, 3] } },
          extendData: rep,
        }, [{ timestamp: group.timestamp, value: rep.price }]);

        // Mirror the same marker onto the Binance OI reference pane, at
        // the same shared x-axis position, so alignment between the
        // CryptoHFT-based alert and Binance's own OI is visible without
        // needing to cross-reference the two panes manually.
        if (binanceOIState.enabled) {
          createOverlaySafely(chart, {
            name: 'verticalStraightLine',
            lock: true,
            styles: { line: { color, style: 'dashed', size: 1.4, dashedValue: [4, 3] } },
            extendData: rep,
          }, [{ timestamp: group.timestamp, value: rep.price }], BINANCE_OI_PANE_ID);
        }

        if (group.alerts.length > 1) {
          createOverlaySafely(chart, {
            name: 'oixAlertCountBadge',
            lock: true,
            extendData: { count: group.alerts.length, color },
          }, [{ timestamp: group.timestamp, value: rep.price }]);
        }
      });

      renderChartMarkerDiagnostic(reconciliation);
    } catch (err) {
      chartError('applyChartData', err);
    }
  }

  function setChartTimeframe(tf) {
    if (!CHART_BUCKET_MS[tf]) return;
    state.chart.timeframe = tf;
    document.querySelectorAll('.oix-tf-btn').forEach(b => {
      const active = b.getAttribute('data-tf') === tf;
      b.style.background = active ? 'var(--teal)' : 'transparent';
      b.style.color = active ? '#07060c' : 'var(--text)';
    });
    // Full dispose + recreate rather than applyNewData on the live
    // instance — switching to a dataset of very different size (e.g. 1H's
    // ~720 candles to 15m's ~2880) was observed to silently fail to
    // re-render on the existing instance (no error, chart just keeps
    // showing the previous timeframe). A clean reinit is the same code
    // path that already renders correctly on first load.
    initChart();
  }

  /** Full detail grid for a single alert — unchanged from before, factored out for reuse by both the hover tooltip and the group tooltip. */
  function renderAlertDetailHtml(a) {
    if (a.cause === 'DOWNSIDE_OI_CHASE' || a.cause === 'UPSIDE_OI_CHASE') {
      return `<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;">
        <span style="color:var(--text-faint);">Date</span><span>${new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ')}</span>
        <span style="color:var(--text-faint);">Cause</span><span>${causeBadgeHtml(a.cause)}</span>
        <span style="color:var(--text-faint);">Price</span><span>$${safeNumber(a.price, { maximumFractionDigits: 0 })}</span>
        <span style="color:var(--text-faint);">Impulse window</span><span>${escapeHtml(a.impulseWindow || '—')}</span>
        <span style="color:var(--text-faint);">Price return</span><span style="color:${a.priceReturnPct != null ? (a.priceReturnPct >= 0 ? 'var(--green)' : 'var(--red)') : 'inherit'};">${a.priceReturnPct != null ? (a.priceReturnPct >= 0 ? '+' : '') + a.priceReturnPct.toFixed(2) + '%' : '—'}</span>
        <span style="color:var(--text-faint);">Price percentile</span><span>${a.pricePercentile != null ? a.pricePercentile.toFixed(1) : '—'}</span>
        <span style="color:var(--text-faint);">OI return</span><span>${a.oiReturnPct != null ? '+' + a.oiReturnPct.toFixed(2) + '%' : '—'}</span>
        <span style="color:var(--text-faint);">OI percentile</span><span>${a.oiPercentile != null ? a.oiPercentile.toFixed(1) : '—'}</span>
        <span style="color:var(--text-faint);">Raw OI increase</span><span>${a.rawOiIncreasePct != null ? a.rawOiIncreasePct.toFixed(2) + '%' : '—'}</span>
        <span style="color:var(--text-faint);">Zone</span><span>${escapeHtml(a.zoneBounds.label || a.zoneId)}</span>
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:0.5px solid var(--line-old);font-size:10.5px;color:var(--text-faint);line-height:1.5;">
        Aggressive late positioning during a fast move — not a directional call by itself. Continuation, a later sweep/reversal, or no trade at all are all possible depending on HTF location and price reaction.
      </div>`;
    }
    return `<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;">
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
  }

  /**
   * Tooltip content for a display-candle group. A single alert gets the
   * full detail grid unchanged (the common case, same as before this
   * fix). 2+ alerts sharing a candle get a compact per-alert summary list
   * instead — each row keeps that alert's own raw timestamp and price
   * (never the shared display-candle's), so nothing about an individual
   * alert is lost just because it's grouped with others.
   */
  function renderAlertGroupTooltipHtml(group) {
    if (group.alerts.length === 1) return renderAlertDetailHtml(group.alerts[0]);
    const rows = group.alerts.map(a => `
      <div style="display:grid;grid-template-columns:auto auto 1fr;gap:8px;align-items:center;padding:4px 0;border-bottom:0.5px solid var(--line-old);">
        <span style="color:var(--text-faint);">${new Date(a.timestamp).toISOString().slice(11, 16)}</span>
        ${causeBadgeHtml(a.cause)}
        <span>$${safeNumber(a.price, { maximumFractionDigits: 0 })} &middot; ${escapeHtml(a.zoneBounds.label || a.zoneId)}</span>
      </div>`).join('');
    return `<div style="font-size:11px;min-width:220px;">
      <div style="font-weight:600;color:var(--text);margin-bottom:6px;">${group.alerts.length} alerts in this candle</div>
      ${rows}
    </div>`;
  }

  function wireChartTooltip(chart) {
    const wrap = document.getElementById('oix-price-chart-wrap');
    const tooltip = document.getElementById('oix-chart-tooltip');
    if (!wrap || !tooltip) return;

    wrap.onmousemove = (e) => {
      const groups = state.chart.markerGroups;
      if (!groups || !groups.length) { tooltip.style.display = 'none'; return; }
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      let nearest = null, nearestDist = Infinity;
      try {
        for (const group of groups) {
          // Hit-test against the displayed candle's timestamp (matches
          // where the overlay was actually drawn), not any individual
          // alert's raw 15m timestamp — those diverge at 1H/4H/1D. The
          // tooltip TEXT itself still reports each alert's real raw
          // timestamp/price (see renderAlertGroupTooltipHtml).
          const px = chart.convertToPixel({ timestamp: group.timestamp }, { absolute: false });
          if (!px || px.x == null) continue;
          const dist = Math.abs(mx - px.x);
          if (dist < 8 && dist < nearestDist) { nearest = group; nearestDist = dist; }
        }
      } catch (err) {
        tooltip.style.display = 'none';
        return;
      }
      if (!nearest) { tooltip.style.display = 'none'; return; }

      tooltip.innerHTML = renderAlertGroupTooltipHtml(nearest);
      tooltip.style.display = 'block';
      const tx = mx + 12 > rect.width - 200 ? mx - 195 : mx + 12;
      tooltip.style.left = tx + 'px';
      tooltip.style.top = (my - 10) + 'px';
    };
    wrap.onmouseleave = () => { tooltip.style.display = 'none'; };
  }

  // ── Help tooltip ("?") system — browser wiring ───────────────────────────
  // nextHelpTooltipState (pure/testable) lives in the shared section above.
  let helpTooltipOpenId = null;

  function closeAllHelpTooltips() {
    document.querySelectorAll('.oix-help.oix-help-open').forEach(el => el.classList.remove('oix-help-open'));
    helpTooltipOpenId = null;
  }

  /** Keeps the popover from overflowing off-screen on narrow viewports by nudging it, not resizing it. */
  function positionHelpPopover(iconEl) {
    const pop = iconEl.querySelector('.oix-help-pop');
    if (!pop) return;
    pop.style.transform = 'translateX(-50%)';
    const rect = pop.getBoundingClientRect();
    const margin = 8;
    if (rect.left < margin) {
      pop.style.transform = `translateX(calc(-50% + ${(margin - rect.left).toFixed(1)}px))`;
    } else if (rect.right > window.innerWidth - margin) {
      pop.style.transform = `translateX(calc(-50% - ${(rect.right - (window.innerWidth - margin)).toFixed(1)}px))`;
    }
  }

  function toggleHelpTooltip(id) {
    const next = nextHelpTooltipState(helpTooltipOpenId, id);
    closeAllHelpTooltips();
    if (next) {
      const el = document.getElementById(next);
      if (el) {
        el.classList.add('oix-help-open');
        positionHelpPopover(el);
        helpTooltipOpenId = next;
      }
    }
  }

  function focusChartOnAlert(alertIdx) {
    const run = state.lastRun;
    const chart = state.chart.instance;
    if (!run || !chart) return;
    const alert = run.result.alerts[alertIdx];
    if (!alert) return;
    try {
      // At 1H/4H/1D the raw 15m alert timestamp doesn't land on a displayed
      // candle boundary — scroll to the containing displayed candle instead.
      const timeframe = state.chart.timeframe;
      const bucketTs = getUtcBucketStart(alert.timestamp, timeframe);
      chart.scrollToTimestamp(bucketTs, 300);

      // #10: also open the marker's own tooltip/detail once the scroll
      // settles, so clicking a table row visibly connects to its chart
      // marker rather than just moving the viewport. Reuses the exact
      // same group lookup/rendering the hover tooltip uses.
      setTimeout(() => {
        const groups = state.chart.markerGroups || [];
        const group = groups.find(g => g.timestamp === bucketTs);
        const wrap = document.getElementById('oix-price-chart-wrap');
        const tooltip = document.getElementById('oix-chart-tooltip');
        if (!group || !wrap || !tooltip) return;
        try {
          const px = chart.convertToPixel({ timestamp: bucketTs }, { absolute: false });
          if (!px || px.x == null) return;
          const rect = wrap.getBoundingClientRect();
          tooltip.innerHTML = renderAlertGroupTooltipHtml(group);
          tooltip.style.display = 'block';
          const tx = px.x + 12 > rect.width - 200 ? px.x - 195 : px.x + 12;
          tooltip.style.left = tx + 'px';
          tooltip.style.top = '20px';
          // No mouse is hovering to naturally dismiss it via onmouseleave,
          // so auto-hide after a few seconds.
          clearTimeout(state.chart.focusTooltipHideTimer);
          state.chart.focusTooltipHideTimer = setTimeout(() => { tooltip.style.display = 'none'; }, 4000);
        } catch (err) { /* non-fatal — the scroll itself already succeeded */ }
      }, 320);
    } catch (err) {
      chartError('focusChartOnAlert', err);
    }
  }

  // ── Public API + init ────────────────────────────────────────────────

  function init() {
    loadSettings();
    loadZones();
    renderSettingsForm();
    renderZoneEditor();
    renderStaleBanner();
    updateRawDataPackControls();
    setStatus('Not yet run. Configure zones/parameters above, then Fetch data &amp; run analysis.');

    // Help tooltip system: click outside any "?" icon, or Escape, closes
    // whichever one is open. Registered once here rather than per-icon.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.oix-help')) closeAllHelpTooltips();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllHelpTooltips();
    });
  }

  function updateRawDataPackControls() {
    const exportBtn = document.getElementById('oix-export-data-pack-btn');
    const runImportedBtn = document.getElementById('oix-run-imported-pack-btn');
    const importStatus = document.getElementById('oix-import-data-pack-status');
    if (exportBtn) exportBtn.disabled = !state.rawDataCache;
    if (runImportedBtn) runImportedBtn.disabled = !state.importedDataPack;
    if (importStatus) {
      if (state.importedDataPack) {
        importStatus.textContent = `Imported pack ready: ${safeUtcDateString(state.importedDataPack.startTime)} → ${safeUtcDateString(state.importedDataPack.endTime)}. Run it without fetching.`;
        importStatus.style.color = 'var(--teal)';
      } else {
        importStatus.textContent = 'Export a completed run once, then import that file later to rerun it without downloading CryptoHFT data.';
        importStatus.style.color = 'var(--text-faint)';
      }
    }
  }

  function exportRawDataPack() {
    try {
      if (!state.rawDataCache) throw new Error('Run an analysis first. There is no loaded raw dataset to export yet.');
      const pack = createRawDataPack(state.rawDataCache);
      const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = rawDataPackFilename(state.rawDataCache);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`<span style="color:var(--teal);">Raw-data pack exported.</span> It contains the loaded BTCUSDT 15m price + CryptoHFT aggregate OI only — no API key or raw exchange files.`);
    } catch (err) {
      setStatus(`<span style="color:var(--red);">Export failed:</span> ${escapeHtml(err && err.message ? err.message : String(err))}`);
    }
  }

  function chooseRawDataPackFile() {
    const input = document.getElementById('oix-import-data-pack-file');
    if (input) input.click();
  }

  async function importRawDataPackFile(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
      if (file.size > RAW_DATA_PACK_MAX_BYTES) throw new Error('Imported data pack is too large.');
      const parsed = parseRawDataPack(await file.text());
      state.importedDataPack = parsed;
      updateRawDataPackControls();
      setStatus(`<span style="color:var(--teal);">Imported raw-data pack.</span> Click “Run imported data” to analyse it without fetching CryptoHFT data.`);
    } catch (err) {
      state.importedDataPack = null;
      updateRawDataPackControls();
      setStatus(`<span style="color:var(--red);">Import failed:</span> ${escapeHtml(err && err.message ? err.message : String(err))}`);
    } finally {
      if (input) input.value = '';
    }
  }

  function runImportedData() {
    if (!state.importedDataPack) {
      setStatus('<span style="color:var(--amber);">No imported data pack is selected.</span>');
      return Promise.resolve();
    }
    return runAnalysis({ rawDataOverride: state.importedDataPack });
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

    // Directional-impulse — always evaluated in this diagnostic regardless
    // of whether the feature is enabled in Settings, so this tool can
    // answer "would it have qualified" even with the feature off.
    const directionalImpulseWindow = Engine.IMPULSE_WINDOW_CANDLES[overrides.directionalImpulseWindow] ? overrides.directionalImpulseWindow : s.directionalImpulseWindow;
    const directionalImpulseWindowCandles = Engine.IMPULSE_WINDOW_CANDLES[directionalImpulseWindow];
    const directionalPriceEntryPercentile = overrides.directionalPriceEntryPercentile != null ? overrides.directionalPriceEntryPercentile : s.directionalPriceEntryPercentile;
    const directionalOiEntryPercentile = overrides.directionalOiEntryPercentile != null ? overrides.directionalOiEntryPercentile : s.directionalOiEntryPercentile;
    const directionalImpulseRearmPercentile = overrides.directionalImpulseRearmPercentile != null ? overrides.directionalImpulseRearmPercentile : s.directionalImpulseRearmPercentile;
    const directionalMinRawOiIncreasePct = overrides.directionalMinRawOiIncreasePct != null ? overrides.directionalMinRawOiIncreasePct : s.directionalMinRawOiIncreasePct;

    const targetTimestamps = isoTimestamps.map(str => new Date(str).getTime());
    console.log(`Params: alertModel=${alertModel} entryPercentile=${entryPercentile} rearmPercentile=${rearmPercentile} ` +
      `minBaselineSamples=${minBaselineSamples} baselineLookbackCandles=${baselineLookbackCandles} ` +
      `oiRecencyFilterEnabled=${oiRecencyFilterEnabled} oiRecencyWindow=${oiRecencyWindow} minimumRecentOIChangePct=${minimumRecentOIChangePct}`);
    console.log(`Directional-impulse params (evaluated regardless of the Settings toggle): window=${directionalImpulseWindow} ` +
      `priceEntryPercentile=${directionalPriceEntryPercentile} oiEntryPercentile=${directionalOiEntryPercentile} ` +
      `rearmPercentile=${directionalImpulseRearmPercentile} minRawOiIncreasePct=${directionalMinRawOiIncreasePct}%`);
    console.log(`Target timestamps: ${targetTimestamps.map(t => new Date(t).toISOString()).join(', ')}`);
    console.log(`Using cached raw data window: ${safeUtcDateString(cache.startTime)} → ${safeUtcDateString(cache.endTime)} (fetched ${safeUtcDateString(cache.cachedAt)})`);
    console.log('');

    const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));
    const { timestamps, closes, ois, validFlags } = Backtest.alignCandlesAndOI(cache.binanceCandles, cache.oiRows);
    const series = Engine.computeExhaustionSeries(timestamps, closes, ois, { validFlags });

    const targetSet = new Set(targetTimestamps);
    const baseline = Engine.createBaselineLog({ baselineLookbackCandles });
    const zoneStates = new Map(zones.map(z => [z.id, false]));

    // Directional-impulse causal state, tracked alongside the V1/V2 loop
    // below — same two independent baselines and per-zone/per-direction
    // armed state the real backtest uses (oi-exhaustion-backtest.js).
    const priceImpulseBaseline = Engine.createBaselineLog({ baselineLookbackCandles });
    const oiImpulseBaseline = Engine.createBaselineLog({ baselineLookbackCandles });
    const directionalZoneStates = new Map(zones.map(z => [z.id, { upsideArmed: false, downsideArmed: false }]));

    let anyMatched = false;

    for (let t = 0; t < series.length; t++) {
      const entry = series[t];
      const ts = timestamps[t];
      const price = closes[t];
      const isTarget = targetSet.has(ts);

      // ── Directional-impulse: independent of V1/V2 entry.valid, same as
      // the real backtest loop. Computed every candle so its baselines/
      // armed-state stay causally correct even when this candle isn't a
      // requested target.
      const impulseGapFree = Engine.isImpulseWindowGapFree(validFlags, t, directionalImpulseWindowCandles);
      let diPriceReturnPct = null, diOiReturnPct = null;
      if (impulseGapFree) {
        diPriceReturnPct = Engine.computeChangeOverCandles(closes, t, directionalImpulseWindowCandles);
        diOiReturnPct = Engine.computeChangeOverCandles(ois, t, directionalImpulseWindowCandles);
      }
      const directionalWarmingUp = priceImpulseBaseline.size() < minBaselineSamples || oiImpulseBaseline.size() < minBaselineSamples;
      let diPricePercentile = null, diOiPercentile = null;
      if (impulseGapFree && !directionalWarmingUp) {
        if (diPriceReturnPct !== null) diPricePercentile = priceImpulseBaseline.percentileRank(Math.abs(diPriceReturnPct));
        if (diOiReturnPct !== null && diOiReturnPct > 0) diOiPercentile = oiImpulseBaseline.percentileRank(diOiReturnPct);
      }
      const diEval = (impulseGapFree && !directionalWarmingUp)
        ? Engine.evaluateDirectionalImpulse(diPriceReturnPct, diPricePercentile, diOiReturnPct, diOiPercentile, {
            priceEntryPercentile: directionalPriceEntryPercentile, oiEntryPercentile: directionalOiEntryPercentile, minRawOiIncreasePct: directionalMinRawOiIncreasePct,
          })
        : { qualifies: false, cause: null, direction: null, failReasons: [impulseGapFree ? 'baseline_warming_up' : 'impulse_window_gap_or_insufficient_history'] };

      const diPerZoneSnapshots = [];
      for (const zone of zones) {
        const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
        const zState = directionalZoneStates.get(zone.id);
        const downQualifies = diEval.qualifies && diEval.cause === Engine.ALERT_CAUSE_DOWNSIDE_OI_CHASE;
        const upQualifies = diEval.qualifies && diEval.cause === Engine.ALERT_CAUSE_UPSIDE_OI_CHASE;
        const downStep = Engine.stepDirectionalImpulseState(zState.downsideArmed, inZone, downQualifies, diPricePercentile, diOiPercentile, { rearmPercentile: directionalImpulseRearmPercentile });
        const upStep = Engine.stepDirectionalImpulseState(zState.upsideArmed, inZone, upQualifies, diPricePercentile, diOiPercentile, { rearmPercentile: directionalImpulseRearmPercentile });
        zState.downsideArmed = downStep.armed;
        zState.upsideArmed = upStep.armed;
        diPerZoneSnapshots.push({ zone, inZone, downsideArmed: downStep.armed, downsideFired: downStep.alertFired, upsideArmed: upStep.armed, upsideFired: upStep.alertFired });
      }
      if (impulseGapFree) {
        if (diPriceReturnPct !== null) priceImpulseBaseline.insert(Math.abs(diPriceReturnPct));
        if (diOiReturnPct !== null && diOiReturnPct > 0) oiImpulseBaseline.insert(diOiReturnPct);
      }
      const directionalCtx = {
        impulseWindow: directionalImpulseWindow, priceReturnPct: diPriceReturnPct, oiReturnPct: diOiReturnPct,
        pricePercentile: diPricePercentile, oiPercentile: diOiPercentile, warmingUp: directionalWarmingUp,
        gapFree: impulseGapFree, evalResult: diEval, perZoneSnapshots: diPerZoneSnapshots,
        priceEntryPercentile: directionalPriceEntryPercentile, oiEntryPercentile: directionalOiEntryPercentile,
      };

      if (!entry.valid) {
        for (const zone of zones) {
          const inZone = Engine.isPriceInZone(price, zone) && Engine.isZoneTemporallyActive(zone, ts);
          if (!inZone) zoneStates.set(zone.id, false);
        }
        if (isTarget) { anyMatched = true; diagnoseAlertPrint(ts, price, null, zones, { invalidWindow: true, directional: directionalCtx }); }
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
          directional: directionalCtx,
        });
      }
    }

    if (!anyMatched) {
      console.warn('None of the requested timestamps matched an exact 15m candle in the cached data — check the ISO strings are on a 15-minute boundary and within the cached window shown above.');
    }
  }

  function diagnoseAlertPrint(ts, price, entry, zones, ctx) {
    const f = diagnoseAlertFmt;
    console.log('════════════════════════════════════════════════════════');
    console.log(`Timestamp: ${new Date(ts).toISOString()}`);
    console.log(`Price: ${price != null ? price : 'n/a'}`);

    if (ctx.invalidWindow || !entry) {
      console.log('Window invalid at this candle (gap/missing data) — no V1/V2 score computed.');
      console.log('Final rejection reason (V1/V2): INVALID_WINDOW (signal window not fully valid here)');
      if (ctx.directional) diagnoseDirectionalPrint(ctx.directional);
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

    console.log(`[V1/V2] Score > 0 passed:        ${scorePassed}`);
    console.log(`[V1/V2] Percentile >= ${ctx.entryPercentile} passed: ${percentilePassed}`);
    console.log(`[V1/V2] OI recency filter passed: ${ctx.oiRecencyFilterEnabled ? recencyPassed : 'n/a (filter disabled)'}`);
    console.log('');

    for (const snap of ctx.perZoneSnapshots) {
      console.log(`[V1/V2] Zone "${snap.zone.label || snap.zone.id}": inZone=${snap.inZone} prevArmed=${snap.prevArmed} -> armed=${snap.armed} alertFired=${snap.alertFired}`);
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
    if (ctx.directional) diagnoseDirectionalPrint(ctx.directional);
    console.log('════════════════════════════════════════════════════════\n');
  }

  /** The directional-impulse half of the candle-inspection view — "why did/didn't this candle qualify as a fast directional OI build". */
  function diagnoseDirectionalPrint(d) {
    const f = diagnoseAlertFmt;
    console.log('');
    console.log(`[Directional] Impulse window: ${d.impulseWindow}  Gap-free: ${d.gapFree}  Baseline warming up: ${d.warmingUp}`);
    console.log(`[Directional] Price return over window: ${f(d.priceReturnPct, 3)}%  (direction: ${d.evalResult.direction || 'n/a'})`);
    console.log(`[Directional] Price percentile (vs abs-return baseline): ${f(d.pricePercentile, 2)}  (need >= ${d.priceEntryPercentile})`);
    console.log(`[Directional] OI return over window: ${f(d.oiReturnPct, 3)}%`);
    console.log(`[Directional] OI percentile (vs positive-only baseline): ${d.oiPercentile != null ? f(d.oiPercentile, 2) : 'n/a (OI not positive, or not enough positive history yet)'}  (need >= ${d.oiEntryPercentile})`);
    console.log(`[Directional] Qualifies: ${d.evalResult.qualifies}  Cause: ${d.evalResult.cause || 'none'}`);
    if (!d.evalResult.qualifies) {
      console.log(`[Directional] Failed condition(s): ${d.evalResult.failReasons.join(', ')}`);
    }
    for (const snap of d.perZoneSnapshots) {
      console.log(`[Directional] Zone "${snap.zone.label || snap.zone.id}": inZone=${snap.inZone} ` +
        `downsideArmed=${snap.downsideArmed} downsideFired=${snap.downsideFired} ` +
        `upsideArmed=${snap.upsideArmed} upsideFired=${snap.upsideFired}`);
    }
  }

  /**
   * Reruns the currently cached raw data through the directional-impulse
   * feature at all three window settings (15m/1h/2h), using every other
   * current Settings value unchanged, so downside/upside chase counts can
   * be compared side by side on REAL data — this is what actually answers
   * "is the 15m / raw-OI-floor setting too strict or too noisy," rather
   * than a one-off single-window run.
   *
   * Console usage: OIExhaustionRender.compareDirectionalImpulseWindows()
   */
  function compareDirectionalImpulseWindows() {
    const cache = state.rawDataCache;
    if (!cache) {
      console.warn('No raw data cached yet — click "Fetch data & run analysis" at least once first.');
      return;
    }
    const s = state.settings;
    const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));
    const rows = [];
    for (const w of Engine.IMPULSE_WINDOWS) {
      const result = Backtest.runEventStudy(cache.binanceCandles, cache.oiRows, zones, {
        entryPercentile: s.entryPercentile, rearmPercentile: s.rearmPercentile,
        minBaselineSamples: s.minBaselineSamples, baselineLookbackCandles: s.baselineLookbackCandles,
        signalWindow: s.signalWindow, alertModel: s.alertModel,
        directionalImpulseEnabled: true,
        directionalImpulseWindow: w,
        directionalPriceEntryPercentile: s.directionalPriceEntryPercentile,
        directionalOiEntryPercentile: s.directionalOiEntryPercentile,
        directionalImpulseRearmPercentile: s.directionalImpulseRearmPercentile,
        directionalMinRawOiIncreasePct: s.directionalMinRawOiIncreasePct,
      });
      const di = result.meta.directionalImpulse;
      rows.push({
        window: w,
        downsideChaseCount: di.downsideChaseCount,
        upsideChaseCount: di.upsideChaseCount,
        totalChaseCount: di.downsideChaseCount + di.upsideChaseCount,
        priceBaselineSize: di.priceBaselineSize,
        oiBaselineSize: di.oiBaselineSize,
      });
    }
    console.log(`compareDirectionalImpulseWindows — priceEntry=${s.directionalPriceEntryPercentile} oiEntry=${s.directionalOiEntryPercentile} ` +
      `rearm=${s.directionalImpulseRearmPercentile} minRawOiIncreasePct=${s.directionalMinRawOiIncreasePct}% ` +
      `(cached range: ${safeUtcDateString(cache.startTime)} → ${safeUtcDateString(cache.endTime)})`);
    console.table(rows);
    return rows;
  }

  Object.assign(OIExhaustionRender, {
    init, runAnalysis, refreshRawData, exportRawDataPack, chooseRawDataPackFile, importRawDataPackFile, runImportedData, diagnoseAlert, dumpRawOI, directionalOiShock, directionalOiImpulse, compareDirectionalImpulseWindows, addZoneRow, removeZone, updateZoneField, readSettingsFromForm,
    focusChartOnAlert,
    setChartTimeframe,
    toggleHelpTooltip,
    closeAllHelpTooltips,
    toggleBinanceOIReference,
    probeBinanceOI,
    fetchBybitOI, fetchBybitCandles, fetchBinanceCandles, // exposed for console debugging
  });

  window.OIExhaustionRender = OIExhaustionRender;

})(typeof window !== 'undefined' ? window : globalThis);

/**
 * oi-exhaustion-cryptohft-source.js
 * Candidate aggregate source — inert. Target basket: Binance Futures,
 * Bybit, OKX, Bitget BTC perpetuals.
 *
 * THIS FILE IS FULLY INERT AS OF THIS MILESTONE:
 *  - Not imported by render.js or any other file.
 *  - No network fetching implemented yet (see header notes below for the
 *    verified API contract this will eventually use).
 *  - Does not touch V1, V2, Bybit fetching, the UI, or the backtest.
 *
 * ── Verified CryptoHFTData API contract (for the future fetcher) ─────────
 * Dataset: https://www.cryptohftdata.com/datasets/crypto-open-interest-data
 * Download: https://api.cryptohftdata.com/download?file={path}&api_key=KEY
 * Data format: hourly-named Parquet/Zstd files (NOT JSON) — a future fetcher
 * will need a parquet reader, not a simple fetch+json() call.
 * Object path: {exchange}/{YYYY-MM-DD}/{HH}/{symbol}_open_interest.parquet.zst
 *   e.g. binance_futures/2026-06-25/12/BTCUSDT_open_interest.parquet.zst
 *        bybit/2026-06-25/12/BTCUSDT_open_interest.parquet.zst
 *        okx_futures/2026-06-25/12/BTC-USDT-SWAP_open_interest.parquet.zst
 *        bitget_futures/2026-06-25/12/BTCUSDT_open_interest.parquet.zst
 *
 * RESOLVED (was a TODO): the `/HH/` path segment's real coverage window
 * varies BY VENUE — confirmed via real measurement, not assumption.
 * binance_futures files do contain a wide (~42.5h) overlapping window and
 * tolerate sparse (multi-hour-step) fetching fine. bybit and okx_futures do
 * NOT share that behavior: a real 14-day, 3-venue coverage run at an 8-hour
 * fetch step produced only 12.3% complete 3-venue 15m buckets, with
 * "bybit+okx_futures missing" as 100% of the incomplete reasons. A targeted
 * retest of bybit alone at a 1-hour fetch step reached 96.9% coverage for
 * a single day. The live fetcher (oi-exhaustion-render.js) now defaults
 * hourStepHours to 1 because of this — do not widen it without re-measuring
 * bybit/okx_futures specifically, not just binance_futures.
 *
 * Row schema — CORRECTED based on inspecting one real downloaded file,
 * which contradicted the originally-provided docs (see below). This is
 * the `rawSnapshots` shape bucketAndAggregateOI consumes:
 *   {
 *     exchange: string,                   // 'binance_futures' | 'bybit' | 'okx_futures' | 'bitget_futures'
 *                                          // NOT present in the parquet rows themselves — the future
 *                                          // fetch/decode layer must inject this from the requested
 *                                          // object path, since the row data has no exchange field at all.
 *     timestamp: string|number,           // exchange snapshot time, UNIX MILLISECONDS.
 *                                          // Verified against a real file: a 13-digit value like
 *                                          // 1782239100000 decodes to a sane 2026 UTC date at face
 *                                          // value, with NO division needed. The original doc said
 *                                          // "nanoseconds" — that was wrong for this field. Aggregation
 *                                          // uses ONLY this field.
 *     received_time: string|number|bigint,// provider receive time, UNIX NANOSECONDS (this part of the
 *                                          // original doc WAS correct — verified as a 19-digit value in
 *                                          // the real file). NOT used in aggregation, and must never be
 *                                          // used as a substitute for `timestamp` — kept only for a
 *                                          // possible future, separately-documented fallback policy.
 *     symbol: string,
 *     sum_open_interest: string,          // raw contracts — NEVER read by this module
 *     sum_open_interest_value: string,    // quote-notional OI — the only OI field used
 *   }
 *
 * Snapshot cadence varies by venue and is NOT expected to align across
 * exchanges — bucketAndAggregateOI buckets by time window rather than
 * requiring matching raw timestamps, per the provider's own guidance.
 */
'use strict';

(function (root) {

  const DEFAULT_BUCKET_MS = 15 * 60 * 1000; // 15 minutes
  // Canonical 3-venue aggregate basket (fixed, not dynamic). bitget_futures
  // is excluded — confirmed via real downloaded files across 3 different
  // dates (April-June 2026) that its sum_open_interest_value is null in
  // 100% of rows. This default matches the live basket in
  // oi-exhaustion-render.js; both must stay in sync if this changes again.
  const DEFAULT_REQUIRED_VENUES = ['binance_futures', 'bybit', 'okx_futures'];

  /**
   * Parses the exchange `timestamp` field — verified (via a real downloaded
   * file) to already be UNIX MILLISECONDS, not nanoseconds. No division is
   * performed. A 13-digit value like "1782239100000" is preserved exactly.
   * Accepts a numeric string or a plain Number; returns a finite Number of
   * milliseconds, or null for anything unparseable.
   *
   * This is the ONLY timestamp parser bucketAndAggregateOI uses for its
   * bucket-key math — it must never receive `received_time`.
   */
  function parseMsTimestamp(ts) {
    if (ts === null || ts === undefined) return null;
    if (typeof ts === 'string') {
      const trimmed = ts.trim();
      if (!/^\d+$/.test(trimmed)) return null; // plain integer strings only — no scientific notation, no decimals, no sign
      const n = Number(trimmed);
      return isFinite(n) ? n : null;
    }
    if (typeof ts === 'number') {
      return isFinite(ts) ? ts : null;
    }
    if (typeof ts === 'bigint') {
      // Verified against a real decoded CryptoHFTData file: hyparquet returns
      // parquet INT64 columns (which `timestamp` is) as native JS BigInt, not
      // a string or Number. Converting via Number() is exact/safe here —
      // millisecond-epoch values are always well within Number.MAX_SAFE_INTEGER
      // (~9.007e15), unlike the nanosecond `received_time` field, which needs
      // the BigInt-preserving math in nsToMs() instead.
      const n = Number(ts);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Converts a NANOSECOND epoch timestamp (string, number, or bigint) to a
   * millisecond epoch Number, using BigInt arithmetic when the input is a
   * string or bigint to avoid precision loss (ns-epoch values for 2026
   * exceed Number.MAX_SAFE_INTEGER, ~9.007e15).
   *
   * Reserved for a possible future, SEPARATELY DOCUMENTED fallback policy
   * around `received_time`. NOT used anywhere in bucketAndAggregateOI today,
   * and must never be applied to the exchange `timestamp` field — that
   * field is milliseconds already (see parseMsTimestamp above), and this
   * function would silently produce a wrong, far-too-small value if run
   * against it.
   */
  function nsToMs(ts) {
    if (ts === null || ts === undefined) return null;
    try {
      if (typeof ts === 'bigint') {
        return Number(ts / 1000000n);
      }
      if (typeof ts === 'string') {
        const trimmed = ts.trim();
        if (!/^\d+$/.test(trimmed)) return null; // only plain integer strings — no scientific notation, no decimals
        return Number(BigInt(trimmed) / 1000000n);
      }
      if (typeof ts === 'number') {
        if (!isFinite(ts)) return null;
        return Math.floor(ts / 1000000);
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /** Parses sum_open_interest_value (a string) into a finite Number, or null. */
  function parseOiValue(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return isFinite(n) ? n : null;
  }

  /**
   * Buckets raw multi-venue OI snapshots into fixed-width time buckets and
   * sums each venue's LATEST sum_open_interest_value within each bucket.
   *
   * Rules (all per explicit spec, no deviation):
   *  - bucketKey = floor(snapshotMs / bucketMs) * bucketMs
   *  - per (venue, bucket): the snapshot with the latest exchange
   *    `timestamp` wins — not received_time, not array order.
   *  - a bucket is emitted ONLY if every venue in `requiredVenues` has at
   *    least one valid snapshot in it. Missing even one venue omits the
   *    bucket entirely — no forward-fill, no partial sum, no zero
   *    substitution for the missing venue.
   *  - only `sum_open_interest_value` is ever read; `sum_open_interest`
   *    (raw contracts) is never touched, even if present on the row.
   *
   * @param {Array<object>} rawSnapshots
   * @param {number} [bucketMs] defaults to 15 minutes
   * @param {string[]} [requiredVenues] defaults to the 4-venue basket
   * @returns {Array<{ts:number, oi:number}>} ascending by ts — same shape
   *   `alignCandlesAndOI` already consumes from fetchBybitOI.
   */
  function bucketAndAggregateOI(rawSnapshots, bucketMs, requiredVenues) {
    const bucket = bucketMs != null ? bucketMs : DEFAULT_BUCKET_MS;
    const venues = requiredVenues != null ? requiredVenues : DEFAULT_REQUIRED_VENUES;

    if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) return [];

    // latestByVenueBucket: Map<bucketKey, Map<venue, {tsMs, oiValue}>>
    const latestByVenueBucket = new Map();

    for (const row of rawSnapshots) {
      if (!row || typeof row !== 'object') continue;
      if (venues.indexOf(row.exchange) === -1) continue; // ignore venues outside the required basket entirely

      // Aggregation uses ONLY the exchange `timestamp` field (milliseconds,
      // parsed as-is — see parseMsTimestamp). `received_time` is never
      // read here, per explicit policy.
      const tsMs = parseMsTimestamp(row.timestamp);
      if (tsMs === null) continue;
      const oiValue = parseOiValue(row.sum_open_interest_value); // NEVER row.sum_open_interest
      if (oiValue === null) continue;

      const bucketKey = Math.floor(tsMs / bucket) * bucket;

      if (!latestByVenueBucket.has(bucketKey)) latestByVenueBucket.set(bucketKey, new Map());
      const venueMap = latestByVenueBucket.get(bucketKey);

      const existing = venueMap.get(row.exchange);
      if (!existing || tsMs >= existing.tsMs) {
        venueMap.set(row.exchange, { tsMs, oiValue });
      }
    }

    const out = [];
    for (const [bucketKey, venueMap] of latestByVenueBucket) {
      let complete = true;
      let sum = 0;
      for (const v of venues) {
        const entry = venueMap.get(v);
        if (!entry) { complete = false; break; }
        sum += entry.oiValue;
      }
      if (!complete) continue; // omit incomplete buckets entirely — no partial aggregate
      out.push({ ts: bucketKey, oi: sum });
    }

    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /**
   * Diagnostic-only companion to bucketAndAggregateOI: reports how many
   * distinct time buckets were SEEN in the raw data at all, vs how many
   * were actually complete (all required venues present) and thus emitted.
   * Does not change bucketAndAggregateOI's own output contract — purely
   * for UI/status reporting ("N valid buckets, M incomplete excluded").
   *
   * @returns {{totalBucketsSeen:number, completeBuckets:number, incompleteBuckets:number, venuesSeen:string[]}}
   */
  function summarizeBucketCoverage(rawSnapshots, bucketMs, requiredVenues) {
    const bucket = bucketMs != null ? bucketMs : DEFAULT_BUCKET_MS;
    const venues = requiredVenues != null ? requiredVenues : DEFAULT_REQUIRED_VENUES;

    if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) {
      return { totalBucketsSeen: 0, completeBuckets: 0, incompleteBuckets: 0, venuesSeen: [] };
    }

    const bucketVenues = new Map(); // bucketKey -> Set<venue>
    const venuesSeenSet = new Set();

    for (const row of rawSnapshots) {
      if (!row || typeof row !== 'object') continue;
      if (venues.indexOf(row.exchange) === -1) continue;
      const tsMs = parseMsTimestamp(row.timestamp);
      if (tsMs === null) continue;
      const oiValue = parseOiValue(row.sum_open_interest_value);
      if (oiValue === null) continue;

      venuesSeenSet.add(row.exchange);
      const bucketKey = Math.floor(tsMs / bucket) * bucket;
      if (!bucketVenues.has(bucketKey)) bucketVenues.set(bucketKey, new Set());
      bucketVenues.get(bucketKey).add(row.exchange);
    }

    let completeBuckets = 0;
    for (const venueSet of bucketVenues.values()) {
      if (venues.every(v => venueSet.has(v))) completeBuckets++;
    }

    return {
      totalBucketsSeen: bucketVenues.size,
      completeBuckets,
      incompleteBuckets: bucketVenues.size - completeBuckets,
      venuesSeen: Array.from(venuesSeenSet),
    };
  }

  const OIExhaustionCryptoHFTSource = {
    DEFAULT_BUCKET_MS,
    DEFAULT_REQUIRED_VENUES,
    parseMsTimestamp,
    nsToMs,
    parseOiValue,
    bucketAndAggregateOI,
    summarizeBucketCoverage,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionCryptoHFTSource;
  } else {
    root.OIExhaustionCryptoHFTSource = OIExhaustionCryptoHFTSource;
  }

})(typeof window !== 'undefined' ? window : globalThis);

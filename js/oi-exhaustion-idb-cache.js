/**
 * oi-exhaustion-idb-cache.js
 * Persistent (IndexedDB) cache for the OI Exhaustion module's raw dataset —
 * the CryptoHFT 3-venue aggregate OI + Binance 15m candles pull that takes
 * 30+ minutes cold. Lets a 90-day pull be a one-time cost: incremental
 * per-venue writes mean a crash/reload mid-fetch resumes instead of
 * restarting, and a completed dataset reruns instantly with new parameters.
 *
 * Reconstructed from the call-site contract in oi-exhaustion-render.js
 * (buildCacheKey / getCacheEntry / putCacheEntry / deleteCacheEntry /
 * isCacheEntryComplete / completedVenues / makeEmptyEntry) — the original
 * implementation was never committed. render.js already treats every call
 * here as fallible (try/catch, non-fatal) and degrades to always-fetch if
 * `IdbCache` never loads at all, so this module fails safe by design: any
 * error here just costs the persistence benefit, never breaks a run.
 *
 * Entry shape stored per cache key:
 *   {
 *     key, lookbackDays, startTime, endTime,
 *     perVenueOI: { [venue]: Array<{ts, oi}> },  // filled in incrementally
 *     binanceCandles: Array<candle>,
 *     aggregateOI: Array<{ts, oi}>,               // only set once complete
 *     coverage: object|null,                      // only set once complete
 *     status: 'pending' | 'complete',
 *     updatedAt: number (ms),
 *   }
 */
(function (root) {
  'use strict';

  const DB_NAME = 'oix-cache';
  const DB_VERSION = 1;
  const STORE_NAME = 'datasets';

  // ── Pure logic (no IndexedDB) — exported for Node tests ────────────────

  /**
   * Deterministic cache key for a given fetch configuration. Venues are
   * sorted so key order never matters; changing venues, bucket width, or
   * lookback window all correctly invalidate the old cache entry (a
   * differently-shaped dataset should never be silently reused).
   */
  function buildCacheKey(params) {
    const p = params || {};
    const venues = Array.isArray(p.venues) ? p.venues.slice().sort() : [];
    const bucketMs = p.bucketMs != null ? p.bucketMs : 'na';
    const lookbackDays = p.lookbackDays != null ? p.lookbackDays : 'na';
    return `oix_v1_${venues.join('-')}_${bucketMs}_${lookbackDays}`;
  }

  /** Fresh, empty entry for a new (not-yet-fetched) dataset. */
  function makeEmptyEntry(key, fields) {
    const f = fields || {};
    return {
      key: key,
      lookbackDays: f.lookbackDays != null ? f.lookbackDays : null,
      startTime: f.startTime != null ? f.startTime : null,
      endTime: f.endTime != null ? f.endTime : null,
      perVenueOI: {},
      binanceCandles: [],
      aggregateOI: [],
      coverage: null,
      status: 'pending',
      updatedAt: Date.now(),
    };
  }

  /** Which of `requiredVenues` already have a non-empty bucketed series in this entry. */
  function completedVenues(entry, requiredVenues) {
    const venues = Array.isArray(requiredVenues) ? requiredVenues : [];
    if (!entry || !entry.perVenueOI || typeof entry.perVenueOI !== 'object') return [];
    return venues.filter(v => Array.isArray(entry.perVenueOI[v]) && entry.perVenueOI[v].length > 0);
  }

  /**
   * True only if the entry is fully usable as-is: explicitly marked
   * complete, has a non-empty final aggregate + candle series, AND every
   * required venue's per-venue series is present (belt-and-suspenders in
   * case a `status` field is ever stale relative to the actual data).
   */
  function isCacheEntryComplete(entry, requiredVenues) {
    if (!entry) return false;
    if (entry.status !== 'complete') return false;
    if (!Array.isArray(entry.aggregateOI) || entry.aggregateOI.length === 0) return false;
    if (!Array.isArray(entry.binanceCandles) || entry.binanceCandles.length === 0) return false;
    const venues = Array.isArray(requiredVenues) ? requiredVenues : [];
    return completedVenues(entry, venues).length === venues.length;
  }

  // ── IndexedDB-backed persistence ────────────────────────────────────────
  // Real browser storage, wrapped in Promises. Every method takes an
  // optional `options.indexedDBImpl` override — used only by tests, via a
  // fake implementing the same async event-based surface — and otherwise
  // defaults to the global `indexedDB`. Callers already wrap every call in
  // try/catch and treat failures as non-fatal, so these intentionally throw
  // / reject on failure rather than swallowing errors themselves.

  function getIndexedDBImpl(options) {
    const impl = (options && options.indexedDBImpl) || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!impl) throw new Error('IndexedDB is not available in this environment.');
    return impl;
  }

  function openDb(options) {
    const idb = getIndexedDBImpl(options);
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = idb.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed.')); };
    });
  }

  /** Reads one entry by cache key. Resolves `null` if not found (never rejects for a plain miss). */
  async function getCacheEntry(key, options) {
    const db = await openDb(options);
    return new Promise((resolve, reject) => {
      let tx, store, req;
      try {
        tx = db.transaction(STORE_NAME, 'readonly');
        store = tx.objectStore(STORE_NAME);
        req = store.get(key);
      } catch (err) {
        reject(err);
        return;
      }
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB get failed.')); };
    });
  }

  /** Upserts an entry (keyed by `entry.key`), stamping `updatedAt`. Resolves the stored entry. */
  async function putCacheEntry(entry, options) {
    if (!entry || typeof entry.key !== 'string' || !entry.key) {
      throw new Error('putCacheEntry requires an entry with a non-empty string `key`.');
    }
    entry.updatedAt = Date.now();
    const db = await openDb(options);
    return new Promise((resolve, reject) => {
      let tx, store, req;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
        store = tx.objectStore(STORE_NAME);
        req = store.put(entry);
      } catch (err) {
        reject(err);
        return;
      }
      req.onsuccess = function () { resolve(entry); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB put failed.')); };
    });
  }

  /** Deletes an entry by cache key. Resolves even if the key didn't exist. */
  async function deleteCacheEntry(key, options) {
    const db = await openDb(options);
    return new Promise((resolve, reject) => {
      let tx, store, req;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
        store = tx.objectStore(STORE_NAME);
        req = store.delete(key);
      } catch (err) {
        reject(err);
        return;
      }
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB delete failed.')); };
    });
  }

  const OIExhaustionIdbCache = {
    DB_NAME,
    DB_VERSION,
    STORE_NAME,
    buildCacheKey,
    makeEmptyEntry,
    completedVenues,
    isCacheEntryComplete,
    getCacheEntry,
    putCacheEntry,
    deleteCacheEntry,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionIdbCache;
  } else {
    root.OIExhaustionIdbCache = OIExhaustionIdbCache;
  }

})(typeof window !== 'undefined' ? window : globalThis);

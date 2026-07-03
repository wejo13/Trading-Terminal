// oi-exhaustion-idb-cache.test.js — pure logic + a fake IndexedDB
// implementing the real async event-based surface (open/onupgradeneeded,
// transaction/objectStore/get/put/delete with onsuccess/onerror), so the
// actual persistence methods get exercised, not just the pure helpers.
'use strict';

const IdbCache = require('./oi-exhaustion-idb-cache.js');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

const VENUES = ['binance_futures', 'bybit', 'okx_futures'];

// ── Fake IndexedDB ──────────────────────────────────────────────────────
// Minimal in-memory stand-in for the subset of the real IndexedDB API this
// module actually uses. Async behavior (callbacks fired on a later tick)
// is preserved so this exercises the same Promise-wrapping code paths the
// real browser API would.
function makeFakeIndexedDB() {
  const stores = new Map(); // dbName -> Map<storeName, Map<key, value>>

  function fakeRequest() {
    const req = { onsuccess: null, onerror: null, result: undefined, error: undefined };
    return req;
  }
  function resolveSoon(req, result) {
    req.result = result;
    setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
  }
  function rejectSoon(req, err) {
    req.error = err;
    setTimeout(() => { if (req.onerror) req.onerror(); }, 0);
  }

  return {
    _stores: stores,
    open(name, version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
      setTimeout(() => {
        if (!stores.has(name)) stores.set(name, new Map());
        const dbStores = stores.get(name);
        const db = {
          objectStoreNames: { contains: n => dbStores.has(n) },
          createObjectStore(storeName, opts) {
            dbStores.set(storeName, { keyPath: opts && opts.keyPath, data: new Map() });
            return { name: storeName };
          },
          transaction(storeName, mode) {
            const storeRecord = dbStores.get(storeName);
            return {
              objectStore() {
                return {
                  get(key) {
                    const r = fakeRequest();
                    resolveSoon(r, storeRecord.data.get(key));
                    return r;
                  },
                  put(value) {
                    const r = fakeRequest();
                    const k = value[storeRecord.keyPath];
                    storeRecord.data.set(k, value);
                    resolveSoon(r, k);
                    return r;
                  },
                  delete(key) {
                    const r = fakeRequest();
                    storeRecord.data.delete(key);
                    resolveSoon(r, undefined);
                    return r;
                  },
                };
              },
            };
          },
        };
        req.result = db;
        if (!dbStores.has('datasets') && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

// ── Pure logic ───────────────────────────────────────────────────────────

section('buildCacheKey: deterministic, order-independent on venues, changes with params');
(function () {
  const a = IdbCache.buildCacheKey({ venues: ['okx_futures', 'bybit', 'binance_futures'], bucketMs: 900000, lookbackDays: 90 });
  const b = IdbCache.buildCacheKey({ venues: ['binance_futures', 'bybit', 'okx_futures'], bucketMs: 900000, lookbackDays: 90 });
  const c = IdbCache.buildCacheKey({ venues: VENUES, bucketMs: 900000, lookbackDays: 5 });
  assert('venue order does not affect the key', a === b);
  assert('different lookbackDays produces a different key', a !== c);
})();

section('makeEmptyEntry: correct shape and defaults');
(function () {
  const entry = IdbCache.makeEmptyEntry('mykey', { lookbackDays: 5, startTime: 100, endTime: 200 });
  assert('key set', entry.key === 'mykey');
  assert('lookbackDays set', entry.lookbackDays === 5);
  assert('perVenueOI starts empty object', typeof entry.perVenueOI === 'object' && Object.keys(entry.perVenueOI).length === 0);
  assert('binanceCandles starts empty array', Array.isArray(entry.binanceCandles) && entry.binanceCandles.length === 0);
  assert('aggregateOI starts empty array', Array.isArray(entry.aggregateOI) && entry.aggregateOI.length === 0);
  assert('coverage starts null', entry.coverage === null);
  assert('status starts pending', entry.status === 'pending');
})();

section('completedVenues: reports only venues with non-empty bucketed series');
(function () {
  const entry = IdbCache.makeEmptyEntry('k', {});
  entry.perVenueOI = { binance_futures: [{ ts: 0, oi: 1 }], bybit: [], okx_futures: [{ ts: 0, oi: 1 }] };
  const done = IdbCache.completedVenues(entry, VENUES);
  assert('binance_futures counted', done.indexOf('binance_futures') !== -1);
  assert('okx_futures counted', done.indexOf('okx_futures') !== -1);
  assert('bybit (empty array) not counted', done.indexOf('bybit') === -1);
  assert('exactly 2 done', done.length === 2);
})();

section('completedVenues: empty/garbage input never throws');
(function () {
  assert('null entry -> []', IdbCache.completedVenues(null, VENUES).length === 0);
  assert('entry with no perVenueOI -> []', IdbCache.completedVenues({}, VENUES).length === 0);
})();

section('isCacheEntryComplete: requires status=complete, non-empty aggregate/candles, all venues done');
(function () {
  const complete = {
    status: 'complete',
    aggregateOI: [{ ts: 0, oi: 100 }],
    binanceCandles: [{ ts: 0 }],
    perVenueOI: { binance_futures: [{ ts: 0, oi: 1 }], bybit: [{ ts: 0, oi: 1 }], okx_futures: [{ ts: 0, oi: 1 }] },
  };
  assert('fully complete entry -> true', IdbCache.isCacheEntryComplete(complete, VENUES) === true);

  const pendingStatus = Object.assign({}, complete, { status: 'pending' });
  assert('status pending -> false', IdbCache.isCacheEntryComplete(pendingStatus, VENUES) === false);

  const emptyAgg = Object.assign({}, complete, { aggregateOI: [] });
  assert('empty aggregateOI -> false', IdbCache.isCacheEntryComplete(emptyAgg, VENUES) === false);

  const missingVenue = Object.assign({}, complete, { perVenueOI: { binance_futures: [{ ts: 0, oi: 1 }], bybit: [{ ts: 0, oi: 1 }] } });
  assert('missing a required venue -> false', IdbCache.isCacheEntryComplete(missingVenue, VENUES) === false);

  assert('null entry -> false', IdbCache.isCacheEntryComplete(null, VENUES) === false);
})();

// ── IndexedDB-backed persistence (against the fake) ─────────────────────

(async function () {
  section('getCacheEntry: miss returns null, no throw');
  {
    const fakeIdb = makeFakeIndexedDB();
    const result = await IdbCache.getCacheEntry('nope', { indexedDBImpl: fakeIdb });
    assert('missing key -> null', result === null);
  }

  section('putCacheEntry + getCacheEntry: round-trips the full entry, stamps updatedAt');
  {
    const fakeIdb = makeFakeIndexedDB();
    const key = IdbCache.buildCacheKey({ venues: VENUES, bucketMs: 900000, lookbackDays: 5 });
    const entry = IdbCache.makeEmptyEntry(key, { lookbackDays: 5, startTime: 1000, endTime: 2000 });
    entry.perVenueOI.bybit = [{ ts: 0, oi: 42 }];

    const before = Date.now();
    const stored = await IdbCache.putCacheEntry(entry, { indexedDBImpl: fakeIdb });
    assert('put resolves the entry', stored.key === key);
    assert('put stamps updatedAt', typeof stored.updatedAt === 'number' && stored.updatedAt >= before);

    const fetched = await IdbCache.getCacheEntry(key, { indexedDBImpl: fakeIdb });
    assert('round-tripped entry has correct key', fetched.key === key);
    assert('round-tripped entry preserves nested data', fetched.perVenueOI.bybit[0].oi === 42);
  }

  section('putCacheEntry: rejects an entry with no key');
  {
    const fakeIdb = makeFakeIndexedDB();
    let threw = false;
    try { await IdbCache.putCacheEntry({}, { indexedDBImpl: fakeIdb }); } catch (e) { threw = true; }
    assert('missing key rejects', threw);
  }

  section('deleteCacheEntry: removes an entry; safe on a non-existent key');
  {
    const fakeIdb = makeFakeIndexedDB();
    const key = 'del-me';
    await IdbCache.putCacheEntry(IdbCache.makeEmptyEntry(key, {}), { indexedDBImpl: fakeIdb });
    await IdbCache.deleteCacheEntry(key, { indexedDBImpl: fakeIdb });
    const afterDelete = await IdbCache.getCacheEntry(key, { indexedDBImpl: fakeIdb });
    assert('entry gone after delete', afterDelete === null);

    let threw = false;
    try { await IdbCache.deleteCacheEntry('never-existed', { indexedDBImpl: fakeIdb }); } catch (e) { threw = true; }
    assert('deleting a non-existent key does not throw', !threw);
  }

  section('getCacheEntry: throws when no IndexedDB implementation is available');
  {
    let threw = false;
    try { await IdbCache.getCacheEntry('k', { indexedDBImpl: null }); } catch (e) { threw = true; }
    assert('no impl -> rejects rather than hanging', threw);
  }

  console.log('\n────────────────────────────────────────');
  console.log('oi-exhaustion-idb-cache: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();

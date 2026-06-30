/**
 * sp500-data-source.js
 * Frontend data-source boundary for the S&P 500 Watchlist.
 *
 * Strategy:
 *   1. getSnapshot()  — sync, always returns fixture data immediately.
 *   2. fetchLive(cb)  — async, fetches real prices from the Worker,
 *                       merges them into the watchlist rows, then calls cb(snapshot).
 *                       Falls back silently to fixture on any error.
 *
 * Per-row provenance: every watchlist row gets a `priceSource` field —
 * 'live' when the Worker returned a quote for that ticker, 'fixture' otherwise.
 * The snapshot-level `mode` reflects TRUTHFUL coverage, not an all-or-nothing flag:
 *   'live'    — every row has priceSource:'live'
 *   'partial' — some rows live, some fixture
 *   'demo'    — fetch failed / no usable payload, all rows fixture
 *
 * 20D/200D trend, distances, Status, and Note are NEVER touched here —
 * those remain fixture-derived regardless of price provenance.
 */
(function () {
  'use strict';

  var WORKER_URL = 'https://royal-darkness-0ac6.wimneys.workers.dev/api/sp500-prices';
  var FETCH_TIMEOUT_MS = 8000;

  // ── sync fixture snapshot ──────────────────────────────────────────────────

  function getSnapshot() {
    var valuation = (typeof SP500_VALUATION !== 'undefined') ? SP500_VALUATION : null;
    var watchlist  = (typeof SP500_WATCHLIST !== 'undefined') ? SP500_WATCHLIST : [];
    var taggedWatchlist = watchlist.map(function (row) {
      return Object.assign({}, row, { priceSource: 'fixture' });
    });
    return {
      valuation: valuation,
      watchlist:  taggedWatchlist,
      mode:       'demo',
      asOf:       'Demo fixture — no live data yet',
      provider:   'Fixture',
      isLive:     false,
      liveCount:  0,
      totalCount: taggedWatchlist.length,
    };
  }

  // ── merge live rows into fixture watchlist, tagging provenance ─────────────
  // Only overwrites price and dayChg; preserves all other fixture fields
  // (sector, dist20d, dist200d, status, note — all stay fixture-derived).

  function _mergeRows(fixtureRows, liveRows) {
    var liveMap = {};
    for (var i = 0; i < liveRows.length; i++) {
      liveMap[liveRows[i].ticker] = liveRows[i];
    }
    return fixtureRows.map(function (row) {
      var live = liveMap[row.ticker];
      if (!live) {
        return Object.assign({}, row, { priceSource: 'fixture' });
      }
      return Object.assign({}, row, {
        price:       live.price,
        dayChg:      live.dayChg,
        priceSource: 'live',
      });
    });
  }

  // ── async live fetch ──────────────────────────────────────────────────────

  function fetchLive(callback) {
    if (typeof fetch === 'undefined') return; // non-browser env

    var done = false;
    var timer = setTimeout(function () {
      if (!done) { done = true; /* timeout — stay on fixture */ }
    }, FETCH_TIMEOUT_MS);

    fetch(WORKER_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (done) return;
        done = true;
        clearTimeout(timer);

        if (!data || !Array.isArray(data.rows) || data.rows.length === 0) {
          throw new Error('Empty payload');
        }

        var fixture = getSnapshot();
        var merged  = _mergeRows(fixture.watchlist, data.rows);

        var liveCount  = merged.filter(function (r) { return r.priceSource === 'live'; }).length;
        var totalCount = merged.length;
        var mode = (liveCount === 0) ? 'demo' : (liveCount === totalCount) ? 'live' : 'partial';

        var snapshot = {
          valuation:  fixture.valuation,
          watchlist:  merged,
          mode:       mode,
          asOf:       data.asOf || new Date().toISOString(),
          provider:   data.provider || 'Twelve Data',
          isLive:     mode === 'live',
          liveCount:  liveCount,
          totalCount: totalCount,
        };
        if (typeof callback === 'function') callback(snapshot);
      })
      .catch(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Silently stay on fixture — no error thrown to caller
      });
  }

  var SP500DataSource = {
    getSnapshot: getSnapshot,
    fetchLive:   fetchLive,
    WORKER_URL:  WORKER_URL,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SP500DataSource;
  } else {
    window.SP500DataSource = SP500DataSource;
  }
}());

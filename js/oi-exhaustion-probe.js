/**
 * oi-exhaustion-probe.js
 * Browser-side coverage probe for Bybit BTCUSDT linear 5-minute open interest.
 *
 * Purpose: reliable evidence only — how far back 5min OI history reaches via the
 * existing public browser -> Bybit path, whether pagination is complete/gap-free,
 * and whether it's usable as the future event-study baseline. No scoring, no UI,
 * no alert logic.
 *
 * Transport: reuses the exact pattern already proven live in ema-engine.js's
 * fetchOIDelta() — unauthenticated GET to api.bybit.com's public open-interest
 * endpoint, called directly from the browser. This file never reads
 * bybit_api_key, bybit_api_secret, or localStorage in any form — those only
 * apply to the unrelated signed grid-bot endpoints in grid-bybit.js.
 *
 * Independent of ema-engine.js and backtest.js — no shared state, no imports
 * from either.
 *
 * Manual invocation only (browser console):
 *   runOICoverageProbe().then(r => console.log(r.reportText))
 *   runOICoverageProbe({ days: 7 }).then(r => console.table(r.report.pagination.pageSummaries))
 */
'use strict';

(function (root) {

  // ── Config ─────────────────────────────────────────────────────────────

  var DEFAULTS = {
    baseUrl: 'https://api.bybit.com/v5/market/open-interest',
    category: 'linear',
    symbol: 'BTCUSDT',
    intervalTime: '5min',
    intervalMs: 5 * 60 * 1000,
    days: 30,
    pageLimit: 200,        // Bybit's documented max per call
    maxPages: 60,          // safety cap: 30d * 288/day / 200 ≈ 43.2, + margin
    requestDelayMs: 250,
    maxRetriesPerPage: 3,
    retryBackoffMs: 1000,
  };

  // ── Pure helpers (identical contract to the standalone Node probe.js,
  //    transport-agnostic — dual-exported below for Node test reuse) ──────

  function parseRow(rawRow) {
    if (!rawRow || typeof rawRow !== 'object') return null;
    var ts = parseInt(rawRow.timestamp, 10);
    var oi = parseFloat(rawRow.openInterest);
    if (!isFinite(ts) || !isFinite(oi)) return null;
    return { ts: ts, oi: oi };
  }

  function mergeDedupe(pagesOfRows) {
    var byTs = new Map();
    var duplicateCount = 0;
    pagesOfRows.forEach(function (rows) {
      rows.forEach(function (row) {
        if (!row) return;
        if (byTs.has(row.ts)) { duplicateCount++; return; }
        byTs.set(row.ts, row);
      });
    });
    var rows = Array.from(byTs.values()).sort(function (a, b) { return a.ts - b.ts; });
    return { rows: rows, duplicateCount: duplicateCount };
  }

  function detectGaps(rows, intervalMs) {
    var gaps = [];
    for (var i = 1; i < rows.length; i++) {
      var delta = rows[i].ts - rows[i - 1].ts;
      if (delta > intervalMs) {
        var missingIntervals = Math.round(delta / intervalMs) - 1;
        if (missingIntervals > 0) {
          gaps.push({ fromTs: rows[i - 1].ts, toTs: rows[i].ts, missingIntervals: missingIntervals });
        }
      }
    }
    return gaps;
  }

  function computeExpectedIntervals(startTime, endTime, intervalMs) {
    return Math.floor((endTime - startTime) / intervalMs);
  }

  function detectStagnation(pageSummaries, requestedStartTime) {
    if (pageSummaries.length === 0) {
      return { stagnant: true, reason: 'no_pages_returned', evidence: [] };
    }
    var earliestSeen = Math.min.apply(null, pageSummaries.map(function (p) { return p.returnedEarliestTs; }));
    var requestedRangeHonored = earliestSeen <= requestedStartTime + 24 * 3600 * 1000; // 1 day slack

    var noProgressPages = 0;
    for (var i = 1; i < pageSummaries.length; i++) {
      var prev = pageSummaries[i - 1], cur = pageSummaries[i];
      var cursorChanged = prev.nextCursor !== cur.cursorUsed || prev.cursorUsed !== cur.cursorUsed;
      var earliestDidNotDecrease = cur.returnedEarliestTs >= prev.returnedEarliestTs;
      if (cursorChanged && earliestDidNotDecrease) noProgressPages++;
    }

    var stagnant = !requestedRangeHonored && noProgressPages >= 2;
    return {
      stagnant: stagnant,
      requestedRangeHonored: requestedRangeHonored,
      earliestTimestampAchieved: earliestSeen,
      noProgressPageCount: noProgressPages,
      reason: stagnant
        ? 'earliest_timestamp_did_not_regress_despite_pagination'
        : (requestedRangeHonored ? 'requested_range_appears_honored' : 'inconclusive'),
    };
  }

  // ── Browser transport — same shape as fetchOIDelta, generalized with
  //    startTime/endTime/cursor. No auth headers, no signing, no credentials. ──

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  async function fetchPage(cfg, startTime, endTime, cursor) {
    var params = new URLSearchParams({
      category: cfg.category,
      symbol: cfg.symbol,
      intervalTime: cfg.intervalTime,
      limit: String(cfg.pageLimit),
      startTime: String(startTime),
      endTime: String(endTime),
    });
    if (cursor) params.set('cursor', cursor);
    var url = cfg.baseUrl + '?' + params.toString();

    var lastErr = null;
    for (var attempt = 1; attempt <= cfg.maxRetriesPerPage; attempt++) {
      try {
        var res = await fetch(url); // unauthenticated public GET — no headers added
        var json = null;
        try { json = await res.json(); } catch (parseErr) { /* leave json null */ }
        return { url: url, httpStatus: res.status, ok: res.ok, json: json };
      } catch (err) {
        lastErr = err;
        if (attempt < cfg.maxRetriesPerPage) await sleep(cfg.retryBackoffMs * attempt);
      }
    }
    return { url: url, httpStatus: null, ok: false, json: null, fetchError: String(lastErr) };
  }

  async function runOICoverageProbe(opts) {
    var cfg = Object.assign({}, DEFAULTS, opts || {});
    var endTime = Date.now();
    var startTime = endTime - cfg.days * 24 * 3600 * 1000;

    var pageSummaries = [];
    var pagesOfParsedRows = [];
    var cursor;
    var pageIndex = 0;
    var hardStop = false, hardStopReason = null;

    while (pageIndex < cfg.maxPages && !hardStop) {
      var page = await fetchPage(cfg, startTime, endTime, cursor);

      if (!page.ok || !page.json) {
        hardStop = true;
        hardStopReason = page.fetchError
          ? 'fetch_error: ' + page.fetchError
          : 'http_' + page.httpStatus + '_or_unparseable_body';
        break;
      }
      if (page.json.retCode !== 0) {
        hardStop = true;
        hardStopReason = 'bybit_retCode_' + page.json.retCode + ': ' + page.json.retMsg;
        break;
      }

      var list = (page.json.result && page.json.result.list) || [];
      var parsedRows = list.map(parseRow).filter(Boolean);
      pagesOfParsedRows.push(parsedRows);

      var tsList = parsedRows.map(function (r) { return r.ts; });
      var returnedEarliestTs = tsList.length ? Math.min.apply(null, tsList) : null;
      var returnedLatestTs = tsList.length ? Math.max.apply(null, tsList) : null;
      var nextCursor = (page.json.result && page.json.result.nextPageCursor) || null;

      pageSummaries.push({
        pageIndex: pageIndex,
        cursorUsed: cursor || null,
        nextCursor: nextCursor,
        rowCount: parsedRows.length,
        returnedEarliestTs: returnedEarliestTs,
        returnedLatestTs: returnedLatestTs,
      });

      pageIndex++;
      if (!nextCursor || parsedRows.length === 0) break;
      cursor = nextCursor;
      await sleep(cfg.requestDelayMs);
    }

    var merged = mergeDedupe(pagesOfParsedRows);
    var rows = merged.rows, duplicateCount = merged.duplicateCount;
    var gaps = detectGaps(rows, cfg.intervalMs);
    var expectedIntervals = computeExpectedIntervals(startTime, endTime, cfg.intervalMs);
    var missingCount = Math.max(0, expectedIntervals - rows.length);
    var coveragePct = expectedIntervals > 0 ? (rows.length / expectedIntervals) * 100 : 0;
    var stagnation = detectStagnation(pageSummaries, startTime);

    var verdict;
    if (hardStop) {
      verdict = 'INCONCLUSIVE';
    } else if (stagnation.stagnant) {
      verdict = 'FAIL';
    } else if (coveragePct >= 95) {
      verdict = 'PASS';
    } else if (coveragePct > 0) {
      verdict = 'PARTIAL';
    } else {
      verdict = 'FAIL';
    }

    var report = {
      generatedAt: new Date().toISOString(),
      route: 'browser-direct-public (same pattern as fetchOIDelta, no credentials)',
      credentialsUsed: false,
      request: {
        symbol: cfg.symbol, category: cfg.category, intervalTime: cfg.intervalTime,
        requestedStartIso: new Date(startTime).toISOString(),
        requestedEndIso: new Date(endTime).toISOString(),
        requestedDays: cfg.days,
      },
      hardStop: hardStop ? { atPage: pageIndex, reason: hardStopReason } : null,
      pagination: { pagesFetched: pageSummaries.length, pageSummaries: pageSummaries },
      coverage: {
        uniqueRowCount: rows.length,
        duplicateCount: duplicateCount,
        expectedIntervalCount: expectedIntervals,
        missingIntervalCount: missingCount,
        coveragePct: Math.round(coveragePct * 100) / 100,
        earliestRowIso: rows.length ? new Date(rows[0].ts).toISOString() : null,
        latestRowIso: rows.length ? new Date(rows[rows.length - 1].ts).toISOString() : null,
      },
      gaps: { gapCount: gaps.length, totalMissingIntervalsInGaps: gaps.reduce(function (s, g) { return s + g.missingIntervals; }, 0) },
      stagnationCheck: stagnation,
      verdict: verdict,
    };

    var reportText = [
      'OI Coverage Probe — ' + report.generatedAt,
      'Route: ' + report.route,
      report.request.symbol + ' ' + report.request.category + ' interval=' + report.request.intervalTime,
      'Requested: ' + report.request.requestedStartIso + ' -> ' + report.request.requestedEndIso + ' (' + report.request.requestedDays + 'd)',
      report.hardStop ? ('HARD STOP page ' + report.hardStop.atPage + ': ' + report.hardStop.reason) : ('Pages fetched: ' + report.pagination.pagesFetched),
      'Unique rows: ' + report.coverage.uniqueRowCount + '  Duplicates: ' + report.coverage.duplicateCount,
      'Expected intervals: ' + report.coverage.expectedIntervalCount + '  Missing: ' + report.coverage.missingIntervalCount,
      'Coverage: ' + report.coverage.coveragePct + '%',
      'Earliest achieved: ' + (report.coverage.earliestRowIso || 'n/a'),
      'Latest achieved: ' + (report.coverage.latestRowIso || 'n/a'),
      'Gaps (>1 interval): ' + report.gaps.gapCount + '  Total missing in gaps: ' + report.gaps.totalMissingIntervalsInGaps,
      'Stagnation: ' + JSON.stringify(report.stagnationCheck),
      'VERDICT: ' + report.verdict,
    ].join('\n');

    return { report: report, reportText: reportText };
  }

  var OIExhaustionProbe = {
    parseRow: parseRow,
    mergeDedupe: mergeDedupe,
    detectGaps: detectGaps,
    computeExpectedIntervals: computeExpectedIntervals,
    detectStagnation: detectStagnation,
    runOICoverageProbe: runOICoverageProbe,
    DEFAULTS: DEFAULTS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionProbe;
  } else {
    root.OIExhaustionProbe = OIExhaustionProbe;
    root.runOICoverageProbe = runOICoverageProbe; // manual console invocation
  }

})(typeof window !== 'undefined' ? window : globalThis);

/**
 * sp500-render.js
 * Renderer for the S&P 500 Watchlist tab.
 * All data flows through SP500DataSource.getSnapshot() — never reads fixture globals directly.
 * Classification via SP500Engine (sp500-engine.js).
 * No live data, no APIs.
 */
(function () {
  'use strict';

  // ── helpers ──────────────────────────────────────────────────────────────────

  function _esc(s) {
    if (s == null) return '—';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _fmtPct(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  }

  function _fmtPrice(v) {
    if (v == null || !isFinite(v)) return '—';
    return '$' + v.toFixed(2);
  }

  function _fmtDist(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(1) + '%';
  }

  function _fmtCape(v) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(1) + 'x';
  }

  // ── CSS class maps ────────────────────────────────────────────────────────────

  var POSTURE_DESC = {
    'Bullish':   'Above 20D and 200D',
    'Neutral':   'Above 200D, below 20D',
    'Extended':  'Strong trend, extended from 20D',
    'Weakening': 'Below 200D',
  };

  var STATUS_CLS = {
    'Bullish':   'sp5-status--bullish',
    'Neutral':   'sp5-status--neutral',
    'Extended':  'sp5-status--extended',
    'Weakening': 'sp5-status--weakening',
  };

  var CAUTION_CLS = {
    'Normal':   'sp5-caution--normal',
    'Elevated': 'sp5-caution--elevated',
    'Extreme':  'sp5-caution--extreme',
  };

  // ── live snapshot cache (set after fetchLive succeeds) ──────────────────────
  var _liveSnapshot = null;

  // ── data source ─────────────────────────────────────────────────────────────

  function _safeSnapshot() {
    if (_liveSnapshot) return _liveSnapshot;
    if (typeof SP500DataSource !== 'undefined' && typeof SP500DataSource.getSnapshot === 'function') {
      return SP500DataSource.getSnapshot();
    }
    return {
      valuation: (typeof SP500_VALUATION !== 'undefined') ? SP500_VALUATION : null,
      watchlist:  (typeof SP500_WATCHLIST !== 'undefined') ? SP500_WATCHLIST : [],
      mode: 'demo', asOf: 'Demo fixture', provider: 'Fixture', isLive: false,
    };
  }

  function _setPillDemo() {
    var dot   = document.getElementById('sp5-live-dot');
    var label = document.getElementById('sp5-live-label');
    var pill  = document.getElementById('sp5-live-pill');
    if (dot)   dot.style.background = 'var(--amber,#d9a93f)';
    if (label) label.textContent    = 'Demo';
    if (pill)  { pill.style.borderColor = 'rgba(217,169,63,0.4)'; pill.style.color = '#d9a93f'; }
  }

  function _setPillLive() {
    var dot   = document.getElementById('sp5-live-dot');
    var label = document.getElementById('sp5-live-label');
    var pill  = document.getElementById('sp5-live-pill');
    if (dot)   dot.style.background = 'var(--teal,#28d7c8)';
    if (label) label.textContent    = 'Live';
    if (pill)  { pill.style.borderColor = ''; pill.style.color = ''; }
  }

  // ── valuation panel ──────────────────────────────────────────────────────────

  function renderValuation() {
    var el = document.getElementById('sp5-valuation-body');
    if (!el) return;

    var v = _safeSnapshot().valuation;
    if (!v) {
      el.innerHTML = '<div class="sp5-unavail">Valuation fixture data not loaded.</div>';
      return;
    }

    var caution = (typeof SP500Engine !== 'undefined')
      ? SP500Engine.classifyValuationCaution(v.capePercentile)
      : (v.caution || 'Normal');
    var cautionCls = CAUTION_CLS[caution] || 'sp5-caution--normal';

    // Metrics grid
    var metrics =
      '<div class="sp5-val-grid">' +
        _valMetric('Shiller CAPE',          _fmtCape(v.cape)) +
        _valMetric('Forward P/E',           v.forwardPE != null ? v.forwardPE.toFixed(1) + 'x' : '—') +
        _valMetric('Trailing P/E',          v.trailingPE != null ? v.trailingPE.toFixed(1) + 'x' : '—') +
        _valMetric('CAPE Percentile',       v.capePercentile != null ? v.capePercentile + 'th' : '—') +
        _valMetric('vs 2000 Peak (' + _fmtCape(v.cape2000Peak) + ')', v.distFrom2000 != null ? (v.distFrom2000 > 0 ? '+' : '') + v.distFrom2000.toFixed(1) + '%' : '—') +
        '<div class="sp5-val-metric sp5-val-metric--wide">' +
          '<div class="sp5-vm-label">Valuation Caution</div>' +
          '<div class="sp5-vm-val"><span class="sp5-caution ' + _esc(cautionCls) + '">' + _esc(caution) + '</span></div>' +
        '</div>' +
      '</div>';

    // Cycle note
    var note = v.cycleNote
      ? '<div class="sp5-cycle-note">' + _esc(v.cycleNote) + '</div>'
      : '';

    // Historical comparison table
    var hist = '';
    if (Array.isArray(v.history) && v.history.length) {
      hist =
        '<div class="sp5-hist-label">Historical Valuation Comparisons</div>' +
        '<table class="sp5-hist-table">' +
          '<thead><tr><th>Cycle</th><th>CAPE</th><th>What happened</th></tr></thead>' +
          '<tbody>';
      for (var i = 0; i < v.history.length; i++) {
        var h = v.history[i];
        var isCurrent = i === v.history.length - 1;
        hist +=
          '<tr' + (isCurrent ? ' class="sp5-hist-current"' : '') + '>' +
          '<td>' + _esc(h.cycle) + '</td>' +
          '<td>' + _esc(_fmtCape(h.cape)) + '</td>' +
          '<td>' + _esc(h.note) + '</td>' +
          '</tr>';
      }
      hist += '</tbody></table>';
    }

    el.innerHTML = metrics + note + hist;
  }

  function _valMetric(label, val) {
    return '<div class="sp5-val-metric">' +
      '<div class="sp5-vm-label">' + _esc(label) + '</div>' +
      '<div class="sp5-vm-val">' + _esc(val) + '</div>' +
    '</div>';
  }

  // ── watchlist table ──────────────────────────────────────────────────────────

  function renderWatchlist() {
    var el = document.getElementById('sp5-watchlist-body');
    if (!el) return;

    var raw = _safeSnapshot().watchlist || null;
    if (!raw || !raw.length) {
      el.innerHTML = '<div class="sp5-unavail">Watchlist fixture data not loaded.</div>';
      return;
    }

    var rows = (typeof SP500Engine !== 'undefined')
      ? SP500Engine.classifyAll(raw)
      : raw.map(function (r) { return Object.assign({}, r, { status: 'Neutral' }); });

    // SPY posture line
    var spyRow = rows.find(function (r) { return r.ticker === 'SPY'; });
    var spyStatus = spyRow ? spyRow.status : null;
    var spyDesc   = spyStatus ? (POSTURE_DESC[spyStatus] || '') : '';
    var postureLine = spyStatus
      ? '<div class="sp5-posture">SPY Market Posture: ' +
          '<span class="sp5-status ' + _esc(STATUS_CLS[spyStatus] || '') + '">' + _esc(spyStatus) + '</span>' +
          (spyDesc ? ' <span class="sp5-posture-desc">— ' + _esc(spyDesc) + '</span>' : '') +
        '</div>'
      : '';

    var snap = _safeSnapshot();
    var isPartial = snap.mode === 'partial';

    var html = postureLine +
      '<table class="sp5-table">' +
        '<thead><tr>' +
          '<th>Ticker</th><th>Company</th><th>Sector</th>' +
          '<th>Price</th><th>Day %</th>' +
          (isPartial ? '<th>Source</th>' : '') +
          '<th>20D</th><th>20D Dist</th><th>200D</th><th>200D Dist</th>' +
          '<th>Status</th><th>Note</th>' +
        '</tr></thead>' +
        '<tbody>';

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var statusCls = STATUS_CLS[r.status] || '';
      var dayCls    = (typeof r.dayChg === 'number' && r.dayChg >= 0) ? 'pos-pnl--pos' : 'pos-pnl--neg';
      var t20       = r.above20d  ? '<span class="sp5-ma sp5-ma--above">&uarr;</span>' : '<span class="sp5-ma sp5-ma--below">&darr;</span>';
      var t200      = r.above200d ? '<span class="sp5-ma sp5-ma--above">&uarr;</span>' : '<span class="sp5-ma sp5-ma--below">&darr;</span>';

      var sourceCell = isPartial
        ? '<td class="sp5-source sp5-source--' + _esc(r.priceSource || 'fixture') + '">' +
            (r.priceSource === 'live' ? 'Live' : 'Fixture') + '</td>'
        : '';

      html +=
        '<tr>' +
        '<td><strong>' + _esc(r.ticker)  + '</strong></td>' +
        '<td>' + _esc(r.company) + '</td>' +
        '<td>' + _esc(r.sector)  + '</td>' +
        '<td>' + _fmtPrice(r.price) + '</td>' +
        '<td class="' + _esc(dayCls) + '">' + _fmtPct(r.dayChg) + '</td>' +
        sourceCell +
        '<td>' + t20  + '</td>' +
        '<td>' + _esc(_fmtDist(r.dist20d))  + '</td>' +
        '<td>' + t200 + '</td>' +
        '<td>' + _esc(_fmtDist(r.dist200d)) + '</td>' +
        '<td><span class="sp5-status ' + _esc(statusCls) + '">' + _esc(r.status) + '</span></td>' +
        '<td class="sp5-note">' + _esc(r.note || r._autoNote || '') + '</td>' +
        '</tr>';
    }

    html += '</tbody></table>';
    el.innerHTML = html;
  }

  // ── public ───────────────────────────────────────────────────────────────────

  function init() {
    // Initial paint with fixture data immediately
    renderValuation();
    renderWatchlist();
    _setPillDemo();

    // Then fetch live prices and re-render watchlist only.
    // Valuation panel always stays DEMO — only the watchlist updates to LIVE.
    if (typeof SP500DataSource !== 'undefined' &&
        typeof SP500DataSource.fetchLive === 'function') {
      SP500DataSource.fetchLive(function (snapshot) {
        _liveSnapshot = snapshot;
        renderWatchlist();
        if (snapshot.mode === 'live') {
          _setPillLive();
          _updateWatchlistBanner(snapshot);
        } else if (snapshot.mode === 'partial') {
          // Pill stays Demo — coverage incomplete, never claim full Live status
          _updateWatchlistBanner(snapshot);
        }
        // mode === 'demo' (fetch failed) — leave existing DEMO state untouched
      });
    }
  }

  function _updateWatchlistBanner(snapshot) {
    var banner = document.getElementById('sp5-watchlist-banner');
    if (!banner) return;

    if (snapshot.mode === 'live') {
      var time = '';
      try { time = new Date(snapshot.asOf).toLocaleTimeString(); } catch (_) {}
      banner.textContent = 'LIVE PRICES · ' + (snapshot.provider || 'Live') +
        (time ? ' · ' + time : '');
      banner.style.background  = 'rgba(40,215,200,0.08)';
      banner.style.borderColor = 'rgba(40,215,200,0.35)';
      banner.style.color       = 'var(--teal,#28d7c8)';
      return;
    }

    if (snapshot.mode === 'partial') {
      banner.textContent = 'PARTIAL LIVE PRICES · ' + snapshot.liveCount + '/' +
        snapshot.totalCount + ' live · Remaining rows use fixtures';
      banner.style.background  = 'rgba(249,115,22,0.1)';
      banner.style.borderColor = 'rgba(249,115,22,0.3)';
      banner.style.color       = '#f97316';
      return;
    }
    // demo / failure — leave the default DEMO banner untouched
  }

  var SP500Render = { init: init, renderValuation: renderValuation, renderWatchlist: renderWatchlist,
    setPillDemo: _setPillDemo, setPillLive: _setPillLive, getSnapshot: _safeSnapshot };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SP500Render;
  } else {
    window.SP500Render = SP500Render;
  }
}());

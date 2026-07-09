(function (root) {
  'use strict';

  var DATA_URL = 'data/oi-alert-outcomes.json';
  var HORIZONS = ['1h', '2h', '4h', '12h', '24h'];

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(value) {
    if (!isFiniteNumber(value)) return '—';
    return '$' + value.toLocaleString('en-US', {
      minimumFractionDigits: value >= 1000 ? 0 : 2,
      maximumFractionDigits: value >= 1000 ? 0 : 2
    });
  }

  function formatPct(value) {
    if (!isFiniteNumber(value)) return '—';
    var sign = value > 0 ? '+' : '';
    return sign + (value * 100).toFixed(2) + '%';
  }

  function formatCET(ts) {
    if (!isFiniteNumber(ts)) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Brussels',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ts)) + ' CET/CEST';
  }

  function classifySignal(signal) {
    var bias = signal && signal.alert_bias ? signal.alert_bias : 'neutral';
    var direction = signal && signal.direction ? signal.direction : null;
    var type = signal && signal.type ? signal.type : 'unknown';
    var label = 'Neutral';
    if (bias === 'bullish') label = 'Bullish';
    else if (bias === 'bearish') label = 'Bearish';
    else if (type.indexOf('flush') >= 0) label = 'Flush';
    return {
      bias: bias,
      direction: direction,
      type: type,
      label: label
    };
  }

  function typeLabel(type) {
    if (type === 'oi_expansion_with_price_up') return 'OI buildup + price up';
    if (type === 'oi_expansion_with_price_down') return 'OI buildup + price down';
    if (type === 'upside_oi_flush') return 'Upside OI flush';
    if (type === 'downside_oi_flush') return 'Downside OI flush';
    if (type === 'oi_flush') return 'OI flush';
    return String(type || 'unknown').replace(/_/g, ' ');
  }

  function horizonMap(outcome) {
    var out = {};
    var rows = outcome && Array.isArray(outcome.send_horizons) && outcome.send_horizons.length
      ? outcome.send_horizons
      : outcome && Array.isArray(outcome.horizons) ? outcome.horizons : [];
    for (var i = 0; i < rows.length; i++) out[rows[i].label] = rows[i];
    return out;
  }

  function metricClass(value, status) {
    if (status && status !== 'complete') return 'pending';
    if (!isFiniteNumber(value) || value === 0) return 'flat';
    return value > 0 ? 'up' : 'down';
  }

  function renderMoveCell(horizon) {
    if (!horizon || horizon.status !== 'complete') {
      return '<td class="oiar-move oiar-move-pending"><span>Pending</span><small>' +
        escapeHtml(horizon && horizon.target_ts ? formatCET(horizon.target_ts) : 'waiting for candle') +
        '</small></td>';
    }
    var cls = metricClass(horizon.price_return, horizon.status);
    return '<td class="oiar-move oiar-move-' + cls + '">' +
      '<span>' + escapeHtml(formatPct(horizon.price_return)) + '</span>' +
      '<small>' + escapeHtml(formatMoney(horizon.price)) + '</small>' +
      '</td>';
  }

  function newestFirst(a, b) {
    var aTs = a && a.signal && isFiniteNumber(a.signal.sent_ts) ? a.signal.sent_ts : 0;
    var bTs = b && b.signal && isFiniteNumber(b.signal.sent_ts) ? b.signal.sent_ts : 0;
    return bTs - aTs;
  }

  function summarize(report) {
    var outcomes = Array.isArray(report && report.outcomes) ? report.outcomes : [];
    var bullish = 0;
    var bearish = 0;
    var neutral = 0;
    for (var i = 0; i < outcomes.length; i++) {
      var signal = outcomes[i].signal || {};
      if (signal.alert_bias === 'bullish') bullish++;
      else if (signal.alert_bias === 'bearish') bearish++;
      else neutral++;
    }
    return {
      total: outcomes.length,
      bullish: bullish,
      bearish: bearish,
      neutral: neutral,
      complete: report && report.send_price_enrichment ? report.send_price_enrichment.complete_horizons : report.complete_horizons,
      pending: report && report.send_price_enrichment ? report.send_price_enrichment.pending_horizons : report.pending_horizons
    };
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function renderSummary(report) {
    var summary = summarize(report);
    setText('oiar-total-alerts', String(summary.total));
    setText('oiar-bullish-alerts', String(summary.bullish));
    setText('oiar-bearish-alerts', String(summary.bearish));
    setText('oiar-pending-checkpoints', String(summary.pending || 0));
    setText('oiar-generated', report && report.generated_ts ? formatCET(report.generated_ts) : '—');
    var source = report && report.send_price_enrichment;
    setText('oiar-source-note', source && source.ok
      ? source.note
      : 'Using local 15m signal-bucket outcomes because Binance 1m sent-price enrichment is unavailable.');
  }

  function renderRows(report) {
    var body = document.getElementById('oiar-table-body');
    if (!body) return;
    var outcomes = Array.isArray(report && report.outcomes) ? report.outcomes.slice().sort(newestFirst) : [];
    if (!outcomes.length) {
      body.innerHTML = '<tr><td colspan="9" class="oiar-empty-cell">No sent OI alerts found in the exported snapshot yet.</td></tr>';
      return;
    }
    body.innerHTML = outcomes.map(function (outcome) {
      var signal = outcome.signal || {};
      var cls = classifySignal(signal);
      var horizons = horizonMap(outcome);
      var sentPrice = outcome.send_price_reference && isFiniteNumber(outcome.send_price_reference.price)
        ? outcome.send_price_reference.price
        : outcome.base && isFiniteNumber(outcome.base.price_close) ? outcome.base.price_close : null;
      return '<tr>' +
        '<td class="oiar-alert-type"><span class="oiar-badge oiar-badge-' + escapeHtml(cls.bias) + '">' + escapeHtml(cls.label) + '</span></td>' +
        '<td><div class="oiar-strong">' + escapeHtml(typeLabel(cls.type)) + '</div><small>' + escapeHtml(signal.direction_source || 'source unknown') + '</small></td>' +
        '<td><div class="oiar-strong">' + escapeHtml(formatCET(signal.sent_ts)) + '</div><small>sent</small></td>' +
        '<td><div class="oiar-strong">' + escapeHtml(formatMoney(sentPrice)) + '</div><small>' + escapeHtml(outcome.send_price_reference ? 'Binance 1m open' : '15m bucket close') + '</small></td>' +
        HORIZONS.map(function (label) { return renderMoveCell(horizons[label]); }).join('') +
        '</tr>';
    }).join('');
  }

  function renderError(message) {
    var body = document.getElementById('oiar-table-body');
    if (body) {
      body.innerHTML = '<tr><td colspan="9" class="oiar-empty-cell">Could not load OI alert outcomes: ' + escapeHtml(message) + '</td></tr>';
    }
    setText('oiar-status', 'Load failed');
  }

  function render(report) {
    renderSummary(report);
    renderRows(report);
    setText('oiar-status', 'Active - Scanning');
  }

  function init() {
    if (!document.getElementById('tab-oix-alerts')) return;
    setText('oiar-status', 'Loading…');
    fetch(DATA_URL + '?v=site-oi-alerts-v1', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(render)
      .catch(function (err) {
        renderError(err && err.message ? err.message : String(err));
      });
  }

  var api = {
    init: init,
    classifySignal: classifySignal,
    formatPct: formatPct,
    formatCET: formatCET,
    summarize: summarize
  };

  root.OIAlertReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

(function (root) {
  'use strict';

  var DATA_URL = 'data/oi-alert-outcomes.json';
  var HORIZONS = ['1h', '2h', '4h', '12h', '24h'];
  var FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  var OIAR_GREEN = '#22c55e';
  var OIAR_RED = '#ef4444';
  var chartOutcomesById = {};
  var chartInstance = null;
  var alertDotOverlayRegistered = false;
  var refreshTimer = null;
  var REFRESH_MS = 5 * 60 * 1000;

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

  function sentPrice(outcome) {
    return outcome && outcome.send_price_reference && isFiniteNumber(outcome.send_price_reference.price)
      ? outcome.send_price_reference.price
      : outcome && outcome.base && isFiniteNumber(outcome.base.price_close) ? outcome.base.price_close : null;
  }

  function sentPriceSource(outcome) {
    return outcome && outcome.send_price_reference ? 'Binance 1m open' : '15m bucket close';
  }

  function chartAlertId(outcome, index) {
    return 'oi-alert-' + index + '-' + String(outcome && (outcome.id || outcome.signal && outcome.signal.id) || 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 90);
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

  function renderInlineMove(horizon) {
    if (!horizon || horizon.status !== 'complete') return 'pending';
    return formatPct(horizon.price_return) + ' after ' + horizon.label;
  }

  function ensureAlertDotOverlay() {
    if (alertDotOverlayRegistered || typeof klinecharts === 'undefined') return;
    try {
      klinecharts.registerOverlay({
        name: 'oiarAlertDot',
        totalStep: 1,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        createPointFigures: function (ctx) {
          var coordinates = ctx.coordinates || [];
          var overlay = ctx.overlay || {};
          if (!coordinates.length) return [];
          var p = coordinates[0];
          var data = overlay.extendData || {};
          var color = data.color || '#38bdf8';
          return [
            { type: 'circle', attrs: { x: p.x, y: p.y, r: 6 }, styles: { style: 'fill', color: color }, ignoreEvent: true },
            { type: 'circle', attrs: { x: p.x, y: p.y, r: 12 }, styles: { style: 'stroke', color: color, size: 2 }, ignoreEvent: true },
            { type: 'text', attrs: { x: p.x + 12, y: p.y - 10, text: data.label || 'OI alert', align: 'left', baseline: 'middle' }, styles: { color: color, size: 11 }, ignoreEvent: true }
          ];
        }
      });
      alertDotOverlayRegistered = true;
    } catch (err) {
      alertDotOverlayRegistered = true;
    }
  }

  function ensureChartModal() {
    var modal = document.getElementById('oiarChartModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'oiarChartModal';
    modal.className = 'oiar-chart-modal';
    modal.innerHTML =
      '<div class="oiar-chart-panel">' +
        '<div class="oiar-chart-head">' +
          '<div><div id="oiarChartTitle" class="oiar-chart-title">BTCUSDT 4H alert view</div><div id="oiarChartSub" class="oiar-chart-sub"></div></div>' +
          '<button type="button" class="oiar-chart-close" onclick="OIAlertReview.closeChart()">Close</button>' +
        '</div>' +
        '<div id="oiarChartError" class="oiar-chart-error"></div>' +
        '<div id="oiarChartCanvas" class="oiar-chart-canvas"></div>' +
      '</div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeChart();
    });
    document.body.appendChild(modal);
    return modal;
  }

  function closeChart() {
    var modal = document.getElementById('oiarChartModal');
    if (modal) modal.style.display = 'none';
    try {
      if (typeof klinecharts !== 'undefined') klinecharts.dispose('oiarChartCanvas');
    } catch (err) {}
    chartInstance = null;
  }

  function setChartError(message) {
    var errorEl = document.getElementById('oiarChartError');
    if (!errorEl) return;
    if (message) {
      errorEl.style.display = 'block';
      errorEl.textContent = message;
    } else {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function fetchFourHourCandles(alertTs) {
    var startTime = Math.max(0, alertTs - 4 * 24 * 60 * 60 * 1000);
    var endTime = alertTs + 14 * 24 * 60 * 60 * 1000;
    var params = 'symbol=BTCUSDT&interval=4h&limit=1500&startTime=' + encodeURIComponent(startTime) + '&endTime=' + encodeURIComponent(endTime);
    var futuresUrl = 'https://fapi.binance.com/fapi/v1/klines?' + params;
    var spotUrl = 'https://api.binance.com/api/v3/klines?' + params;
    return fetchJson(futuresUrl).catch(function () {
      return fetchJson(spotUrl);
    });
  }

  function normalizeCandles(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return {
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4])
      };
    }).filter(function (candle) {
      return isFiniteNumber(candle.timestamp) &&
        isFiniteNumber(candle.open) &&
        isFiniteNumber(candle.high) &&
        isFiniteNumber(candle.low) &&
        isFiniteNumber(candle.close);
    });
  }

  function findAlertMarker(candles, alertTs, price) {
    var candle = null;
    for (var i = 0; i < candles.length; i++) {
      if (alertTs >= candles[i].timestamp && alertTs < candles[i].timestamp + FOUR_HOURS_MS) {
        candle = candles[i];
        break;
      }
    }
    if (!candle) {
      candle = candles.reduce(function (best, current) {
        if (!best) return current;
        return Math.abs(current.timestamp - alertTs) < Math.abs(best.timestamp - alertTs) ? current : best;
      }, null);
    }
    if (!candle) return null;
    return {
      timestamp: candle.timestamp,
      value: isFiniteNumber(price) ? price : candle.close,
      candle: candle
    };
  }

  function renderChart(outcome, candles) {
    var signal = outcome.signal || {};
    var cls = classifySignal(signal);
    var price = sentPrice(outcome);
    var marker = findAlertMarker(candles, signal.sent_ts, price);
    var titleEl = document.getElementById('oiarChartTitle');
    var subEl = document.getElementById('oiarChartSub');
    if (!marker) {
      setChartError('Could not map this alert to a 4H candle.');
      return;
    }
    if (titleEl) titleEl.textContent = 'BTCUSDT 4H - ' + cls.label + ' OI alert';
    if (subEl) subEl.textContent = 'Sent ' + formatCET(signal.sent_ts) + ' - alert price ' + formatMoney(price) + ' - ' + typeLabel(cls.type);
    try {
      klinecharts.dispose('oiarChartCanvas');
    } catch (err) {}
    var chart = klinecharts.init('oiarChartCanvas');
    if (!chart) {
      setChartError('Chart failed to initialize.');
      return;
    }
    chartInstance = chart;
    chart.setStyles({
      grid: { horizontal: { color: 'rgba(148,163,184,0.10)' }, vertical: { show: false } },
      candle: {
        bar: {
          upColor: OIAR_GREEN,
          downColor: OIAR_RED,
          noChangeColor: '#64748b',
          upBorderColor: OIAR_GREEN,
          downBorderColor: OIAR_RED,
          upWickColor: OIAR_GREEN,
          downWickColor: OIAR_RED
        }
      },
      xAxis: { tickText: { color: '#7186a0' }, axisLine: { color: 'rgba(148,163,184,0.14)' } },
      yAxis: { tickText: { color: '#7186a0' }, axisLine: { color: 'rgba(148,163,184,0.14)' } }
    });
    chart.applyNewData(candles);
    ensureAlertDotOverlay();
    chart.createOverlay({
      name: 'oiarAlertDot',
      lock: true,
      points: [{ timestamp: marker.timestamp, value: marker.value }],
      extendData: {
        color: cls.bias === 'bearish' ? OIAR_RED : OIAR_GREEN,
        label: cls.label + ' alert'
      }
    });
    if (chart.scrollToTimestamp) chart.scrollToTimestamp(marker.timestamp, 0);
  }

  function openChart(id) {
    var outcome = chartOutcomesById[id];
    var signal = outcome && outcome.signal ? outcome.signal : {};
    var modal = ensureChartModal();
    var titleEl = document.getElementById('oiarChartTitle');
    var subEl = document.getElementById('oiarChartSub');
    modal.style.display = 'flex';
    setChartError('');
    if (titleEl) titleEl.textContent = 'BTCUSDT 4H alert view';
    if (subEl) subEl.textContent = 'Loading candles...';
    if (!outcome || !isFiniteNumber(signal.sent_ts)) {
      setChartError('This alert has no valid sent timestamp.');
      if (subEl) subEl.textContent = '';
      return;
    }
    if (typeof klinecharts === 'undefined') {
      setChartError('Chart library is not loaded.');
      if (subEl) subEl.textContent = '';
      return;
    }
    fetchFourHourCandles(signal.sent_ts)
      .then(function (rows) {
        var candles = normalizeCandles(rows);
        if (!candles.length) throw new Error('No BTCUSDT 4H candles returned.');
        setChartError('');
        renderChart(outcome, candles);
      })
      .catch(function (err) {
        if (subEl) subEl.textContent = '';
        setChartError('Could not load BTCUSDT 4H candles: ' + (err && err.message ? err.message : String(err)));
      });
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
    chartOutcomesById = {};
    if (!outcomes.length) {
      body.innerHTML = '<tr><td colspan="10" class="oiar-empty-cell">No sent OI alerts found in the exported snapshot yet.</td></tr>';
      return;
    }
    body.innerHTML = outcomes.map(function (outcome, index) {
      var signal = outcome.signal || {};
      var cls = classifySignal(signal);
      var horizons = horizonMap(outcome);
      var id = chartAlertId(outcome, index);
      var chartDisabled = !isFiniteNumber(signal.sent_ts);
      chartOutcomesById[id] = outcome;
      var price = sentPrice(outcome);
      return '<tr>' +
        '<td class="oiar-alert-type"><span class="oiar-badge oiar-badge-' + escapeHtml(cls.bias) + '">' + escapeHtml(cls.label) + '</span></td>' +
        '<td><div class="oiar-strong">' + escapeHtml(typeLabel(cls.type)) + '</div><small>' + escapeHtml(signal.direction_source || 'source unknown') + '</small></td>' +
        '<td><div class="oiar-strong">' + escapeHtml(formatCET(signal.sent_ts)) + '</div><small>sent</small></td>' +
        '<td><div class="oiar-strong">' + escapeHtml(formatMoney(price)) + '</div><small>' + escapeHtml(sentPriceSource(outcome)) + '</small></td>' +
        '<td><button type="button" class="oiar-view-btn" ' + (chartDisabled ? 'disabled ' : '') + 'onclick="OIAlertReview.openChart(\'' + escapeHtml(id) + '\')">View</button></td>' +
        HORIZONS.map(function (label) { return renderMoveCell(horizons[label]); }).join('') +
        '</tr>';
    }).join('');
  }

  function renderDashboardLatest(report) {
    var el = document.getElementById('dashLatestOiAlert');
    if (!el) return;
    var outcomes = Array.isArray(report && report.outcomes) ? report.outcomes.slice().sort(newestFirst) : [];
    if (!outcomes.length) {
      el.innerHTML = '<div class="dash-oi-empty">No OI alerts found yet.</div>';
      return;
    }
    var outcome = outcomes[0];
    var signal = outcome.signal || {};
    var cls = classifySignal(signal);
    var horizons = horizonMap(outcome);
    var price = sentPrice(outcome);
    var id = chartAlertId(outcome, 'dashboard-latest');
    var chartDisabled = !isFiniteNumber(signal.sent_ts);
    chartOutcomesById[id] = outcome;
    var moveText = renderInlineMove(horizons['1h']);
    if (moveText === 'pending') moveText = renderInlineMove(horizons['4h']);
    var badgeClass = 'oiar-badge oiar-badge-' + escapeHtml(cls.bias);
    el.innerHTML =
      '<div class="dash-oi-row">' +
        '<div class="dash-oi-left">' +
          '<div class="dash-oi-kicker"><i class="ti ti-bell-ringing"></i><span>Latest OI alert</span><span class="' + badgeClass + '">' + escapeHtml(cls.label) + '</span></div>' +
          '<div class="dash-oi-title">' + escapeHtml(typeLabel(cls.type)) + ' at ' + escapeHtml(formatMoney(price)) + '</div>' +
          '<div class="dash-oi-meta">' + escapeHtml(formatCET(signal.sent_ts)) + ' - ' + escapeHtml(sentPriceSource(outcome)) + ' - ' + escapeHtml(moveText) + '</div>' +
        '</div>' +
        '<button type="button" class="dash-oi-view" ' + (chartDisabled ? 'disabled ' : '') + 'onclick="OIAlertReview.openChart(\'' + escapeHtml(id) + '\')">View</button>' +
      '</div>';
  }

  function renderError(message) {
    var body = document.getElementById('oiar-table-body');
    if (body) {
      body.innerHTML = '<tr><td colspan="10" class="oiar-empty-cell">Could not load OI alert outcomes: ' + escapeHtml(message) + '</td></tr>';
    }
    var dash = document.getElementById('dashLatestOiAlert');
    if (dash) {
      dash.innerHTML = '<div class="dash-oi-empty">Could not load latest OI alert: ' + escapeHtml(message) + '</div>';
    }
    setText('oiar-status', 'Load failed');
  }

  function render(report) {
    renderSummary(report);
    renderRows(report);
    renderDashboardLatest(report);
    setText('oiar-status', 'Active - Scanning');
  }

  function loadReport() {
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

  function init() {
    if (!document.getElementById('tab-oix-alerts') && !document.getElementById('dashLatestOiAlert')) return;
    loadReport();
    if (!refreshTimer) refreshTimer = setInterval(loadReport, REFRESH_MS);
  }

  var api = {
    init: init,
    classifySignal: classifySignal,
    formatPct: formatPct,
    formatCET: formatCET,
    summarize: summarize,
    openChart: openChart,
    closeChart: closeChart,
    renderDashboardLatest: renderDashboardLatest
  };

  root.OIAlertReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

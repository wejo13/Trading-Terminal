/**
 * oi-exhaustion-render.js
 * UI layer for the OI Exhaustion tab. Wires the pure engine/backtest modules
 * to the DOM — this file itself does no scoring/state-machine math, it only
 * fetches data, calls OIExhaustionEngine/OIExhaustionBacktest, and renders.
 *
 * Data source rule (explicit, per spec):
 *  - Bybit 5m OI + Bybit 5m candles are the SIGNAL source (paired, same
 *    instrument, same timestamps — this is what actually feeds the engine).
 *  - Binance 5m BTCUSDT candles are used ONLY for the displayed chart.
 *    Alert markers are plotted at the Binance candle matching the alert's
 *    timestamp; the alert's own price/score/percentile values always come
 *    from the Bybit-based calculation, never from Binance.
 *  - Bybit API key/secret are never read here — OI and kline are both
 *    public, unauthenticated endpoints.
 */
'use strict';

(function (root) {

  const FIVE_MIN_MS = 5 * 60 * 1000;
  const SETTINGS_KEY = 'oix_settings_v1';
  const ZONES_KEY = 'oix_zones_v1';

  const DEFAULT_SETTINGS = {
    lookbackDays: 90,
    signalWindow: 144,
    baselineLookbackCandles: 8640,
    minBaselineSamples: 500,
    entryPercentile: 95,
    rearmPercentile: 80,
    alertModel: 'netProgress', // UI default per explicit request; engine/backtest default independently to 'strict' for backward compatibility
    oiRecencyFilterEnabled: false, // disabled by default, per explicit request — not auto-tuned
    minimumRecentOIChangePct: 0,
    oiRecencyWindow: '1h',
  };

  const VALID_ALERT_MODELS = ['strict', 'netProgress'];
  const VALID_OI_RECENCY_WINDOWS = ['30m', '1h', '2h', '4h'];

  // ── Pure logic (no DOM) — exported for Node tests ───────────────────────

  /** Fills in any missing fields with defaults; clamps obviously invalid values. */
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

  /** Start timestamp of the latest fully completed 5m candle, given "now". */
  function latestCompletedCandleStart(nowMs) {
    const currentCandleStart = Math.floor(nowMs / FIVE_MIN_MS) * FIVE_MIN_MS;
    return currentCandleStart - FIVE_MIN_MS;
  }

  const CHART_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h chart candles (display only)

  const OIExhaustionRender = {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    ZONES_KEY,
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
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OIExhaustionRender;
    return; // Node/test environment — stop here, no DOM code below.
  }

  // ── Everything below touches the DOM / network — browser only ──────────

  const Engine = window.OIExhaustionEngine;
  const Backtest = window.OIExhaustionBacktest;
  const Probe = window.OIExhaustionProbe; // parseRow/mergeDedupe reuse for OI

  const SYMBOL = 'BTCUSDT';
  const CATEGORY = 'linear';
  const PAGE_LIMIT = 200;
  const REQUEST_DELAY_MS = 200;
  const MAX_PAGES = 700;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Fetch: Bybit OI (signal source, public, no credentials) ────────────

  async function fetchBybitOI(startTime, endTime, onProgress) {
    const base = 'https://api.bybit.com/v5/market/open-interest';
    let cursor, pageIndex = 0;
    const pagesOfRows = [];

    while (pageIndex < MAX_PAGES) {
      const params = new URLSearchParams({
        category: CATEGORY, symbol: SYMBOL, intervalTime: '5min',
        limit: String(PAGE_LIMIT), startTime: String(startTime), endTime: String(endTime),
      });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`${base}?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.retCode !== 0) {
        throw new Error(`Bybit OI fetch failed at page ${pageIndex}: httpStatus=${res.status} retCode=${json && json.retCode} retMsg=${json && json.retMsg}`);
      }
      const list = (json.result && json.result.list) || [];
      const rows = list.map(Probe.parseRow).filter(Boolean);
      pagesOfRows.push(rows);
      if (onProgress) onProgress('oi', pageIndex, rows.length);

      pageIndex++;
      const nextCursor = json.result && json.result.nextPageCursor;
      if (!nextCursor || rows.length === 0) break;
      cursor = nextCursor;
      await sleep(REQUEST_DELAY_MS);
    }
    return Probe.mergeDedupe(pagesOfRows).rows;
  }

  // ── Fetch: Bybit candles (signal source, paired with OI) ────────────────

  function parseBybitKlineRow(raw) {
    if (!Array.isArray(raw) || raw.length < 5) return null;
    const ts = parseInt(raw[0], 10);
    const open = parseFloat(raw[1]), high = parseFloat(raw[2]), low = parseFloat(raw[3]), close = parseFloat(raw[4]);
    if (![ts, open, high, low, close].every(isFinite)) return null;
    return { ts, open, high, low, close };
  }

  async function fetchBybitCandles(startTime, endTime, onProgress) {
    const base = 'https://api.bybit.com/v5/market/kline';
    let currentEnd = endTime, pageIndex = 0;
    const pagesOfRows = [];

    while (pageIndex < MAX_PAGES && currentEnd > startTime) {
      const params = new URLSearchParams({
        category: CATEGORY, symbol: SYMBOL, interval: '5',
        start: String(startTime), end: String(currentEnd), limit: String(PAGE_LIMIT),
      });
      const res = await fetch(`${base}?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.retCode !== 0) {
        throw new Error(`Bybit candle fetch failed at page ${pageIndex}: httpStatus=${res.status} retCode=${json && json.retCode} retMsg=${json && json.retMsg}`);
      }
      const list = (json.result && json.result.list) || [];
      const rows = list.map(parseBybitKlineRow).filter(Boolean);
      pagesOfRows.push(rows);
      if (onProgress) onProgress('bybit-candles', pageIndex, rows.length);

      pageIndex++;
      if (rows.length === 0) break;
      const minTs = Math.min(...rows.map(r => r.ts));
      if (minTs <= startTime) break;
      currentEnd = minTs - 1;
      await sleep(REQUEST_DELAY_MS);
    }
    const byTs = new Map();
    for (const page of pagesOfRows) for (const r of page) byTs.set(r.ts, r);
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }

  // ── Fetch: Binance candles (chart display only) ─────────────────────────

  async function fetchBinanceCandles(startTime, endTime, onProgress) {
    const allCandles = [];
    let ts = startTime;
    let pageIndex = 0;
    while (ts <= endTime && pageIndex < MAX_PAGES) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=1000&startTime=${ts}&endTime=${endTime}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Binance candle fetch failed at page ${pageIndex}: httpStatus=${res.status} ${await res.text()}`);
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) break;
      for (const c of list) {
        allCandles.push({ ts: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
      }
      if (onProgress) onProgress('binance-candles', pageIndex, list.length);
      pageIndex++;
      const lastTs = list[list.length - 1][0];
      if (lastTs <= ts) break;
      ts = lastTs + CHART_INTERVAL_MS;
      await sleep(REQUEST_DELAY_MS);
    }
    return allCandles;
  }

  // ── State ────────────────────────────────────────────────────────────

  const state = {
    settings: DEFAULT_SETTINGS,
    zones: [],
    lastRun: null, // { result, binanceCandles, binanceIndex, chartPoints }
    chart: { scale: 0.3, offsetX: 0, dragging: false },
  };

  function loadSettings() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) { /* ignore */ }
    state.settings = validateSettings(raw);
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
    const ids = ['lookbackDays', 'signalWindow', 'baselineLookbackCandles', 'minBaselineSamples', 'entryPercentile', 'rearmPercentile', 'alertModel', 'minimumRecentOIChangePct', 'oiRecencyWindow'];
    ids.forEach(id => {
      const el = document.getElementById('oix-' + id);
      if (el) el.value = s[id];
    });
    const filterEl = document.getElementById('oix-oiRecencyFilterEnabled');
    if (filterEl) filterEl.checked = s.oiRecencyFilterEnabled;
  }

  function readSettingsFromForm() {
    const ids = ['lookbackDays', 'signalWindow', 'baselineLookbackCandles', 'minBaselineSamples', 'entryPercentile', 'rearmPercentile', 'alertModel', 'minimumRecentOIChangePct', 'oiRecencyWindow'];
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

  async function runAnalysis() {
    readSettingsFromForm();
    const s = state.settings;
    const runBtn = document.getElementById('oix-run-btn');
    if (runBtn) runBtn.disabled = true;

    try {
      const endTime = latestCompletedCandleStart(Date.now());
      const startTime = endTime - s.lookbackDays * 24 * 3600 * 1000;

      setStatus('Fetching Bybit OI + candles, and Binance candles for chart…');
      const progress = (source, page, rows) => {
        setStatus(`Fetching… ${source} page ${page} (${rows} rows)`);
      };

      const [oiRows, bybitCandles, binanceCandles] = await Promise.all([
        fetchBybitOI(startTime, endTime, progress),
        fetchBybitCandles(startTime, endTime, progress),
        fetchBinanceCandles(startTime, endTime, progress),
      ]);

      if (oiRows.length === 0 || bybitCandles.length === 0) {
        throw new Error('Zero rows returned for Bybit OI and/or candles — aborting rather than running on partial data.');
      }

      const zones = state.zones.map(normalizeZone).filter(z => isFinite(z.top) && isFinite(z.bottom));

      setStatus(`Running event-study… (${bybitCandles.length} Bybit candles, ${oiRows.length} OI rows, ${zones.length} active zone definitions)`);

      const result = Backtest.runEventStudy(bybitCandles, oiRows, zones, {
        entryPercentile: s.entryPercentile,
        rearmPercentile: s.rearmPercentile,
        minBaselineSamples: s.minBaselineSamples,
        baselineLookbackCandles: s.baselineLookbackCandles,
        alertModel: s.alertModel,
        oiRecencyFilterEnabled: s.oiRecencyFilterEnabled,
        minimumRecentOIChangePct: s.minimumRecentOIChangePct,
        oiRecencyWindow: s.oiRecencyWindow,
      });

      const binanceIndex = buildBinanceCandleIndex(binanceCandles);
      const chartPoints = result.alerts
        .map(a => mapAlertToContainingChartPoint(a, binanceCandles, CHART_INTERVAL_MS))
        .filter(Boolean);

      state.lastRun = { result, binanceCandles, binanceIndex, chartPoints };

      setStatus(
        `<span style="color:var(--teal);">Done.</span> ` +
        `Model: <b>${s.alertModel === 'netProgress' ? 'Net progress score (V2)' : 'Strict path score (V1)'}</b> &middot; ` +
        `Coverage: ${bybitCandles.length} Bybit candles / ${oiRows.length} OI rows / ${binanceCandles.length} Binance candles &middot; ` +
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
      setStatus(`<span style="color:var(--red);">Error:</span> ${escapeHtml(err.message || String(err))}`);
      console.error(err);
    } finally {
      if (runBtn) runBtn.disabled = false;
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
        <td>${dist.count.toLocaleString()}</td>
        <td>${dist.positiveRatePct.toFixed(1)}%</td>
        <td>${dist.p50.toFixed(4)}</td>
        <td>${dist.p90.toFixed(4)}</td>
        <td>${dist.p95.toFixed(4)}</td>
        <td>${dist.p99.toFixed(4)}</td>
      </tr>`;
    }

    body.innerHTML = `
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
        <b style="color:var(--text);">Choppy-but-flat count:</b> ${d.choppyButFlatCount.toLocaleString()} candles
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
            <td>$${a.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
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
      <span style="color:var(--text-faint);">Price</span><span>$${a.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
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
      ctx.fillText('$' + p.toLocaleString(undefined, { maximumFractionDigits: 0 }), W - padR + 4, y + 3);
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
    setStatus('Not yet run. Configure zones/parameters above, then Fetch data &amp; run analysis.');
  }

  Object.assign(OIExhaustionRender, {
    init, runAnalysis, addZoneRow, removeZone, updateZoneField, readSettingsFromForm,
    focusChartOnAlert,
    fetchBybitOI, fetchBybitCandles, fetchBinanceCandles, // exposed for console debugging
  });

  window.OIExhaustionRender = OIExhaustionRender;

})(typeof window !== 'undefined' ? window : globalThis);

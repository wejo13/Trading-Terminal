// ===================== BACKTESTING ENGINE =====================
// Strategy: BTC 4H candle wicks into 4H 200 EMA from above → long entry at candle close
// SL: 3% below entry (= 1R). TP tested at 1R–10R independently.
// Cooldown: 20 candles after SL hit before next entry.
// Data: Bybit kline API, paginated back to March 2020.

const BT_SYMBOL = 'BTCUSDT';
const BT_INTERVAL = '240'; // 4H in minutes
const BT_INTERVAL_MS = 4 * 60 * 60 * 1000;
let BT_SL_PCT = 0.03;    // default 3%, overridden by user input each run
const BT_EMA_PERIOD = 200;
let BT_START_TS = 1583020800000; // default March 1 2020 00:00 UTC, overridden by user selection
let BT_END_TS = Date.now(); // default now, overridden by user selection
let BT_INCLUDE_WINDOWS = null; // null = single contiguous range; array of [start,end] = bull market mode
const BT_TP_LEVELS = [1,2,3,4,5,6,7,8,9,10,20,50,100]; // multiples of R

// Bull market presets
const BT_BULL_1 = [Date.UTC(2019, 1, 1), Date.UTC(2021, 10, 30, 23, 59, 59)]; // Feb 2019 -> Nov 2021
const BT_BULL_2 = [Date.UTC(2022, 11, 1), Date.UTC(2025, 9, 31, 23, 59, 59)]; // Dec 2022 -> Oct 2025
let btDebug = false; // set window.btDebug = true in console to log near-EMA rejected candles
Object.defineProperty(window, 'btDebug', { get: () => btDebug, set: v => { btDebug = v; } });
let btDebugLog = [];

// palette for equity curves
const BT_COLORS = [
  '#28d7c8','#3ddc97','#9b8ae8','#d9a93f','#e2645f',
  '#5aabf0','#f07850','#c8e028','#e028c8','#28a0e0',
  '#ff9f43','#54a0ff','#5f27cd'
];

let btData = null; // cached raw candles
let btResults = null; // results per TP level

// ── EMA calculation ───────────────────────────────────────────────────────────
function btCalcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = new Array(closes.length).fill(null);
  // seed with SMA of first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ── Fetch all 4H candles from BT_START_TS to BT_END_TS (or superset of windows) ─
async function btFetchCandles() {
  const statusEl = document.getElementById('bt-status');
  const allCandles = [];
  let end = BT_END_TS;
  const limit = 1000;

  while (true) {
    statusEl.textContent = `Fetching candles… ${allCandles.length.toLocaleString()} loaded`;
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${BT_SYMBOL}&interval=${BT_INTERVAL}&limit=${limit}&end=${end}`;
    const res = await fetch(url);
    const json = await res.json();
    const list = json?.result?.list;
    if (!list || list.length === 0) break;

    // Bybit returns newest first: [ts, open, high, low, close, vol, turnover]
    const candles = list.map(c => ({
      ts: parseInt(c[0]),
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4])
    }));

    // oldest candle in this batch
    const oldest = candles[candles.length - 1].ts;
    allCandles.push(...candles);

    if (oldest <= BT_START_TS) break;
    end = oldest - 1;
    await new Promise(r => setTimeout(r, 80)); // rate limit buffer
  }

  // sort oldest → newest, keep the full superset range (EMA needs continuous history)
  allCandles.sort((a, b) => a.ts - b.ts);
  return allCandles.filter(c => c.ts >= BT_START_TS && c.ts <= BT_END_TS);
}

// ── Trim a (candles, ema) pair down to only the configured include-windows ─────
// Keeps candles/ema arrays index-aligned for the rest of the pipeline.
function btApplyIncludeWindows(candles, ema) {
  if (!BT_INCLUDE_WINDOWS) return { candles, ema };
  const outCandles = [];
  const outEma = [];
  for (let i = 0; i < candles.length; i++) {
    const ts = candles[i].ts;
    const inWindow = BT_INCLUDE_WINDOWS.some(([s, e]) => ts >= s && ts <= e);
    if (inWindow) {
      outCandles.push(candles[i]);
      outEma.push(ema[i]);
    }
  }
  return { candles: outCandles, ema: outEma };
}

// ── Run backtest for one TP level ─────────────────────────────────────────────
function btRunLevel(candles, ema, tpMultiple) {
  const slPct = BT_SL_PCT;
  const tpPct = BT_SL_PCT * tpMultiple;
  const trades = [];
  let cooldown = 0;
  let inTrade = null;
  const maxGapMs = BT_INTERVAL_MS * 2; // allow normal 4H spacing, flag anything bigger as a window seam

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const emaVal = ema[i];

    // Detect a seam between two non-contiguous bull-market windows: reset state,
    // any open trade at a seam is force-closed as "Open" since we can't track it
    // across the excluded gap.
    if (c.ts - candles[i - 1].ts > maxGapMs) {
      if (inTrade) {
        inTrade.outcome = 'Open';
        trades.push(inTrade);
        inTrade = null;
      }
      cooldown = 0;
    }

    if (!emaVal) { if (cooldown > 0) cooldown--; continue; }

    // If in trade, check SL/TP hit on this candle
    if (inTrade) {
      const slPrice = inTrade.entry * (1 - slPct);
      const tpPrice = inTrade.entry * (1 + tpPct);

      // Check SL first (conservative — assume worst case on same candle)
      if (c.l <= slPrice) {
        inTrade.outcome = 'Loss';
        inTrade.exitPrice = slPrice;
        inTrade.exitTs = c.ts;
        inTrade.rMade = -1;
        trades.push(inTrade);
        inTrade = null;
        cooldown = 20;
        continue;
      }
      if (c.h >= tpPrice) {
        inTrade.outcome = 'Win';
        inTrade.exitPrice = tpPrice;
        inTrade.exitTs = c.ts;
        inTrade.rMade = tpMultiple;
        trades.push(inTrade);
        inTrade = null;
        cooldown = 0;
        continue;
      }
      continue; // still in trade
    }

    if (cooldown > 0) { cooldown--; continue; }

    // Entry condition: previous candle closed below EMA, this candle is bullish
    // and closes above EMA (reclaim from below)
    const prevEma = ema[i - 1];
    const prevClose = candles[i - 1].c;
    const wasBelow = prevClose < prevEma;
    const isBullish = c.c > c.o;
    const closedAbove = c.c > emaVal;

    if (wasBelow && isBullish && closedAbove) {
      inTrade = {
        entryTs: c.ts,
        entry: c.c,
        tp: tpMultiple,
        outcome: 'Open',
        exitPrice: null,
        exitTs: null,
        rMade: null
      };
      if (btDebug && tpMultiple === 1) {
        btDebugLog.push(
          new Date(c.ts).toISOString().slice(0,16).replace('T',' ') +
          '  ENTRY close=' + c.c.toFixed(1) + ' open=' + c.o.toFixed(1) + ' ema=' + emaVal.toFixed(1) +
          '  prevClose=' + prevClose.toFixed(1) + ' prevEma=' + prevEma.toFixed(1)
        );
      }
    } else if (btDebug && tpMultiple === 1 && prevEma != null && Math.abs(c.c - emaVal) / emaVal < 0.10) {
      // Debug: collect near-miss candles close to EMA so rejected signals can be inspected in UI
      let reason = [];
      if (!wasBelow) reason.push('prev close was already above EMA');
      if (!isBullish) reason.push('candle not bullish');
      if (!closedAbove) reason.push('close did not end above EMA');
      if (cooldown > 0) reason.push('in cooldown (' + cooldown + ' left)');
      btDebugLog.push(
        new Date(c.ts).toISOString().slice(0,16).replace('T',' ') +
        '  close=' + c.c.toFixed(1) + ' open=' + c.o.toFixed(1) + ' ema=' + emaVal.toFixed(1) +
        '  prevClose=' + prevClose.toFixed(1) + ' prevEma=' + prevEma.toFixed(1) +
        '  -> ' + (reason.length ? reason.join(', ') : 'unknown')
      );
    }
  }

  // Any open trade at end of data
  if (inTrade) {
    inTrade.outcome = 'Open';
    trades.push(inTrade);
  }

  return trades;
}

// ── Summarise trades for a TP level ──────────────────────────────────────────
function btSummarise(trades, tpMultiple) {
  const closed = trades.filter(t => t.outcome !== 'Open');
  const wins = trades.filter(t => t.outcome === 'Win');
  const losses = trades.filter(t => t.outcome === 'Loss');
  const winRate = closed.length ? (wins.length / closed.length * 100) : 0;
  const grossWin = wins.length * tpMultiple;
  const grossLoss = losses.length;
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss) : wins.length > 0 ? Infinity : 0;
  const netR = grossWin - grossLoss;
  return {
    tp: tpMultiple, trades, total: trades.length,
    wins: wins.length, losses: losses.length,
    open: trades.filter(t => t.outcome === 'Open').length,
    winRate, profitFactor, netR
  };
}

// ── Build equity curve series for a TP level ─────────────────────────────────
function btEquitySeries(trades) {
  const pts = [0];
  let running = 0;
  trades.filter(t => t.outcome !== 'Open').forEach(t => {
    running += t.rMade;
    pts.push(running);
  });
  return pts;
}

// ── Render result cards ───────────────────────────────────────────────────────
// ── Compute $ P&L and final balance for a trade sequence ─────────────────────
function btCalcBalance(trades, startBalance, riskPct, compound) {
  const closed = trades.filter(t => t.outcome !== 'Open');
  let balance = startBalance;
  const riskFraction = riskPct / 100;
  closed.forEach(t => {
    const riskAmount = compound ? balance * riskFraction : startBalance * riskFraction;
    balance += riskAmount * t.rMade;
  });
  return { finalBalance: balance, pnl: balance - startBalance };
}

function btRenderCards(results) {
  const best = results.reduce((a, b) => b.netR > a.netR ? b : a);
  const activeTp = parseInt(document.getElementById('bt-log-filter')?.value) || best.tp;
  const container = document.getElementById('bt-cards');

  const startBalance = parseFloat(document.getElementById('bt-balance-input')?.value) || 1000;
  const riskPct = parseFloat(document.getElementById('bt-risk-select')?.value) || 3;
  const compound = document.getElementById('bt-compound-toggle')?.checked || false;

  container.innerHTML = results.map(r => {
    const isBest = r.tp === best.tp;
    const isActive = r.tp === activeTp;
    const wr = r.winRate.toFixed(1);
    const pf = isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞';
    const netColor = r.netR >= 0 ? 'var(--green)' : 'var(--red)';
    const rowBg = isActive ? 'var(--bg2)' : 'transparent';

    const { finalBalance, pnl } = btCalcBalance(r.trades, startBalance, riskPct, compound);
    const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const pnlStr = (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toLocaleString(undefined, {maximumFractionDigits: 0});
    const balanceStr = '$' + finalBalance.toLocaleString(undefined, {maximumFractionDigits: 0});

    const closedCount = r.wins + r.losses;
    const tradesStr = r.open > 0
      ? `${closedCount} <span style="font-size:10px;color:var(--text-faint);">+${r.open} open</span>`
      : `${closedCount}`;

    return `<tr onclick="btSelectTp(${r.tp})" style="cursor:pointer;background:${rowBg};border-bottom:0.5px solid var(--line-old);">
      <td style="padding:7px 10px;font-weight:600;color:var(--text);">${r.tp}R${isBest ? ' <span style="font-size:9px;background:var(--teal);color:#07060c;border-radius:4px;padding:1px 5px;font-weight:700;margin-left:4px;">BEST</span>' : ''}</td>
      <td style="padding:7px 10px;text-align:right;color:var(--text);">${wr}%</td>
      <td style="padding:7px 10px;text-align:right;color:var(--text-faint);" title="${closedCount} closed${r.open > 0 ? ` (${r.wins}W/${r.losses}L), ${r.open} still open and excluded from win rate/PF` : ` (${r.wins}W/${r.losses}L)`}">${tradesStr}</td>
      <td style="padding:7px 10px;text-align:right;color:var(--text-faint);">${r.wins}/${r.losses}</td>
      <td style="padding:7px 10px;text-align:right;color:var(--text-faint);">${pf}</td>
      <td style="padding:7px 10px;text-align:right;color:${netColor};font-weight:600;">${r.netR >= 0 ? '+' : ''}${r.netR.toFixed(1)}</td>
      <td style="padding:7px 10px;text-align:right;color:${pnlColor};font-weight:600;">${pnlStr}</td>
      <td style="padding:7px 10px;text-align:right;color:var(--text);font-weight:600;">${balanceStr}</td>
    </tr>`;
  }).join('');
}

function btRefreshBalance() {
  if (btResults) btRenderCards(btResults);
}

function btSelectTp(tp) {
  const sel = document.getElementById('bt-log-filter');
  if (sel) sel.value = tp;
  if (btResults) btRenderCards(btResults);
  btRenderLog();
}

// ── Render equity curve canvas ────────────────────────────────────────────────
function btRenderChart(results) {
  const canvas = document.getElementById('bt-equity-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight || 220;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const series = results.map(r => btEquitySeries(r.trades));
  const allVals = series.flat();
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const range = maxV - minV || 1;
  const padL = 40, padR = 10, padT = 10, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxLen = Math.max(...series.map(s => s.length));

  // grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 0.5;
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (g / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const val = minV + (g / 4) * range;
    ctx.fillStyle = 'rgba(155,160,166,0.6)';
    ctx.font = '9px Inter,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText((val >= 0 ? '+' : '') + val.toFixed(1) + 'R', padL - 4, y + 3);
  }

  // zero line
  const zeroY = padT + plotH - ((0 - minV) / range) * plotH;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 0.8;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, zeroY); ctx.lineTo(W - padR, zeroY); ctx.stroke();
  ctx.setLineDash([]);

  // draw each series
  series.forEach((pts, idx) => {
    if (pts.length < 2) return;
    const col = BT_COLORS[idx];
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    pts.forEach((v, j) => {
      const x = padL + (j / (maxLen - 1)) * plotW;
      const y = padT + plotH - ((v - minV) / range) * plotH;
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  // legend
  const legendEl = document.getElementById('bt-curve-legend');
  legendEl.innerHTML = results.map((r, i) => `
    <span style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-dim);">
      <span style="display:inline-block;width:16px;height:2px;background:${BT_COLORS[i]};border-radius:1px;"></span>${r.tp}R
    </span>`).join('');
}

// ── Render trade log ──────────────────────────────────────────────────────────
function btRenderLog() {
  if (!btResults) return;
  const tpSel = parseInt(document.getElementById('bt-log-filter').value);
  const outSel = document.getElementById('bt-outcome-filter').value;
  const result = btResults.find(r => r.tp === tpSel);
  if (!result) return;

  let trades = result.trades;
  if (outSel !== 'all') trades = trades.filter(t => t.outcome === outSel);

  const tbody = document.getElementById('bt-log-tbody');
  tbody.innerHTML = trades.map((t, idx) => {
    const date = new Date(t.entryTs).toISOString().slice(0, 16).replace('T', ' ');
    const entryPrice = t.entry != null ? t.entry : 0;
    const sl = (entryPrice * (1 - BT_SL_PCT)).toFixed(1);
    const tp = (entryPrice * (1 + BT_SL_PCT * (t.tp || 1))).toFixed(1);
    const outcomeColor = t.outcome === 'Win' ? 'var(--green)' : t.outcome === 'Loss' ? 'var(--red)' : 'var(--text-faint)';
    return `<tr style="border-top:0.5px solid var(--line-old);">
      <td style="padding:7px 10px 7px 0;color:var(--text-faint);">${idx + 1}</td>
      <td style="padding:7px 10px 7px 0;color:var(--text-dim);">${date}</td>
      <td style="padding:7px 10px 7px 0;text-align:right;color:var(--text);">$${entryPrice.toFixed(1)}</td>
      <td style="padding:7px 10px 7px 0;text-align:right;color:var(--red);">$${sl}</td>
      <td style="padding:7px 10px 7px 0;text-align:right;color:var(--green);">$${tp}</td>
      <td style="padding:7px 0;color:${outcomeColor};font-weight:600;">${t.outcome}</td>
    </tr>`;
  }).join('');
}

// ── Price chart with 1R trade markers ────────────────────────────────────────
let btChartState = {
  offsetX: 0,       // pan offset in candle units
  scale: 1,         // zoom: candles visible = baseVisible / scale
  dragging: false,
  dragStartX: 0,
  dragStartOffset: 0,
  candles: null,
  ema: null,
  trades: null,     // trades for the currently selected TP level
  allResults: null  // all 10 TP results, keyed by tp number
};

const BT_BASE_VISIBLE = 300; // candles visible at scale=1

function btInitPriceChart(candles, ema, allResults) {
  const cs = btChartState;
  cs.candles = candles;
  cs.ema = ema;
  cs.allResults = allResults;
  const selectedTp = parseInt(document.getElementById('bt-chart-tp-select')?.value) || 1;
  const result = allResults.find(r => r.tp === selectedTp);
  cs.trades = (result ? result.trades : []).map(t => ({ ...t, entryTs: Number(t.entryTs) }));
  cs.scale = 0.3; // zoomed out to show all candles
  cs.offsetX = 0;

  const canvas = document.getElementById('bt-price-canvas');
  if (!canvas) return;

  // Remove old listeners by replacing element
  const wrap = document.getElementById('bt-price-chart-wrap');
  const newCanvas = canvas.cloneNode(false);
  wrap.replaceChild(newCanvas, canvas);

  newCanvas.addEventListener('wheel', btChartWheel, { passive: false });
  newCanvas.addEventListener('mousedown', btChartMouseDown);
  newCanvas.addEventListener('mousemove', btChartMouseMove);
  newCanvas.addEventListener('mouseup', () => { btChartState.dragging = false; });
  newCanvas.addEventListener('mouseleave', () => {
    btChartState.dragging = false;
    document.getElementById('bt-chart-tooltip').style.display = 'none';
  });

  btDrawPriceChart();
}

function btSwitchChartTp() {
  const cs = btChartState;
  if (!cs.allResults) return;
  const selectedTp = parseInt(document.getElementById('bt-chart-tp-select').value);
  const result = cs.allResults.find(r => r.tp === selectedTp);
  cs.trades = (result ? result.trades : []).map(t => ({ ...t, entryTs: Number(t.entryTs) }));
  btDrawPriceChart();
}

function btChartWheel(e) {
  e.preventDefault();
  const cs = btChartState;
  const delta = e.deltaY > 0 ? 0.85 : 1.18;
  const newScale = Math.max(0.1, Math.min(10, cs.scale * delta));
  // keep center candle stable
  const canvas = document.getElementById('bt-price-canvas');
  const visible = BT_BASE_VISIBLE / cs.scale;
  const centerCandle = cs.offsetX + visible / 2;
  cs.scale = newScale;
  const newVisible = BT_BASE_VISIBLE / newScale;
  cs.offsetX = Math.max(0, Math.min(cs.candles.length - 1, centerCandle - newVisible / 2));
  btDrawPriceChart();
}

function btChartMouseDown(e) {
  const cs = btChartState;
  cs.dragging = true;
  cs.dragStartX = e.clientX;
  cs.dragStartOffset = cs.offsetX;
}

function btChartMouseMove(e) {
  const cs = btChartState;
  const canvas = document.getElementById('bt-price-canvas');
  if (!canvas) return;
  const W = canvas.offsetWidth;
  const visible = Math.round(BT_BASE_VISIBLE / cs.scale);

  if (cs.dragging) {
    const dxPx = e.clientX - cs.dragStartX;
    const candlesPerPx = visible / W;
    cs.offsetX = Math.max(0, Math.min(cs.candles.length - visible, cs.dragStartOffset - dxPx * candlesPerPx));
    btDrawPriceChart();
    return;
  }

  // Tooltip only appears near a trade marker
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const padL = 8, padR = 60;
  const plotW = W - padL - padR;
  const candleW = plotW / visible;
  const tooltip = document.getElementById('bt-chart-tooltip');

  if (!cs.trades || !cs.trades.length) {
    tooltip.style.display = 'none';
    return;
  }

  const startIdx = Math.max(0, Math.floor(cs.offsetX));
  const endIdx = Math.min(cs.candles.length - 1, startIdx + visible);

  // Find nearest trade marker within hit radius
  const HIT_RADIUS = 10;
  let nearest = null;
  let nearestDist = Infinity;
  for (const t of cs.trades) {
    const ci = cs.candles.findIndex(c => Number(c.ts) === Number(t.entryTs));
    if (ci < startIdx || ci > endIdx) continue;
    const x = padL + (ci - startIdx + 0.5) * candleW;
    const entryY = cs._lastEntryYByIdx ? cs._lastEntryYByIdx[ci] : null;
    const dx = mx - x;
    const dy = entryY != null ? my - entryY : 0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dx >= -candleW && dx <= candleW * 1.5 && Math.abs(dist) < 40 && dist < nearestDist) {
      nearest = t;
      nearestDist = dist;
    }
  }

  if (!nearest) {
    tooltip.style.display = 'none';
    return;
  }

  const entryDate = new Date(nearest.entryTs).toISOString().slice(0,16).replace('T',' ');
  const exitDate = nearest.exitTs ? new Date(nearest.exitTs).toISOString().slice(0,16).replace('T',' ') : '—';
  const outcomeColor = nearest.outcome === 'Win' ? 'var(--green)' : nearest.outcome === 'Loss' ? 'var(--red)' : 'var(--amber)';
  const exitPriceStr = nearest.exitPrice ? '$' + nearest.exitPrice.toLocaleString(undefined,{maximumFractionDigits:0}) : '—';

  let html = `<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;">`;
  html += `<span style="color:var(--text-faint);">Date</span><span>${entryDate}</span>`;
  html += `<span style="color:var(--text-faint);">Entry</span><span>$${nearest.entry.toLocaleString(undefined,{maximumFractionDigits:0})}</span>`;
  html += `<span style="color:var(--text-faint);">Exit</span><span>${exitPriceStr}</span>`;
  if (nearest.outcome !== 'Open') {
    html += `<span style="color:var(--text-faint);">Exit date</span><span>${exitDate}</span>`;
  }
  html += `<span style="color:var(--text-faint);">Result</span><span style="color:${outcomeColor};font-weight:600;">${nearest.outcome}</span>`;
  html += `</div>`;

  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  const tx = mx + 12 > rect.width - 170 ? mx - 165 : mx + 12;
  tooltip.style.left = tx + 'px';
  tooltip.style.top = (my - 10) + 'px';
}

function btDrawPriceChart() {
  const cs = btChartState;
  const canvas = document.getElementById('bt-price-canvas');
  if (!canvas || !cs.candles) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight || 340;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const visible = Math.round(BT_BASE_VISIBLE / cs.scale);
  const startIdx = Math.max(0, Math.floor(cs.offsetX));
  const endIdx = Math.min(cs.candles.length - 1, startIdx + visible);
  const slice = cs.candles.slice(startIdx, endIdx + 1);
  if (!slice.length) return;

  const padL = 8, padR = 60, padT = 16, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // price range with padding
  let minP = Math.min(...slice.map(c => c.l));
  let maxP = Math.max(...slice.map(c => c.h));
  // include EMA
  slice.forEach((c, i) => {
    const ev = cs.ema[startIdx + i];
    if (ev) { minP = Math.min(minP, ev); maxP = Math.max(maxP, ev); }
  });
  // include SL/TP lines from trades in view
  if (cs.trades) {
    cs.trades.forEach(t => {
      if (t.entryTs >= slice[0].ts && t.entryTs <= slice[slice.length-1].ts) {
        minP = Math.min(minP, t.entry * (1 - BT_SL_PCT));
        maxP = Math.max(maxP, t.entry * (1 + BT_SL_PCT * t.tp));
      }
    });
  }
  const pRange = (maxP - minP) || 1;
  const pad5 = pRange * 0.05;
  minP -= pad5; maxP += pad5;
  const range = maxP - minP;

  const yOf = p => padT + plotH - ((p - minP) / range) * plotH;
  const candleW = plotW / slice.length;
  const bodyW = Math.max(1, candleW * 0.6);

  // Background
  ctx.fillStyle = '#0a090f';
  ctx.fillRect(0, 0, W, H);

  // Grid lines + price labels
  const gridLines = 5;
  for (let g = 0; g <= gridLines; g++) {
    const p = minP + (g / gridLines) * range;
    const y = yOf(p);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(155,160,166,0.5)';
    ctx.font = '9px Inter,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('$' + p.toLocaleString(undefined, {maximumFractionDigits: 0}), W - padR + 4, y + 3);
  }

  // EMA line
  ctx.strokeStyle = 'rgba(40,215,200,0.7)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let emaStarted = false;
  slice.forEach((c, i) => {
    const ev = cs.ema[startIdx + i];
    if (!ev) return;
    const x = padL + (i + 0.5) * candleW;
    const y = yOf(ev);
    if (!emaStarted) { ctx.moveTo(x, y); emaStarted = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Candles
  slice.forEach((c, i) => {
    const x = padL + (i + 0.5) * candleW;
    const isBull = c.c >= c.o;
    const col = isBull ? '#3ddc97' : '#e2645f';
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 0.8;

    // wick
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.h));
    ctx.lineTo(x, yOf(c.l));
    ctx.stroke();

    // body
    const yTop = yOf(Math.max(c.o, c.c));
    const yBot = yOf(Math.min(c.o, c.c));
    const bodyH = Math.max(1, yBot - yTop);
    if (isBull) {
      ctx.fillRect(x - bodyW / 2, yTop, bodyW, bodyH);
    } else {
      ctx.strokeRect(x - bodyW / 2, yTop, bodyW, bodyH);
    }
  });

  // Trade markers
  cs._lastEntryYByIdx = {};
  if (cs.trades) {
    cs.trades.forEach(t => {
      const ci = cs.candles.findIndex(c => Number(c.ts) === Number(t.entryTs));
      if (ci < startIdx || ci > endIdx) return;
      const i = ci - startIdx;
      const x = padL + (i + 0.5) * candleW;
      const entryY = yOf(t.entry);
      const slY = yOf(t.entry * (1 - BT_SL_PCT));
      const tpY = yOf(t.entry * (1 + BT_SL_PCT * t.tp));
      const outcomeColor = t.outcome === 'Win' ? '#3ddc97' : t.outcome === 'Loss' ? '#e2645f' : '#d9a93f';
      cs._lastEntryYByIdx[ci] = entryY;

      // SL line (red dashed)
      ctx.strokeStyle = 'rgba(226,100,95,0.5)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.max(padL, x - candleW * 2), slY);
      ctx.lineTo(Math.min(W - padR, x + candleW * 8), slY);
      ctx.stroke();

      // TP line (green dashed)
      ctx.strokeStyle = 'rgba(61,220,151,0.5)';
      ctx.beginPath();
      ctx.moveTo(Math.max(padL, x - candleW * 2), tpY);
      ctx.lineTo(Math.min(W - padR, x + candleW * 8), tpY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Entry triangle
      ctx.fillStyle = outcomeColor;
      ctx.beginPath();
      ctx.moveTo(x, entryY - 7);
      ctx.lineTo(x - 4, entryY - 1);
      ctx.lineTo(x + 4, entryY - 1);
      ctx.closePath();
      ctx.fill();

      // Entry dot
      ctx.beginPath();
      ctx.arc(x, entryY, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Date labels
  const labelEvery = Math.max(1, Math.floor(visible / 6));
  ctx.fillStyle = 'rgba(155,160,166,0.5)';
  ctx.font = '9px Inter,sans-serif';
  ctx.textAlign = 'center';
  slice.forEach((c, i) => {
    if (i % labelEvery !== 0) return;
    const x = padL + (i + 0.5) * candleW;
    const d = new Date(c.ts);
    const label = d.toISOString().slice(0, 7);
    ctx.fillText(label, x, H - 6);
  });
}

// ── Debug panel copy ───────────────────────────────────────────────────────────
// ── Range mode toggle ─────────────────────────────────────────────────────────
function btToggleRangeMode() {
  const mode = document.getElementById('bt-range-mode-select').value;
  document.getElementById('bt-custom-range-controls').style.display = mode === 'custom' ? 'flex' : 'none';
  document.getElementById('bt-bull-range-controls').style.display = mode === 'bull' ? 'flex' : 'none';
}

function btCopyDebug() {
  const ta = document.getElementById('bt-debug-output');
  ta.select();
  ta.setSelectionRange(0, 999999);
  navigator.clipboard.writeText(ta.value).then(() => {
    const btn = event.target.closest('button');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="ti ti-check" style="font-size:12px;vertical-align:-1px;margin-right:4px;"></i>Copied';
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  }).catch(() => {
    document.execCommand('copy');
  });
}

async function btRun() {
  const btn = document.getElementById('bt-run-btn');
  const statusEl = document.getElementById('bt-status');
  const emptyEl = document.getElementById('bt-empty');
  const resultsEl = document.getElementById('bt-results-grid');

  btn.disabled = true;
  btn.style.opacity = '0.5';
  emptyEl.style.display = 'flex';
  resultsEl.style.display = 'none';
  statusEl.textContent = 'Starting…';

  btDebug = document.getElementById('bt-debug-toggle').checked;
  btDebugLog = [];
  const debugPanel = document.getElementById('bt-debug-panel');
  debugPanel.style.display = btDebug ? 'block' : 'none';

  const slInput = document.getElementById('bt-sl-input');
  let slPctVal = parseFloat(slInput.value);
  if (!isFinite(slPctVal) || slPctVal <= 0) slPctVal = 3;
  slInput.value = slPctVal;
  BT_SL_PCT = slPctVal / 100;

  const rangeMode = document.getElementById('bt-range-mode-select').value;
  let fromLabel, toLabel;

  if (rangeMode === 'bull') {
    const bullPeriod = document.getElementById('bt-bull-period-select').value;
    if (bullPeriod === 'bull1') {
      BT_START_TS = BT_BULL_1[0];
      BT_END_TS = BT_BULL_1[1];
      BT_INCLUDE_WINDOWS = [BT_BULL_1];
      fromLabel = 'Feb 2019'; toLabel = 'Nov 2021';
    } else if (bullPeriod === 'bull2') {
      BT_START_TS = BT_BULL_2[0];
      BT_END_TS = BT_BULL_2[1];
      BT_INCLUDE_WINDOWS = [BT_BULL_2];
      fromLabel = 'Dec 2022'; toLabel = 'Oct 2025';
    } else {
      // both periods combined: fetch the full superset, then trim to the two windows
      BT_START_TS = BT_BULL_1[0];
      BT_END_TS = BT_BULL_2[1];
      BT_INCLUDE_WINDOWS = [BT_BULL_1, BT_BULL_2];
      fromLabel = 'Feb 2019 + Dec 2022'; toLabel = 'Nov 2021 + Oct 2025';
    }
  } else {
    BT_INCLUDE_WINDOWS = null;
    const startYear = document.getElementById('bt-start-year-select').value;
    BT_START_TS = startYear === '2020'
      ? 1583020800000 // Mar 1 2020
      : Date.UTC(parseInt(startYear), 0, 1);

    const endYear = document.getElementById('bt-end-year-select').value;
    BT_END_TS = endYear === 'now'
      ? Date.now()
      : Date.UTC(parseInt(endYear) + 1, 0, 1) - 1; // end of Dec that year

    fromLabel = startYear === '2020' ? 'Mar 2020' : `Jan ${startYear}`;
    toLabel = endYear === 'now' ? 'Now' : `Dec ${endYear}`;
  }

  if (BT_END_TS <= BT_START_TS) {
    statusEl.textContent = 'Error: end date must be after start date';
    btn.disabled = false;
    btn.style.opacity = '1';
    return;
  }

  try {
    // Fetch candles (superset range; windows are applied after EMA calc)
    let candles = await btFetchCandles();
    statusEl.textContent = `${candles.length.toLocaleString()} candles loaded — computing EMA…`;

    // EMA on the full continuous superset first, for accuracy
    const closes = candles.map(c => c.c);
    let ema = btCalcEMA(closes, BT_EMA_PERIOD);

    // Now trim to the configured windows (no-op in custom range mode)
    ({ candles, ema } = btApplyIncludeWindows(candles, ema));
    btData = candles;

    if (!candles.length) {
      statusEl.textContent = 'Error: no candles in selected range';
      btn.disabled = false;
      btn.style.opacity = '1';
      return;
    }

    // Run all TP levels
    statusEl.textContent = 'Running backtest…';
    btResults = BT_TP_LEVELS.map(tp => {
      const trades = btRunLevel(candles, ema, tp);
      return btSummarise(trades, tp);
    });

    if (btDebug) {
      document.getElementById('bt-debug-output').value = btDebugLog.length
        ? btDebugLog.join('\n')
        : '(no rejected candles found within 3% of EMA)';
    }

    // Render
    emptyEl.style.display = 'none';
    resultsEl.style.display = 'block';
    btRenderCards(btResults);
    // Wait for canvas to be visible and sized
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        btRenderChart(btResults);
        btInitPriceChart(candles, ema, btResults);
      } catch(renderErr) {
        statusEl.textContent = 'Render error: ' + renderErr.message;
        console.error('[Backtest render]', renderErr);
      }
    }));
    btRenderLog();

    const best = btResults.reduce((a, b) => b.netR > a.netR ? b : a);
    statusEl.textContent = `Done · ${fromLabel} → ${toLabel} · SL ${slPctVal}% · ${candles.length.toLocaleString()} candles · Best: ${best.tp}R (${best.winRate.toFixed(1)}% WR, +${best.netR.toFixed(1)}R net)`;
  } catch(e) {
    statusEl.textContent = 'Error: ' + e.message;
    console.error('[Backtest]', e);
  }

  btn.disabled = false;
  btn.style.opacity = '1';
}

// ── Parameter Grid (SL x TP heatmap) ──────────────────────────────────────────
let btGridResults = null; // { slPct: number, cells: [{ tp, ...summary, finalBalance, pnl }] }[]
const BT_GRID_MIN_CLOSED = 15; // below this, flag as low-sample

function btRunGrid() {
  const statusEl = document.getElementById('bt-grid-status');
  const btn = document.getElementById('bt-grid-run-btn');

  if (!btData || !btData.length) {
    statusEl.textContent = 'Run a backtest above first — the grid reuses those candles.';
    return;
  }

  const slMin = parseFloat(document.getElementById('bt-grid-sl-min').value);
  const slMax = parseFloat(document.getElementById('bt-grid-sl-max').value);
  const slStep = parseFloat(document.getElementById('bt-grid-sl-step').value);

  if (!isFinite(slMin) || !isFinite(slMax) || !isFinite(slStep) || slStep <= 0 || slMax < slMin) {
    statusEl.textContent = 'Error: check SL range/step values';
    return;
  }

  const slValues = [];
  for (let v = slMin; v <= slMax + 1e-9; v += slStep) {
    slValues.push(Math.round(v * 100) / 100);
  }
  const cellCount = slValues.length * BT_TP_LEVELS.length;
  if (cellCount > 400) {
    statusEl.textContent = `Error: ${cellCount} combos is too many — narrow the SL range or widen the step`;
    return;
  }

  btn.disabled = true;
  btn.style.opacity = '0.5';
  statusEl.textContent = `Running ${cellCount} combos…`;

  // Recompute EMA once on btData (already trimmed to the active range/windows)
  const closes = btData.map(c => c.c);
  const ema = btCalcEMA(closes, BT_EMA_PERIOD);

  const startBalance = parseFloat(document.getElementById('bt-balance-input')?.value) || 1000;
  const riskPct = parseFloat(document.getElementById('bt-risk-select')?.value) || 3;
  const compound = document.getElementById('bt-compound-toggle')?.checked || false;

  btGridResults = slValues.map(slPct => {
    const prevSlPct = BT_SL_PCT;
    BT_SL_PCT = slPct / 100;
    const cells = BT_TP_LEVELS.map(tp => {
      const trades = btRunLevel(btData, ema, tp);
      const summary = btSummarise(trades, tp);
      const { finalBalance, pnl } = btCalcBalance(trades, startBalance, riskPct, compound);
      return { ...summary, finalBalance, pnl };
    });
    BT_SL_PCT = prevSlPct;
    return { slPct, cells };
  });

  statusEl.textContent = `Done · ${slValues.length} SL levels × ${BT_TP_LEVELS.length} TP levels = ${cellCount} combos`;
  btRenderGrid();

  btn.disabled = false;
  btn.style.opacity = '1';
}

function btGridMetricValue(cell, metric) {
  if (metric === 'pf') return isFinite(cell.profitFactor) ? cell.profitFactor : (cell.wins > 0 ? 99 : 0);
  if (metric === 'netR') return cell.netR;
  if (metric === 'balance') return cell.pnl;
  if (metric === 'winRate') return cell.winRate;
  return 0;
}

function btGridColorFor(value, metric) {
  // thresholds tuned per metric so the gradient is meaningful at a glance
  let stops;
  if (metric === 'pf') {
    stops = [{v:0.5,c:[226,100,95]},{v:1.0,c:[217,169,63]},{v:1.5,c:[120,190,140]},{v:2.5,c:[61,220,151]}];
  } else if (metric === 'winRate') {
    stops = [{v:20,c:[226,100,95]},{v:40,c:[217,169,63]},{v:55,c:[120,190,140]},{v:75,c:[61,220,151]}];
  } else {
    // netR and balance(pnl): symmetric around 0
    const mag = Math.max(Math.abs(value), 1);
    stops = [{v:-mag,c:[226,100,95]},{v:0,c:[217,169,63]},{v:mag*0.5,c:[120,190,140]},{v:mag,c:[61,220,151]}];
  }
  if (value <= stops[0].v) return `rgb(${stops[0].c.join(',')})`;
  if (value >= stops[stops.length-1].v) return `rgb(${stops[stops.length-1].c.join(',')})`;
  let lo = stops[0], hi = stops[stops.length-1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (value >= stops[i].v && value <= stops[i+1].v) { lo = stops[i]; hi = stops[i+1]; break; }
  }
  const t = (value - lo.v) / (hi.v - lo.v || 1);
  const c = lo.c.map((ch,i) => Math.round(ch + (hi.c[i]-ch)*t));
  return `rgb(${c.join(',')})`;
}

function btGridFormatValue(cell, metric) {
  if (metric === 'pf') return isFinite(cell.profitFactor) ? cell.profitFactor.toFixed(2) : '∞';
  if (metric === 'netR') return (cell.netR >= 0 ? '+' : '') + cell.netR.toFixed(1);
  if (metric === 'balance') return (cell.pnl >= 0 ? '+$' : '-$') + Math.abs(cell.pnl).toLocaleString(undefined, {maximumFractionDigits: 0});
  if (metric === 'winRate') return cell.winRate.toFixed(0) + '%';
  return '';
}

function btRenderGrid() {
  const wrap = document.getElementById('bt-grid-wrap');
  const legend = document.getElementById('bt-grid-legend');
  const legendLabel = document.getElementById('bt-grid-legend-label');
  if (!btGridResults) { wrap.innerHTML = ''; legend.style.display = 'none'; return; }

  const metric = document.getElementById('bt-grid-metric-select').value;
  const metricLabels = { pf: 'Profit factor', netR: 'Net R', balance: 'P&L ($)', winRate: 'Win rate' };
  legendLabel.textContent = metricLabels[metric];
  legend.style.display = 'flex';

  let html = '<table style="border-collapse:collapse;font-size:11px;width:100%;table-layout:fixed;">';
  html += '<thead><tr><th style="width:54px;padding:4px;text-align:left;color:var(--text-faint);font-weight:600;font-size:10px;">SL ＼ TP</th>';
  BT_TP_LEVELS.forEach(tp => {
    html += `<th style="padding:4px;text-align:center;color:var(--text-faint);font-weight:600;font-size:10px;">${tp}R</th>`;
  });
  html += '</tr></thead><tbody>';

  // find best cell overall for this metric to highlight it
  let best = null;
  let bestVal = -Infinity;
  btGridResults.forEach(row => row.cells.forEach(cell => {
    const closedCount = cell.wins + cell.losses;
    if (closedCount < BT_GRID_MIN_CLOSED) return;
    const v = btGridMetricValue(cell, metric);
    if (v > bestVal) { bestVal = v; best = { slPct: row.slPct, tp: cell.tp }; }
  }));

  btGridResults.forEach(row => {
    html += `<tr><td style="padding:4px;color:var(--text-dim);font-weight:600;">${row.slPct}%</td>`;
    row.cells.forEach(cell => {
      const closedCount = cell.wins + cell.losses;
      const lowSample = closedCount < BT_GRID_MIN_CLOSED;
      const v = btGridMetricValue(cell, metric);
      const bg = btGridColorFor(v, metric);
      const isBest = best && best.slPct === row.slPct && best.tp === cell.tp;
      const valStr = btGridFormatValue(cell, metric);
      const tooltip = `SL ${row.slPct}% / TP ${cell.tp}R — PF ${isFinite(cell.profitFactor) ? cell.profitFactor.toFixed(2) : '∞'}, ${cell.winRate.toFixed(0)}% WR, ${closedCount} closed (${cell.wins}W/${cell.losses}L), ${cell.open} open, net ${cell.netR >= 0 ? '+' : ''}${cell.netR.toFixed(1)}R`;
      html += `<td title="${tooltip}" style="padding:4px;text-align:center;background:${bg};border-radius:3px;${isBest ? 'box-shadow:inset 0 0 0 1.5px #07060c;' : ''}">
        <div style="color:#07060c;font-weight:700;">${valStr}</div>
        <div style="font-size:9px;color:#07060c;opacity:0.75;${lowSample ? 'font-style:italic;' : ''}">${closedCount}t${lowSample ? ' ⚠' : ''}</div>
      </td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

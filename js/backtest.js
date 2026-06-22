// ===================== BACKTESTING ENGINE =====================
// Strategy: BTC 4H candle wicks into 4H 200 EMA from above → long entry at candle close
// SL: 3% below entry (= 1R). TP tested at 1R–10R independently.
// Cooldown: 20 candles after SL hit before next entry.
// Data: Binance spot kline API (api.binance.com/api/v3/klines), paginated forward from warmup start.

const BT_SYMBOL = 'BTCUSDT';
const BT_INTERVAL = '4h'; // Binance 4H interval enum
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

// EMA warmup: fetch this many 4H candles before the period start for EMA seeding.
// 1,000 candles = ~167 days of continuous history before the first tradable candle.
// These candles are used only for EMA calculation — no entries or state changes occur
// before BT_START_TS. BT_WARMUP_START_TS is set alongside BT_START_TS at run time.
const BT_WARMUP_CANDLES = 1000;
let BT_WARMUP_START_TS = null; // set at run time: BT_START_TS minus 1000 x 4H
let btDebug = false; // set window.btDebug = true in console to log near-EMA rejected candles
Object.defineProperty(window, 'btDebug', { get: () => btDebug, set: v => { btDebug = v; } });
let btDebugLog = [];

// palette for equity curves
const BT_COLORS = [
  '#28d7c8','#3ddc97','#9b8ae8','#d9a93f','#e2645f',
  '#5aabf0','#f07850','#c8e028','#e028c8','#28a0e0',
  '#ff9f43','#54a0ff','#5f27cd'
];

let btData = null;          // window-trimmed candles (for grid display)
let btResults = null;       // combined results per TP level (for UI cards/chart)
let btPeriodResults = null; // { bull1: [...], bull2: [...] } — per-period summaries (Buckets 4-6)
let btFullEma = null;       // warmup-inclusive EMA aligned to btAllCandles (for grid reuse)
let btAllCandles = null;    // full warmup+period candle array (for EMA index lookup)
let btWindowSlices = null;  // [{ wStart, wEnd, periodId, sliceCandles, sliceEma }] (bull mode)

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

// ── Fetch all 4H candles from BT_WARMUP_START_TS to BT_END_TS ─────────────────
// Uses Binance spot BTCUSDT kline API — history available from Aug 2017, covering
// all of Bull Run 1 (Feb 2019) and the required warmup (back to ~Aug 2018).
// Bybit linear BTCUSDT only launched Mar 2020 and cannot cover Bull Run 1 at all.
//
// Binance pagination differs from Bybit:
//   - Response is oldest-first (no sort needed)
//   - Paginate FORWARDS using startTime, not backwards using end
//   - Interval param is '4h' string, not minutes
//   - Response fields: [openTime, open, high, low, close, volume, closeTime, ...]
async function btFetchCandles() {
  const statusEl = document.getElementById('bt-status');
  const allCandles = [];
  const limit = 1000;
  const fetchStart = BT_WARMUP_START_TS !== null ? BT_WARMUP_START_TS : BT_START_TS;
  let startTime = fetchStart;

  // Hard pre-flight: if Binance cannot possibly have data for this window, fail fast.
  // Binance BTCUSDT spot launched August 2017 — nothing before that exists.
  const BINANCE_BTCUSDT_LAUNCH_MS = Date.UTC(2017, 7, 17); // Aug 17 2017
  if (fetchStart < BINANCE_BTCUSDT_LAUNCH_MS) {
    throw new Error(
      `Requested warmup start ${new Date(fetchStart).toISOString().slice(0,10)} is before ` +
      `Binance BTCUSDT launch (2017-08-17). Reduce BT_WARMUP_CANDLES or adjust the period.`
    );
  }

  while (startTime <= BT_END_TS) {
    statusEl.textContent = `Fetching candles… ${allCandles.length.toLocaleString()} loaded`;
    const url = `https://api.binance.com/api/v3/klines?symbol=${BT_SYMBOL}&interval=${BT_INTERVAL}&limit=${limit}&startTime=${startTime}&endTime=${BT_END_TS}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API error ${res.status}: ${await res.text()}`);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;

    // Binance returns oldest-first: [openTime, open, high, low, close, volume, closeTime, ...]
    for (const c of list) {
      allCandles.push({
        ts: c[0],           // open time ms
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4])
      });
    }

    if (list.length < limit) break; // last page — no more data
    // Advance: next page starts 1ms after the last candle's open time
    startTime = list[list.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 80)); // rate limit buffer
  }

  // Binance returns oldest-first already — no sort needed.
  // Clamp to [fetchStart, BT_END_TS] to discard any edge-page overshoot.
  return allCandles.filter(c => c.ts >= fetchStart && c.ts <= BT_END_TS);
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

// ── Run backtest for one period × one TP level ───────────────────────────────
// candles / ema : index-aligned arrays for ONE contiguous period (already trimmed
//                 from the full warmup-inclusive sequence — EMA values are warm).
// periodStart   : first tradable timestamp for this period (entries blocked before it).
// periodEnd     : final timestamp of this period (used for end-of-period close).
// tpMultiple    : TP as a multiple of SL (1R, 2R, … 100R).
// periodId      : string label attached to every trade ('bull1' | 'bull2' | 'custom').
//
// Bucket 3 guarantees:
//   • Starts flat — cooldown=0, inTrade=null — no state carried from another period.
//   • No seam detection — one contiguous period per call, seams do not occur.
//   • End-of-period close — any trade still open on the final candle is closed at
//     that candle's close price, labelled 'test_end_exit', and counted in realized P&L.
//     rMade is computed as (exitPrice / entry - 1) / slPct so it is in R units.
//   • Entry guard uses periodStart param, not the BT_START_TS global.
function btRunPeriod(candles, ema, tpMultiple, periodStart, periodEnd, periodId) {
  const slPct = BT_SL_PCT;
  const tpPct = BT_SL_PCT * tpMultiple;
  const trades = [];
  let cooldown = 0;
  let inTrade = null;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const emaVal = ema[i];

    if (!emaVal) { if (cooldown > 0) cooldown--; continue; }

    // ── In-trade: check SL / TP on this candle ───────────────────────────────
    if (inTrade) {
      const slPrice = inTrade.entry * (1 - slPct);
      const tpPrice = inTrade.entry * (1 + tpPct);

      // SL-first: if both levels touched on same candle, SL wins (conservative)
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

    // Entry guard: periodStart blocks any warmup candles that may precede the
    // tradable window in the slice (should not occur after correct slicing, but
    // this is a belt-and-suspenders check matching Bucket 1 intent).
    if (c.ts < periodStart) continue;

    // ── Entry condition ───────────────────────────────────────────────────────
    const prevEma = ema[i - 1];
    const prevClose = candles[i - 1].c;
    const wasBelow = prevClose < prevEma;
    const isBullish = c.c > c.o;
    const closedAbove = c.c > emaVal;

    if (wasBelow && isBullish && closedAbove) {
      inTrade = {
        periodId,
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
          `  [${periodId}] ENTRY close=` + c.c.toFixed(1) + ' open=' + c.o.toFixed(1) +
          ' ema=' + emaVal.toFixed(1) +
          '  prevClose=' + prevClose.toFixed(1) + ' prevEma=' + prevEma.toFixed(1)
        );
      }
    } else if (btDebug && tpMultiple === 1 && prevEma != null && Math.abs(c.c - emaVal) / emaVal < 0.10) {
      let reason = [];
      if (!wasBelow) reason.push('prev close was already above EMA');
      if (!isBullish) reason.push('candle not bullish');
      if (!closedAbove) reason.push('close did not end above EMA');
      if (cooldown > 0) reason.push('in cooldown (' + cooldown + ' left)');
      btDebugLog.push(
        new Date(c.ts).toISOString().slice(0,16).replace('T',' ') +
        `  [${periodId}]  close=` + c.c.toFixed(1) + ' open=' + c.o.toFixed(1) +
        ' ema=' + emaVal.toFixed(1) +
        '  prevClose=' + prevClose.toFixed(1) + ' prevEma=' + prevEma.toFixed(1) +
        '  -> ' + (reason.length ? reason.join(', ') : 'unknown')
      );
    }
  }

  // ── End-of-period close ───────────────────────────────────────────────────
  // Any trade still open at the last candle is force-closed at that candle's
  // close price and counted as realized. It must not be ignored or carried forward.
  if (inTrade) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle.c;
    // R made = (exit / entry - 1) / slPct  (positive = profit, negative = loss)
    const rMade = (exitPrice / inTrade.entry - 1) / slPct;
    inTrade.outcome = 'test_end_exit';
    inTrade.exitPrice = exitPrice;
    inTrade.exitTs = lastCandle.ts;
    inTrade.rMade = rMade;
    trades.push(inTrade);
    inTrade = null;
  }

  return trades;
}

// ── Summarise trades for one period × one TP level ───────────────────────────
// 'test_end_exit' trades are realized (closed at final candle's close) and
// counted in wins/losses based on rMade sign. 'Open' never appears after
// Bucket 3 — the field is kept for safety but should always be 0.
function btSummarise(trades, tpMultiple) {
  const closed = trades.filter(t => t.outcome !== 'Open');
  // test_end_exit: classify by rMade sign so they contribute to win rate / PF
  const wins    = closed.filter(t => t.outcome === 'Win' || (t.outcome === 'test_end_exit' && t.rMade > 0));
  const losses  = closed.filter(t => t.outcome === 'Loss' || (t.outcome === 'test_end_exit' && t.rMade <= 0));
  const winRate = closed.length ? (wins.length / closed.length * 100) : 0;
  // netR sums actual rMade values (test_end_exit uses fractional R, not integer)
  const netR = closed.reduce((sum, t) => sum + (t.rMade || 0), 0);
  const grossWin  = wins.reduce((sum, t)   => sum + Math.max(0, t.rMade || 0), 0);
  const grossLoss = losses.reduce((sum, t) => sum + Math.abs(Math.min(0, t.rMade || 0)), 0);
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss) : wins.length > 0 ? Infinity : 0;
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
  // Reset opt-grid and rank state whenever a new backtest run begins.
  // btOptGrid / btOptGridParams are cleared so that btRunFiltersAndRank()
  // cannot use results from a prior opt-grid run on different data.
  btWindowSlices  = null;
  btOptGrid       = null;
  btOptGridParams = null;
  btEnableOptGridBtn();
  // Clear the rank output and reset the rank button label
  const rankWrap = document.getElementById('bt-rank-wrap');
  if (rankWrap) rankWrap.innerHTML = '';
  const rankStatus = document.getElementById('bt-rank-status');
  if (rankStatus) rankStatus.textContent = '';
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
    // Set warmup start: fetch 1,000 x 4H candles before the period start for EMA seeding.
    // For Bull Run 2 and combined mode, BT_START_TS is already Feb 2019 or earlier,
    // so warmup is naturally covered. For Bull Run 1 (Feb 2019) this pushes the fetch
    // back ~167 days to ~Aug 2018, giving the EMA a well-seeded starting value.
    BT_WARMUP_START_TS = BT_START_TS - (BT_WARMUP_CANDLES * BT_INTERVAL_MS);

    // Fetch candles (warmup + full period; windows applied after EMA calc)
    let allCandles = await btFetchCandles();

    // ── HARD VALIDATION: data source must have reached the requested warmup start ──
    // If the earliest returned candle is later than BT_WARMUP_START_TS, the data
    // source hit its history wall before our warmup window. The EMA will be
    // under-seeded and results cannot be trusted. Stop immediately.
    if (allCandles.length === 0) {
      throw new Error('No candles returned from data source. Check symbol and date range.');
    }
    const actualFetchStart = allCandles[0].ts;
    const warmupSlackMs = BT_INTERVAL_MS * 3; // allow up to 3 candles of slack for exchange open gaps
    if (actualFetchStart > BT_WARMUP_START_TS + warmupSlackMs) {
      const requested = new Date(BT_WARMUP_START_TS).toISOString().slice(0,10);
      const actual    = new Date(actualFetchStart).toISOString().slice(0,10);
      throw new Error(
        `DATA SOURCE TOO SHORT: requested warmup back to ${requested} but earliest candle is ${actual}. ` +
        `The EMA cannot be properly seeded. Switch to a data source with longer history or shorten the warmup window.`
      );
    }

    // Compute EMA on the full warmup+period sequence for accuracy
    const allCloses = allCandles.map(c => c.c);
    let allEma = btCalcEMA(allCloses, BT_EMA_PERIOD);

    // Build audit summary before trimming to trade windows
    const warmupCandles = allCandles.filter(c => c.ts < BT_START_TS);
    const periodCandles = allCandles.filter(c => c.ts >= BT_START_TS);
    const firstTradable = periodCandles[0];
    const warmupStart = allCandles[0];

    // Detect 4H candle gaps in the full fetched set (anything > 2× interval is a gap)
    const gapThresholdMs = BT_INTERVAL_MS * 2;
    const gaps = [];
    for (let gi = 1; gi < allCandles.length; gi++) {
      const diff = allCandles[gi].ts - allCandles[gi - 1].ts;
      if (diff > gapThresholdMs) {
        gaps.push(
          `  ${new Date(allCandles[gi - 1].ts).toISOString().slice(0,10)} → ` +
          `${new Date(allCandles[gi].ts).toISOString().slice(0,10)} ` +
          `(${Math.round(diff / BT_INTERVAL_MS)} candles missing)`
        );
      }
    }

    // Selected period label
    const periodLabel = rangeMode === 'bull'
      ? (document.getElementById('bt-bull-period-select')?.value === 'bull1' ? 'Bull Run 1 (Feb 2019 – Nov 2021)'
        : document.getElementById('bt-bull-period-select')?.value === 'bull2' ? 'Bull Run 2 (Dec 2022 – Oct 2025)'
        : 'Both Bull Runs combined')
      : `Custom (${fromLabel} → ${toLabel})`;

    const firstTradableIdx = firstTradable ? allCandles.indexOf(firstTradable) : -1;
    const emaWarm = firstTradableIdx >= 0 && allEma[firstTradableIdx] !== null ? 'YES' : 'NO — PROBLEM';

    const auditLines = [
      `=== BUCKET 1 DATA AUDIT ===`,
      `Data source                : Binance spot REST API (api.binance.com/api/v3/klines)`,
      `Instrument                 : ${BT_SYMBOL} spot — canonical historical signal proxy`,
      `  NOTE: live execution (if any) would use a separate instrument (e.g. Bybit`,
      `        BTCUSDT perp). Spot price is the correct backtest reference; the Bybit`,
      `        linear contract did not exist before 2020-03-30 and cannot cover Bull Run 1.`,
      `Interval                   : ${BT_INTERVAL} (4-hour candles)`,
      `Selected period            : ${periodLabel}`,
      `Warmup fetch start (requested): ${new Date(BT_WARMUP_START_TS).toISOString().slice(0,10)}`,
      `Actual first fetched candle: ${warmupStart ? new Date(warmupStart.ts).toISOString().slice(0,10) : 'n/a'}`,
      `Warmup candles requested   : ${BT_WARMUP_CANDLES}`,
      `Warmup candles actually fetched: ${warmupCandles.length}`,
      `Official period start      : ${new Date(BT_START_TS).toISOString().slice(0,10)}`,
      `First eligible trade candle: ${firstTradable ? new Date(firstTradable.ts).toISOString().slice(0,10) : 'n/a'}`,
      `Total candles fetched      : ${allCandles.length}`,
      `EMA warm at first eligible candle: ${emaWarm}`,
      `Detected 4H candle gaps    : ${gaps.length === 0 ? 'none' : gaps.length + ' gap(s):\n' + gaps.join('\n')}`,
      `===========================`,
    ].join('\n');
    console.log(auditLines);

    // Write audit into textarea. It is stored separately so the entry/rejection log
    // written below (when debug mode is on) never overwrites it.
    const debugEl = document.getElementById('bt-debug-output');
    const _btAuditBlock = auditLines; // captured in closure for re-prepend below

    statusEl.textContent = `${allCandles.length.toLocaleString()} candles loaded (${warmupCandles.length} warmup + ${periodCandles.length} period) — computing EMA…`;

    // Trim to trade windows now (no-op in custom range mode)
    // Use allCandles/allEma so window filter sees the full index-aligned arrays
    let candles = allCandles;
    let ema = allEma;
    ({ candles, ema } = btApplyIncludeWindows(candles, ema));

    // After window trim, enforce the entry guard at candle level (belt-and-suspenders:
    // btRunPeriod also checks c.ts >= periodStart before opening any trade)
    btData = candles;

    if (!candles.length) {
      statusEl.textContent = 'Error: no candles in selected range';
      btn.disabled = false;
      btn.style.opacity = '1';
      return;
    }

    // Run all TP levels
    // In bull mode: run each period independently so state never bleeds across.
    // In custom mode: single period run.
    statusEl.textContent = 'Running backtest…';

    if (rangeMode === 'bull' && BT_INCLUDE_WINDOWS && BT_INCLUDE_WINDOWS.length > 0) {
      // Slice candles/ema to each window from the full warmup-inclusive arrays.
      // EMA values at window boundaries are already warm — no recalculation.
      const windowSlices = BT_INCLUDE_WINDOWS.map(([wStart, wEnd], wi) => {
        const ids = ['bull1', 'bull2'];
        const periodId = ids[wi] || `period${wi + 1}`;
        const sliceCandles = allCandles.filter(c => c.ts >= wStart && c.ts <= wEnd);
        // ema is index-aligned with allCandles — find matching indices
        const sliceEma = sliceCandles.map(c => {
          const idx = allCandles.indexOf(c);
          return allEma[idx];
        });
        return { wStart, wEnd, periodId, sliceCandles, sliceEma };
      });

      // Run each period independently, accumulate combined trade list per TP level
      btResults = BT_TP_LEVELS.map(tp => {
        const allTrades = [];
        windowSlices.forEach(({ wStart, wEnd, periodId, sliceCandles, sliceEma }) => {
          const trades = btRunPeriod(sliceCandles, sliceEma, tp, wStart, wEnd, periodId);
          allTrades.push(...trades);
        });
        return btSummarise(allTrades, tp);
      });

      // Also store per-period results for Bucket 4-6 filters and ranking
      btPeriodResults = {};
      windowSlices.forEach(({ wStart, wEnd, periodId, sliceCandles, sliceEma }) => {
        btPeriodResults[periodId] = BT_TP_LEVELS.map(tp => {
          const trades = btRunPeriod(sliceCandles, sliceEma, tp, wStart, wEnd, periodId);
          return btSummarise(trades, tp);
        });
      });

      // btData: use the full trimmed candle set for the grid heatmap display
      btData = candles;
      // btFullEma: store the warmup-inclusive EMA for grid reuse (fixes Bucket 2 bug)
      btFullEma = allEma;
      btAllCandles = allCandles;
      btWindowSlices = windowSlices;

    } else {
      // Custom range: single period
      const periodId = 'custom';
      btResults = BT_TP_LEVELS.map(tp => {
        const trades = btRunPeriod(candles, ema, tp, BT_START_TS, BT_END_TS, periodId);
        return btSummarise(trades, tp);
      });
      btPeriodResults = null;
      btData = candles;
      btFullEma = allEma;
      btAllCandles = allCandles;
      btWindowSlices = null;
    }

    // Always show the audit block at the top of the debug textarea.
    // Entry/rejection log is appended below it only when debug mode is on.
    if (debugEl) {
      if (btDebug) {
        const entryLog = btDebugLog.length
          ? btDebugLog.join('\n')
          : '(no entry/rejection events logged within 10% of EMA)';
        debugEl.value = _btAuditBlock + '\n\n--- Entry / Rejection Log (debug mode) ---\n' + entryLog;
      } else {
        debugEl.value = _btAuditBlock;
      }
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

    // Enable the opt-grid button now if both bull run periods are ready.
    // btWindowSlices was populated above when rangeMode==='bull' with both periods.
    btEnableOptGridBtn();
    if (btWindowSlices && btWindowSlices.length >= 2) {
      const optStatus = document.getElementById('bt-opt-grid-status');
      if (optStatus) optStatus.textContent = 'Both Bull Runs data ready — click to run optimisation';
    }

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
const BT_GRID_MIN_CLOSED = 15; // below this, flag as low-sample in heatmap display

// Bucket 4: raw optimization grid — separate from btGridResults (heatmap display).
// Populated by btRunOptGrid(). Read by Buckets 5-6 for filtering and ranking.
// Structure per combination:
//   { slPct, tp,
//     bull1: { trades, wins, losses, testEndExits, netR, pnl },
//     bull2: { trades, wins, losses, testEndExits, netR, pnl },
//     combined: { trades, wins, losses, testEndExits, netR, pnl } }
let btOptGrid = null;
// Parameters used for the last btRunOptGrid() call — shown in debug output.
let btOptGridParams = null;

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

  // Use the warmup-inclusive EMA stored at run time — do NOT recompute on the
  // trimmed btData, which would re-seed the EMA from the first window candle
  // and undo the Bucket 1 warmup fix. btFullEma is index-aligned with btAllCandles;
  // extract the slice that matches btData by timestamp lookup.
  const ema = btData.map(c => {
    const idx = btAllCandles ? btAllCandles.findIndex(ac => ac.ts === c.ts) : -1;
    return idx >= 0 ? btFullEma[idx] : null;
  });

  const startBalance = parseFloat(document.getElementById('bt-balance-input')?.value) || 1000;
  const riskPct = parseFloat(document.getElementById('bt-risk-select')?.value) || 3;
  const compound = document.getElementById('bt-compound-toggle')?.checked || false;

  btGridResults = slValues.map(slPct => {
    const prevSlPct = BT_SL_PCT;
    BT_SL_PCT = slPct / 100;
    const cells = BT_TP_LEVELS.map(tp => {
      const trades = btRunPeriod(btData, ema, tp, BT_START_TS, BT_END_TS, 'grid');
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

// ── Bucket 4: Raw SL × TP Optimization Grid ───────────────────────────────────
// Runs every SL% × TP-R combination independently for Bull Run 1 and Bull Run 2.
// Requires "Both Bull Runs" mode to have been run first (btWindowSlices must exist).
// Uses fixed 1% risk of original starting balance per trade, no compounding.
// Does NOT filter, rank, or alter strategy logic. Stores all raw combinations.
//
// Stored in btOptGrid:
//   Array of { slPct, tp, bull1, bull2, combined }
//   Each period object: { trades, wins, losses, testEndExits, winRate,
//                         profitFactor, netR, pnl, startBalance }
//
// Also populates btOptGridParams with the parameter universe for audit output.
function btRunOptGrid() {
  // Own status element and button — separate from the heatmap grid controls.
  const statusEl  = document.getElementById('bt-opt-grid-status');
  const btn       = document.getElementById('bt-opt-grid-run-btn');
  const debugEl   = document.getElementById('bt-debug-output');

  // Require both bull run periods to be available.
  // btWindowSlices is only populated after "Both Bull Runs" completes.
  if (!btWindowSlices || btWindowSlices.length < 2) {
    if (statusEl) statusEl.textContent =
      'Run "Both Bull Runs" mode above first — prerequisite data not available.';
    return;
  }

  const bull1Slice = btWindowSlices.find(s => s.periodId === 'bull1');
  const bull2Slice = btWindowSlices.find(s => s.periodId === 'bull2');
  if (!bull1Slice || !bull2Slice) {
    if (statusEl) statusEl.textContent =
      'Could not find bull1 and bull2 window slices — re-run "Both Bull Runs".';
    return;
  }

  // ── Read SL range parameters from the shared heatmap SL inputs ──────────────
  const slMin  = parseFloat(document.getElementById('bt-grid-sl-min').value);
  const slMax  = parseFloat(document.getElementById('bt-grid-sl-max').value);
  const slStep = parseFloat(document.getElementById('bt-grid-sl-step').value);

  if (!isFinite(slMin) || !isFinite(slMax) || !isFinite(slStep) || slStep <= 0 || slMax < slMin) {
    if (statusEl) statusEl.textContent = 'Error: check SL min / max / step values above';
    return;
  }

  const slValues = [];
  for (let v = slMin; v <= slMax + 1e-9; v += slStep) {
    slValues.push(parseFloat((Math.round(v * 1000) / 1000).toFixed(3)));
  }

  const expectedCombos = slValues.length * BT_TP_LEVELS.length;

  // ── Read starting balance and risk % from the existing page controls ───────────
  // Uses the same bt-balance-input and bt-risk-select already on the page —
  // no duplicate inputs. Values are snapshotted into btOptGridParams at run
  // start so results remain reproducible regardless of later UI changes.
  const START_BALANCE = parseFloat(document.getElementById('bt-balance-input')?.value);
  const RISK_PCT      = parseFloat(document.getElementById('bt-risk-select')?.value);
  const COMPOUND      = false; // locked: fixed risk, no compounding

  if (!isFinite(START_BALANCE) || START_BALANCE <= 0) {
    if (statusEl) statusEl.textContent = 'Error: set a valid starting balance above before running';
    return;
  }
  if (!isFinite(RISK_PCT) || RISK_PCT <= 0 || RISK_PCT > 100) {
    if (statusEl) statusEl.textContent = 'Error: set a valid risk % above before running';
    return;
  }

  // ── Log parameter universe before running ───────────────────────────────────
  const paramLines = [
    '=== BUCKET 4 OPT GRID — PARAMETER UNIVERSE ===',
    `SL range     : ${slMin}% to ${slMax}% step ${slStep}%`,
    `SL values    : [${slValues.join(', ')}]  (${slValues.length} levels)`,
    `TP-R values  : [${BT_TP_LEVELS.join(', ')}]  (${BT_TP_LEVELS.length} levels)`,
    `Combinations : ${slValues.length} SL × ${BT_TP_LEVELS.length} TP = ${expectedCombos} expected`,
    `Starting balance : $${START_BALANCE.toLocaleString()}`,
    `Risk per trade   : ${RISK_PCT}% of $${START_BALANCE.toLocaleString()} = $${(START_BALANCE * RISK_PCT / 100).toFixed(2)} fixed, no compounding`,
    `Bull Run 1   : ${new Date(bull1Slice.wStart).toISOString().slice(0,10)} → ${new Date(bull1Slice.wEnd).toISOString().slice(0,10)} (${bull1Slice.sliceCandles.length} candles)`,
    `Bull Run 2   : ${new Date(bull2Slice.wStart).toISOString().slice(0,10)} → ${new Date(bull2Slice.wEnd).toISOString().slice(0,10)} (${bull2Slice.sliceCandles.length} candles)`,
    `Running...`,
  ].join('\n');
  if (debugEl) debugEl.value = paramLines;
  console.log(paramLines);

  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  if (statusEl) statusEl.textContent = `Running ${expectedCombos} combos…`;

  // ── Helper: summarise one period's trades into a raw cell object ─────────────
  function periodCell(trades) {
    const closed     = trades.filter(t => t.outcome !== 'Open');
    const wins       = closed.filter(t => t.outcome === 'Win' || (t.outcome === 'test_end_exit' && t.rMade > 0));
    const losses     = closed.filter(t => t.outcome === 'Loss' || (t.outcome === 'test_end_exit' && t.rMade <= 0));
    const testEndExits = closed.filter(t => t.outcome === 'test_end_exit').length;
    const netR       = closed.reduce((s, t) => s + (t.rMade || 0), 0);
    const grossWin   = wins.reduce((s, t)   => s + Math.max(0, t.rMade || 0), 0);
    const grossLoss  = losses.reduce((s, t) => s + Math.abs(Math.min(0, t.rMade || 0)), 0);
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0;
    const winRate    = closed.length > 0 ? wins.length / closed.length * 100 : 0;
    // Dollar P&L: fixed risk per trade (non-compounding), using the run-start values
    const riskAmount = START_BALANCE * RISK_PCT / 100;
    const pnl        = closed.reduce((s, t) => s + riskAmount * (t.rMade || 0), 0);
    return { trades: closed.length, wins: wins.length, losses: losses.length,
             testEndExits, winRate, profitFactor, netR, pnl, startBalance: START_BALANCE };
  }

  // ── Run every SL × TP combination ──────────────────────────────────────────
  const rawResults = [];
  let actualRuns = 0;
  let failedRuns = 0;

  const savedSlPct = BT_SL_PCT;
  for (const slPct of slValues) {
    BT_SL_PCT = slPct / 100;
    for (const tp of BT_TP_LEVELS) {
      try {
        const trades1 = btRunPeriod(
          bull1Slice.sliceCandles, bull1Slice.sliceEma,
          tp, bull1Slice.wStart, bull1Slice.wEnd, 'bull1'
        );
        const trades2 = btRunPeriod(
          bull2Slice.sliceCandles, bull2Slice.sliceEma,
          tp, bull2Slice.wStart, bull2Slice.wEnd, 'bull2'
        );
        const allTrades = [...trades1, ...trades2];

        rawResults.push({
          slPct,
          tp,
          bull1:    periodCell(trades1),
          bull2:    periodCell(trades2),
          combined: periodCell(allTrades),
          // Raw trade arrays retained for Bucket 5 metrics (drawdown, largest winner).
          // These are closed trades only — 'Open' outcome never appears after Bucket 3.
          _trades1: trades1.filter(t => t.outcome !== 'Open'),
          _trades2: trades2.filter(t => t.outcome !== 'Open'),
        });
        actualRuns++;
      } catch (err) {
        failedRuns++;
        console.error(`[OptGrid] SL=${slPct}% TP=${tp}R failed:`, err);
      }
    }
  }
  BT_SL_PCT = savedSlPct;

  btOptGrid = rawResults;
  // Store all parameters used for this run — these lock the reproducibility context.
  btOptGridParams = {
    slMin, slMax, slStep, slValues,
    tpLevels:     BT_TP_LEVELS,
    expectedCombos,
    startBalance: START_BALANCE,  // snapshotted from bt-balance-input at run start
    riskPct:      RISK_PCT,       // snapshotted from bt-risk-select at run start
    riskPerTrade: START_BALANCE * RISK_PCT / 100,
    compound:     COMPOUND,
    runAt:        new Date().toISOString(),
  };

  // ── Completion summary + sample ────────────────────────────────────────────
  // Written to bt-opt-grid-output (always visible, no debug toggle needed).
  // Also written to bt-debug-output and console for completeness.
  const sampleItems = [
    ...rawResults.slice(0, 3),
    rawResults.length > 3 ? rawResults[rawResults.length - 1] : null,
  ].filter(Boolean);

  const sampleLines = ['', '--- Raw result sample (first 3 + last combo) ---'];
  sampleItems.forEach((r, i) => {
    const isLast = i === sampleItems.length - 1 && rawResults.length > 3;
    sampleLines.push(
      `${isLast ? '... ' : '    '}SL ${r.slPct}% / TP ${r.tp}R` +
      `  |  B1: ${r.bull1.trades}t ${r.bull1.wins}W/${r.bull1.losses}L pnl=$${r.bull1.pnl.toFixed(0)}` +
      `  |  B2: ${r.bull2.trades}t ${r.bull2.wins}W/${r.bull2.losses}L pnl=$${r.bull2.pnl.toFixed(0)}` +
      `  |  Comb: ${r.combined.trades}t pnl=$${r.combined.pnl.toFixed(0)} netR=${r.combined.netR.toFixed(2)} tee=${r.combined.testEndExits}`
    );
  });

  const summaryLines = [
    '',
    '=== BUCKET 4 COMPLETION SUMMARY ===',
    `Expected combinations : ${expectedCombos}`,
    `Actual runs completed : ${actualRuns}`,
    `Failed runs           : ${failedRuns}`,
    `btOptGrid entries     : ${btOptGrid.length}`,
    `Starting balance used : $${START_BALANCE.toLocaleString()}`,
    `Risk % used           : ${RISK_PCT}%  ($${(START_BALANCE * RISK_PCT / 100).toFixed(2)} per trade)`,
    failedRuns === 0
      ? 'Status: ALL COMBINATIONS COMPLETED SUCCESSFULLY'
      : `Status: ${failedRuns} FAILED — check console`,
    '====================================',
  ].join('\n');

  // Strip "Running..." from the pre-run header for the final output
  const paramHeader = paramLines.split('\n').filter(l => l !== 'Running...').join('\n');
  const fullOutput  = paramHeader + sampleLines.join('\n') + '\n' + summaryLines;

  // Primary output: always-visible pre block (no debug toggle needed)
  const optOutputEl = document.getElementById('bt-opt-grid-output');
  if (optOutputEl) {
    optOutputEl.textContent = fullOutput;
    optOutputEl.style.display = 'block';
  }
  // Secondary: debug textarea (visible only when debug toggle is on)
  if (debugEl) debugEl.value = fullOutput;
  console.log(fullOutput);

  if (statusEl) statusEl.textContent =
    `Opt grid done · ${actualRuns}/${expectedCombos} combos · ${failedRuns === 0 ? '✓ all succeeded' : failedRuns + ' failed'} · btOptGrid ready`;

  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }

  // Enable the rank button now that btOptGrid is populated.
  const rankBtn = document.getElementById('bt-rank-run-btn');
  const rankStatus = document.getElementById('bt-rank-status');
  if (rankBtn) { rankBtn.disabled = false; rankBtn.style.opacity = '1'; rankBtn.title = ''; }
  if (rankStatus) rankStatus.textContent = 'Optimisation data ready — click to filter and rank';
}

// ── Bucket 5: Filter, rank, and render eligible combinations ─────────────────
//
// Hard eligibility filters (all must pass):
//   F1: combined closed trades >= 10
//   F2: Bull Run 1 closed trades >= 3
//   F3: Bull Run 2 closed trades >= 3
//   F4: Bull Run 1 P&L > 0
//   F5: Bull Run 2 P&L > 0
//
// Ranked by combined dollar P&L descending.
// Uses btOptGrid (raw results) and btOptGridParams (risk snapshot) set by btRunOptGrid().
// Does NOT re-run the engine. Does NOT recommend a configuration.
function btRunFiltersAndRank() {
  const wrapEl   = document.getElementById('bt-rank-wrap');
  const statusEl = document.getElementById('bt-rank-status');
  const btn      = document.getElementById('bt-rank-run-btn');

  // Guard: require a completed optimisation run.
  // btOptGridParams.runAt is set at the end of btRunOptGrid() — if it's absent
  // the grid has never completed (or was cleared by a new btRun() call).
  if (!btOptGrid || btOptGrid.length === 0 || !btOptGridParams) {
    if (statusEl) statusEl.textContent =
      'Run "Both Bull Runs" → "Run SL × TP Optimisation" first.';
    if (wrapEl) wrapEl.innerHTML = '';
    return;
  }

  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

  const riskPerTrade = btOptGridParams.riskPerTrade; // snapshotted at opt-grid run time

  // ── Helper: max drawdown for ONE period's trade sequence ─────────────────────
  // B1 and B2 are independent simulations with separate starting equity = 0.
  // Their equity curves must never be concatenated — doing so would create a
  // fictitious multi-year trough across the gap between the two periods.
  // Returns the largest peak-to-trough dollar drop within that single period.
  function periodMaxDD(trades) {
    let peak = 0, equity = 0, maxDD = 0;
    for (const t of trades) {
      equity += riskPerTrade * (t.rMade || 0);
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
  }

  // ── Helper: largest single winning trade $ P&L as % of combined $ P&L ────────
  // Includes test_end_exit trades (they are realized outcomes).
  // Returns null — displayed as N/A — when combined P&L is zero or negative,
  // because the percentage would be undefined or misleading.
  function largestWinnerPct(allTrades, combPnlDollars) {
    if (combPnlDollars <= 0) return null;
    let maxWinDollars = 0;
    for (const t of allTrades) {
      // Only count positive-rMade trades (actual winners, including tee winners)
      const tradePnl = riskPerTrade * Math.max(0, t.rMade || 0);
      if (tradePnl > maxWinDollars) maxWinDollars = tradePnl;
    }
    return (maxWinDollars / combPnlDollars) * 100;
  }

  // ── Apply filters sequentially, track marginal rejections ────────────────────
  // Each counter only increments when all prior filters have already passed,
  // so each number represents the true marginal cost of that specific filter.
  let failF1 = 0, failF2 = 0, failF3 = 0, failF4 = 0, failF5 = 0;
  const eligible = [];

  for (const r of btOptGrid) {
    const c  = r.combined;
    const b1 = r.bull1;
    const b2 = r.bull2;

    if (c.trades  < 10)  { failF1++; continue; }
    if (b1.trades <  3)  { failF2++; continue; }
    if (b2.trades <  3)  { failF3++; continue; }
    if (b1.pnl    <= 0)  { failF4++; continue; }
    if (b2.pnl    <= 0)  { failF5++; continue; }

    // ── Compute derived metrics from retained raw trade arrays ────────────────
    const trades1 = r._trades1 || [];
    const trades2 = r._trades2 || [];
    const allTrades = [...trades1, ...trades2];

    // Max drawdown: computed independently per period; report worst of the two.
    const b1MaxDD = periodMaxDD(trades1);
    const b2MaxDD = periodMaxDD(trades2);
    const maxDD   = Math.max(b1MaxDD, b2MaxDD); // worst of the two periods

    const avgR    = c.trades > 0 ? c.netR / c.trades : 0;
    const lwPct   = largestWinnerPct(allTrades, c.pnl);
    const teeCount = b1.testEndExits + b2.testEndExits;

    eligible.push({
      slPct:       r.slPct,
      tp:          r.tp,
      // Combined
      combPnl:     c.pnl,
      combTrades:  c.trades,
      combWinRate: c.winRate,
      combPF:      c.profitFactor,
      combNetR:    c.netR,
      // Per period
      b1Trades: b1.trades, b1Pnl: b1.pnl, b1MaxDD,
      b2Trades: b2.trades, b2Pnl: b2.pnl, b2MaxDD,
      // Derived
      maxDD,    // worst of b1MaxDD / b2MaxDD
      avgR,
      lwPct,    // null → N/A when combPnl <= 0
      teeCount,
    });
  }

  // ── Rank by combined P&L descending ──────────────────────────────────────────
  eligible.sort((a, b) => b.combPnl - a.combPnl);

  // ── Build filter rejection summary ───────────────────────────────────────────
  const totalRaw  = btOptGrid.length;
  const totalPass = eligible.length;
  const totalFail = totalRaw - totalPass;

  const filterSummary = [
    `Raw combinations      : ${totalRaw}`,
    `─────────────────────────────────────────`,
    `F1 fail (comb < 10t)  : ${failF1}`,
    `F2 fail (B1 < 3t)     : ${failF2}  [after F1]`,
    `F3 fail (B2 < 3t)     : ${failF3}  [after F2]`,
    `F4 fail (B1 P&L ≤ $0) : ${failF4}  [after F3]`,
    `F5 fail (B2 P&L ≤ $0) : ${failF5}  [after F4]`,
    `─────────────────────────────────────────`,
    `Total excluded        : ${totalFail}`,
    `Eligible (all 5 pass) : ${totalPass}`,
  ].join('\n');

  if (statusEl) statusEl.textContent =
    `${totalPass} eligible of ${totalRaw} · ranked by combined P&L`;

  if (!wrapEl) {
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    return;
  }

  if (eligible.length === 0) {
    wrapEl.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--text-faint);">
      No combinations passed all five filters.<br><br>
      <pre style="font-size:11px;color:var(--text-dim);white-space:pre-wrap;">${filterSummary}</pre></div>`;
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    return;
  }

  // ── Formatting helpers ────────────────────────────────────────────────────────
  const fmtPF  = v => isFinite(v) ? v.toFixed(2) : '∞';
  const fmtPnl = v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString(undefined, {maximumFractionDigits: 0});
  const fmtPct = v => v.toFixed(1) + '%';

  // ── Render ranked table ───────────────────────────────────────────────────────
  let html = `
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;white-space:pre;font-family:monospace;
                background:var(--bg2);padding:10px 12px;border-radius:6px;border:0.5px solid var(--line-old);">${filterSummary}</div>
    <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;font-size:11px;width:100%;min-width:960px;">
      <thead>
        <tr style="border-bottom:1px solid var(--line-old);">
          <th style="padding:6px 8px;text-align:center;color:var(--text-faint);font-weight:600;font-size:10px;">#</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">SL%</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">TP-R</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">Comb P&amp;L</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">B1 P&amp;L</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">B2 P&amp;L</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">Trades (B1/B2)</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">PF</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;" title="Worst of B1 and B2 max drawdown. Hover a cell for the period breakdown.">Max DD ▾</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">Win%</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">Avg R</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;" title="Largest single winning trade $ as % of combined net P&L. Distinct from win rate.">Largest win %<br><span style="font-weight:400;font-size:9px;">of net P&L</span></th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">TEE</th>
        </tr>
      </thead>
      <tbody>`;

  // ── Duration diagnostics helpers ─────────────────────────────────────────────
  const MS_PER_DAY = 86400000;

  function tradeDurationDays(t) {
    if (!t.entryTs || !t.exitTs) return null;
    return (t.exitTs - t.entryTs) / MS_PER_DAY;
  }

  function durationStats(allTrades) {
    const durations = allTrades
      .map(t => tradeDurationDays(t))
      .filter(d => d !== null)
      .sort((a, b) => a - b);
    if (!durations.length) return { avg: 0, median: 0, longest: 0, over30: 0 };
    const avg    = durations.reduce((s, d) => s + d, 0) / durations.length;
    const mid    = Math.floor(durations.length / 2);
    const median = durations.length % 2 === 0
      ? (durations[mid - 1] + durations[mid]) / 2
      : durations[mid];
    const longest = durations[durations.length - 1];
    const over30  = durations.filter(d => d > 30).length;
    return { avg, median, longest, over30 };
  }

  function top5Winners(allTrades, riskPerTrade) {
    // All trades with positive rMade, sorted by realized $ P&L descending
    return allTrades
      .filter(t => (t.rMade || 0) > 0)
      .map(t => ({
        entryTs:  t.entryTs,
        exitTs:   t.exitTs,
        outcome:  t.outcome,
        rMade:    t.rMade,
        pnl:      riskPerTrade * t.rMade,
        days:     tradeDurationDays(t),
        periodId: t.periodId,
      }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 5);
  }

  // ── Concentration / loss-streak diagnostics ──────────────────────────────────
  // All six metrics are derived from the raw closed trade array.
  // riskPerTrade is used to convert R values to dollar P&L.
  function concentrationStats(allTrades, rpt) {
    if (!allTrades.length) return {
      maxConsecLosses: 0, longestWinGapDays: null,
      totalWins: 0,
      top5WinPctOfGrossWin: null, grossWinPctOfNetPnl: null, top5WinPctOfNetPnl: null,
    };

    // ── Max consecutive losing trades ─────────────────────────────────────────
    // A "loss" is any trade where rMade <= 0 (includes test_end_exit losers).
    let maxConsecLosses = 0, curLoss = 0;
    for (const t of allTrades) {
      if ((t.rMade || 0) <= 0) { curLoss++; if (curLoss > maxConsecLosses) maxConsecLosses = curLoss; }
      else curLoss = 0;
    }

    // ── Longest gap between winning trades (calendar days) ───────────────────
    // Sorts winning trades by exit timestamp, measures gap between successive exits.
    const winExits = allTrades
      .filter(t => (t.rMade || 0) > 0 && t.exitTs)
      .map(t => t.exitTs)
      .sort((a, b) => a - b);
    let longestWinGapDays = null;
    for (let i = 1; i < winExits.length; i++) {
      const gapDays = (winExits[i] - winExits[i - 1]) / 86400000;
      if (longestWinGapDays === null || gapDays > longestWinGapDays) longestWinGapDays = gapDays;
    }

    // ── Winner totals and concentration ──────────────────────────────────────
    const winners = allTrades.filter(t => (t.rMade || 0) > 0);
    const totalWins = winners.length;

    // Gross winning P&L = sum of all positive-rMade trades in dollars
    const grossWinDollars = winners.reduce((s, t) => s + rpt * (t.rMade || 0), 0);

    // Net P&L = sum of all trades (positive + negative rMade) in dollars
    const netPnlDollars = allTrades.reduce((s, t) => s + rpt * (t.rMade || 0), 0);

    // Top-5 winners by dollar P&L (same sort as top5Winners(), but keep $ values)
    const top5Dollars = winners
      .map(t => rpt * (t.rMade || 0))
      .sort((a, b) => b - a)
      .slice(0, 5);
    const top5GrossDollars = top5Dollars.reduce((s, v) => s + v, 0);

    // Gross P&L from top-5 winners as % of gross winning P&L
    const top5WinPctOfGrossWin = grossWinDollars > 0
      ? (top5GrossDollars / grossWinDollars) * 100
      : null;

    // Gross winning P&L as % of net P&L (shows how much gross gain was eroded by losses)
    const grossWinPctOfNetPnl = netPnlDollars > 0
      ? (grossWinDollars / netPnlDollars) * 100
      : null;

    // Top-5 winners' P&L as % of net P&L
    const top5WinPctOfNetPnl = netPnlDollars > 0
      ? (top5GrossDollars / netPnlDollars) * 100
      : null;

    return {
      maxConsecLosses,
      longestWinGapDays,
      totalWins,
      top5WinPctOfGrossWin,  // top-5 $ / gross-win $
      grossWinPctOfNetPnl,   // gross-win $ / net-P&L $ (>100% = losses ate into gross wins)
      top5WinPctOfNetPnl,    // top-5 $ / net-P&L $ (% of final P&L from 5 trades)
    };
  }

  // ── Compute duration diagnostics for top 5 eligible only (no rank change) ────
  const top5 = eligible.slice(0, 5);
  top5.forEach(r => {
    const rawEntry = btOptGrid.find(g => g.slPct === r.slPct && g.tp === r.tp);
    const allTrades = rawEntry
      ? [...(rawEntry._trades1 || []), ...(rawEntry._trades2 || [])]
      : [];
    r._durationStats      = durationStats(allTrades);
    r._concentrationStats = concentrationStats(allTrades, riskPerTrade);
    r._top5Winners        = top5Winners(allTrades, riskPerTrade);
    r._allTrades          = allTrades; // kept for decision-support logic below
  });

  // ── Render ranked table (all eligible, all columns unchanged) ─────────────────
  eligible.forEach((r, i) => {
    const pnlCol = r.combPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const ddCol  = r.maxDD > Math.abs(r.combPnl) * 0.5 ? 'var(--amber)' : 'var(--text-dim)';
    const lwCol  = r.lwPct !== null && r.lwPct > 50 ? 'var(--amber)' : 'var(--text-dim)';
    const lwStr  = r.lwPct !== null ? fmtPct(r.lwPct) : 'N/A';
    const ddTip  = `B1 Max DD: -$${r.b1MaxDD.toLocaleString(undefined,{maximumFractionDigits:0})}  |  B2 Max DD: -$${r.b2MaxDD.toLocaleString(undefined,{maximumFractionDigits:0})}  →  worst: -$${r.maxDD.toLocaleString(undefined,{maximumFractionDigits:0})}`;

    html += `<tr style="border-bottom:0.5px solid var(--line-old);">
      <td style="padding:6px 8px;text-align:center;color:var(--text-faint);">${i + 1}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text);">${r.slPct}%</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text);font-weight:600;">${r.tp}R</td>
      <td style="padding:6px 8px;text-align:right;color:${pnlCol};font-weight:700;">${fmtPnl(r.combPnl)}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-dim);">${fmtPnl(r.b1Pnl)}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-dim);">${fmtPnl(r.b2Pnl)}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-dim);">${r.combTrades} (${r.b1Trades}/${r.b2Trades})</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-dim);">${fmtPF(r.combPF)}</td>
      <td style="padding:6px 8px;text-align:right;color:${ddCol};" title="${ddTip}">-$${r.maxDD.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-dim);">${fmtPct(r.combWinRate)}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-dim);">${r.avgR.toFixed(3)}R</td>
      <td style="padding:6px 8px;text-align:right;color:${lwCol};">${lwStr}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-faint);">${r.teeCount}</td>
    </tr>`;
  });

  html += `</tbody></table></div>
    <div style="margin-top:8px;font-size:10px;color:var(--text-faint);line-height:1.6;">
      Sorted by combined P&amp;L descending.
      <b>Max DD</b> = worst of B1 and B2 period drawdowns (each computed independently; hover for period breakdown).
      <b>Largest win % of net P&L</b> = largest single winning trade $ ÷ combined net P&L $. This is not the win rate. N/A when combined P&L ≤ 0; amber = &gt;50%.
      <b>TEE</b> = test_end_exit count. Ranking unchanged by duration diagnostics below.
    </div>`;

  // ── Duration diagnostic panels for top 5 ─────────────────────────────────────
  const fmtD = d => d !== null ? d.toFixed(1) + 'd' : '—';
  const fmtDate = ts => ts ? new Date(ts).toISOString().slice(0, 10) : '—';

  html += `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line-old);">
    <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:12px;">
      Trade Duration — Top 5 Candidates
    </div>`;

  top5.forEach((r, i) => {
    const ds = r._durationStats;
    const cs = r._concentrationStats;
    const dOver30Col = ds.over30 > 0 ? 'var(--amber)' : 'var(--text-dim)';
    const consecCol  = cs.maxConsecLosses >= 10 ? 'var(--red)'
                     : cs.maxConsecLosses >= 5  ? 'var(--amber)' : 'var(--text)';
    const winGapCol  = cs.longestWinGapDays !== null && cs.longestWinGapDays > 90
                     ? 'var(--amber)' : 'var(--text)';
    const top5GrossCol = cs.top5WinPctOfGrossWin !== null && cs.top5WinPctOfGrossWin > 70
                     ? 'var(--amber)' : 'var(--text)';
    const top5NetCol   = cs.top5WinPctOfNetPnl !== null && cs.top5WinPctOfNetPnl > 60
                     ? 'var(--amber)' : 'var(--text)';

    const fmtPctOrNA = v => v !== null ? v.toFixed(1) + '%' : 'N/A';
    const fmtGapOrNA = v => v !== null ? v.toFixed(0) + 'd' : 'N/A';

    html += `<div style="margin-bottom:14px;padding:10px 12px;background:var(--bg2);
                         border-radius:6px;border:0.5px solid var(--line-old);">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
        <span style="font-size:11px;font-weight:700;color:var(--teal);">#${i+1} — SL ${r.slPct}% / TP ${r.tp}R</span>
        <span style="font-size:10px;color:var(--text-faint);">${r.combTrades} trades · ${fmtPnl(r.combPnl)}</span>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:11px;margin-bottom:6px;">
        <span style="color:var(--text-dim);">Avg duration <b style="color:var(--text);">${fmtD(ds.avg)}</b></span>
        <span style="color:var(--text-dim);">Median <b style="color:var(--text);">${fmtD(ds.median)}</b></span>
        <span style="color:var(--text-dim);">Longest <b style="color:var(--text);">${fmtD(ds.longest)}</b></span>
        <span style="color:var(--text-dim);">Trades &gt;30d <b style="color:${dOver30Col};">${ds.over30} (${r.combTrades > 0 ? Math.round(ds.over30/r.combTrades*100) : 0}%)</b></span>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:11px;margin-bottom:6px;">
        <span style="color:var(--text-dim);">Total wins <b style="color:var(--text);">${cs.totalWins}</b></span>
        <span style="color:var(--text-dim);">Max consec. losses <b style="color:${consecCol};">${cs.maxConsecLosses}</b></span>
        <span style="color:var(--text-dim);">Longest win gap <b style="color:${winGapCol};">${fmtGapOrNA(cs.longestWinGapDays)}</b></span>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:11px;margin-bottom:8px;">
        <span style="color:var(--text-dim);" title="Top-5 winners' $ P&L as % of all gross winning $ P&L">Top-5 / gross wins <b style="color:${top5GrossCol};">${fmtPctOrNA(cs.top5WinPctOfGrossWin)}</b></span>
        <span style="color:var(--text-dim);" title="All gross winning $ P&L as % of final net $ P&L — above 100% means losses eroded gross gains">Gross wins / net P&L <b style="color:var(--text);">${fmtPctOrNA(cs.grossWinPctOfNetPnl)}</b></span>
        <span style="color:var(--text-dim);" title="Top-5 winners' $ P&L as % of final net $ P&L">Top-5 / net P&L <b style="color:${top5NetCol};">${fmtPctOrNA(cs.top5WinPctOfNetPnl)}</b></span>
      </div>
      <div style="font-size:10px;color:var(--text-faint);margin-bottom:5px;">Top 5 winning trades by P&amp;L:</div>
      <table style="border-collapse:collapse;font-size:10px;width:100%;">
        <thead><tr style="color:var(--text-faint);">
          <th style="padding:3px 6px;text-align:left;font-weight:600;">Entry</th>
          <th style="padding:3px 6px;text-align:left;font-weight:600;">Exit</th>
          <th style="padding:3px 6px;text-align:right;font-weight:600;">Dur</th>
          <th style="padding:3px 6px;text-align:right;font-weight:600;">R</th>
          <th style="padding:3px 6px;text-align:right;font-weight:600;">P&amp;L</th>
          <th style="padding:3px 6px;text-align:left;font-weight:600;">Period</th>
          <th style="padding:3px 6px;text-align:left;font-weight:600;">Outcome</th>
        </tr></thead>
        <tbody>`;

    r._top5Winners.forEach(w => {
      const durCol = w.days !== null && w.days > 30 ? 'var(--amber)' : 'var(--text-dim)';
      html += `<tr style="border-top:0.5px solid var(--line-old);">
        <td style="padding:3px 6px;color:var(--text-dim);">${fmtDate(w.entryTs)}</td>
        <td style="padding:3px 6px;color:var(--text-dim);">${fmtDate(w.exitTs)}</td>
        <td style="padding:3px 6px;text-align:right;color:${durCol};">${fmtD(w.days)}</td>
        <td style="padding:3px 6px;text-align:right;color:var(--text-dim);">${w.rMade.toFixed(2)}R</td>
        <td style="padding:3px 6px;text-align:right;color:var(--green);font-weight:600;">+$${w.pnl.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
        <td style="padding:3px 6px;color:var(--text-faint);">${w.periodId}</td>
        <td style="padding:3px 6px;color:var(--text-faint);">${w.outcome}</td>
      </tr>`;
    });

    html += `</tbody></table></div>`;
  });

  html += `</div>`;

  // ── Bucket 6: Decision support — no automatic selection ─────────────────────
  // Computes flags for each of the top 5 candidates on four axes and renders
  // them in a comparison table. Does NOT choose a live configuration. That
  // decision is made explicitly by the user after reviewing the evidence.

  function decisionSupportBlock(top5) {
    if (top5.length === 0) return '';

    // Evaluate each candidate on four robustness axes.
    // Flags are informational — they surface concerns but do not override rank.
    const evaluated = top5.map((r, i) => {
      const ds = r._durationStats;
      const over30Pct = r.combTrades > 0 ? ds.over30 / r.combTrades : 0;
      const ddRatio   = r.combPnl > 0 ? r.maxDD / r.combPnl : Infinity;
      const b1Share   = r.combPnl > 0 ? r.b1Pnl / r.combPnl : 0;

      // Flags — each describes a specific concern, not a hard exclusion.
      const flags = [];
      if (ds.avg > 60)
        flags.push({ axis: 'Hold time',      text: `avg hold ${ds.avg.toFixed(0)}d` });
      if (over30Pct > 0.30)
        flags.push({ axis: 'Hold time',      text: `${Math.round(over30Pct*100)}% of trades >30d` });
      if (r.lwPct !== null && r.lwPct > 40)
        flags.push({ axis: 'Outlier dep.',   text: `largest winner = ${r.lwPct.toFixed(0)}% of P&L` });
      if (ddRatio > 0.60)
        flags.push({ axis: 'Drawdown',       text: `Max DD = ${Math.round(ddRatio*100)}% of P&L` });
      if (b1Share > 0.80)
        flags.push({ axis: 'Period balance', text: `B1 = ${Math.round(b1Share*100)}% of combined P&L` });
      if (b1Share < 0.20)
        flags.push({ axis: 'Period balance', text: `B2 = ${Math.round((1-b1Share)*100)}% of combined P&L` });

      return { rank: i + 1, r, ds, over30Pct, ddRatio, b1Share, flags };
    });

    // Identify: highest P&L (always rank 1) and most practical (fewest flags,
    // tie-broken by rank). These are observations for the user, not an automatic choice.
    const highestPnl = evaluated[0];
    let mostPractical = evaluated[0];
    for (let i = 1; i < evaluated.length; i++) {
      if (evaluated[i].flags.length < mostPractical.flags.length) mostPractical = evaluated[i];
    }
    const sameCandidate = highestPnl.rank === mostPractical.rank;

    let out = `<div style="margin-top:20px;padding:14px 16px;border-radius:8px;
                            border:1px solid var(--line-old);background:var(--bg2);">
      <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px;">
        Bucket 6 — Decision Support
      </div>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:14px;line-height:1.5;">
        Flags are informational. No configuration has been automatically selected.
        Review the evidence below and approve a final parameter pair explicitly.
      </div>`;

    // ── Observation summary ───────────────────────────────────────────────────
    out += `<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;line-height:1.8;">`;
    out += `<b style="color:var(--text);">Highest combined P&L:</b>
      SL ${highestPnl.r.slPct}% / TP ${highestPnl.r.tp}R — ${fmtPnl(highestPnl.r.combPnl)}`;
    if (highestPnl.flags.length > 0) {
      out += ` <span style="color:var(--amber);">(${highestPnl.flags.length} flag${highestPnl.flags.length>1?'s':''}:
        ${highestPnl.flags.map(f=>f.text).join(' · ')})</span>`;
    } else {
      out += ` <span style="color:var(--green);">(no flags)</span>`;
    }
    out += `<br>`;

    if (!sameCandidate) {
      out += `<b style="color:var(--text);">Fewest flags:</b>
        SL ${mostPractical.r.slPct}% / TP ${mostPractical.r.tp}R — ${fmtPnl(mostPractical.r.combPnl)}
        (rank #${mostPractical.rank} by P&L`;
      if (mostPractical.flags.length === 0) {
        out += `, no flags)`;
      } else {
        out += `, ${mostPractical.flags.length} flag${mostPractical.flags.length>1?'s':''}:
          ${mostPractical.flags.map(f=>f.text).join(' · ')})`;
      }
      out += `<br>`;
    } else {
      out += `<b style="color:var(--text);">Highest P&L and fewest flags are the same candidate.</b><br>`;
    }
    out += `</div>`;

    // ── Comparison table: all top-5, one row each ─────────────────────────────
    out += `<div style="overflow-x:auto;margin-bottom:12px;">
    <table style="border-collapse:collapse;font-size:11px;width:100%;min-width:700px;">
      <thead>
        <tr style="border-bottom:1px solid var(--line-old);">
          <th style="padding:5px 8px;text-align:center;color:var(--text-faint);font-weight:600;font-size:10px;">#</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">SL% / TP</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">P&amp;L</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">Avg hold</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">&gt;30d</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;" title="Maximum consecutive losing trades">Max L streak</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;" title="Longest calendar gap between winning trade exits">Win gap</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;" title="Largest single winning trade $ as % of combined net P&L. Distinct from win rate.">Largest win %<br><span style="font-weight:400;font-size:9px;">of net P&L</span></th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;" title="Top-5 winners' P&L as % of final net P&L">Top-5/net</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">DD/P&amp;L</th>
          <th style="padding:5px 8px;text-align:right;color:var(--text-faint);font-weight:600;font-size:10px;">B1/B2 split</th>
          <th style="padding:5px 8px;text-align:left;color:var(--text-faint);font-weight:600;font-size:10px;">Flags</th>
        </tr>
      </thead>
      <tbody>`;

    evaluated.forEach(e => {
      const isHighest  = e.rank === highestPnl.rank;
      const isPractical = e.rank === mostPractical.rank;
      const rowBg = isHighest && !sameCandidate ? 'rgba(40,215,200,0.05)'
                  : isPractical && !sameCandidate ? 'rgba(61,220,151,0.05)'
                  : 'transparent';
      const rowLabel = isHighest && isPractical ? ' ★ highest P&L · fewest flags'
                     : isHighest ? ' ★ highest P&L'
                     : isPractical ? ' ✦ fewest flags'
                     : '';
      const over30Str = `${e.ds.over30} (${Math.round(e.over30Pct*100)}%)`;
      const ddStr     = isFinite(e.ddRatio) ? Math.round(e.ddRatio*100)+'%' : '—';
      const b1Str     = `${Math.round(e.b1Share*100)}% / ${Math.round((1-e.b1Share)*100)}%`;
      const flagStr   = e.flags.length === 0
        ? `<span style="color:var(--green);">✓ none</span>`
        : e.flags.map(f=>`<span style="color:var(--amber);" title="${f.axis}">⚠ ${f.text}</span>`).join(' ');

      const cs2 = e.r._concentrationStats || {};
      const consecCol2  = (cs2.maxConsecLosses||0) >= 10 ? 'var(--red)'
                        : (cs2.maxConsecLosses||0) >= 5  ? 'var(--amber)' : 'var(--text-dim)';
      const winGapCol2  = cs2.longestWinGapDays > 90 ? 'var(--amber)' : 'var(--text-dim)';
      const top5NetCol2 = cs2.top5WinPctOfNetPnl !== null && cs2.top5WinPctOfNetPnl > 60
                        ? 'var(--amber)' : 'var(--text-dim)';

      out += `<tr style="border-bottom:0.5px solid var(--line-old);background:${rowBg};">
        <td style="padding:5px 8px;text-align:center;color:var(--text-faint);">${e.rank}${rowLabel ? `<br><span style="font-size:9px;color:var(--teal);">${rowLabel}</span>` : ''}</td>
        <td style="padding:5px 8px;text-align:right;color:var(--text);font-weight:600;">${e.r.slPct}% / ${e.r.tp}R</td>
        <td style="padding:5px 8px;text-align:right;color:var(--green);font-weight:700;">${fmtPnl(e.r.combPnl)}</td>
        <td style="padding:5px 8px;text-align:right;color:${e.ds.avg>60?'var(--amber)':'var(--text-dim)'};">${e.ds.avg.toFixed(1)}d</td>
        <td style="padding:5px 8px;text-align:right;color:${e.over30Pct>0.30?'var(--amber)':'var(--text-dim)'};">${over30Str}</td>
        <td style="padding:5px 8px;text-align:right;color:${consecCol2};">${cs2.maxConsecLosses ?? '—'}</td>
        <td style="padding:5px 8px;text-align:right;color:${winGapCol2};">${cs2.longestWinGapDays !== null && cs2.longestWinGapDays !== undefined ? cs2.longestWinGapDays.toFixed(0)+'d' : '—'}</td>
        <td style="padding:5px 8px;text-align:right;color:${e.r.lwPct!==null&&e.r.lwPct>40?'var(--amber)':'var(--text-dim)'};">${e.r.lwPct!==null?fmtPct(e.r.lwPct):'N/A'}</td>
        <td style="padding:5px 8px;text-align:right;color:${top5NetCol2};">${cs2.top5WinPctOfNetPnl !== null && cs2.top5WinPctOfNetPnl !== undefined ? cs2.top5WinPctOfNetPnl.toFixed(1)+'%' : 'N/A'}</td>
        <td style="padding:5px 8px;text-align:right;color:${e.ddRatio>0.60?'var(--amber)':'var(--text-dim)'};">${ddStr}</td>
        <td style="padding:5px 8px;text-align:right;color:${Math.abs(e.b1Share-0.5)>0.30?'var(--amber)':'var(--text-dim)'};">${b1Str}</td>
        <td style="padding:5px 8px;">${flagStr}</td>
      </tr>`;
    });

    out += `</tbody></table></div>`;

    // ── Awaiting user decision ────────────────────────────────────────────────
    out += `<div style="font-size:11px;color:var(--text-faint);line-height:1.6;
                        border-top:0.5px solid var(--line-old);padding-top:10px;">
      <b style="color:var(--text-dim);">Awaiting your decision.</b>
      Review the duration panels, top-5 winning trade breakdown, and flag comparison above,
      then approve a final SL% / TP-R pair explicitly.
      <br><span style="color:var(--amber);">
        Historical signal on Binance spot price. Live execution on a separate instrument.
        Past performance does not guarantee future results.
      </span>
    </div>`;

    out += `</div>`;
    return out;
  }

  html += decisionSupportBlock(top5);

  wrapEl.innerHTML = html;
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

// ── Enable / disable the opt-grid button based on prerequisite state ─────────
// Called by btRun() after a successful "Both Bull Runs" completion.
// Also called at the start of btRun() to reset the button while a new run loads.
function btEnableOptGridBtn() {
  const btn    = document.getElementById('bt-opt-grid-run-btn');
  const status = document.getElementById('bt-opt-grid-status');
  const ready  = !!(btWindowSlices && btWindowSlices.length >= 2);
  if (btn) {
    btn.disabled = !ready;
    btn.style.opacity = ready ? '1' : '0.4';
    btn.title = ready ? '' : 'Run "Both Bull Runs" mode first to enable this button';
  }
  if (status && !ready) {
    status.textContent = 'Run "Both Bull Runs" above to enable';
  }
  // When opt-grid prerequisites are lost (new btRun started), also disable the
  // rank button — btOptGrid is cleared at this point so it would be stale.
  if (!ready) {
    const rankBtn = document.getElementById('bt-rank-run-btn');
    const rankStatus = document.getElementById('bt-rank-status');
    if (rankBtn) { rankBtn.disabled = true; rankBtn.style.opacity = '0.4'; rankBtn.title = 'Run SL × TP Optimisation above first'; }
    if (rankStatus) rankStatus.textContent = '';
  }
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

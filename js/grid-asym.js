// ===================== MM GRID BOT (Lighter) =====================
// A NEW gridbot, separate from the older symmetric neutral grid in
// grid-lighter.js. Implements the frozen "Gridbot Redesign — WEJO Seed
// 2026-07-18" ASYM spec (vault: 04 Resources/Strategy Research). Reference
// backtest engine: regime-research-fable/gridbot-mm-true.js (mode ASYM).
//
// WHAT "ASYM" MEANS (asymmetric boundaries):
//   - The bot runs a two-sided market-maker grid inside a box the owner draws
//     after a capitulation: 0% = impulse-wick low, 61.8% = fib cap.
//   - BOTTOM (0% wick) is a DISASTER BRAKE, not a normal exit: touch -> flatten
//     everything + turn OFF. Re-arm is MANUAL only (owner presses Arm again
//     after his next bullish 3D close, price back inside the box).
//   - TOP (61.8% cap) is PAUSE + HOLD: touch just stops adding exposure and
//     rides the inventory; harvesting resumes when price re-enters below cap.
//     The top is NEVER a stop (this asymmetry was the difference between a
//     losing and a positive backtest on both of the owner's boxes).
//
// SIZING (mirrors gridbot-mm-true.js exactly):
//   geometric levels L_0=wick .. L_N<=cap, step d;  unit$ = SIDE_CAP / N;
//   SIDE_CAP = sideCapX * bankroll (default 3x). Full long deployment lands at
//   the wick with total notional ~= SIDE_CAP. Each side capped at SIDE_CAP.
//
// SAFETY / SCOPE:
//   - Owner-armed only. Nothing here auto-starts, registers a task, or places
//     an order on load. The price feed runs read-only for the ladder viz.
//   - The 0% disaster stop is ALSO placed as a resting reduce-only stop on
//     Lighter, so it still fires if the browser tab is closed. (A browser bot
//     only runs while the tab is open — a 24/7 headless port is a later step.)
//   - Reuses the proven plumbing from the dashboard: window.__getLighterSigner
//     (js/lighter-signer.js), fetchLighterMarketMap / toLighterInt
//     (js/lighter-executor.js), LIGHTER_* globals (js/ema-engine.js).
'use strict';

/* ------------------------------------------------------------------ *
 * PURE MATH (no browser deps) — exported for the Node parity test.    *
 * Kept byte-for-byte faithful to gridbot-mm-true.js's level/unit math.*
 * ------------------------------------------------------------------ */

// Geometric ladder from wick up to cap, inclusive of wick, last level <= cap.
// Same loop as the reference engine: for(p=SL; p<=CAP*(1+1e-9); p*=1+step).
function agBuildLevels(wick, cap, stepPct){
  const step = stepPct / 100;
  const levels = [];
  if(!(wick > 0) || !(cap > wick) || !(step > 0)) return levels;
  for(let p = wick; p <= cap * (1 + 1e-9); p *= (1 + step)) levels.push(p);
  return levels; // length N+1
}

// unit$ per level = SIDE_CAP / N, where N = levels.length - 1 (number of steps).
function agUnitUsd(sideCapUsd, levelCount){
  const N = levelCount - 1;
  return N > 0 ? sideCapUsd / N : 0;
}

// Maximum long inventory in BTC if every buy level down to the wick fills
// (used to size the resting disaster stop; reduce-only so over-sizing is safe).
function agMaxInventoryBase(levels, unitUsd){
  return levels.reduce((s, p) => s + unitUsd / p, 0);
}

// Theoretical realized profit per round trip at a level pair (one step).
// Mirrors the reference sanity check: $/RT ~= unit * step.
function agProfitPerStep(unitUsd, stepPct){
  return unitUsd * (stepPct / 100);
}

// Only these states are allowed to react to price boundaries. In particular,
// arm_failed must remain inert while the always-on read-only price feed keeps
// updating in the background.
function agBoundaryStateActive(state){
  return state === 'armed' || state === 'paused';
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { agBuildLevels, agUnitUsd, agMaxInventoryBase, agProfitPerStep, agBoundaryStateActive };
}

/* ------------------------------------------------------------------ *
 * BROWSER BOT — only wires up when a DOM/window is present.           *
 * ------------------------------------------------------------------ */
if(typeof window !== 'undefined' && typeof document !== 'undefined'){ (function(){

const AG_STORAGE_KEY = 'asym_grid_v1';
const AG_WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';
// BTC market index is NOT assumable (BTC = market_id 1, market 0 is ETH) — it is
// resolved by SYMBOL at runtime via agResolveBtcMarket(); never hardcode it.

// clientOrderIndex encoding: role*1000 + levelIndex. Roles:
//   1 = OPEN-BUY  (rests at levels[i], opens a long)
//   2 = OPEN-SELL (rests at levels[i], opens a short)
//   3 = CLOSE-SELL(rests at levels[i+1], banks the long opened at i)
//   4 = CLOSE-BUY (rests at levels[i-1], banks the short opened at i)
// Decode on fill: role = floor(ci/1000), levelIndex = ci % 1000.
const AG_ROLE = { OPEN_BUY: 1, OPEN_SELL: 2, CLOSE_SELL: 3, CLOSE_BUY: 4 };
const AG_DISASTER_CI = 900; // resting reduce-only stop at the wick

let ag = null;              // persisted config + runtime state
let agPriceWs = null;
let agOrderWs = null;
let agPrice = null;         // latest mid price
let agUptimeTimer = null;
let agVizRaf = null;
let agVizDirty = false;
let agBtcMarket = null;     // cached { marketIndex, sizeDecimals, priceDecimals }

// ---- Persistence ----
function agSave(){ try{ localStorage.setItem(AG_STORAGE_KEY, JSON.stringify(ag)); }catch(e){} }
function agLoad(){ try{ const r = localStorage.getItem(AG_STORAGE_KEY); return r ? JSON.parse(r) : null; }catch(e){ return null; } }

// ---- Toast ----
function agToast(msg, ms = 3800){
  const el = document.getElementById('agToast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

// ---- Small UI helpers ----
function agEl(id){ return document.getElementById(id); }
function agStat(id, val, cls){ const el = agEl(id); if(!el) return; el.textContent = val; el.className = 'grid-stat-val' + (cls ? ' ' + cls : ''); }
function agSetBadge(state){ // idle | armed | paused | stopped
  const el = agEl('ag-status-badge'); if(!el) return;
  const map = { idle:'IDLE', armed:'ARMED', paused:'PAUSED · TOP', stopped:'STOPPED · OFF' };
  el.className = 'grid-status-badge ' + (state === 'idle' ? '' : (state === 'stopped' ? 'stopped' : (state === 'paused' ? 'paused' : 'running')));
  el.textContent = map[state] || state.toUpperCase();
}
function agSetLiveDot(s){ const el = agEl('ag-live-dot'); if(el) el.className = 'grid-live-dot ' + s; }
function agShowControls(armed, paused){
  const arm = agEl('ag-arm-btn'), pause = agEl('ag-pause-btn'), disarm = agEl('ag-disarm-btn');
  if(arm)    arm.style.display    = armed ? 'none' : 'flex';
  if(pause)  pause.style.display  = armed ? 'flex' : 'none';
  if(disarm) disarm.style.display = armed ? 'flex' : 'none';
  if(pause) pause.innerHTML = paused
    ? '<i class="ti ti-player-play"></i> Resume'
    : '<i class="ti ti-player-pause"></i> Pause';
}

// ---- Config read + box preview ----
function agReadConfig(){
  return {
    wick:     parseFloat(agEl('ag-wick').value),
    cap:      parseFloat(agEl('ag-cap').value),
    bankroll: parseFloat(agEl('ag-bankroll').value),
    sideCapX: parseFloat(agEl('ag-sidecap').value),
    stepPct:  parseFloat(agEl('ag-step').value),
    leverage: parseFloat(agEl('ag-leverage').value) || 10,
  };
}

// Live readout of the box the owner has typed: fib mid, level count, unit size,
// max exposure, profit/round-trip — plus the capital check. Recomputed on input.
function agRefreshBox(){
  const c = agReadConfig();
  const lvEl = agEl('ag-leverage-display'); if(lvEl) lvEl.textContent = (c.leverage || 10) + '×';
  const imr = Math.max(1 / (c.leverage || 10), 0.02);
  const imrEl = agEl('ag-imr-display'); if(imrEl) imrEl.textContent = (imr * 100).toFixed(1) + '%';

  const readout = agEl('ag-box-readout');
  const cap$ = agEl('ag-capital-check');
  if(!readout) return;

  if(isNaN(c.wick) || isNaN(c.cap) || isNaN(c.bankroll) || isNaN(c.sideCapX) || isNaN(c.stepPct)){
    readout.innerHTML = '<span class="ag-box-hint">Enter the box (0% wick, 61.8% cap) and sizing to preview the ladder.</span>';
    if(cap$) cap$.style.display = 'none';
    return;
  }
  if(c.cap <= c.wick){
    readout.innerHTML = '<span class="ag-box-warn">Cap (61.8%) must be above the wick (0%).</span>';
    if(cap$) cap$.style.display = 'none';
    return;
  }

  const sideCap = c.sideCapX * c.bankroll;
  const levels = agBuildLevels(c.wick, c.cap, c.stepPct);
  const N = levels.length - 1;
  const unit = agUnitUsd(sideCap, levels.length);
  const perRT = agProfitPerStep(unit, c.stepPct);
  const boxPct = ((c.cap - c.wick) / c.wick) * 100;
  const impliedOrigin = c.wick + (c.cap - c.wick) / 0.618; // if cap == 61.8% of impulse

  readout.innerHTML =
    `<div class="ag-box-grid">
       <div><span class="ag-box-k">Box span</span><span class="ag-box-v">$${c.wick.toLocaleString()} → $${c.cap.toLocaleString()} (${boxPct.toFixed(1)}%)</span></div>
       <div><span class="ag-box-k">Implied 100% origin</span><span class="ag-box-v">~$${impliedOrigin.toLocaleString('en-US',{maximumFractionDigits:0})}</span></div>
       <div><span class="ag-box-k">Levels (N steps)</span><span class="ag-box-v">${levels.length} (${N})</span></div>
       <div><span class="ag-box-k">Unit / level</span><span class="ag-box-v">$${unit.toFixed(2)}</span></div>
       <div><span class="ag-box-k">Side cap</span><span class="ag-box-v">$${sideCap.toLocaleString()} (${c.sideCapX}×)</span></div>
       <div><span class="ag-box-k">Profit / round-trip</span><span class="ag-box-v">~$${perRT.toFixed(2)}</span></div>
     </div>`;

  // Capital check: peak one-sided exposure = SIDE_CAP (long at wick OR short at cap).
  const required = sideCap * imr * 1.05;
  let available = null;
  const dashSub = agEl('dashLighterSub');
  if(dashSub){ const m = dashSub.textContent.match(/avail \$([0-9,]+)/); if(m) available = parseFloat(m[1].replace(/,/g,'')); }
  if(cap$){
    cap$.style.display = 'block';
    if(available === null){
      cap$.className = 'grid-capital-check ok';
      cap$.innerHTML = `Required margin: <strong>~$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> ($${sideCap.toLocaleString()} peak notional × ${(imr*100).toFixed(1)}% IMR + 5% buffer). Connect Lighter to validate.`;
    } else if(required > available){
      cap$.className = 'grid-capital-check warn';
      cap$.innerHTML = `Not possible — needs <strong>$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> margin but only <strong>$${available.toLocaleString('en-US',{maximumFractionDigits:0})}</strong> available. Lower the side-cap × or raise leverage.`;
    } else {
      cap$.className = 'grid-capital-check ok';
      cap$.innerHTML = `✓ Margin OK — needs <strong>$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> of $${available.toLocaleString('en-US',{maximumFractionDigits:0})} available.`;
    }
  }
}

['ag-wick','ag-cap','ag-bankroll','ag-sidecap','ag-step','ag-leverage'].forEach(id => {
  const el = agEl(id);
  if(el) el.addEventListener('input', agRefreshBox);
});

// ---- Market resolution (reuses lighter-executor.js) ----
async function agResolveBtcMarket(){
  if(agBtcMarket) return agBtcMarket;
  const map = await fetchLighterMarketMap();
  if(!map) return null;
  const m = map['BTC'] || Object.entries(map).find(([k]) => k.startsWith('BTC'))?.[1];
  if(m) agBtcMarket = m;
  return agBtcMarket;
}

// ---- Price feed (always-on, read-only, for the viz + boundary checks) ----
async function agStartPriceWs(){
  if(agPriceWs && agPriceWs.readyState < 2) return;
  // Resolve BTC by symbol first, then subscribe to the CORRECT market's order_book
  // channel (name is `order_book:<id>`, not `orderbook:<id>`; id is BTC's market_id,
  // NOT a hardcoded 0 which is ETH).
  const market = await agResolveBtcMarket();
  const idx = market ? market.marketIndex : null;
  if(idx === null || idx === undefined){ setTimeout(agStartPriceWs, 3000); return; }
  agPriceWs = new WebSocket(AG_WS_URL);
  agPriceWs.onopen = () => agPriceWs.send(JSON.stringify({ type:'subscribe', channel:'order_book:' + idx }));
  agPriceWs.onmessage = (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      const d = msg.data || msg;
      const bids = d.bids || d.b || [];
      const asks = d.asks || d.a || [];
      let price = null;
      if(bids.length && asks.length){
        const rawBid = Array.isArray(bids[0]) ? bids[0][0] : (bids[0].price ?? bids[0].p ?? bids[0]);
        const rawAsk = Array.isArray(asks[0]) ? asks[0][0] : (asks[0].price ?? asks[0].p ?? asks[0]);
        const pd = agBtcMarket ? agBtcMarket.priceDecimals : 2;
        let bid = parseFloat(rawBid), ask = parseFloat(rawAsk);
        if(!isNaN(bid) && !isNaN(ask)){
          if(bid > 1e6) bid /= Math.pow(10, pd);
          if(ask > 1e6) ask /= Math.pow(10, pd);
          price = (bid + ask) / 2;
        }
      }
      if(price === null && d.last_price) price = parseFloat(d.last_price);
      if(price !== null && !isNaN(price) && price > 1000){
        agPrice = price;
        agStat('agstat-price', '$' + price.toLocaleString('en-US',{maximumFractionDigits:1}));
        agUpdateDistances();
        agVizDirty = true;
        agCheckBoundaries();
      }
    }catch(e){ /* ignore parse noise */ }
  };
  agPriceWs.onclose = () => setTimeout(agStartPriceWs, 3000);
  agPriceWs.onerror = () => agSetLiveDot('error');
}

// Mark-price poll — the ROBUST price source (the headless bot uses the same:
// WS order_book deltas can't give a clean mid). Reads the BTC market resolved by
// symbol, so it can never read the wrong asset, and drives the boundary machine
// so the disaster/cap logic runs even when the WS is quiet.
async function agFetchPriceFallback(){
  try{
    const market = await agResolveBtcMarket();
    if(!market) return;
    const res = await fetch(`${LIGHTER_BASE_URL}/api/v1/orderBookDetails?market_id=${market.marketIndex}`);
    if(!res.ok) return;
    const data = await res.json();
    const d = (data.order_book_details || [])[0] || data;
    const p = parseFloat(d.mark_price || d.last_trade_price || d.index_price || d.last_price || 0);
    if(p > 1000){
      agPrice = p;
      agStat('agstat-price', '$' + p.toLocaleString('en-US',{maximumFractionDigits:1}));
      agUpdateDistances(); agVizDirty = true;
      agCheckBoundaries();
    }
  }catch(e){}
}

// ---- Boundary state machine (the heart of ASYM) ----
function agCheckBoundaries(){
  if(!ag || !agBoundaryStateActive(ag.state)) return;
  if(agPrice === null) return;

  // BOTTOM 0% — disaster brake: flatten everything + OFF, manual re-arm only.
  if(agPrice <= ag.wick){
    console.warn('[MM] 0% disaster brake hit at', agPrice, '(wick', ag.wick, ')');
    agToast('⛔ 0% disaster brake — flattening everything and turning OFF. Re-arm manually after your next bullish 3D close.', 7000);
    agDisasterStop();
    return;
  }

  // TOP 61.8% — pause + hold: stop adding exposure, ride inventory, resume below cap.
  if(agPrice >= ag.cap){
    if(ag.state !== 'paused'){
      ag.state = 'paused'; agSave();
      agSetBadge('paused'); agSetLiveDot('paused');
      agStat('agstat-state', 'Paused · top (holding)');
      agToast('⏸ 61.8% cap touched — holding inventory, no new exposure. Harvest resumes when price re-enters.', 6000);
    }
  } else if(ag.state === 'paused' && agPrice < ag.cap){
    ag.state = 'armed'; agSave();
    agSetBadge('armed'); agSetLiveDot('live');
    agStat('agstat-state', 'Running');
    agToast('▶ Back inside the box — grid resumed.');
  }
}

function agUpdateDistances(){
  if(!ag || agPrice === null) return;
  const toWick = ((agPrice - ag.wick) / agPrice) * 100;
  const toCap  = ((ag.cap - agPrice) / agPrice) * 100;
  agStat('agstat-towick', toWick.toFixed(1) + '%', toWick < 3 ? 'down' : '');
  agStat('agstat-tocap',  toCap.toFixed(1) + '%');
}

// ---- Order fill feed ----
function agStartOrderWs(){
  if(agOrderWs && agOrderWs.readyState < 2) return;
  agOrderWs = new WebSocket(AG_WS_URL);
  agOrderWs.onopen = () => agOrderWs.send(JSON.stringify({ type:'subscribe', channel:`account_all_orders:${LIGHTER_ACCOUNT_INDEX}` }));
  agOrderWs.onmessage = async (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      if(!(msg.channel || '').startsWith('account_all_orders') || !msg.data) return;
      const orders = Array.isArray(msg.data) ? msg.data : [msg.data];
      for(const o of orders){
        const status = o.status ?? o.order_status ?? o.state ?? '';
        const ci = o.client_order_index ?? o.clientOrderIndex ?? o.client_order_idx;
        const filled = status === 'filled' || status === 'FILLED' || status === 2 || status === 'closed';
        if(filled) await agHandleFill(parseInt(ci, 10));
      }
    }catch(e){ /* ignore */ }
  };
  agOrderWs.onclose = () => { if(ag && (ag.state === 'armed' || ag.state === 'paused')) setTimeout(agStartOrderWs, 3000); };
}
function agStopOrderWs(){ if(agOrderWs){ try{ agOrderWs.close(); }catch(e){} agOrderWs = null; } }
function agStopPriceWs(){ if(agPriceWs){ try{ agPriceWs.close(); }catch(e){} agPriceWs = null; } }

// The two-sided grid mechanic, decoded from clientOrderIndex. Mirrors
// gridbot-mm-true.js fillsUp/fillsDown: an OPEN fill spawns a paired CLOSE one
// level away; a CLOSE fill banks one step and restores the OPEN it came from.
async function agHandleFill(ci){
  if(!ag || (ag.state !== 'armed' && ag.state !== 'paused')) return;
  if(isNaN(ci)) return;
  const role = Math.floor(ci / 1000);
  const i = ci % 1000;
  const L = ag.levels;
  if(i < 0 || i >= L.length) return;
  const unit = ag.unit;

  if(role === AG_ROLE.OPEN_BUY){
    // long opened at level i -> place CLOSE-SELL one level up (i+1)
    if(ag.openState[ci] === 'filled') return; ag.openState[ci] = 'filled';
    ag.longsUsd += unit; ag.longsBase += unit / L[i];
    if(i + 1 <= L.length - 1) await agPlace(L[i+1], true, unit, AG_ROLE.CLOSE_SELL * 1000 + i);
  } else if(role === AG_ROLE.OPEN_SELL){
    // short opened at level i -> place CLOSE-BUY one level down (i-1)
    if(ag.openState[ci] === 'filled') return; ag.openState[ci] = 'filled';
    ag.shortsUsd += unit; ag.shortsBase += unit / L[i];
    if(i - 1 >= 0) await agPlace(L[i-1], false, unit, AG_ROLE.CLOSE_BUY * 1000 + i);
  } else if(role === AG_ROLE.CLOSE_SELL){
    // long from level i closed at i+1 -> bank one step, restore OPEN-BUY at i
    ag.realized += unit * (L[i+1] - L[i]) / L[i];
    ag.longsUsd = Math.max(0, ag.longsUsd - unit); ag.longsBase = Math.max(0, ag.longsBase - unit / L[i]);
    ag.roundTrips++;
    if(ag.state === 'armed' && ag.longsUsd + unit <= ag.sideCap + 1e-6) await agPlace(L[i], false, unit, AG_ROLE.OPEN_BUY * 1000 + i);
  } else if(role === AG_ROLE.CLOSE_BUY){
    // short from level i closed at i-1 -> bank one step, restore OPEN-SELL at i
    ag.realized += unit * (L[i] - L[i-1]) / L[i];
    ag.shortsUsd = Math.max(0, ag.shortsUsd - unit); ag.shortsBase = Math.max(0, ag.shortsBase - unit / L[i]);
    ag.roundTrips++;
    if(ag.state === 'armed' && ag.shortsUsd + unit <= ag.sideCap + 1e-6) await agPlace(L[i], true, unit, AG_ROLE.OPEN_SELL * 1000 + i);
  } else {
    return; // not one of ours (e.g. the disaster stop 900) — handled elsewhere
  }

  ag.fills = (ag.fills || 0) + 1;
  agSave();
  agStat('agstat-fills', ag.fills);
  agStat('agstat-pnl', (ag.realized >= 0 ? '+' : '') + '$' + ag.realized.toFixed(2), ag.realized >= 0 ? 'up' : 'down');
  agStat('agstat-long',  '$' + ag.longsUsd.toFixed(0));
  agStat('agstat-short', '$' + ag.shortsUsd.toFixed(0));
  agRenderLevels();
  agVizDirty = true;
}

// ---- Order placement (mirrors grid-lighter.js's proven signer calls) ----
async function agPlace(price, isAsk, notionalUsd, clientOrderIndex){
  try{
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor;
    const market = await agResolveBtcMarket();
    if(!market){ console.error('[MM] BTC market not found'); return null; }
    const base = toLighterInt(notionalUsd / price, market.sizeDecimals);
    const px = toLighterInt(price, market.priceDecimals);
    const [tx, hash, error] = await signer.createOrderOptimized({
      marketIndex: market.marketIndex,
      clientOrderIndex,
      baseAmount: base,
      price: px,
      isAsk,
      orderType: SC.ORDER_TYPE_LIMIT,
      timeInForce: SC.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
      reduceOnly: false,
      triggerPrice: 0,
      orderExpiry: Date.now() + 28 * 24 * 60 * 60 * 1000
    });
    if(error){ console.error('[MM] order error @', price, error); return null; }
    ag.openState[clientOrderIndex] = 'open';
    return { clientOrderIndex };
  }catch(e){ console.error('[MM] place exception', e.message || e); return null; }
}

// Resting reduce-only STOP_LOSS at the wick — the disaster brake that survives a
// closed browser. Low-level signCreateOrder path, same as grid-lighter.js SLs.
async function agPlaceDisasterStop(){
  try{
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor;
    const market = await agResolveBtcMarket();
    if(!market){ console.error('[MM] no market for disaster stop'); return false; }
    const maxBase = agMaxInventoryBase(ag.levels, ag.unit);
    const size = toLighterInt(maxBase, market.sizeDecimals);
    const px = toLighterInt(ag.wick, market.priceDecimals);
    const nonce = await signer.transactionApi.getNextNonce(signer.config.accountIndex, signer.config.apiKeyIndex);
    const resp = await signer.wallet.signCreateOrder({
      marketIndex: market.marketIndex,
      clientOrderIndex: AG_DISASTER_CI,
      baseAmount: size,
      price: px,
      isAsk: 1,                 // sell to close longs at the wick
      orderType: SC.ORDER_TYPE_STOP_LOSS,
      timeInForce: SC.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
      // reduceOnly MUST be 1: without it an oversized stop can trade through
      // zero and OPEN a short (Codex review 2026-07-18 — comment above said
      // reduce-only but the flag was 0).
      reduceOnly: 1,
      triggerPrice: px,
      orderExpiry: Date.now() + 28 * 24 * 60 * 60 * 1000,
      integratorAccountIndex: 0, integratorTakerFee: 0, integratorMakerFee: 0,
      skipNonce: 0, nonce: nonce.nonce,
      apiKeyIndex: signer.config.apiKeyIndex, accountIndex: signer.config.accountIndex
    });
    if(resp.error){ console.warn('[MM] disaster stop sign error', resp.error); return false; }
    const txh = await signer.transactionApi.sendTxWithIndices(
      resp.txType || SC.TX_TYPE_CREATE_ORDER, resp.txInfo,
      signer.config.accountIndex, signer.config.apiKeyIndex, false
    );
    if(txh.code && txh.code !== 200){ console.warn('[MM] disaster stop send error', txh.message); return false; }
    ag.disasterMarketIndex = market.marketIndex;
    agSave();
    console.log('[MM] disaster stop resting at wick', ag.wick);
    return true;
  }catch(e){ console.warn('[MM] disaster stop exception', e.message || e); return false; }
}

async function agCancelAll(){
  try{
    const signer = await window.__getLighterSigner();
    const market = await agResolveBtcMarket();
    if(!market) return;
    const cis = Object.keys(ag.openState || {}).filter(ci => ag.openState[ci] === 'open').map(Number);
    for(const ci of cis){
      const [,, err] = await signer.cancelOrder({ marketIndex: market.marketIndex, orderIndex: ci });
      if(!err) ag.openState[ci] = 'cancelled';
    }
    if(ag.disasterMarketIndex !== undefined){
      const [,, e] = await signer.cancelOrder({ marketIndex: market.marketIndex, orderIndex: AG_DISASTER_CI });
      if(e) console.warn('[MM] cancel disaster stop error', e);
    }
    agSave();
  }catch(e){ console.warn('[MM] cancelAll error', e.message || e); }
}

// Market-close the net inventory (reduce-only), sized from tracked base.
async function agMarketCloseNet(){
  try{
    const netBase = (ag.longsBase || 0) - (ag.shortsBase || 0);
    if(Math.abs(netBase) < 1e-9) return;
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor;
    const market = await agResolveBtcMarket();
    if(!market) return;
    const isAsk = netBase > 0; // net long -> sell to close
    const size = toLighterInt(Math.abs(netBase), market.sizeDecimals);
    await signer.createOrderOptimized({
      marketIndex: market.marketIndex, clientOrderIndex: 0,
      baseAmount: size, price: 0, isAsk,
      orderType: SC.ORDER_TYPE_MARKET,
      timeInForce: SC.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
      reduceOnly: true, triggerPrice: 0, orderExpiry: 0
    });
    console.log('[MM] net market close sent, base', netBase);
  }catch(e){ console.warn('[MM] market close failed (maybe flat)', e.message || e); }
}

// ---- Arm (manual) ----
async function agArm(){
  if(ag && (ag.state === 'armed' || ag.state === 'paused')){ agToast('Already armed.'); return; }
  const c = agReadConfig();
  if([c.wick, c.cap, c.bankroll, c.sideCapX, c.stepPct].some(v => isNaN(v))){ agToast('Fill in the box and sizing first.'); return; }
  if(c.cap <= c.wick){ agToast('Cap must be above the wick.'); return; }
  if(agPrice === null){ agToast('No live price yet — wait a moment.'); return; }
  if(!(agPrice > c.wick && agPrice < c.cap)){ agToast('Price must be INSIDE the box to arm (your bullish-3D-close rule).'); return; }
  if(!localStorage.getItem('lighterPrivateKey')){ agToast('No Lighter private key — set it in Settings.'); return; }

  const sideCap = c.sideCapX * c.bankroll;
  const levels = agBuildLevels(c.wick, c.cap, c.stepPct);
  if(levels.length < 3){ agToast('Box too tight for this step — need ≥3 levels.'); return; }
  const unit = agUnitUsd(sideCap, levels.length);

  ag = {
    wick: c.wick, cap: c.cap, bankroll: c.bankroll, sideCapX: c.sideCapX, sideCap,
    stepPct: c.stepPct, leverage: c.leverage, levels, unit,
    state: 'armed', startTime: Date.now(),
    realized: 0, roundTrips: 0, fills: 0,
    longsUsd: 0, shortsUsd: 0, longsBase: 0, shortsBase: 0,
    openState: {}
  };
  agSave();

  agSetBadge('armed'); agSetLiveDot('live'); agShowControls(true, false);
  agStat('agstat-state', 'Arming…');
  agStartPriceWs(); agStartOrderWs();
  clearInterval(agUptimeTimer); agUptimeTimer = setInterval(agTickUptime, 1000);
  agStartVizLoop();

  // Place the resting disaster stop FIRST (safety before exposure).
  // FAIL-CLOSED (Codex review 2026-07-18): if the stop cannot be placed we
  // must NOT seed the grid — abort the arm instead of continuing unprotected.
  const stopOk = await agPlaceDisasterStop();
  if(!stopOk){
    // Armed-runtime teardown (Codex review round 2): without this the bot
    // stayed administratively 'armed' — localStorage said armed, order-ws and
    // uptime/viz loops kept running, the UI suggested protection that did not
    // exist, and the arm button refused a retry ("Already armed"). The global
    // read-only price feed intentionally remains active; arm_failed is inert
    // in agCheckBoundaries().
    console.error('[MM] disaster stop FAILED — arm aborted, no grid orders placed.');
    ag.state = 'arm_failed'; agSave();
    agStopOrderWs();
    clearInterval(agUptimeTimer); agUptimeTimer = null;
    if(agVizRaf){ cancelAnimationFrame(agVizRaf); agVizRaf = null; }
    agSetBadge('idle'); agSetLiveDot('off'); agShowControls(false, false);
    agStat('agstat-state', '❌ Arm aborted: disaster stop failed — fix and retry');
    agToast('Arm aborted: disaster stop could not be placed. Nothing was opened.');
    return;
  }

  // Seed the grid: buys below price, sells above; skip the level nearest price.
  const N = levels.length - 1;
  const nearest = agNearestLevelIdx(agPrice);
  let placed = 0;
  for(let i = 0; i <= N; i++){
    if(i === nearest) continue;              // avoid instant fill on the straddled level
    const below = levels[i] < agPrice;
    const ci = (below ? AG_ROLE.OPEN_BUY : AG_ROLE.OPEN_SELL) * 1000 + i;
    const r = await agPlace(levels[i], !below, unit, ci); // isAsk = sell = above price
    if(r) placed++;
    agStat('agstat-orders', placed);
    agVizDirty = true;
    await new Promise(res => setTimeout(res, 120));
  }
  ag.state = 'armed'; agSave();
  agStat('agstat-state', 'Running');
  agRenderLevels();
  agToast(`✓ Armed — ${placed} orders across ${levels.length} levels, disaster stop resting at $${c.wick.toLocaleString()}.`);
  console.log('[MM] armed:', placed, '/', levels.length);
}

function agNearestLevelIdx(price){
  if(!ag || !ag.levels || !ag.levels.length) return -1;
  let best = 0, bd = Infinity;
  for(let i = 0; i < ag.levels.length; i++){
    const d = Math.abs(ag.levels[i] - price);
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}

// ---- Pause / Resume (manual, independent of the auto top-pause) ----
function agTogglePause(){
  if(!ag || ag.state === 'idle' || ag.state === 'stopped') return;
  if(ag.state === 'paused'){ ag.state = 'armed'; agSetBadge('armed'); agSetLiveDot('live'); agStat('agstat-state','Running'); agToast('▶ Resumed.'); }
  else { ag.state = 'paused'; agSetBadge('paused'); agSetLiveDot('paused'); agStat('agstat-state','Paused (manual)'); agToast('⏸ Paused — no new counter-orders.'); }
  agShowControls(true, ag.state === 'paused');
  agSave();
}

// ---- Disaster stop (0% brake): flatten everything + OFF, manual re-arm ----
async function agDisasterStop(){
  if(!ag) return;
  ag.state = 'stopped'; agSave();
  agSetBadge('stopped'); agSetLiveDot('error');
  agStat('agstat-state', '0% brake — OFF (re-arm manually)');
  clearInterval(agUptimeTimer);
  agStopOrderWs();
  await agCancelAll();
  await agMarketCloseNet();
  ag.longsUsd = 0; ag.shortsUsd = 0; ag.longsBase = 0; ag.shortsBase = 0;
  agShowControls(false, false);
  agSave();
  agRenderLevels(); agVizDirty = true;
}

// ---- Disarm (owner-initiated full stop) ----
async function agDisarm(){
  if(!ag) return;
  if(!confirm('Disarm: cancel all orders and market-close inventory on Lighter?')) return;
  ag.state = 'idle'; agSave();
  agSetBadge('idle'); agSetLiveDot('');
  agStat('agstat-state', 'Idle');
  clearInterval(agUptimeTimer);
  agStopOrderWs();
  await agCancelAll();
  await agMarketCloseNet();
  ag.longsUsd = 0; ag.shortsUsd = 0; ag.longsBase = 0; ag.shortsBase = 0;
  agShowControls(false, false);
  agSave();
  agRenderLevels(); agVizDirty = true;
  agToast('Disarmed — orders cancelled, inventory closed.');
}

// ---- Uptime ----
function agTickUptime(){
  if(!ag || !ag.startTime) return;
  const s = Math.floor((Date.now() - ag.startTime) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  agStat('agstat-uptime', h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m ${String(ss).padStart(2,'0')}s`);
}

// ---- Level table ----
function agRenderLevels(){
  const tb = agEl('ag-level-tbody');
  if(!tb) return;
  if(!ag || !ag.levels || !ag.levels.length){ tb.innerHTML = '<tr><td colspan="5" class="grid-table-empty">No grid armed</td></tr>'; return; }
  const rows = [];
  for(let i = ag.levels.length - 1; i >= 0; i--){
    const p = ag.levels[i];
    const openBuy  = ag.openState[AG_ROLE.OPEN_BUY  * 1000 + i] === 'open';
    const openSell = ag.openState[AG_ROLE.OPEN_SELL * 1000 + i] === 'open';
    const closeSell= ag.openState[AG_ROLE.CLOSE_SELL* 1000 + i] === 'open';
    const closeBuy = ag.openState[AG_ROLE.CLOSE_BUY * 1000 + i] === 'open';
    let side = '<span class="gl-status-idle">—</span>', st = '<span class="gl-status-idle">—</span>';
    if(openBuy){ side = '<span class="gl-side-buy">BUY</span>'; st = '<span class="gl-status-open">open</span>'; }
    else if(openSell){ side = '<span class="gl-side-sell">SELL</span>'; st = '<span class="gl-status-open">open</span>'; }
    else if(closeSell){ side = '<span class="gl-side-sell">close↑</span>'; st = '<span class="gl-status-open">open</span>'; }
    else if(closeBuy){ side = '<span class="gl-side-buy">close↓</span>'; st = '<span class="gl-status-open">open</span>'; }
    rows.push(`<tr><td>${i}</td><td>$${p.toLocaleString('en-US',{maximumFractionDigits:0})}</td><td>${side}</td><td>$${ag.unit.toFixed(0)}</td><td>${st}</td></tr>`);
  }
  tb.innerHTML = rows.join('');
}

// ---- Ladder viz (adapted from grid-lighter.js; wick=red, cap=amber) ----
function agStartVizLoop(){
  if(agVizRaf) cancelAnimationFrame(agVizRaf);
  (function loop(){ if(agVizDirty){ agDrawViz(); agVizDirty = false; } agVizRaf = requestAnimationFrame(loop); })();
}
function agDrawViz(){
  const canvas = agEl('ag-viz-canvas'), empty = agEl('ag-viz-empty');
  if(!canvas) return;
  if(!ag || !ag.levels || !ag.levels.length){ canvas.style.display = 'none'; if(empty) empty.style.display = 'flex'; return; }
  canvas.style.display = 'block'; if(empty) empty.style.display = 'none';
  const wrap = agEl('ag-viz-wrap');
  const W = wrap ? wrap.clientWidth - 28 : 500;
  const n = ag.levels.length;
  const rowH = Math.max(14, Math.min(34, Math.floor(460 / n)));
  const H = n * rowH + 40;
  canvas.width = W; canvas.height = H; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const lo = ag.wick, hi = ag.cap, range = hi - lo || 1;
  const padL = 92, padR = 20;
  const y = p => 20 + ((hi - p) / range) * (H - 40);

  ctx.fillStyle = 'rgba(40,215,200,0.04)';
  ctx.fillRect(padL, y(hi), W - padL - padR, y(lo) - y(hi));

  ag.levels.forEach((p, i) => {
    const openBuy  = ag.openState[AG_ROLE.OPEN_BUY  * 1000 + i] === 'open' || ag.openState[AG_ROLE.CLOSE_BUY * 1000 + i] === 'open';
    const openSell = ag.openState[AG_ROLE.OPEN_SELL * 1000 + i] === 'open' || ag.openState[AG_ROLE.CLOSE_SELL* 1000 + i] === 'open';
    const color = openBuy ? '#3ddc97' : openSell ? '#e2645f' : '#3d3c44';
    const yy = y(p);
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = (openBuy || openSell) ? 1.2 : 0.6;
    ctx.setLineDash((openBuy || openSell) ? [] : [4,4]);
    ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('$' + p.toLocaleString('en-US',{maximumFractionDigits:0}), padL - 5, yy + 3.5);
  });

  // cap (61.8%) — amber; wick (0%) — red disaster line
  [{ p: hi, c: '#d9a93f', t: '61.8% cap · hold' }, { p: lo, c: '#e2645f', t: '0% wick · disaster' }].forEach(b => {
    const yy = y(b.p);
    ctx.beginPath(); ctx.strokeStyle = b.c; ctx.lineWidth = 1.6; ctx.setLineDash([5,3]);
    ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = b.c; ctx.font = 'bold 9px Inter,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(b.t, padL + 4, yy - 3);
  });

  if(agPrice !== null && agPrice >= lo * 0.9 && agPrice <= hi * 1.1){
    const py = y(agPrice);
    ctx.beginPath(); ctx.strokeStyle = '#d9a93f'; ctx.lineWidth = 2; ctx.setLineDash([6,3]);
    ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#d9a93f'; ctx.font = 'bold 11px Inter,sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('$' + agPrice.toLocaleString('en-US',{maximumFractionDigits:0}), padL - 5, py - 4);
    ctx.beginPath(); ctx.arc(padL + 4, py, 4, 0, Math.PI*2); ctx.fillStyle = '#d9a93f'; ctx.fill();
  }
}

// ---- Restore on load ----
function agRestore(){
  const s = agLoad();
  if(!s) return;
  ag = s;
  // reflect config into the inputs
  const set = (id, v) => { const el = agEl(id); if(el && v !== undefined && v !== null) el.value = v; };
  set('ag-wick', s.wick); set('ag-cap', s.cap); set('ag-bankroll', s.bankroll);
  set('ag-sidecap', s.sideCapX); set('ag-step', s.stepPct); set('ag-leverage', s.leverage);

  if(s.state === 'armed' || s.state === 'paused'){
    agSetBadge(s.state); agSetLiveDot(s.state === 'paused' ? 'paused' : 'live'); agShowControls(true, s.state === 'paused');
    agStat('agstat-state', s.state === 'paused' ? 'Paused (restored)' : 'Running (restored)');
    agStat('agstat-fills', s.fills || 0);
    agStat('agstat-pnl', ((s.realized||0) >= 0 ? '+' : '') + '$' + (s.realized||0).toFixed(2), (s.realized||0) >= 0 ? 'up' : 'down');
    agStat('agstat-long', '$' + (s.longsUsd||0).toFixed(0));
    agStat('agstat-short', '$' + (s.shortsUsd||0).toFixed(0));
    agStartOrderWs();
    clearInterval(agUptimeTimer); agUptimeTimer = setInterval(agTickUptime, 1000);
  } else {
    agSetBadge(s.state === 'stopped' ? 'stopped' : 'idle');
    agStat('agstat-state', s.state === 'stopped' ? '0% brake — OFF' : 'Idle');
    agStat('agstat-fills', s.fills || 0);
    agStat('agstat-pnl', ((s.realized||0) >= 0 ? '+' : '') + '$' + (s.realized||0).toFixed(2), (s.realized||0) >= 0 ? 'up' : 'down');
  }
  agRenderLevels();
  agStartVizLoop();
  agRefreshBox();
}

// expose handlers for the inline onclick attributes in index.html
window.agArm = agArm;
window.agTogglePause = agTogglePause;
window.agDisarm = agDisarm;

// ---- bootstrap (read-only price feed + restore; NO auto-arm) ----
agResolveBtcMarket();
agStartPriceWs();
agFetchPriceFallback();
setInterval(agFetchPriceFallback, 3000);
agRestore();
agRefreshBox();

})(); }

// ===================== GRID BOT =====================
// BTC-only, neutral grid. Places all limit orders upfront.
// Price feed: WebSocket orderbook:0
// Fill detection: WebSocket account_all_orders:21229
// Counter-order on fill, SL at bounds ±0.5%, persists state in localStorage.

const GRID_STORAGE_KEY = 'ema_watch_grid_v1';
const GRID_WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';
const GRID_BTC_MARKET = 0;

let gridState = null; // persisted config + runtime data
let gridPriceWs = null;
let gridOrderWs = null;
let gridCurrentPrice = null;
let gridUptimeInterval = null;
let gridVizRaf = null;
let gridVizDirty = false;

// ---- Persistence ----
function gridSave(){
  try{ localStorage.setItem(GRID_STORAGE_KEY, JSON.stringify(gridState)); } catch(e){}
}
function gridLoad(){
  try{
    const raw = localStorage.getItem(GRID_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}

// ---- Toast ----
function gridToast(msg, durationMs = 3500){
  const el = document.getElementById('gridToast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), durationMs);
}

// ---- UI helpers ----
function gridSetBadge(state){ // 'idle'|'running'|'paused'|'stopped'
  const el = document.getElementById('grid-status-badge');
  if(!el) return;
  el.className = 'grid-status-badge ' + (state !== 'idle' ? state : '');
  el.textContent = state.toUpperCase();
}
function gridSetLiveDot(state){ // 'live'|'paused'|'error'|''
  const el = document.getElementById('grid-live-dot');
  if(!el) return;
  el.className = 'grid-live-dot ' + state;
}
function gridShowControls(running, paused){
  document.getElementById('grid-start-btn').style.display = running ? 'none' : 'flex';
  document.getElementById('grid-pause-btn').style.display = running ? 'flex' : 'none';
  document.getElementById('grid-stop-btn').style.display  = running ? 'flex' : 'none';
  const pauseBtn = document.getElementById('grid-pause-btn');
  if(pauseBtn){
    pauseBtn.innerHTML = paused
      ? '<i class="ti ti-player-play"></i> Resume'
      : '<i class="ti ti-player-pause"></i> Pause';
  }
}
function gridUpdateStat(id, val, cls){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = val;
  el.className = 'grid-stat-val' + (cls ? ' ' + cls : '');
}

// ---- Capital check ----
function gridCheckCapital(){
  const lower = parseFloat(document.getElementById('grid-lower').value);
  const upper = parseFloat(document.getElementById('grid-upper').value);
  const levels = parseInt(document.getElementById('grid-levels').value);
  const notional = parseFloat(document.getElementById('grid-notional').value);
  const leverage = parseFloat(document.getElementById('grid-leverage').value) || 50;
  const el = document.getElementById('grid-capital-check');

  // Update IMR display (BTC IMR = 1/leverage, min 2% at 50x per Lighter docs)
  const imr = Math.max(1 / leverage, 0.02);
  const imrEl = document.getElementById('grid-imr-display');
  if(imrEl) imrEl.textContent = (imr * 100).toFixed(1) + '%';

  if(!el) return true;
  if(isNaN(lower)||isNaN(upper)||isNaN(levels)||isNaN(notional)||levels<2){
    el.style.display = 'none'; return false;
  }
  if(upper<=lower){ el.style.display='block'; el.className='grid-capital-check warn'; el.textContent='Upper bound must be above lower bound.'; return false; }

  // Get available balance from dashboard element if it exists
  const dashSub = document.getElementById('dashLighterSub');
  let available = null;
  if(dashSub){
    const m = dashSub.textContent.match(/avail \$([0-9,]+)/);
    if(m) available = parseFloat(m[1].replace(/,/g,''));
  }

  // Required margin = total notional × IMR × 1.05 buffer
  const totalNotional = levels * notional;
  const required = totalNotional * imr * 1.05;
  el.style.display = 'block';

  if(available === null){
    el.className = 'grid-capital-check ok';
    el.innerHTML = `Required margin: <strong>~$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> ($${totalNotional.toLocaleString()} notional × ${(imr*100).toFixed(1)}% IMR + 5% buffer). Connect Lighter to validate.`;
    return true;
  }

  if(required > available){
    const maxNotional = Math.floor((available * 0.95) / (levels * imr));
    el.className = 'grid-capital-check warn';
    el.innerHTML = `Not possible — requires <strong>$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> margin but only <strong>$${available.toLocaleString('en-US',{maximumFractionDigits:0})}</strong> available.<br>Max notional per level: <strong>$${maxNotional.toLocaleString('en-US',{maximumFractionDigits:0})}</strong>`;
    return false;
  }

  el.className = 'grid-capital-check ok';
  el.innerHTML = `✓ Margin OK — requires <strong>$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> of $${available.toLocaleString('en-US',{maximumFractionDigits:0})} available ($${totalNotional.toLocaleString()} notional × ${(imr*100).toFixed(1)}% IMR)`;
  return true;
}

// wire up input listeners for capital check + slider label
['grid-lower','grid-upper','grid-levels','grid-notional','grid-leverage'].forEach(id => {
  const el = document.getElementById(id);
  if(el) el.addEventListener('input', () => {
    if(id === 'grid-leverage'){
      const v = el.value;
      const display = document.getElementById('grid-leverage-display');
      if(display) display.textContent = v + '×';
    }
    gridCheckCapital();
  });
});

// Start price feed immediately on load (always-on, not bot-dependent)
gridStartPriceWs();
gridFetchPriceFallback(); // REST fallback in case WS takes a moment

// ---- Price WebSocket (public orderbook:0) ----
// Always-on: starts on page load so price shows in viz even before bot starts
function gridStartPriceWs(){
  if(gridPriceWs && gridPriceWs.readyState < 2) return;
  gridPriceWs = new WebSocket(GRID_WS_URL);
  gridPriceWs.onopen = () => {
    gridPriceWs.send(JSON.stringify({type:'subscribe', channel:'orderbook:0'}));
  };
  gridPriceWs.onmessage = (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      // channel may be 'orderbook:0' or the data may be nested differently
      const ch = msg.channel || msg.type || '';
      const d = msg.data || msg;
      if(ch.includes('orderbook') || d.bids || d.asks || d.b || d.a){
        // best bid + best ask midpoint — Lighter sends arrays of [price_int, size_int]
        const bids = d.bids || d.b || [];
        const asks = d.asks || d.a || [];
        let price = null;
        if(bids.length && asks.length){
          // Entries can be [priceInt, sizeInt] arrays or objects with .price
          const rawBid = Array.isArray(bids[0]) ? bids[0][0] : (bids[0].price ?? bids[0].p ?? bids[0]);
          const rawAsk = Array.isArray(asks[0]) ? asks[0][0] : (asks[0].price ?? asks[0].p ?? asks[0]);
          const btcMarketData = lighterMarketMap ? Object.values(lighterMarketMap).find(m => m.marketIndex === GRID_BTC_MARKET) : null;
          const priceDecimals = btcMarketData ? btcMarketData.priceDecimals : 2;
          // If the price looks like an integer (>1e6 for BTC), scale it down
          let bid = parseFloat(rawBid);
          let ask = parseFloat(rawAsk);
          if(!isNaN(bid) && !isNaN(ask)){
            if(bid > 1e6) { bid = bid / Math.pow(10, priceDecimals); }
            if(ask > 1e6) { ask = ask / Math.pow(10, priceDecimals); }
            price = (bid + ask) / 2;
          }
        }
        if(price === null && d.last_price) price = parseFloat(d.last_price);
        if(price === null && d.mark_price) price = parseFloat(d.mark_price);
        if(price !== null && !isNaN(price) && price > 1000){
          gridCurrentPrice = price;
          gridUpdateStat('gstat-price', '$' + price.toLocaleString('en-US',{maximumFractionDigits:1}));
          gridVizDirty = true;
          // SL check — only when bot is running
          if(gridState && gridState.running && !gridState.paused){
            const slLow  = gridState.lower * 0.995;
            const slHigh = gridState.upper * 1.005;
            if(price <= slLow || price >= slHigh){
              console.warn('[GridBot] SL triggered — price', price, 'bounds', gridState.lower, gridState.upper);
              gridToast('⚠️ Stop-loss triggered — cancelling orders and closing position', 5000);
              gridBotStop(true);
            }
          }
        }
      }
    } catch(e){ console.warn('[GridBot] price WS parse error', e); }
  };
  gridPriceWs.onclose = () => {
    // Always reconnect — we want price even without bot running
    setTimeout(gridStartPriceWs, 3000);
  };
  gridPriceWs.onerror = () => { gridSetLiveDot('error'); };
}

// REST price fallback — fetch BTC mark price from Lighter REST API
// Runs on load and then every 15s as a safety net in case the WS price parse fails.
async function gridFetchPriceFallback(){
  try{
    const map = await fetchLighterMarketMap();
    if(!map) return;
    const res = await fetch(`${LIGHTER_BASE_URL}/api/v1/orderBooks`);
    if(!res.ok) return;
    const data = await res.json();
    const btcBook = (data.order_books || []).find(ob => ob.market_id === GRID_BTC_MARKET || ob.market_index === GRID_BTC_MARKET);
    if(btcBook){
      // mark_price and last_price come as plain USD floats from REST
      const p = parseFloat(btcBook.mark_price || btcBook.last_price || 0);
      if(p > 1000){
        gridCurrentPrice = p;
        gridUpdateStat('gstat-price', '$' + p.toLocaleString('en-US',{maximumFractionDigits:1}));
        gridVizDirty = true;
      }
    }
  } catch(e){}
}
// Poll REST every 15s so price stat always shows even if WS parse fails
setInterval(gridFetchPriceFallback, 15000);

function gridStopPriceWs(){
  if(gridPriceWs){ try{ gridPriceWs.close(); }catch(e){} gridPriceWs=null; }
}

// ---- Order fill WebSocket (account_all_orders:21229) ----
function gridStartOrderWs(){
  if(gridOrderWs && gridOrderWs.readyState < 2) return;
  gridOrderWs = new WebSocket(GRID_WS_URL);
  gridOrderWs.onopen = () => {
    gridOrderWs.send(JSON.stringify({type:'subscribe', channel:`account_all_orders:${LIGHTER_ACCOUNT_INDEX}`}));
  };
  gridOrderWs.onmessage = async (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      // Log ALL account_all_orders messages so we can see exact field names/values on fills
      if((msg.channel || '').startsWith('account_all_orders')){
        console.log('[GridBot] order WS raw:', JSON.stringify(msg).slice(0, 400));
      }
      if((msg.channel || '').startsWith('account_all_orders') && msg.data){
        const orders = Array.isArray(msg.data) ? msg.data : [msg.data];
        for(const order of orders){
          const status = order.status ?? order.order_status ?? order.state ?? '';
          const clientIdx = order.client_order_index ?? order.clientOrderIndex ?? order.client_order_idx;
          const isFilled = status === 'filled' || status === 'FILLED' || status === 2 || status === 'closed';
          console.log('[GridBot] order update — status:', status, 'clientIdx:', clientIdx, 'isFilled:', isFilled);
          if(isFilled){
            await gridHandleFill(order, clientIdx);
          }
        }
      }
    } catch(e){ console.warn('[GridBot] order WS parse error', e); }
  };
  gridOrderWs.onclose = () => {
    if(gridState && gridState.running){
      setTimeout(gridStartOrderWs, 3000);
    }
  };
}

function gridStopOrderWs(){
  if(gridOrderWs){ try{ gridOrderWs.close(); }catch(e){} gridOrderWs=null; }
}

// ---- Level helpers ----
// clientOrderIndex for grid levels: 100 + levelIndex (0-based)
// counter-orders use 200 + levelIndex
function levelIdxFromClientIdx(ci){ return ci - 100; }

async function gridHandleFill(order, clientIdx){
  if(!gridState || !gridState.running || gridState.paused) return;
  // clientIdx may be string or number — coerce
  const ci = parseInt(clientIdx, 10);
  console.log('[GridBot] fill detected clientIdx=', ci, 'order=', order);
  const li = ci - 100; // levels use clientOrderIndex 100+i
  if(isNaN(ci) || li < 0 || li >= gridState.levels.length){
    console.log('[GridBot] fill ignored — not a grid level idx', ci);
    return;
  }

  const level = gridState.levels[li];
  if(!level || level.status === 'filled') return; // already handled

  level.status = 'filled';
  gridState.fillCount = (gridState.fillCount || 0) + 1;
  gridState.pnl = (gridState.pnl || 0); // updated below

  // Realize grid profit: each fill earns (price_gap * btc_size) per round trip
  const priceStep = (gridState.upper - gridState.lower) / (gridState.levels.length - 1);
  const btcSize = gridState.notional / level.price;
  gridState.pnl += priceStep * btcSize * 0.5; // half realized on fill, half on counter fill

  gridSave();
  gridUpdateStat('gstat-fills', gridState.fillCount);
  gridUpdateStat('gstat-pnl', (gridState.pnl >= 0 ? '+' : '') + '$' + gridState.pnl.toFixed(2), gridState.pnl >= 0 ? 'up' : 'down');
  gridRenderLevelTable();
  gridVizDirty = true;

  // Place counter-order one level up (if buy filled → place sell above) or down (if sell filled → place buy below)
  const isBuy = !level.isAsk;
  const counterLevelIdx = isBuy ? li + 1 : li - 1;
  if(counterLevelIdx >= 0 && counterLevelIdx < gridState.levels.length){
    const counterLevel = gridState.levels[counterLevelIdx];
    await gridPlaceSingleOrder(counterLevel.price, !isBuy, gridState.notional, 200 + li);
    console.log('[GridBot] counter-order placed at', counterLevel.price, !isBuy ? 'sell' : 'buy');
  }
}

// ---- Order placement ----
// Signs via WASM then sends with priceProtection=false to avoid "accidental price" rejection
// for limit orders placed away from current price (normal for grid bots).
async function gridPlaceSingleOrder(price, isAsk, notional, clientOrderIdx){
  try{
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor;
    const map = await fetchLighterMarketMap();

    const market = map ? (map['BTC'] || Object.entries(map).find(([k]) => k.startsWith('BTC'))?.[1]) : null;
    if(!market){ console.error('[GridBot] BTC market not found'); return null; }

    const btcSize = notional / price;
    const base_amount = toLighterInt(btcSize, market.sizeDecimals);
    const priceLighter = toLighterInt(price, market.priceDecimals);

    // Use createOrderOptimized with unique clientOrderIndex per level.
    // Per official Lighter docs: cancel_order(market_index, order_index=client_order_index)
    console.log('[GridBot] placing', { price, isAsk, clientOrderIdx, marketIndex: market.marketIndex, base_amount, priceLighter });
    const [tx, hash, error] = await signer.createOrderOptimized({
      marketIndex: market.marketIndex,
      clientOrderIndex: clientOrderIdx,
      baseAmount: base_amount,
      price: priceLighter,
      isAsk,
      orderType: SC.ORDER_TYPE_LIMIT,
      timeInForce: SC.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
      reduceOnly: false,
      triggerPrice: 0,
      orderExpiry: Date.now() + 28 * 24 * 60 * 60 * 1000
    });
    if(error){ console.error('[GridBot] order error', error); return null; }
    console.log('[GridBot] order placed', hash);
    return { marketIndex: market.marketIndex, clientOrderIdx };
  } catch(e){
    console.error('[GridBot] order exception', e.message || e);
    return null;
  }
}

async function gridCancelAllOrders(){
  try{
    const signer = await window.__getLighterSigner();
    const levels = gridState ? gridState.levels || [] : [];
    const openLevels = levels.filter(lv => lv.status === 'open' && lv.clientOrderIdx !== undefined);
    console.log('[GridBot] cancelling', openLevels.length, 'orders by clientOrderIdx');
    for(const lv of openLevels){
      const [,, err] = await signer.cancelOrder({ marketIndex: lv.marketIndex, orderIndex: lv.clientOrderIdx });
      if(err) console.warn('[GridBot] cancel error idx', lv.clientOrderIdx, err);
      else console.log('[GridBot] cancelled', lv.clientOrderIdx);
    }
    // Also cancel bound SL orders
    if(gridState?.slLowerIdx !== undefined){
      const mkt = gridState.slMarketIndex;
      const [,, e1] = await signer.cancelOrder({ marketIndex: mkt, orderIndex: gridState.slLowerIdx });
      if(e1) console.warn('[GridBot] cancel lower SL error', e1);
      else console.log('[GridBot] cancelled lower SL', gridState.slLowerIdx);
    }
    if(gridState?.slUpperIdx !== undefined){
      const mkt = gridState.slMarketIndex;
      const [,, e2] = await signer.cancelOrder({ marketIndex: mkt, orderIndex: gridState.slUpperIdx });
      if(e2) console.warn('[GridBot] cancel upper SL error', e2);
      else console.log('[GridBot] cancelled upper SL', gridState.slUpperIdx);
    }
  } catch(e){
    console.warn('[GridBot] gridCancelAllOrders error:', e.message || e);
  }
}

// Place two reduce-only stop-loss orders at the grid bounds.
// Lower bound SL: triggers if price drops to lower*0.995 — closes longs.
// Upper bound SL: triggers if price rises to upper*1.005 — closes shorts.
// Size = max possible position = all levels × notional / midPrice (BTC amount).
async function gridPlaceBoundSLs(){
  try{
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor;
    const map = await fetchLighterMarketMap();
    const market = map ? (map['BTC'] || Object.entries(map).find(([k]) => k.startsWith('BTC'))?.[1]) : null;
    if(!market){ console.error('[GridBot] BTC market not found for SL'); return; }

    const { lower, upper, nLevels, notional } = gridState;
    const midPrice = (lower + upper) / 2;
    const maxBtcSize = (nLevels * notional) / midPrice;
    const slSize = toLighterInt(maxBtcSize, market.sizeDecimals);
    const expiry = Date.now() + 28 * 24 * 60 * 60 * 1000;

    const slLowerPrice = lower * 0.995;
    const slUpperPrice = upper * 1.005;
    const slLowerPriceLighter = toLighterInt(slLowerPrice, market.priceDecimals);
    const slUpperPriceLighter = toLighterInt(slUpperPrice, market.priceDecimals);

    async function placeSL(clientOrderIndex, price, isAsk, label){
      const nonceResult = await signer.transactionApi.getNextNonce(signer.config.accountIndex, signer.config.apiKeyIndex);
      const wasmParams = {
        marketIndex: market.marketIndex,
        clientOrderIndex,
        baseAmount: slSize,
        price,
        isAsk: isAsk ? 1 : 0,
        orderType: SC.ORDER_TYPE_STOP_LOSS,
        timeInForce: SC.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
        reduceOnly: 0,
        triggerPrice: price,
        orderExpiry: expiry,
        integratorAccountIndex: 0,
        integratorTakerFee: 0,
        integratorMakerFee: 0,
        skipNonce: 0,
        nonce: nonceResult.nonce,
        apiKeyIndex: signer.config.apiKeyIndex,
        accountIndex: signer.config.accountIndex
      };
      const wasmResponse = await signer.wallet.signCreateOrder(wasmParams);
      if(wasmResponse.error){ console.warn(`[GridBot] ${label} SL sign error`, wasmResponse.error); return false; }
      const txHash = await signer.transactionApi.sendTxWithIndices(
        wasmResponse.txType || SC.TX_TYPE_CREATE_ORDER,
        wasmResponse.txInfo,
        signer.config.accountIndex,
        signer.config.apiKeyIndex,
        false // priceProtection=false
      );
      if(txHash.code && txHash.code !== 200){ console.warn(`[GridBot] ${label} SL send error`, txHash.message); return false; }
      console.log(`[GridBot] ${label} SL placed`, txHash.tx_hash || txHash.hash);
      return true;
    }

    // Lower SL — sell to close longs
    const okLow = await placeSL(90, slLowerPriceLighter, true, 'lower');
    if(okLow){ gridState.slLowerIdx = 90; }

    // Upper SL — buy to close shorts
    const okHigh = await placeSL(91, slUpperPriceLighter, false, 'upper');
    if(okHigh){ gridState.slUpperIdx = 91; }

    gridState.slMarketIndex = market.marketIndex;
    gridSave();
  } catch(e){
    console.warn('[GridBot] gridPlaceBoundSLs error:', e.message || e);
  }
}

// ---- Start ----
async function gridBotStart(){
  const lower   = parseFloat(document.getElementById('grid-lower').value);
  const upper   = parseFloat(document.getElementById('grid-upper').value);
  const nLevels = parseInt(document.getElementById('grid-levels').value);
  const notional= parseFloat(document.getElementById('grid-notional').value);
  const leverage= parseFloat(document.getElementById('grid-leverage').value) || 50;

  if(isNaN(lower)||isNaN(upper)||isNaN(nLevels)||isNaN(notional)){
    gridToast('Fill in all fields before starting.'); return;
  }
  if(upper<=lower){ gridToast('Upper bound must be above lower.'); return; }
  if(nLevels<2){ gridToast('Need at least 2 levels.'); return; }
  if(!gridCheckCapital()) return;

  const privateKey = localStorage.getItem('lighterPrivateKey');
  if(!privateKey){ gridToast('No Lighter private key — set it in Settings.'); return; }

  // Build levels
  const step = (upper - lower) / (nLevels - 1);
  const price = gridCurrentPrice || (lower + upper) / 2;
  const levels = [];
  for(let i = 0; i < nLevels; i++){
    const lp = lower + i * step;
    const isAsk = lp > price; // above price → sell, below → buy
    levels.push({ price: lp, isAsk, notional, status: 'pending', clientOrderIndex: 100 + i });
  }

  gridState = {
    lower, upper, nLevels, notional, leverage,
    levels, running: true, paused: false,
    startTime: Date.now(), fillCount: 0, pnl: 0
  };
  gridSave();

  gridSetBadge('running');
  gridSetLiveDot('live');
  gridShowControls(true, false);
  gridUpdateStat('gstat-state', 'Placing orders…');
  gridUpdateStat('gstat-orders', '0');

  // Start WebSockets
  gridStartPriceWs();
  gridStartOrderWs();

  // Start uptime ticker
  clearInterval(gridUptimeInterval);
  gridUptimeInterval = setInterval(gridTickUptime, 1000);

  // Start viz loop
  gridStartVizLoop();

  // Place all orders upfront
  let placed = 0;
  const startBtn = document.getElementById('grid-start-btn');
  if(startBtn){ startBtn.disabled = true; }

  for(let i = 0; i < levels.length; i++){
    const lv = levels[i];
    if(Math.abs(lv.price - price) < step * 0.1){ lv.status = 'skip'; continue; }
    const clientOrderIdx = 100 + i; // unique per level, stored for cancellation
    const result = await gridPlaceSingleOrder(lv.price, lv.isAsk, lv.notional, clientOrderIdx);
    if(result !== null){
      lv.status = 'open';
      lv.marketIndex = result.marketIndex;
      lv.clientOrderIdx = result.clientOrderIdx;
      placed++;
    } else {
      lv.status = 'error';
    }
    gridState.levels[i] = lv;
    gridUpdateStat('gstat-orders', placed);
    gridRenderLevelTable();
    gridVizDirty = true;
    await new Promise(r => setTimeout(r, 120));
  }

  gridSave();
  gridUpdateStat('gstat-state', 'Running');
  // Place bound stop-losses on Lighter at lower−0.5% and upper+0.5%
  await gridPlaceBoundSLs();
  gridToast(`✓ Grid bot started — ${placed} orders placed across ${nLevels} levels`);
  console.log('[GridBot] started, placed', placed, '/', nLevels, 'orders');
}

// ---- Pause / Resume ----
function gridBotTogglePause(){
  if(!gridState) return;
  gridState.paused = !gridState.paused;
  gridSave();
  const paused = gridState.paused;
  gridSetBadge(paused ? 'paused' : 'running');
  gridSetLiveDot(paused ? 'paused' : 'live');
  gridShowControls(true, paused);
  gridUpdateStat('gstat-state', paused ? 'Paused' : 'Running');
  gridToast(paused ? '⏸ Bot paused — no new counter-orders will be placed' : '▶ Bot resumed');
}

// ---- Stop ----
async function gridBotStop(isSL){
  if(!gridState) return;
  gridState.running = false;
  gridState.paused  = false;
  gridSave();

  gridSetBadge('stopped');
  gridSetLiveDot('error');
  gridShowControls(false, false);
  gridUpdateStat('gstat-state', isSL ? 'SL Triggered' : 'Stopped');
  clearInterval(gridUptimeInterval);
  gridStopPriceWs();
  gridStopOrderWs();

  // Cancel all grid orders on Lighter + always market close any open position
  await gridCancelAllOrders();
  try{
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor;
    await signer.createOrderOptimized({
      marketIndex: GRID_BTC_MARKET,
      clientOrderIndex: 0,
      baseAmount: 0,
      price: 0,
      isAsk: false,
      orderType: SC.ORDER_TYPE_MARKET,
      timeInForce: SC.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
      reduceOnly: true,
      triggerPrice: 0,
      orderExpiry: 0
    });
    console.log('[GridBot] market close sent');
  } catch(e){ console.warn('[GridBot] market close failed (may have no position)', e); }

  gridRenderLevelTable();
  gridVizDirty = true;
  if(!isSL) gridToast('Bot stopped. Orders cancelled & position closed.');
}

// ---- Uptime ----
function gridTickUptime(){
  if(!gridState || !gridState.startTime) return;
  const secs = Math.floor((Date.now() - gridState.startTime) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const str = h > 0
    ? `${h}h ${m.toString().padStart(2,'0')}m`
    : `${m}m ${s.toString().padStart(2,'0')}s`;
  gridUpdateStat('gstat-uptime', str);
}

// ---- Level Table ----
function gridRenderLevelTable(){
  const tbody = document.getElementById('grid-level-tbody');
  if(!tbody) return;
  if(!gridState || !gridState.levels || !gridState.levels.length){
    tbody.innerHTML = '<tr><td colspan="5" class="grid-table-empty">No grid active</td></tr>';
    return;
  }
  const rows = [...gridState.levels].reverse().map((lv, ri) => {
    const i = gridState.levels.length - 1 - ri;
    const side = lv.isAsk
      ? '<span class="gl-side-sell">SELL</span>'
      : '<span class="gl-side-buy">BUY</span>';
    const statusMap = {
      pending:'<span class="gl-status-idle">pending</span>',
      open:   '<span class="gl-status-open">open</span>',
      filled: '<span class="gl-status-filled">filled</span>',
      error:  '<span class="gl-status-sl">error</span>',
      skip:   '<span class="gl-status-idle">—</span>',
    };
    const status = statusMap[lv.status] || lv.status;
    return `<tr>
      <td>${i+1}</td>
      <td>$${lv.price.toLocaleString('en-US',{maximumFractionDigits:0})}</td>
      <td>${side}</td>
      <td>$${lv.notional.toLocaleString('en-US',{maximumFractionDigits:0})}</td>
      <td>${status}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

// ---- Visualization ----
function gridStartVizLoop(){
  if(gridVizRaf) cancelAnimationFrame(gridVizRaf);
  function loop(){
    if(gridVizDirty){ gridDrawViz(); gridVizDirty = false; }
    gridVizRaf = requestAnimationFrame(loop);
  }
  gridVizRaf = requestAnimationFrame(loop);
}

function gridDrawViz(){
  const canvas = document.getElementById('grid-viz-canvas');
  const empty  = document.getElementById('grid-viz-empty');
  if(!canvas) return;

  if(!gridState || !gridState.levels || !gridState.levels.length){
    canvas.style.display = 'none';
    if(empty) empty.style.display = 'flex';
    return;
  }

  canvas.style.display = 'block';
  if(empty) empty.style.display = 'none';

  const wrap = document.getElementById('grid-viz-wrap');
  const W = wrap ? wrap.clientWidth - 28 : 500;
  const nLevels = gridState.levels.length;
  const rowH = Math.max(22, Math.min(40, Math.floor(440 / nLevels)));
  const H = nLevels * rowH + 40;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const lower = gridState.lower;
  const upper = gridState.upper;
  const priceRange = upper - lower || 1;
  const padLeft = 90;
  const padRight = 20;
  const barW = W - padLeft - padRight;

  const priceToY = (p) => {
    // top = upper, bottom = lower
    return 20 + ((upper - p) / priceRange) * (H - 40);
  };

  // background stripe for grid zone
  ctx.fillStyle = 'rgba(40,215,200,0.04)';
  ctx.fillRect(padLeft, priceToY(upper), barW, priceToY(lower) - priceToY(upper));

  // draw levels
  gridState.levels.forEach((lv, i) => {
    const y = priceToY(lv.price);
    const isBuy = !lv.isAsk;
    const color = lv.status === 'filled' ? '#d9a93f'
                : lv.status === 'open'   ? (isBuy ? '#3ddc97' : '#e2645f')
                : lv.status === 'error'  ? '#e2645f'
                : '#3d3c44';

    // horizontal line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lv.status === 'open' ? 1.2 : 0.7;
    ctx.setLineDash(lv.status === 'open' ? [] : [4,4]);
    ctx.moveTo(padLeft, y);
    ctx.lineTo(W - padRight, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // price label
    ctx.fillStyle = color;
    ctx.font = '10px Inter,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('$' + lv.price.toLocaleString('en-US',{maximumFractionDigits:0}), padLeft - 5, y + 3.5);

    // side arrow indicator
    if(lv.status === 'open'){
      ctx.fillStyle = color;
      ctx.font = 'bold 9px Inter,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(isBuy ? '▶' : '◀', W - padRight + 3, y + 3.5);
    }
  });

  // current price line
  if(gridCurrentPrice !== null && gridCurrentPrice >= lower * 0.9 && gridCurrentPrice <= upper * 1.1){
    const py = priceToY(gridCurrentPrice);
    ctx.beginPath();
    ctx.strokeStyle = '#d9a93f';
    ctx.lineWidth = 2;
    ctx.setLineDash([6,3]);
    ctx.moveTo(padLeft, py);
    ctx.lineTo(W - padRight, py);
    ctx.stroke();
    ctx.setLineDash([]);

    // price label
    ctx.fillStyle = '#d9a93f';
    ctx.font = 'bold 11px Inter,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('$' + gridCurrentPrice.toLocaleString('en-US',{maximumFractionDigits:0}), padLeft - 5, py - 4);

    // dot
    ctx.beginPath();
    ctx.arc(padLeft + 4, py, 4, 0, Math.PI*2);
    ctx.fillStyle = '#d9a93f';
    ctx.fill();
  }

  // SL markers
  const slLow  = lower * 0.995;
  const slHigh = upper * 1.005;
  [slLow, slHigh].forEach(sl => {
    if(sl < lower*0.85 || sl > upper*1.15) return;
    const sy = priceToY(sl);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(226,100,95,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2,4]);
    ctx.moveTo(padLeft, sy);
    ctx.lineTo(W - padRight, sy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(226,100,95,0.7)';
    ctx.font = '9px Inter,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('SL', padLeft - 5, sy + 3);
  });
}

// ---- Restore state on load ----
(function gridRestoreOnLoad(){
  const saved = gridLoad();
  if(!saved) return;
  gridState = saved;
  // Restore UI values
  document.getElementById('grid-lower').value    = saved.lower || '';
  document.getElementById('grid-upper').value    = saved.upper || '';
  document.getElementById('grid-levels').value   = saved.nLevels || '';
  document.getElementById('grid-notional').value = saved.notional || '';
  document.getElementById('grid-leverage').value = saved.leverage || 50;

  if(saved.running){
    gridSetBadge(saved.paused ? 'paused' : 'running');
    gridSetLiveDot(saved.paused ? 'paused' : 'live');
    gridShowControls(true, saved.paused);
    gridUpdateStat('gstat-fills', saved.fillCount || 0);
    const pnl = saved.pnl || 0;
    gridUpdateStat('gstat-pnl', (pnl>=0?'+':'')+'$'+pnl.toFixed(2), pnl>=0?'up':'down');
    gridUpdateStat('gstat-orders', (saved.levels||[]).filter(l=>l.status==='open').length);
    gridUpdateStat('gstat-state', saved.paused ? 'Paused (restored)' : 'Running (restored)');
    // Reconnect WebSockets
    gridStartPriceWs();
    if(!saved.paused) gridStartOrderWs();
    clearInterval(gridUptimeInterval);
    gridUptimeInterval = setInterval(gridTickUptime, 1000);
    gridStartVizLoop();
  } else {
    gridSetBadge('stopped');
    gridUpdateStat('gstat-state', 'Stopped');
    const pnl = saved.pnl || 0;
    gridUpdateStat('gstat-pnl', (pnl>=0?'+':'')+'$'+pnl.toFixed(2), pnl>=0?'up':'down');
    gridUpdateStat('gstat-fills', saved.fillCount || 0);
    gridStartVizLoop();
  }
  gridRenderLevelTable();
  gridCheckCapital();
})();

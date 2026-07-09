// ===================== LIGHTER EXECUTOR =====================
let lighterMarketMap = null;       // ticker (uppercase) -> { marketIndex, sizeDecimals, priceDecimals, status }
let lighterMarketFetchPromise = null;

async function fetchLighterMarketMap(){
  if(lighterMarketMap) return lighterMarketMap;
  if(lighterMarketFetchPromise) return lighterMarketFetchPromise;

  lighterMarketFetchPromise = (async () => {
    try{
      const res = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
      if(!res.ok) throw new Error(`orderBooks HTTP ${res.status}`);
      const data = await res.json();
      const map = {};
      for(const ob of (data.order_books || [])){
        map[ob.symbol.toUpperCase()] = {
          marketIndex: ob.market_id,
          sizeDecimals: ob.supported_size_decimals,
          priceDecimals: ob.supported_price_decimals,
          status: ob.status
        };
      }
      lighterMarketMap = map;
      return map;
    } catch(err){
      console.error('[Lighter market data] failed to fetch orderBooks:', err);
      lighterMarketFetchPromise = null; // allow retry on next call
      return null;
    }
  })();

  return lighterMarketFetchPromise;
}

// Looks up a single ticker in the cached map. Returns null if the map hasn't
// loaded yet or the ticker isn't found (delisted, or naming mismatch between
// our watchlist ticker and Lighter's symbol string, e.g. "1000PEPE" vs "PEPE").
function resolveLighterMarket(ticker){
  if(!lighterMarketMap || !ticker) return null;
  return lighterMarketMap[ticker.toUpperCase()] || null;
}

// Converts a human-readable size/price into Lighter's required integer format,
// scaled by that market's own decimal precision. Per Lighter's docs: amounts and
// prices are passed as integers, e.g. priceDecimals=2 means $3100.00 -> 310000.
function toLighterInt(value, decimals){
  if(value === null || value === undefined || isNaN(value)) return null;
  return Math.round(value * Math.pow(10, decimals));
}

// ===================== LIGHTER TRADE EXECUTOR (STUB) =====================
// This is the test-phase stub: no signing, no network call to Lighter to place
// orders. placeOnLighter() builds the request object Lighter would eventually
// need and console.logs it, so the data flow/shape can be reviewed before any
// real signer (the community lighter-ts WASM port) gets wired in as its own
// separate step.
//
// market_index and the integer-scaled amount/price fields are now resolved for
// real via the live orderBooks lookup above, rather than left as placeholders -
// but the actual order submission (signing + network call) is still stubbed.

let execOrderType = 'market'; // 'market' | 'limit'
let execSlTouchedManually = false;
let execSizeTouchedManually = false;

function setExecOrderType(type){
  execOrderType = type;
  document.getElementById('exec-type-market').classList.toggle('active', type === 'market');
  document.getElementById('exec-type-limit').classList.toggle('active', type === 'limit');
  document.getElementById('exec-limit-price').disabled = (type === 'market');
  if(type === 'market') document.getElementById('exec-limit-price').value = '';
  // entry slippage tolerance only applies to market orders - for limit orders the
  // limit price itself already is the worst acceptable price, so this row is moot
  document.getElementById('exec-entry-slippage-enabled').disabled = (type === 'limit');
  document.getElementById('exec-entry-slippage-pct').disabled = (type === 'limit');
  document.getElementById('exec-entry-slippage-row').style.opacity = (type === 'limit') ? '0.4' : '1';
  clearExecValidationMsg();
}

// Keeps the executor's read-only direction tag in sync with the journal's own
// direction select - the executor intentionally has no long/short control of its
// own, since direction is set once at the top of the form, not repeated here.
function syncExecDirectionTag(){
  const dirSelect = document.getElementById('jf-direction');
  const tag = document.getElementById('exec-dir-tag');
  if(!dirSelect || !tag) return;
  const dir = dirSelect.value;
  tag.textContent = dir.toUpperCase();
  tag.className = 'dir-tag ' + (dir === 'short' ? 'dir-short' : 'dir-long');
}

// SL price and size both follow the same prefill-then-lock pattern: they mirror
// the corresponding journal field live UNTIL the user types directly into the
// executor's own copy, at which point that field stops following the journal
// field so a manual override isn't silently clobbered by further journal edits.
function syncExecSlPrice(){ /* no-op: SL is now a direct input on the Trade tab */ }
function syncExecSize(){ /* no-op: size is now a direct input on the Trade tab */ }

function showExecValidationMsg(msg){
  const el = document.getElementById('exec-validation-msg');
  if(!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('exec-place-btn').disabled = true;
}

function clearExecValidationMsg(){
  const el = document.getElementById('exec-validation-msg');
  if(!el) return;
  el.style.display = 'none';
  el.textContent = '';
  document.getElementById('exec-place-btn').disabled = false;
}

// Real dismiss-required popup for the "ticker not tradable on Lighter" case -
// distinct from the inline amber messages used for ordinary fixable validation
// errors (missing size, missing SL price, etc.), since this one means the trade
// fundamentally can't be routed through Lighter at all, not just incomplete.
function openExecTickerModal(ticker, stillLoading){
  const body = document.getElementById('exec-ticker-modal-body');
  body.textContent = stillLoading
    ? `Lighter's market list is still loading — try again in a moment.`
    : `"${ticker}" isn't a tradable pair on Lighter. Double-check the ticker, or this pair may simply not be listed there.`;
  document.getElementById('exec-ticker-modal-overlay').style.display = 'flex';
}

function closeExecTickerModal(){
  document.getElementById('exec-ticker-modal-overlay').style.display = 'none';
}

// Validates just enough to keep the order from being submitted obviously
// incomplete or with a bogus slippage reference - ticker, size, and SL price are
// required regardless of order type; limit orders additionally require a limit
// price; market orders need the ticker resolvable in a live watchlist so the
// slippage cap can be anchored to a real current price, not a guess.
function validateExecFields(){
  const ticker = document.getElementById('jf-ticker').value.trim().toUpperCase();
  const notional = document.getElementById('jf-notional').value;
  const slPrice = document.getElementById('exec-sl-price').value;
  const limitPrice = document.getElementById('exec-limit-price').value;

  if(!ticker){ showExecValidationMsg('enter a ticker above before placing on Lighter'); return false; }
  if(!notional || parseFloat(notional) <= 0){ showExecValidationMsg('notional size is required'); return false; }
  if(!slPrice || parseFloat(slPrice) <= 0){ showExecValidationMsg('SL price is required'); return false; }
  if(execOrderType === 'limit' && (!limitPrice || parseFloat(limitPrice) <= 0)){
    showExecValidationMsg('limit price is required for limit orders');
    return false;
  }
  if(execOrderType === 'market'){
    const liveMatch = cryptoData.find(d => d.symbol === ticker) || stockData.find(d => d.symbol === ticker);
    if(!liveMatch){
      showExecValidationMsg(`"${ticker}" isn't loaded in the current watchlist - can't anchor market order slippage to a live price. Refresh the watchlist, or use a limit order instead.`);
      return false;
    }
  }
  clearExecValidationMsg();
  return true;
}

// Builds the order request and submits it for real signing via the WASM signer.
// market_index, base_amount, and price are resolved via the live orderBooks lookup.
function placeOnLighter(){
  if(!validateExecFields()) return;

  const ticker = document.getElementById('jf-ticker').value.trim().toUpperCase();
  const direction = document.getElementById('jf-direction').value;
  const size = parseFloat(document.getElementById('jf-notional').value);
  const slPrice = parseFloat(document.getElementById('exec-sl-price').value);
  const slippageEnabled = document.getElementById('exec-slippage-enabled').checked;
  const slippagePct = parseFloat(document.getElementById('exec-slippage-pct').value) || 0;
  const limitPrice = execOrderType === 'limit' ? parseFloat(document.getElementById('exec-limit-price').value) : null;
  const entrySlippageEnabled = document.getElementById('exec-entry-slippage-enabled').checked;
  const entrySlippagePct = parseFloat(document.getElementById('exec-entry-slippage-pct').value) || 0;

  const market = resolveLighterMarket(ticker);
  if(!market){
    clearExecValidationMsg();
    openExecTickerModal(ticker, !lighterMarketMap);
    return;
  }

  // For market orders, Lighter's `price` field is NOT a fill price - per their own
  // docs/SDK reference it's the worst acceptable execution price (slippage cap vs
  // the live market), independent of where the SL sits. Using SL price here was the
  // bug that got an order auto-cancelled for "excessive slippage" - SL can sit far
  // from the live price by design, so anchoring the entry's slippage cap to it was
  // never correct. The live last price comes from whichever watchlist (crypto or
  // stocks) currently has this ticker loaded - same lookup pattern already used by
  // autofillJournalChecksFromTicker.
  const liveMatch = cryptoData.find(d => d.symbol === ticker) || stockData.find(d => d.symbol === ticker);
  const livePrice = liveMatch ? liveMatch.price : null;

  let referencePrice;
  if(limitPrice !== null){
    // limit orders: the limit price itself already IS the worst acceptable price
    referencePrice = limitPrice;
  } else if(livePrice != null){
    // market orders: worst acceptable price = live price +/- entry slippage tolerance,
    // direction-aware (a long's worst case is paying MORE, a short's worst case is
    // receiving LESS)
    const entrySlippageFraction = entrySlippageEnabled ? entrySlippagePct / 100 : 0;
    referencePrice = direction === 'short'
      ? livePrice * (1 - entrySlippageFraction)
      : livePrice * (1 + entrySlippageFraction);
  } else {
    // fallback if this ticker isn't currently loaded in either watchlist (e.g. typed
    // manually, watchlist not yet refreshed) - SL price as a last resort, same as
    // the old behavior, rather than failing outright
    referencePrice = slPrice;
  }

  const slippageFraction = slippageEnabled ? slippagePct / 100 : 0;
  const slExecutionPrice = slippageEnabled
    ? (direction === 'short' ? slPrice * (1 + slippageFraction) : slPrice * (1 - slippageFraction))
    : slPrice;

  const orderRequest = {
    // --- human-readable fields ---
    ticker,
    direction,                               // 'long' | 'short' - maps to is_ask: false/true
    orderType: execOrderType,                // 'market' | 'limit'
    sizeUsd: size,
    limitPrice,                              // null for market orders
    livePrice,                               // reference price used to anchor market-order slippage cap
    entrySlippage: (execOrderType === 'market')
      ? (entrySlippageEnabled ? { enabled: true, pct: entrySlippagePct } : { enabled: false, pct: null })
      : null,
    slPrice,
    slSlippage: slippageEnabled ? { enabled: true, pct: slippagePct } : { enabled: false, pct: null },
    grouping: 'GROUPING_TYPE_ONE_TRIGGERS_THE_OTHER', // entry + SL as one bundled OTO group

    // --- resolved Lighter wire-format fields ---
    market_index: market.marketIndex,
    base_amount: toLighterInt(size, market.sizeDecimals),
    price: toLighterInt(referencePrice, market.priceDecimals),
    slTriggerPrice: toLighterInt(slPrice, market.priceDecimals),
    slExecutionPrice: toLighterInt(slExecutionPrice, market.priceDecimals),
    is_ask: direction === 'short',
  };

  submitOrderToLighter(orderRequest);
}

// In-browser signing via lighter-ts-sdk (loaded as an ESM module above, which
// exposes window.__getLighterSigner + window.__LighterGroupingType since this
// classic script can't use `import` directly). Entry + SL are bundled as one
// OTO (One-Triggers-the-Other) grouped order: leg 0 is the entry (market or
// limit), leg 1 is the SL, ReduceOnly, opposite side, triggered off slPrice.
async function submitOrderToLighter(orderRequest){
  const btn = document.getElementById('exec-place-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'placing...';

  try{
    const signer = await window.__getLighterSigner();
    const SC = signer.constructor; // SignerClient, for its static ORDER_TYPE_* / TIF_* constants
    const GroupingType = window.__LighterGroupingType;

    const isAsk = orderRequest.is_ask; // true = short/sell, false = long/buy
    const entryOrderType = orderRequest.orderType === 'market' ? SC.ORDER_TYPE_MARKET : SC.ORDER_TYPE_LIMIT;
    const entryTimeInForce = orderRequest.orderType === 'market'
      ? SC.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
      : SC.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME;

    const entryExpiry = orderRequest.orderType === 'market' ? 0 : Date.now() + 28 * 24 * 60 * 60 * 1000;
    const protectionExpiry = Date.now() + 28 * 24 * 60 * 60 * 1000;

    const entryLeg = {
      marketIndex: orderRequest.market_index,
      clientOrderIndex: 0,
      baseAmount: orderRequest.base_amount,
      price: orderRequest.price,
      isAsk,
      orderType: entryOrderType,
      timeInForce: entryTimeInForce,
      reduceOnly: false,
      triggerPrice: 0,
      orderExpiry: entryExpiry
    };

    const slLeg = {
      marketIndex: orderRequest.market_index,
      clientOrderIndex: 0,
      baseAmount: 0, // reduce-only trigger leg must be 0/nil per SDK's own OTOCO reference pattern
      price: orderRequest.slExecutionPrice,
      isAsk: !isAsk, // SL closes the position, so it's the opposite side of entry
      orderType: SC.ORDER_TYPE_STOP_LOSS,
      timeInForce: SC.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
      reduceOnly: true,
      triggerPrice: orderRequest.slTriggerPrice,
      orderExpiry: protectionExpiry
    };

    const [tx, hash, error] = await signer.createGroupedOrders(GroupingType.OTO, [entryLeg, slLeg]);

    if(error){
      btn.textContent = 'failed ✗';
      showExecValidationMsg(error || 'order failed - see console');
      console.error('[Lighter] order failed:', error);
    } else {
      btn.textContent = 'placed ✓';
      console.log('[Lighter] order placed:', { tx, hash });
      // auto-log to journal - capture checklist state at the moment of placement
      if(typeof journalAutoEntry === 'function') journalAutoEntry(orderRequest);
    }
  } catch(err){
    btn.textContent = 'failed ✗';
    showExecValidationMsg(err?.message || 'signing/network error - see console');
    console.error('[Lighter] request error:', err);
  } finally {
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2200);
  }
}



// ---- image attachment helpers ----

function previewJournalImage(inputId, previewId, removeId){
  const file = document.getElementById(inputId).files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const prev = document.getElementById(previewId);
    const rem = document.getElementById(removeId);
    prev.src = e.target.result;
    prev.classList.add('visible');
    rem.classList.add('visible');
  };
  reader.readAsDataURL(file);
}

function removeJournalImage(inputId, previewId, removeId){
  document.getElementById(inputId).value = '';
  const prev = document.getElementById(previewId);
  const rem = document.getElementById(removeId);
  prev.src = '';
  prev.classList.remove('visible');
  rem.classList.remove('visible');
}

function openLightbox(src){
  document.getElementById('journalLightboxImg').src = src;
  document.getElementById('journalLightbox').classList.add('open');
}
function closeLightbox(){
  document.getElementById('journalLightbox').classList.remove('open');
}

// reads base64 from a preview img element (already loaded by previewJournalImage)
function getImageBase64(previewId){
  const el = document.getElementById(previewId);
  return (el && el.classList.contains('visible')) ? el.src : null;
}

// ===================== JOURNAL ENGINE =====================
const JOURNAL_KEY = 'ema_watch_journal_v1';

function journalLoad(){
  try{ return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'); }
  catch(e){ return []; }
}
function journalSave(entries){
  try{ localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries)); } catch(e){}
}
function journalGenId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

// Calculates result % for a closed trade.
// For a long: (exit - entry) / entry * 100
// For a short: (entry - exit) / entry * 100
// Returns null when either price is missing or outcome is 'open'.
function journalCalcResultPct(entry){
  if(entry.outcome === 'open' || !entry.entryPrice || !entry.exitPrice) return null;
  const e = parseFloat(entry.entryPrice);
  const x = parseFloat(entry.exitPrice);
  if(!e || isNaN(x)) return null;
  return entry.direction === 'short'
    ? ((e - x) / e) * 100
    : ((x - e) / e) * 100;
}

// Called by submitOrderToLighter on success. Reads the current Trade tab state
// and appends an "open" entry to the journal automatically.
function journalAutoEntry(orderRequest){
  const checks = [1,2,3,4,5,6].map(i => {
    const el = document.getElementById('jf-check-'+i);
    return el ? el.checked : false;
  });
  const liveMatch = cryptoData.find(d => d.symbol === orderRequest.ticker) || stockData.find(d => d.symbol === orderRequest.ticker);
  const livePrice = liveMatch ? liveMatch.price : null;

  const entry = {
    id: journalGenId(),
    ts: Date.now(),
    source: 'auto',
    ticker: orderRequest.ticker,
    direction: orderRequest.direction,
    outcome: 'open',
    notional: orderRequest.sizeUsd,
    entryPrice: livePrice,
    slPrice: orderRequest.slPrice,
    exitPrice: null,
    checklist: checks,
  };

  const entries = journalLoad();
  entries.unshift(entry);
  journalSave(entries);
  journalRender();
  journalShowToast('Trade auto-logged to Journal');
}

function journalShowToast(msg){
  const toast = document.getElementById('journalToast');
  const msgEl = document.getElementById('journalToastMsg');
  if(!toast) return;
  msgEl.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function journalRender(){
  const entries = journalLoad();
  const wrap = document.getElementById('journalLogWrap');
  if(!wrap) return;

  // update stats
  const closed = entries.filter(e => e.outcome !== 'open');
  const wins = closed.filter(e => e.outcome === 'win');
  const wr = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  const results = closed.map(e => journalCalcResultPct(e)).filter(v => v !== null);
  const avgResult = results.length ? results.reduce((a,b)=>a+b,0) / results.length : null;
  const checkAvg = entries.length
    ? entries.reduce((s,e) => s + (e.checklist ? e.checklist.filter(Boolean).length : 0), 0) / entries.length
    : null;

  document.getElementById('jstat-total').textContent = entries.length;
  document.getElementById('jstat-wr').textContent = wr !== null ? wr + '%' : '—';
  document.getElementById('jstat-avg').textContent = avgResult !== null
    ? (avgResult >= 0 ? '+' : '') + avgResult.toFixed(1) + '%' : '—';
  document.getElementById('jstat-avg').className = 'jstat-value' + (avgResult > 0 ? ' win' : avgResult < 0 ? ' loss' : '');
  document.getElementById('jstat-checks').textContent = checkAvg !== null ? checkAvg.toFixed(1) : '—';

  if(!entries.length){
    wrap.innerHTML = '<div class="journal-empty"><i class="ti ti-notebook"></i>No trades logged yet. Place an order or log one manually above.</div>';
    return;
  }

  const rows = entries.map(e => {
    const checkCount = e.checklist ? e.checklist.filter(Boolean).length : 0;
    const pct = journalCalcResultPct(e);
    const pctStr = pct !== null
      ? `<span class="jt-pct ${pct>=0?'pos':'neg'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span>`
      : `<span class="jt-pct open">—</span>`;
    const dateStr = new Date(e.ts).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});
    const dirBadge = e.direction === 'long'
      ? `<span class="jt-dir-long">LONG</span>`
      : `<span class="jt-dir-short">SHORT</span>`;
    const outcomeBadge = `<span class="jt-outcome ${e.outcome}">${e.outcome.toUpperCase()}</span>`;
    const scoreClass = checkCount === 6 ? 'full' : '';
    const autoBadge = e.source === 'auto' ? `<span style="font-size:8px;color:var(--teal);margin-left:5px;">auto</span>` : '';

    const thumbCell = e.image
      ? `<td><img class="jt-thumb" src="${e.image}" alt="chart" onclick="openLightbox('${e.image.replace(/'/g,"\\'")}')"></td>`
      : `<td style="color:var(--text-faint);font-size:10px;">—</td>`;

    return `<tr>
      <td style="color:var(--text-faint);font-size:10px;">${dateStr}</td>
      <td style="font-weight:700;">${e.ticker}${autoBadge}</td>
      <td>${dirBadge}</td>
      <td>${outcomeBadge}</td>
      <td class="jt-score ${scoreClass}">${checkCount}/6</td>
      <td style="color:var(--text-dim);font-size:11px;">${e.notional ? '$'+Number(e.notional).toLocaleString() : '—'}</td>
      <td style="color:var(--text-dim);font-size:11px;">${e.entryPrice ? Number(e.entryPrice).toLocaleString() : '—'}</td>
      <td style="color:var(--text-dim);font-size:11px;">${e.slPrice ? Number(e.slPrice).toLocaleString() : '—'}</td>
      <td>${pctStr}</td>
      ${thumbCell}
      <td>
        <button class="jt-action-btn" onclick="openJournalEdit('${e.id}')" title="Edit"><i class="ti ti-pencil"></i></button>
        <button class="jt-action-btn del" onclick="deleteJournalEntry('${e.id}')" title="Delete"><i class="ti ti-trash"></i></button>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="journal-table">
    <thead><tr>
      <th>DATE</th><th>TICKER</th><th>DIR</th><th>OUTCOME</th>
      <th>CHECKS</th><th>NOTIONAL</th><th>ENTRY</th><th>SL</th><th>RESULT</th><th>CHART</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function toggleJournalForm(){
  const body = document.getElementById('journalFormBody');
  const header = document.getElementById('journalFormHeader');
  const btn = document.getElementById('journalFormToggleBtn');
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  header.classList.toggle('open', !isOpen);
  btn.textContent = isOpen ? 'open' : 'close';
  if(!isOpen){
    // pre-fill date to now
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const el = document.getElementById('jman-date');
    if(el) el.value = now.toISOString().slice(0,16);
  }
}

function submitManualJournalEntry(){
  const ticker = document.getElementById('jman-ticker').value.trim().toUpperCase();
  if(!ticker){ alert('Ticker is required.'); return; }
  const checks = [1,2,3,4,5,6].map(i => document.getElementById('jman-c'+i).checked);
  const entry = {
    id: journalGenId(),
    ts: (() => { const d = document.getElementById('jman-date').value; return d ? new Date(d).getTime() : Date.now(); })(),
    source: 'manual',
    ticker,
    direction: document.getElementById('jman-direction').value,
    outcome: document.getElementById('jman-outcome').value,
    notional: parseFloat(document.getElementById('jman-notional').value) || null,
    entryPrice: parseFloat(document.getElementById('jman-entry').value) || null,
    slPrice: parseFloat(document.getElementById('jman-sl').value) || null,
    exitPrice: parseFloat(document.getElementById('jman-exit').value) || null,
    checklist: checks,
    image: getImageBase64('jman-preview'),
  };
  const entries = journalLoad();
  entries.unshift(entry);
  journalSave(entries);
  // reset form
  ['jman-ticker','jman-notional','jman-entry','jman-sl','jman-exit'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  [1,2,3,4,5,6].forEach(i => { const el = document.getElementById('jman-c'+i); if(el) el.checked = false; });
  document.getElementById('jman-outcome').value = 'open';
  removeJournalImage('jman-image','jman-preview','jman-remove');
  toggleJournalForm();
  journalRender();
  journalShowToast('Trade logged');
}

function deleteJournalEntry(id){
  if(!confirm('Delete this trade from the journal?')) return;
  const entries = journalLoad().filter(e => e.id !== id);
  journalSave(entries);
  journalRender();
}

function openJournalEdit(id){
  const entries = journalLoad();
  const e = entries.find(x => x.id === id);
  if(!e) return;
  document.getElementById('jedit-id').value = id;
  document.getElementById('jedit-ticker').value = e.ticker || '';
  document.getElementById('jedit-direction').value = e.direction || 'long';
  document.getElementById('jedit-outcome').value = e.outcome || 'open';
  document.getElementById('jedit-notional').value = e.notional || '';
  document.getElementById('jedit-entry').value = e.entryPrice || '';
  document.getElementById('jedit-sl').value = e.slPrice || '';
  document.getElementById('jedit-exit').value = e.exitPrice || '';
  [1,2,3,4,5,6].forEach(i => {
    const el = document.getElementById('jedit-c'+i);
    if(el) el.checked = e.checklist ? e.checklist[i-1] : false;
  });
  // load existing image into preview
  const editPrev = document.getElementById('jedit-preview');
  const editRem = document.getElementById('jedit-remove');
  if(e.image){
    editPrev.src = e.image;
    editPrev.classList.add('visible');
    editRem.classList.add('visible');
  } else {
    editPrev.src = '';
    editPrev.classList.remove('visible');
    editRem.classList.remove('visible');
  }
  document.getElementById('journalEditOverlay').classList.add('open');
}

function closeJournalEdit(){
  document.getElementById('journalEditOverlay').classList.remove('open');
}

function saveJournalEdit(){
  const id = document.getElementById('jedit-id').value;
  const entries = journalLoad();
  const idx = entries.findIndex(e => e.id === id);
  if(idx === -1) return;
  const checks = [1,2,3,4,5,6].map(i => document.getElementById('jedit-c'+i).checked);
  entries[idx] = {
    ...entries[idx],
    ticker: document.getElementById('jedit-ticker').value.trim().toUpperCase(),
    direction: document.getElementById('jedit-direction').value,
    outcome: document.getElementById('jedit-outcome').value,
    notional: parseFloat(document.getElementById('jedit-notional').value) || null,
    entryPrice: parseFloat(document.getElementById('jedit-entry').value) || null,
    slPrice: parseFloat(document.getElementById('jedit-sl').value) || null,
    exitPrice: parseFloat(document.getElementById('jedit-exit').value) || null,
    checklist: checks,
    image: getImageBase64('jedit-preview') || entries[idx].image || null,
  };
  journalSave(entries);
  closeJournalEdit();
  journalRender();
}

function exportJournalCSV(){
  const entries = journalLoad();
  if(!entries.length){ alert('No trades to export.'); return; }
  const headers = ['Date','Ticker','Direction','Outcome','Checks','Notional','Entry','SL','Exit','Result%'];
  const rows = entries.map(e => {
    const pct = journalCalcResultPct(e);
    return [
      new Date(e.ts).toISOString().slice(0,10),
      e.ticker, e.direction, e.outcome,
      e.checklist ? e.checklist.filter(Boolean).length : 0,
      e.notional || '', e.entryPrice || '', e.slPrice || '', e.exitPrice || '',
      pct !== null ? pct.toFixed(2) : ''
    ].join(',');
  });
  const blob = new Blob([[headers.join(','), ...rows].join('\n')], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'journal_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}

function exportJournalJSON(){
  const entries = journalLoad();
  if(!entries.length){ alert('No trades to export.'); return; }
  const blob = new Blob([JSON.stringify(entries, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'journal_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
}

function shareJournalToX(){
  const entries = journalLoad();
  const closed = entries.filter(e => e.outcome !== 'open');
  const wins = closed.filter(e => e.outcome === 'win');
  const wr = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  const results = closed.map(e => journalCalcResultPct(e)).filter(v=>v!==null);
  const avg = results.length ? (results.reduce((a,b)=>a+b,0)/results.length).toFixed(1) : null;
  const last5 = entries.slice(0,5).map(e => {
    const pct = journalCalcResultPct(e);
    const sign = e.outcome==='open' ? '⏳' : e.outcome==='win' ? '✅' : '❌';
    return `${sign} ${e.ticker} ${e.direction==='long'?'↑':'↓'}${pct!==null?(pct>=0?' +':' ')+pct.toFixed(1)+'%':''}`;
  });
  const text = [
    `📒 Journal update — ${entries.length} trades logged`,
    wr !== null ? `Win rate: ${wr}% · Avg: ${avg!==null?(avg>0?'+':'')+avg+'%':'—'}` : '',
    '',
    last5.join('\n'),
    '',
    '#BTC #crypto'
  ].filter(l=>l!==undefined).join('\n');
  window.open('https://x.com/intent/post?text='+encodeURIComponent(text), '_blank');
}

// render journal when switching to that tab
const _origSwitchTab = window.switchTab;
// patch switchTab to trigger journal render
(function(){
  const orig = window.switchTab;
  if(typeof orig === 'function'){
    window.switchTab = function(tab, opts){
      orig(tab, opts);
      if(tab === 'journal') journalRender();
    };
  }
})();

// render on page load in case journal is the landing tab
journalRender();

// ===================== END JOURNAL ENGINE =====================
// wire ticker autocomplete and direction tag on page load
const _tickerInput = document.getElementById('jf-ticker');
if(_tickerInput) _tickerInput.addEventListener('input', autofillJournalChecksFromTicker);
syncExecDirectionTag();
setExecOrderType('market');

// populates the ticker datalist keeping the pinned four (BTC/ETH/HYPE/LIGHTER)
// at the top, appending everything else from the live watchlist below them
function populateJournalTickerList(){
  const list = document.getElementById('jf-ticker-list');
  if(!list) return;
  const pinned = new Set(['BTC','ETH','HYPE','LIGHTER']);
  const all = [...cryptoData, ...stockData];
  [...list.querySelectorAll('option[data-dynamic]')].forEach(o => o.remove());
  all.filter(d => !pinned.has(d.symbol)).forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.symbol;
    opt.dataset.dynamic = '1';
    list.appendChild(opt);
  });
}

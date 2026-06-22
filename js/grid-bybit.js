// ===================== BYBIT GRID BOT =====================
const BB_STORAGE_KEY='ema_watch_bb_grid_v1',BB_REST_BASE='https://api.bybit.com',BB_WS_PUBLIC='wss://stream.bybit.com/v5/public/linear',BB_WS_PRIVATE='wss://stream.bybit.com/v5/private',BB_SYMBOL='BTCUSDT',BB_CATEGORY='linear';
let bbState=null,bbPriceWs=null,bbPrivateWs=null,bbCurrentPrice=null,bbUptimeInterval=null,bbVizRaf=null,bbVizDirty=false;

// ── BOT CONSOLE ──────────────────────────────────────────────────────────────
function bbConsoleLog(msg, type){
  const el=document.getElementById('bb-console');
  if(!el)return;
  const ts=new Date().toLocaleTimeString('en-GB',{hour12:false});
  const color=type==='error'?'#e2645f':type==='warn'?'#d9a93f':'#9aa0a6';
  const line=document.createElement('div');
  line.style.color=color;
  line.textContent=ts+'  '+msg;
  el.appendChild(line);
  el.scrollTop=el.scrollHeight;
  // cap at 300 lines
  while(el.children.length>300)el.removeChild(el.firstChild);
}
function bbConsoleClear(){const el=document.getElementById('bb-console');if(el)el.innerHTML='';}
// Intercept console methods scoped to BBGrid logs
(function(){
  const _log=console.log.bind(console);
  const _warn=console.warn.bind(console);
  const _error=console.error.bind(console);
  console.log=function(){
    _log.apply(console,arguments);
    const msg=Array.from(arguments).join(' ');
    if(msg.includes('[BBGrid]'))bbConsoleLog(msg,'log');
  };
  console.warn=function(){
    _warn.apply(console,arguments);
    const msg=Array.from(arguments).join(' ');
    if(msg.includes('[BBGrid]'))bbConsoleLog(msg,'warn');
  };
  console.error=function(){
    _error.apply(console,arguments);
    const msg=Array.from(arguments).join(' ');
    if(msg.includes('[BBGrid]'))bbConsoleLog(msg,'error');
  };
})();

function bbGetKey(){return localStorage.getItem('bybit_api_key')||'';}
function bbGetSecret(){return localStorage.getItem('bybit_api_secret')||'';}
function saveSettingsBybit(){const k=document.getElementById('settings-bybit-key').value.trim(),s=document.getElementById('settings-bybit-secret').value.trim(),st=document.getElementById('settings-bybit-status');if(!k||!s){st.textContent='both fields required';return;}localStorage.setItem('bybit_api_key',k);localStorage.setItem('bybit_api_secret',s);st.textContent='saved ✓';setTimeout(()=>{st.textContent='';},2500);}
async function testSettingsBybit(){const st=document.getElementById('settings-bybit-status');st.textContent='testing…';try{const r=await bbSignedGet('/v5/account/wallet-balance',{accountType:'UNIFIED'});if(r.retCode===0){const coins=r.result?.list?.[0]?.coin||[];const usdt=coins.find(c=>c.coin==='USDT');st.textContent=usdt?`✓ connected — USDT: $${parseFloat(usdt.walletBalance).toFixed(2)}`:'✓ connected';}else{st.textContent='✗ '+(r.retMsg||'error');}}catch(e){st.textContent='✗ '+e.message;}}
(function loadSettingsBybit(){const k=localStorage.getItem('bybit_api_key'),s=localStorage.getItem('bybit_api_secret'),kEl=document.getElementById('settings-bybit-key'),sEl=document.getElementById('settings-bybit-secret');if(k&&kEl)kEl.value=k;if(s&&sEl)sEl.value=s;})();
async function bbHmac(secret,message){const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=await crypto.subtle.sign('HMAC',key,enc.encode(message));return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function bbSignedGet(path,params={}){const key=bbGetKey(),secret=bbGetSecret();if(!key||!secret)throw new Error('Bybit API key/secret not set');const ts=Date.now().toString(),recv='5000',qs=new URLSearchParams(params).toString(),sig=await bbHmac(secret,ts+key+recv+qs);const res=await fetch(`${BB_REST_BASE}${path}?${qs}`,{headers:{'X-BAPI-API-KEY':key,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':recv,'X-BAPI-SIGN':sig}});return res.json();}
async function bbSignedPost(path,body={}){const key=bbGetKey(),secret=bbGetSecret();if(!key||!secret)throw new Error('Bybit API key/secret not set');const ts=Date.now().toString(),recv='5000',bodyStr=JSON.stringify(body),sig=await bbHmac(secret,ts+key+recv+bodyStr);const res=await fetch(`${BB_REST_BASE}${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-BAPI-API-KEY':key,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':recv,'X-BAPI-SIGN':sig},body:bodyStr});return res.json();}
function bbSave(){try{localStorage.setItem(BB_STORAGE_KEY,JSON.stringify(bbState));}catch(e){}}
function bbLoad(){try{const r=localStorage.getItem(BB_STORAGE_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function bbToast(msg,ms=3500){const el=document.getElementById('bbToast');if(!el)return;el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),ms);}
function bbSetBadge(s){const el=document.getElementById('bb-status-badge');if(!el)return;el.className='grid-status-badge '+(s!=='idle'?s:'');el.textContent=s.toUpperCase();}
function bbSetLiveDot(s){const el=document.getElementById('bb-live-dot');if(!el)return;el.className='grid-live-dot '+s;}
function bbShowControls(running,paused){document.getElementById('bb-start-btn').style.display=running?'none':'flex';document.getElementById('bb-pause-btn').style.display=running?'flex':'none';document.getElementById('bb-stop-btn').style.display=running?'flex':'none';const pb=document.getElementById('bb-pause-btn');if(pb)pb.innerHTML=paused?'<i class="ti ti-player-play"></i> Resume':'<i class="ti ti-player-pause"></i> Pause';}
function bbUpdateStat(id,val,cls){const el=document.getElementById(id);if(!el)return;el.textContent=val;el.className='grid-stat-val'+(cls?' '+cls:'');}
function bbCheckCapital(){const lower=parseFloat(document.getElementById('bb-lower').value),upper=parseFloat(document.getElementById('bb-upper').value),levels=parseInt(document.getElementById('bb-levels').value),notional=parseFloat(document.getElementById('bb-notional').value),leverage=parseFloat(document.getElementById('bb-leverage').value)||10,el=document.getElementById('bb-capital-check'),imr=1/leverage,imrEl=document.getElementById('bb-imr-display');if(imrEl)imrEl.textContent=(imr*100).toFixed(1)+'%';if(!el)return true;if(isNaN(lower)||isNaN(upper)||isNaN(levels)||isNaN(notional)||levels<2){el.style.display='none';return false;}if(upper<=lower){el.style.display='block';el.className='grid-capital-check warn';el.textContent='Upper bound must be above lower bound.';return false;}const totalNotional=levels*notional,required=totalNotional*imr*1.05;el.style.display='block';el.className='grid-capital-check ok';el.innerHTML=`Required margin: <strong>~$${required.toLocaleString('en-US',{maximumFractionDigits:2})}</strong> ($${totalNotional.toLocaleString()} notional x ${(imr*100).toFixed(1)}% IMR + 5% buffer)`;

  // Static max loss: worst case if ALL levels fill and price hits SL boundary
  // Lower SL at lower*0.995 — all buy levels would be losing
  // Upper SL at upper*1.005 — all sell levels would be losing
  // Worst case = all levels on the wrong side of the move
  const slLow = lower * 0.995;
  const slHigh = upper * 1.005;
  const step = (upper - lower) / (levels - 1);
  let worstLoss = 0;
  for(let i = 0; i < levels; i++){
    const lp = lower + i * step;
    const isBuy = true; // assume all buy levels fill (downside scenario)
    const btcQty = notional / lp;
    worstLoss += (slLow - lp) * btcQty; // negative number
  }
  // also check upside scenario (all sells fill, price hits upper SL)
  let worstLossUp = 0;
  for(let i = 0; i < levels; i++){
    const lp = lower + i * step;
    const btcQty = notional / lp;
    worstLossUp += (lp - slHigh) * btcQty; // negative number
  }
  const worstCase = Math.min(worstLoss, worstLossUp);
  const mlEl = document.getElementById('bb-max-loss-static');
  if(mlEl){
    mlEl.style.display = 'block';
    mlEl.innerHTML = `Worst-case loss at SL: <strong>~$${Math.abs(worstCase).toFixed(2)}</strong> <span style="opacity:0.7">(all levels fill, price hits bound ±0.5%)</span>`;
  }
  return true;}
['bb-lower','bb-upper','bb-levels','bb-notional','bb-leverage'].forEach(id=>{const el=document.getElementById(id);if(el)el.addEventListener('input',()=>{if(id==='bb-leverage'){const d=document.getElementById('bb-leverage-display');if(d)d.textContent=el.value+'x';}bbCheckCapital();});});
async function bbSetLeverage(leverage){try{const r=await bbSignedPost('/v5/position/set-leverage',{category:BB_CATEGORY,symbol:BB_SYMBOL,buyLeverage:String(leverage),sellLeverage:String(leverage)});if(r.retCode!==0&&r.retCode!==110043)console.warn('[BBGrid] leverage error',r.retMsg);else console.log('[BBGrid] leverage set',leverage);}catch(e){console.warn('[BBGrid] leverage failed',e.message);}}
async function bbPlaceOrder(price,isBuy,notional,clientOrderId){try{const qty=(notional/price).toFixed(3),body={category:BB_CATEGORY,symbol:BB_SYMBOL,side:isBuy?'Buy':'Sell',orderType:'Limit',qty,price:price.toFixed(2),timeInForce:'GTC',positionIdx:0,reduceOnly:false,closeOnTrigger:false,orderLinkId:clientOrderId};console.log('[BBGrid] placing',body);const r=await bbSignedPost('/v5/order/create',body);if(r.retCode!==0){console.error('[BBGrid] order error',r.retMsg);return null;}console.log('[BBGrid] order placed',r.result?.orderId);return r.result?.orderId||null;}catch(e){console.error('[BBGrid] order exception',e.message);return null;}}
async function bbCancelOrder(orderId){try{const r=await bbSignedPost('/v5/order/cancel',{category:BB_CATEGORY,symbol:BB_SYMBOL,orderId});if(r.retCode!==0)console.warn('[BBGrid] cancel error',r.retMsg,orderId);return r.retCode===0;}catch(e){console.warn('[BBGrid] cancel exception',e.message);return false;}}
async function bbCancelAllOrders(){
  try{
    // Cancel all open orders on BTCUSDT in one call — catches everything including next-orders
    const r=await bbSignedPost('/v5/order/cancel-all',{category:BB_CATEGORY,symbol:BB_SYMBOL});
    console.log('[BBGrid] cancel-all result',r.retCode,r.retMsg);
    // Also explicitly cancel SL stop orders (separate orderFilter)
    const rSL=await bbSignedPost('/v5/order/cancel-all',{category:BB_CATEGORY,symbol:BB_SYMBOL,orderFilter:'StopOrder'});
    console.log('[BBGrid] cancel-all StopOrders',rSL.retCode,rSL.retMsg);
  }catch(e){console.warn('[BBGrid] cancelAll error',e.message);}
}
async function bbPlaceBoundSLs(){try{const{lower,upper,nLevels,notional}=bbState,midPrice=(lower+upper)/2,totalQty=((nLevels*notional)/midPrice).toFixed(3),slLow=(lower*0.995).toFixed(2),slHigh=(upper*1.005).toFixed(2);const rLow=await bbSignedPost('/v5/order/create',{category:BB_CATEGORY,symbol:BB_SYMBOL,side:'Sell',orderType:'Market',qty:totalQty,reduceOnly:true,positionIdx:0,triggerPrice:slLow,triggerDirection:2,orderFilter:'StopOrder',orderLinkId:'bbgrid_sl_lower_'+Date.now()});if(rLow.retCode===0){bbState.slLowerOrderId=rLow.result?.orderId;console.log('[BBGrid] lower SL placed',bbState.slLowerOrderId);}else console.warn('[BBGrid] lower SL error',rLow.retMsg);const rHigh=await bbSignedPost('/v5/order/create',{category:BB_CATEGORY,symbol:BB_SYMBOL,side:'Buy',orderType:'Market',qty:totalQty,reduceOnly:true,positionIdx:0,triggerPrice:slHigh,triggerDirection:1,orderFilter:'StopOrder',orderLinkId:'bbgrid_sl_upper_'+Date.now()});if(rHigh.retCode===0){bbState.slUpperOrderId=rHigh.result?.orderId;console.log('[BBGrid] upper SL placed',bbState.slUpperOrderId);}else console.warn('[BBGrid] upper SL error',rHigh.retMsg);bbSave();}catch(e){console.warn('[BBGrid] placeBoundSLs error',e.message);}}
async function bbMarketClose(){
  try{
    // Fetch actual position to get real size
    const pos=await bbSignedGet('/v5/position/list',{category:BB_CATEGORY,symbol:BB_SYMBOL});
    const positions=(pos.result?.list||[]).filter(p=>parseFloat(p.size)>0);
    if(!positions.length){console.log('[BBGrid] no open position to close');return;}
    for(const p of positions){
      const side=p.side==='Buy'?'Sell':'Buy'; // close opposite
      const r=await bbSignedPost('/v5/order/create',{
        category:BB_CATEGORY,symbol:BB_SYMBOL,
        side,orderType:'Market',qty:p.size,
        reduceOnly:true,positionIdx:0,
        orderLinkId:'bbgrid_close_'+Date.now()
      });
      console.log('[BBGrid] market close',side,p.size,r.retCode===0?'ok':r.retMsg);
    }
  }catch(e){console.warn('[BBGrid] market close failed',e.message);}
}
async function bbHandleFill(ex){
  if(!bbState||!bbState.running||bbState.paused)return;
  const clientOrderId=ex.orderLinkId||'';
  const fillPrice=parseFloat(ex.execPrice);
  const fillQty=parseFloat(ex.execQty);
  const fee=parseFloat(ex.execFee||0);
  const isBuy=ex.side==='Buy';
  console.log('[BBGrid] fill — orderLinkId:',clientOrderId,'price:',fillPrice,'side:',ex.side,'qty:',fillQty,'fee:',fee);

  // Init net position tracker if missing
  if(!bbState.netPos) bbState.netPos={qty:0,side:null,totalCost:0,totalFees:0,counterOrderId:null,counterClientId:null};
  const np=bbState.netPos;

  // ── HELPER: complete a cycle and restart the grid ─────────────────────────
  async function bbCompleteCycle(closeFee){
    const avgEntry=np.totalCost/np.qty;
    const grossPnl=np.side==='Buy'?(fillPrice-avgEntry)*np.qty:(avgEntry-fillPrice)*np.qty;
    const netPnl=grossPnl-closeFee-np.totalFees;
    bbState.pnl=(bbState.pnl||0)+netPnl;
    bbState.fillCount=(bbState.fillCount||0)+1;
    console.log('[BBGrid] cycle complete — round trip PnL:',netPnl.toFixed(4),'cumul:',bbState.pnl.toFixed(4));
    bbLifetimeAddTrade(netPnl);
    bbUpdateStat('bbstat-fills',bbState.fillCount);
    const pnl=bbState.pnl||0;
    bbUpdateStat('bbstat-pnl',(pnl>=0?'+':'')+'$'+pnl.toFixed(2),pnl>=0?'up':'down');
    // Clear net position
    bbState.netPos={qty:0,side:null,totalCost:0,totalFees:0,counterOrderId:null,counterClientId:null};
    bbState.levels.forEach(lv=>{if(lv.status==='filled'||lv.status==='waiting')lv.status='open';});
    bbSave();bbRenderLevelTable();bbVizDirty=true;
    // Wait 10s then redeploy
    console.log('[BBGrid] waiting 10s before redeploying grid...');
    bbUpdateStat('bbstat-state','Cycle reset — waiting 10s...');
    await new Promise(r=>setTimeout(r,10000));
    if(!bbState||!bbState.running)return;
    let currentPrice=bbCurrentPrice;
    try{
      const ticker=await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${BB_SYMBOL}`);
      const td=await ticker.json();
      const tp=parseFloat(td?.result?.list?.[0]?.lastPrice||0);
      if(tp>1000)currentPrice=tp;
    }catch(e){console.warn('[BBGrid] price fetch failed, using WS price');}
    console.log('[BBGrid] redeploying grid at price',currentPrice);
    bbUpdateStat('bbstat-state','Redeploying grid...');
    const THRESHOLD=50;
    let placed=0;
    for(let i=0;i<bbState.levels.length;i++){
      const lv=bbState.levels[i];
      const diff=currentPrice-lv.price;
      if(Math.abs(diff)<THRESHOLD){
        lv.status='skip';
        console.log('[BBGrid] skipping level',i,'at',lv.price,'within $'+THRESHOLD+' of price');
        continue;
      }
      const shouldBeBuy=diff>0;
      const clientId=`bbgrid_${shouldBeBuy?'b':'s'}_${i}_${Date.now()}`;
      lv.isBuy=shouldBeBuy;lv.clientOrderId=clientId;lv.status='pending';
      const orderId=await bbPlaceOrder(lv.price,shouldBeBuy,bbState.notional,clientId);
      if(orderId){lv.orderId=orderId;lv.status='open';placed++;}
      else lv.status='error';
      bbState.levels[i]=lv;
      bbRenderLevelTable();bbVizDirty=true;
      await new Promise(r=>setTimeout(r,120));
    }
    bbSave();
    bbUpdateStat('bbstat-orders',placed);
    bbUpdateStat('bbstat-state','Running');
    console.log('[BBGrid] grid redeployed —',placed,'orders placed');
  }

  // ── COUNTER ORDER FILL (matched by clientId) ──────────────────────────────
  if(clientOrderId===np.counterClientId){
    console.log('[BBGrid] counter fill (matched) — closing position. qty:',fillQty,'price:',fillPrice);
    await bbCompleteCycle(fee);
    return;
  }

  // ── GRID LEVEL FILL ───────────────────────────────────────────────────────
  const li=bbState.levels.findIndex(lv=>lv.clientOrderId===clientOrderId);
  if(li===-1){
    // Unmatched fill — check if it closes our net position (e.g. a grid sell fills while we are long)
    if(np.qty>0&&np.side){
      const closesPosition=(np.side==='Buy'&&!isBuy)||(np.side==='Sell'&&isBuy);
      if(closesPosition){
        console.log('[BBGrid] unmatched fill closes net position — treating as cycle complete');
        await bbCompleteCycle(fee);
        return;
      }
    }
    console.log('[BBGrid] fill unmatched — ignoring',clientOrderId);
    return;
  }

  const level=bbState.levels[li];

  // If this grid fill is in the OPPOSITE direction to our net position, it closes us out
  if(np.qty>0&&np.side){
    const closesPosition=(np.side==='Buy'&&!isBuy)||(np.side==='Sell'&&isBuy);
    if(closesPosition){
      console.log('[BBGrid] grid level fill closes net position — treating as cycle complete');
      // Cancel the pending counter order if any before completing
      if(np.counterOrderId){await bbCancelOrder(np.counterOrderId);np.counterOrderId=null;np.counterClientId=null;}
      level.status='open';level.fillPrice=fillPrice;
      bbRenderLevelTable();bbVizDirty=true;
      await bbCompleteCycle(fee);
      return;
    }
  }

  // Opening leg — accumulate net position
  level.status='filled';
  level.fillPrice=fillPrice;
  level.isBuy=isBuy;
  bbRenderLevelTable();bbVizDirty=true;

  np.side=isBuy?'Buy':'Sell';
  np.qty+=fillQty;
  np.totalCost+=fillPrice*fillQty;
  np.totalFees+=fee;
  const avgEntry=np.qty>0?np.totalCost/np.qty:0;
  console.log('[BBGrid] net position — side:',np.side,'qty:',np.qty.toFixed(3),'avg entry:',avgEntry.toFixed(2));

  // Cancel existing counter if any, place fresh one for full net qty
  if(np.counterOrderId){
    console.log('[BBGrid] cancelling previous counter order',np.counterOrderId);
    await bbCancelOrder(np.counterOrderId);
    np.counterOrderId=null;np.counterClientId=null;
  }

  // Counter price: one level beyond the outermost filled level
  const filledIdxs=bbState.levels.map((lv,i)=>lv.status==='filled'?i:-1).filter(i=>i>=0);
  let counterPrice;
  if(np.side==='Buy'){
    const counterIdx=Math.min(Math.max(...filledIdxs)+1,bbState.levels.length-1);
    counterPrice=bbState.levels[counterIdx].price;
  } else {
    const counterIdx=Math.max(Math.min(...filledIdxs)-1,0);
    counterPrice=bbState.levels[counterIdx].price;
  }

  // Add a small delay so Bybit position is updated before placing reduceOnly
  await new Promise(r=>setTimeout(r,500));

  const counterQty=np.qty.toFixed(3);
  const counterClientId=`bbgrid_counter_${Date.now()}`;
  np.counterClientId=counterClientId;
  const counterSide=np.side==='Buy'?'Sell':'Buy';
  const counterBody={category:BB_CATEGORY,symbol:BB_SYMBOL,side:counterSide,orderType:'Limit',qty:counterQty,price:counterPrice.toFixed(2),timeInForce:'GTC',positionIdx:0,reduceOnly:false,closeOnTrigger:false,orderLinkId:counterClientId};
  console.log('[BBGrid] placing counter order — side:',counterSide,'qty:',counterQty,'price:',counterPrice);
  try{
    const r=await bbSignedPost('/v5/order/create',counterBody);
    if(r.retCode!==0){console.error('[BBGrid] counter order error',r.retMsg);np.counterClientId=null;}
    else{np.counterOrderId=r.result?.orderId||null;console.log('[BBGrid] counter order placed',np.counterOrderId);}
  }catch(e){console.error('[BBGrid] counter order exception',e.message);np.counterClientId=null;}
  bbSave();bbUpdateStat('bbstat-orders',bbState.levels.filter(l=>l.status==='open').length);
}
function bbStartPriceWs(){if(bbPriceWs&&bbPriceWs.readyState<2)return;bbPriceWs=new WebSocket(BB_WS_PUBLIC);bbPriceWs.onopen=()=>{bbPriceWs.send(JSON.stringify({op:'subscribe',args:['tickers.BTCUSDT']}));};bbPriceWs.onmessage=(ev)=>{try{const msg=JSON.parse(ev.data),d=msg.data;if(!d)return;const p=parseFloat(d.lastPrice||d.markPrice||0);if(p>1000){bbCurrentPrice=p;bbUpdateStat('bbstat-price','$'+p.toLocaleString('en-US',{maximumFractionDigits:1}));bbVizDirty=true;bbCalcOpenPnl();if(bbState&&bbState.running&&!bbState.paused){const slLow=bbState.lower*0.995,slHigh=bbState.upper*1.005;if(p<=slLow||p>=slHigh){console.warn('[BBGrid] SL triggered',p);bbToast('Stop-loss triggered',5000);bbBotStop(true);}}}}catch(e){};};bbPriceWs.onclose=()=>setTimeout(bbStartPriceWs,3000);bbPriceWs.onerror=()=>bbSetLiveDot('error');}
function bbStopPriceWs(){if(bbPriceWs){try{bbPriceWs.close();}catch(e){}bbPriceWs=null;}}
async function bbStartPrivateWs(){if(bbPrivateWs&&bbPrivateWs.readyState<2)return;const key=bbGetKey(),secret=bbGetSecret();if(!key||!secret)return;bbPrivateWs=new WebSocket(BB_WS_PRIVATE);bbPrivateWs.onopen=async()=>{const expires=Date.now()+10000,sig=await bbHmac(secret,'GET/realtime'+expires);bbPrivateWs.send(JSON.stringify({op:'auth',args:[key,expires,sig]}));};bbPrivateWs.onmessage=async(ev)=>{try{const msg=JSON.parse(ev.data);if(msg.op==='auth'&&msg.success){console.log('[BBGrid] private WS authenticated');bbPrivateWs.send(JSON.stringify({op:'subscribe',args:['execution']}));}if(msg.topic==='execution'&&msg.data){const execs=Array.isArray(msg.data)?msg.data:[msg.data];for(const ex of execs){console.log('[BBGrid] execution raw:',JSON.stringify(ex).slice(0,300));if(ex.symbol===BB_SYMBOL&&ex.execType==='Trade')await bbHandleFill(ex);}}}catch(e){console.warn('[BBGrid] private WS error',e);};};bbPrivateWs.onclose=()=>{if(bbState&&bbState.running)setTimeout(bbStartPrivateWs,3000);};bbPrivateWs.onerror=()=>bbSetLiveDot('error');}
function bbStopPrivateWs(){if(bbPrivateWs){try{bbPrivateWs.close();}catch(e){}bbPrivateWs=null;}}
async function bbBotStart(){const lower=parseFloat(document.getElementById('bb-lower').value),upper=parseFloat(document.getElementById('bb-upper').value),nLevels=parseInt(document.getElementById('bb-levels').value),notional=parseFloat(document.getElementById('bb-notional').value),leverage=parseFloat(document.getElementById('bb-leverage').value)||10;if(isNaN(lower)||isNaN(upper)||isNaN(nLevels)||isNaN(notional)){bbToast('Fill in all fields.');return;}if(upper<=lower){bbToast('Upper must be above lower.');return;}if(nLevels<2){bbToast('Need at least 2 levels.');return;}if(!bbGetKey()||!bbGetSecret()){bbToast('No Bybit API keys — set them in Settings.');return;}bbCheckCapital();const price=bbCurrentPrice||(lower+upper)/2,step=(upper-lower)/(nLevels-1),levels=[];for(let i=0;i<nLevels;i++){const lp=lower+i*step,isBuy=lp<price,clientOrderId=`bbgrid_${Date.now()}_${i}`;levels.push({price:lp,isBuy,notional,status:'pending',clientOrderId});}bbState={lower,upper,nLevels,notional,leverage,levels,running:true,paused:false,startTime:Date.now(),fillCount:0,pnl:0,netPos:{qty:0,side:null,totalCost:0,totalFees:0,counterOrderId:null,counterClientId:null}};bbSave();bbSetBadge('running');bbSetLiveDot('live');bbShowControls(true,false);bbUpdateStat('bbstat-state','Setting leverage...');await bbSetLeverage(leverage);bbUpdateStat('bbstat-state','Placing orders...');bbUpdateStat('bbstat-orders','0');bbStartPriceWs();await bbStartPrivateWs();clearInterval(bbUptimeInterval);bbUptimeInterval=setInterval(bbTickUptime,1000);bbStartVizLoop();document.getElementById('bb-start-btn').disabled=true;let placed=0;for(let i=0;i<levels.length;i++){const lv=levels[i];if(Math.abs(lv.price-price)<step*0.1){lv.status='skip';continue;}const orderId=await bbPlaceOrder(lv.price,lv.isBuy,lv.notional,lv.clientOrderId);if(orderId){lv.status='open';lv.orderId=orderId;placed++;}else lv.status='error';bbState.levels[i]=lv;bbUpdateStat('bbstat-orders',placed);bbRenderLevelTable();bbVizDirty=true;await new Promise(r=>setTimeout(r,120));}bbSave();bbUpdateStat('bbstat-state','Running');document.getElementById('bb-start-btn').disabled=false;await bbPlaceBoundSLs();bbToast(`Grid bot started - ${placed} orders placed across ${nLevels} levels`);}
function bbBotTogglePause(){if(!bbState)return;bbState.paused=!bbState.paused;bbSave();const paused=bbState.paused;bbSetBadge(paused?'paused':'running');bbSetLiveDot(paused?'paused':'live');bbShowControls(true,paused);bbUpdateStat('bbstat-state',paused?'Paused':'Running');bbToast(paused?'Bot paused':'Bot resumed');}
async function bbBotStop(isSL){if(!bbState)return;bbState.running=false;bbState.paused=false;bbSave();bbSetBadge('stopped');bbSetLiveDot('error');bbShowControls(false,false);bbUpdateStat('bbstat-state',isSL?'SL Triggered':'Stopped');clearInterval(bbUptimeInterval);bbStopPriceWs();bbStopPrivateWs();await bbCancelAllOrders();await bbMarketClose();bbRenderLevelTable();bbVizDirty=true;bbToast(isSL?'SL triggered - orders cancelled & position closed.':'Bot stopped. Orders cancelled & position closed.');}
function bbTickUptime(){if(!bbState||!bbState.startTime)return;const secs=Math.floor((Date.now()-bbState.startTime)/1000),h=Math.floor(secs/3600),m=Math.floor((secs%3600)/60),s=secs%60;bbUpdateStat('bbstat-uptime',h>0?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m ${String(s).padStart(2,'0')}s`);bbCalcOpenPnl();}

function bbCalcOpenPnl(){
  if(!bbCurrentPrice||!bbState)return;
  const np=bbState.netPos;
  if(!np||!np.qty||!np.side){bbUpdateStat('bbstat-opnl','$0.00');bbUpdateStat('bbstat-maxloss','--');return;}
  const avgEntry=np.totalCost/np.qty;
  const openPnl=np.side==='Buy'?(bbCurrentPrice-avgEntry)*np.qty:(avgEntry-bbCurrentPrice)*np.qty;
  const slLow=bbState.lower*0.995,slHigh=bbState.upper*1.005;
  const slPrice=np.side==='Buy'?slLow:slHigh;
  const maxLoss=np.side==='Buy'?(slPrice-avgEntry)*np.qty:(avgEntry-slPrice)*np.qty;
  bbUpdateStat('bbstat-opnl',(openPnl>=0?'+':'')+'$'+openPnl.toFixed(2),openPnl>=0?'up':'down');
  if(maxLoss<0){bbUpdateStat('bbstat-maxloss','-$'+Math.abs(maxLoss).toFixed(2),'down');}
  else{bbUpdateStat('bbstat-maxloss','$'+maxLoss.toFixed(2));}
}
function bbRenderLevelTable(){const tbody=document.getElementById('bb-level-tbody');if(!tbody)return;if(!bbState||!bbState.levels||!bbState.levels.length){tbody.innerHTML='<tr><td colspan="6" class="grid-table-empty">No grid active</td></tr>';return;}const rows=[...bbState.levels].reverse().map((lv,ri)=>{const i=bbState.levels.length-1-ri,side=lv.isBuy?'<span class="gl-side-buy">BUY</span>':'<span class="gl-side-sell">SELL</span>',statusMap={pending:'<span class="gl-status-idle">pending</span>',open:'<span class="gl-status-open">open</span>',waiting:'<span class="gl-status-filled">waiting</span>',filled:'<span class="gl-status-filled">filled</span>',error:'<span class="gl-status-sl">error</span>',skip:'<span class="gl-status-idle">-</span>'},fp=lv.fillPrice?'$'+lv.fillPrice.toLocaleString('en-US',{maximumFractionDigits:2}):'--';return `<tr><td>${i+1}</td><td>$${lv.price.toLocaleString('en-US',{maximumFractionDigits:0})}</td><td>${side}</td><td>$${lv.notional.toLocaleString('en-US',{maximumFractionDigits:0})}</td><td>${fp}</td><td>${statusMap[lv.status]||lv.status}</td></tr>`;});tbody.innerHTML=rows.join('');}
function bbStartVizLoop(){if(bbVizRaf)cancelAnimationFrame(bbVizRaf);function loop(){if(bbVizDirty){bbDrawViz();bbVizDirty=false;}bbVizRaf=requestAnimationFrame(loop);}bbVizRaf=requestAnimationFrame(loop);}
function bbDrawViz(){const canvas=document.getElementById('bb-viz-canvas'),empty=document.getElementById('bb-viz-empty');if(!canvas)return;if(!bbState||!bbState.levels||!bbState.levels.length){canvas.style.display='none';if(empty)empty.style.display='flex';return;}canvas.style.display='block';if(empty)empty.style.display='none';const wrap=document.getElementById('bb-viz-wrap'),W=wrap?wrap.clientWidth-28:500,nL=bbState.levels.length,rowH=Math.max(22,Math.min(40,Math.floor(440/nL))),H=nL*rowH+40;canvas.width=W;canvas.height=H;canvas.style.height=H+'px';const ctx=canvas.getContext('2d');ctx.clearRect(0,0,W,H);const lower=bbState.lower,upper=bbState.upper,range=upper-lower||1,padL=90,padR=20,barW=W-padL-padR,pY=p=>20+((upper-p)/range)*(H-40);ctx.fillStyle='rgba(40,215,200,0.04)';ctx.fillRect(padL,pY(upper),barW,pY(lower)-pY(upper));bbState.levels.forEach(lv=>{const y=pY(lv.price),color=lv.status==='filled'?'#d9a93f':lv.status==='open'?(lv.isBuy?'#3ddc97':'#e2645f'):lv.status==='error'?'#e2645f':'#3d3c44';ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=lv.status==='open'?1.2:0.7;ctx.setLineDash(lv.status==='open'?[]:[4,4]);ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='10px Inter,sans-serif';ctx.textAlign='right';ctx.fillText('$'+lv.price.toLocaleString('en-US',{maximumFractionDigits:0}),padL-5,y+3.5);if(lv.status==='open'){ctx.fillStyle=color;ctx.font='bold 9px Inter,sans-serif';ctx.textAlign='left';ctx.fillText(lv.isBuy?'▶':'◀',W-padR+3,y+3.5);}});if(bbCurrentPrice!==null&&bbCurrentPrice>=lower*0.9&&bbCurrentPrice<=upper*1.1){const y=pY(bbCurrentPrice);ctx.beginPath();ctx.strokeStyle='#d9a93f';ctx.lineWidth=2;ctx.setLineDash([6,3]);ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#d9a93f';ctx.font='bold 11px Inter,sans-serif';ctx.textAlign='right';ctx.fillText('$'+bbCurrentPrice.toLocaleString('en-US',{maximumFractionDigits:0}),padL-5,y-4);ctx.beginPath();ctx.arc(padL+4,y,4,0,Math.PI*2);ctx.fillStyle='#d9a93f';ctx.fill();}[lower*0.995,upper*1.005].forEach(sl=>{const y=pY(sl);ctx.beginPath();ctx.strokeStyle='rgba(226,100,95,0.5)';ctx.lineWidth=1;ctx.setLineDash([2,4]);ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(226,100,95,0.7)';ctx.font='9px Inter,sans-serif';ctx.textAlign='right';ctx.fillText('SL',padL-5,y+3);});}
bbStartPriceWs();
(function bbRestoreOnLoad(){const saved=bbLoad();if(!saved)return;bbState=saved;document.getElementById('bb-lower').value=saved.lower||'';document.getElementById('bb-upper').value=saved.upper||'';document.getElementById('bb-levels').value=saved.nLevels||'';document.getElementById('bb-notional').value=saved.notional||'';document.getElementById('bb-leverage').value=saved.leverage||10;const lvD=document.getElementById('bb-leverage-display');if(lvD)lvD.textContent=(saved.leverage||10)+'x';if(saved.running){bbSetBadge(saved.paused?'paused':'running');bbSetLiveDot(saved.paused?'paused':'live');bbShowControls(true,saved.paused);bbUpdateStat('bbstat-fills',saved.fillCount||0);const pnl=saved.pnl||0;bbUpdateStat('bbstat-pnl',(pnl>=0?'+':'')+'$'+pnl.toFixed(2),pnl>=0?'up':'down');bbUpdateStat('bbstat-orders',(saved.levels||[]).filter(l=>l.status==='open').length);bbUpdateStat('bbstat-state',saved.paused?'Paused (restored)':'Running (restored)');bbStartPrivateWs();clearInterval(bbUptimeInterval);bbUptimeInterval=setInterval(bbTickUptime,1000);bbStartVizLoop();}else{bbSetBadge('stopped');bbUpdateStat('bbstat-state','Stopped');const pnl=saved.pnl||0;bbUpdateStat('bbstat-pnl',(pnl>=0?'+':'')+'$'+pnl.toFixed(2),pnl>=0?'up':'down');bbUpdateStat('bbstat-fills',saved.fillCount||0);bbStartVizLoop();}bbRenderLevelTable();bbCheckCapital();})();

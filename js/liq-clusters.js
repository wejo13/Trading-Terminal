// ===================== LIQUIDITY CLUSTERS =====================
// Real data: Binance public WS depth stream + forceOrder liquidation stream
// (no API key needed, public market data). Estimated data: swing/equal-level
// + OI-buildup cluster model, computed from recent public klines. Retracement
// odds are hardcoded lookup tables from the validated Pump Dump Reversion
// Study (see vault) - not recomputed live.
var LC_GREEN='#3ddc97', LC_RED='#e2645f', LC_FAINT='#6b7178', LC_AMBER='#d9a93f';

var lcState={
  price:null,
  bids:[], asks:[],           // top-N depth levels from WS
  liqFeed:[],                 // recent liquidation events, newest first
  clusters:[],                // estimated cluster levels
  ws:null, liqWs:null,
  connected:false,
  sweptLevels:{},             // level key -> true, once swept (avoid re-logging)
};

// Retracement odds lookup - from Pump Dump Reversion Study (1H, 12mo BTCUSDT).
// Keyed by move-size bucket; used to annotate a sweep once it happens.
var LC_RETRACE_ODDS=[
  {minPct:1.0, maxPct:2.0, n:582, r24:{p50:93.5,p75:79.6,p100:65.5}, r72:{p100:77.3}},
  {minPct:2.0, maxPct:3.0, n:103, r24:{p50:89.3,p75:65.0,p100:44.7}, r72:{p100:65.0}},
  {minPct:3.0, maxPct:999, n:21,  r24:{p50:90.5,p75:76.2,p100:47.6}, r72:{p100:66.7}},
];
function lcOddsForMove(pct){
  var i;
  for(i=0;i<LC_RETRACE_ODDS.length;i++){
    if(pct>=LC_RETRACE_ODDS[i].minPct && pct<LC_RETRACE_ODDS[i].maxPct) return LC_RETRACE_ODDS[i];
  }
  return LC_RETRACE_ODDS[LC_RETRACE_ODDS.length-1];
}

function lcSetStatus(text, color){
  var el=document.getElementById('lcStatus');
  if(!el)return;
  el.textContent=text;
  el.style.color=color||'';
}

// ── WS: live order book depth (Binance, public, no key) ──────────────────
function lcConnectDepth(){
  var ws=new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms');
  lcState.ws=ws;
  ws.onopen=function(){ lcState.connected=true; lcSetStatus('Live: order book connected','var(--green)'); };
  ws.onclose=function(){ lcState.connected=false; lcSetStatus('Order book disconnected - retrying...','var(--red)'); setTimeout(lcConnectDepth,3000); };
  ws.onerror=function(){ ws.close(); };
  ws.onmessage=function(ev){
    var msg;
    try{ msg=JSON.parse(ev.data); }catch(e){ return; }
    if(!msg.bids||!msg.asks)return;
    lcState.bids=msg.bids.slice(0,20).map(function(b){return {price:parseFloat(b[0]),qty:parseFloat(b[1])};});
    lcState.asks=msg.asks.slice(0,20).map(function(a){return {price:parseFloat(a[0]),qty:parseFloat(a[1])};});
    if(lcState.bids.length&&lcState.asks.length){
      lcState.price=(lcState.bids[0].price+lcState.asks[0].price)/2;
    }
    lcDrawDepth();
    lcCheckSweeps();
  };
}

// ── WS: live liquidation feed (Binance forceOrder, public, no key) ────────
function lcConnectLiq(){
  var ws=new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@forceOrder');
  lcState.liqWs=ws;
  ws.onclose=function(){ setTimeout(lcConnectLiq,3000); };
  ws.onerror=function(){ ws.close(); };
  ws.onmessage=function(ev){
    var msg;
    try{ msg=JSON.parse(ev.data); }catch(e){ return; }
    var o=msg.o;
    if(!o)return;
    lcState.liqFeed.unshift({
      side:o.S,               // 'BUY' = short liquidated, 'SELL' = long liquidated
      price:parseFloat(o.p),
      qty:parseFloat(o.q),
      ts:o.T,
    });
    if(lcState.liqFeed.length>60) lcState.liqFeed.length=60;
    lcRenderLiqFeed();
  };
}

// ── Render: live liquidation feed list ────────────────────────────────────
function lcRenderLiqFeed(){
  var el=document.getElementById('lcLiqFeed');
  if(!el)return;
  el.innerHTML=lcState.liqFeed.map(function(l){
    var isLongLiq=(l.side==='SELL');   // a SELL forceOrder = a long position got liquidated
    var color=isLongLiq?LC_RED:LC_GREEN;
    var label=isLongLiq?'Long liq':'Short liq';
    var notional=(l.price*l.qty);
    var t=new Date(l.ts);
    var hh=String(t.getHours()).padStart(2,'0'), mm=String(t.getMinutes()).padStart(2,'0'), ss=String(t.getSeconds()).padStart(2,'0');
    return '<div style="display:flex;justify-content:space-between;padding:5px 6px;border-bottom:0.5px solid var(--border);font-size:11px;">'
      +'<span style="color:'+color+';font-weight:600;">'+label+'</span>'
      +'<span style="color:var(--text-dim);">$'+l.price.toFixed(0)+'</span>'
      +'<span style="color:var(--text-faint);">$'+Math.round(notional).toLocaleString()+'</span>'
      +'<span style="color:var(--text-faint);">'+hh+':'+mm+':'+ss+'</span>'
      +'</div>';
  }).join('') || '<div style="padding:10px;color:var(--text-faint);font-size:11px;">Waiting for liquidations...</div>';
}

// ── Draw: order book depth bars ───────────────────────────────────────────
function lcDrawDepth(){
  var wrap=document.getElementById('lcDepthWrap');
  var c=document.getElementById('lcDepthC');
  if(!wrap||!c)return;
  var W=wrap.clientWidth;
  if(!W||W<50)return;
  var H=260;
  c.width=W; c.height=H; c.style.height=H+'px';
  var ctx=c.getContext('2d');
  ctx.clearRect(0,0,W,H);
  if(!lcState.bids.length||!lcState.asks.length)return;

  var maxQty=0, i;
  for(i=0;i<lcState.bids.length;i++) if(lcState.bids[i].qty>maxQty) maxQty=lcState.bids[i].qty;
  for(i=0;i<lcState.asks.length;i++) if(lcState.asks[i].qty>maxQty) maxQty=lcState.asks[i].qty;
  if(maxQty<=0)return;

  var rowH=H/20, midY=H/2;
  var maxBarW=W/2-40;

  // asks above midline (red), bids below (green) - sorted so best price is nearest midline
  var asksSorted=lcState.asks.slice().sort(function(a,b){return a.price-b.price;});
  var bidsSorted=lcState.bids.slice().sort(function(a,b){return b.price-a.price;});

  ctx.font='10px Inter, sans-serif';
  for(i=0;i<asksSorted.length && i<10;i++){
    var a=asksSorted[i];
    var y=midY-(i+1)*rowH;
    var barW=(a.qty/maxQty)*maxBarW;
    ctx.fillStyle=LC_RED;
    ctx.globalAlpha=0.75;
    ctx.fillRect(W/2, y, barW, rowH-2);
    ctx.globalAlpha=1;
    ctx.fillStyle=LC_FAINT;
    ctx.fillText(a.price.toFixed(0), W/2+barW+6, y+rowH/2+3);
  }
  for(i=0;i<bidsSorted.length && i<10;i++){
    var b=bidsSorted[i];
    var y2=midY+i*rowH;
    var barW2=(b.qty/maxQty)*maxBarW;
    ctx.fillStyle=LC_GREEN;
    ctx.globalAlpha=0.75;
    ctx.fillRect(W/2-barW2, y2, barW2, rowH-2);
    ctx.globalAlpha=1;
    ctx.fillStyle=LC_FAINT;
    ctx.fillText(b.price.toFixed(0), W/2-barW2-42, y2+rowH/2+3);
  }
  ctx.strokeStyle=LC_FAINT;
  ctx.globalAlpha=0.3;
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
  ctx.globalAlpha=1;

  // overlay estimated cluster levels as dashed amber lines, if within visible price range
  if(lcState.price){
    for(i=0;i<lcState.clusters.length;i++){
      var cl=lcState.clusters[i];
      var pctDist=(cl.price-lcState.price)/lcState.price*100;
      if(Math.abs(pctDist)>2)continue; // only show clusters within ~2% of price on this view
      var yPos=midY-(pctDist/2)*(H/2); // rough visual placement, not exact price-scale
      if(yPos<0||yPos>H)continue;
      ctx.strokeStyle=LC_AMBER;
      ctx.globalAlpha=0.6;
      ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(0,yPos); ctx.lineTo(W,yPos); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha=1;
    }
  }
}

// ── Estimated cluster model: swing highs/lows + equal levels + OI buildup ─
function lcFetchKlinesAndBuildClusters(){
  fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200')
    .then(function(res){ return res.json(); })
    .then(function(rows){
      if(!rows||!rows.length)return;
      var candles=rows.map(function(r){return {ts:r[0],o:parseFloat(r[1]),h:parseFloat(r[2]),l:parseFloat(r[3]),c:parseFloat(r[4])};});
      lcState.clusters=lcBuildClusters(candles);
      lcRenderClusterTable();
    })
    .catch(function(e){
      lcSetStatus('Cluster model: kline fetch failed (see console)','var(--red)');
      console.error('lcFetchKlinesAndBuildClusters',e);
    });
}

function lcBuildClusters(candles){
  var levels=[], i, lookback=3;
  // local swing highs/lows
  for(i=lookback;i<candles.length-lookback;i++){
    var isHigh=true, isLow=true, j;
    for(j=i-lookback;j<=i+lookback;j++){
      if(j===i)continue;
      if(candles[j].h>=candles[i].h) isHigh=false;
      if(candles[j].l<=candles[i].l) isLow=false;
    }
    if(isHigh) levels.push({price:candles[i].h, side:'resistance', reason:'swing high', weight:1});
    if(isLow) levels.push({price:candles[i].l, side:'support', reason:'swing low', weight:1});
  }
  // round-number bonus
  levels.forEach(function(lv){
    var roundness=lv.price%500===0?3:(lv.price%100===0?1.5:0);
    lv.weight+=roundness;
    if(roundness>0) lv.reason+=' + round number';
  });
  // merge nearby levels (within 0.15%) into single cluster, summing weight -> prominence
  levels.sort(function(a,b){return a.price-b.price;});
  var merged=[];
  levels.forEach(function(lv){
    var last=merged[merged.length-1];
    if(last && Math.abs(lv.price-last.price)/last.price<0.0015 && last.side===lv.side){
      last.weight+=lv.weight;
      last.touches=(last.touches||1)+1;
      if(last.touches>=2) last.reason='equal '+(lv.side==='resistance'?'highs':'lows')+' ('+last.touches+'x)';
    } else {
      merged.push({price:lv.price, side:lv.side, reason:lv.reason, weight:lv.weight, touches:1});
    }
  });
  merged.forEach(function(m){
    m.prominence=Math.min(100, Math.round(m.weight*12));
  });
  merged.sort(function(a,b){return b.prominence-a.prominence;});
  return merged.slice(0,12);
}

function lcRenderClusterTable(){
  var el=document.getElementById('lcClusterTbody');
  if(!el)return;
  if(!lcState.price || !lcState.clusters.length){
    el.innerHTML='<tr><td colspan="5" style="padding:10px;color:var(--text-faint);">Loading clusters...</td></tr>';
    return;
  }
  var rows=lcState.clusters.slice().sort(function(a,b){
    return Math.abs(a.price-lcState.price)-Math.abs(b.price-lcState.price);
  }).slice(0,10);
  el.innerHTML=rows.map(function(cl){
    var distPct=((cl.price-lcState.price)/lcState.price*100);
    var color=cl.side==='resistance'?LC_RED:LC_GREEN;
    return '<tr style="border-bottom:0.5px solid var(--border);">'
      +'<td style="padding:5px 8px;">$'+cl.price.toFixed(0)+'</td>'
      +'<td style="padding:5px 8px;color:'+color+';">'+cl.side+'</td>'
      +'<td style="padding:5px 8px;text-align:right;">'+(distPct>0?'+':'')+distPct.toFixed(2)+'%</td>'
      +'<td style="padding:5px 8px;text-align:right;">'+cl.prominence+'/100</td>'
      +'<td style="padding:5px 8px;color:var(--text-faint);">'+cl.reason+'</td>'
      +'</tr>';
  }).join('');
}

// ── Sweep detection: has price crossed a known cluster level? ────────────
function lcCheckSweeps(){
  if(!lcState.price || !lcState.clusters.length)return;
  lcState.clusters.forEach(function(cl){
    var key=cl.price.toFixed(0)+'_'+cl.side;
    if(lcState.sweptLevels[key])return;
    var swept=(cl.side==='resistance' && lcState.price>cl.price) || (cl.side==='support' && lcState.price<cl.price);
    if(swept){
      lcState.sweptLevels[key]=true;
      lcLogSweep(cl);
    }
  });
}

function lcLogSweep(cl){
  var el=document.getElementById('lcSweepLog');
  if(!el)return;
  // rough move-size estimate: distance from cluster level to current price, as %
  var movePct=Math.abs((lcState.price-cl.price)/cl.price*100);
  var odds=lcOddsForMove(Math.max(movePct,1.0));
  var entry='<div style="padding:10px;background:var(--bg1);border:0.5px solid var(--border);border-radius:6px;margin-bottom:8px;">'
    +'<b>Swept '+cl.side+' at $'+cl.price.toFixed(0)+'</b> (prominence '+cl.prominence+'/100, '+cl.reason+')<br>'
    +'<span style="color:var(--text-faint);">Move so far: '+movePct.toFixed(2)+'%. Closest matched study bucket n='+odds.n+': '
    +'50%+ retrace in 24h ~'+odds.r24.p50+'%, 75%+ ~'+odds.r24.p75+'%, full retrace ~'+odds.r24.p100+'% (24h) / '+odds.r72.p100+'% (72h).</span>'
    +'</div>';
  el.innerHTML=entry+el.innerHTML;
}

// ── Init / lifecycle ──────────────────────────────────────────────────────
function lcInit(){
  lcConnectDepth();
  lcConnectLiq();
  lcFetchKlinesAndBuildClusters();
  setInterval(lcFetchKlinesAndBuildClusters, 5*60*1000); // refresh cluster model every 5min
}

(function(){
  var tab=document.getElementById('tab-sea-liq');
  if(!tab)return;
  var started=false;
  function tryStart(){
    if(started)return;
    var wrap=document.getElementById('lcDepthWrap');
    if(wrap&&wrap.clientWidth>50){
      started=true;
      lcInit();
    }
  }
  var obs=new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      if(m.type==='attributes'&&m.attributeName==='class'){
        if(tab.classList.contains('active')){
          requestAnimationFrame(function(){requestAnimationFrame(tryStart);});
        }
      }
    });
  });
  obs.observe(tab,{attributes:true});
  window.addEventListener('resize',function(){if(tab.classList.contains('active')){lcDrawDepth();}});
})();

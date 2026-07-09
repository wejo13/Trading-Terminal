// ===================== MOST LIKELY DIRECTION (BTC confluence dashboard) =====================
// Combines 3 independently-validated signals - impulse retracement, EMA200 4H
// touch, liquidity cluster proximity - shown SEPARATELY plus a plain-language
// synthesis. Deliberately NOT summed/averaged into one score: the underlying
// studies don't establish that combining them this way is valid, and several
// may be correlated (see Pump Dump Reversion Study + OI-conditioned findings
// in the vault). Includes a localStorage outcome tracker so read quality can
// be checked against reality over time instead of trusted on vibes.

var MLD_GREEN='#3ddc97', MLD_RED='#e2645f', MLD_FAINT='#6b7178', MLD_AMBER='#d9a93f';
var MLD_STORAGE_KEY='mld_reading_log_v1';
var MLD_MANUAL_CLUSTER_KEY='mld_manual_liquidity_clusters_v1';
var MLD_FAST_REFRESH_MS=60*1000;
var MLD_SLOW_REFRESH_MS=30*60*1000;
var mldImpulseDotOverlayRegistered=false;
var mldImpulseChartInstance=null;

var mldState={ price:null, klines1h:[], klines4h:[], impulse:null, emaSignal:null, clusterSignal:null,
  keyLevels:null, macroEvents:null, oiLevel:null, manualClusters:[] };

function mldEscapeHtml(value){
  return String(value===undefined||value===null?'':value)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function mldFormatTime(ts, withDate){
  if(!ts) return '—';
  return new Date(ts).toLocaleString(undefined, withDate
    ? {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}
    : {hour:'2-digit',minute:'2-digit'});
}

// Retracement odds lookup - Pump Dump Reversion Study (1H, 12mo BTCUSDT, no news filter).
var MLD_RETRACE_ODDS=[
  {minPct:1.0, maxPct:2.0, n:582, r24:{p50:93.5,p75:79.6,p100:65.5}, r72:{p100:77.3}},
  {minPct:2.0, maxPct:3.0, n:103, r24:{p50:89.3,p75:65.0,p100:44.7}, r72:{p100:65.0}},
  {minPct:3.0, maxPct:999, n:21,  r24:{p50:90.5,p75:76.2,p100:47.6}, r72:{p100:66.7}},
];
function mldOddsForMove(pct){
  var i;
  for(i=0;i<MLD_RETRACE_ODDS.length;i++){
    if(pct>=MLD_RETRACE_ODDS[i].minPct && pct<MLD_RETRACE_ODDS[i].maxPct) return MLD_RETRACE_ODDS[i];
  }
  return MLD_RETRACE_ODDS[MLD_RETRACE_ODDS.length-1];
}

// EMA200 4H Touch Study constants (from vault - EMA200 4H Touch Study.md).
// First touch rejects ~70-86%, second touch 81-100%. Median penetration
// before rejecting: 1-2%. ~55% of below-episodes reclaim after 1 touch.
var MLD_EMA_STUDY={ firstTouchRejectLow:70, firstTouchRejectHigh:86, secondTouchRejectLow:81, secondTouchRejectHigh:100, medianPenetrationPct:1.5 };

function mldEma(values, period){
  var k=2/(period+1), i;
  var sma=0;
  for(i=0;i<period;i++) sma+=values[i];
  sma=sma/period;
  var prev=sma;
  for(i=period;i<values.length;i++){ prev=values[i]*k+prev*(1-k); }
  return prev;
}

function mldFetchKlines(interval, limit){
  return fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval='+interval+'&limit='+limit)
    .then(function(res){ return res.json(); })
    .then(function(rows){
      return rows.map(function(r){return {ts:r[0],o:parseFloat(r[1]),h:parseFloat(r[2]),l:parseFloat(r[3]),c:parseFloat(r[4])};});
    });
}

// ── Signal 1: most recent impulse + retracement-so-far ───────────────────
function mldComputeImpulseSignal(candles){
  var N=candles.length, threshold=1.0, i;
  // scan backward for the most recent qualifying impulse, same method as
  // the Pump Dump Reversion Study (anchor = prior close, extreme tracked
  // until first opposite-colored close).
  for(i=N-2;i>=1;i--){
    var anchor=candles[i-1].c;
    var up=(candles[i].h-anchor)/anchor*100;
    var down=(anchor-candles[i].l)/anchor*100;
    var direction=null;
    if(up>=threshold && up>=down) direction='up';
    else if(down>=threshold && down>up) direction='down';
    if(!direction) continue;

    var extremePrice=direction==='up'?candles[i].h:candles[i].l;
    var extremeIdx=i, j;
    for(j=i+1;j<N;j++){
      var cj=candles[j];
      if(direction==='up'){
        if(cj.h>extremePrice){ extremePrice=cj.h; extremeIdx=j; }
        if(cj.c<cj.o) break;
      } else {
        if(cj.l<extremePrice){ extremePrice=cj.l; extremeIdx=j; }
        if(cj.c>cj.o) break;
      }
    }
    var impulseEndIdx=Math.min(j,N-1);
    var moveSizePct=Math.abs(extremePrice-anchor)/anchor*100;
    var currentPrice=candles[N-1].c;
    var retracedPct;
    if(direction==='up') retracedPct=(extremePrice-currentPrice)/(extremePrice-anchor)*100;
    else retracedPct=(currentPrice-extremePrice)/(anchor-extremePrice)*100;
    retracedPct=Math.max(0,Math.min(100,retracedPct));

    return {
      direction:direction, moveSizePct:moveSizePct, retracedPct:retracedPct,
      anchorPrice:anchor, extremePrice:extremePrice, impulseEndIdx:impulseEndIdx,
      impulseStartTs:candles[i].ts, impulseAnchorTs:candles[i-1].ts,
      impulseExtremeTs:candles[extremeIdx].ts, impulseEndTs:candles[impulseEndIdx].ts,
      hoursAgo:(N-1-impulseEndIdx), odds:mldOddsForMove(moveSizePct),
    };
  }
  return null;
}

// ── Signal 2: EMA200 4H distance + touch state ────────────────────────────
function mldComputeEmaSignal(candles4h){
  if(candles4h.length<210) return null;
  var closes=candles4h.map(function(c){return c.c;});
  var emaVal=mldEma(closes,200);
  var last=candles4h[candles4h.length-1];
  var distPct=(last.c-emaVal)/emaVal*100;
  var touching=(last.l<=emaVal && last.h>=emaVal);
  // count consecutive recent touches (last 10 4H candles) for 1st-vs-2nd-touch context
  var touches=0, k;
  for(k=candles4h.length-10;k<candles4h.length;k++){
    if(k<0) continue;
    if(candles4h[k].l<=emaVal && candles4h[k].h>=emaVal) touches++;
  }
  return { emaValue:emaVal, distPct:distPct, touching:touching, recentTouchCount:touches, side:(last.c>=emaVal?'above':'below') };
}

// ── Signal 3: nearest manually-entered liquidity cluster ─────────────────
function mldManualTypeMeta(type){
  if(type==='eq_low') return { label:'EQ LOWS', side:'support' };
  if(type==='swing_high') return { label:'SWING HIGH', side:'resistance' };
  if(type==='swing_low') return { label:'SWING LOW', side:'support' };
  return { label:'EQ HIGHS', side:'resistance' };
}
function mldLoadManualClusters(){
  try{
    var parsed=JSON.parse(localStorage.getItem(MLD_MANUAL_CLUSTER_KEY))||[];
    if(!Array.isArray(parsed)) return [];
    return parsed.filter(function(c){ return c && isFinite(c.price) && c.price>0; }).map(function(c){
      var meta=mldManualTypeMeta(c.type);
      return { id:String(c.id), type:c.type, label:meta.label, side:meta.side, price:Number(c.price), createdTs:Number(c.createdTs)||Date.now(), source:'manual' };
    });
  }catch(e){ return []; }
}
function mldSaveManualClusters(clusters){
  try{ localStorage.setItem(MLD_MANUAL_CLUSTER_KEY, JSON.stringify(clusters)); }catch(e){}
}
function mldRefreshClusterSignalFromManual(){
  mldState.manualClusters=mldLoadManualClusters();
  if(mldState.price){
    mldState.clusterSignal=mldComputeClusterSignal(mldState.price);
  }
  mldRender();
  mldRenderManualClusters();
}
function mldAddManualCluster(){
  var typeEl=document.getElementById('mldManualClusterType');
  var priceEl=document.getElementById('mldManualClusterPrice');
  var price=priceEl?Number(priceEl.value):NaN;
  if(!isFinite(price)||price<=0){
    if(priceEl) priceEl.focus();
    return;
  }
  var type=typeEl?typeEl.value:'eq_high';
  var meta=mldManualTypeMeta(type);
  var clusters=mldLoadManualClusters();
  clusters.unshift({ id:String(Date.now()), type:type, label:meta.label, side:meta.side, price:price, createdTs:Date.now(), source:'manual' });
  mldSaveManualClusters(clusters.slice(0,50));
  if(priceEl) priceEl.value='';
  mldRefreshClusterSignalFromManual();
}
function mldDeleteManualCluster(id){
  var clusters=mldLoadManualClusters().filter(function(c){ return String(c.id)!==String(id); });
  mldSaveManualClusters(clusters);
  mldRefreshClusterSignalFromManual();
}
function mldRenderManualClusters(){
  var el=document.getElementById('mldManualClusterList');
  if(!el) return;
  var clusters=mldLoadManualClusters();
  mldState.manualClusters=clusters;
  if(!clusters.length){
    el.innerHTML='';
    return;
  }
  el.innerHTML=clusters.map(function(c){
    var color=c.side==='resistance'?MLD_RED:MLD_GREEN;
    var dist=mldState.price?(((c.price-mldState.price)/mldState.price*100)) : null;
    var distText=dist===null?'':' · '+(dist>0?'+':'')+dist.toFixed(2)+'% from price';
    return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:7px 8px;border:0.5px solid var(--border);border-radius:7px;background:rgba(255,255,255,.02);">'
      +'<div style="font-size:12px;"><span style="color:'+color+';font-weight:700;">'+mldEscapeHtml(c.label)+'</span> <span style="color:var(--text);font-weight:700;">$'+c.price.toFixed(0)+'</span><span style="color:var(--text-faint);">'+distText+'</span></div>'
      +'<button onclick="mldDeleteManualCluster(\''+mldEscapeHtml(c.id)+'\')" style="background:transparent;border:0.5px solid var(--border);border-radius:6px;color:var(--text-faint);padding:4px 8px;font-size:10px;cursor:pointer;">Remove</button>'
      +'</div>';
  }).join('');
}
function mldComputeClusterSignal(price){
  var clusters=mldLoadManualClusters();
  if(!clusters.length) return null;
  clusters.sort(function(a,b){ return Math.abs(a.price-price)-Math.abs(b.price-price); });
  var nearest=clusters[0];
  return { price:nearest.price, side:nearest.side, distPct:(nearest.price-price)/price*100, source:'manual', label:nearest.label, type:nearest.type||'' };
}

function mldEnsureImpulseDotOverlay(){
  if(mldImpulseDotOverlayRegistered || typeof klinecharts==='undefined') return;
  try{
    klinecharts.registerOverlay({
      name:'mldImpulseDot',
      totalStep:1,
      needDefaultPointFigure:false,
      needDefaultXAxisFigure:false,
      needDefaultYAxisFigure:false,
      createPointFigures:function(ctx){
        var coordinates=ctx.coordinates||[];
        var overlay=ctx.overlay||{};
        if(!coordinates.length) return [];
        var p=coordinates[0];
        var data=overlay.extendData||{};
        var color=data.color||MLD_GREEN;
        return [
          { type:'circle', attrs:{ x:p.x, y:p.y, r:6 }, styles:{ style:'fill', color:color }, ignoreEvent:true },
          { type:'circle', attrs:{ x:p.x, y:p.y, r:11 }, styles:{ style:'stroke', color:color, size:2 }, ignoreEvent:true },
          { type:'text', attrs:{ x:p.x+12, y:p.y-10, text:data.label||'Impulse', align:'left', baseline:'middle' }, styles:{ color:color, size:11 }, ignoreEvent:true }
        ];
      }
    });
    mldImpulseDotOverlayRegistered=true;
  }catch(e){
    console.error('mldEnsureImpulseDotOverlay', e);
  }
}
function mldFindImpulse4hMarker(){
  var im=mldState.impulse;
  if(!im || !mldState.klines4h.length) return null;
  var ts=im.impulseExtremeTs||im.impulseStartTs;
  var i, candle=null;
  for(i=0;i<mldState.klines4h.length;i++){
    var c=mldState.klines4h[i];
    if(ts>=c.ts && ts<c.ts+4*3600000){ candle=c; break; }
  }
  if(!candle){
    candle=mldState.klines4h.reduce(function(best,c){
      if(!best) return c;
      return Math.abs(c.ts-ts)<Math.abs(best.ts-ts)?c:best;
    }, null);
  }
  if(!candle) return null;
  return {
    timestamp:candle.ts,
    value:im.extremePrice,
    candle:candle,
    color:im.direction==='up'?MLD_GREEN:MLD_RED,
    label:(im.direction==='up'?'Bullish':'Bearish')+' impulse'
  };
}
function mldEnsureImpulseModal(){
  var modal=document.getElementById('mldImpulseModal');
  if(modal) return modal;
  modal=document.createElement('div');
  modal.id='mldImpulseModal';
  modal.style.cssText='position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);z-index:9999;padding:22px;';
  modal.innerHTML='<div style="width:min(980px,96vw);background:var(--bg);border:0.5px solid var(--border);border-radius:14px;box-shadow:0 22px 70px rgba(0,0,0,.55);overflow:hidden;">'
    +'<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:13px 16px;border-bottom:0.5px solid var(--border);background:var(--bg1);">'
      +'<div><div id="mldImpulseModalTitle" style="font-size:14px;font-weight:700;color:var(--text);">Impulse 4H view</div><div id="mldImpulseModalSub" style="font-size:11px;color:var(--text-faint);margin-top:2px;"></div></div>'
      +'<button onclick="mldCloseImpulseChart()" style="background:transparent;border:0.5px solid var(--border);border-radius:7px;color:var(--text-faint);padding:6px 10px;font-size:12px;cursor:pointer;">Close</button>'
    +'</div>'
    +'<div id="mldImpulseChartError" style="display:none;padding:12px 16px;color:'+MLD_RED+';font-size:12px;"></div>'
    +'<div id="mldImpulseChartCanvas" style="height:430px;background:#050911;"></div>'
  +'</div>';
  modal.addEventListener('click', function(e){ if(e.target===modal) mldCloseImpulseChart(); });
  document.body.appendChild(modal);
  return modal;
}
function mldCloseImpulseChart(){
  var modal=document.getElementById('mldImpulseModal');
  if(modal) modal.style.display='none';
  try{
    if(typeof klinecharts!=='undefined') klinecharts.dispose('mldImpulseChartCanvas');
  }catch(e){}
  mldImpulseChartInstance=null;
}
function mldOpenImpulseChart(){
  var im=mldState.impulse;
  var modal=mldEnsureImpulseModal();
  var errorEl=document.getElementById('mldImpulseChartError');
  var titleEl=document.getElementById('mldImpulseModalTitle');
  var subEl=document.getElementById('mldImpulseModalSub');
  if(errorEl){ errorEl.style.display='none'; errorEl.textContent=''; }
  modal.style.display='flex';
  if(!im || !mldState.klines4h.length){
    if(errorEl){ errorEl.style.display='block'; errorEl.textContent='No impulse or 4H candles loaded yet.'; }
    return;
  }
  if(typeof klinecharts==='undefined'){
    if(errorEl){ errorEl.style.display='block'; errorEl.textContent='Chart library is not loaded.'; }
    return;
  }
  var marker=mldFindImpulse4hMarker();
  if(!marker){
    if(errorEl){ errorEl.style.display='block'; errorEl.textContent='Could not map this impulse to a 4H candle.'; }
    return;
  }
  if(titleEl) titleEl.textContent='BTCUSDT 4H · '+(im.direction==='up'?'bullish':'bearish')+' impulse';
  if(subEl) subEl.textContent='Impulse start '+mldFormatTime(im.impulseStartTs,true)+' · extreme '+mldFormatTime(im.impulseExtremeTs,true)+' · move '+im.moveSizePct.toFixed(2)+'% · retraced '+im.retracedPct.toFixed(0)+'%';
  try{
    klinecharts.dispose('mldImpulseChartCanvas');
  }catch(e){}
  var chart=klinecharts.init('mldImpulseChartCanvas');
  if(!chart){
    if(errorEl){ errorEl.style.display='block'; errorEl.textContent='Chart failed to initialize.'; }
    return;
  }
  mldImpulseChartInstance=chart;
  chart.setStyles({
    grid:{ horizontal:{ color:'rgba(255,255,255,0.06)' }, vertical:{ show:false } },
    candle:{ bar:{ upColor:MLD_GREEN, downColor:MLD_RED, noChangeColor:'#6b7178', upBorderColor:MLD_GREEN, downBorderColor:MLD_RED, upWickColor:MLD_GREEN, downWickColor:MLD_RED } },
    xAxis:{ tickText:{ color:'#7186a0' }, axisLine:{ color:'rgba(255,255,255,0.08)' } },
    yAxis:{ tickText:{ color:'#7186a0' }, axisLine:{ color:'rgba(255,255,255,0.08)' } }
  });
  var chartData=mldState.klines4h.map(function(c){
    return { timestamp:c.ts, open:c.o, high:c.h, low:c.l, close:c.c };
  });
  chart.applyNewData(chartData);
  mldEnsureImpulseDotOverlay();
  chart.createOverlay({
    name:'mldImpulseDot',
    lock:true,
    points:[{ timestamp:marker.timestamp, value:marker.value }],
    extendData:{ color:marker.color, label:'Impulse' }
  });
  if(chart.scrollToTimestamp) chart.scrollToTimestamp(marker.timestamp, 0);
}

// ── Signal 4: key levels (daily/weekly open, distance to each) ───────────
function mldComputeKeyLevels(candles4h, price){
  if(!candles4h.length) return null;
  var now=new Date();
  var dailyOpenTs=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),0,0,0);
  var dow=now.getUTCDay(); // Sun=0..Sat=6
  var daysSinceMonday=(dow+6)%7;
  var weeklyOpenTs=dailyOpenTs-daysSinceMonday*86400000;

  function candleAtOrAfter(ts){
    var i;
    for(i=0;i<candles4h.length;i++){ if(candles4h[i].ts>=ts) return candles4h[i]; }
    return null;
  }
  var dailyC=candleAtOrAfter(dailyOpenTs);
  var weeklyC=candleAtOrAfter(weeklyOpenTs);
  if(!dailyC||!weeklyC) return null;
  return {
    dailyOpen:dailyC.o, dailyChgPct:(price-dailyC.o)/dailyC.o*100,
    weeklyOpen:weeklyC.o, weeklyChgPct:(price-weeklyC.o)/weeklyC.o*100,
  };
}

// ── Signal 5: macro calendar (USD high/medium impact, via Worker proxy) ──
// The free ForexFactory feed only covers "this week" - no forward-looking
// endpoint exists (confirmed: nextweek.json 404s). FOMC dates are set months
// in advance by the Fed, so they're hardcoded here as a fallback the "this
// week" feed can't provide. CPI/NFP dates are NOT hardcoded (BLS doesn't
// publish them on a fixed formula far enough out to hardcode reliably) -
// those only show once they enter the live "this week" window.
var MLD_CALENDAR_URL='https://royal-darkness-0ac6.wimneys.workers.dev/api/macro-calendar';
// 2026 FOMC decision dates (2nd day of each meeting), 14:00 ET, converted to
// exact UTC offsets per date (source: federalreserve.gov official calendar).
var MLD_FOMC_DATES=[
  '2026-01-28T14:00:00-05:00','2026-03-18T14:00:00-04:00','2026-04-29T14:00:00-04:00',
  '2026-06-17T14:00:00-04:00','2026-07-29T14:00:00-04:00','2026-09-16T14:00:00-04:00',
  '2026-10-28T14:00:00-04:00','2026-12-09T14:00:00-05:00',
];
function mldNextFomc(){
  var now=Date.now(), i;
  for(i=0;i<MLD_FOMC_DATES.length;i++){
    var ts=Date.parse(MLD_FOMC_DATES[i]);
    if(ts>=now) return { ts:ts, daysAway:Math.ceil((ts-now)/86400000) };
  }
  return null;
}
function mldFetchMacroCalendar(){
  return fetch(MLD_CALENDAR_URL).then(function(res){ return res.json(); }).then(function(data){
    if(!data||!data.events) return [];
    var now=Date.now(), horizon=now+4*86400000; // next 4 days
    return data.events
      .map(function(e){ return { title:e.title, impact:e.impact, ts:Date.parse(e.date), forecast:e.forecast, previous:e.previous }; })
      .filter(function(e){ return e.ts && e.ts>=now-3600000 && e.ts<=horizon; })
      .sort(function(a,b){ return a.ts-b.ts; })
      .slice(0,6);
  }).catch(function(e){ console.error('mldFetchMacroCalendar',e); return null; });
}

// ── Signal 6: OI level context (Binance native OI, 30d rolling z-score) ──
// Single-venue (Binance only) live reference, NOT the same as the vault's
// Binance+Bybit combined research series. See "OI-Extreme Reversal Study"
// in the vault: this framing (OI level z-score -> reversal) was tested and
// showed no reliable edge - shown here as context only, not a signal.
var MLD_OI_HIST_URL='https://fapi.binance.com/futures/data/openInterestHist';
function mldFetchOiHistory(){
  var endTime=Date.now(), results=[], calls=0, maxCalls=8;
  function step(){
    var url=MLD_OI_HIST_URL+'?symbol=BTCUSDT&period=15m&limit=500&endTime='+endTime;
    return fetch(url).then(function(res){return res.json();}).then(function(rows){
      if(!rows||!rows.length) return results;
      rows.forEach(function(r){ results.push({ts:Number(r.timestamp),oi:parseFloat(r.sumOpenInterest)}); });
      var oldest=Number(rows[0].timestamp);
      endTime=oldest-1;
      calls++;
      var cutoff=Date.now()-30*86400000;
      if(oldest<=cutoff||calls>=maxCalls) return results;
      return step();
    });
  }
  return step().then(function(rows){
    rows.sort(function(a,b){return a.ts-b.ts;});
    return rows;
  }).catch(function(e){ console.error('mldFetchOiHistory',e); return null; });
}
function mldComputeOiZScore(rows){
  if(!rows||rows.length<200) return null;
  var vals=rows.map(function(r){return r.oi;});
  var n=vals.length, sum=0, sumSq=0, i;
  for(i=0;i<n;i++){ sum+=vals[i]; sumSq+=vals[i]*vals[i]; }
  var mean=sum/n, variance=Math.max(0,sumSq/n-mean*mean), std=Math.sqrt(variance);
  var current=vals[n-1];
  var z=std>0?(current-mean)/std:0;
  var sorted=vals.slice().sort(function(a,b){return a-b;});
  var rank=0; for(i=0;i<sorted.length;i++){ if(sorted[i]<=current) rank=i; }
  var pctile=Math.round(100*rank/(sorted.length-1));
  return { current:current, z:z, pctile:pctile, days:Math.round((rows[n-1].ts-rows[0].ts)/86400000) };
}

// ── Render ─────────────────────────────────────────────────────────────
function mldRender(){
  var priceLabel=document.getElementById('mldPriceLabel');
  if(priceLabel && mldState.price) priceLabel.textContent='$'+mldState.price.toFixed(0)+' · refreshed '+new Date().toLocaleTimeString();

  var el=document.getElementById('mldSignals');
  if(!el) return;
  var manualTypeBefore=document.getElementById('mldManualClusterType');
  var manualPriceBefore=document.getElementById('mldManualClusterPrice');
  var manualTypeValue=manualTypeBefore?manualTypeBefore.value:'';
  var manualPriceValue=manualPriceBefore?manualPriceBefore.value:'';
  var cards=[];

  if(mldState.impulse){
    var im=mldState.impulse;
    var dirLabel=im.direction==='up'?'Pump':'Dump';
    var dirColor=im.direction==='up'?MLD_GREEN:MLD_RED;
    var impulseTime='Impulse '+mldFormatTime(im.impulseStartTs,true)+' → '+mldFormatTime(im.impulseEndTs,true);
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px;">'
        +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;">Impulse retracement</div>'
        +'<button onclick="mldOpenImpulseChart()" style="background:transparent;border:0.5px solid var(--border);border-radius:6px;color:var(--text);padding:3px 8px;font-size:10px;cursor:pointer;">View</button>'
      +'</div>'
      +'<div style="font-size:13px;"><span style="color:'+dirColor+';font-weight:600;">'+dirLabel+'</span> of '+im.moveSizePct.toFixed(2)+'%, ~'+im.hoursAgo+'h ago. Retraced so far: <b>'+im.retracedPct.toFixed(0)+'%</b></div>'
      +'<div style="font-size:11px;color:var(--text-faint);margin-top:5px;">'+impulseTime+'</div>'
      +'</div>');
  } else {
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text-faint);font-size:12px;">Impulse retracement: no qualifying move (≥1%) found in the recent window.</div>');
  }

  if(mldState.emaSignal){
    var es=mldState.emaSignal;
    var sideColor=es.side==='above'?MLD_GREEN:MLD_RED;
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">EMA200 · 4H</div>'
      +'<div style="font-size:13px;">Price is <span style="color:'+sideColor+';font-weight:600;">'+es.side+'</span> EMA200, '+(es.distPct>0?'+':'')+es.distPct.toFixed(2)+'% away ($'+es.emaValue.toFixed(0)+')</div>'
      +'</div>');
  } else {
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text-faint);font-size:12px;">EMA200 4H: not enough history loaded yet.</div>');
  }

  var cs=mldState.clusterSignal;
  var csColor=cs&&cs.side==='resistance'?MLD_RED:MLD_GREEN;
  var csText=cs
    ? '$'+cs.price.toFixed(0)+' <span style="color:'+csColor+';font-weight:600;">'+mldEscapeHtml(cs.label)+' · '+mldEscapeHtml(cs.side)+'</span>, '+(cs.distPct>0?'+':'')+cs.distPct.toFixed(2)+'% away'
    : '—';
  cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
    +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Nearest liquidity cluster</div>'
    +'<div style="font-size:13px;margin-bottom:9px;">'+csText+'</div>'
    +'<div style="display:grid;grid-template-columns:minmax(96px,1fr) 86px auto;gap:6px;align-items:end;">'
      +'<label style="font-size:9px;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;">Type'
        +'<select id="mldManualClusterType" style="width:100%;margin-top:3px;background:var(--bg2);border:0.5px solid var(--border);border-radius:6px;color:var(--text);padding:5px 7px;font-size:10px;">'
          +'<option value="eq_high">EQ HIGHS</option>'
          +'<option value="eq_low">EQ LOWS</option>'
          +'<option value="swing_high">SWING HIGH</option>'
          +'<option value="swing_low">SWING LOW</option>'
        +'</select>'
      +'</label>'
      +'<label style="font-size:9px;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;">Price'
        +'<input id="mldManualClusterPrice" type="number" step="0.1" placeholder="63250" style="width:100%;margin-top:3px;background:var(--bg2);border:0.5px solid var(--border);border-radius:6px;color:var(--text);padding:5px 7px;font-size:10px;box-sizing:border-box;">'
      +'</label>'
      +'<button onclick="mldAddManualCluster()" style="background:var(--teal);color:var(--bg);border:none;border-radius:6px;padding:6px 10px;font-size:10px;font-weight:600;cursor:pointer;">Add</button>'
    +'</div>'
    +'<div id="mldManualClusterList" style="margin-top:8px;display:flex;flex-direction:column;gap:6px;"></div>'
    +'</div>');

  if(mldState.keyLevels){
    var kl=mldState.keyLevels;
    var dColor=kl.dailyChgPct>=0?MLD_GREEN:MLD_RED, wColor=kl.weeklyChgPct>=0?MLD_GREEN:MLD_RED;
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Key levels</div>'
      +'<div style="font-size:13px;">Daily open $'+kl.dailyOpen.toFixed(0)+' (<span style="color:'+dColor+';font-weight:600;">'+(kl.dailyChgPct>=0?'+':'')+kl.dailyChgPct.toFixed(2)+'%</span>)</div>'
      +'<div style="font-size:13px;margin-top:2px;">Weekly open $'+kl.weeklyOpen.toFixed(0)+' (<span style="color:'+wColor+';font-weight:600;">'+(kl.weeklyChgPct>=0?'+':'')+kl.weeklyChgPct.toFixed(2)+'%</span>)</div>'
      +'</div>');
  }

  if(mldState.oiLevel){
    var oi=mldState.oiLevel;
    var oiNote=Math.abs(oi.z)>=2?(oi.z>0?'unusually high':'unusually low'):(Math.abs(oi.z)>=1?(oi.z>0?'elevated':'low'):'normal range');
    var oiColor=Math.abs(oi.z)>=1.5?MLD_AMBER:'var(--text)';
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">OI level (Binance, '+oi.days+'d)</div>'
      +'<div style="font-size:13px;">'+Math.round(oi.current)+' BTC · <span style="color:'+oiColor+';font-weight:600;">'+oiNote+'</span> (z='+oi.z.toFixed(2)+', p'+oi.pctile+')</div>'
      +'</div>');
  }

  var fomc=mldNextFomc();
  var fomcLine=fomc?('<div style="font-size:12px;margin-top:3px;padding-top:5px;border-top:0.5px solid var(--border);"><span style="color:'+MLD_RED+';font-weight:600;">●</span> Next FOMC: '+new Date(fomc.ts).toLocaleDateString(undefined,{month:'short',day:'numeric'})+' ('+fomc.daysAway+'d away)</div>'):'';
  if(mldState.macroEvents && mldState.macroEvents.length){
    var evRows=mldState.macroEvents.map(function(e){
      var when=new Date(e.ts);
      var impactColor=e.impact==='High'?MLD_RED:MLD_AMBER;
      return '<div style="font-size:12px;margin-top:3px;"><span style="color:'+impactColor+';font-weight:600;">●</span> '+when.toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'})+' — '+e.title+'</div>';
    }).join('');
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Macro calendar (USD)</div>'
      +evRows+fomcLine+'</div>');
  } else if(mldState.macroEvents){
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Macro calendar (USD)</div>'
      +'<div style="color:var(--text-faint);font-size:12px;">Nothing high/medium-impact in the next 4 days.</div>'+fomcLine+'</div>');
  }

  el.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;">'+cards.join('')+'</div>';
  if(manualTypeValue){
    var manualTypeAfter=document.getElementById('mldManualClusterType');
    if(manualTypeAfter) manualTypeAfter.value=manualTypeValue;
  }
  if(manualPriceValue){
    var manualPriceAfter=document.getElementById('mldManualClusterPrice');
    if(manualPriceAfter) manualPriceAfter.value=manualPriceValue;
  }

  mldRenderSynthesis();
  mldRenderHeadline();
  mldRenderManualClusters();
}

// ── Headline: single plain-language verdict, shown above the cards ───────
function mldRenderHeadline(){
  var el=document.getElementById('mldHeadline');
  if(!el) return;
  var bullish=0, bearish=0, notes=[];

  if(mldState.impulse){
    var im=mldState.impulse;
    if(im.retracedPct<50){
      if(im.direction==='up'){ bearish++; notes.push('pump not yet retraced'); }
      else { bullish++; notes.push('dump not yet retraced'); }
    }
  }
  if(mldState.emaSignal){
    var es=mldState.emaSignal;
    if(es.touching){
      if(es.side==='above'){ bearish++; notes.push('at 4H 200EMA from above (reject zone)'); }
      else { bullish++; notes.push('at 4H 200EMA from below (reject zone)'); }
    }
  }
  if(mldState.clusterSignal && Math.abs(mldState.clusterSignal.distPct)<0.3){
    if(mldState.clusterSignal.side==='resistance') bearish++; else bullish++;
    notes.push('sitting at a '+mldState.clusterSignal.side+' cluster');
  }
  if(mldState.keyLevels){
    if(mldState.keyLevels.dailyChgPct>0) bullish++; else bearish++;
  }

  var verdict, color;
  if(bullish>bearish+1){ verdict='Leaning bullish'; color=MLD_GREEN; }
  else if(bearish>bullish+1){ verdict='Leaning bearish'; color=MLD_RED; }
  else { verdict='No clear lean'; color=MLD_FAINT; }

  var hasHighImpactToday=false;
  if(mldState.macroEvents){
    var todayEnd=new Date(); todayEnd.setUTCHours(23,59,59,999);
    hasHighImpactToday=mldState.macroEvents.some(function(e){ return e.impact==='High' && e.ts<=todayEnd.getTime(); });
  }
  var fomcToday=mldNextFomc();
  if(fomcToday && fomcToday.daysAway<=0) hasHighImpactToday=true;
  var macroNote=hasHighImpactToday?' High-impact USD data today — expect volatility around the release.':'';

  el.innerHTML='<span style="color:'+color+';font-weight:700;font-size:15px;">'+verdict+'</span>'
    +'<span style="font-size:12px;color:var(--text-dim);"> ('+(notes.length?notes.join(', '):'no signals aligned')+')'+macroNote+'</span>';
}

function mldRenderSynthesis(){
  var el=document.getElementById('mldSynthesis');
  if(!el) return;
  var notes=[];
  if(mldState.impulse){
    var im=mldState.impulse;
    if(im.retracedPct<50) notes.push('the recent '+(im.direction==='up'?'pump':'dump')+' has more room to retrace by historical base rates (only '+im.retracedPct.toFixed(0)+'% retraced so far)');
    else notes.push('the recent '+(im.direction==='up'?'pump':'dump')+' has already retraced '+im.retracedPct.toFixed(0)+'%, closer to the study\'s typical outcome');
  }
  if(mldState.emaSignal && mldState.emaSignal.touching){
    notes.push('price is actively at the 4H 200EMA, historically a high-reject-rate zone');
  }
  if(mldState.clusterSignal && Math.abs(mldState.clusterSignal.distPct)<0.3){
    notes.push('price is sitting right at a liquidity cluster ('+mldState.clusterSignal.side+')');
  }
  var text=notes.length
    ? 'Read: '+notes.join('; ')+'. This is a directional tilt from independently-measured base rates, not a combined probability - treat agreement across signals as a reason to pay closer attention, not as added statistical confidence.'
    : 'No strong signal alignment right now - price isn\'t at a notable EMA touch or cluster, and no fresh impulse is mid-retracement.';
  el.textContent=text;
}

// ── Outcome tracker (localStorage) ────────────────────────────────────────
function mldLoadLog(){
  try{ return JSON.parse(localStorage.getItem(MLD_STORAGE_KEY)) || []; }catch(e){ return []; }
}
function mldSaveLog(log){
  try{ localStorage.setItem(MLD_STORAGE_KEY, JSON.stringify(log)); }catch(e){}
}
function mldLogReading(){
  if(!mldState.price) return;
  var log=mldLoadLog();
  var lean='neutral';
  if(mldState.impulse && mldState.impulse.retracedPct<50){
    lean=mldState.impulse.direction==='up'?'expect down (retrace)':'expect up (retrace)';
  }
  log.unshift({ ts:Date.now(), price:mldState.price, lean:lean });
  if(log.length>50) log.length=50;
  mldSaveLog(log);
  mldRenderHistory();
  var status=document.getElementById('mldLogStatus');
  if(status){ status.textContent='Logged at '+new Date().toLocaleTimeString(); setTimeout(function(){status.textContent='';},3000); }
}
function mldRenderHistory(){
  var el=document.getElementById('mldHistoryTbody');
  if(!el) return;
  var log=mldLoadLog();
  if(!log.length){ el.innerHTML='<tr><td colspan="5" style="padding:8px;color:var(--text-faint);">No reads logged yet.</td></tr>'; return; }
  el.innerHTML=log.map(function(entry){
    var ageHours=(Date.now()-entry.ts)/3600000;
    var loggedStr=new Date(entry.ts).toLocaleString();
    var outcomeCell='<span style="color:var(--text-faint);">pending (24h not elapsed)</span>';
    var laterCell='—';
    if(ageHours>=24 && mldState.price){
      var chgPct=(mldState.price-entry.price)/entry.price*100;
      laterCell='$'+mldState.price.toFixed(0)+' ('+(chgPct>0?'+':'')+chgPct.toFixed(2)+'%)';
      var wentDown=chgPct<0, wentUp=chgPct>0;
      var correct=null;
      if(entry.lean.indexOf('expect down')===0) correct=wentDown;
      else if(entry.lean.indexOf('expect up')===0) correct=wentUp;
      outcomeCell=correct===null?'<span style="color:var(--text-faint);">neutral read</span>'
        :(correct?'<span style="color:'+MLD_GREEN+';font-weight:600;">correct</span>':'<span style="color:'+MLD_RED+';font-weight:600;">wrong</span>');
    }
    return '<tr style="border-bottom:0.5px solid var(--border);">'
      +'<td style="padding:4px 6px;color:var(--text-faint);">'+loggedStr+'</td>'
      +'<td style="padding:4px 6px;text-align:right;">$'+entry.price.toFixed(0)+'</td>'
      +'<td style="padding:4px 6px;">'+entry.lean+'</td>'
      +'<td style="padding:4px 6px;text-align:right;">'+laterCell+'</td>'
      +'<td style="padding:4px 6px;">'+outcomeCell+'</td>'
      +'</tr>';
  }).join('');
}

// ── Init / refresh cycle ───────────────────────────────────────────────
function mldRefresh(){
  Promise.all([mldFetchKlines('1h',72), mldFetchKlines('4h',300)]).then(function(results){
    mldState.klines1h=results[0];
    mldState.klines4h=results[1];
    mldState.price=results[0][results[0].length-1].c;
    mldState.impulse=mldComputeImpulseSignal(mldState.klines1h);
    mldState.emaSignal=mldComputeEmaSignal(mldState.klines4h);
    mldState.clusterSignal=mldComputeClusterSignal(mldState.price);
    mldState.keyLevels=mldComputeKeyLevels(mldState.klines4h, mldState.price);
    mldRender();
    mldRenderHistory();
  }).catch(function(e){
    var el=document.getElementById('mldSignals');
    if(el) el.innerHTML='<div style="color:'+MLD_RED+';font-size:12px;">Failed to load (see console).</div>';
    console.error('mldRefresh',e);
  });
}

// Slower cycle for the heavier/less time-critical cards (macro calendar,
// OI level, key levels) — no need to hit these every 5 min like price.
function mldSlowRefresh(){
  if(mldState.klines4h.length && mldState.price){
    mldState.keyLevels=mldComputeKeyLevels(mldState.klines4h, mldState.price);
    mldRender();
  }
  mldFetchMacroCalendar().then(function(events){ mldState.macroEvents=events; mldRender(); });
  mldFetchOiHistory().then(function(rows){ mldState.oiLevel=mldComputeOiZScore(rows); mldRender(); });
}

function mldInit(){
  mldRefresh();
  setInterval(mldRefresh, MLD_FAST_REFRESH_MS);
  mldSlowRefresh();
  setInterval(mldSlowRefresh, MLD_SLOW_REFRESH_MS);
}

(function(){
  var tab=document.getElementById('tab-dashboard');
  if(!tab)return;
  var started=false;
  function tryStart(){
    if(started)return;
    var el=document.getElementById('mldSignals');
    if(el){ started=true; mldInit(); }
  }
  // dashboard is the default active tab, so try immediately too
  document.addEventListener('DOMContentLoaded', tryStart);
  if(document.readyState==='complete'||document.readyState==='interactive') tryStart();
  var obs=new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      if(m.type==='attributes'&&m.attributeName==='class'){
        if(tab.classList.contains('active')) tryStart();
      }
    });
  });
  obs.observe(tab,{attributes:true});
})();

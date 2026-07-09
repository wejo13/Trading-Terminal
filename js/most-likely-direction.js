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

var mldState={ price:null, klines1h:[], klines4h:[], impulse:null, emaSignal:null, clusterSignal:null };

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
        if(cj.h>extremePrice) extremePrice=cj.h;
        if(cj.c<cj.o) break;
      } else {
        if(cj.l<extremePrice) extremePrice=cj.l;
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

// ── Signal 3: nearest liquidity cluster (lightweight, same model as the
// Liquidity Clusters research tab, rebuilt here so this card works without
// needing that tab's live WS connections running) ────────────────────────
function mldBuildClusters(candles){
  var levels=[], i, lookback=3;
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
  levels.forEach(function(lv){
    var roundness=lv.price%500===0?3:(lv.price%100===0?1.5:0);
    lv.weight+=roundness;
  });
  levels.sort(function(a,b){return a.price-b.price;});
  var merged=[];
  levels.forEach(function(lv){
    var last=merged[merged.length-1];
    if(last && Math.abs(lv.price-last.price)/last.price<0.0015 && last.side===lv.side){
      last.weight+=lv.weight; last.touches=(last.touches||1)+1;
    } else {
      merged.push({price:lv.price, side:lv.side, reason:lv.reason, weight:lv.weight, touches:1});
    }
  });
  merged.forEach(function(m){ m.prominence=Math.min(100,Math.round(m.weight*12)); });
  return merged;
}
function mldComputeClusterSignal(candles, price){
  var clusters=mldBuildClusters(candles);
  if(!clusters.length) return null;
  clusters.sort(function(a,b){ return Math.abs(a.price-price)-Math.abs(b.price-price); });
  var nearest=clusters[0];
  return { price:nearest.price, side:nearest.side, prominence:nearest.prominence, distPct:(nearest.price-price)/price*100 };
}

// ── Render ─────────────────────────────────────────────────────────────
function mldRender(){
  var priceLabel=document.getElementById('mldPriceLabel');
  if(priceLabel && mldState.price) priceLabel.textContent='$'+mldState.price.toFixed(0)+' · refreshed '+new Date().toLocaleTimeString();

  var el=document.getElementById('mldSignals');
  if(!el) return;
  var cards=[];

  if(mldState.impulse){
    var im=mldState.impulse;
    var dirLabel=im.direction==='up'?'Pump':'Dump';
    var dirColor=im.direction==='up'?MLD_GREEN:MLD_RED;
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Impulse retracement</div>'
      +'<div style="font-size:13px;"><span style="color:'+dirColor+';font-weight:600;">'+dirLabel+'</span> of '+im.moveSizePct.toFixed(2)+'%, ~'+im.hoursAgo+'h ago. Retraced so far: <b>'+im.retracedPct.toFixed(0)+'%</b></div>'
      +'<div style="font-size:11px;color:var(--text-faint);margin-top:4px;">Matched study bucket n='+im.odds.n+': 50%+ retrace ~'+im.odds.r24.p50+'% (24h), 75%+ ~'+im.odds.r24.p75+'%, full ~'+im.odds.r24.p100+'% (24h) / '+im.odds.r72.p100+'% (72h)</div>'
      +'</div>');
  } else {
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text-faint);font-size:12px;">Impulse retracement: no qualifying move (≥1%) found in the recent window.</div>');
  }

  if(mldState.emaSignal){
    var es=mldState.emaSignal;
    var sideColor=es.side==='above'?MLD_GREEN:MLD_RED;
    var touchNote=es.touching
      ? 'Currently touching. First-touch reject rate in study: '+MLD_EMA_STUDY.firstTouchRejectLow+'-'+MLD_EMA_STUDY.firstTouchRejectHigh+'% (2nd touch: '+MLD_EMA_STUDY.secondTouchRejectLow+'-'+MLD_EMA_STUDY.secondTouchRejectHigh+'%). Recent touches (last 10 bars): '+es.recentTouchCount
      : 'Not currently touching (recent touches in last 10 bars: '+es.recentTouchCount+')';
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">EMA200 · 4H</div>'
      +'<div style="font-size:13px;">Price is <span style="color:'+sideColor+';font-weight:600;">'+es.side+'</span> EMA200, '+(es.distPct>0?'+':'')+es.distPct.toFixed(2)+'% away ($'+es.emaValue.toFixed(0)+')</div>'
      +'<div style="font-size:11px;color:var(--text-faint);margin-top:4px;">'+touchNote+'</div>'
      +'</div>');
  } else {
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text-faint);font-size:12px;">EMA200 4H: not enough history loaded yet.</div>');
  }

  if(mldState.clusterSignal){
    var cs=mldState.clusterSignal;
    var csColor=cs.side==='resistance'?MLD_RED:MLD_GREEN;
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Nearest liquidity cluster (estimated)</div>'
      +'<div style="font-size:13px;">$'+cs.price.toFixed(0)+' <span style="color:'+csColor+';font-weight:600;">'+cs.side+'</span>, '+(cs.distPct>0?'+':'')+cs.distPct.toFixed(2)+'% away, prominence '+cs.prominence+'/100</div>'
      +'</div>');
  }

  el.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;">'+cards.join('')+'</div>';

  mldRenderSynthesis();
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
    notes.push('price is sitting right at an estimated liquidity cluster ('+mldState.clusterSignal.side+')');
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
    mldState.clusterSignal=mldComputeClusterSignal(mldState.klines4h, mldState.price);
    mldRender();
    mldRenderHistory();
  }).catch(function(e){
    var el=document.getElementById('mldSignals');
    if(el) el.innerHTML='<div style="color:'+MLD_RED+';font-size:12px;">Failed to load (see console).</div>';
    console.error('mldRefresh',e);
  });
}

function mldInit(){
  mldRefresh();
  setInterval(mldRefresh, 5*60*1000);
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

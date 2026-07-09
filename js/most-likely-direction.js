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

var mldState={ price:null, klines1h:[], klines4h:[], impulse:null, emaSignal:null, clusterSignal:null,
  keyLevels:null, macroEvents:null, oiLevel:null };

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
  var cards=[];

  if(mldState.impulse){
    var im=mldState.impulse;
    var dirLabel=im.direction==='up'?'Pump':'Dump';
    var dirColor=im.direction==='up'?MLD_GREEN:MLD_RED;
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Impulse retracement</div>'
      +'<div style="font-size:13px;"><span style="color:'+dirColor+';font-weight:600;">'+dirLabel+'</span> of '+im.moveSizePct.toFixed(2)+'%, ~'+im.hoursAgo+'h ago. Retraced so far: <b>'+im.retracedPct.toFixed(0)+'%</b></div>'
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

  if(mldState.clusterSignal){
    var cs=mldState.clusterSignal;
    var csColor=cs.side==='resistance'?MLD_RED:MLD_GREEN;
    cards.push('<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;">Nearest liquidity cluster (estimated)</div>'
      +'<div style="font-size:13px;">$'+cs.price.toFixed(0)+' <span style="color:'+csColor+';font-weight:600;">'+cs.side+'</span>, '+(cs.distPct>0?'+':'')+cs.distPct.toFixed(2)+'% away, prominence '+cs.prominence+'/100</div>'
      +'</div>');
  }

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

  mldRenderSynthesis();
  mldRenderHeadline();
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
  setInterval(mldRefresh, 5*60*1000);
  mldSlowRefresh();
  setInterval(mldSlowRefresh, 30*60*1000);
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

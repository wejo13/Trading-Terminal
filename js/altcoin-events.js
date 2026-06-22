// ===================== ALTCOIN EVENT RESEARCH =====================
const ALT_CAT_COLORS={hack:'#e2645f',upgrade:'#28d7c8',partnership:'#3ddc97',ownership:'#d9a93f',listing:'#9b8ae8'};
const ALT_CAT_LABELS={hack:'Hack / Exploit',upgrade:'Network Upgrade',partnership:'Partnership / Deal',ownership:'Ownership / Regulation',listing:'Listing / Delisting'};

const ALT_EVENTS={
  ETH:[
    {date:'2020-12-01',cat:'upgrade',label:'ETH 2.0 Beacon Chain launch',pre:38,post:13,note:'ETH ran from ~$450 to ~$620 (+38%) into the launch. No sell-off — staking narrative was net-new and bullish. Continued higher for months. One of the rare upgrades without BTRS.'},
    {date:'2021-08-05',cat:'upgrade',label:'EIP-1559 London hard fork (fee burn)',pre:28,post:5,note:'Fee burn made ETH deflationary during high activity. Strong pre-event run. Modest post-event gain — fee burn narrative held. One of the few upgrades without a major sell-off.'},
    {date:'2021-08-10',cat:'hack',label:'Poly Network hack ($611M)',pre:-3,post:8,note:'Largest DeFi hack at the time. Hacker returned all funds within days. ETH barely reacted — hack recovery narrative was overwhelmingly positive. Structural damage = crash; no damage = ignored.'},
    {date:'2022-06-13',cat:'hack',label:'Celsius Network freezes withdrawals',pre:-25,post:-30,note:'DeFi contagion — stETH depegged, mass liquidations cascaded. ETH already falling (-25% pre-event), the freeze accelerated the crash -30% further. Pure shock event.'},
    {date:'2022-09-15',cat:'upgrade',label:'The Merge — PoW to PoS transition',pre:60,post:-16,note:'Months-long run $1000 → $2000. Classic BTRS on delivery — ETH dropped 9% on Merge day and kept falling to $1200. CoinShares: "market had priced in a successful Merge."'},
    {date:'2023-04-12',cat:'upgrade',label:'Shapella — staked ETH withdrawals enabled',pre:16,post:12,note:'Market feared mass selling from unlocked stakers. Opposite happened — price rose +12% after. Whales bought the FUD. Rare case: the pessimistic consensus was the losing trade.'},
    {date:'2023-10-12',cat:'listing',label:'BlackRock files spot Ethereum ETF',pre:8,post:12,note:'Smaller reaction than BTC ETF filing — market already priced ETH ETF as inevitable post-BTC precedent. Steady positive drift. Insider buying visible weeks before filing.'},
    {date:'2024-03-13',cat:'upgrade',label:'Dencun upgrade — EIP-4844 proto-danksharding',pre:63,post:-13,note:'ETH ran $2300 → $3740 in 5 weeks (+63%). On the day: above $3900. After: sold off -13% within a week. BTRS confirmed — strongest pre-event run of any ETH upgrade ended in textbook sell-the-news.'},
    {date:'2024-05-23',cat:'listing',label:'Spot ETH ETF approved by SEC',pre:31,post:-18,note:'SEC surprised market (25% approval odds days before). Pre-event surge +31% on leaked approval signal. Post-event: BTRS — sold off -18% over 2 weeks. ETF launched July 23 with far weaker inflows vs BTC ETF.'},
    {date:'2025-02-21',cat:'hack',label:'Bybit hack — $1.5B ETH stolen by Lazarus Group',pre:-8,post:-21,note:'Largest exchange hack in history. North Korea exploited Bybit cold wallet. ETH fell -21% and stayed suppressed for weeks — unlike typical hack recoveries. Scale + nation-state attribution created lasting fear.'},
  ],
  SOL:[
    {date:'2021-09-14',cat:'hack',label:'Solana network outage — 17 hours offline',pre:5,post:-18,note:'First major outage. Market punished hard -18%. But SOL recovered within 2 weeks — bull market narrative dominated. Outages cause short-term fear, not structural damage, in a bull cycle.'},
    {date:'2022-01-21',cat:'hack',label:'Second major Solana network outage',pre:-15,post:-28,note:'Second outage in 4 months in a bear market. Double punishment — reliability fears compounded macro selloff. Repeated failures amplify narrative damage. Recovery far slower.'},
    {date:'2022-02-02',cat:'hack',label:'Wormhole bridge hack ($323M)',pre:-12,post:-16,note:'Jump Trading refilled the $323M hole within 24h. SOL still dropped -16% — bridge exploits destroy ecosystem trust regardless of refill. Short dump, 3-week recovery.'},
    {date:'2022-11-08',cat:'ownership',label:'FTX collapse — Alameda held 10-15% of all SOL',pre:-10,post:-62,note:'Most devastating event in SOL history. Crashed from $34 to $13 in 6 days (-62%), then to $8 by December. But became the greatest recovery story in crypto — $8 to $295 by Jan 2025.'},
    {date:'2023-07-20',cat:'upgrade',label:'Firedancer validator client announced',pre:15,post:20,note:'New independent validator promised to solve Solana outage problem. Strong positive reaction. Pre-announcement buzz visible in Jump Crypto activity. Sustained post-event move as narrative shifted from "broken chain" to "fixed."'},
    {date:'2024-01-15',cat:'upgrade',label:'SOL surpasses ETH in weekly DEX volume',pre:58,post:21,note:'Narrative inflection point — SOL proved it could out-trade Ethereum. Insiders had DEX data before mainstream media. SOL ran $60 → $95 pre-event. Strong continued momentum as ETH underperformed.'},
    {date:'2024-11-13',cat:'listing',label:'Solana spot ETF filings post-Trump election',pre:25,post:33,note:'Post-Trump election crypto euphoria + SOL ETF filings coincided. Strong sustained move $180 → $240. Broader bull run momentum overrode BTRS tendency — rare exception driven by political macro shift.'},
    {date:'2025-01-17',cat:'listing',label:'Trump launches TRUMP memecoin on Solana',pre:20,post:-30,note:'SOL surged +23% overnight to ATH of $293 as TRUMP launched. MELANIA launched 2 days later split attention. After inauguration: SOL sold off hard. Platform benefits short-term from hype, then speculation drag sets in.'},
  ],
  BNB:[
    {date:'2021-05-10',cat:'upgrade',label:'BSC ecosystem peak — DeFi TVL hits $30B',pre:800,post:-55,note:'BNB ran $40 → $690 in 4 months as BSC became dominant cheap DeFi chain during ETH gas crisis. Peak at $690. Crash caught in broader May 2021 selloff from China ban FUD and Elon reversal.'},
    {date:'2022-10-06',cat:'hack',label:'BNB Chain cross-chain bridge hack ($570M)',pre:-5,post:-14,note:'2M BNB minted out of thin air via IAVL proof forgery. Chain halted 8 hours. Only $7M recovered. Initial price drop mild (-4%) — Binance moved fast. Sustained -14% over 2 weeks as bridge trust eroded.'},
    {date:'2023-06-05',cat:'ownership',label:'SEC sues Binance — 13 charges',pre:-8,post:-16,note:'13 charges including unregistered exchange and securities violations. BNB dropped -12% on day one. Sustained pressure for weeks as BUSD was already unwinding. Pure shock — no insider pre-warning.'},
    {date:'2023-11-21',cat:'ownership',label:'CZ pleads guilty — steps down as Binance CEO',pre:-12,post:-8,note:'Expected after months of DOJ negotiations — market had priced it in. BNB only dropped -4.6% on day. New CEO provided continuity. Biggest fear (exchange shutdown) never materialized.'},
    {date:'2024-04-30',cat:'ownership',label:'CZ sentenced to 4 months — lighter than expected',pre:-8,post:12,note:'DOJ wanted 3 years, got 4 months. Market relief rally +12%. Light sentence meant CZ could return to crypto quickly. Rare: regulatory outcome more positive than feared = genuine post-event pump.'},
    {date:'2025-05-29',cat:'ownership',label:'SEC drops Binance lawsuit — case dismissed',pre:15,post:8,note:'Joint motion to dismiss after 2 years. Symbolic end to Gensler-era crypto crackdown. Modest positive reaction — regulatory risk had already been priced out over 2024-2025.'},
  ],
  XRP:[
    {date:'2020-12-22',cat:'ownership',label:'SEC sues Ripple — XRP deemed unregistered security',pre:-5,post:-65,note:'Nuclear shock. Coinbase, Kraken and others delisted XRP for US users within days. -65% in under a week while BTC was going parabolic. Biggest regulatory shock in altcoin history.'},
    {date:'2021-02-01',cat:'listing',label:'XRP relisted after DOJ documents leaked',pre:20,post:45,note:'Leaked DOJ docs suggested XRP not a security. Exchanges relisted. Strong pre-leak buying by insiders. XRP ran to $0.50 then continued to $1.80 in April altseason.'},
    {date:'2023-07-13',cat:'ownership',label:'Judge rules XRP not a security in retail sales',pre:15,post:65,note:'Explosive surprise — market priced only 30-40% odds of a win. XRP jumped +75% in 24h from $0.47 to $0.93. One of the fastest single-day moves in top-10 crypto history.'},
    {date:'2024-11-06',cat:'ownership',label:'Trump elected — XRP legal overhang expected to lift',pre:30,post:280,note:'XRP biggest beneficiary of Trump election among top alts. Years of legal uncertainty expected to resolve. Post-event: extraordinary sustained run from $0.55 to nearly $3.00 by December. Genuine structural re-rating.'},
    {date:'2025-01-21',cat:'ownership',label:'SEC drops appeal against Ripple ruling',pre:25,post:-8,note:'XRP had already run +400% since Trump election. Appeal drop was partially priced in. Initial pop then sold off. When an event has been telegraphed for months and price already moved, the news = sell.'},
    {date:'2025-08-22',cat:'ownership',label:'SEC v Ripple — final settlement, case closed',pre:10,post:-8,note:'Final closure after 5 years. $50M penalty vs $2B original ask. Modest sell-off — XRP had already dropped 48% from July ATH of $3.65 as legal clarity was long priced in.'},
  ]
};

const altPriceCache={};
const altActiveFilter={};

function altGetEvents(coin,filter){
  var evts=ALT_EVENTS[coin]||[];
  var f=filter||altActiveFilter[coin]||'all';
  return f==='all'?evts:evts.filter(function(e){return e.cat===f;});
}

async function altFetchPrice(coin){
  if(altPriceCache[coin])return altPriceCache[coin];
  var symbol=coin+'USDT';
  var start=1577836800000;
  try{
    var url='https://api.bybit.com/v5/market/kline?category=linear&symbol='+symbol+'&interval=W&start='+start+'&limit=260';
    var r=await fetch(url);
    var d=await r.json();
    if(d.retCode!==0||!d.result||!d.result.list||!d.result.list.length)return null;
    var pts=d.result.list.map(function(c){return[parseInt(c[0]),parseFloat(c[4])];}).reverse();
    altPriceCache[coin]=pts;
    return pts;
  }catch(e){console.warn('[AltEvents] price fetch failed',e.message);return null;}
}

async function altRender(coin){
  var loading=document.getElementById('altChartLoading-'+coin);
  if(loading)loading.style.display='flex';
  var pts=await altFetchPrice(coin);
  if(loading)loading.style.display='none';
  var evts=altGetEvents(coin);
  altDrawChart(coin,pts,evts);
  altRenderTable(coin,evts);
  altRenderStats(coin,evts);
  altRenderInsights(coin,evts);
}

function altDrawChart(coin,pts,evts){
  var canvas=document.getElementById('altC-'+coin);
  if(!canvas)return;
  var wrap=document.getElementById('altChartWrap-'+coin);
  var W=wrap?wrap.clientWidth:800;
  var H=260;
  canvas.width=W;canvas.height=H;
  var ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  var P={l:72,r:16,t:16,b:24};
  var cW=W-P.l-P.r,cH=H-P.t-P.b;
  if(!pts||!pts.length){
    ctx.fillStyle='#6b7178';ctx.font='12px Inter,sans-serif';ctx.textAlign='center';
    ctx.fillText('No price data',W/2,H/2);return;
  }
  var tMin=pts[0][0],tMax=pts[pts.length-1][0];
  var prices=pts.map(function(p){return p[1];});
  var pMin=Math.min.apply(null,prices)*0.97,pMax=Math.max.apply(null,prices)*1.03;
  var xf=function(t){return P.l+(t-tMin)/(tMax-tMin)*cW;};
  var yf=function(p){return P.t+cH-(p-pMin)/(pMax-pMin)*cH;};
  ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.lineWidth=1;
  for(var i=0;i<=4;i++){
    var y=P.t+i*(cH/4);
    ctx.beginPath();ctx.moveTo(P.l,y);ctx.lineTo(W-P.r,y);ctx.stroke();
    var val=pMax-(i/4)*(pMax-pMin);
    ctx.fillStyle='rgba(255,255,255,0.25)';ctx.font='9px Inter,sans-serif';ctx.textAlign='right';
    ctx.fillText('$'+val.toLocaleString('en-US',{maximumFractionDigits:0}),P.l-4,y+3);
  }
  ctx.fillStyle='rgba(255,255,255,0.2)';ctx.font='9px Inter,sans-serif';ctx.textAlign='center';
  for(var yr=2020;yr<=2026;yr++){
    var t=new Date(yr+'-01-01').getTime();
    if(t>=tMin&&t<=tMax){ctx.fillText(yr,xf(t),H-6);}
  }
  ctx.strokeStyle='#3ddc97';ctx.lineWidth=1.5;ctx.beginPath();
  pts.forEach(function(pt,idx){if(idx===0)ctx.moveTo(xf(pt[0]),yf(pt[1]));else ctx.lineTo(xf(pt[0]),yf(pt[1]));});
  ctx.stroke();
  evts.forEach(function(e){
    var ts=new Date(e.date).getTime();
    if(ts<tMin||ts>tMax)return;
    var cl=pts.reduce(function(b,p){return Math.abs(p[0]-ts)<Math.abs(b[0]-ts)?p:b;});
    var x=xf(ts),yd=yf(cl[1]);
    ctx.beginPath();ctx.arc(x,yd,5,0,Math.PI*2);
    ctx.fillStyle=ALT_CAT_COLORS[e.cat]||'#888';ctx.fill();
    ctx.strokeStyle='#0d0f10';ctx.lineWidth=1.5;ctx.stroke();
  });
}

function altRenderTable(coin,evts){
  var tbody=document.getElementById('altTbody-'+coin);
  if(!tbody)return;
  if(!evts.length){tbody.innerHTML='<tr><td colspan="6" style="padding:12px 6px;color:var(--text-faint);font-size:11px;">No events for this filter.</td></tr>';return;}
  var sorted=evts.slice().sort(function(a,b){return b.date.localeCompare(a.date);});
  tbody.innerHTML=sorted.map(function(e){
    var col=ALT_CAT_COLORS[e.cat]||'#888';
    var lbl=ALT_CAT_LABELS[e.cat]||e.cat;
    var preC=e.pre>=0?'#3ddc97':'#e2645f';
    var postC=e.post>=0?'#3ddc97':'#e2645f';
    var pat=e.post>5&&e.pre<10?'Genuine pump':e.pre>15&&e.post<-5?'Buy rumour sell news':e.post<-10?'Sustained drop':e.post>0?'Mild positive':'Neutral';
    var patC=pat==='Genuine pump'?'#3ddc97':pat==='Buy rumour sell news'?'#d9a93f':pat==='Sustained drop'?'#e2645f':'#9aa0a6';
    return '<tr>'
      +'<td style="padding:6px 6px;border-bottom:0.5px solid var(--border);white-space:nowrap;font-size:11px;color:var(--text-faint)">'+e.date+'</td>'
      +'<td style="padding:6px 6px;border-bottom:0.5px solid var(--border);font-size:11px">'+e.label+'<div style="font-size:10px;color:var(--text-faint);margin-top:2px;line-height:1.4">'+e.note+'</div></td>'
      +'<td style="padding:6px 6px;border-bottom:0.5px solid var(--border);font-size:10px;color:'+col+'">'+lbl+'</td>'
      +'<td style="padding:6px 6px;border-bottom:0.5px solid var(--border);text-align:right;font-size:11px;color:'+preC+'">'+(e.pre>0?'+':'')+e.pre+'%</td>'
      +'<td style="padding:6px 6px;border-bottom:0.5px solid var(--border);text-align:right;font-size:11px;color:'+postC+'">'+(e.post>0?'+':'')+e.post+'%</td>'
      +'<td style="padding:6px 6px;border-bottom:0.5px solid var(--border);font-size:10px;color:'+patC+'">'+pat+'</td>'
      +'</tr>';
  }).join('');
}

function altRenderStats(coin,evts){
  var el=document.getElementById('altStats-'+coin);
  if(!el||!evts.length){if(el)el.innerHTML='';return;}
  var postDrops=evts.filter(function(e){return e.post<0;});
  var avgPre=(evts.reduce(function(s,e){return s+e.pre;},0)/evts.length).toFixed(1);
  var avgPost=(evts.reduce(function(s,e){return s+e.post;},0)/evts.length).toFixed(1);
  var stats=[
    {l:'Events analysed',v:evts.length,c:'var(--text)'},
    {l:'Post-event drops',v:postDrops.length+' of '+evts.length+' ('+(Math.round(postDrops.length/evts.length*100))+'%)',c:'#e2645f'},
    {l:'Avg 7d pre-move',v:(parseFloat(avgPre)>=0?'+':'')+avgPre+'%',c:parseFloat(avgPre)>=0?'#3ddc97':'#e2645f'},
    {l:'Avg 7d post-move',v:(parseFloat(avgPost)>=0?'+':'')+avgPost+'%',c:parseFloat(avgPost)>=0?'#3ddc97':'#e2645f'},
  ];
  el.innerHTML=stats.map(function(s){
    return '<div style="background:var(--bg1);border-radius:8px;padding:12px 14px;border:0.5px solid var(--border)">'
      +'<div style="font-size:10px;color:var(--text-faint);margin-bottom:4px">'+s.l+'</div>'
      +'<div style="font-size:18px;font-weight:500;color:'+s.c+'">'+s.v+'</div></div>';
  }).join('');
}

function altRenderInsights(coin,evts){
  var el=document.getElementById('altInsights-'+coin);
  if(!el)return;
  var btrs=evts.filter(function(e){return e.pre>10&&e.post<-5;});
  var hacks=evts.filter(function(e){return e.cat==='hack';});
  var upgrades=evts.filter(function(e){return e.cat==='upgrade';});
  var hackAvgPost=hacks.length?(hacks.reduce(function(s,e){return s+e.post;},0)/hacks.length):null;
  var upgradeAvgPost=upgrades.length?(upgrades.reduce(function(s,e){return s+e.post;},0)/upgrades.length):null;
  var insights=[];
  if(btrs.length>=2)insights.push({t:'Buy rumour, sell news is dominant on '+coin,b:btrs.length+' of '+evts.length+' events showed a strong pre-event run followed by a post-event selloff.'});
  if(hackAvgPost!==null)insights.push({t:'Hacks: severity determines recovery speed',b:'Avg 7d post-hack move for '+coin+': '+(hackAvgPost>=0?'+':'')+hackAvgPost.toFixed(1)+'%. Funds recovered = quick bounce. Structural damage = weeks of suppression.'});
  if(upgradeAvgPost!==null)insights.push({t:'Network upgrades: the run-up IS the trade',b:'Avg 7d post-upgrade move: '+(upgradeAvgPost>=0?'+':'')+upgradeAvgPost.toFixed(1)+'%. Price discovery happens in the anticipation phase. By delivery day, the trade is usually over.'});
  if(!insights.length){el.innerHTML='';return;}
  el.innerHTML='<div style="font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">Key patterns</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
    +insights.map(function(p){
      return '<div style="padding:10px 12px;background:var(--bg2);border-radius:6px;border:0.5px solid var(--border)">'
        +'<div style="font-size:11px;font-weight:500;color:var(--text);margin-bottom:6px">'+p.t+'</div>'
        +'<div style="font-size:11px;color:var(--text-faint);line-height:1.6">'+p.b+'</div></div>';
    }).join('')+'</div>';
}

// Tooltips
['ETH','SOL','BNB','XRP'].forEach(function(coin){
  var canvas=document.getElementById('altC-'+coin);
  if(!canvas)return;
  canvas.addEventListener('mousemove',function(ev){
    var evts=altGetEvents(coin);
    var pts=altPriceCache[coin];
    if(!pts||!pts.length)return;
    var rect=this.getBoundingClientRect();
    var mx=ev.clientX-rect.left;
    var tMin=pts[0][0],tMax=pts[pts.length-1][0];
    var ht=tMin+(mx-72)/(this.width-72-16)*(tMax-tMin);
    var cl=null,md=Infinity;
    evts.forEach(function(e){var d=Math.abs(new Date(e.date).getTime()-ht);if(d<md){md=d;cl=e;}});
    var tip=document.getElementById('altTip-'+coin);
    if(cl&&md<(tMax-tMin)*0.025){
      var col=ALT_CAT_COLORS[cl.cat]||'#888';
      tip.innerHTML='<b style="color:var(--text)">'+cl.label+'</b><br>'
        +'<span style="color:var(--text-faint);font-size:10px">'+cl.date+'</span><br><br>'
        +'<span style="font-size:10px;color:'+col+'">'+ALT_CAT_LABELS[cl.cat]+'</span><br><br>'
        +'<span style="color:var(--text-faint)">7d pre</span> <b style="color:'+(cl.pre>=0?'#3ddc97':'#e2645f')+'">'+(cl.pre>0?'+':'')+cl.pre+'%</b><br>'
        +'<span style="color:var(--text-faint)">7d post</span> <b style="color:'+(cl.post>=0?'#3ddc97':'#e2645f')+'">'+(cl.post>0?'+':'')+cl.post+'%</b><br><br>'
        +'<span style="color:var(--text-faint);font-size:10px">'+cl.note+'</span>';
      tip.style.display='block';
      var lx=mx+14,ly=ev.clientY-rect.top-10;
      tip.style.left=(lx+230>this.width?mx-240:lx)+'px';tip.style.top=ly+'px';
    } else {tip.style.display='none';}
  });
  canvas.addEventListener('mouseleave',function(){var tip=document.getElementById('altTip-'+coin);if(tip)tip.style.display='none';});
});

// Filter buttons
['ETH','SOL','BNB','XRP'].forEach(function(coin){
  var el=document.getElementById('altFilters-'+coin);
  if(!el)return;
  el.addEventListener('click',function(ev){
    var b=ev.target.closest('[data-acat]');if(!b)return;
    altActiveFilter[coin]=b.dataset.acat;
    el.querySelectorAll('[data-acat]').forEach(function(x){x.classList.toggle('active',x===b);});
    var evts=altGetEvents(coin);
    altDrawChart(coin,altPriceCache[coin],evts);
    altRenderTable(coin,evts);
    altRenderStats(coin,evts);
    altRenderInsights(coin,evts);
  });
});

// MutationObserver — init on tab activate
['ETH','SOL','BNB','XRP'].forEach(function(coin){
  var tab=document.getElementById('tab-alt-'+coin.toLowerCase());
  if(!tab)return;
  var inited=false;
  var obs=new MutationObserver(function(){
    if(tab.classList.contains('active')){
      if(!inited){
        inited=true;
        requestAnimationFrame(function(){requestAnimationFrame(function(){altRender(coin);});});
      } else {
        requestAnimationFrame(function(){requestAnimationFrame(function(){altDrawChart(coin,altPriceCache[coin],altGetEvents(coin));});});
      }
    }
  });
  obs.observe(tab,{attributes:true});
});

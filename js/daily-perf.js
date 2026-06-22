// ===================== DAILY PERFORMANCE (DAY-OF-WEEK SEASONALITY) =====================
var DP_DAY_ORDER=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
var DP_GREEN='#3ddc97', DP_RED='#e2645f', DP_FAINT='#6b7178';

function dpFmtPct(v){return (v>0?'+':'')+v.toFixed(2)+'%';}
function dpColorFor(v){return v>=0?DP_GREEN:DP_RED;}

// ── HEADER VERDICT ───────────────────────────────────────────────────────
function dpRenderVerdict(){
  var rl=document.getElementById('dpRangeLabel');
  if(rl) rl.textContent=DP_META.start+' to '+DP_META.end+' ('+DP_META.n_total+' daily candles)';
  var v=document.getElementById('dpVerdict');
  if(v) v.innerHTML='Verdict: weekend-pump / Mon-Tue-dump is <span style="color:'+DP_RED+'">not supported</span> in this data — see breakdown below.';
}

// ── STAT CARDS (one per weekday) ─────────────────────────────────────────
function dpRenderStatCards(){
  var el=document.getElementById('dpStatCards');
  if(!el)return;
  el.innerHTML=DP_OVERALL.map(function(o){
    var c=dpColorFor(o.avg);
    return '<div style="background:var(--bg1);border:0.5px solid var(--border);border-radius:8px;padding:10px 8px;text-align:center;">'
      +'<div style="font-size:11px;color:var(--text-faint);font-weight:600;margin-bottom:6px;">'+o.day+'</div>'
      +'<div style="font-size:15px;font-weight:700;color:'+c+';">'+dpFmtPct(o.avg)+'</div>'
      +'<div style="font-size:10px;color:var(--text-faint);margin-top:3px;">win '+o.win+'%</div>'
      +'</div>';
  }).join('');
}

// ── BAR CHART: avg return per weekday ────────────────────────────────────
function dpDrawBar(){
  var wrap=document.getElementById('dpBarWrap');
  var c=document.getElementById('dpBarC');
  if(!wrap||!c)return;
  var W=wrap.clientWidth;
  if(!W||W<50)return;
  var H=220;
  c.width=W;c.height=H;c.style.height=H+'px';
  var ctx=c.getContext('2d');
  var P={l:50,r:16,t:16,b:28};
  var cW=W-P.l-P.r, cH=H-P.t-P.b;
  ctx.fillStyle='#0d0f10';ctx.fillRect(0,0,W,H);

  var maxAbs=Math.max.apply(null,DP_OVERALL.map(function(o){return Math.abs(o.avg);}))*1.25;
  var zeroY=P.t+cH/2;

  // zero line + gridlines
  [-1,-0.5,0,0.5,1].forEach(function(frac){
    var val=maxAbs*frac;
    var y=zeroY-(val/maxAbs)*(cH/2);
    ctx.strokeStyle=frac===0?'rgba(255,255,255,0.18)':'rgba(255,255,255,0.06)';
    ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(P.l,y);ctx.lineTo(P.l+cW,y);ctx.stroke();
    ctx.fillStyle='#555';ctx.font='10px Inter,sans-serif';ctx.textAlign='right';
    ctx.fillText(val.toFixed(2)+'%',P.l-6,y+3);
  });

  var slotW=cW/DP_OVERALL.length;
  var barW=slotW*0.5;
  DP_OVERALL.forEach(function(o,i){
    var xc=P.l+slotW*i+slotW/2;
    var barH=(Math.abs(o.avg)/maxAbs)*(cH/2);
    var y=o.avg>=0?zeroY-barH:zeroY;
    ctx.fillStyle=dpColorFor(o.avg);
    ctx.fillRect(xc-barW/2,y,barW,barH);
    ctx.fillStyle='var(--text-dim)';ctx.font='11px Inter,sans-serif';ctx.textAlign='center';
    ctx.fillText(o.day,xc,P.t+cH+18);
    // value label above/below bar
    ctx.fillStyle=dpColorFor(o.avg);ctx.font='10px Inter,sans-serif';
    var labelY=o.avg>=0?y-6:y+barH+14;
    ctx.fillText(dpFmtPct(o.avg),xc,labelY);
  });
}

// ── STATS TABLE ───────────────────────────────────────────────────────────
function dpRenderStatsTable(){
  var tbody=document.getElementById('dpStatsTbody');
  if(!tbody)return;
  tbody.innerHTML=DP_OVERALL.map(function(o){
    var sig=Math.abs(o.t)>=1.96;
    return '<tr>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);font-weight:500;">'+o.day+'</td>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;color:'+dpColorFor(o.avg)+'">'+dpFmtPct(o.avg)+'</td>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;color:'+dpColorFor(o.median)+'">'+dpFmtPct(o.median)+'</td>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;">'+o.win+'%</td>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;color:var(--text-faint);">'+o.std.toFixed(2)+'</td>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;'+(sig?'color:var(--teal);font-weight:600;':'color:var(--text-faint);')+'">'+o.t.toFixed(2)+'</td>'
      +'<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;color:var(--text-faint);">'+o.n+'</td>'
      +'</tr>';
  }).join('');
}

// ── YEAR-BY-YEAR TABLE ────────────────────────────────────────────────────
function dpRenderYearTable(){
  var tbody=document.getElementById('dpYearTbody');
  if(!tbody)return;
  var years=Object.keys(DP_BY_YEAR).sort();
  tbody.innerHTML=years.map(function(y){
    var row=DP_BY_YEAR[y];
    var cells=DP_DAY_ORDER.map(function(d){
      var v=row[d];
      if(v===undefined) return '<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;color:var(--text-faint);">—</td>';
      return '<td style="padding:6px 8px;border-bottom:0.5px solid var(--border);text-align:right;color:'+dpColorFor(v)+'">'+dpFmtPct(v)+'</td>';
    }).join('');
    return '<tr><td style="padding:6px 8px;border-bottom:0.5px solid var(--border);font-weight:500;">'+y+'</td>'+cells+'</tr>';
  }).join('');
}

function dpInit(){
  dpRenderVerdict();
  dpRenderStatCards();
  dpDrawBar();
  dpRenderStatsTable();
  dpRenderYearTable();
}

// ── MUTATION OBSERVER — draw as soon as tab becomes visible ───────────────
(function(){
  var tab=document.getElementById('tab-sea-daily');
  if(!tab)return;
  var drawn=false;
  function tryDraw(){
    if(drawn)return;
    var wrap=document.getElementById('dpBarWrap');
    if(wrap&&wrap.clientWidth>50){
      drawn=true;
      dpInit();
    }
  }
  var obs=new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      if(m.type==='attributes'&&m.attributeName==='class'){
        if(tab.classList.contains('active')){
          drawn=false;
          requestAnimationFrame(function(){requestAnimationFrame(tryDraw);});
        }
      }
    });
  });
  obs.observe(tab,{attributes:true});
  window.addEventListener('resize',function(){if(tab.classList.contains('active')){dpDrawBar();}});
})();

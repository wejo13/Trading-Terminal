// ===================== BYBIT LIFETIME P&L =====================
const BB_LIFETIME_KEY = 'ema_watch_bb_lifetime_v1';

function bbLifetimeLoad(){
  try{ const r=localStorage.getItem(BB_LIFETIME_KEY); return r?JSON.parse(r):{totalPnl:0,trades:[]}; }
  catch(e){ return {totalPnl:0,trades:[]}; }
}
function bbLifetimeSave(data){
  try{ localStorage.setItem(BB_LIFETIME_KEY,JSON.stringify(data)); }catch(e){}
}

function bbPlayTradeSound(success){
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    if(success){
      // clean two-tone chime: low then high
      [[440,0,0.12],[660,0.13,0.18]].forEach(([freq,start,end])=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.connect(g);g.connect(ctx.destination);
        o.type='sine';o.frequency.value=freq;
        g.gain.setValueAtTime(0,ctx.currentTime+start);
        g.gain.linearRampToValueAtTime(0.18,ctx.currentTime+start+0.02);
        g.gain.linearRampToValueAtTime(0,ctx.currentTime+end);
        o.start(ctx.currentTime+start);o.stop(ctx.currentTime+end+0.05);
      });
    } else {
      // low descending tone for a loss
      [[300,0,0.2],[220,0.22,0.38]].forEach(([freq,start,end])=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.connect(g);g.connect(ctx.destination);
        o.type='sine';o.frequency.value=freq;
        g.gain.setValueAtTime(0,ctx.currentTime+start);
        g.gain.linearRampToValueAtTime(0.15,ctx.currentTime+start+0.02);
        g.gain.linearRampToValueAtTime(0,ctx.currentTime+end);
        o.start(ctx.currentTime+start);o.stop(ctx.currentTime+end+0.05);
      });
    }
  }catch(e){}
}

function bbLifetimeAddTrade(netPnl){
  const data=bbLifetimeLoad();
  data.totalPnl=(data.totalPnl||0)+netPnl;
  data.trades.push({ts:Date.now(),pnl:netPnl,cumulative:data.totalPnl});
  bbLifetimeSave(data);
  bbRenderLifetime();
  bbPlayTradeSound(netPnl>=0);
  // Telegram notification
  if(typeof sendTelegramMessage === 'function'){
    const sign=netPnl>=0?'✅':'❌';
    const sessionPnl=bbState?bbState.pnl||0:0;
    const msg=`${sign} Grid Bot · Bybit — Round trip complete\n`
      +`Trade P&L: ${netPnl>=0?'+':''}$${netPnl.toFixed(4)}\n`
      +`Session P&L: ${sessionPnl>=0?'+':''}$${sessionPnl.toFixed(2)}\n`
      +`Lifetime P&L: ${data.totalPnl>=0?'+':''}$${data.totalPnl.toFixed(2)}\n`
      +`Total trades: ${data.trades.length}`;
    sendTelegramMessage(msg).catch(()=>{});
  }
}

function bbResetLifetime(){
  if(!confirm('Reset lifetime P&L history? This cannot be undone.'))return;
  bbLifetimeSave({totalPnl:0,trades:[]});
  bbRenderLifetime();
}

function bbRenderLifetime(){
  const data=bbLifetimeLoad();
  const total=data.totalPnl||0;
  const trades=data.trades||[];

  // header total
  const hEl=document.getElementById('bb-lifetime-total');
  if(hEl){ hEl.textContent=(total>=0?'+':'')+'$'+total.toFixed(2); hEl.style.color=total>=0?'var(--green)':'var(--red)'; }

  // stat in live stats panel
  const sEl=document.getElementById('bbstat-lifetime-pnl');
  if(sEl){ sEl.textContent=(total>=0?'+':'')+'$'+total.toFixed(2); sEl.className='grid-stat-val '+(total>=0?'up':'down'); }

  // trade count
  const tEl=document.getElementById('bb-lifetime-trades');
  if(tEl) tEl.textContent=trades.length+' round trip'+(trades.length===1?'':'s');

  // chart
  const canvas=document.getElementById('bb-pnl-chart');
  const empty=document.getElementById('bb-pnl-chart-empty');
  if(!canvas)return;

  if(trades.length<2){
    canvas.style.display='none';
    if(empty)empty.style.display='flex';
    return;
  }
  canvas.style.display='block';
  if(empty)empty.style.display='none';

  const W=canvas.parentElement.clientWidth||500;
  const H=120;
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);

  const vals=trades.map(t=>t.cumulative);
  const minV=Math.min(0,...vals), maxV=Math.max(0,...vals);
  const range=maxV-minV||1;
  const padL=8,padR=8,padT=10,padB=10;
  const chartW=W-padL-padR, chartH=H-padT-padB;

  const xOf=i=>padL+i*(chartW/(trades.length-1));
  const yOf=v=>padT+chartH-((v-minV)/range)*chartH;

  // zero line
  const zeroY=yOf(0);
  ctx.beginPath();
  ctx.strokeStyle='rgba(255,255,255,0.08)';
  ctx.lineWidth=1;
  ctx.moveTo(padL,zeroY);
  ctx.lineTo(W-padR,zeroY);
  ctx.stroke();

  // fill under/over line
  ctx.beginPath();
  ctx.moveTo(xOf(0),yOf(vals[0]));
  for(let i=1;i<vals.length;i++) ctx.lineTo(xOf(i),yOf(vals[i]));
  ctx.lineTo(xOf(vals.length-1),zeroY);
  ctx.lineTo(xOf(0),zeroY);
  ctx.closePath();
  const grad=ctx.createLinearGradient(0,padT,0,H-padB);
  if(total>=0){
    grad.addColorStop(0,'rgba(61,220,151,0.25)');
    grad.addColorStop(1,'rgba(61,220,151,0.02)');
  } else {
    grad.addColorStop(0,'rgba(226,100,95,0.02)');
    grad.addColorStop(1,'rgba(226,100,95,0.25)');
  }
  ctx.fillStyle=grad;
  ctx.fill();

  // line
  ctx.beginPath();
  ctx.strokeStyle=total>=0?'#3ddc97':'#e2645f';
  ctx.lineWidth=1.5;
  ctx.moveTo(xOf(0),yOf(vals[0]));
  for(let i=1;i<vals.length;i++) ctx.lineTo(xOf(i),yOf(vals[i]));
  ctx.stroke();

  // last value dot
  const lx=xOf(vals.length-1), ly=yOf(vals[vals.length-1]);
  ctx.beginPath();
  ctx.arc(lx,ly,3,0,Math.PI*2);
  ctx.fillStyle=total>=0?'#3ddc97':'#e2645f';
  ctx.fill();

  // last value label
  ctx.fillStyle=total>=0?'#3ddc97':'#e2645f';
  ctx.font='bold 10px Inter,sans-serif';
  ctx.textAlign='right';
  ctx.fillText((total>=0?'+':'')+'$'+total.toFixed(2),W-padR-6,ly+(total>=0?-5:12));
}

// Patch bbHandleFill to call bbLifetimeAddTrade on round trip completion
const _bbHandleFillOrig = bbHandleFill;
bbHandleFill = async function(ex){
  const prevPnl = bbState ? (bbState.pnl||0) : 0;
  await _bbHandleFillOrig(ex);
  const newPnl = bbState ? (bbState.pnl||0) : 0;
  const diff = newPnl - prevPnl;
  if(diff !== 0) bbLifetimeAddTrade(diff);
};

// Init on load
bbRenderLifetime();

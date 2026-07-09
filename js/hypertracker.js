(function(){
  'use strict';

  const traders = [
    {
      address:'0x9e8b1e51c642f4c8b87c6ba11c53d516a218afc4',
      observedPnl:1319474.46, medianHold:38763.484, winRate:.3902439,
      profitFactor:1.278445, episodes:41, coverage:.936,
      monthPnl:4784554.64, accountValue:10245634.53, basis:'Monthly PnL'
    },
    {
      address:'0xb981a0c739dddb86a40c576aa1fd75f491184e0e',
      observedPnl:80518.27, medianHold:8996.752, winRate:.6233766,
      profitFactor:1.26516, episodes:77, coverage:.9916898,
      monthPnl:128341.97, accountValue:140516.40, basis:'Monthly ROI'
    },
    {
      address:'0x42b9594f12bddd170416e94c42e4cb5e42965f39',
      observedPnl:44636.62, medianHold:44418.042, winRate:.4833333,
      profitFactor:1.454406, episodes:120, coverage:.9970824,
      monthPnl:130380.72, accountValue:108833.23, basis:'Monthly ROI'
    },
    {
      address:'0xc38a25f2bcccb803b96ef9102bd94f6dc74725bc',
      observedPnl:35489.11, medianHold:5807.676, winRate:.6923077,
      profitFactor:1.89393, episodes:65, coverage:.9983165,
      monthPnl:18623.30, accountValue:21568.49, basis:'Monthly ROI'
    },
    {
      address:'0xb1039883265d21395850d6d9bc4d7d141cc41343',
      observedPnl:33775.44, medianHold:201.937, winRate:.6382979,
      profitFactor:5.532284, episodes:94, coverage:.9905,
      monthPnl:17223.76, accountValue:22395.78, basis:'Monthly ROI'
    },
    {
      address:'0xfae1d8c606a26071a01b59f3f02e157083114b90',
      observedPnl:28710.27, medianHold:18713.019, winRate:.4666667,
      profitFactor:1.340001, episodes:30, coverage:.8646617,
      monthPnl:79629.04, accountValue:84496.30, basis:'Monthly ROI'
    },
    {
      address:'0x9f7493b0e5d278de8ef65673285d24b17bcd5170',
      observedPnl:12217.37, medianHold:72.009, winRate:.5116751,
      profitFactor:1.23963, episodes:985, coverage:1,
      monthPnl:18919.36, accountValue:2892.84, basis:'Monthly ROI'
    },
    {
      address:'0xd8155b44c1487f7533279b27c6758931f5a91743',
      observedPnl:10683.69, medianHold:894.257, winRate:.5708155,
      profitFactor:1.338779, episodes:233, coverage:.8655,
      monthPnl:1854.25, accountValue:30768.83, basis:'Monthly ROI'
    }
  ];

  const state={sort:'observedPnl',query:'',selected:null};
  const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const number=new Intl.NumberFormat('en-US',{maximumFractionDigits:1});

  function shortAddress(address){return address.slice(0,6)+'…'+address.slice(-4);}
  function explorerUrl(address){return 'https://hypurrscan.io/address/'+address;}
  function pct(value){return Math.max(0,Math.min(100,value*100));}
  function holdLabel(seconds){
    if(seconds<60)return Math.round(seconds)+' sec';
    if(seconds<3600)return number.format(seconds/60)+' min';
    if(seconds<86400)return number.format(seconds/3600)+' hr';
    return number.format(seconds/86400)+' days';
  }
  function sortRows(rows){
    return rows.sort((a,b)=>{
      if(state.sort==='medianHold')return a.medianHold-b.medianHold;
      return b[state.sort]-a[state.sort];
    });
  }
  function visibleRows(){
    const q=state.query.toLowerCase();
    return sortRows(traders.filter(t=>!q||t.address.includes(q)));
  }
  function detailTemplate(t){
    const twoDays=172800;
    const holdWidth=Math.max(2,Math.min(100,t.medianHold/twoDays*100));
    return `
      <div class="ht-detail-top">
        <div class="ht-detail-wallet">
          <span>Selected wallet</span>
          <strong title="${t.address}">${shortAddress(t.address)}</strong>
        </div>
        <span class="ht-badge">Confirmed</span>
      </div>
      <a class="ht-open-wallet" href="${explorerUrl(t.address)}" target="_blank" rel="noopener noreferrer">
        <i class="ti ti-external-link"></i>Open wallet on HypurrScan
      </a>
      <div class="ht-pnl-block">
        <span>Net PnL · completed episodes</span>
        <strong>+${money.format(t.observedPnl)}</strong>
        <small>${t.episodes} reconstructed position episodes</small>
      </div>
      <div class="ht-stat-pairs">
        <div class="ht-stat-pair"><span>Median hold</span><strong>${holdLabel(t.medianHold)}</strong></div>
        <div class="ht-stat-pair"><span>Win rate</span><strong>${number.format(t.winRate*100)}%</strong></div>
        <div class="ht-stat-pair"><span>Profit factor</span><strong>${number.format(t.profitFactor)}</strong></div>
        <div class="ht-stat-pair"><span>Fill coverage</span><strong>${number.format(pct(t.coverage))}%</strong></div>
        <div class="ht-stat-pair"><span>Monthly PnL</span><strong>${money.format(t.monthPnl)}</strong></div>
        <div class="ht-stat-pair"><span>Account value</span><strong>${money.format(t.accountValue)}</strong></div>
      </div>
      <div class="ht-hold-profile">
        <div class="ht-hold-profile-head"><span>Median hold vs 2-day ceiling</span><strong>${number.format(holdWidth)}%</strong></div>
        <div class="ht-hold-track"><i style="width:${holdWidth}%"></i></div>
        <div class="ht-hold-labels"><span>0</span><span>2 days</span></div>
      </div>`;
  }
  function renderDetail(address){
    const trader=traders.find(t=>t.address===address);
    if(!trader)return;
    state.selected=trader.address;
    const detail=document.getElementById('htDetail');
    if(detail)detail.innerHTML=detailTemplate(trader);
    document.querySelectorAll('#htTraderRows tr').forEach(row=>{
      row.classList.toggle('active',row.dataset.address===trader.address);
    });
  }
  function renderRows(){
    const tbody=document.getElementById('htTraderRows');
    if(!tbody)return;
    const rows=visibleRows();
    tbody.innerHTML=rows.map((t,index)=>`
      <tr data-address="${t.address}" tabindex="0" aria-label="Inspect ${t.address}">
        <td>
          <div class="ht-rank-wallet">
            <span class="ht-rank">${index+1}</span>
            <div>
              <a class="ht-wallet-link" href="${explorerUrl(t.address)}" target="_blank" rel="noopener noreferrer" title="Open ${t.address} on HypurrScan">
                <span class="ht-address">${shortAddress(t.address)}</span><i class="ti ti-external-link"></i>
              </a>
              <span class="ht-basis">Candidate: ${t.basis}</span>
            </div>
          </div>
        </td>
        <td class="ht-positive">+${money.format(t.observedPnl)}</td>
        <td class="ht-hold">${holdLabel(t.medianHold)}</td>
        <td>${number.format(t.winRate*100)}%</td>
        <td>${number.format(t.profitFactor)}</td>
        <td>${t.episodes}</td>
        <td><span class="ht-coverage"><span class="ht-coverage-bar"><i style="width:${pct(t.coverage)}%"></i></span>${number.format(pct(t.coverage))}%</span></td>
      </tr>`).join('');
    document.getElementById('htEmpty').style.display=rows.length?'none':'block';
    const resultCount=document.getElementById('htResultCount');
    if(resultCount)resultCount.textContent=rows.length+' '+(rows.length===1?'wallet':'wallets')+' shown';
    tbody.querySelectorAll('.ht-wallet-link').forEach(link=>{
      link.addEventListener('click',event=>event.stopPropagation());
    });
    tbody.querySelectorAll('tr').forEach(row=>{
      row.addEventListener('click',()=>renderDetail(row.dataset.address));
      row.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){event.preventDefault();renderDetail(row.dataset.address);}
      });
    });
    const preferred=rows.find(row=>row.address===state.selected)||rows[0];
    if(preferred)renderDetail(preferred.address);
  }
  function init(){
    const search=document.getElementById('htSearch');
    const sort=document.getElementById('htSort');
    if(!search||!sort)return;
    search.addEventListener('input',event=>{state.query=event.target.value.trim();renderRows();});
    sort.addEventListener('change',event=>{state.sort=event.target.value;renderRows();});
    renderRows();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();

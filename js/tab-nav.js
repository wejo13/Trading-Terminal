// Single source of truth for which tab is showing. Each tab's content lives in
// its own .tab-view div in the DOM at all times (not lazily injected) - this
// keeps the shell simple for now; if any tab's content becomes heavy enough
// that mounting it upfront is wasteful, that's a later optimization, not a
// concern at this stage.
function switchTab(tabName, opts){
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  document.querySelectorAll('.nav-sub-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  let matched = false;
  document.querySelectorAll('.tab-view').forEach(el => {
    const isMatch = el.id === 'tab-' + tabName;
    el.classList.toggle('active', isMatch);
    if(isMatch) { document.getElementById('mainTitle').textContent = el.dataset.title; matched = true; }
  });
  // Reflect the current tab in the URL hash so any tab can be bookmarked or
  // shared directly (e.g. #oix opens straight to the OI Backtester tab) —
  // replaceState rather than a hash assignment so clicking around the app
  // doesn't spam the browser back-button history with one entry per tab.
  if (matched && !(opts && opts.skipHash)) {
    history.replaceState(null, '', '#' + tabName);
  }
}

// Deep-link support: on load (and on back/forward navigation), open
// whichever tab is named in the URL hash, if it exists — otherwise leave
// whatever tab is marked active by default in the HTML (Dashboard).
function openTabFromHash(){
  const tabName = location.hash.replace(/^#/, '');
  if (tabName && document.getElementById('tab-' + tabName)) {
    switchTab(tabName, { skipHash: true });
  }
}
document.addEventListener('DOMContentLoaded', openTabFromHash);
window.addEventListener('hashchange', openTabFromHash);

let balancesHidden = false;
function toggleBalanceVisibility(){
  balancesHidden = !balancesHidden;
  document.getElementById('balanceGrid').classList.toggle('balances-hidden', balancesHidden);
  document.getElementById('hideBalanceIcon').className = balancesHidden ? 'ti ti-eye-off' : 'ti ti-eye';
  document.getElementById('hideBalanceLabel').textContent = balancesHidden ? 'show balances' : 'hide balances';
}

// fills the exec-size field and highlights the active pill
function setExecSize(amount){
  const input = document.getElementById('jf-notional');
  if(input) input.value = amount;
  document.querySelectorAll('.size-pill').forEach(p => {
    p.classList.toggle('active', parseInt(p.textContent.replace(/\D/g,'')) * (p.textContent.includes('K') ? 1000 : 1) === amount);
  });
}

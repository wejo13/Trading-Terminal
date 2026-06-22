// Single source of truth for which tab is showing. Each tab's content lives in
// its own .tab-view div in the DOM at all times (not lazily injected) - this
// keeps the shell simple for now; if any tab's content becomes heavy enough
// that mounting it upfront is wasteful, that's a later optimization, not a
// concern at this stage.
function switchTab(tabName){
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  document.querySelectorAll('.nav-sub-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-view').forEach(el => {
    const isMatch = el.id === 'tab-' + tabName;
    el.classList.toggle('active', isMatch);
    if(isMatch) document.getElementById('mainTitle').textContent = el.dataset.title;
  });
}

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

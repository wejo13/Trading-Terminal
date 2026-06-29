// sp500.test.js — S&P 500 Watchlist focused tests
'use strict';

const SP500Engine  = require('./sp500-engine.js');
const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
const fs = require('fs');
const renderSrc = fs.readFileSync(__dirname + '/sp500-render.js', 'utf8');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

// ── SECTION: fixture is all demo ──────────────────────────────────────────────

section('Fixture: all data is clearly marked DEMO');
(function () {
  assert('SP500_VALUATION._demo is true',   SP500_VALUATION._demo === true);
  assert('watchlist has entries',            SP500_WATCHLIST.length > 0);
  assert('watchlist has 12+ entries',       SP500_WATCHLIST.length >= 12);
  const tickers = SP500_WATCHLIST.map(r => r.ticker);
  assert('SPY present',  tickers.includes('SPY'));
  assert('NVDA present', tickers.includes('NVDA'));
  assert('AMD present',  tickers.includes('AMD'));
})();

// ── SECTION: classifyValuationCaution ────────────────────────────────────────

section('classifyValuationCaution: Normal below 70th percentile');
(function () {
  assert('50th → Normal', SP500Engine.classifyValuationCaution(50) === 'Normal');
  assert('69th → Normal', SP500Engine.classifyValuationCaution(69) === 'Normal');
  assert('0th  → Normal', SP500Engine.classifyValuationCaution(0)  === 'Normal');
})();

section('classifyValuationCaution: Elevated 70–84th percentile');
(function () {
  assert('70th  → Elevated', SP500Engine.classifyValuationCaution(70)  === 'Elevated');
  assert('84th  → Elevated', SP500Engine.classifyValuationCaution(84)  === 'Elevated');
})();

section('classifyValuationCaution: Extreme at 85th percentile and above');
(function () {
  assert('85th  → Extreme',  SP500Engine.classifyValuationCaution(85)  === 'Extreme');
  assert('88th  → Extreme',  SP500Engine.classifyValuationCaution(88)  === 'Extreme');
  assert('100th → Extreme',  SP500Engine.classifyValuationCaution(100) === 'Extreme');
})();

section('classifyValuationCaution: handles missing/invalid input gracefully');
(function () {
  assert('null   → Normal', SP500Engine.classifyValuationCaution(null)      === 'Normal');
  assert('NaN    → Normal', SP500Engine.classifyValuationCaution(NaN)       === 'Normal');
  assert('string → Normal', SP500Engine.classifyValuationCaution('bad')     === 'Normal');
  assert('undef  → Normal', SP500Engine.classifyValuationCaution(undefined) === 'Normal');
})();

section('Demo fixture CAPE percentile 88 → Extreme');
(function () {
  const caution = SP500Engine.classifyValuationCaution(SP500_VALUATION.capePercentile);
  assert('fixture capePercentile 88 → Extreme', caution === 'Extreme');
})();

// ── SECTION: classifyWatchlistStatus ─────────────────────────────────────────

section('classifyWatchlistStatus: Bullish — above both MAs, not extended');
(function () {
  const r = SP500Engine.classifyWatchlistStatus({ above20d: true, above200d: true, extended: false });
  assert('status is Bullish', r.status === 'Bullish');
  assert('note_auto non-empty', r.note_auto.length > 0);
})();

section('classifyWatchlistStatus: Neutral — above 200D but below 20D');
(function () {
  const r = SP500Engine.classifyWatchlistStatus({ above20d: false, above200d: true });
  assert('status is Neutral', r.status === 'Neutral');
})();

section('classifyWatchlistStatus: Extended — above both MAs, extended=true');
(function () {
  const r = SP500Engine.classifyWatchlistStatus({ above20d: true, above200d: true, extended: true });
  assert('status is Extended', r.status === 'Extended');
  assert('reason mentions pullback or profit', r.note_auto.toLowerCase().includes('pullback') || r.note_auto.toLowerCase().includes('profit'));
  assert('no Short language', !r.note_auto.toLowerCase().includes('short'));
})();

section('classifyWatchlistStatus: Weakening — below 200D');
(function () {
  const r1 = SP500Engine.classifyWatchlistStatus({ above20d: false, above200d: false });
  const r2 = SP500Engine.classifyWatchlistStatus({ above20d: true,  above200d: false });
  assert('below both → Weakening',  r1.status === 'Weakening');
  assert('above 20D only → Weakening', r2.status === 'Weakening');
})();

section('classifyWatchlistStatus: null/undefined input → safe fallback');
(function () {
  let threw = false;
  try {
    const r = SP500Engine.classifyWatchlistStatus(null);
    assert('null returns a status string', typeof r.status === 'string');
  } catch (e) { threw = true; }
  assert('no throw on null', !threw);
})();

// ── SECTION: classifyAll fixture integration ──────────────────────────────────

section('classifyAll: fixture rows get correct statuses');
(function () {
  const rows = SP500Engine.classifyAll(SP500_WATCHLIST);
  assert('returns same count as input', rows.length === SP500_WATCHLIST.length);

  // AMD: above20d=false, above200d=false → Weakening
  const amd = rows.find(r => r.ticker === 'AMD');
  assert('AMD → Weakening', amd && amd.status === 'Weakening');

  // AAPL: above20d=true, above200d=true, dayChg=0.18 (<1.5) → Bullish
  const aapl = rows.find(r => r.ticker === 'AAPL');
  assert('AAPL → Bullish', aapl && aapl.status === 'Bullish');

  // MSFT: above20d=false, above200d=true → Neutral
  const msft = rows.find(r => r.ticker === 'MSFT');
  assert('MSFT → Neutral', msft && msft.status === 'Neutral');

  // NVDA: above20d=true, above200d=true, dayChg=1.85 (>1.5) → Extended
  const nvda = rows.find(r => r.ticker === 'NVDA');
  assert('NVDA → Extended', nvda && nvda.status === 'Extended');
})();

section('classifyAll: no short/bearish language in any note_auto');
(function () {
  const rows = SP500Engine.classifyAll(SP500_WATCHLIST);
  rows.forEach(function (r) {
    if (r._autoNote) {
      assert('no "short" in note for ' + r.ticker,
        !r._autoNote.toLowerCase().includes('short') &&
        !r._autoNote.toLowerCase().includes('risk-off'));
    }
  });
})();

section('classifyAll: handles empty array');
(function () {
  assert('empty array → empty array', SP500Engine.classifyAll([]).length === 0);
  assert('null → empty array',        SP500Engine.classifyAll(null).length === 0);
})();

// ── SECTION: renderer DOM output ─────────────────────────────────────────────

function makeRenderer(valuation, watchlist) {
  const nodes = {};
  function makeNode() {
    let _h = '';
    const n = {
      style: {}, _classes: [],
      get innerHTML() { return _h; },
      set innerHTML(v) { _h = v; },
    };
    return n;
  }
  const doc = { getElementById(id) { if (!nodes[id]) nodes[id] = makeNode(); return nodes[id]; } };
  const globals = {
    SP500_VALUATION:  valuation,
    SP500_WATCHLIST:  watchlist,
    SP500Engine,
    document: doc,
    window: {}, module: { exports: {} }, require,
  };
  const fn = new Function(...Object.keys(globals), renderSrc + '\nreturn module.exports;');
  const R = fn(...Object.values(globals));
  return {
    R,
    valHTML:  () => (nodes['sp5-valuation-body']  || { innerHTML: '' }).innerHTML,
    watchHTML:() => (nodes['sp5-watchlist-body']  || { innerHTML: '' }).innerHTML,
  };
}

section('Renderer: valuation panel shows CAPE and history table');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderValuation();
  const html = env.valHTML();
  assert('CAPE value shown',             html.includes('36.8'));
  assert('Forward P/E shown',            html.includes('21.4'));
  assert('CAPE percentile shown',        html.includes('88'));
  assert('2000 Dot-com row present',     html.includes('2000 Dot-com'));
  assert('1929 row present',             html.includes('1929'));
  assert('Today row present',            html.includes('Today'));
  assert('Extreme caution class shown',  html.includes('sp5-caution--extreme'));
})();

section('Renderer: historical table has 6 rows');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderValuation();
  const html = env.valHTML();
  const trCount = (html.match(/<tr/g) || []).length;
  // 1 header row + 6 data rows
  assert('6 history + 1 header = 7 tr elements', trCount === 7);
})();

section('Renderer: cycle note present and mentions context/timing');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderValuation();
  const html = env.valHTML();
  assert('cycle note present',           html.includes('sp5-cycle-note'));
  assert('note mentions timing signal',  html.toLowerCase().includes('timing'));
})();

section('Renderer: watchlist table has all fixture tickers');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderWatchlist();
  const html = env.watchHTML();
  ['SPY','NVDA','MSFT','AMZN','META','GOOGL','AAPL','AVGO','AMD','SMH','XLF','XLE']
    .forEach(t => assert(t + ' in watchlist table', html.includes(t)));
})();

section('Renderer: status badges use correct CSS classes');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderWatchlist();
  const html = env.watchHTML();
  assert('Bullish class present',   html.includes('sp5-status--bullish'));
  assert('Neutral class present',   html.includes('sp5-status--neutral'));
  assert('Extended class present',  html.includes('sp5-status--extended'));
  assert('Weakening class present', html.includes('sp5-status--weakening'));
})();

section('Renderer: missing/null SP500_VALUATION shows unavailable gracefully');
(function () {
  const env = makeRenderer(undefined, SP500_WATCHLIST);
  let threw = false;
  try { env.R.renderValuation(); } catch (e) { threw = true; }
  assert('no throw on missing valuation', !threw);
  assert('unavailable message shown', env.valHTML().includes('not loaded') || env.valHTML().includes('unavailable'));
})();

section('Renderer: missing/null SP500_WATCHLIST shows unavailable gracefully');
(function () {
  const env = makeRenderer(SP500_VALUATION, undefined);
  let threw = false;
  try { env.R.renderWatchlist(); } catch (e) { threw = true; }
  assert('no throw on missing watchlist', !threw);
  assert('unavailable message shown', env.watchHTML().includes('not loaded') || env.watchHTML().includes('unavailable'));
})();

section('Renderer: MA trend arrows rendered for above/below states');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderWatchlist();
  const html = env.watchHTML();
  assert('above arrow present',   html.includes('sp5-ma--above'));
  assert('below arrow present',   html.includes('sp5-ma--below'));
})();

section('Renderer: no "short" or "risk-off" language anywhere');
(function () {
  const env = makeRenderer(SP500_VALUATION, SP500_WATCHLIST);
  env.R.renderValuation();
  env.R.renderWatchlist();
  const html = env.valHTML() + env.watchHTML();
  assert('no "short" in output',    !html.toLowerCase().includes('>short'));
  assert('no "risk-off" in output', !html.toLowerCase().includes('risk-off'));
})();


// ── SECTION: 20D/200D distance columns ───────────────────────────────────────

section('Fixture: dist20d and dist200d fields present on all rows');
(function () {
  const { SP500_WATCHLIST: W } = require('/home/claude/fresh/js/sp500-fixture.js');
  W.forEach(function (r) {
    assert(r.ticker + ' has dist20d',  typeof r.dist20d  === 'number');
    assert(r.ticker + ' has dist200d', typeof r.dist200d === 'number');
  });
})();

section('Fixture: dist20d sign consistent with above20d');
(function () {
  const { SP500_WATCHLIST: W } = require('/home/claude/fresh/js/sp500-fixture.js');
  W.forEach(function (r) {
    if (r.above20d)  assert(r.ticker + ' above20d → dist20d > 0',  r.dist20d  > 0);
    if (!r.above20d) assert(r.ticker + ' below20d → dist20d < 0',  r.dist20d  < 0);
  });
})();

section('Fixture: dist200d sign consistent with above200d');
(function () {
  const { SP500_WATCHLIST: W } = require('/home/claude/fresh/js/sp500-fixture.js');
  W.forEach(function (r) {
    if (r.above200d)  assert(r.ticker + ' above200d → dist200d > 0', r.dist200d > 0);
    if (!r.above200d) assert(r.ticker + ' below200d → dist200d < 0', r.dist200d < 0);
  });
})();

section('_fmtDist: formats positive, negative, zero, missing values');
(function () {
  // Test via the renderer's internal logic by running renderWatchlist and checking output
  const { SP500_VALUATION, SP500_WATCHLIST } = require('/home/claude/fresh/js/sp500-fixture.js');
  const SP500Engine = require('/home/claude/fresh/js/sp500-engine.js');
  const renderSrc2  = require('fs').readFileSync('/home/claude/fresh/js/sp500-render.js', 'utf8');

  const nodes2 = {};
  function makeNode2() {
    let _h = '';
    return { style:{}, get innerHTML(){return _h;}, set innerHTML(v){_h=v;} };
  }
  const doc2 = { getElementById(id){ if(!nodes2[id]) nodes2[id]=makeNode2(); return nodes2[id]; } };
  const globals2 = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine, document:doc2, window:{}, module:{exports:{}}, require };
  const fn2 = new Function(...Object.keys(globals2), renderSrc2+'\nreturn module.exports;');
  const R2  = fn2(...Object.values(globals2));
  R2.renderWatchlist();
  const html = (nodes2['sp5-watchlist-body']||{innerHTML:''}).innerHTML;

  assert('+7.2% NVDA dist20d shown',    html.includes('+7.2%'));
  assert('-4.3% AMD dist20d shown',     html.includes('-4.3%'));
  assert('+38.6% NVDA dist200d shown',  html.includes('+38.6%'));
  assert('-11.2% AMD dist200d shown',   html.includes('-11.2%'));
  assert('20D Dist header present',     html.includes('20D Dist'));
  assert('200D Dist header present',    html.includes('200D Dist'));
})();

section('_fmtDist: missing/null shows —');
(function () {
  const { SP500_VALUATION } = require('/home/claude/fresh/js/sp500-fixture.js');
  const SP500Engine = require('/home/claude/fresh/js/sp500-engine.js');
  const renderSrc2  = require('fs').readFileSync('/home/claude/fresh/js/sp500-render.js', 'utf8');

  const nullRow = [{ ticker:'TEST', company:'Test', sector:'ETF', price:100, dayChg:0.5,
    above20d:true, above200d:true, dist20d:null, dist200d:undefined, note:'Test' }];
  const nodes2 = {};
  function makeNode2(){ let _h=''; return { style:{}, get innerHTML(){return _h;}, set innerHTML(v){_h=v;} }; }
  const doc2 = { getElementById(id){ if(!nodes2[id]) nodes2[id]=makeNode2(); return nodes2[id]; } };
  const globals2 = { SP500_VALUATION, SP500_WATCHLIST:nullRow, SP500Engine, document:doc2, window:{}, module:{exports:{}}, require };
  const fn2 = new Function(...Object.keys(globals2), renderSrc2+'\nreturn module.exports;');
  const R2  = fn2(...Object.values(globals2));
  R2.renderWatchlist();
  const html = (nodes2['sp5-watchlist-body']||{innerHTML:''}).innerHTML;
  // Both null and undefined → '—'
  const dashCount = (html.match(/>—</g)||[]).length;
  assert('at least 2 dashes for null dist fields', dashCount >= 2);
  assert('no NaN in output', !html.includes('NaN'));
  assert('no undefined in output', !html.includes('undefined'));
})();


// ── SECTION: SPY Market Posture line ─────────────────────────────────────────

section('SPY posture line: Bullish shows correct description');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('/home/claude/fresh/js/sp500-fixture.js');
  const SP500Engine = require('/home/claude/fresh/js/sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync('/home/claude/fresh/js/sp500-render.js', 'utf8');
  function makeEnv(watchlist) {
    const nodes = {};
    function mn(){ let _h=''; return { style:{}, get innerHTML(){return _h;}, set innerHTML(v){_h=v;} }; }
    const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
    const g = { SP500_VALUATION, SP500_WATCHLIST:watchlist, SP500Engine, document:doc, window:{}, module:{exports:{}}, require };
    const R = new Function(...Object.keys(g), renderSrc3+'\nreturn module.exports;')(...Object.values(g));
    return { R, html:()=>(nodes['sp5-watchlist-body']||{innerHTML:''}).innerHTML };
  }

  // SPY fixture: above20d=true, above200d=true → Bullish
  const env = makeEnv(SP500_WATCHLIST);
  env.R.renderWatchlist();
  const html = env.html();
  assert('posture label present',          html.includes('SPY Market Posture'));
  assert('SPY status badge shown',         html.includes('sp5-status--bullish'));
  assert('Bullish label in posture',       html.includes('>Bullish<'));
  assert('Bullish description shown',      html.includes('Above 20D and 200D'));
  assert('description not from CAPE',      !html.includes('CAPE') || html.indexOf('SPY Market Posture') < html.indexOf('CAPE'));
})();

section('SPY posture line: each status maps to correct description');
(function () {
  const { SP500_VALUATION } = require('/home/claude/fresh/js/sp500-fixture.js');
  const SP500Engine = require('/home/claude/fresh/js/sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync('/home/claude/fresh/js/sp500-render.js', 'utf8');
  function makeEnv(spy) {
    const nodes = {};
    function mn(){ let _h=''; return { style:{}, get innerHTML(){return _h;}, set innerHTML(v){_h=v;} }; }
    const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
    const wl = [Object.assign({ ticker:'SPY', company:'SPY', sector:'ETF', price:545, dayChg:0.4,
      dist20d:1.4, dist200d:12.3, note:'' }, spy)];
    const g = { SP500_VALUATION, SP500_WATCHLIST:wl, SP500Engine, document:doc, window:{}, module:{exports:{}}, require };
    const R = new Function(...Object.keys(g), renderSrc3+'\nreturn module.exports;')(...Object.values(g));
    R.renderWatchlist();
    return (nodes['sp5-watchlist-body']||{innerHTML:''}).innerHTML;
  }

  const bullHtml = makeEnv({ above20d:true,  above200d:true,  dayChg:0.4 });
  assert('Bullish → "Above 20D and 200D"',     bullHtml.includes('Above 20D and 200D'));

  const neutHtml = makeEnv({ above20d:false, above200d:true,  dayChg:-0.3 });
  assert('Neutral → "Above 200D, below 20D"',  neutHtml.includes('Above 200D, below 20D'));

  const weakHtml = makeEnv({ above20d:false, above200d:false, dayChg:-0.8 });
  assert('Weakening → "Below 200D"',           weakHtml.includes('Below 200D'));

  const extHtml  = makeEnv({ above20d:true,  above200d:true,  dayChg:2.0 }); // dayChg>1.5 → Extended
  assert('Extended → "Strong trend, extended"', extHtml.includes('Strong trend, extended'));
})();

section('SPY posture line: posture appears before watchlist table');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('/home/claude/fresh/js/sp500-fixture.js');
  const SP500Engine = require('/home/claude/fresh/js/sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync('/home/claude/fresh/js/sp500-render.js', 'utf8');
  const nodes = {};
  function mn(){ let _h=''; return { style:{}, get innerHTML(){return _h;}, set innerHTML(v){_h=v;} }; }
  const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
  const g = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine, document:doc, window:{}, module:{exports:{}}, require };
const R = new Function(...Object.keys(g), renderSrc3+'\nreturn module.exports;')(...Object.values(g));
  R.renderWatchlist();
  const html = (nodes['sp5-watchlist-body']||{innerHTML:''}).innerHTML;
  const postureIdx = html.indexOf('SPY Market Posture');
  const tableIdx   = html.indexOf('<table');
  assert('posture line before table', postureIdx >= 0 && tableIdx > postureIdx);
})();

section('SPY posture line: no CAPE influence on posture status');
(function () {
  // Posture is purely from SPY row status (above20d/above200d/dayChg), not CAPE
  // Verify by checking the description doesn't mention valuation terms
  const { SP500_VALUATION, SP500_WATCHLIST } = require('/home/claude/fresh/js/sp500-fixture.js');
  const SP500Engine = require('/home/claude/fresh/js/sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync('/home/claude/fresh/js/sp500-render.js', 'utf8');
  const nodes = {};
  function mn(){ let _h=''; return { style:{}, get innerHTML(){return _h;}, set innerHTML(v){_h=v;} }; }
  const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
  const g = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine, document:doc, window:{}, module:{exports:{}}, require };
  const R = new Function(...Object.keys(g), renderSrc3+'\nreturn module.exports;')(...Object.values(g));
  R.renderWatchlist();
  const html = (nodes['sp5-watchlist-body']||{innerHTML:''}).innerHTML;
  const postureSection = html.slice(html.indexOf('SPY Market Posture'), html.indexOf('<table'));
  assert('no CAPE in posture line',      !postureSection.includes('CAPE'));
  assert('no percentile in posture line',!postureSection.includes('percentile'));
})();

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log('sp500: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

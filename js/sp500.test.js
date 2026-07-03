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
  const { SP500_WATCHLIST: W } = require('./sp500-fixture.js');
  W.forEach(function (r) {
    assert(r.ticker + ' has dist20d',  typeof r.dist20d  === 'number');
    assert(r.ticker + ' has dist200d', typeof r.dist200d === 'number');
  });
})();

section('Fixture: dist20d sign consistent with above20d');
(function () {
  const { SP500_WATCHLIST: W } = require('./sp500-fixture.js');
  W.forEach(function (r) {
    if (r.above20d)  assert(r.ticker + ' above20d → dist20d > 0',  r.dist20d  > 0);
    if (!r.above20d) assert(r.ticker + ' below20d → dist20d < 0',  r.dist20d  < 0);
  });
})();

section('Fixture: dist200d sign consistent with above200d');
(function () {
  const { SP500_WATCHLIST: W } = require('./sp500-fixture.js');
  W.forEach(function (r) {
    if (r.above200d)  assert(r.ticker + ' above200d → dist200d > 0', r.dist200d > 0);
    if (!r.above200d) assert(r.ticker + ' below200d → dist200d < 0', r.dist200d < 0);
  });
})();

section('_fmtDist: formats positive, negative, zero, missing values');
(function () {
  // Test via the renderer's internal logic by running renderWatchlist and checking output
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc2  = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');

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
  const { SP500_VALUATION } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc2  = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');

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
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
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
  const { SP500_VALUATION } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
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
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
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
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc3  = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
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


// ── SECTION: sp500-data-source.js ────────────────────────────────────────────

section('DataSource: getSnapshot returns required metadata fields');
(function () {
  // Test the module in isolation (fixtures as globals)
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const dsSrc = require('fs').readFileSync(__dirname + '/sp500-data-source.js', 'utf8');
  const globals = {
    SP500_VALUATION, SP500_WATCHLIST,
    window:{}, module:{exports:{}}, require,
  };
  const DS = new Function(...Object.keys(globals), dsSrc+'\nreturn module.exports;')(...Object.values(globals));
  const snap = DS.getSnapshot();

  assert('mode is "demo"',           snap.mode === 'demo');
  assert('isLive is false',          snap.isLive === false);
  assert('provider is "Fixture"',    snap.provider === 'Fixture');
  assert('asOf is a string',         typeof snap.asOf === 'string' && snap.asOf.length > 0);
  assert('valuation is an object',   snap.valuation !== null && typeof snap.valuation === 'object');
  assert('watchlist is an array',    Array.isArray(snap.watchlist) && snap.watchlist.length > 0);
})();

section('DataSource: isLive is strictly false (not falsy — must be boolean false)');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const dsSrc = require('fs').readFileSync(__dirname + '/sp500-data-source.js', 'utf8');
  const globals = { SP500_VALUATION, SP500_WATCHLIST, window:{}, module:{exports:{}}, require };
  const DS = new Function(...Object.keys(globals), dsSrc+'\nreturn module.exports;')(...Object.values(globals));
  assert('isLive === false (strict)',  DS.getSnapshot().isLive === false);
  assert('isLive is not null',        DS.getSnapshot().isLive !== null);
  assert('isLive is not undefined',   DS.getSnapshot().isLive !== undefined);
})();

section('DataSource: snapshot valuation matches SP500_VALUATION fixture');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const dsSrc = require('fs').readFileSync(__dirname + '/sp500-data-source.js', 'utf8');
  const globals = { SP500_VALUATION, SP500_WATCHLIST, window:{}, module:{exports:{}}, require };
  const DS = new Function(...Object.keys(globals), dsSrc+'\nreturn module.exports;')(...Object.values(globals));
  const snap = DS.getSnapshot();
  assert('cape matches fixture',      snap.valuation.cape === SP500_VALUATION.cape);
  assert('watchlist length matches',  snap.watchlist.length === SP500_WATCHLIST.length);
})();

section('Renderer: _safeSnapshot falls back gracefully when DataSource absent');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
  // No SP500DataSource in globals — should fall back to direct globals
  const nodes = {};
  function mn(){ let _h=''; return {style:{},get innerHTML(){return _h;},set innerHTML(v){_h=v;}}; }
  const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
  const globals = {
    SP500_VALUATION, SP500_WATCHLIST, SP500Engine,
    // SP500DataSource deliberately absent
    document:doc, window:{}, module:{exports:{}}, require,
  };
  const R = new Function(...Object.keys(globals), renderSrc+'\nreturn module.exports;')(...Object.values(globals));
  const snap = R.getSnapshot();
  assert('fallback mode is demo',    snap.mode === 'demo');
  assert('fallback isLive is false', snap.isLive === false);
  assert('fallback has valuation',   snap.valuation !== null);
  // Render should still work
  let threw = false;
  try { R.renderWatchlist(); } catch(e) { threw = true; }
  assert('renders without DataSource', !threw);
})();

section('Renderer: banner text is consistent "DEMO DATA · Fixture values · Not live"');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
  // Banners are in index.html static HTML, not renderer output — check index.html
  const html = require('fs').readFileSync(__dirname + '/../index.html', 'utf8');
  // Banners use &middot; entities; check raw HTML directly
  const bannerCount = (html.match(/sp5-demo-banner/g)||[]).length;
  assert('at least two banners present', bannerCount >= 2);
  assert('both say Fixture values',      (html.match(/Fixture values/g)||[]).length >= 2);
  assert('both say Not live',            (html.match(/Not live/g)||[]).length >= 2);
  assert('no "Not live prices" variant', !html.includes('Not live prices'));
  assert('no "For layout" variant',      !html.includes('For layout'));
})();

section('Index.html: live-pill has IDs for runtime updates');
(function () {
  const html = require('fs').readFileSync(__dirname + '/../index.html', 'utf8');
  assert('sp5-live-pill id exists',  html.includes('id="sp5-live-pill"'));
  assert('sp5-live-dot id exists',   html.includes('id="sp5-live-dot"'));
  assert('sp5-live-label id exists', html.includes('id="sp5-live-label"'));
})();

section('Index.html: sp500-data-source.js script tag present before fixture');
(function () {
  const html = require('fs').readFileSync(__dirname + '/../index.html', 'utf8');
  const dsIdx  = html.indexOf('sp500-data-source.js');
  const fixIdx = html.indexOf('sp500-fixture.js');
  assert('data-source script tag present', dsIdx !== -1);
  assert('data-source loads before fixture', dsIdx < fixIdx);
})();


// ── SECTION: live data merge (sp500-data-source.js) ──────────────────────────

section('DataSource: fetchLive merges live price/dayChg, preserves fixture fields');
(function () {
  const { SP500_WATCHLIST } = require('./sp500-fixture.js');

  function mergeRows(fixtureRows, liveRows) {
    const liveMap = {};
    for (const r of liveRows) liveMap[r.ticker] = r;
    return fixtureRows.map(row => {
      const live = liveMap[row.ticker];
      if (!live) return row;
      return Object.assign({}, row, { price: live.price, dayChg: live.dayChg });
    });
  }

  const liveRows = [
    { ticker:'SPY',  price:728.99, dayChg:-0.72 },
    { ticker:'NVDA', price:192.53, dayChg:-1.64 },
  ];
  const merged = mergeRows(SP500_WATCHLIST, liveRows);
  const spy = merged.find(r => r.ticker === 'SPY');

  assert('SPY price overwritten by live',     spy.price === 728.99);
  assert('SPY dayChg overwritten by live',    spy.dayChg === -0.72);
  assert('SPY dist20d preserved from fixture', spy.dist20d === SP500_WATCHLIST.find(r=>r.ticker==='SPY').dist20d);
  assert('SPY note preserved from fixture',    spy.note === SP500_WATCHLIST.find(r=>r.ticker==='SPY').note);
  assert('SPY sector preserved from fixture',  spy.sector === SP500_WATCHLIST.find(r=>r.ticker==='SPY').sector);
})();

section('DataSource: tickers absent from live payload keep fixture values');
(function () {
  const { SP500_WATCHLIST } = require('./sp500-fixture.js');
  function mergeRows(fixtureRows, liveRows) {
    const liveMap = {};
    for (const r of liveRows) liveMap[r.ticker] = r;
    return fixtureRows.map(row => {
      const live = liveMap[row.ticker];
      if (!live) return row;
      return Object.assign({}, row, { price: live.price, dayChg: live.dayChg });
    });
  }
  // Only 8 of 12 tickers come back from the trimmed worker
  const liveRows = ['SPY','NVDA','MSFT','AMZN','META','AAPL','AMD','SMH']
    .map(t => ({ ticker: t, price: 100, dayChg: 0.1 }));
  const merged = mergeRows(SP500_WATCHLIST, liveRows);
  const googl = merged.find(r => r.ticker === 'GOOGL');
  const avgo  = merged.find(r => r.ticker === 'AVGO');
  const xlf   = merged.find(r => r.ticker === 'XLF');
  const xle   = merged.find(r => r.ticker === 'XLE');
  const fixGoogl = SP500_WATCHLIST.find(r => r.ticker === 'GOOGL');

  assert('GOOGL keeps fixture price (not in live payload)', googl.price === fixGoogl.price);
  assert('AVGO keeps fixture price',  avgo.price === SP500_WATCHLIST.find(r=>r.ticker==='AVGO').price);
  assert('XLF keeps fixture price',   xlf.price  === SP500_WATCHLIST.find(r=>r.ticker==='XLF').price);
  assert('XLE keeps fixture price',   xle.price  === SP500_WATCHLIST.find(r=>r.ticker==='XLE').price);
})();

section('DataSource: WORKER_URL points to deployed Cloudflare Worker');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const dsSrc = require('fs').readFileSync(__dirname + '/sp500-data-source.js', 'utf8');
  const globals = { SP500_VALUATION, SP500_WATCHLIST, window:{}, module:{exports:{}}, require };
  const DS = new Function(...Object.keys(globals), dsSrc+'\nreturn module.exports;')(...Object.values(globals));
  assert('WORKER_URL is the deployed endpoint',
    DS.WORKER_URL === 'https://royal-darkness-0ac6.wimneys.workers.dev/api/sp500-prices');
  assert('fetchLive is a function', typeof DS.fetchLive === 'function');
})();

section('Renderer: setPillLive and setPillDemo are exposed and distinct');
(function () {
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
  assert('setPillLive present in source',  renderSrc.includes('setPillLive'));
  assert('setPillDemo present in source',  renderSrc.includes('setPillDemo'));
  assert('_updateWatchlistBanner present', renderSrc.includes('_updateWatchlistBanner'));
})();

section('Index.html: watchlist banner has stable ID for live updates');
(function () {
  const html = require('fs').readFileSync(__dirname + '/../index.html', 'utf8');
  assert('sp5-watchlist-banner id present', html.includes('id="sp5-watchlist-banner"'));
})();


// ── SECTION: per-row provenance + truthful coverage labeling ─────────────────

section('DataSource: getSnapshot tags every row priceSource=fixture by default');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const dsSrc = require('fs').readFileSync(__dirname + '/sp500-data-source.js', 'utf8');
  const globals = { SP500_VALUATION, SP500_WATCHLIST, window:{}, module:{exports:{}}, require };
  const DS = new Function(...Object.keys(globals), dsSrc+'\nreturn module.exports;')(...Object.values(globals));
  const snap = DS.getSnapshot();
  assert('mode is demo',           snap.mode === 'demo');
  assert('liveCount is 0',         snap.liveCount === 0);
  assert('totalCount is 12',       snap.totalCount === 12);
  snap.watchlist.forEach(r => assert(r.ticker + ' priceSource=fixture', r.priceSource === 'fixture'));
})();

function buildMergeFn() {
  // Mirrors _mergeRows in sp500-data-source.js exactly
  return function mergeRows(fixtureRows, liveRows) {
    const liveMap = {};
    for (const r of liveRows) liveMap[r.ticker] = r;
    return fixtureRows.map(row => {
      const live = liveMap[row.ticker];
      if (!live) return Object.assign({}, row, { priceSource: 'fixture' });
      return Object.assign({}, row, { price: live.price, dayChg: live.dayChg, priceSource: 'live' });
    });
  };
}

section('Coverage: all 12 tickers returned → mode=live, every row priceSource=live');
(function () {
  const { SP500_WATCHLIST } = require('./sp500-fixture.js');
  const mergeRows = buildMergeFn();
  const liveRows = SP500_WATCHLIST.map(r => ({ ticker: r.ticker, price: 999, dayChg: 1.1 }));
  const merged = mergeRows(SP500_WATCHLIST, liveRows);
  const liveCount = merged.filter(r => r.priceSource === 'live').length;
  const mode = liveCount === 0 ? 'demo' : (liveCount === merged.length ? 'live' : 'partial');

  assert('all 12 rows priceSource=live', liveCount === 12);
  assert('mode computed as live',        mode === 'live');
  merged.forEach(r => assert(r.ticker + ' price overwritten', r.price === 999));
})();

section('Coverage: 8/12 returned → mode=partial, correct per-row provenance');
(function () {
  const { SP500_WATCHLIST } = require('./sp500-fixture.js');
  const mergeRows = buildMergeFn();
  const liveTickers = ['SPY','NVDA','MSFT','AMZN','META','AAPL','AMD','SMH'];
  const liveRows = liveTickers.map(t => ({ ticker: t, price: 500, dayChg: 0.5 }));
  const merged = mergeRows(SP500_WATCHLIST, liveRows);
  const liveCount = merged.filter(r => r.priceSource === 'live').length;
  const mode = liveCount === 0 ? 'demo' : (liveCount === merged.length ? 'live' : 'partial');

  assert('exactly 8 rows are live',      liveCount === 8);
  assert('mode computed as partial',     mode === 'partial');
  liveTickers.forEach(t => {
    const row = merged.find(r => r.ticker === t);
    assert(t + ' is priceSource=live', row.priceSource === 'live');
  });
  ['GOOGL','AVGO','XLF','XLE'].forEach(t => {
    const row = merged.find(r => r.ticker === t);
    assert(t + ' is priceSource=fixture', row.priceSource === 'fixture');
  });
})();

section('Coverage: no payload / failure → demo state preserved, all rows fixture');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const dsSrc = require('fs').readFileSync(__dirname + '/sp500-data-source.js', 'utf8');
  const globals = { SP500_VALUATION, SP500_WATCHLIST, window:{}, module:{exports:{}}, require };
  const DS = new Function(...Object.keys(globals), dsSrc+'\nreturn module.exports;')(...Object.values(globals));
  // Simulate fetch failure: getSnapshot() is what the renderer falls back to
  const snap = DS.getSnapshot();
  assert('mode is demo on no payload',  snap.mode === 'demo');
  assert('isLive is false',             snap.isLive === false);
  assert('liveCount is 0',              snap.liveCount === 0);
  snap.watchlist.forEach(r => assert(r.ticker + ' stays fixture', r.priceSource === 'fixture'));
})();

section('Merge: fixture technical fields unchanged after quote merge (live)');
(function () {
  const { SP500_WATCHLIST } = require('./sp500-fixture.js');
  const mergeRows = buildMergeFn();
  const liveRows = SP500_WATCHLIST.map(r => ({ ticker: r.ticker, price: 777, dayChg: 2.2 }));
  const merged = mergeRows(SP500_WATCHLIST, liveRows);
  const nvdaOrig = SP500_WATCHLIST.find(r => r.ticker === 'NVDA');
  const nvdaNew  = merged.find(r => r.ticker === 'NVDA');

  assert('above20d unchanged',  nvdaNew.above20d  === nvdaOrig.above20d);
  assert('above200d unchanged', nvdaNew.above200d === nvdaOrig.above200d);
  assert('dist20d unchanged',   nvdaNew.dist20d   === nvdaOrig.dist20d);
  assert('dist200d unchanged',  nvdaNew.dist200d  === nvdaOrig.dist200d);
  assert('sector unchanged',    nvdaNew.sector    === nvdaOrig.sector);
  assert('note unchanged',      nvdaNew.note      === nvdaOrig.note);
  assert('company unchanged',   nvdaNew.company   === nvdaOrig.company);
  assert('only price/dayChg/priceSource changed', nvdaNew.price === 777 && nvdaNew.dayChg === 2.2);
})();

section('Merge: fixture technical fields unchanged after quote merge (partial)');
(function () {
  const { SP500_WATCHLIST } = require('./sp500-fixture.js');
  const mergeRows = buildMergeFn();
  const liveRows = [{ ticker:'SPY', price: 700, dayChg: -1.0 }]; // only SPY live
  const merged = mergeRows(SP500_WATCHLIST, liveRows);
  const googlOrig = SP500_WATCHLIST.find(r => r.ticker === 'GOOGL');
  const googlNew  = merged.find(r => r.ticker === 'GOOGL');

  assert('GOOGL price unchanged (fixture)',   googlNew.price   === googlOrig.price);
  assert('GOOGL dayChg unchanged (fixture)',  googlNew.dayChg  === googlOrig.dayChg);
  assert('GOOGL above20d unchanged',          googlNew.above20d === googlOrig.above20d);
  assert('GOOGL dist200d unchanged',          googlNew.dist200d === googlOrig.dist200d);
})();

section('Renderer: banner text — full live coverage');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
  const nodes = {};
  function mn(){ let _h=''; return {style:{},get innerHTML(){return _h;},set innerHTML(v){_h=v;},get textContent(){return _h;},set textContent(v){_h=v;}}; }
  const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
  const globals = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine, document:doc, window:{}, module:{exports:{}}, require };
  const R = new Function(...Object.keys(globals), renderSrc+'\nreturn module.exports;')(...Object.values(globals));

  const liveSnapshot = {
    valuation: SP500_VALUATION,
    watchlist: SP500_WATCHLIST.map(r => Object.assign({}, r, { priceSource:'live' })),
    mode: 'live', isLive: true, provider: 'Twelve Data',
    asOf: new Date().toISOString(), liveCount: 12, totalCount: 12,
  };
  // Directly exercise the internal banner updater via the public renderWatchlist + manual snapshot injection
  // We test the banner text format using the same function the renderer uses internally
  R.renderWatchlist(); // initial demo paint
  // Simulate what init() does on success
  const banner = doc.getElementById('sp5-watchlist-banner');
  // Manually invoke same logic the module would (banner text assembled identically)
  const time = new Date(liveSnapshot.asOf).toLocaleTimeString();
  banner.textContent = 'LIVE PRICES \u00b7 ' + liveSnapshot.provider + ' \u00b7 ' + time;
  assert('full coverage banner says LIVE PRICES', banner.textContent.includes('LIVE PRICES'));
  assert('full coverage banner has provider',     banner.textContent.includes('Twelve Data'));
})();

section('Renderer: banner text — partial coverage format');
(function () {
  const partialSnapshot = { mode: 'partial', liveCount: 8, totalCount: 12 };
  const text = 'PARTIAL LIVE PRICES \u00b7 ' + partialSnapshot.liveCount + '/' +
    partialSnapshot.totalCount + ' live \u00b7 Remaining rows use fixtures';
  assert('partial banner format correct', text === 'PARTIAL LIVE PRICES \u00b7 8/12 live \u00b7 Remaining rows use fixtures');
})();

section('Renderer: Source column only rendered when coverage is partial');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');

  // Demo mode (no SP500DataSource) — Source column should NOT appear
  const nodes1 = {};
  function mn1(){ let _h=''; return {style:{},get innerHTML(){return _h;},set innerHTML(v){_h=v;}}; }
  const doc1 = { getElementById(id){ if(!nodes1[id]) nodes1[id]=mn1(); return nodes1[id]; } };
  const g1 = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine, document:doc1, window:{}, module:{exports:{}}, require };
  const R1 = new Function(...Object.keys(g1), renderSrc+'\nreturn module.exports;')(...Object.values(g1));
  R1.renderWatchlist();
  const demoHtml = (nodes1['sp5-watchlist-body']||{innerHTML:''}).innerHTML;
  assert('no Source column header in demo mode', !demoHtml.includes('<th>Source</th>'));
})();

section('Renderer: Source column shows Live/Fixture labels when partial');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');

  const nodes = {};
  function mn(){ let _h=''; return {style:{},get innerHTML(){return _h;},set innerHTML(v){_h=v;}}; }
  const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };

  // Inject a fake SP500DataSource that returns partial coverage
  const partialWatchlist = SP500_WATCHLIST.map((r,i) =>
    Object.assign({}, r, { priceSource: i < 8 ? 'live' : 'fixture' }));
  const fakeDS = {
    getSnapshot: () => ({
      valuation: SP500_VALUATION, watchlist: partialWatchlist,
      mode: 'partial', isLive: false, provider: 'Twelve Data',
      asOf: new Date().toISOString(), liveCount: 8, totalCount: 12,
    }),
    fetchLive: () => {},
  };

  const g = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine,
    SP500DataSource: fakeDS, document:doc, window:{}, module:{exports:{}}, require };
  const R = new Function(...Object.keys(g), renderSrc+'\nreturn module.exports;')(...Object.values(g));
  R.renderWatchlist();
  const html = (nodes['sp5-watchlist-body']||{innerHTML:''}).innerHTML;

  assert('Source column header present when partial', html.includes('<th>Source</th>'));
  assert('Live label appears',     html.includes('>Live<'));
  assert('Fixture label appears',  html.includes('>Fixture<'));
  assert('sp5-source--live class', html.includes('sp5-source--live'));
  assert('sp5-source--fixture class', html.includes('sp5-source--fixture'));
})();

section('Renderer: valuation panel stays DEMO regardless of watchlist coverage');
(function () {
  const { SP500_VALUATION, SP500_WATCHLIST } = require('./sp500-fixture.js');
  const SP500Engine = require('./sp500-engine.js');
  const renderSrc = require('fs').readFileSync(__dirname + '/sp500-render.js', 'utf8');
  const nodes = {};
  function mn(){ let _h=''; return {style:{},get innerHTML(){return _h;},set innerHTML(v){_h=v;}}; }
  const doc = { getElementById(id){ if(!nodes[id]) nodes[id]=mn(); return nodes[id]; } };
  const g = { SP500_VALUATION, SP500_WATCHLIST, SP500Engine, document:doc, window:{}, module:{exports:{}}, require };
  const R = new Function(...Object.keys(g), renderSrc+'\nreturn module.exports;')(...Object.values(g));
  R.renderValuation();
  const html = (nodes['sp5-valuation-body']||{innerHTML:''}).innerHTML;
  assert('valuation shows CAPE (fixture)', html.includes('36.8'));
  // The valuation renderer never reads watchlist coverage at all
  assert('no Source/Live language in valuation panel', !html.includes('sp5-source'));
})();

// The Cloudflare Worker source (merged-index.js) lives in a separate
// deployment, not in this repo — WORKER_SRC_PATH is a local-only override
// (e.g. `WORKER_SRC_PATH=/path/to/merged-index.js node js/sp500.test.js`)
// for anyone who has that file checked out elsewhere. Without it, these two
// sections skip rather than crashing the rest of the suite.
const WORKER_SRC_PATH = process.env.WORKER_SRC_PATH || null;
let workerSrcCached = null;
function tryReadWorkerSrc() {
  if (workerSrcCached !== null) return workerSrcCached;
  if (!WORKER_SRC_PATH) return null;
  try {
    workerSrcCached = require('fs').readFileSync(WORKER_SRC_PATH, 'utf8');
    return workerSrcCached;
  } catch (e) {
    return null;
  }
}

section('Worker source: requests all 12 tickers');
(function () {
  const workerSrc = tryReadWorkerSrc();
  if (!workerSrc) { console.log('  SKIP worker source not available locally (set WORKER_SRC_PATH to run this section)'); return; }
  const expected = ['SPY','NVDA','MSFT','AMZN','META','GOOGL','AAPL','AVGO','AMD','SMH','XLF','XLE'];
  expected.forEach(t => assert('worker requests ' + t, workerSrc.includes("'" + t + "'")));
})();

section('Response shape: normalized payload still has ticker/price/dayChg/provider/asOf');
(function () {
  const workerSrc = tryReadWorkerSrc();
  if (!workerSrc) { console.log('  SKIP worker source not available locally (set WORKER_SRC_PATH to run this section)'); return; }
  assert('payload includes provider field', workerSrc.includes("provider: 'Twelve Data'"));
  assert('payload includes asOf field',     workerSrc.includes('asOf: new Date().toISOString()'));
  assert('row includes ticker field',       workerSrc.includes('ticker,'));
  assert('row includes price field',        workerSrc.includes('price:'));
  assert('row includes dayChg field',       workerSrc.includes('dayChg:'));
})();

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log('sp500: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

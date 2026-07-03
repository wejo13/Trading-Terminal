// oi-exhaustion-tooltips.test.js — "?" help tooltips on Parameters & Zones.
// No jsdom in this environment (see oi-exhaustion-explainer.test.js for
// why) — structural/content checks read index.html as a string, same
// pattern as sp500.test.js and the explainer accordion tests. The actual
// open/close STATE LOGIC (nextHelpTooltipState) is pure and is tested
// properly in oi-exhaustion-render.test.js against the real function, not
// re-implemented here.
'use strict';

const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const R = require('./oi-exhaustion-render.js');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log('  PASS ' + desc); passed++; }
  else       { console.error('  FAIL ' + desc); failed++; }
}
function section(name) { console.log('\n' + name); }

const paramStart = html.indexOf('<!-- Parameters -->');
const zonesStart = html.indexOf('<!-- Zones editor -->');
const runStart = html.indexOf('<!-- Run -->');
const paramsHtml = html.slice(paramStart, zonesStart);
const zonesHtml = html.slice(zonesStart, runStart);

const EXPECTED_PARAM_HELP_IDS = [
  'oix-help-symbol', 'oix-help-alertModel', 'oix-help-lookbackDays', 'oix-help-signalWindow',
  'oix-help-baselineLookback', 'oix-help-minBaselineSamples', 'oix-help-alertPercentile',
  'oix-help-rearmPercentile', 'oix-help-apiKey', 'oix-help-recencyEnable', 'oix-help-recencyWindow',
  'oix-help-recencyMinChange',
];
const EXPECTED_ZONE_HELP_IDS = [
  'oix-help-zoneLabel', 'oix-help-zoneType', 'oix-help-zoneLevelTop', 'oix-help-zoneToleranceBottom',
  'oix-help-zoneAvailableFrom', 'oix-help-zoneAvailableUntil', 'oix-help-zoneEnabled',
];

section('Every parameter field has a help icon');
(function () {
  EXPECTED_PARAM_HELP_IDS.forEach(id => assert(id + ' present in Parameters', paramsHtml.includes('id="' + id + '"')));
})();

section('Every zone-field column header has a help icon');
(function () {
  EXPECTED_ZONE_HELP_IDS.forEach(id => assert(id + ' present in Zones header', zonesHtml.includes('id="' + id + '"')));
})();

section('All help-icon ids are unique across the page (no accidental duplicates)');
(function () {
  const ids = (html.match(/id="oix-help-[a-zA-Z]+"/g) || []);
  const unique = new Set(ids);
  assert('found the expected number of icons (12 params + 7 zone columns = 19)', ids.length === 19);
  assert('no duplicate ids', ids.length === unique.size);
})();

section('Icon markup: hover + click + keyboard, one popover each');
(function () {
  EXPECTED_PARAM_HELP_IDS.concat(EXPECTED_ZONE_HELP_IDS).forEach(id => {
    const re = new RegExp(
      'class="oix-help" id="' + id + '"[^>]*tabindex="0"[^>]*role="button"[^>]*' +
      'onclick="OIExhaustionRender\\.toggleHelpTooltip\\(\'' + id + '\'\\)"[^>]*' +
      'onkeydown="[^"]*key===\'Enter\'[^"]*key===\' \'[^"]*"[^>]*>\\?<span class="oix-help-pop">'
    );
    assert(id + ': focusable, click-toggles via toggleHelpTooltip, Enter/Space wired, exactly one popover', re.test(html));
  });
})();

section('CSS: hover, click-open, and keyboard-focus all reveal the popover; closed by default');
(function () {
  assert('.oix-help-pop is display:none by default', /\.oix-help-pop\{[^}]*display:none/.test(html));
  assert('hover reveals the popover', /\.oix-help:hover \.oix-help-pop[^{]*\{display:block;\}|\.oix-help:hover \.oix-help-pop,[^{]*\{display:block;\}/.test(html) || /:hover \.oix-help-pop/.test(html));
  assert('keyboard focus reveals the popover (:focus-visible)', /:focus-visible \.oix-help-pop/.test(html));
  assert('the click-toggled "open" state reveals the popover', /\.oix-help-open \.oix-help-pop/.test(html));
  assert('popover text-transform is reset (parent labels are uppercase; copy must not be)', /\.oix-help-pop\{[^}]*text-transform:none/.test(html));
})();

section('Popover width is viewport-clamped for small screens');
(function () {
  assert('popover width uses a vw-based max-width clamp', /\.oix-help-pop\{[^}]*max-width:min\(230px,72vw\)/.test(html));
})();

section('Only one tooltip open at a time — outside click and Escape both close it');
(function () {
  const renderSrc = fs.readFileSync(__dirname + '/oi-exhaustion-render.js', 'utf8');
  assert('toggleHelpTooltip drives off the pure nextHelpTooltipState (single source of truth)', /toggleHelpTooltip[\s\S]{0,200}nextHelpTooltipState\(helpTooltipOpenId, id\)/.test(renderSrc));
  assert('closeAllHelpTooltips removes .oix-help-open from every icon (not just one)', /closeAllHelpTooltips[\s\S]{0,200}querySelectorAll\('\.oix-help\.oix-help-open'\)/.test(renderSrc));
  assert('outside-click listener registered once in init()', /document\.addEventListener\('click'[\s\S]{0,150}closeAllHelpTooltips\(\)/.test(renderSrc));
  assert('Escape key also closes any open tooltip', /document\.addEventListener\('keydown'[\s\S]{0,150}key === 'Escape'[\s\S]{0,80}closeAllHelpTooltips\(\)/.test(renderSrc));
  assert('nextHelpTooltipState only returns the clicked id or null (never two ids at once)', typeof R.nextHelpTooltipState === 'function');
})();

section('Popover copy: correct source label, no forbidden phrasing, no premature V1/V2 leakage in tooltip text');
(function () {
  assert('API key tooltip uses the exact source label', /CryptoHFTData API key[\s\S]{0,400}CryptoHFT major-venue aggregate/.test(paramsHtml));
  assert('Symbol tooltip uses the exact source label', /Symbol[\s\S]{0,400}CryptoHFT major-venue aggregate/.test(paramsHtml));
  assert('no "all exchanges" anywhere on the page', !html.includes('all exchanges'));
  assert('no "market-wide OI" anywhere on the page', !html.includes('market-wide OI'));
  assert('no "Velo aggregate" anywhere on the page', !html.includes('Velo aggregate'));
  assert('alert-model tooltip explicitly says not to blend V1 and V2', paramsHtml.includes("Don't blend V1 and V2 results."));
})();

section('Required OI-neutral principle is visible near the parameter area without needing a tooltip');
(function () {
  const principleIdx = paramsHtml.indexOf('OI is neutral; HTF structure, liquidity, price reaction, and execution rules decide the trade.');
  assert('principle text present', principleIdx !== -1);
  assert('principle text is NOT inside a popover (visible by default, not hover/click-gated)', principleIdx !== -1 && !paramsHtml.slice(Math.max(0, principleIdx - 120), principleIdx).includes('oix-help-pop'));
})();

section('Zones: compact "best use" note visible without a tooltip');
(function () {
  const noteIdx = zonesHtml.indexOf('Best use: define narrow, real higher-timeframe areas. Wide placeholder zones create more alerts but weaker insight.');
  assert('note text present', noteIdx !== -1);
  assert('note is NOT inside a popover', noteIdx !== -1 && !zonesHtml.slice(Math.max(0, noteIdx - 120), noteIdx).includes('oix-help-pop'));
})();

section('Layout: parameter section is not substantially taller — no per-row help text blocks added outside popovers');
(function () {
  // The only always-visible additions are the one-line OI-neutral principle
  // (Parameters) and the one-line "best use" note (Zones) — everything else
  // lives inside a hidden-until-triggered .oix-help-pop, so it costs no
  // permanent vertical space.
  const alwaysVisibleAdditions = (paramsHtml.match(/<div style="font-size:11px;color:var\(--text-faint\);margin-bottom:12px;">/g) || []).length;
  assert('exactly one always-visible line added to the Parameters card', alwaysVisibleAdditions === 1);
})();

console.log('\n────────────────────────────────────────');
console.log('oi-exhaustion-tooltips: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

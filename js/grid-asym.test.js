// Tests for the ASYM gridbot (js/grid-asym.js) — UI wiring + the pure sizing
// math ported from the frozen reference engine regime-research-fable/
// gridbot-mm-true.js. Run: node --test js/grid-asym.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { agBuildLevels, agUnitUsd, agMaxInventoryBase, agProfitPerStep } = require('./grid-asym.js');

test('ASYM grid is a bookmarkable Strategies tab, wired to its script', () => {
  assert.match(html, /data-tab="grid-asym"/);
  assert.match(html, /id="tab-grid-asym" data-title="Grid Bot · ASYM"/);
  assert.match(html, /src="js\/grid-asym\.js"/);
});

test('the tab exposes the ASYM box inputs and owner-only arm controls', () => {
  ['ag-wick', 'ag-cap', 'ag-bankroll', 'ag-sidecap', 'ag-step', 'ag-leverage']
    .forEach(id => assert.match(html, new RegExp(`id="${id}"`), `missing input ${id}`));
  assert.match(html, /onclick="agArm\(\)"/);
  assert.match(html, /onclick="agDisarm\(\)"/);
  // asymmetry must be spelled out in the docs: bottom = brake, top = hold
  assert.match(html, /disaster brake/i);
  assert.match(html, /PAUSE \+ HOLD/i);
});

test('the browser bot does NOT auto-arm on load', () => {
  const src = fs.readFileSync(path.join(__dirname, 'grid-asym.js'), 'utf8');
  // bootstrap may start the read-only price feed + restore, but must never arm
  assert.doesNotMatch(src, /\n\s*agArm\(\)\s*;/); // no bare agArm() call in bootstrap
  assert.match(src, /agStartPriceWs\(\);/);        // price feed is fine
});

test('geometric ladder is faithful to the reference (inclusive wick, last level <= cap)', () => {
  const levels = agBuildLevels(60000, 66000, 1.0);
  assert.equal(levels[0], 60000);                       // includes the wick
  assert.ok(levels[levels.length - 1] <= 66000 + 1e-6); // never above the cap
  assert.ok(levels[levels.length - 1] * 1.01 > 66000);  // and it's the last one that fits
  for (let i = 1; i < levels.length; i++) {
    assert.ok(Math.abs(levels[i] / levels[i - 1] - 1.01) < 1e-9, 'constant geometric step');
  }
});

test("owner LIVE box (57,800 → 69,975, step 1%) sizes as independently computed", () => {
  // Independent oracle: k_max = floor(ln(cap/wick)/ln(1+step)); N = k_max, levels = k_max+1.
  // ln(69975/57800)/ln(1.01) = 19.21 -> 19 steps, 20 levels.
  const levels = agBuildLevels(57800, 69975, 1.0);
  assert.equal(levels.length, 20);
  const N = levels.length - 1;
  assert.equal(N, 19);

  const sideCap = 3 * 500; // 3x bankroll = $1,500 per side
  const unit = agUnitUsd(sideCap, levels.length);
  assert.ok(Math.abs(unit - 1500 / 19) < 1e-9, 'unit = SIDE_CAP / N');

  // full one-sided deployment notional must equal the side cap exactly
  assert.ok(Math.abs(N * unit - sideCap) < 1e-6, 'N * unit == SIDE_CAP');

  // note's sanity check: $/round-trip ~= unit * step
  assert.ok(Math.abs(agProfitPerStep(unit, 1.0) - unit * 0.01) < 1e-9);
});

test("reference 2026 box (60,097.27 → 81,923.01, step 0.5%) reproduces 62 steps", () => {
  // Matches gridbot-mm-true.js DEFAULT_CFG: SL=60097.27, CAP=SL+0.618*(95414-SL).
  const wick = 60097.27;
  const cap = wick + 0.618 * (95414 - wick);
  assert.ok(Math.abs(cap - 81923.01) < 0.02, 'cap fib arithmetic');
  const levels = agBuildLevels(wick, cap, 0.5);
  assert.equal(levels.length - 1, 62); // 62 steps, independently: floor(ln(cap/wick)/ln(1.005))
  const unit = agUnitUsd(1500, levels.length);
  assert.ok(Math.abs(unit - 1500 / 62) < 1e-9);
});

test('max inventory base covers the whole ladder (for sizing the disaster stop)', () => {
  const levels = agBuildLevels(57800, 69975, 1.0);
  const unit = agUnitUsd(1500, levels.length);
  const base = agMaxInventoryBase(levels, unit);
  // sum of unit/price over all levels: bounded by (levels*unit)/wick and above (levels*unit)/cap
  const totalUsd = levels.length * unit;
  assert.ok(base > totalUsd / 69975 && base < totalUsd / 57800, 'base within price bounds');
  assert.ok(base > 0);
});

test('degenerate boxes yield no ladder (guards against arming garbage)', () => {
  assert.equal(agBuildLevels(70000, 60000, 1.0).length, 0); // cap below wick
  assert.equal(agBuildLevels(0, 60000, 1.0).length, 0);     // no wick
  assert.equal(agBuildLevels(57800, 69975, 0).length, 0);   // no step
});

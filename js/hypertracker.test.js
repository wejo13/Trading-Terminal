const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'hypertracker.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css', 'hypertracker.css'), 'utf8');

test('HyperTracker is a bookmarkable Research tab', () => {
  assert.match(html, /data-tab="hypertracker"/);
  assert.match(html, /id="tab-hypertracker" data-title="HyperTracker"/);
  assert.match(html, /href="css\/hypertracker\.css(?:\?[^"]*)?"/);
  assert.match(html, /src="js\/hypertracker\.js"/);
});

test('visible screening rules match the research defaults', () => {
  assert.match(html, /Median hold<\/span><strong>≤ 2 days/);
  assert.match(html, /Monthly PnL<\/span><strong>&gt; \$1K/);
  assert.match(html, /Monthly volume<\/span><strong>&gt; \$100K/);
  assert.match(html, /Account value<\/span><strong>&gt; \$2K/);
  assert.match(html, /Financial matches<\/span>\s*<strong>3,835/);
});

test('confirmed sample is interactive and styled without external UI dependencies', () => {
  assert.equal((script.match(/address:'0x/g) || []).length, 8);
  assert.match(script, /function renderDetail/);
  assert.match(script, /function renderRows/);
  assert.match(script, /state\.sort==='medianHold'/);
  assert.match(styles, /\.ht-workspace/);
  assert.match(styles, /@media\(max-width:760px\)/);
});

test('every rendered wallet gets a HypurrScan address link', () => {
  assert.match(script, /function explorerUrl/);
  assert.match(script, /https:\/\/hypurrscan\.io\/address\//);
  assert.doesNotMatch(script, /https:\/\/app\.hyperliquid\.xyz\/explorer\/address\//);
  assert.match(script, /class="ht-wallet-link"/);
  assert.match(script, /class="ht-open-wallet"/);
  assert.match(script, /resultCount\.textContent=rows\.length/);
});

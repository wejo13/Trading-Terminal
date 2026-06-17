// EMA Watch — Telegram touch-alert checker
//
// Standalone Node script, run on a schedule via GitHub Actions (not in the browser).
// Detects the same condition as index.html's browser-based alert system: a coin was
// trading above its 4H 200EMA, and on this check it has come back down and is now
// touching that EMA (candle's high/low wick straddles the EMA level).
//
// IMPORTANT: this intentionally duplicates logic from index.html (the symbol-discovery
// pipeline, EMA calc, and touch classification) rather than sharing code with it, since
// this runs in Node/GitHub Actions, not the browser. If you change any of the
// following in index.html, mirror the same change here so the two don't drift apart:
//   - INITIAL_POOL_SIZE, MARKET_CAP_FLOOR, STABLECOIN_BLOCKLIST
//   - fetch7DayAvgVolume, fetchMarketCapMap, loadTop100SymbolsByVolume (symbol pipeline)
//   - ema() (EMA calculation)
//   - classifyTouch() (above/touching/below classification)
//
// DELIBERATE DIFFERENCE from index.html: this script calls api.binance.us, not
// api.binance.com. GitHub Actions runners run from US-based cloud-provider IP
// ranges, and Binance's global API (.com) returns HTTP 451 "restricted location"
// errors for those ranges - this doesn't affect index.html since browsers connect
// from the user's own residential IP, not a datacenter. Binance.US has a smaller
// symbol/trading-pair list than global Binance, so the watchlist built here may be
// meaningfully smaller than the page's top-100 - that's an accepted tradeoff for
// this to work at all from GitHub Actions, not a bug.
//
// State between runs (GitHub Actions runs are stateless — no shared memory between
// scheduled executions) is kept in alert_state.json, committed back to the repo by
// the workflow after each run. This is the only way the "was above, now touching"
// transition can be detected across separate runs.

const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set as environment variables (GitHub Actions secrets).');
  process.exit(1);
}

const STATE_FILE = path.join(__dirname, 'alert_state.json');

// ===================== ported from index.html — symbol discovery pipeline =====================

const INITIAL_POOL_SIZE = 300;
const MARKET_CAP_FLOOR = 450_000_000;

const STABLECOIN_BLOCKLIST = new Set([
  "USD1","RLUSD","BFUSD","USDS","USDC","USDE","DAI","FDUSD","TUSD",
  "PYUSD","USDP","GUSD","USTC","FRAX","LUSD","USDD","U"
]);

const FALLBACK_CRYPTO_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT",
  "LINKUSDT","DOTUSDT","MATICUSDT","LTCUSDT","UNIUSDT","ATOMUSDT","ETCUSDT","NEARUSDT",
  "APTUSDT","ARBUSDT","OPUSDT","SUIUSDT","FILUSDT","INJUSDT","TIAUSDT","SEIUSDT",
  "AAVEUSDT","MKRUSDT","RUNEUSDT","FTMUSDT","ALGOUSDT","XLMUSDT"
];

async function fetch7DayAvgVolume(symbol){
  const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=1d&limit=7`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('7d volume fetch failed '+symbol);
  const raw = await res.json();
  if(!raw.length) return 0;
  const totalQuoteVol = raw.reduce((sum,c) => sum + parseFloat(c[7]), 0);
  return totalQuoteVol / raw.length;
}

async function fetchMarketCapMap(){
  const map = new Map();
  for(const page of [1, 2]){
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('coingecko fetch failed, page '+page);
    const list = await res.json();
    if(!Array.isArray(list) || !list.length) break;
    list.forEach(coin => {
      if(!coin.symbol || coin.market_cap == null) return;
      const sym = coin.symbol.toUpperCase();
      const existing = map.get(sym);
      if(!existing || coin.market_cap > existing){
        map.set(sym, coin.market_cap);
      }
    });
  }
  return map;
}

async function loadTop100SymbolsByVolume(){
  const res = await fetch('https://api.binance.us/api/v3/ticker/24hr');
  if(!res.ok) throw new Error('ticker fetch failed');
  const all = await res.json();

  const usdtPairs = all.filter(t =>
    t.symbol.endsWith('USDT') &&
    !t.symbol.includes('UP') && !t.symbol.includes('DOWN') &&
    !t.symbol.includes('BULL') && !t.symbol.includes('BEAR') &&
    !STABLECOIN_BLOCKLIST.has(t.symbol.replace(/USDT$/, ''))
  );
  usdtPairs.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  const pool = usdtPairs.slice(0, INITIAL_POOL_SIZE).map(t => t.symbol);

  const ranked = [];
  const CHUNK = 15;
  for(let i=0; i<pool.length; i+=CHUNK){
    const chunk = pool.slice(i, i+CHUNK);
    const settled = await Promise.allSettled(chunk.map(async sym => ({
      symbol: sym,
      avgVol7d: await fetch7DayAvgVolume(sym)
    })));
    settled.forEach(r => { if(r.status==='fulfilled') ranked.push(r.value); });
  }
  ranked.sort((a,b) => b.avgVol7d - a.avgVol7d);

  let filtered = ranked;
  try{
    const mcapMap = await fetchMarketCapMap();
    filtered = ranked.filter(r => {
      const base = r.symbol.replace(/USDT$/, '');
      const mcap = mcapMap.get(base);
      return mcap != null && mcap >= MARKET_CAP_FLOOR;
    });
  } catch(e){
    console.error('market cap filter failed, falling back to volume-only ranking:', e.message);
    filtered = ranked;
  }

  const top100 = filtered.slice(0,100).map(r => r.symbol);
  return top100.length ? top100 : ranked.slice(0,100).map(r => r.symbol);
}

// ===================== ported from index.html — EMA calc and touch classification =====================

function ema(values, period){
  const k = 2/(period+1);
  let sma = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let prev = sma;
  for(let i=period;i<values.length;i++){
    prev = values[i]*k + prev*(1-k);
  }
  return prev;
}

function classifyTouch(candle, emaLevel){
  if(candle.l <= emaLevel && candle.h >= emaLevel) return 'touching';
  if(candle.l > emaLevel) return 'above';
  return 'below';
}

async function fetch4hCandlesAndEma(symbol){
  const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=4h&limit=1000`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('binance 4h fetch failed '+symbol);
  const raw = await res.json();
  const closes = raw.map(c => parseFloat(c[4]));
  const e = ema(closes, 200);
  const lastCandle = {
    l: parseFloat(raw[raw.length-1][3]),
    h: parseFloat(raw[raw.length-1][2])
  };
  return { lastCandle, ema200: e };
}

// ===================== Telegram delivery =====================

async function sendTelegramMessage(text){
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  });
  const data = await res.json();
  if(!data.ok){
    throw new Error('Telegram API error: ' + (data.description || JSON.stringify(data)));
  }
  return data;
}

// ===================== state persistence between runs =====================

function loadState(){
  try{
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(e){
    // first-ever run, or file missing/corrupt - start fresh rather than failing
    return {};
  }
}

function saveState(state){
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ===================== main =====================

async function main(){
  console.log(`[${new Date().toISOString()}] starting EMA touch alert check…`);

  let symbols;
  try{
    symbols = await loadTop100SymbolsByVolume();
    console.log(`watchlist: ${symbols.length} symbols`);
  } catch(e){
    console.error('failed to build watchlist:', e.message);
    await sendTelegramMessage(`⚠️ EMA Watch alert job failed to build the watchlist: ${e.message}`).catch(err => console.error('also failed to send failure notification:', err.message));
    process.exit(1);
  }

  const prevState = loadState();
  const newState = {};
  const touches = [];
  let failedSymbols = 0;

  for(const symbol of symbols){
    try{
      const { lastCandle, ema200 } = await fetch4hCandlesAndEma(symbol);
      const state = classifyTouch(lastCandle, ema200);
      const prev = prevState[symbol];

      if(state === 'touching' && prev === 'above'){
        const label = symbol.replace('USDT','');
        touches.push(label);
      }
      newState[symbol] = state;
    } catch(e){
      failedSymbols++;
      console.error(`check failed for ${symbol}:`, e.message);
      // keep whatever previous state existed for this symbol rather than dropping it,
      // so a single transient fetch failure doesn't reset its touch-detection baseline
      if(prevState[symbol]) newState[symbol] = prevState[symbol];
    }
  }

  // if too many symbols failed, treat this as a real failure worth flagging rather
  // than silently sending a (likely incomplete/wrong) result - threshold is somewhat
  // arbitrary but catches "Binance is down" style outages rather than a few one-off
  // misses, which are normal and expected occasionally
  const failureRate = symbols.length ? failedSymbols / symbols.length : 1;
  if(failureRate > 0.3){
    const msg = `⚠️ EMA Watch alert job: ${failedSymbols}/${symbols.length} symbol checks failed this run (over 30% failure rate) — results this run are unreliable, possible Binance API issue.`;
    console.error(msg);
    await sendTelegramMessage(msg).catch(err => console.error('also failed to send failure notification:', err.message));
    process.exit(1);
  }

  if(touches.length){
    console.log(`${touches.length} touch alert(s) found: ${touches.join(', ')}`);
    for(const label of touches){
      const msg = `🟣 <b>${label}</b> touched its 4H 200EMA\n${label} was trading above its 4H 200EMA and price just came back down to touch it.`;
      try{
        await sendTelegramMessage(msg);
        console.log(`sent Telegram alert for ${label}`);
      } catch(e){
        console.error(`failed to send Telegram alert for ${label}:`, e.message);
      }
    }
  } else {
    console.log('no touches found this run.');
  }

  saveState(newState);
  console.log(`[${new Date().toISOString()}] check complete. ${failedSymbols} symbol(s) failed, state saved for ${Object.keys(newState).length} symbols.`);
}

main().catch(async (e) => {
  console.error('unexpected error in main():', e);
  await sendTelegramMessage(`⚠️ EMA Watch alert job crashed unexpectedly: ${e.message}`).catch(err => console.error('also failed to send failure notification:', err.message));
  process.exit(1);
});

// ===================== PORTED WATCHLIST + ALERTS ENGINE =====================
// Brought across verbatim from the old single-file app (scoring, candle fetch,
// table rendering, chart modal, touch alerts). Journal and Lighter executor are
// migrated in separate steps - nothing here depends on those, but a few guarded
// calls (typeof populateJournalTickerList === 'function') exist for when they
// are added later, so they were left in place rather than stripped out.
const FALLBACK_CRYPTO_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT",
  "LINKUSDT","TONUSDT","SUIUSDT","DOTUSDT","LTCUSDT","NEARUSDT","APTUSDT","ARBUSDT",
  "OPUSDT","INJUSDT","ATOMUSDT","FILUSDT","RNDRUSDT","TIAUSDT","SEIUSDT","ETCUSDT",
  "HBARUSDT","UNIUSDT","AAVEUSDT","MKRUSDT","PEPEUSDT","WIFUSDT"
];

const SYMBOL_LIST_CACHE_KEY = 'ema_watch_top100_symbols_v7_bybit';
const SYMBOL_LIST_CACHE_TTL = 24 * 60 * 60 * 1000; // re-rank once a day; otherwise reuse cached list

let CRYPTO_SYMBOLS = FALLBACK_CRYPTO_SYMBOLS;

// Pulls all USDT linear perpetuals from Bybit's tickers endpoint (one call returns
// price, 24h volume, funding rate, and open interest together - no separate calls
// needed), ranks by quote-denominated volume (turnover24h), and keeps the top 100.
// Cached for a day so we don't re-rank on every single page load.
//
// Ranking is based on 7-DAY average daily volume rather than raw 24h volume, because
// 24h volume alone lets through "dogshit coins" that had one freak spike day - a 7-day
// average is a much better proxy for genuinely liquid, tradeable pairs. We use the
// tickers endpoint first to get a broad initial pool (top 300 by 24h turnover, cheap,
// 1 API call), then fetch 7 daily candles per symbol in that pool to compute the true
// 7-day average and re-rank by that before keeping the top 100.
const INITIAL_POOL_SIZE = 300;

// Market cap floor (USD) - anything below this gets excluded even if volume looks high,
// since volume alone can come from wash trading / pump-and-dump activity on low-quality
// coins. Originally $1B, lowered to $450M per user request to widen the pool a bit
// further down the market cap curve.
const MARKET_CAP_FLOOR = 450_000_000;

// Known stablecoins to exclude entirely - these trivially "trade above their 200EMA"
// with meaningless sub-1% moves since they're pegged to $1, which pollutes the
// EXCELLENT tier with noise that has nothing to do with the trading system.
const STABLECOIN_BLOCKLIST = new Set([
  "USD1","RLUSD","BFUSD","USDS","USDC","USDE","DAI","FDUSD","TUSD",
  "PYUSD","USDP","GUSD","USTC","FRAX","LUSD","USDD","U"
]);

async function fetch7DayAvgVolume(symbol){
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=7`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('7d volume fetch failed '+symbol);
  const data = await res.json();
  const raw = data?.result?.list || [];
  if(!raw.length) return 0;
  // Bybit kline array: [start, open, high, low, close, volume, turnover] - turnover
  // (index 6) is the quote-denominated (USDT) volume, the correct basis for ranking liquidity
  const totalQuoteVol = raw.reduce((sum,c) => sum + parseFloat(c[6]), 0);
  return totalQuoteVol / raw.length;
}

// Fetches market cap data from CoinGecko's public API (no key required) in bulk,
// using /coins/markets which returns up to 250 coins per call - so the entire top
// of the market fits in 1-2 requests rather than one call per symbol.
// Returns a Map of UPPERCASE base-asset symbol -> market cap in USD.
// Note: symbol collisions are possible (multiple coins can share a ticker, e.g. many
// projects use "AI" or generic names) - when that happens we keep whichever has the
// LARGER market cap, since that's almost certainly the "real" / intended asset.
async function fetchMarketCapMap(){
  const map = new Map();
  for(const page of [1, 2]){ // 2 pages x 250 = top 500 coins by market cap, plenty of coverage
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
  try{
    const cached = JSON.parse(localStorage.getItem(SYMBOL_LIST_CACHE_KEY) || 'null');
    if(cached && cached.timestamp && (Date.now() - cached.timestamp) < SYMBOL_LIST_CACHE_TTL && cached.symbols?.length){
      return cached.symbols;
    }
  } catch(e){ /* fall through to live fetch */ }

  const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  if(!res.ok) throw new Error('ticker fetch failed');
  const data = await res.json();
  const all = data?.result?.list || [];

  const usdtPairs = all.filter(t =>
    t.symbol.endsWith('USDT') &&
    /^[A-Z0-9]+USDT$/.test(t.symbol) && // ASCII-only ticker - excludes non-Latin-script
    // meme coins (e.g. a Chinese-character "Binance Life" token) that can clear the
    // market cap floor purely on hype/whale-concentrated volume despite having none
    // of the genuine liquidity/distribution the filter is meant to require
    !t.symbol.includes('UP') && !t.symbol.includes('DOWN') &&
    !t.symbol.includes('BULL') && !t.symbol.includes('BEAR') &&
    !STABLECOIN_BLOCKLIST.has(t.symbol.replace(/USDT$/, ''))
  );
  // initial broad cut by 24h turnover (quote-denominated volume), just to keep the
  // next step (7-day lookups) to a manageable number of API calls instead of querying
  // every USDT linear perp on Bybit
  usdtPairs.sort((a,b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h));
  const pool = usdtPairs.slice(0, INITIAL_POOL_SIZE).map(t => t.symbol);

  // now compute true 7-day average volume for everything in the pool, in chunks to
  // respect rate limits, then re-rank by that more stable metric
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

  // market cap filter: pull CoinGecko data and drop anything under the floor, or
  // anything we have no market cap data for at all (unmatched symbols are excluded
  // rather than assumed to pass, since that would defeat the point of the filter)
  let filtered = ranked;
  try{
    const mcapMap = await fetchMarketCapMap();
    filtered = ranked.filter(r => {
      const base = r.symbol.replace(/USDT$/, '');
      const mcap = mcapMap.get(base);
      return mcap != null && mcap >= MARKET_CAP_FLOOR;
    });
  } catch(e){
    console.error('market cap filter failed, falling back to volume-only ranking', e);
    // if CoinGecko is unreachable/rate-limited, fall back to the volume-only ranked
    // list rather than failing the whole page - filtering is a nice-to-have, not critical
    filtered = ranked;
  }

  const top100 = filtered.slice(0,100).map(r => r.symbol);

  try{
    localStorage.setItem(SYMBOL_LIST_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), symbols: top100 }));
  } catch(e){ /* storage full or unavailable, non-fatal */ }

  return top100.length ? top100 : ranked.slice(0,100).map(r => r.symbol);
}

// Stocks: now sourced from Lighter's RWA (Real World Asset) perp markets instead of
// Twelve Data. Lighter has native 4H/12H/1D/1W candles for these (same as crypto),
// so the daily-only approximation that used to apply here no longer does - stocks
// get the exact same real sweep-detection scoring as crypto. Pulled from Lighter's
// own RWA market specifications doc (equities + index/ETF categories), June 2026.
// Excludes RWA's commodities/FX/pre-IPO categories by user request - equities and
// index/ETF only.
const STOCK_SYMBOLS = [
  // equities
  "SKHYNIXUSD","SAMSUNGUSD","HYUNDAIUSD","NVDA","TSLA","CRCL","GOOGL","MSTR","MSFT",
  "AMZN","AAPL","COIN","META","INTC","HOOD","ASML","AMD","SNDK","MU","ORCL","MRVL",
  "CBRS","BOT","NBIS","NOW","RKLB","DELL","IBM","SPCX",
  // index / ETF
  "SPY","QQQ","DIA","BOTZ","MAGS","IWM","EWY","DRAM","US500","US100","H100"
];

const SCORE_LABELS = { excellent_plus: 'EXCELLENT+', excellent: 'EXCELLENT', good: 'GOOD', bad: 'BAD' };
const DIST_TIER_LABELS = {
  tight: 'tight to 4H 200EMA (within 2%)',
  extended: 'extended from 4H 200EMA (2-8%)',
  very_extended: 'very extended from 4H 200EMA (8%+) - chasing risk'
};

let currentMarket = 'crypto';
let cryptoData = [];
let stockData = [];
let sortKey = 'distPct';
let sortDir = -1;
let candleCache = {}; // key: SYMBOL_interval -> candles array
let currentChartSymbol = null;
let currentChartMarket = 'crypto'; // tracks which source ('crypto' or 'stocks') the open chart belongs to, so switchTimeframe fetches from the right API
let currentChartLabel = '';
let currentChart4hEma = null; // the 4H 200EMA price level, shown as reference line on all timeframes

function ema(values, period){
  const k = 2/(period+1);
  // seed with SMA of first `period` values
  let sma = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let prev = sma;
  for(let i=period;i<values.length;i++){
    prev = values[i]*k + prev*(1-k);
  }
  return prev;
}

// returns an array same length as values, with EMA at each index from `period-1` onward (null before that)
function emaSeriesFull(values, period){
  const k = 2/(period+1);
  const out = new Array(values.length).fill(null);
  if(values.length < period) return out;
  let sma = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let prev = sma;
  out[period-1] = sma;
  for(let i=period;i<values.length;i++){
    prev = values[i]*k + prev*(1-k);
    out[i] = prev;
  }
  return out;
}

// Detects fractal swing lows: a candle whose low is lower than the `side` candles
// immediately before AND after it. This is where retail stop-losses cluster (liquidity).
// For each detected low, also determines whether price has since swept below it and
// reclaimed (closed back above it with a bullish candle) - the sweep+reclaim setup.
function detectFractalLows(candles, side){
  const lows = [];
  const n = candles.length;
  for(let i=side; i<n-side; i++){
    const center = candles[i].l;
    let isLow = true;
    for(let j=i-side; j<=i+side; j++){
      if(j===i) continue;
      if(candles[j].l < center){ isLow = false; break; }
    }
    if(!isLow) continue;

    // check what happened AFTER this fractal formed: did price sweep below it,
    // then close back above it on a later candle (sweep + reclaim)?
    //
    // BUG FIX (found via WLFI false-positive EXCELLENT+ score, June 2026): sweepIndex
    // must lock to the FIRST candle that breaches the level, not get overwritten by
    // every subsequent candle that's still below it. The original code re-set
    // sweepIndex = k inside the swept_open branch unconditionally, so a coin that
    // breached a level once and simply kept trending down without reclaiming would
    // have sweepIndex creep forward to whatever the most recent candle happened to
    // be - making an old, stale breach look like it "just happened" purely because
    // price never came back above the level. A real sweep is the moment of breach,
    // not "still below it N candles later."
    let status = 'resting'; // never touched since forming
    let sweepIndex = null;
    for(let k=i+side+1; k<n; k++){
      if(candles[k].l < center){
        // price swept below the old low
        // now look for a bullish candle that closes back above the level
        if(candles[k].c > center && candles[k].c > candles[k].o){
          status = 'swept_reclaimed';
          sweepIndex = k;
          break;
        } else if(status !== 'swept_open'){
          // only lock sweepIndex on the FIRST breach - if we're already swept_open,
          // this is just a later candle still below the level, not a new sweep event
          status = 'swept_open';
          sweepIndex = k;
          // keep scanning forward in case a later candle reclaims it
        }
      } else if(status === 'swept_open' && candles[k].c > center && candles[k].c > candles[k].o){
        status = 'swept_reclaimed';
        sweepIndex = k;
        break;
      }
    }
    lows.push({ index: i, price: center, status, sweepIndex });
  }
  return lows;
}

// Detects fractal swing HIGHS (mirror of detectFractalLows). Used by the setup
// scoring system and kept available for future HH/HL structure checks.
function detectFractalHighs(candles, side){
  const highs = [];
  const n = candles.length;
  for(let i=side; i<n-side; i++){
    const center = candles[i].h;
    let isHigh = true;
    for(let j=i-side; j<=i+side; j++){
      if(j===i) continue;
      if(candles[j].h > center){ isHigh = false; break; }
    }
    if(isHigh) highs.push({ index: i, price: center });
  }
  return highs;
}

// Fetches funding rates for ALL USDT linear perpetual symbols in ONE call (Bybit's
// tickers endpoint with no symbol param returns the full category list, including
// fundingRate per symbol). Not every symbol the watchlist tracks is guaranteed to be
// in this exact category list, so this returns a partial map - missing symbols just
// show no data, which is expected, not a bug. Returns Map of symbol -> { fundingRate, nextFundingTime }.
async function fetchAllFundingRates(){
  const url = 'https://api.bybit.com/v5/market/tickers?category=linear';
  const res = await fetch(url);
  if(!res.ok) throw new Error('funding rate fetch failed');
  const data = await res.json();
  const list = data?.result?.list || [];
  const map = new Map();
  list.forEach(item => {
    map.set(item.symbol, {
      fundingRate: parseFloat(item.fundingRate),
      nextFundingTime: item.nextFundingTime ? parseInt(item.nextFundingTime) : null
    });
  });
  return map;
}

// Fetches open interest delta for a single symbol: current OI value vs ~24h ago.
// Uses Bybit's 1h-period historical OI endpoint and looks back 24 buckets. No bulk
// endpoint exists for this on Bybit either, so it's one call per symbol - kept to
// symbols actually being displayed, not run during the broader ranking/filtering step.
// Returns null if the symbol has no contract or the data is unavailable.
async function fetchOIDelta(symbol){
  try{
    const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=25`;
    const res = await fetch(url);
    if(!res.ok) return null;
    const data = await res.json();
    const list = data?.result?.list || [];
    if(!list || list.length < 2) return null;
    // Bybit returns most-recent-first, so reverse to get oldest -> newest for the delta calc
    const oldest = parseFloat(list[list.length-1].openInterest);
    const newest = parseFloat(list[0].openInterest);
    if(!oldest || isNaN(oldest) || isNaN(newest)) return null;
    return { deltaPct: ((newest - oldest) / oldest) * 100, current: newest };
  } catch(e){
    return null; // missing contract or rate-limited - treated as "no data", not an error
  }
}

// Classifies how far price has extended from the 4H 200EMA. A coin chasing 14% above
// the line is a structurally different entry than one sitting 0.3% above it fresh off
// a reclaim, even though both currently read "above EMA" - this tier surfaces that.
function classifyEmaDistance(distPct){
  const abs = Math.abs(distPct);
  if(abs <= 2) return 'tight';
  if(abs <= 8) return 'extended';
  return 'very_extended';
}

// Maps this app's own interval strings to Bybit's kline interval enum, which uses
// raw minutes (or D/W/M) rather than Binance-style "4h"/"12h"/"3d" strings.
const BYBIT_INTERVAL_MAP = { '4h': '240', '12h': '720', '1d': 'D', '1w': 'W' }; // 3d has
// no native Bybit interval, so it's handled separately below via daily-candle aggregation
// rather than silently substituting daily data under a misleading "3d" label.

async function fetchBybitCandles(symbol, ourInterval){
  if(ourInterval === '3d'){
    // Bybit has no native 3-day interval - pull enough daily candles and aggregate
    // them into 3-day buckets ourselves so the EMA still reflects real 3D bars,
    // not a silent substitution of daily data under a misleading label.
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=1000`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('bybit fetch failed '+symbol);
    const data = await res.json();
    const raw = (data?.result?.list || []).slice().reverse(); // Bybit returns newest-first; we need oldest-first
    const daily = raw.map(c => ({
      t: parseInt(c[0]), o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5])
    }));
    const buckets = [];
    for(let i=0; i<daily.length; i+=3){
      const group = daily.slice(i, i+3);
      if(!group.length) continue;
      buckets.push({
        t: group[0].t,
        o: group[0].o,
        h: Math.max(...group.map(g=>g.h)),
        l: Math.min(...group.map(g=>g.l)),
        c: group[group.length-1].c,
        v: group.reduce((s,g)=>s+g.v, 0)
      });
    }
    const closes = buckets.map(c=>c.c);
    const emaSeries = emaSeriesFull(closes, 200);
    return buckets.map((c,i)=>({ ...c, ema: emaSeries[i] }));
  }

  const bybitInterval = BYBIT_INTERVAL_MAP[ourInterval];
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=1000`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('bybit fetch failed '+symbol);
  const data = await res.json();
  const raw = (data?.result?.list || []).slice().reverse(); // Bybit returns newest-first; we need oldest-first for EMA math
  const closes = raw.map(c => parseFloat(c[4]));
  const emaSeries = emaSeriesFull(closes, 200);
  const candles = raw.map((c,i)=>({
    t: parseInt(c[0]), o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]),
    v: parseFloat(c[5]), // base asset volume for this candle
    ema: emaSeries[i]
  }));
  return candles;
}

async function fetchBybit4h(symbol, fundingMap){
  // fetch 4H (primary), 12H, 3D candles, plus OI delta - all in parallel since they're
  // independent requests and this keeps total wait time down rather than adding a 4th
  // sequential step on top of the existing three.
  const [candles, candles12h, candles3d, oiDelta] = await Promise.all([
    fetchBybitCandles(symbol, '4h'),
    fetchBybitCandles(symbol, '12h'),
    fetchBybitCandles(symbol, '3d'),
    fetchOIDelta(symbol)
  ]);
  const closes = candles.map(c=>c.c);
  const lastClose = closes[closes.length-1];
  const prevClose = closes[closes.length-2];
  const e = ema(closes, 200);
  candleCache[symbol+'_4h'] = candles;
  candleCache[symbol+'_12h'] = candles12h;
  candleCache[symbol+'_3d'] = candles3d;

  // relative volume: current candle's volume vs the average of the prior 20 candles.
  // a spike here often coincides with a sweep or a real breakout, not just noise.
  const lastCandle = candles[candles.length-1];
  const lookback = candles.slice(-21, -1); // 20 candles before the current one
  const avgVol = lookback.length ? lookback.reduce((s,c)=>s+c.v,0)/lookback.length : null;
  const relVol = (avgVol && avgVol > 0) ? (lastCandle.v / avgVol) : null;

  const above = lastClose > e;
  const distPct = ((lastClose - e)/e)*100;
  const score = computeSetupScore(above, { '4h': candles, '12h': candles12h, '3d': candles3d }, distPct);
  const SCORE_RANK = { excellent_plus: 4, excellent: 3, good: 2, bad: 1 };

  // funding rate isn't available for every symbol in the same category list (rare
  // edge case e.g. symbol delisted mid-session) - fundingInfo is null in that case,
  // which the UI treats as "no data" rather than an error
  const fundingInfo = fundingMap ? fundingMap.get(symbol) : null;

  return {
    symbol: symbol.replace('USDT',''),
    rawSymbol: symbol,
    price: lastClose,
    ema200: e,
    above,
    distPct,
    distTier: classifyEmaDistance(distPct),
    chg4h: ((lastClose - prevClose)/prevClose)*100,
    relVol,
    score,
    scoreRank: SCORE_RANK[score.tier],
    fundingRate: fundingInfo ? fundingInfo.fundingRate : null,
    oiDeltaPct: oiDelta ? oiDelta.deltaPct : null,
    barsAvailable: candles.length,
    insufficientHistory: candles.length < 200,
    candles
  };
}

// Removes candleCache entries for symbols no longer in the current watchlist.
// Without this, candleCache grows forever over a long-running session - each entry
// holds up to 1000 candles per timeframe (4h/12h/3d), and the watchlist composition
// shifts over time as the top-100-by-volume ranking changes, so old entries for
// coins that rotated out would otherwise just accumulate indefinitely. Called
// whenever CRYPTO_SYMBOLS is refreshed, not on every render, since pruning itself
// is cheap but only needs to happen when the watchlist composition could have changed.
function pruneCandleCache(currentSymbols){
  const keep = new Set(currentSymbols);
  Object.keys(candleCache).forEach(key => {
    // keys are formatted SYMBOL_interval, e.g. "BTCUSDT_4h" - strip the trailing
    // _4h/_12h/_3d to recover the bare symbol for the lookup
    const symbol = key.replace(/_(4h|12h|3d)$/, '');
    if(!keep.has(symbol)) delete candleCache[key];
  });
}

// ===================== STOCKS (Lighter RWA markets) =====================
// Stocks now pull real 4H/12H/1D/1W candles from Lighter's public, no-auth candles
// endpoint - the same RWA equities/index markets visible under Lighter's RWA tab.
// This replaced an earlier Twelve Data integration that only had daily-interval
// data on the free tier (a real approximation, not just a label) - Lighter gives
// genuine 4H bars, so stocks now run through the EXACT same sweep-detection scoring
// engine as crypto (computeSetupScore, fractal lows, distance tiers), not a
// stripped-down approximation. Reuses fetchLighterMarketMap (defined further down,
// originally built for the trade executor) to resolve ticker -> market_id, since
// that lookup is already exactly what's needed here.
//
// Lighter has no native 3-day interval either (same gap as Bybit), so 3D candles
// are built the same way: pull 1d candles and aggregate into 3-day buckets.
const LIGHTER_INTERVAL_MAP = { '4h': '4h', '12h': '12h', '1d': '1d', '1w': '1w' };

async function fetchLighterCandles(marketId, ourInterval){
  // Lighter's candles endpoint requires explicit start/end timestamps plus count_back -
  // request a window comfortably larger than 1000 bars back from now so there's enough
  // history for a real 200EMA, mirroring the same "200+ bars of lookback" intent as the
  // Bybit path's limit=1000.
  const now = Date.now();

  if(ourInterval === '3d'){
    // aggregate 1d candles into 3-day buckets, same approach as fetchBybitCandles
    const start = now - 1000 * 24 * 60 * 60 * 1000;
    const url = `https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=${marketId}&resolution=1d&start_timestamp=${start}&end_timestamp=${now}&count_back=1000`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('lighter candle fetch failed market_id='+marketId);
    const data = await res.json();
    const raw = data?.c || [];
    const daily = raw.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
    const buckets = [];
    for(let i=0; i<daily.length; i+=3){
      const group = daily.slice(i, i+3);
      if(!group.length) continue;
      buckets.push({
        t: group[0].t,
        o: group[0].o,
        h: Math.max(...group.map(g=>g.h)),
        l: Math.min(...group.map(g=>g.l)),
        c: group[group.length-1].c,
        v: group.reduce((s,g)=>s+g.v, 0)
      });
    }
    const closes = buckets.map(c=>c.c);
    const emaSeries = emaSeriesFull(closes, 200);
    return buckets.map((c,i)=>({ ...c, ema: emaSeries[i] }));
  }

  const resolution = LIGHTER_INTERVAL_MAP[ourInterval];
  // window size scales with bar duration so ~1000 bars actually fit in the requested
  // start/end range - a fixed lookback window would silently truncate history on
  // coarser timeframes (e.g. 1w needs ~19 years back for 1000 bars, 4h only ~167 days)
  const MS_PER_BAR = { '4h': 4*60*60*1000, '12h': 12*60*60*1000, '1d': 24*60*60*1000, '1w': 7*24*60*60*1000 };
  const start = now - 1000 * MS_PER_BAR[ourInterval];
  const url = `https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=${marketId}&resolution=${resolution}&start_timestamp=${start}&end_timestamp=${now}&count_back=1000`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('lighter candle fetch failed market_id='+marketId);
  const data = await res.json();
  const raw = data?.c || []; // Lighter returns oldest-first already, unlike Bybit
  const closes = raw.map(c => c.c);
  const emaSeries = emaSeriesFull(closes, 200);
  return raw.map((c,i) => ({
    t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
    ema: emaSeries[i]
  }));
}

// Mirrors fetchBybit4h's shape/return object exactly, so buildRows/openChart/render
// work on stock rows with zero special-casing. Funding/OI aren't wired up for RWA
// markets yet (out of scope for this pass) - left null, which the UI already treats
// as "no data" rather than an error, same as crypto symbols missing a Bybit contract.
async function fetchLighterStock(symbol, marketId){
  const [candles, candles12h, candles3d] = await Promise.all([
    fetchLighterCandles(marketId, '4h'),
    fetchLighterCandles(marketId, '12h'),
    fetchLighterCandles(marketId, '3d')
  ]);
  const closes = candles.map(c=>c.c);
  const lastClose = closes[closes.length-1];
  const prevClose = closes[closes.length-2];
  const e = ema(closes, 200);
  candleCache[symbol+'_4h'] = candles;
  candleCache[symbol+'_12h'] = candles12h;
  candleCache[symbol+'_3d'] = candles3d;

  const lastCandle = candles[candles.length-1];
  const lookback = candles.slice(-21, -1);
  const avgVol = lookback.length ? lookback.reduce((s,c)=>s+c.v,0)/lookback.length : null;
  const relVol = (avgVol && avgVol > 0) ? (lastCandle.v / avgVol) : null;

  const above = lastClose > e;
  const distPct = ((lastClose - e)/e)*100;
  const score = computeSetupScore(above, { '4h': candles, '12h': candles12h, '3d': candles3d }, distPct);
  const SCORE_RANK = { excellent_plus: 4, excellent: 3, good: 2, bad: 1 };

  return {
    symbol,
    rawSymbol: symbol,
    price: lastClose,
    ema200: e,
    above,
    distPct,
    distTier: classifyEmaDistance(distPct),
    chg4h: ((lastClose - prevClose)/prevClose)*100,
    relVol,
    score,
    scoreRank: SCORE_RANK[score.tier],
    fundingRate: null,
    oiDeltaPct: null,
    barsAvailable: candles.length,
    insufficientHistory: candles.length < 200,
    candles
  };
}

// Loads all STOCK_SYMBOLS via Lighter. No rate-limit throttling needed (unlike the
// old Twelve Data path) - Lighter's public candles endpoint has no documented
// free-tier cap like that, so all symbols fetch in parallel chunks the same way
// crypto does. Symbols Lighter doesn't have a market_id for (naming mismatch,
// delisted, etc.) are skipped, not treated as a fatal error for the whole batch.
async function loadStocksFromLighter(){
  const marketMap = await fetchLighterMarketMap();
  if(!marketMap) throw new Error('could not resolve Lighter market list');

  const results = [];
  const CHUNK_SIZE = 10;
  const chunks = [];
  for(let i=0;i<STOCK_SYMBOLS.length;i+=CHUNK_SIZE) chunks.push(STOCK_SYMBOLS.slice(i,i+CHUNK_SIZE));
  for(const chunk of chunks){
    const settled = await Promise.allSettled(chunk.map(sym => {
      const market = marketMap[sym.toUpperCase()];
      if(!market) return Promise.reject(new Error('no Lighter market for '+sym));
      return fetchLighterStock(sym, market.marketIndex);
    }));
    settled.forEach(r => {
      if(r.status==='fulfilled') results.push(r.value);
      else console.error('stock fetch failed:', r.reason);
    });
  }
  return results;
}

async function loadCrypto(){
  CRYPTO_SYMBOLS = await loadTop100SymbolsByVolume().catch(()=>FALLBACK_CRYPTO_SYMBOLS);
  pruneCandleCache(CRYPTO_SYMBOLS);

  // fetch funding rates ONCE for everything (one bulk call), rather than per-symbol -
  // if this fails (e.g. futures API unreachable), we proceed with fundingMap = null and
  // every coin just shows no funding data, which degrades gracefully instead of breaking the page
  const fundingMap = await fetchAllFundingRates().catch(e => {
    console.error('funding rate fetch failed, proceeding without funding data', e);
    return null;
  });

  const results = [];
  const chunks = [];
  const CHUNK_SIZE = 10; // 100 symbols / 10 per chunk = 10 sequential batches, keeps Bybit happy
  for(let i=0;i<CRYPTO_SYMBOLS.length;i+=CHUNK_SIZE) chunks.push(CRYPTO_SYMBOLS.slice(i,i+CHUNK_SIZE));
  for(const chunk of chunks){
    const settled = await Promise.allSettled(chunk.map(sym => fetchBybit4h(sym, fundingMap)));
    settled.forEach(r => { if(r.status==='fulfilled') results.push(r.value); });
  }
  return results;
}

function fmtPrice(p){

  if(p >= 1000) return p.toLocaleString(undefined,{maximumFractionDigits:2});
  if(p >= 1) return p.toFixed(2);
  return p.toFixed(6);
}

// Builds a direct TradingView chart link so the user can open a symbol in TradingView
// for deeper analysis - extra indicators, drawing tools, etc - that this app
// intentionally doesn't try to replicate. For crypto, always uses the BYBIT exchange
// prefix since that's this app's own crypto data source, so the chart the user lands
// on matches what they were just looking at here. For stocks (Lighter RWA tickers),
// no exchange prefix is used - TradingView's own symbol search resolves a bare ticker
// to its best match, which avoids having to maintain a per-ticker exchange map (some
// of these are NASDAQ, some NYSE, some Korea-listed ADRs that wouldn't map cleanly
// to a single TradingView exchange prefix anyway).
// No timeframe param is set - opens to TradingView's own default rather than trying
// to map this app's 4H/12H/1D/3D/1W buttons onto TradingView's interval scheme, since
// that mapping isn't always 1:1 (e.g. TradingView's interval params are in raw
// minutes, not all of this app's timeframes translate cleanly).
function tradingViewUrl(rawSymbol, market){
  if(market === 'stocks'){
    return `https://www.tradingview.com/chart/?symbol=${rawSymbol}`;
  }
  return `https://www.tradingview.com/chart/?symbol=BYBIT:${rawSymbol}.P`;
}

// Builds the <tr> HTML for a list of coins. Extracted out of render() so the same
// row markup can be reused for both the main (above-EMA) table and the collapsible
// below-EMA section, without duplicating all the badge/dot/confluence logic twice.
function buildRows(list){
  return list.map(d=>{
    const rvol = d.relVol;
    const rvolHigh = rvol != null && rvol >= 1.5;
    const rvolBadge = rvol != null
      ? `<span class="rvol-badge ${rvolHigh?'hot':''}" title="current 4H volume vs 20-candle average">${rvol.toFixed(1)}x</span>`
      : '';
    const score = d.score;
    const sweptSummaryForTooltip = score && score.sweptTFs.length
      ? 'swept on: ' + score.sweptTFs.map(s => `${s.label} (${s.candlesAgo} candle${s.candlesAgo===1?'':'s'} ago)`).join(', ')
      : 'no recent sweep detected';
    const scoreBadge = score
      ? `<span class="score-badge ${score.tier}" title="${sweptSummaryForTooltip}">${SCORE_LABELS[score.tier]}</span>`
      : '';

    // swept label shows which timeframe(s) + exactly how many candles ago the sweep
    // happened. With the tightened per-timeframe freshness windows (max 3 bars on 4H,
    // 1 bar on 12H/3D), anything that still qualifies is inherently fresh by definition -
    // there's no longer a meaningful "aging but still counted" middle ground to fade.
    let sweptLabel = '<span class="swept-tfs none">—</span>';
    if(score && score.sweptTFs.length){
      const tfText = score.sweptTFs.map(s => s.label).join('+');
      const freshestAgo = Math.min(...score.sweptTFs.map(s => s.candlesAgo));
      sweptLabel = `<span class="swept-tfs fresh">${tfText}</span><span class="swept-ago">${freshestAgo}c ago</span>`;
    }

    // distance tier shown as a tiny dot next to the % rather than its own column -
    // tight=dim, extended=amber, very_extended=red, signalling "chasing" without shouting
    const distDot = `<span class="dist-tier-dot ${d.distTier}" title="${DIST_TIER_LABELS[d.distTier]}"></span>`;

    // funding rate gets its own column (FUNDING) rather than sitting inline next to
    // the score badge - keeps the score column a clean, consistently-centered badge,
    // and gives funding its own readable, sortable-feeling place in the table. OI
    // delta stays tooltip-only on the small dot next to the funding text, since that
    // one wasn't asked to be made visible inline.
    let fundingCellHtml = '<span class="funding-text flat">—</span>';
    const hasFunding = d.fundingRate != null;
    const hasOI = d.oiDeltaPct != null;
    if(hasFunding || hasOI){
      const tooltipParts = [];
      if(hasFunding) tooltipParts.push(`funding ${d.fundingRate>=0?'+':''}${(d.fundingRate*100).toFixed(3)}%`);
      if(hasOI) tooltipParts.push(`OI ${d.oiDeltaPct>=0?'+':''}${d.oiDeltaPct.toFixed(1)}% (24h)`);

      // tone prioritizes funding rate when available (negative funding = crowded shorts,
      // a contrarian-bullish tell that pairs well with this system's sweep-hunting logic),
      // falling back to OI delta direction when funding data is missing for this symbol
      let tone = 'flat';
      if(hasFunding){
        tone = d.fundingRate < 0 ? 'neg' : (d.fundingRate > 0.0003 ? 'pos' : 'flat');
      } else if(hasOI){
        tone = d.oiDeltaPct > 5 ? 'pos' : (d.oiDeltaPct < -5 ? 'neg' : 'flat');
      }

      const fundingText = hasFunding
        ? `<span class="funding-text ${tone}">${d.fundingRate>=0?'+':''}${(d.fundingRate*100).toFixed(3)}%</span>`
        : '<span class="funding-text flat">—</span>';
      fundingCellHtml = `${fundingText}<span class="conf-dot ${tone}" title="${tooltipParts.join(' · ')}"></span>`;
    }

    // visual triage: Excellent/Excellent+ rows get a stronger row-level highlight (not
    // just the badge) so they catch the eye while scanning the list, without being loud
    // enough to read as a warning/alert state. Bad/Good stay visually neutral.
    const tierRowClass = score && (score.tier === 'excellent' || score.tier === 'excellent_plus')
      ? `row-highlight-${score.tier}`
      : '';

    // flags symbols whose 4H 200EMA isn't trustworthy yet - fewer than 200 real 4H
    // candles means the EMA is still converging, so DIST% and score can be way off
    // (e.g. BOT showing +108% on a freshly-listed RWA market). Sits in the symbol
    // cell, before DIST%/SCORE, so it's seen first.
    const immatureBadge = d.insufficientHistory
      ? `<span class="immature-badge" title="only ${d.barsAvailable} of 200 4H candles available - EMA/score not yet reliable">LOW HIST</span>`
      : '';

    return `
    <tr class="clickable ${tierRowClass}" onclick="openChart('${d.rawSymbol||d.symbol}')">
      <td class="sym">
        <span class="strip ${d.above?'above':'below'}"></span>${d.symbol}${immatureBadge}
        <a href="${tradingViewUrl(d.rawSymbol||d.symbol, currentMarket)}" target="_blank" rel="noopener" class="tv-link" title="open in TradingView" onclick="event.stopPropagation()">TV↗</a>
      </td>
      <td class="num pct ${d.distPct>=0?'pos':'neg'}">${d.distPct>=0?'+':''}${d.distPct.toFixed(2)}%${distDot}</td>
      <td class="num rvol-cell">${rvolBadge}</td>
      <td class="score-cell">${scoreBadge}</td>
      <td class="funding-cell">${fundingCellHtml}</td>
      <td class="swept-cell">${sweptLabel}</td>
    </tr>`;
  }).join('');
}

const TABLE_HEAD = `
  <thead>
    <tr>
      <th class="col-symbol ${sortKey==='symbol'?'sorted':''}" onclick="sortBy('symbol')">SYMBOL</th>
      <th class="col-dist ${sortKey==='distPct'?'sorted':''}" onclick="sortBy('distPct')">DIST % FROM 200EMA</th>
      <th class="col-rvol">RVOL</th>
      <th class="col-score ${sortKey==='scoreRank'?'sorted':''}" onclick="sortBy('scoreRank')">SCORE</th>
      <th class="col-funding">FUNDING</th>
      <th class="col-swept">SWEPT</th>
    </tr>
  </thead>`;

function render(){
  const data = currentMarket === 'crypto' ? cryptoData : stockData;
  const content = document.getElementById('content');

  // Stocks are fetched separately from crypto (own loadStocksManual call, not bundled
  // into the main refresh button) since they're a fully distinct watchlist - but with
  // Lighter as the data source there's no rate limit to manage anymore, so this is
  // just a normal loading/empty state, not the old throttled-batch messaging.
  if(currentMarket === 'stocks' && !data.length){
    content.innerHTML = stocksLoading
      ? `<div class="loading">pulling 4H candles…</div>`
      : `<div class="err" style="display:flex;flex-direction:column;gap:10px;align-items:center;">
           <div>no stock data loaded yet.</div>
           <button id="stocksFetchBtn" class="refresh-btn" onclick="loadStocksManual()">↻ fetch stock data</button>
         </div>`;
    return;
  }
  if(!data.length){
    content.innerHTML = '<div class="err">no data loaded — check connection or refresh</div>';
    return;
  }

  // sort once, then split into above/below groups for the two separate tables -
  // each group keeps its own internal closest-to-EMA-first ordering from the sort step
  const sorted = [...data].sort((a,b)=>{
    if(sortKey === 'symbol') return a.symbol.localeCompare(b.symbol)*sortDir*-1;
    if(sortKey === 'distPct'){
      // within each group (above/below are now rendered as separate tables, so this
      // grouping no longer needs to interleave them), sort by EMA distance. The
      // above/below split itself always stays above-first (that's tied to how the
      // two-table layout works, not something the DIST% sort toggle should affect) -
      // sortDir only controls whether each group orders closest-to-farthest or
      // farthest-to-closest. Default (sortDir=-1, first click) is closest-first,
      // matching the page's long-standing default presentation.
      if(a.above !== b.above) return a.above ? -1 : 1;
      return (Math.abs(a.distPct) - Math.abs(b.distPct)) * sortDir * -1;
    }
    return (a[sortKey]-b[sortKey])*sortDir;
  });

  const aboveList = sorted.filter(d => d.above);
  const belowList = sorted.filter(d => !d.above);

  document.getElementById('aboveCount').textContent = aboveList.length;
  document.getElementById('totalCount').textContent = data.length;

  const note = currentMarket === 'stocks'
    ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
         <button id="stocksFetchBtn" class="refresh-btn" onclick="loadStocksManual()" ${stocksLoading?'disabled':''}>${stocksLoading?'fetching…':'↻ refresh stock data'}</button>
       </div>`
    : '';

  const aboveRows = buildRows(aboveList);
  const belowRows = buildRows(belowList);

  // Preserve the below-EMA <details> section's open/closed state across re-renders.
  // Without this, expanding it and then having ANY re-render fire afterward (most
  // notably the hourly alert check, which calls render() every time it runs even
  // if nothing alert-worthy happened) would silently snap it back closed, since a
  // freshly-templated <details> element always starts collapsed unless explicitly
  // told otherwise.
  const belowEmaWasOpen = document.querySelector('.below-ema-section')?.open || false;

  content.innerHTML = `
    ${note}
    <table>
      ${TABLE_HEAD}
      <tbody>${aboveRows || '<tr><td colspan="6" class="empty-note">no coins currently above their 4H 200EMA</td></tr>'}</tbody>
    </table>

    <details class="below-ema-section" ${belowEmaWasOpen ? 'open' : ''}>
      <summary>below 200EMA (${belowList.length}) — click to expand</summary>
      <table>
        ${TABLE_HEAD}
        <tbody>${belowRows || '<tr><td colspan="6" class="empty-note">no coins currently below their 4H 200EMA</td></tr>'}</tbody>
      </table>
    </details>
  `;
}

// Builds the Dashboard's "excellent setups right now" list - deliberately the
// opposite of render()'s full table: only EXCELLENT/EXCELLENT+ scored symbols,
// combined across BOTH crypto and stocks into one flat list, no sort/tabs/
// below-EMA section. Each row tags its own market explicitly (rather than relying
// on the global currentMarket toggle, which belongs to the Strategies tab and may
// not match a given row) so openChart resolves correctly regardless of which
// market the Strategies tab happens to be sitting on. Called from the same refresh
// points as render() (loadAll/loadStocksManual) so it never drifts out of sync.
function renderDashboardHighlights(){
  const target = document.getElementById('dashboardHighlights');
  if(!target) return;

  const tagged = [
    ...cryptoData.map(d => ({...d, _market:'crypto'})),
    ...stockData.map(d => ({...d, _market:'stocks'}))
  ];
  const excellentOnly = tagged.filter(d => d.score && (d.score.tier === 'excellent' || d.score.tier === 'excellent_plus'));

  if(!excellentOnly.length){
    target.innerHTML = `<div class="empty-note" style="padding:24px 0;">nothing excellent right now — browse the Trade tab for other setups</div>`;
    return;
  }

  // excellent+ first, then by closeness to the 4H 200EMA within each tier - the
  // same "closest first" convention as the main watchlist's default sort
  excellentOnly.sort((a,b) => {
    if(a.score.tier !== b.score.tier) return a.score.tier === 'excellent_plus' ? -1 : 1;
    return Math.abs(a.distPct) - Math.abs(b.distPct);
  });

  target.innerHTML = excellentOnly.map(d => {
    const scoreBadge = `<span class="score-badge ${d.score.tier}">${SCORE_LABELS[d.score.tier]}</span>`;
    const distDot = `<span class="dist-tier-dot ${d.distTier}" title="${DIST_TIER_LABELS[d.distTier]}"></span>`;
    const marketTag = `<span class="pr-mkt">${d._market}</span>`;
    return `
    <div class="potential-row" onclick="openChart('${d.rawSymbol||d.symbol}', '${d._market}')">
      <div class="pr-left">
        <span class="strip ${d.above?'above':'below'}"></span>
        <div><span class="pr-sym">${d.symbol}</span>${marketTag}</div>
      </div>
      <div class="pr-right">
        <span class="pct ${d.distPct>=0?'pos':'neg'}">${d.distPct>=0?'+':''}${d.distPct.toFixed(2)}%${distDot}</span>
        ${scoreBadge}
      </div>
    </div>`;
  }).join('');
}

// Checks a single timeframe's candles for a RECENT swept structural low: a fractal low
// that has been swept (price traded below it) within the last `recentWindow` candles.
// "Swept" alone counts here - it does not need to be reclaimed yet, since the scoring
// system treats "swept" itself as the relevant liquidity event, with reclaim/structure
// shift handled separately by the above/below-EMA check.
// Returns null if no recent sweep, or { candlesAgo } for the MOST RECENT qualifying sweep
// on this timeframe (lower candlesAgo = fresher = more actionable right now).
//
// Per-timeframe freshness windows (max bars old a sweep can be and still count toward
// the score): 3 candles on 4H, but only 1 candle on 12H and 1 on 3D, since a single
// 12H/3D candle already spans far more real time than 3 4H candles - this keeps
// "freshness" roughly equivalent across timeframes rather than one timeframe staying
// "fresh" for an unreasonably long stretch. Tightened down from a uniform 12-candle
// window after the original window let stale sweeps (weeks old) still score as Excellent.
const SWEEP_FRESHNESS_WINDOWS = { '4H': 3, '12H': 1, '3D': 1 };

// How many recent candles' worth of fractal lows are even ELIGIBLE to be considered,
// before the freshness window is applied on top. This MUST match what the chart modal
// actually displays (TF_BAR_COUNTS), otherwise the scorer can find an ancient fractal
// low from outside the visible chart - one with no relevance to current structure - and
// flag a coincidental dip below it as a "fresh sweep" even though nothing meaningful
// just happened on the chart the user is actually looking at. This was a real bug: a
// coin could score Excellent purely because price brushed some swing low from months
// ago that isn't even visible in the 120-candle chart window.
const FRACTAL_LOOKBACK_WINDOWS = { '4H': 120, '12H': 120, '3D': 100 };

function getRecentSweepInfo(candles, side, recentWindow, lookbackWindow){
  if(!candles || candles.length < side*2+2) return null;
  // restrict to the same recent slice the chart itself shows, so fractal lows from
  // outside that visible window are never even considered
  const scoped = lookbackWindow ? candles.slice(-lookbackWindow) : candles;
  if(scoped.length < side*2+2) return null;
  const fractals = detectFractalLows(scoped, side);
  const n = scoped.length;
  let best = null; // tracks the LOWEST candlesAgo (freshest) qualifying sweep
  fractals.forEach(f => {
    if((f.status === 'swept_open' || f.status === 'swept_reclaimed') && f.sweepIndex != null){
      const candlesAgo = n - 1 - f.sweepIndex;
      if(candlesAgo <= recentWindow && (best === null || candlesAgo < best)){
        best = candlesAgo;
      }
    }
  });
  return best === null ? null : { candlesAgo: best };
}

// kept for any external callers expecting a boolean - now backed by getRecentSweepInfo
function hasRecentSweep(candles, side, recentWindow, lookbackWindow){
  return getRecentSweepInfo(candles, side, recentWindow, lookbackWindow) !== null;
}

// Returns which of the 4H/12H/3D timeframes have a recent swept structural low, along
// with how fresh each sweep is, so the UI can show exactly where (and how recently)
// the liquidity was taken. Each timeframe uses its OWN freshness window AND its own
// lookback scope (matching the chart's visible window) per the constants above.
function findSweptTimeframes(candleSets){
  const hit = [];
  const tfConfigs = [['4H','4h'], ['12H','12h'], ['3D','3d']];
  tfConfigs.forEach(([label, key]) => {
    const info = getRecentSweepInfo(candleSets[key], 3, SWEEP_FRESHNESS_WINDOWS[label], FRACTAL_LOOKBACK_WINDOWS[label]);
    if(info) hit.push({ label, candlesAgo: info.candlesAgo });
  });
  return hit;
}

// The scoring system:
//   Bad        = price below 4H 200EMA, AND no recent sweep on 4H/12H/3D
//   Good       = price below 4H 200EMA, AND a recent sweep on 4H/12H/3D
//   Excellent  = price above 4H 200EMA, AND a recent sweep on EXACTLY ONE of 4H/12H/3D
//   Excellent+ = price above 4H 200EMA, AND a recent sweep on TWO OR MORE of 4H/12H/3D
//                at once - multiple timeframes lining up on the same liquidity event is
//                a meaningfully stronger signal than a sweep showing up on just one
// (HH/HL structure check intentionally omitted for now per user request - may be added later)
//
// On top of the above, EMA distance acts as a CAP on the final tier (not a replacement -
// the small dist-tier dot in the UI still independently shows tight/extended/very_extended
// regardless of this cap). The reasoning: a coin can have a textbook-perfect sweep and
// still be a bad trade if price has already run too far from the EMA, since this system
// never chases. Distance <=2% applies no cap (sweep logic decides freely). Distance 2-6%
// caps the result at Good even if the sweep logic alone would say Excellent/Excellent+.
// Distance >6% caps the result at Bad regardless of how clean the sweep looks.
const SCORE_TIER_ORDER = ['bad', 'good', 'excellent', 'excellent_plus'];

function capScoreByDistance(tier, distPct){
  const abs = Math.abs(distPct);
  let capTier;
  if(abs <= 2) capTier = 'excellent_plus'; // no real cap - excellent_plus is the ceiling anyway
  else if(abs <= 6) capTier = 'good';
  else capTier = 'bad';

  const tierRank = SCORE_TIER_ORDER.indexOf(tier);
  const capRank = SCORE_TIER_ORDER.indexOf(capTier);
  return tierRank <= capRank ? tier : capTier;
}

function computeSetupScore(above, candleSets, distPct){
  const sweptTFs = findSweptTimeframes(candleSets);
  const hasSweep = sweptTFs.length > 0;

  let tier;
  if(above && hasSweep){
    tier = sweptTFs.length >= 2 ? 'excellent_plus' : 'excellent';
  } else if(!above && hasSweep){
    tier = 'good';
  } else {
    tier = 'bad';
  }

  if(distPct != null) tier = capScoreByDistance(tier, distPct);

  return { tier, sweptTFs };
}

function sortBy(key){
  if(sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = -1; }
  render();
}

async function loadAll(){
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  if(currentMarket === 'crypto') document.getElementById('content').innerHTML = '<div class="loading">pulling 4H candles…</div>';
  try{
    cryptoData = await loadCrypto();
  } catch(e){
    console.error(e);
    cryptoData = [];
  }
  btn.disabled = false;
  if(currentMarket === 'crypto') render();
  renderDashboardHighlights(); // Dashboard's excellent-only list needs to refresh every time crypto data changes, regardless of which Strategies sub-tab (crypto/stocks) is currently active
  // refresh the journal's ticker autocomplete list now that cryptoData is populated -
  // this also keeps it in sync on every manual refresh, not just the initial page load
  if(typeof populateJournalTickerList === 'function') populateJournalTickerList();
}

// Stocks are still fetched separately from crypto, on their own button rather than
// the main refresh - they're a distinct watchlist, not because of any rate limit
// (Lighter's candles endpoint has none documented, unlike the old Twelve Data path).
let stocksLoading = false;

async function loadStocksManual(){
  if(stocksLoading) return;
  stocksLoading = true;
  render(); // immediately show the loading state in place of the prior empty/stale view

  try{
    stockData = await loadStocksFromLighter();
  } catch(e){
    console.error('stocks refresh failed', e);
    stockData = [];
  }

  stocksLoading = false;
  render();
  renderDashboardHighlights(); // same reasoning as loadAll - Dashboard's combined list needs stock data too
  // same as loadAll's crypto path - keep the journal's ticker autocomplete in sync
  // once stockData is populated, so stock tickers show up too, not just crypto.
  if(typeof populateJournalTickerList === 'function') populateJournalTickerList();
}

function setMarket(mkt){
  currentMarket = mkt;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.mkt===mkt));
  render();
}

const TF_LABELS = {'4h':'4H · last 120 candles','12h':'12H · last 120 candles','1d':'1D · last 120 candles','3d':'3D · last 100 candles','1w':'1W · last 100 candles'};
const TF_BAR_COUNTS = {'4h':120,'12h':120,'1d':120,'3d':100,'1w':100};

// marketOverride lets a caller explicitly state which market a symbol belongs to,
// rather than relying on the global currentMarket toggle - needed because the
// Dashboard's excellent-setups list can mix crypto and stock symbols together,
// where currentMarket (the Strategies tab's crypto/stocks switch) may not match
// the symbol actually being clicked. Strategies' own table rows omit this param
// and fall back to currentMarket exactly as before.
function openChart(rawSymbol, marketOverride){
  const market = marketOverride || currentMarket;
  const sourceData = market === 'crypto' ? cryptoData : stockData;
  const item = sourceData.find(d => d.rawSymbol === rawSymbol);
  if(!item){
    return;
  }
  currentChartSymbol = rawSymbol;
  currentChartMarket = market; // remember which source this chart belongs to, for timeframe switches
  currentChartLabel = market === 'crypto' ? (item.symbol + ' / USDT') : item.symbol;
  currentChart4hEma = item.ema200;
  document.getElementById('modalSym').textContent = currentChartLabel;
  const distEl = document.getElementById('modalDist');
  distEl.textContent = (item.distPct>=0?'+':'') + item.distPct.toFixed(2) + '% from 200EMA (4H)';
  distEl.style.color = item.distPct>=0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('modalTvLink').href = tradingViewUrl(rawSymbol, market);
  document.querySelectorAll('.tf-btn').forEach(b=>b.classList.toggle('active', b.dataset.tf==='4h'));
  document.getElementById('modalBg').classList.add('open');
  renderTimeframe('4h', item.candles);
}

async function switchTimeframe(tf){
  if(!currentChartSymbol) return;
  document.querySelectorAll('.tf-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.tf===tf);
    if(b.dataset.tf!==tf) b.disabled = true;
  });
  document.getElementById('modalSub').textContent = 'loading ' + tf.toUpperCase() + '…';
  document.getElementById('chartArea').innerHTML = '<div class="chart-loading">pulling candles…</div>';

  const cacheKey = currentChartSymbol + '_' + tf;
  let candles = candleCache[cacheKey];
  if(!candles){
    try{
      if(currentChartMarket === 'crypto'){
        candles = await fetchBybitCandles(currentChartSymbol, tf);
      } else {
        const marketMap = await fetchLighterMarketMap();
        const market = marketMap ? marketMap[currentChartSymbol.toUpperCase()] : null;
        if(!market) throw new Error('no Lighter market for '+currentChartSymbol);
        candles = await fetchLighterCandles(market.marketIndex, tf);
      }
      candleCache[cacheKey] = candles;
    } catch(e){
      document.getElementById('chartArea').innerHTML = '<div class="chart-loading">could not load this timeframe — try again</div>';
      document.querySelectorAll('.tf-btn').forEach(b=>b.disabled=false);
      return;
    }
  }
  document.querySelectorAll('.tf-btn').forEach(b=>b.disabled=false);
  renderTimeframe(tf, candles);
}

function renderTimeframe(tf, candles){
  document.getElementById('modalSub').textContent = TF_LABELS[tf];
  document.getElementById('chartArea').innerHTML = '<canvas id="chartCanvas" height="360"></canvas>';
  const n = TF_BAR_COUNTS[tf] || 120;
  const sliceStart = Math.max(0, candles.length - n);
  const visible = candles.slice(sliceStart);
  requestAnimationFrame(() => drawChart(visible, currentChart4hEma, tf));
}

function closeModal(){
  document.getElementById('modalBg').classList.remove('open');
}

document.addEventListener('keydown', e => { if(e.key === 'Escape') closeModal(); });

function drawChart(candles, ema4hLevel, tf){
  const canvas = document.getElementById('chartCanvas');
  if(!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth;
  const cssHeight = 360;
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const padL = 56, padR = 12, padT = 14, padB = 22;
  const w = cssWidth - padL - padR;
  const h = cssHeight - padT - padB;

  const showNativeEma = (tf === '4h');
  // fractal/liquidity detection only runs on 4H and higher timeframes — this is
  // intentional: lower timeframes are too noisy to represent where real stop-loss
  // liquidity clusters. Since 1H has been removed from this app, every available
  // timeframe (4H/12H/1D/3D/1W) qualifies.
  const FRACTAL_TIMEFRAMES = ['4h','12h','1d','3d','1w'];
  const fractals = FRACTAL_TIMEFRAMES.includes(tf) ? detectFractalLows(candles, 3) : [];

  const highs = candles.map(c=>c.h);
  const lows = candles.map(c=>c.l);
  const emaVals = showNativeEma ? candles.map(c=>c.ema).filter(v=>v!=null) : [];
  const refVals = (ema4hLevel!=null) ? [ema4hLevel] : [];
  let max = Math.max(...highs, ...emaVals, ...refVals);
  let min = Math.min(...lows, ...emaVals, ...refVals);
  const pad = (max-min)*0.06 || max*0.01;
  max += pad; min -= pad;

  const n = candles.length;
  const slotW = w / n;
  const bodyW = Math.max(1, slotW*0.62);

  const yOf = v => padT + h - ((v-min)/(max-min))*h;
  const xOf = i => padL + i*slotW + slotW/2;

  ctx.clearRect(0,0,cssWidth,cssHeight);

  // grid + price labels
  ctx.strokeStyle = '#1c2730';
  ctx.fillStyle = '#5c6e78';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  const gridLines = 5;
  for(let i=0;i<=gridLines;i++){
    const v = min + (max-min)*i/gridLines;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL+w, y);
    ctx.stroke();
    ctx.fillText(fmtPrice(v), padL-6, y+3);
  }

  // candles
  for(let i=0;i<n;i++){
    const c = candles[i];
    const x = xOf(i);
    const up = c.c >= c.o;
    ctx.strokeStyle = up ? '#2dd4a0' : '#ff5d5d';
    ctx.fillStyle = up ? '#2dd4a0' : '#ff5d5d';
    // wick
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.h));
    ctx.lineTo(x, yOf(c.l));
    ctx.stroke();
    // body
    const yO = yOf(c.o), yC = yOf(c.c);
    const top = Math.min(yO,yC), bh = Math.max(1, Math.abs(yO-yC));
    ctx.fillRect(x-bodyW/2, top, bodyW, bh);
  }

  // ema line - only drawn on the 4H chart, since higher-TF EMA200 values
  // (e.g. 12H/1D 200EMA) aren't meaningful to this system
  if(showNativeEma){
    ctx.strokeStyle = '#f0b429';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for(let i=0;i<n;i++){
      if(candles[i].ema == null) continue;
      const x = xOf(i), y = yOf(candles[i].ema);
      if(!started){ ctx.moveTo(x,y); started = true; } else { ctx.lineTo(x,y); }
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // 4H 200EMA reference line (dashed, violet) - shown on higher timeframes for context.
  // hidden on the 4H chart itself since it would be an exact duplicate of the solid native line above.
  if(!showNativeEma && ema4hLevel != null && ema4hLevel >= min && ema4hLevel <= max){
    const y = yOf(ema4hLevel);
    ctx.save();
    ctx.strokeStyle = '#8b7fe8';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5,4]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL+w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8b7fe8';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('4H 200EMA', padL+w-72, y-4);
    ctx.restore();
  }

  // time labels (first / mid / last)
  ctx.fillStyle = '#5c6e78';
  ctx.textAlign = 'center';
  const showHour = (candles.length>1) && (candles[1].t - candles[0].t) < 24*60*60*1000;
  [0, Math.floor(n/2), n-1].forEach(i=>{
    const d = new Date(candles[i].t);
    let label = (d.getMonth()+1) + '/' + d.getDate();
    if(showHour) label += ' ' + String(d.getHours()).padStart(2,'0') + 'h';
    ctx.fillText(label, xOf(i), cssHeight-6);
  });

  // fractal swing lows = resting liquidity. drawn as short horizontal markers at the
  // level itself, color-coded by status:
  //   grey  = resting, never swept — liquidity still sitting there, untouched
  //   blue  = swept but not yet reclaimed with a bullish close
  //   white = swept AND reclaimed (bullish close back above) — the setup you're hunting
  fractals.forEach(f=>{
    if(f.price < min || f.price > max) return;
    const y = yOf(f.price);
    const xStart = xOf(f.index);
    let color, label;
    if(f.status === 'resting'){ color = '#5c6e78'; label = 'liquidity'; }
    else if(f.status === 'swept_open'){ color = '#5aa9e6'; label = 'swept'; }
    else { color = '#f4f4f4'; label = 'swept+reclaimed'; }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = f.status === 'swept_reclaimed' ? 2 : 1.2;
    ctx.setLineDash(f.status === 'resting' ? [2,3] : []);
    ctx.beginPath();
    const lineEnd = (f.status !== 'resting' && f.sweepIndex != null) ? xOf(f.sweepIndex) : (xStart + 26);
    ctx.moveTo(xStart, y);
    ctx.lineTo(Math.min(lineEnd, padL+w), y);
    ctx.stroke();
    ctx.setLineDash([]);

    // small marker dot at the fractal candle itself
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xStart, y, f.status === 'swept_reclaimed' ? 3 : 2, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  });
}

// ---- touch alert system ----
// fires when a symbol was trading above its 4H 200EMA and the latest 4H candle's
// low has come back down to touch (or pierce) that EMA level.
let alertsEnabled = false;
let alertTimerId = null;
let alertPrevState = {}; // symbol -> 'above' | 'touching' | 'below'

const ALERT_LOG_KEY = 'ema_watch_alert_log_v1';
const MAX_LOG_ENTRIES = 200;

function loadAlertLogFromStorage(){
  try{
    const raw = localStorage.getItem(ALERT_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ return []; }
}

function saveAlertLogToStorage(entries){
  try{
    localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(entries.slice(0, MAX_LOG_ENTRIES)));
  } catch(e){ console.error('could not save alert log', e); }
}

function renderAlertLog(){
  const log = document.getElementById('alertLog');
  const entries = loadAlertLogFromStorage();
  if(!entries.length){
    log.innerHTML = '<div class="alert-log-empty">no alerts yet — history persists here across reloads on this device</div>';
    return;
  }
  log.innerHTML = entries.map(e=>
    `<div class="${e.hit?'hit':''}">[${e.time}] ${e.msg}</div>`
  ).join('');
}

function clearAlertLog(){
  saveAlertLogToStorage([]);
  renderAlertLog();
}

function logAlert(msg, isHit){
  const entries = loadAlertLogFromStorage();
  entries.unshift({ time: new Date().toLocaleString(), msg, hit: isHit });
  saveAlertLogToStorage(entries);
  renderAlertLog();
}

function classifyTouch(candle, emaLevel){
  // 'above': low stayed clearly above ema. 'touching': low <= ema <= high (wick touched/pierced it).
  // 'below': high stayed clearly below ema.
  if(candle.l <= emaLevel && candle.h >= emaLevel) return 'touching';
  if(candle.l > emaLevel) return 'above';
  return 'below';
}

async function checkTouchAlerts(isManual){
  console.log('running' + (isManual ? ' manual' : ' hourly') + ' EMA touch check…');

  // Refresh the watchlist itself before checking, not just prices for whatever list
  // was last loaded. Without this, a long-running session (exactly the scenario
  // alerts are meant for) would silently keep checking a stale symbol list for
  // hours - missing coins that newly entered the real top 100 and wasting checks on
  // ones that dropped out. loadTop100SymbolsByVolume has its own 24h cache, so this
  // is cheap on a cache hit and only does real work once that cache naturally expires.
  try{
    CRYPTO_SYMBOLS = await loadTop100SymbolsByVolume();
    pruneCandleCache(CRYPTO_SYMBOLS);
  } catch(e){
    console.error('alert check: failed to refresh watchlist, using existing list', e);
  }

  const updated = [];
  let touchesFound = 0;
  for(const symbol of CRYPTO_SYMBOLS){
    try{
      const fresh = await fetchBybit4h(symbol);
      const lastCandle = fresh.candles[fresh.candles.length-1];
      const emaLevel = fresh.ema200;
      const state = classifyTouch(lastCandle, emaLevel);
      const prev = alertPrevState[symbol];

      if(state === 'touching' && prev === 'above'){
        const label = symbol.replace('USDT','');
        touchesFound++;
        logAlert(`${label} touched its 4H 200EMA coming from above`, true);
        notify(`${label} touched the 4H 200EMA`, `${label} was trading above its 4H 200EMA and price just came back down to touch it.`);
      }
      alertPrevState[symbol] = state;
      updated.push(fresh);
    } catch(e){
      console.error('alert check failed for', symbol, e);
    }
  }
  if(updated.length) cryptoData = updated;
  if(currentMarket === 'crypto') render();
  // manual checks (the "check now" button) log a clear confirmation either way, so
  // clicking it never looks like nothing happened - the silent hourly timer doesn't
  // log "checked, nothing found" every time, since that would flood the log with
  // 24 uneventful entries a day
  if(isManual){
    logAlert(touchesFound ? `manual check complete — ${touchesFound} touch alert${touchesFound===1?'':'s'} found` : 'manual check complete — no touches found right now', false);
  }
}

// Returns true if a notification was actually shown, false otherwise - callers use
// this to log the real outcome rather than assume notify() always works, since
// browser notification permission can be denied/blocked independently of whether
// the hourly alert timer itself is running.
function notify(title, body){
  if(!('Notification' in window)) return false;
  if(Notification.permission === 'granted'){
    new Notification(title, { body, icon: undefined });
    return true;
  }
  return false;
}

// Keeps a small status line in the alert panel honest about whether browser
// notifications can actually reach the user, independent of whether the hourly
// check timer is running - "ALERTS ON" alone doesn't mean notifications work if
// permission was denied or never granted.
function renderNotifPermissionNote(){
  const el = document.getElementById('notifPermissionNote');
  if(!el) return;
  if(!('Notification' in window)){
    el.innerHTML = '<span style="color:var(--red);">this browser does not support notifications at all</span>';
    return;
  }
  const perm = Notification.permission;
  if(perm === 'granted'){
    el.innerHTML = '<span style="color:var(--green);">browser notification permission: granted</span>';
  } else if(perm === 'denied'){
    el.innerHTML = '<span style="color:var(--red);">browser notification permission: denied — alerts will log here but no popup will appear. Re-enable notifications for this page in your browser site settings.</span>';
  } else {
    el.innerHTML = '<span style="color:var(--amber);">browser notification permission: not yet granted — click "enable alerts" or "send test notification" to be prompted.</span>';
  }
}

// Fires a real notification attempt right now (rather than waiting for a real
// price touch or the hourly timer) so the user can immediately confirm whether
// browser notifications are actually reaching them. Logs the real outcome either
// way, since a silent no-op would be just as confusing as the original problem.
async function sendTestNotification(){
  if('Notification' in window && Notification.permission === 'default'){
    await Notification.requestPermission();
  }
  const ok = notify('EMA Watch — test notification', 'If you can see this, browser notifications are working correctly.');
  logAlert(ok ? 'test notification sent successfully' : 'test notification failed — browser permission is ' + (('Notification' in window) ? Notification.permission : 'unsupported'), ok);
  renderNotifPermissionNote();
}

async function toggleAlerts(){
  if(alertsEnabled){
    alertsEnabled = false;
    if(alertTimerId) clearInterval(alertTimerId);
    alertTimerId = null;
    document.getElementById('alertStatusBadge').textContent = 'ALERTS OFF';
    document.getElementById('alertStatusBadge').className = 'alert-status off';
    document.getElementById('alertToggleBtn').textContent = 'enable alerts';
    logAlert('alerts disabled', false);
    renderNotifPermissionNote();
    return;
  }

  if('Notification' in window && Notification.permission === 'default'){
    await Notification.requestPermission();
  }

  // seed baseline state from current cryptoData so we don't fire a false alert immediately
  cryptoData.forEach(d=>{
    if(!d.candles) return;
    const lastCandle = d.candles[d.candles.length-1];
    alertPrevState[d.rawSymbol] = classifyTouch(lastCandle, d.ema200);
  });

  alertsEnabled = true;
  // the badge reflects whether notifications can actually reach the user, not just
  // whether the hourly timer is running - a denied/unsupported permission state
  // still shows ALERTS ON (the log will still record hits) but in a warning color
  // so it's visually clear that popups won't appear
  const notifReady = ('Notification' in window) && Notification.permission === 'granted';
  document.getElementById('alertStatusBadge').textContent = notifReady ? 'ALERTS ON' : 'ALERTS ON (no popups)';
  document.getElementById('alertStatusBadge').className = 'alert-status ' + (notifReady ? 'on' : 'warn');
  document.getElementById('alertToggleBtn').textContent = 'disable alerts';
  logAlert('alerts enabled — checking every hour while this tab stays open', false);
  renderNotifPermissionNote();

  alertTimerId = setInterval(checkTouchAlerts, 60*60*1000); // every hour
}

// ===================== TRADE JOURNAL =====================
// Entries persist in localStorage only (not synced across devices/browsers) - the
// user explicitly chose this over a GitHub-API write-back approach to avoid storing
// a write-access credential in the browser. The export buttons exist specifically as
// a manual backup path given that tradeoff.

// ===================== LIGHTER BALANCE (REST polling) =====================
// Uses the public /api/v1/account endpoint (no auth needed) to fetch collateral,
// available balance, and open positions including liquidation prices.
// Polls every 60 seconds to stay current.

const LIGHTER_ACCOUNT_INDEX = 21229;
const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai';
let _lighterBalanceTimer = null;

async function fetchLighterBalance(){
  try{
    const res = await fetch(`${LIGHTER_BASE_URL}/api/v1/account?by=index&value=${LIGHTER_ACCOUNT_INDEX}`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // API returns { accounts: [ { collateral, available_balance, ... } ] }
    const account = (data.accounts && data.accounts[0]) || data;
    updateLighterBalanceDisplay(account);
    setLighterDot('live');
  } catch(e){
    console.warn('[LighterBalance] fetch failed', e);
    setLighterDot('error');
    const subEl = document.getElementById('dashLighterSub');
    if(subEl) subEl.textContent = 'fetch failed — retrying';
  }
}

function setLighterDot(state){
  const dot = document.getElementById('lighterDot');
  if(!dot) return;
  if(state === 'live')       { dot.style.background = 'var(--green)'; dot.title = 'live'; }
  else if(state === 'error') { dot.style.background = 'var(--red)';   dot.title = 'error'; }
  else                       { dot.style.background = 'var(--amber)'; dot.title = 'connecting…'; }
}

function updateLighterBalanceDisplay(data){
  const collateral = parseFloat(data.collateral);
  const available  = parseFloat(data.available_balance);
  const totalAsset = parseFloat(data.total_asset_value);

  // total_asset_value includes unrealised PnL; use it if present, else collateral
  const displayBalance = (!isNaN(totalAsset) && totalAsset > 0) ? totalAsset : collateral;
  if(isNaN(displayBalance)) return;

  const balEl = document.getElementById('dashLighterBalance');
  const subEl = document.getElementById('dashLighterSub');

  if(balEl) balEl.textContent = '$' + displayBalance.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

  const subParts = [];
  if(!isNaN(available)) subParts.push(`avail $${available.toLocaleString('en-US',{maximumFractionDigits:0})}`);

  // show liquidation price if there's an open position
  const positions = data.positions || [];
  const openPos = positions.find(p => parseFloat(p.position) !== 0);
  if(openPos && openPos.liquidation_price){
    const liqPrice = parseFloat(openPos.liquidation_price);
    if(!isNaN(liqPrice) && liqPrice > 0){
      subParts.push(`liq $${liqPrice.toLocaleString('en-US',{maximumFractionDigits:0})}`);
    }
  }

  if(subEl) subEl.textContent = subParts.join(' · ') || 'live';
  updateDashboardTotal();
}

function updateDashboardTotal(){
  const lighterText = document.getElementById('dashLighterBalance')?.textContent;
  const bybitText   = document.getElementById('dashBybitBalance')?.textContent;
  const lighterVal  = parseFloat((lighterText||'').replace(/[$,]/g,''));
  const bybitVal    = parseFloat((bybitText||'').replace(/[$,]/g,''));
  const hasLighter  = !isNaN(lighterVal) && lighterText !== '—';
  const hasBybit    = !isNaN(bybitVal)   && bybitText   !== '—';
  if(!hasLighter && !hasBybit) return;

  const total = (hasLighter ? lighterVal : 0) + (hasBybit ? bybitVal : 0);
  const totalEl = document.getElementById('dashTotalBalance');
  const subEl   = document.querySelector('.total-sub');
  if(totalEl) totalEl.textContent = '$' + total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const parts = [];
  if(hasLighter) parts.push('Lighter');
  if(hasBybit)   parts.push('Bybit');
  if(subEl) subEl.textContent = parts.join(' + ') + ' combined';

  // proportion bars
  if(total > 0){
    const lBar = document.getElementById('dashLighterBar');
    const bBar = document.getElementById('dashBybitBar');
    if(lBar) lBar.style.width = (hasLighter ? (lighterVal/total*100) : 0).toFixed(1) + '%';
    if(bBar) bBar.style.width = (hasBybit   ? (bybitVal/total*100)   : 0).toFixed(1) + '%';
  }
}

// fetch immediately, then every 60s
fetchLighterBalance();
_lighterBalanceTimer = setInterval(fetchLighterBalance, 60000);

// ---- Bybit balance ----
function setBybitDot(state){
  const dot = document.getElementById('bybitDot');
  if(!dot) return;
  if(state === 'live')       { dot.style.background = 'var(--green)'; dot.title = 'live'; }
  else if(state === 'error') { dot.style.background = 'var(--red)';   dot.title = 'error'; }
  else                       { dot.style.background = 'var(--amber)'; dot.title = 'connecting…'; }
}

async function fetchBybitBalance(){
  const key = localStorage.getItem('bybit_api_key');
  const secret = localStorage.getItem('bybit_api_secret');
  if(!key || !secret){
    const subEl = document.getElementById('dashBybitSub');
    if(subEl) subEl.textContent = 'set API keys in Settings';
    setBybitDot('error');
    return;
  }
  try{
    // reuse bbHmac if already loaded, else define inline
    const hmac = typeof bbHmac === 'function' ? bbHmac : async (secret, message) => {
      const enc = new TextEncoder();
      const k = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
      return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
    };
    const ts = Date.now().toString(), recv = '5000';
    const params = new URLSearchParams({accountType:'UNIFIED'}).toString();
    const sig = await hmac(secret, ts + key + recv + params);
    const res = await fetch(`https://api.bybit.com/v5/account/wallet-balance?${params}`, {
      headers: {'X-BAPI-API-KEY':key,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':recv,'X-BAPI-SIGN':sig}
    });
    const data = await res.json();
    if(data.retCode !== 0){ console.warn('[BybitBalance] API error', data.retMsg); setBybitDot('error'); return; }

    const account = data.result?.list?.[0];
    if(!account){ setBybitDot('error'); return; }

    const totalWallet = parseFloat(account.totalWalletBalance || 0);
    const totalAvail  = parseFloat(account.totalAvailableBalance || 0);
    const totalEquity = parseFloat(account.totalEquity || totalWallet);

    const balEl = document.getElementById('dashBybitBalance');
    const subEl = document.getElementById('dashBybitSub');
    if(balEl) balEl.textContent = '$' + totalEquity.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

    const subParts = [];
    if(!isNaN(totalAvail)) subParts.push(`avail $${totalAvail.toLocaleString('en-US',{maximumFractionDigits:0})}`);

    // show unrealised PnL if any
    const unrealisedPnl = parseFloat(account.totalPerpUPL || 0);
    if(!isNaN(unrealisedPnl) && Math.abs(unrealisedPnl) > 0.01){
      subParts.push(`uPnL ${unrealisedPnl >= 0 ? '+' : ''}$${unrealisedPnl.toFixed(2)}`);
    }
    if(subEl) subEl.textContent = subParts.join(' · ') || 'live';
    setBybitDot('live');
    updateDashboardTotal();
  } catch(e){
    console.warn('[BybitBalance] fetch failed', e);
    setBybitDot('error');
    const subEl = document.getElementById('dashBybitSub');
    if(subEl) subEl.textContent = 'fetch failed — retrying';
  }
}

fetchBybitBalance();
setInterval(fetchBybitBalance, 60000);



renderAlertLog();
renderNotifPermissionNote();

// ---- hourly auto-refresh ----
// Fires loadAll() every hour so the EMA watchlist stays current without manual intervention.
// Also triggers EXCELLENT+ Telegram alerts after each refresh.
let _autoRefreshTimer = null;
let _nextRefreshAt = null;

function scheduleAutoRefresh(){
  if(_autoRefreshTimer) clearInterval(_autoRefreshTimer);
  _nextRefreshAt = Date.now() + 60 * 60 * 1000;
  updateNextRefreshDisplay();
  _autoRefreshTimer = setInterval(async () => {
    console.log('[AutoRefresh] hourly refresh triggered');
    await loadAll();
    sendExcellentPlusTelegramAlerts();
    _nextRefreshAt = Date.now() + 60 * 60 * 1000;
    updateNextRefreshDisplay();
  }, 60 * 60 * 1000);
}

function updateNextRefreshDisplay(){
  const el = document.getElementById('settings-next-refresh');
  if(!el || !_nextRefreshAt) return;
  const mins = Math.round((_nextRefreshAt - Date.now()) / 60000);
  el.textContent = mins <= 1 ? 'less than a minute' : `in ~${mins} minutes`;
}

scheduleAutoRefresh();
// keep the countdown display live while on the Settings tab
setInterval(updateNextRefreshDisplay, 30000);

// ---- EXCELLENT+ Telegram alerts ----
const TG_TOKEN_KEY = 'ema_watch_tg_token';
const TG_CHATID_KEY = 'ema_watch_tg_chatid';
// track which symbols have already been alerted this session so we don't spam
const _tgAlertedThisSession = new Set();

async function sendTelegramMessage(msg){
  const token = localStorage.getItem(TG_TOKEN_KEY);
  const chatId = localStorage.getItem(TG_CHATID_KEY);
  if(!token || !chatId) return false;
  try{
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' })
    });
    return res.ok;
  } catch(e){
    console.error('[Telegram] send failed', e);
    return false;
  }
}

function sendExcellentPlusTelegramAlerts(){
  const all = [...cryptoData, ...stockData];
  const hits = all.filter(d => d.score && d.score.tier === 'excellent_plus');
  if(!hits.length) return;

  const newHits = hits.filter(d => !_tgAlertedThisSession.has(d.symbol));
  if(!newHits.length) return;

  newHits.forEach(d => _tgAlertedThisSession.add(d.symbol));

  const lines = newHits.map(d => {
    const dist = d.distPct != null ? ` · ${d.distPct >= 0 ? '+' : ''}${d.distPct.toFixed(1)}% from EMA` : '';
    return `• <b>${d.symbol}</b>${dist}`;
  });

  const msg = [
    `🟢 <b>EXCELLENT+ setup${newHits.length > 1 ? 's' : ''} detected</b>`,
    ...lines,
    ``,
    `<i>EMA Watch · ${new Date().toUTCString()}</i>`
  ].join('\n');

  sendTelegramMessage(msg);
}

// ---- Settings tab functions ----
function saveSettingsTelegram(){
  const token = document.getElementById('settings-tg-token').value.trim();
  const chatId = document.getElementById('settings-tg-chatid').value.trim();
  if(!token || !chatId){
    document.getElementById('settings-tg-status').textContent = 'both fields required';
    return;
  }
  localStorage.setItem(TG_TOKEN_KEY, token);
  localStorage.setItem(TG_CHATID_KEY, chatId);
  document.getElementById('settings-tg-status').textContent = 'saved ✓';
  setTimeout(() => { document.getElementById('settings-tg-status').textContent = ''; }, 2500);
}

async function testSettingsTelegram(){
  const statusEl = document.getElementById('settings-tg-status');
  statusEl.textContent = 'sending…';
  const ok = await sendTelegramMessage('✅ EMA Watch test message — Telegram alerts are working!');
  statusEl.textContent = ok ? 'sent ✓' : 'failed — check token & chat ID';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

// pre-fill settings fields from localStorage on page load
(function loadSettingsFields(){
  const token = localStorage.getItem(TG_TOKEN_KEY);
  const chatId = localStorage.getItem(TG_CHATID_KEY);
  const tEl = document.getElementById('settings-tg-token');
  const cEl = document.getElementById('settings-tg-chatid');
  if(tEl && token) tEl.value = token;
  if(cEl && chatId) cEl.value = chatId;
})();

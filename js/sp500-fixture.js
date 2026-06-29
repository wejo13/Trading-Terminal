/**
 * sp500-fixture.js
 * DEMO FIXTURE DATA · Not live · For layout and testing only.
 * All prices, percentages, and valuation figures are illustrative examples.
 */
'use strict';

const SP500_VALUATION = {
  _demo: true,
  cape:            36.8,
  forwardPE:       21.4,
  trailingPE:      25.1,
  capePercentile:  88,          // approx 88th historical percentile
  cape2000Peak:    44.2,        // Dot-com CAPE peak reference
  distFrom2000:    -16.7,       // % below 2000 peak
  cycleNote:       'Valuations remain historically elevated. High CAPE has historically been cycle context, not a timing signal — markets can stay extended for years.',
  caution:         'Elevated',  // Normal | Elevated | Extreme

  history: [
    { cycle:'1929',         cape: 32.6, note:'Major peak / subsequent collapse' },
    { cycle:'Nifty Fifty',  cape: 24.0, note:'Valuation compression 1972–74' },
    { cycle:'2000 Dot-com', cape: 44.2, note:'Extreme valuation / multi-year bear market' },
    { cycle:'2007',         cape: 27.5, note:'Late-cycle credit risk' },
    { cycle:'2021',         cape: 38.3, note:'Liquidity-driven extension' },
    { cycle:'Today (demo)', cape: 36.8, note:'Current DEMO comparison' },
  ],
};

const SP500_WATCHLIST = [
  { ticker:'SPY',  company:'SPDR S&P 500 ETF',       sector:'ETF',          price:545.20, dayChg: 0.42, above20d:true,  above200d:true,  dist20d: 1.4, dist200d: 12.3,  note:'Broad market proxy' },
  { ticker:'NVDA', company:'NVIDIA Corp',             sector:'Semiconductors',price:131.80, dayChg: 1.85, above20d:true,  above200d:true,  dist20d: 7.2, dist200d: 38.6,  note:'AI-cycle leader; elevated extension vs 20D' },
  { ticker:'MSFT', company:'Microsoft Corp',          sector:'Software',      price:415.00, dayChg:-0.28, above20d:false, above200d:true,  dist20d:-2.1, dist200d:  8.4,  note:'Pulled below 20D; watch for recovery' },
  { ticker:'AMZN', company:'Amazon.com Inc',          sector:'Consumer Disc', price:192.40, dayChg: 0.63, above20d:true,  above200d:true,  dist20d: 3.8, dist200d: 22.1,  note:'AWS growth driver; trend intact' },
  { ticker:'META', company:'Meta Platforms',          sector:'Communication', price:588.00, dayChg: 1.10, above20d:true,  above200d:true,  dist20d: 5.5, dist200d: 31.4,  note:'AI spend + ad revenue; bullish structure' },
  { ticker:'GOOGL', company:'Alphabet Inc',           sector:'Communication', price:173.50, dayChg:-0.55, above20d:false, above200d:true,  dist20d:-1.7, dist200d:  6.9,  note:'Below 20D; monitor ad cycle' },
  { ticker:'AAPL', company:'Apple Inc',               sector:'Technology',    price:213.20, dayChg: 0.18, above20d:true,  above200d:true,  dist20d: 1.1, dist200d: 14.7,  note:'Steady; iPhone cycle muted' },
  { ticker:'AVGO', company:'Broadcom Inc',            sector:'Semiconductors',price:168.80, dayChg: 2.30, above20d:true,  above200d:true,  dist20d: 9.8, dist200d: 44.2,  note:'AI networking demand; large 20D extension' },
  { ticker:'AMD',  company:'Advanced Micro Devices',  sector:'Semiconductors',price:156.40, dayChg:-1.20, above20d:false, above200d:false, dist20d:-4.3, dist200d:-11.2, note:'Below both MAs; wait for reclaim' },
  { ticker:'SMH',  company:'VanEck Semiconductor ETF',sector:'ETF',          price:228.60, dayChg: 0.90, above20d:true,  above200d:true,  dist20d: 2.6, dist200d: 19.5,  note:'Semis leadership gauge' },
  { ticker:'XLF',  company:'Financial Select SPDR',   sector:'ETF',          price: 43.80, dayChg: 0.35, above20d:true,  above200d:true,  dist20d: 0.8, dist200d:  7.3,  note:'Rate-sensitive; watch Fed path' },
  { ticker:'XLE',  company:'Energy Select SPDR',      sector:'ETF',          price: 88.50, dayChg:-0.70, above20d:false, above200d:false, dist20d:-3.2, dist200d:-8.6,  note:'Energy underperforming; commodity cycle weak' },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SP500_VALUATION, SP500_WATCHLIST };
} else {
  window.SP500_VALUATION = SP500_VALUATION;
  window.SP500_WATCHLIST = SP500_WATCHLIST;
}

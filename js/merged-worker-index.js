// ── S&P 500 watchlist tickers ─────────────────────────────────────────────────
const SP500_TICKERS = ['SPY','NVDA','MSFT','AMZN','META','GOOGL','AAPL','AVGO','AMD','SMH','XLF','XLE'];

// ── Simple in-memory cache (~5 min) ───────────────────────────────────────────
let _sp500Cache = null; // { payload, expiresAt }
let _calendarCache = null; // { payload, expiresAt }

// ── Twelve Data fetch ─────────────────────────────────────────────────────────
async function fetchSP500Prices(apiKey) {
  const url = `https://api.twelvedata.com/quote?symbol=${SP500_TICKERS.join(',')}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  const data = await res.json();

  const rows = [];
  for (const ticker of SP500_TICKERS) {
    const q = data[ticker] ?? data;
    if (!q || q.status === 'error') continue;
    const price  = parseFloat(q.close ?? q.price ?? '');
    const dayChg = parseFloat(q.percent_change ?? '');
    if (!isFinite(price)) continue;
    rows.push({
      ticker,
      price:  Math.round(price * 100) / 100,
      dayChg: isFinite(dayChg) ? Math.round(dayChg * 100) / 100 : null,
    });
  }
  if (rows.length === 0) throw new Error('No valid quotes returned');
  return { mode: 'live', provider: 'Twelve Data', asOf: new Date().toISOString(), rows };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS headers (existing worker uses wildcard — keep that for Anthropic route) ──
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── NEW: GET /api/sp500-prices ────────────────────────────────────────────
    if (url.pathname === '/api/sp500-prices' && request.method === 'GET') {
      const apiKey = env.TWELVE_DATA_API_KEY;
      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: 'TWELVE_DATA_API_KEY not configured' }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const cacheTtl = parseInt(env.CACHE_TTL_SECONDS ?? '300', 10);
      const now = Date.now();
      if (_sp500Cache && _sp500Cache.expiresAt > now) {
        return new Response(
          JSON.stringify({ ..._sp500Cache.payload, cached: true }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const payload = await fetchSP500Prices(apiKey);
        _sp500Cache = { payload, expiresAt: now + cacheTtl * 1000 };
        return new Response(
          JSON.stringify(payload),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Provider unavailable', detail: e.message }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── NEW: GET /api/macro-calendar ──────────────────────────────────────────
    if (url.pathname === '/api/macro-calendar' && request.method === 'GET') {
      const cacheTtl = parseInt(env.CALENDAR_CACHE_TTL_SECONDS ?? '1800', 10);
      const now = Date.now();
      if (_calendarCache && _calendarCache.expiresAt > now) {
        return new Response(
          JSON.stringify({ ..._calendarCache.payload, cached: true }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      try {
        const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
        if (!res.ok) throw new Error('ForexFactory HTTP ' + res.status);
        const raw = await res.json();
        // keep it to USD, medium+high impact only — this is a BTC dashboard,
        // not a full FX calendar, and we want a short list.
        const events = raw
          .filter((e) => e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
          .map((e) => ({ title: e.title, date: e.date, impact: e.impact, forecast: e.forecast, previous: e.previous }));
        const payload = { asOf: new Date().toISOString(), events };
        _calendarCache = { payload, expiresAt: now + cacheTtl * 1000 };
        return new Response(
          JSON.stringify(payload),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Provider unavailable', detail: e.message }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── EXISTING: Anthropic proxy (POST only) ─────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    try {
      const body = await request.json();
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        status: resp.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }
}

const https = require('https');

const TIINGO_KEY = process.env.TIINGO_KEY;
const METALS_KEY = process.env.METALS_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function fetchJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const SB_HEADERS = {
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  'Content-Type': 'application/json'
};

async function main() {
  console.log('=== SarwaDesk Price Update ===', new Date().toISOString());

  // 1. Load portfolio from Supabase
  console.log('\n1. Loading portfolio from Supabase...');
  const portRes = await fetchJson(
    `${SUPABASE_URL}/rest/v1/portfolio?id=eq.default&select=holdings`,
    { method: 'GET', headers: SB_HEADERS }
  );
  if (portRes.status !== 200) { console.error('Supabase portfolio error:', portRes.status, JSON.stringify(portRes.body)); process.exit(1); }

  const myHoldings = portRes.body[0]?.holdings || [];
  console.log(`Holdings: ${myHoldings.length}`);

  // 2. Collect tickers
  const tickers = new Set(['QQQ']);
  myHoldings.forEach(h => h.ticker && tickers.add(h.ticker.toUpperCase()));
  console.log('Tickers:', [...tickers].join(', '));

  // 3. Fetch stocks from Tiingo
  console.log('\n2. Fetching stocks from Tiingo...');
  const tickerStr = [...tickers].join(',');
  const tiingoRes = await fetchJson(
    `https://api.tiingo.com/iex/?tickers=${tickerStr}&token=${TIINGO_KEY}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${TIINGO_KEY}` } }
  );

  const prices = {};
  const errors = [];
  if (tiingoRes.status === 200 && Array.isArray(tiingoRes.body)) {
    tiingoRes.body.forEach(q => {
      const t = q.ticker?.toUpperCase();
      if (t && (q.last || q.tngoLast)) {
        prices[t] = { price: q.last || q.tngoLast, prevClose: q.prevClose, high: q.high, low: q.low, timestamp: q.timestamp };
        console.log(`✓ ${t}: $${prices[t].price}`);
      } else { errors.push(t); console.log(`✗ ${t}: no price`); }
    });
  } else { [...tickers].forEach(t => errors.push(t)); console.error('Tiingo failed:', tiingoRes.status); }

  // 4. Metals - only on the hour (minute 0-4)
  console.log('\n3. Checking metals fetch...');
  const currentMinute = new Date().getUTCMinutes();
  const shouldFetchMetals = currentMinute < 5;
  console.log(`Current UTC minute: ${currentMinute} — ${shouldFetchMetals ? 'Fetching metals' : 'Skipping metals (not on the hour)'}`);

  let metalPrices = { gold: null, silver: null, updated: null };

  if (shouldFetchMetals && METALS_KEY) {
    try {
      const metalRes = await fetchJson(
        `https://api.metals.dev/v1/latest?api_key=${METALS_KEY}&currency=USD&unit=toz`,
        { method: 'GET' }
      );
      console.log('metals.dev status:', metalRes.status);
      if (metalRes.status === 200 && metalRes.body?.metals) {
        metalPrices.gold = metalRes.body.metals.gold || null;
        metalPrices.silver = metalRes.body.metals.silver || null;
        metalPrices.updated = metalRes.body.timestamps?.metal || new Date().toISOString();
        console.log(`✓ Gold: $${metalPrices.gold}, Silver: $${metalPrices.silver}`);
      } else {
        console.warn('metals.dev returned no data:', JSON.stringify(metalRes.body).slice(0, 300));
      }
    } catch(e) {
      console.error('metals.dev error:', e.message);
    }
  }

  // Preserve cached metals if we skipped this run OR the fetch failed
  if (!shouldFetchMetals || (metalPrices.gold === null && metalPrices.silver === null)) {
    try {
      const existingRes = await fetchJson(
        `${SUPABASE_URL}/rest/v1/prices?id=eq.default&select=data`,
        { method: 'GET', headers: SB_HEADERS }
      );
      if (existingRes.status === 200 && existingRes.body[0]?.data?.metals) {
        const cached = existingRes.body[0].data.metals;
        if (cached.gold) {
          metalPrices = cached;
          console.log(`Using cached metals: Gold $${metalPrices.gold}, Silver $${metalPrices.silver}`);
        }
      }
    } catch(e) {
      console.warn('Could not load cached metals:', e.message);
    }
  }

  // 5. Build final data
  const qqq = prices['QQQ'] || {};
  const change = qqq.price && qqq.prevClose ? qqq.price - qqq.prevClose : null;
  const output = {
    updatedAt: new Date().toISOString(),
    market: {
      symbol: 'QQQ',
      price: qqq.price || null,
      prevClose: qqq.prevClose || null,
      change,
      changePct: change && qqq.prevClose ? (change / qqq.prevClose) * 100 : null,
      high: qqq.high || null,
      low: qqq.low || null
    },
    prices,
    metals: metalPrices,
    errors: errors.length ? errors : undefined
  };

  // 6. Save to Supabase prices table
  console.log('\n4. Saving to Supabase prices table...');
  const saveRes = await fetchJson(
    `${SUPABASE_URL}/rest/v1/prices?id=eq.default`,
    { method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' } },
    JSON.stringify({ data: output, updated_at: new Date().toISOString() })
  );
  if (saveRes.status === 204 || saveRes.status === 200) { console.log('✓ Saved to Supabase'); }
  else { console.error('Save failed:', saveRes.status, JSON.stringify(saveRes.body)); process.exit(1); }

  console.log('\n=== Done ===', Object.keys(prices).length, 'stocks +', (metalPrices.gold?'gold ':''), (metalPrices.silver?'silver':''), 'saved');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

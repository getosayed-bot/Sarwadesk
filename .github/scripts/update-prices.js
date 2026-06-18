const https = require('https');

const TIINGO_KEY = process.env.TIINGO_KEY;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

// Separate bin for prices only
const PRICES_BIN_ID = '6a33bfd4da38895dfed6349f'; // hardcoded

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

async function main() {
  console.log('=== SarwaDesk Price Update ===', new Date().toISOString());

  // 1. Load portfolio from JSONBin
  console.log('\n1. Loading portfolio...');
  const binRes = await fetchJson(
    `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`,
    { method: 'GET', headers: { 'X-Master-Key': JSONBIN_KEY } }
  );
  console.log('JSONBin status:', binRes.status);
  if (binRes.status !== 200) { console.error('JSONBin error:', JSON.stringify(binRes.body)); process.exit(1); }

  const record = binRes.body?.record || {};
  const myHoldings = record.holdings || [];
  const wifeHoldings = record.wifeHoldings || [];
  console.log(`Holdings: ${myHoldings.length} mine, ${wifeHoldings.length} wife`);

  // 2. Extract tickers
  const tickers = new Set(['QQQ']);
  myHoldings.forEach(h => h.ticker && tickers.add(h.ticker.toUpperCase()));
  wifeHoldings.forEach(h => h.ticker && tickers.add(h.ticker.toUpperCase()));
  console.log('Tickers:', [...tickers].join(', '));

  // 3. Fetch from Tiingo
  console.log('\n2. Fetching prices from Tiingo...');
  const tickerStr = [...tickers].join(',');
  const tiingoRes = await fetchJson(
    `https://api.tiingo.com/iex/?tickers=${tickerStr}&token=${TIINGO_KEY}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${TIINGO_KEY}` } }
  );
  console.log('Tiingo status:', tiingoRes.status);
  console.log('Tiingo body:', JSON.stringify(tiingoRes.body).slice(0, 300));

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
  } else { [...tickers].forEach(t => errors.push(t)); }

  // 4. Build output
  const qqq = prices['QQQ'] || {};
  const change = qqq.price && qqq.prevClose ? qqq.price - qqq.prevClose : null;
  const output = {
    updatedAt: new Date().toISOString(),
    market: { symbol: 'QQQ', price: qqq.price||null, prevClose: qqq.prevClose||null, change, changePct: change && qqq.prevClose ? (change/qqq.prevClose)*100 : null, high: qqq.high||null, low: qqq.low||null },
    prices,
    errors: errors.length ? errors : undefined
  };

  // 5. Save to prices bin in JSONBin
  console.log('\n3. Saving to prices bin...');
  const saveRes = await fetchJson(
    `https://api.jsonbin.io/v3/b/${PRICES_BIN_ID}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY } },
    JSON.stringify(output)
  );
  console.log('Save status:', saveRes.status);
  if (saveRes.status === 200) { console.log('✓ Prices saved to JSONBin successfully'); }
  else { console.error('Save failed:', JSON.stringify(saveRes.body)); process.exit(1); }

  // 6. Also write prices.json locally (for git commit attempt)
  require('fs').writeFileSync('prices.json', JSON.stringify(output, null, 2));
  console.log('\n=== Done ===', Object.keys(prices).length, 'prices fetched');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

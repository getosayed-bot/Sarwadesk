const https = require('https');

const TIINGO_KEY = process.env.TIINGO_KEY;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

// Fetch JSON from URL
function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log('=== SarwaDesk Price Update ===');
  console.log(new Date().toISOString());

  // 1. Load portfolio from JSONBin
  console.log('\n1. Loading portfolio from JSONBin...');
  const binData = await fetchJson(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    method: 'GET',
    headers: { 'X-Master-Key': JSONBIN_KEY }
  });

  const record = binData?.record || {};
  const myHoldings = record.holdings || [];
  const wifeHoldings = record.wifeHoldings || [];

  // 2. Extract unique tickers from both portfolios + QQQ for market
  const tickers = new Set(['QQQ']); // Always include QQQ for market tracker
  myHoldings.forEach(h => { if (h.ticker) tickers.add(h.ticker.toUpperCase()); });
  wifeHoldings.forEach(h => { if (h.ticker) tickers.add(h.ticker.toUpperCase()); });

  console.log(`   Tickers found: ${[...tickers].join(', ')}`);

  // 3. Fetch prices from Tiingo
  console.log('\n2. Fetching prices from Tiingo...');
  const prices = {};
  const errors = [];

  for (const ticker of tickers) {
    try {
      const data = await fetchJson(
        `https://api.tiingo.com/iex/?tickers=${ticker}&token=${TIINGO_KEY}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } }
      );

      if (data && data[0]) {
        const quote = data[0];
        prices[ticker] = {
          price: quote.last || quote.tngoLast || quote.prevClose || null,
          prevClose: quote.prevClose || null,
          high: quote.high || null,
          low: quote.low || null,
          open: quote.open || null,
          volume: quote.volume || null,
          timestamp: quote.timestamp || new Date().toISOString()
        };
        console.log(`   ✓ ${ticker}: $${prices[ticker].price}`);
      } else {
        // Try daily endpoint as fallback
        const daily = await fetchJson(
          `https://api.tiingo.com/tiingo/daily/${ticker}/prices?token=${TIINGO_KEY}`,
          { method: 'GET', headers: { 'Content-Type': 'application/json' } }
        );
        if (daily && daily[0]) {
          prices[ticker] = {
            price: daily[0].close || daily[0].adjClose || null,
            prevClose: null,
            high: daily[0].high || null,
            low: daily[0].low || null,
            open: daily[0].open || null,
            volume: daily[0].volume || null,
            timestamp: daily[0].date || new Date().toISOString()
          };
          console.log(`   ✓ ${ticker} (daily): $${prices[ticker].price}`);
        } else {
          errors.push(ticker);
          console.log(`   ✗ ${ticker}: no data`);
        }
      }
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    } catch(e) {
      errors.push(ticker);
      console.log(`   ✗ ${ticker}: ${e.message}`);
    }
  }

  // 4. Build market summary from QQQ
  const qqq = prices['QQQ'] || {};
  const market = {
    symbol: 'QQQ',
    price: qqq.price,
    prevClose: qqq.prevClose,
    change: qqq.price && qqq.prevClose ? qqq.price - qqq.prevClose : null,
    changePct: qqq.price && qqq.prevClose ? ((qqq.price - qqq.prevClose) / qqq.prevClose) * 100 : null,
    high: qqq.high,
    low: qqq.low
  };

  // 5. Write prices.json
  const output = {
    updatedAt: new Date().toISOString(),
    nextUpdate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    market,
    prices,
    errors: errors.length ? errors : undefined
  };

  const fs = require('fs');
  fs.writeFileSync('prices.json', JSON.stringify(output, null, 2));
  console.log('\n3. prices.json written successfully');
  if (errors.length) console.log(`   Errors: ${errors.join(', ')}`);
  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

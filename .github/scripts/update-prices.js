const https = require('https');
const fs = require('fs');

const TIINGO_KEY = process.env.TIINGO_KEY;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

function fetchJson(url, options = {}) {
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
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log('=== SarwaDesk Price Update ===');
  console.log(new Date().toISOString());
  console.log('TIINGO_KEY set:', !!TIINGO_KEY);
  console.log('JSONBIN_BIN_ID:', JSONBIN_BIN_ID);

  // 1. Load portfolio from JSONBin
  console.log('\n1. Loading portfolio from JSONBin...');
  const binRes = await fetchJson(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    method: 'GET',
    headers: {
      'X-Master-Key': JSONBIN_KEY,
      'Content-Type': 'application/json'
    }
  });

  console.log('JSONBin status:', binRes.status);
  
  if (binRes.status !== 200) {
    console.error('JSONBin error:', JSON.stringify(binRes.body));
    process.exit(1);
  }

  const record = binRes.body?.record || {};
  const myHoldings = record.holdings || [];
  const wifeHoldings = record.wifeHoldings || [];
  console.log('My holdings:', myHoldings.length);
  console.log('Wife holdings:', wifeHoldings.length);

  // 2. Extract unique tickers
  const tickers = new Set(['QQQ']);
  myHoldings.forEach(h => { if (h.ticker) tickers.add(h.ticker.toUpperCase()); });
  wifeHoldings.forEach(h => { if (h.ticker) tickers.add(h.ticker.toUpperCase()); });
  console.log('\n2. Tickers to fetch:', [...tickers].join(', '));

  // 3. Fetch prices from Tiingo (batch endpoint)
  console.log('\n3. Fetching from Tiingo...');
  const tickerList = [...tickers].join(',');
  const tiingoRes = await fetchJson(
    `https://api.tiingo.com/iex/?tickers=${tickerList}&token=${TIINGO_KEY}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${TIINGO_KEY}`
      }
    }
  );

  console.log('Tiingo status:', tiingoRes.status);
  console.log('Tiingo response:', JSON.stringify(tiingoRes.body).slice(0, 500));

  const prices = {};
  const errors = [];

  if (tiingoRes.status === 200 && Array.isArray(tiingoRes.body)) {
    tiingoRes.body.forEach(quote => {
      const ticker = quote.ticker?.toUpperCase();
      if (ticker && quote.last) {
        prices[ticker] = {
          price: quote.last,
          prevClose: quote.prevClose || null,
          high: quote.high || null,
          low: quote.low || null,
          timestamp: quote.timestamp || new Date().toISOString()
        };
        console.log(`   ✓ ${ticker}: $${quote.last}`);
      } else {
        errors.push(ticker || 'unknown');
        console.log(`   ✗ ${ticker}: no price data`);
      }
    });
  } else {
    console.error('Tiingo failed:', tiingoRes.status);
    [...tickers].forEach(t => errors.push(t));
  }

  // 4. Build market summary
  const qqq = prices['QQQ'] || {};
  const change = qqq.price && qqq.prevClose ? qqq.price - qqq.prevClose : null;
  const changePct = change && qqq.prevClose ? (change / qqq.prevClose) * 100 : null;
  const market = {
    symbol: 'QQQ',
    price: qqq.price || null,
    prevClose: qqq.prevClose || null,
    change,
    changePct,
    high: qqq.high || null,
    low: qqq.low || null
  };

  // 5. Write prices.json
  const output = {
    updatedAt: new Date().toISOString(),
    nextUpdate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    market,
    prices,
    errors: errors.length ? errors : undefined
  };

  fs.writeFileSync('prices.json', JSON.stringify(output, null, 2));
  console.log('\n4. prices.json written');
  console.log('Prices fetched:', Object.keys(prices).length);
  if (errors.length) console.log('Errors:', errors.join(', '));
  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

/* ============================================================
   ANGEL_REST.js
   All Angel One SmartAPI REST calls in one file
   Multi-user ready: apiKey and jwtToken passed as parameters
   ============================================================ */

const BASE_URL = 'https://apiconnect.angelone.in';

/* ---- Headers ---- */
function headers(apiKey, jwtToken = '') {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey
  };
  if (jwtToken) h['Authorization'] = 'Bearer ' + jwtToken;
  return h;
}

/* ---- Generic request ---- */
async function post(path, body, h) {
  const r = await fetch(BASE_URL + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return r.json();
}
async function get(path, h) {
  const r = await fetch(BASE_URL + path, { headers: h });
  return r.json();
}

/* ============================================================
   1. LOGIN (returns jwtToken, refreshToken, feedToken)
   ============================================================ */
export async function login({ apiKey, clientId, mpin, totp }) {
  return post('/rest/auth/angelbroking/user/v1/loginByPassword',
    { clientcode: clientId, password: mpin, totp },
    headers(apiKey)
  );
}

/* ============================================================
   2. FETCH CANDLES (used for 9:15 candle)
   ============================================================ */
export async function getCandles({ apiKey, jwtToken, exchange, token, interval, from, to }) {
  return post('/rest/secure/angelbroking/historical/v1/getCandleData',
    { exchange, symboltoken: token, interval, fromdate: from, todate: to },
    headers(apiKey, jwtToken)
  );
}

/* ============================================================
   3. MARKET QUOTE (LTP / OHLC in one call for up to 50 tokens)
   mode: 'LTP' | 'OHLC' | 'FULL'
   ============================================================ */
export async function getQuote({ apiKey, jwtToken, mode = 'OHLC', exchange = 'NSE', tokens }) {
  return post('/rest/secure/angelbroking/market/v1/quote',
    { mode, exchangeTokens: { [exchange]: tokens } },
    headers(apiKey, jwtToken)
  );
}

/* ============================================================
   4. POSITIONS (user's own — requires user's jwtToken)
   ============================================================ */
export async function getPositions({ apiKey, jwtToken }) {
  return get('/rest/secure/angelbroking/order/v1/getPosition', headers(apiKey, jwtToken));
}

/* ============================================================
   5. HOLDINGS (user's own)
   ============================================================ */
export async function getHoldings({ apiKey, jwtToken }) {
  return get('/rest/secure/angelbroking/portfolio/v1/getAllHolding', headers(apiKey, jwtToken));
}

/* ============================================================
   6. PLACE ORDER (future — needs static IP + user's own apiKey)
   ============================================================ */
export async function placeOrder({ apiKey, jwtToken, order }) {
  return post('/rest/secure/angelbroking/order/v1/placeOrder', order, headers(apiKey, jwtToken));
}

/* ============================================================
   Angel_Depth.js — v1.0 (MODE 3 SNAP QUOTE / DEPTH)
   ------------------------------------------------------------
   Alag WebSocket connection — sirf depth data (buyers vs sellers)
   Packet 379 bytes — layout CONFIRMED via hex diagnostic (2026-10-14):
     [0]      mode (3)
     [1]      exchange (1=NSE)
     [2-26]   token (25B ascii)
     [27-34]  sequence
     [35-42]  exchange timestamp (ms)
     [43-50]  LTP (paise ÷100)
     [51-58]  last traded qty
     [59-66]  avg traded price = VWAP (paise ÷100)
     [67-74]  cumulative volume
     [347-354] TOTAL BUY QTY   ← buyers
     [355-362] TOTAL SELL QTY  ← sellers
     [363-370] alt buy  (validation log)
     [371-378] alt sell (validation log)
   Quota: mode3 = 3 subscription/token → max ~333 tokens/connection
   ============================================================ */

import WebSocket from 'ws';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const HEARTBEAT_MS = 25000;
const RECONNECT_DELAY_MS = 5000;

let ws = null;
let shouldRun = false;
let feedToken = null;
let apiKey = null;
let clientCode = null;
let depthTokens = [];
let onDepth = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_DELAY_MS;   // v1.1: exponential backoff (429 se bachne ke liye)
let _validateLogged = new Set();

export function startDepthWS({ feedToken: ft, apiKey: key, clientCode: code, tokens, onDepth: cb }) {
  feedToken = ft;
  apiKey = key;
  clientCode = code;
  depthTokens = [...tokens];
  onDepth = cb;
  shouldRun = true;
  connect();
}

export function stopDepthWS() {
  shouldRun = false;
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

/* Live list badlo (top-300 change% refresh) — resubscribe */
export function resubscribeDepth(tokens) {
  depthTokens = [...tokens];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 0, params: { mode: 3, tokenList: [] } }));
    sendSubscribe();
  }
}

export function getDepthStatus() {
  return {
    running: shouldRun,
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    tokenCount: depthTokens.length
  };
}

function connect() {
  if (!shouldRun) return;
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);

  ws = new WebSocket(WS_URL, {
    headers: {
      'Authorization': `Bearer ${feedToken}`,
      'x-api-key': apiKey,
      'x-client-code': clientCode,
      'x-feed-token': feedToken
    }
  });

  ws.on('open', () => {
    reconnectDelay = RECONNECT_DELAY_MS;   // reset backoff on success
    console.log(`🧿 Depth WS connected (${depthTokens.length} tokens, mode=3)`);
    sendSubscribe();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send('ping'); } catch {} }
    }, HEARTBEAT_MS);
  });

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 30) return;
    try {
      const d = parseDepth(buf);
      if (d && onDepth) onDepth(d);
    } catch (e) {
      console.error('🧿 Depth parse error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🧿 Depth WS closed code=${code} reason=${reason?.toString() || ''}`);
    handleDrop();
  });

  ws.on('error', (e) => {
    console.log('🧿 Depth WS error:', e.message);
    handleDrop();
  });

  ws.on('ping', () => { try { ws.pong(); } catch {} });
}

function sendSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!depthTokens.length) return;
  ws.send(JSON.stringify({
    action: 1,
    params: {
      mode: 3,
      tokenList: [
        { exchangeType: 1, tokens: depthTokens }
      ]
    }
  }));
  console.log(`🧿 Depth subscribed: ${depthTokens.length} tokens (quota ${depthTokens.length * 3}/1000)`);
}

function handleDrop() {
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  if (!shouldRun) return;
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);   // 5s → 10s → 20s → 40s → 60s cap
}

function parseDepth(buf) {
  const len = buf.length;
  if (len !== 379) return null;

  const token = buf.slice(2, 27).toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  const ltp = Number(buf.readBigInt64LE(43)) / 100;
  if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;

  const ltq     = Number(buf.readBigInt64LE(51));
  const avg     = Number(buf.readBigInt64LE(59)) / 100;
  const volume  = Number(buf.readBigInt64LE(67));
  const buyQty  = Number(buf.readBigInt64LE(347));
  const sellQty = Number(buf.readBigInt64LE(355));
  const altBuy  = Number(buf.readBigInt64LE(363));
  const altSell = Number(buf.readBigInt64LE(371));

  return {
    token,
    ltp: +ltp.toFixed(2),
    ltq: Number.isFinite(ltq) && ltq >= 0 ? ltq : null,
    avgPrice: Number.isFinite(avg) && avg > 0 ? +avg.toFixed(2) : null,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    buyQty: Number.isFinite(buyQty) && buyQty >= 0 ? buyQty : null,
    sellQty: Number.isFinite(sellQty) && sellQty >= 0 ? sellQty : null,
    altBuy, altSell,
    ts: Date.now(),
    shouldValidate: !_validateLogged.has(token) && (_validateLogged.add(token), true)
  };
}

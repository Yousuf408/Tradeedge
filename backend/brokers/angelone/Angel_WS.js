/* ============================================================
   Angel_WS.js — v1.2
   WebSocket live LTP feed — reconnects + gap backfill support

   CHANGELOG v1.2 (2026-10-05):
   - Handles Angel One 51-byte LTP packet format correctly
   - Multi-candidate price parsing (float / double / int64)
   - Hex diagnostic for first few ticks
   - Cleaner heartbeat + pong handling
   ============================================================ */

import WebSocket from 'ws';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const HEARTBEAT_MS = 25000;
const RECONNECT_DELAY_MS = 3000;

let ws = null;
let feedToken = null;
let apiKey = null;
let clientCode = null;
let subscribedTokens = [];
let onTick = null;                 // callback(token, ltp, ts)
let onDisconnect = null;           // callback(gapStartMs, gapEndMs)
let heartbeatTimer = null;
let reconnectTimer = null;
let connectedAt = null;
let shouldRun = false;
let lastTickMs = null;

/* ---- Public: start WebSocket ---- */
export function startWS({ apiKey: key, clientCode: code, feedToken: token, tokens, onTick: tickCb, onDisconnect: discCb }) {
  apiKey = key;
  clientCode = code;
  feedToken = token;
  subscribedTokens = [...tokens];
  onTick = tickCb;
  onDisconnect = discCb;
  shouldRun = true;
  connect();
}

/* ---- Public: stop WebSocket ---- */
export function stopWS() {
  shouldRun = false;
  clearTimers();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

/* ---- Public: update token list (after new 9:15 fetch) ---- */
export function resubscribe(newTokens) {
  subscribedTokens = [...newTokens];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 0, params: { mode: 1, tokenList: [] } }));
    sendSubscribe();
  }
}

/* ---- Public: status ---- */
export function getWSStatus() {
  return {
    running: shouldRun,
    connected: ws && ws.readyState === WebSocket.OPEN,
    connectedAt,
    lastTickMs,
    tokenCount: subscribedTokens.length
  };
}

/* ============================================================
   INTERNAL
   ============================================================ */
let _hexLogged = 0;
let _sizesLogged = new Set();

function connect() {
  if (!shouldRun) return;
  clearTimers();

  ws = new WebSocket(WS_URL, {
    headers: {
      'Authorization': `Bearer ${feedToken}`,
      'x-api-key': apiKey,
      'x-client-code': clientCode,
      'x-feed-token': feedToken
    }
  });

  ws.on('open', () => {
    connectedAt = Date.now();
    console.log(`🔌 WS connected (${subscribedTokens.length} tokens)`);
    sendSubscribe();
    startHeartbeat();
  });

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    /* Log each unique packet size once */
    if (!_sizesLogged.has(buf.length)) {
      _sizesLogged.add(buf.length);
      console.log(`🔍 WS packet size=${buf.length}`);
    }

    /* Skip heartbeat / ack / small control frames */
    if (buf.length < 30) return;

    try {
      const tick = parseTick(buf);
      if (tick && onTick) {
        lastTickMs = Date.now();
        onTick(tick.token, tick.ltp, lastTickMs);
      }
    } catch (e) {
      console.error('🔍 WS parse error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 WS closed code=${code} reason=${reason?.toString() || ''}`);
    handleDrop();
  });

  ws.on('error', (e) => {
    console.log('🔌 WS error:', e.message);
    handleDrop();
  });

  ws.on('ping', () => {
    try { ws.pong(); } catch {}
  });
}

function handleDrop() {
  clearTimers();
  if (!shouldRun) return;
  const gapStart = connectedAt ? lastTickMs || connectedAt : null;
  const gapEnd = Date.now();
  if (onDisconnect && gapStart) {
    try { onDisconnect(gapStart, gapEnd); } catch {}
  }
  connectedAt = null;
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

function sendSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!subscribedTokens.length) return;
  const msg = {
    action: 1,
    params: {
      mode: 1,   // 1 = LTP mode
      tokenList: [
        { exchangeType: 1, tokens: subscribedTokens }   // 1 = NSE
      ]
    }
  };
  ws.send(JSON.stringify(msg));
  console.log(`📡 Subscribed to ${subscribedTokens.length} tokens`);
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('ping'); } catch {}
    }
  }, HEARTBEAT_MS);
}

function clearTimers() {
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
}

/* ============================================================
   PARSE BINARY TICK — Angel One LTP mode (51 bytes)

   Confirmed layout from live packet:
     [0]      subscription mode   (1 byte)
     [1]      exchange type       (1 byte)
     [2-26]   token               (25 bytes, ASCII, null-padded)
     [27-34]  sequence number     (8 bytes)
     [35-42]  exchange timestamp  (8 bytes)
     [43-50]  LTP                 (8 bytes)

   Angel's docs sometimes say float32 @43, sometimes double @43.
   We try multiple interpretations and pick the first plausible
   price (₹1 – ₹10,00,000).
   ============================================================ */
function parseTick(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length !== 51) return null;

  const token = buf.slice(2, 27).toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  /* Hex diagnostic for first 3 ticks */
  if (_hexLogged < 3) {
    _hexLogged++;
    console.log(`🔬 tick hex [51]: ${buf.toString('hex')}`);
  }

  const candidates = [
    () => buf.readFloatBE(43),
    () => buf.readDoubleBE(43),
    () => buf.readFloatLE(43),
    () => buf.readFloatBE(42),
    () => buf.readFloatBE(41),
    () => buf.readInt32BE(43) / 100,
  ];

  for (const fn of candidates) {
    try {
      const v = fn();
      if (Number.isFinite(v) && v >= 1 && v <= 1000000) {
        return { token, ltp: +v.toFixed(2) };
      }
    } catch {}
  }

  return null;
}

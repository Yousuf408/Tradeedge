/* ============================================================
   Angel_WS.js — v1.1
   WebSocket live LTP feed — reconnects + gap backfill support
   Uses feedToken from Angel_REST login

   CHANGELOG v1.1 (2026-10-05):
   - Handles both 51-byte and 52-byte LTP packets
   - Logs unique packet sizes for diagnostics
   - Logs parse errors instead of silently swallowing
   - Logs heartbeat / ack frames
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
    ws.send(JSON.stringify({ action: 0, params: { mode: 1, tokenList: [] } })); // unsubscribe all
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

  ws._loggedSizes = new Set();   // diagnostic: track unique packet sizes

  ws.on('open', () => {
    connectedAt = Date.now();
    console.log(`🔌 WS connected (${subscribedTokens.length} tokens)`);
    sendSubscribe();
    startHeartbeat();
  });

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    /* Diagnostic — log each unique packet size once */
    if (!ws._loggedSizes.has(buf.length)) {
      ws._loggedSizes.add(buf.length);
      const preview = buf.slice(0, Math.min(20, buf.length)).toString('hex');
      console.log(`🔍 WS packet size=${buf.length} hex=${preview}`);
    }

    /* Skip heartbeat / ack frames (very small) */
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
      mode: 1,   // LTP mode
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
   PARSE BINARY TICK (LTP mode)
   Angel One sends 51-byte OR 52-byte packets depending on SDK.

   Layout (52-byte):
     [0]     subscription mode (1 byte)
     [1]     exchange type (1 byte)
     [2-26]  token (25 bytes, null-padded ASCII)
     [27-34] sequence number (8 bytes)
     [35-42] exchange timestamp (8 bytes)
     [43-50] LTP (8 bytes double, big-endian)

   Layout (51-byte):
     [0]     subscription mode (1 byte)
     [1]     exchange type (1 byte)
     [2-26]  token (25 bytes, null-padded ASCII)
     [27-34] sequence number (8 bytes)
     [35-42] exchange timestamp (8 bytes)
     [43-50] LTP (8 bytes double, big-endian)  ← same
   NOTE: The token offset shifts by 1 byte between versions.
   ============================================================ */
function parseTick(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (buf.length !== 51 && buf.length !== 52) {
    return null;
  }

  /* Token starts at byte 2 for 52-byte, byte 1 for 51-byte.
     Slice generously and trim nulls — safe for both. */
  const tokenStart = buf.length === 52 ? 2 : 1;
  const token = buf.slice(tokenStart, tokenStart + 25).toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  /* LTP is always last 8 bytes (big-endian double) */
  const ltp = buf.readDoubleBE(buf.length - 8);
  if (!ltp || isNaN(ltp) || ltp <= 0) return null;

  return { token, ltp };
}

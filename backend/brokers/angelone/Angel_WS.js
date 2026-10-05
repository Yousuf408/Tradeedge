/* ============================================================
   Angel_WS.js — v1.3
   WebSocket live LTP feed — reconnects + gap backfill support

   CHANGELOG v1.3 (2026-10-05):
   - Confirmed Angel One 51-byte LTP packet format from live hex
   - LTP = int64 little-endian at byte 43, in paise (÷100)
   - Token = bytes 2-26 ASCII, null-trimmed
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
let onTick = null;
let onDisconnect = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let connectedAt = null;
let shouldRun = false;
let lastTickMs = null;

/* ---- Public: start ---- */
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

/* ---- Public: stop ---- */
export function stopWS() {
  shouldRun = false;
  clearTimers();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

/* ---- Public: resubscribe ---- */
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
const _sizesLogged = new Set();

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

    if (!_sizesLogged.has(buf.length)) {
      _sizesLogged.add(buf.length);
      console.log(`🔍 WS packet size=${buf.length}`);
    }

    if (buf.length < 30) return;   // heartbeat / ack

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
  ws.send(JSON.stringify({
    action: 1,
    params: {
      mode: 1,   // LTP mode
      tokenList: [
        { exchangeType: 1, tokens: subscribedTokens }   // 1 = NSE
      ]
    }
  }));
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

   Confirmed from live hex:
     [0]      mode
     [1]      exchange type
     [2-26]   token (25 bytes ASCII, null-padded)
     [27-34]  sequence (int64 LE)
     [35-42]  exchange timestamp (int64 LE, epoch ms)
     [43-50]  LTP (int64 LE, price × 100 in paise)
   ============================================================ */
function parseTick(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length !== 51) return null;

  const token = buf.slice(2, 27).toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  if (_hexLogged < 3) {
    _hexLogged++;
    console.log(`🔬 tick hex [51]: ${buf.toString('hex')}`);
  }

  /* Price × 100, little-endian int64 at byte 43 */
  const ltpPaise = buf.readBigInt64LE(43);
  const ltp = Number(ltpPaise) / 100;

  if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;
  return { token, ltp: +ltp.toFixed(2) };
}

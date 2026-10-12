/* ============================================================
   Angel_WS.js — v1.4
   WebSocket live feed — reconnects + gap backfill support

   CHANGELOG v1.4:
   - Subscribe mode ab configurable: WS_MODE env (default 2 = Quote)
     mode 1 = LTP only (51-byte packet, purana behaviour)
     mode 2 = Quote  (115-byte packet: ltp + volume + O/H/L/C)  ← volume yahan milta hai
     mode 3 = Snap Quote (depth wala, bahut heavy — zaroorat nahi)
   - parseTick ab 51 aur 115 dono packet samajhta hai
   - onTick callback ko 4th arg me poora tick object milta hai
     (server.js isme se volume nikalta hai)
   - Rollback: env me WS_MODE=1 set karo = bilkul purana behaviour
   ============================================================ */

import WebSocket from 'ws';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const HEARTBEAT_MS = 25000;
const RECONNECT_DELAY_MS = 3000;
const WS_MODE = Number(process.env.WS_MODE || 2);   // 1=LTP, 2=Quote

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
    ws.send(JSON.stringify({ action: 0, params: { mode: WS_MODE, tokenList: [] } }));
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
    mode: WS_MODE,
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
    console.log(`🔌 WS connected (${subscribedTokens.length} tokens, mode=${WS_MODE})`);
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
        onTick(tick.token, tick.ltp, lastTickMs, tick);
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
      mode: WS_MODE,   // v1.4: 2 = Quote (ltp + volume + OHLC)
      tokenList: [
        { exchangeType: 1, tokens: subscribedTokens }   // 1 = NSE
      ]
    }
  }));
  console.log(`📡 Subscribed to ${subscribedTokens.length} tokens (mode=${WS_MODE})`);
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
   PARSE BINARY TICK — Angel One WebSocket

   LTP mode (51 bytes) — confirmed from live hex:
     [0]      mode
     [1]      exchange type
     [2-26]   token (25 bytes ASCII, null-padded)
     [27-34]  sequence (int64 LE)
     [35-42]  exchange timestamp (int64 LE, epoch ms)
     [43-50]  LTP (int64 LE, price × 100 in paise)

   Quote mode (115 bytes) — documented layout:
     [0]      mode
     [1]      exchange type
     [2-26]   token
     [27-34]  sequence
     [35-42]  exchange timestamp
     [43-50]  last traded time (int64 LE)
     [51-58]  last traded quantity (int64 LE)
     [59-66]  average traded price (int64 LE, paise)
     [67-74]  VOLUME traded today (int64 LE, raw shares — ÷100 NAHI)
     [75-82]  open  (paise)
     [83-90]  high  (paise)
     [91-98]  low   (paise)
     [99-106] close (paise, prev day close)
     [107-114] LTP  (paise)

   NOTE: deploy ke baad pehle packet ka hex log hoga (_hexLogged).
   Ek baar RELIANCE jaise liquid stock pe cross-check kar lena:
   parsed ltp ≈ REST quote ltp, parsed volume ≈ REST quote volume.
   ============================================================ */
function parseTick(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const len = buf.length;

  if (len !== 51 && len !== 115) return null;

  const token = buf.slice(2, 27).toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  if (_hexLogged < 3) {
    _hexLogged++;
    console.log(`🔬 tick hex [${len}]: ${buf.toString('hex')}`);
  }

  if (len === 51) {
    /* LTP mode — price × 100, little-endian int64 at byte 43 */
    const ltp = Number(buf.readBigInt64LE(43)) / 100;
    if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;
    return { token, ltp: +ltp.toFixed(2), volume: null };
  }

  /* Quote mode (115 bytes) */
  const ltp = Number(buf.readBigInt64LE(107)) / 100;
  if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;

  const volume = Number(buf.readBigInt64LE(67));
  const open   = Number(buf.readBigInt64LE(75)) / 100;
  const high   = Number(buf.readBigInt64LE(83)) / 100;
  const low    = Number(buf.readBigInt64LE(91)) / 100;
  const close  = Number(buf.readBigInt64LE(99)) / 100;

  return {
    token,
    ltp: +ltp.toFixed(2),
    volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    open: open > 0 ? +open.toFixed(2) : null,
    high: high > 0 ? +high.toFixed(2) : null,
    low:  low  > 0 ? +low.toFixed(2)  : null,
    close: close > 0 ? +close.toFixed(2) : null
  };
}

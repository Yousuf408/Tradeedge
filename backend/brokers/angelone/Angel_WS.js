/* ============================================================
   Angel_WS.js — v1.8
   WebSocket live feed — reconnects + gap backfill support

   CHANGELOG v1.4:
   - Subscribe mode configurable: WS_MODE env (default 2 = Quote)
     mode 1 = LTP only (51-byte packet)
     mode 2 = Quote  (115-byte packet: ltp + volume + O/H/L/C)
   - onTick callback gets full tick object as 4th arg

   CHANGELOG v1.5:
   - Angel ne Quote packet 115 → 123 bytes kar diya
   - parseTick ab 123-byte packets bhi accept karta hai

   CHANGELOG v1.6:
   - DIAGNOSTIC: dumped all candidate offsets for first 5 ticks

   CHANGELOG v1.7 (2026-10-13):
   - CONFIRMED: 123-byte packet me NEW layout hai
       LTP moved 107 → 43
       Volume @ 67
       Low    @ 91
       High   @ 99
       Close  @ 107  (prev day close)
       Open   @ 115
   - Legacy 115-byte path untouched (rollback safe)

   CHANGELOG v1.8 (2026-10-14):
   - EXCHANGE VWAP: avg traded price field parse hota hai
       123-byte: @ 59-66   |   115-byte: @ 59-66
     → tick.avgPrice (paise ÷100) = TRUE cumulative VWAP
   - Server isko live VWAP column + ws_1min_vwap series me use karta hai
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
      mode: WS_MODE,
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

   LTP mode (51 bytes) — UNCHANGED:
     [0]      mode
     [1]      exchange type
     [2-26]   token (25 bytes ASCII, null-padded)
     [27-34]  sequence (int64 LE)
     [35-42]  exchange timestamp (int64 LE, epoch ms)
     [43-50]  LTP (int64 LE, price × 100 in paise)

   Quote mode (123 bytes) — v1.7 layout + v1.8 avg:
     [43-50]  LTP        (paise ÷100)
     [51-58]  last traded qty / time block
     [59-66]  AVG TRADED PRICE = TRUE VWAP (paise ÷100)   ← v1.8
     [67-74]  VOLUME traded today (raw shares)
     [91-98]  low       (paise ÷100)
     [99-106] high      (paise ÷100)
     [107-114] close    (paise ÷100, prev day close)
     [115-122] open     (paise ÷100)

   Quote mode (115 bytes) — LEGACY (rollback safe):
     [43-50]  last traded time
     [59-66]  avg traded price (VWAP)                     ← v1.8
     [67-74]  volume
     [75-82]  open | [83-90] high | [91-98] low | [99-106] close
     [107-114] LTP
   ============================================================ */
function parseTick(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const len = buf.length;

  // Log hex of first 3 real ticks (any size ≥30) — debug help
  if (_hexLogged < 3 && len >= 30) {
    _hexLogged++;
    console.log(`🔬 tick hex [${len}]: ${buf.toString('hex')}`);
  }

  if (len !== 51 && len !== 115 && len !== 123) return null;

  const token = buf.slice(2, 27).toString('ascii').replace(/\0+$/, '').trim();
  if (!token) return null;

  /* ---- LTP mode (51 bytes) — unchanged ---- */
  if (len === 51) {
    const ltp = Number(buf.readBigInt64LE(43)) / 100;
    if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;
    return { token, ltp: +ltp.toFixed(2), volume: null, avgPrice: null };
  }

  /* ---- Quote mode (123 bytes) — v1.7 layout + v1.8 VWAP ---- */
  if (len === 123) {
    const ltp = Number(buf.readBigInt64LE(43)) / 100;
    if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;

    const avg    = Number(buf.readBigInt64LE(59)) / 100;   // v1.8: exchange VWAP
    const volume = Number(buf.readBigInt64LE(67));
    const low    = Number(buf.readBigInt64LE(91))  / 100;
    const high   = Number(buf.readBigInt64LE(99))  / 100;
    const close  = Number(buf.readBigInt64LE(107)) / 100;
    const open   = Number(buf.readBigInt64LE(115)) / 100;

    return {
      token,
      ltp: +ltp.toFixed(2),
      avgPrice: Number.isFinite(avg) && avg > 0 ? +avg.toFixed(2) : null,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
      open:  open  > 0 ? +open.toFixed(2)  : null,
      high:  high  > 0 ? +high.toFixed(2)  : null,
      low:   low   > 0 ? +low.toFixed(2)   : null,
      close: close > 0 ? +close.toFixed(2) : null
    };
  }

  /* ---- Quote mode (115 bytes) — LEGACY rollback path ---- */
  const ltp = Number(buf.readBigInt64LE(107)) / 100;
  if (!Number.isFinite(ltp) || ltp <= 0 || ltp > 10000000) return null;

  const avg    = Number(buf.readBigInt64LE(59)) / 100;   // v1.8
  const volume = Number(buf.readBigInt64LE(67));
  const open   = Number(buf.readBigInt64LE(75)) / 100;
  const high   = Number(buf.readBigInt64LE(83)) / 100;
  const low    = Number(buf.readBigInt64LE(91)) / 100;
  const close  = Number(buf.readBigInt64LE(99)) / 100;

  return {
    token,
    ltp: +ltp.toFixed(2),
    avgPrice: Number.isFinite(avg) && avg > 0 ? +avg.toFixed(2) : null,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    open:  open  > 0 ? +open.toFixed(2)  : null,
    high:  high  > 0 ? +high.toFixed(2)  : null,
    low:   low   > 0 ? +low.toFixed(2)   : null,
    close: close > 0 ? +close.toFixed(2) : null
  };
}

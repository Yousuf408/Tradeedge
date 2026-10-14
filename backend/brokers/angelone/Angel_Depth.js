/* ============================================================
   Angel_Depth.js — v0.9 (DIAGNOSTIC BUILD)
   ------------------------------------------------------------
   Mode 3 (Snap Quote / Depth) ka alag WebSocket connection.
   ABHI KA MAQSAD: sirf packet capture + field dump taaki
   123/xxx-byte depth layout ke exact offsets confirm ho sakein.

   - Enable: env DEPTH_DIAG=true  (default OFF = kuch nahi hota)
   - Tokens: env DEPTH_DIAG_TOKENS="token1,token2,..." ya default pehle 5 stocks
   - Main Angel_WS.js (quote feed) se koi lena-dena nahi — alag connection
   - Parse confirm hone ke baad v1.0 me asli depth parser aayega
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
let onPacket = null;
let heartbeatTimer = null;
let reconnectTimer = null;

export function startDepthWS({ feedToken: ft, apiKey: key, clientCode: code, tokens, onPacket: cb }) {
  feedToken = ft;
  apiKey = key;
  clientCode = code;
  depthTokens = [...tokens];
  onPacket = cb;
  shouldRun = true;
  connect();
}

export function stopDepthWS() {
  shouldRun = false;
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch {} ws = null; }
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
    console.log(`🧪 DEPTH WS connected (${depthTokens.length} tokens, mode=3)`);
    ws.send(JSON.stringify({
      action: 1,
      params: {
        mode: 3,   // SNAP QUOTE / DEPTH
        tokenList: [
          { exchangeType: 1, tokens: depthTokens }
        ]
      }
    }));
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send('ping'); } catch {} }
    }, HEARTBEAT_MS);
  });

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 30) return;   // heartbeat / ack
    try {
      const token = buf.slice(2, 27).toString('ascii').replace(/\0+$/, '').trim();
      // har 8-byte int64 field ka raw + price-form dump (offset 27 se aage)
      const fields = [];
      for (let off = 27; off + 8 <= buf.length; off += 8) {
        const raw = Number(buf.readBigInt64LE(off));
        fields.push({ off, raw, price: +(raw / 100).toFixed(2) });
      }
      if (onPacket) onPacket({ token, len: buf.length, fields, hex: buf.toString('hex') });
    } catch (e) {
      console.error('🧪 DEPTH parse error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🧪 DEPTH WS closed code=${code} reason=${reason?.toString() || ''}`);
    handleDrop();
  });

  ws.on('error', (e) => {
    console.log('🧪 DEPTH WS error:', e.message);
    handleDrop();
  });

  ws.on('ping', () => { try { ws.pong(); } catch {} });
}

function handleDrop() {
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  if (!shouldRun) return;
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

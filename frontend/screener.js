/* ============================================================
   SCREENER.JS  — v1.1
   Multi-strategy + ORB stage tracking + timestamps
   + cachedTokens tracking (survives browser crash)
   ============================================================ */

let SCREENER_ALL_STOCKS = [];
let SCREENER_STOCKS = [];
let SCREENER_ALL_CANDLES = {};
let SCREENER_CACHED_TOKENS = new Set();   // tokens already saved server-side
let SCREENER_LTP = {};
let SCREENER_ORB = {};
let SCREENER_INIT_DONE = false;
let SCREENER_LTP_TIMER = null;
let FETCHING = false;

const CURRENT_STRATEGY = 'advance_orb';
const STRATEGY_FILTER = { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 };

let PER_TRADE = 10000;
const BATCH_SIZE = 20;      // was 50 — fewer round trips
const BATCH_DELAY = 150;     // was 500

/* ============================================================
   SECTION 1 — INIT
   ============================================================ */
async function initScreener() {
  if (SCREENER_INIT_DONE) {
    renderScreenerTable();
    if (!SCREENER_LTP_TIMER) startLTPRefresh();
    return;
  }
  setupControls();
  await loadStockList();
  await loadCachedData();
  SCREENER_INIT_DONE = true;
}

/* ============================================================
   SECTION 2 — CONTROLS
   ============================================================ */
function setupControls() {
  const controls = document.querySelector('.screener-controls');
  if (!controls) return;

  ['#strategySelect', '.toggle-wrapper'].forEach(sel => {
    const el = controls.querySelector(sel);
    if (el) el.style.display = 'none';
  });
  controls.querySelectorAll('button, label').forEach(el => el.style.display = 'none');

  controls.innerHTML = `
    <button id="fetch915Btn" class="btn btn-primary" onclick="startFetch()">⚡ Fetch 9:15 Candles</button>
    <span id="screenerStatusPill"
          style="font-size:12px;font-weight:600;color:var(--text-muted);padding:6px 14px;
                 background:rgba(108,92,231,0.06);border-radius:20px;margin-left:12px">Ready</span>
    <span style="font-size:11px;color:var(--text-muted);margin-left:12px">
      Range ≤ ${STRATEGY_FILTER.maxRangePct}% · ₹${STRATEGY_FILTER.minPrice}–${STRATEGY_FILTER.maxPrice}
    </span>
    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-left:16px">Per-Trade ₹</label>
    <input id="perTradeInput" type="number" value="10000" min="100"
           style="width:120px;padding:8px 12px;border:2px solid rgba(0,0,0,0.06);border-radius:10px;
                  font-size:13px;font-family:inherit"
           onchange="onPerTradeChange()" />
    <div id="progressBar" style="display:none;width:100%;margin-top:12px">
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;height:8px;overflow:hidden">
        <div id="progressFill" style="background:var(--gradient-brand);height:100%;width:0%;transition:width 0.3s"></div>
      </div>
      <div id="progressText" style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center">0 / 0</div>
    </div>`;
}

function onPerTradeChange() {
  PER_TRADE = +document.getElementById('perTradeInput').value || 10000;
  renderScreenerTable();
}

/* ============================================================
   SECTION 3 — FILTER
   ============================================================ */
function passesFilter(candle) {
  if (!candle) return false;
  const rangePct = ((candle.high - candle.low) / candle.low) * 100;
  if (rangePct > STRATEGY_FILTER.maxRangePct) return false;
  if (candle.close < STRATEGY_FILTER.minPrice || candle.close > STRATEGY_FILTER.maxPrice) return false;
  return true;
}

function recomputeFilteredStocks() {
  SCREENER_STOCKS = SCREENER_ALL_STOCKS.filter(s => passesFilter(SCREENER_ALL_CANDLES[s.token]));
}

/* ============================================================
   SECTION 4 — LOAD STOCK LIST + CACHED DATA
   ============================================================ */
async function loadStockList() {
  try {
    const r = await fetch(API + '/api/stocks', { headers: { Authorization: 'Bearer ' + getToken() } });
    if (r.ok) SCREENER_ALL_STOCKS = await r.json();
  } catch (e) { console.error('Stock list failed:', e); }
}

async function loadCachedData() {
  try {
    const r = await fetch(API + '/api/screener/data?strategy=' + CURRENT_STRATEGY, {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();
    if (!d.ok) return;

    // Load cached candles (only the passing ones come back here — that's fine)
    SCREENER_ALL_CANDLES = {};
    if (d.results) {
      for (const item of d.results) {
        const c = item.candle;
        if (Array.isArray(c) && c.length >= 5) {
          SCREENER_ALL_CANDLES[item.token] = {
            open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
          };
        }
      }
    }

    // Track which tokens are already saved on the server
    if (Array.isArray(d.cachedTokens)) {
      d.cachedTokens.forEach(t => SCREENER_CACHED_TOKENS.add(String(t)));
    }

    // Do NOT overwrite SCREENER_ALL_STOCKS — /api/stocks already has the full list
    recomputeFilteredStocks();
    renderScreenerTable();

    if (Object.keys(SCREENER_ALL_CANDLES).length) {
      await loadLTP();
      startLTPRefresh();
    }
  } catch (e) { console.error(e); }
}

/* ============================================================
   SECTION 5 — FETCH
   ============================================================ */
async function startFetch() {
  if (FETCHING) return;
  if (!SCREENER_ALL_STOCKS.length) { showToast('⚠️ No stocks', ''); return; }

  FETCHING = true;
  const btn = document.getElementById('fetch915Btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';
  document.getElementById('progressBar').style.display = 'block';

  const allTokens = SCREENER_ALL_STOCKS.map(s => s.token);
  const total = allTokens.length;
  let ok = 0, failed = 0;

  // Only fetch what we haven't already saved on the server
  const missing = allTokens.filter(t => !SCREENER_CACHED_TOKENS.has(String(t)));

  if (!missing.length) {
    setPill('✅ Already cached', 'var(--success)');
    updateProgress(total, total);
    FETCHING = false;
    btn.disabled = false;
    btn.textContent = '⚡ Refresh';
    await loadLTP();
    startLTPRefresh();
    return;
  }

  setPill(`⏳ Fetching 0 / ${missing.length}...`, '#f39c12');
  updateProgress(0, total);

  const alreadyCached = total - missing.length;
  let done = alreadyCached;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);

    try {
      const r = await fetch(API + '/api/screener/fetch-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ tokens: batch })
      });
      const d = await r.json();
      if (d.results) {
        for (const item of d.results) {
          const c = item.candle;
          if (Array.isArray(c) && c.length >= 5) {
            SCREENER_ALL_CANDLES[item.token] = {
              open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
            };
            SCREENER_CACHED_TOKENS.add(String(item.token));   // remember it
            ok++;
          } else failed++;
        }
      }
    } catch (e) {
      failed += batch.length;
    }

    done = alreadyCached + i + batch.length;
    setPill(`⏳ Fetching ${done} / ${total}...`, '#f39c12');
    recomputeFilteredStocks();
    renderScreenerTable();
    updateProgress(done, total);

    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  setPill(`✅ Done — new:${ok} · failed:${failed} · passing:${SCREENER_STOCKS.length}`, 'var(--success)');
  FETCHING = false;
  btn.disabled = false;
  btn.textContent = '⚡ Refresh';

  await loadLTP();
  startLTPRefresh();
}

function updateProgress(done, total) {
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = `${done} / ${total} (${pct}%)`;
}

/* ============================================================
   SECTION 6 — LTP + ORB state
   ============================================================ */
async function loadLTP() {
  if (!SCREENER_STOCKS.length) return;
  try {
    const r = await fetch(API + '/api/screener/ltp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ tokens: SCREENER_STOCKS.map(s => s.token) })
    });
    const d = await r.json();
    if (d.results) {
      for (const item of d.results) {
        if (item.ltp) SCREENER_LTP[item.token] = item.ltp;
        SCREENER_ORB[item.token] = {
          lowBroken: !!item.lowBroken,
          pullbackConfirmed: !!item.pullbackConfirmed,
          entrySignal: !!item.entrySignal,
          newLowAt: item.newLowAt || null,
          pullbackAt: item.pullbackAt || null,
          breakoutAt: item.breakoutAt || null,
          serverTime: item.serverTime || null
        };
      }
    }
    renderScreenerTable();
  } catch (e) { console.error('LTP failed:', e); }
}

function startLTPRefresh() {
  if (SCREENER_LTP_TIMER) clearInterval(SCREENER_LTP_TIMER);
  SCREENER_LTP_TIMER = setInterval(() => loadLTP(), 15000);
}

/* ============================================================
   SECTION 7 — ORB STAGE + TIME HELPERS
   ============================================================ */
function resolveOrbStage(token, candle, ltp) {
  const orb = SCREENER_ORB[token] || { lowBroken: false, pullbackConfirmed: false, entrySignal: false };

  if (orb.entrySignal)      return { label: '🎯 ENTRY SIGNAL', color: '#6C5CE7', weight: 700 };
  if (orb.pullbackConfirmed) return { label: '↩️ Pullback confirmed', color: '#f39c12', weight: 600 };
  if (orb.lowBroken)         return { label: '⬇️ Low Broken', color: '#f39c12', weight: 600 };
  if (ltp && candle) {
    if (ltp > candle.high) return { label: '⏸️ Above High (ignored)', color: 'var(--text-muted)', weight: 500 };
    return { label: '⏸️ Inside Range', color: 'var(--text-muted)', weight: 500 };
  }
  return { label: '— waiting —', color: 'var(--text-muted)', weight: 500 };
}

function formatTimeIST(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(11, 19);
  } catch { return '—'; }
}

/* ============================================================
   SECTION 8 — RENDER
   ============================================================ */
function renderScreenerTable() {
  const head = document.getElementById('screenerHead');
  const body = document.getElementById('screenerBody');
  const count = document.getElementById('screenerCount');
  if (!head || !body) return;

  head.innerHTML = `<tr>
    <th>Stock / Company</th>
    <th>LTP</th>
    <th>9:15 H</th>
    <th>9:15 L</th>
    <th>SL</th>
    <th>Target</th>
    <th>MAXQTY</th>
    <th>NEW LOW</th>
    <th>PULLBACK</th>
    <th>BREAKOUT</th>
    <th>LAST UPDATE</th>
    <th>ORB STAGE</th>
    <th>ACTION</th>
  </tr>`;

  if (!SCREENER_STOCKS.length) {
    body.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:60px;color:var(--text-muted)">
      No stocks match the strategy filter yet.<br>
      Click <strong>⚡ Fetch 9:15 Candles</strong> to load data.
    </td></tr>`;
    if (count) count.textContent = `0 / ${SCREENER_ALL_STOCKS.length} match filter`;
    return;
  }

  body.innerHTML = SCREENER_STOCKS.map(s => {
    const c = SCREENER_ALL_CANDLES[s.token];
    const ltp = SCREENER_LTP[s.token];
    const orb = SCREENER_ORB[s.token] || {};

    const sl = c.low;
    const target = c.high * 1.01;
    const risk = ltp ? (ltp - sl) : (c.high - c.low);
    const maxQty = risk > 0 ? Math.floor(PER_TRADE / risk) : '—';
    const stage = resolveOrbStage(s.token, c, ltp);

    const newLowTime    = formatTimeIST(orb.newLowAt);
    const pullbackTime  = formatTimeIST(orb.pullbackAt);
    const breakoutTime  = formatTimeIST(orb.breakoutAt);
    const lastUpdate    = formatTimeIST(orb.serverTime);

    return `<tr>
      <td><strong>${s.sym}</strong><br><span style="font-size:11px;color:var(--text-muted)">${s.token}</span></td>
      <td style="font-weight:700">${ltp ? '₹' + ltp.toFixed(2) : '—'}</td>
      <td style="color:var(--success);font-weight:600">₹${c.high.toFixed(2)}</td>
      <td style="color:var(--danger);font-weight:600">₹${c.low.toFixed(2)}</td>
      <td>₹${sl.toFixed(2)}</td>
      <td style="color:#6C5CE7;font-weight:600">₹${target.toFixed(2)}</td>
      <td style="font-weight:700;color:#6C5CE7">${maxQty}</td>
      <td style="color:#e17055;font-weight:600;font-family:monospace">${newLowTime}</td>
      <td style="color:#f39c12;font-weight:600;font-family:monospace">${pullbackTime}</td>
      <td style="color:#00b894;font-weight:600;font-family:monospace">${breakoutTime}</td>
      <td style="color:var(--text-muted);font-size:11px;font-family:monospace">${lastUpdate}</td>
      <td style="color:${stage.color};font-weight:${stage.weight};font-size:12px">${stage.label}</td>
      <td>${orb.entrySignal
        ? `<button class="btn btn-success btn-sm" onclick="placeOrder('${s.sym}')">Buy</button>`
        : '<span style="color:var(--text-muted);font-size:11px">—</span>'}</td>
    </tr>`;
  }).join('');

  if (count) count.textContent = `${SCREENER_STOCKS.length} / ${SCREENER_ALL_STOCKS.length} match filter`;
}

/* ============================================================
   SECTION 9 — ORDER PLACEHOLDER
   ============================================================ */
function placeOrder(sym) {
  showToast('📝 Order', `Buy signal for ${sym} — order placement coming soon`);
}

/* ============================================================
   SECTION 10 — HELPERS
   ============================================================ */
function setPill(text, color) {
  const pill = document.getElementById('screenerStatusPill');
  if (!pill) return;
  pill.textContent = text;
  pill.style.color = color || 'var(--text-muted)';
}

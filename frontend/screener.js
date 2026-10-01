/* ============================================================
   SCREENER.JS
   Live 9:15 candles + LTP + SL + MAXQTY + Breakout
   Phase-aware: closed / forming / fetching / ready / weekend
   ============================================================ */

let SCREENER_STOCKS = [];
let SCREENER_CANDLES = {};
let SCREENER_LTP = {};
let SCREENER_INIT_DONE = false;
let SCREENER_POLL_TIMER = null;
let SCREENER_LTP_TIMER = null;

let PER_TRADE = 10000;
let SL_PCT = 1;

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
  await ensureDataLoaded();
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

  if (!document.getElementById('screenerStatusPill')) {
    controls.innerHTML = `
      <span id="screenerStatusPill"
            style="font-size:12px;font-weight:600;color:var(--text-muted);padding:6px 14px;
                   background:rgba(108,92,231,0.06);border-radius:20px">Loading...</span>
      <label style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-left:16px">Per-Trade ₹</label>
      <input id="perTradeInput" type="number" value="10000" min="100"
             style="width:120px;padding:8px 12px;border:2px solid rgba(0,0,0,0.06);border-radius:10px;
                    font-size:13px;font-family:inherit"
             onchange="onPerTradeChange()" />
      <label style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-left:8px">SL</label>
      <select id="slPctSelect" onchange="onSlChange()"
              style="padding:8px 12px;border:2px solid rgba(0,0,0,0.06);border-radius:10px;
                     font-size:13px;font-family:inherit;cursor:pointer">
        <option value="0.5">0.5% Fixed</option>
        <option value="1" selected>1% Fixed</option>
        <option value="2">2% Fixed</option>
      </select>`;
  }
}

function onPerTradeChange() {
  PER_TRADE = +document.getElementById('perTradeInput').value || 10000;
  renderScreenerTable();
}

function onSlChange() {
  SL_PCT = +document.getElementById('slPctSelect').value || 1;
  renderScreenerTable();
}

/* ============================================================
   SECTION 3 — STOCK LIST
   ============================================================ */
async function loadStockList() {
  try {
    const r = await fetch(API + '/api/stocks', { headers: { Authorization: 'Bearer ' + getToken() } });
    if (r.ok) SCREENER_STOCKS = await r.json();
  } catch (e) { console.error('Stock list failed:', e); }
}

/* ============================================================
   SECTION 4 — ENSURE DATA LOADED (phase-aware)
   ============================================================ */
async function ensureDataLoaded() {
  try {
    const r = await fetch(API + '/api/screener/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (d.phase === 'closed') {
      showPhaseMessage('🔒 Market closed — data will load after 9:30 AM');
      return;
    }
    if (d.phase === 'forming') {
      showPhaseMessage('🕘 9:15 candle is forming — data will load at 9:30 AM');
      startFormingPoller();
      return;
    }
    if (d.phase === 'ready') {
      setPill('✅ Live — ' + d.date, 'var(--success)');
      await fetchAndRender();
      await loadLTP();
      startLTPRefresh();
      return;
    }
    if (d.phase === 'fetching') {
      setPill(`⏳ Fetching 0 / ${d.total}...`, '#f39c12');
      startProgressPolling();
    }
  } catch (e) {
    setPill('⚠️ ' + e.message, 'var(--danger)');
  }
}

function showPhaseMessage(msg) {
  setPill(msg, '#f39c12');
  const head = document.getElementById('screenerHead');
  const body = document.getElementById('screenerBody');
  if (head) head.innerHTML = '';
  if (body) {
    body.innerHTML = `<tr><td colspan="8"
      style="text-align:center;padding:60px;color:var(--text-muted);font-size:14px">${msg}</td></tr>`;
  }
}

/* Polls every 30s while in 'forming' phase — auto-switches to fetch at 9:30 */
function startFormingPoller() {
  if (SCREENER_POLL_TIMER) clearInterval(SCREENER_POLL_TIMER);
  SCREENER_POLL_TIMER = setInterval(async () => {
    const r = await fetch(API + '/api/screener/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (d.phase === 'ready' || d.phase === 'fetching') {
      clearInterval(SCREENER_POLL_TIMER);
      SCREENER_POLL_TIMER = null;
      ensureDataLoaded();
    } else if (d.phase === 'closed') {
      clearInterval(SCREENER_POLL_TIMER);
      SCREENER_POLL_TIMER = null;
      showPhaseMessage('🔒 Market closed — data will load after 9:30 AM');
    }
  }, 30000);
}

/* ============================================================
   SECTION 5 — PROGRESS POLLING (during fetch)
   ============================================================ */
function startProgressPolling() {
  if (SCREENER_POLL_TIMER) clearInterval(SCREENER_POLL_TIMER);
  SCREENER_POLL_TIMER = setInterval(async () => {
    try {
      const r = await fetch(API + '/api/screener/status', {
        headers: { Authorization: 'Bearer ' + getToken() }
      });
      const d = await r.json();

      if (d.phase === 'fetching') {
        setPill(`⏳ Fetching ${d.progress} / ${d.total}...`, '#f39c12');
        await fetchAndRender();
      } else if (d.phase === 'ready' || d.phase === 'weekend') {
        clearInterval(SCREENER_POLL_TIMER);
        SCREENER_POLL_TIMER = null;
        setPill('✅ Live — ' + d.date, 'var(--success)');
        await fetchAndRender();
        await loadLTP();
        startLTPRefresh();
      } else if (d.phase === 'closed') {
        clearInterval(SCREENER_POLL_TIMER);
        SCREENER_POLL_TIMER = null;
        showPhaseMessage('🔒 Market closed — data will load after 9:30 AM');
      } else if (d.phase === 'forming') {
        clearInterval(SCREENER_POLL_TIMER);
        SCREENER_POLL_TIMER = null;
        showPhaseMessage('🕘 9:15 candle is forming — data will load at 9:30 AM');
        startFormingPoller();
      }
    } catch (e) { console.error(e); }
  }, 3000);
}

/* ============================================================
   SECTION 6 — FETCH CANDLES + RENDER
   ============================================================ */
async function fetchAndRender() {
  try {
    const r = await fetch(API + '/api/screener/data', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();
    if (!d.ok) return;

    SCREENER_CANDLES = {};
    if (d.results) {
      for (const item of d.results) {
        const c = item.candle;
        if (Array.isArray(c) && c.length >= 5) {
          SCREENER_CANDLES[item.token] = {
            open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
          };
        }
      }
    }
    renderScreenerTable();
  } catch (e) { console.error(e); }
}

/* ============================================================
   SECTION 7 — LTP (batch, 15s refresh)
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
   SECTION 8 — RENDER TABLE
   ============================================================ */
function renderScreenerTable() {
  const head = document.getElementById('screenerHead');
  const body = document.getElementById('screenerBody');
  const count = document.getElementById('screenerCount');
  if (!head || !body) return;

  head.innerHTML = `<tr>
    <th>Stock / Company</th>
    <th>Current LTP</th>
    <th>9:15 High</th>
    <th>9:15 Low</th>
    <th>SL (${SL_PCT}%)</th>
    <th>MAXQTY</th>
    <th>Range %</th>
    <th>Breakout Status</th>
  </tr>`;

  let loaded = 0;

  body.innerHTML = SCREENER_STOCKS.map(s => {
    const c = SCREENER_CANDLES[s.token];
    const ltp = SCREENER_LTP[s.token];

    if (!c) {
      return `<tr>
        <td><strong>${s.sym}</strong><br><span style="font-size:11px;color:var(--text-muted)">Token: ${s.token}</span></td>
        <td colspan="7" style="color:var(--text-muted);font-size:12px">— waiting —</td>
      </tr>`;
    }
    loaded++;

    const rangePct = (((c.high - c.low) / c.low) * 100).toFixed(2);
    const sl = ltp ? (ltp * (1 - SL_PCT / 100)) : null;
    const risk = ltp && sl ? (ltp - sl) : null;
    const maxQty = risk && risk > 0 ? Math.floor(PER_TRADE / risk) : '—';

    let breakout = '—', bColor = 'var(--text-muted)';
    if (ltp) {
      if (ltp > c.high) { breakout = '🚀 Bullish Breakout'; bColor = 'var(--success)'; }
      else if (ltp < c.low) { breakout = '📉 Bearish Breakdown'; bColor = 'var(--danger)'; }
      else { breakout = '⏸️ Inside Range'; bColor = 'var(--text-muted)'; }
    }

    return `<tr>
      <td><strong>${s.sym}</strong><br><span style="font-size:11px;color:var(--text-muted)">Token: ${s.token}</span></td>
      <td style="font-weight:700">${ltp ? '₹' + ltp.toFixed(2) : '—'}</td>
      <td style="color:var(--success);font-weight:600">₹${c.high.toFixed(2)}</td>
      <td style="color:var(--danger);font-weight:600">₹${c.low.toFixed(2)}</td>
      <td>${sl ? '₹' + sl.toFixed(2) : '—'}</td>
      <td style="font-weight:700;color:#6C5CE7">${maxQty}</td>
      <td>${rangePct}%</td>
      <td style="color:${bColor};font-weight:600">${breakout}</td>
    </tr>`;
  }).join('');

  if (count) count.textContent = `${loaded} / ${SCREENER_STOCKS.length} loaded`;
}

/* ============================================================
   SECTION 9 — HELPERS
   ============================================================ */
function setPill(text, color) {
  const pill = document.getElementById('screenerStatusPill');
  if (!pill) return;
  pill.textContent = text;
  pill.style.color = color || 'var(--text-muted)';
}

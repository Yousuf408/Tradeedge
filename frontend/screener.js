/* ============================================================
   SCREENER.JS
   Manual button-triggered fetch with progress bar
   Client sends 20 tokens per batch → server fetches → client waits 7s
   ============================================================ */

let SCREENER_STOCKS = [];
let SCREENER_CANDLES = {};
let SCREENER_LTP = {};
let SCREENER_INIT_DONE = false;
let SCREENER_LTP_TIMER = null;
let FETCHING = false;

let PER_TRADE = 10000;
let SL_PCT = 1;

const BATCH_SIZE = 20;
const BATCH_DELAY = 7000;

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
   SECTION 2 — CONTROLS (button + Per-Trade + SL)
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
    </select>

    <div id="progressBar" style="display:none;width:100%;margin-top:12px">
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;height:8px;overflow:hidden">
        <div id="progressFill" style="background:var(--gradient-brand);height:100%;width:0%;transition:width 0.3s"></div>
      </div>
      <div id="progressText" style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center">0 / 500</div>
    </div>`;
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
   SECTION 3 — LOAD STOCK LIST + CACHED DATA
   ============================================================ */
async function loadStockList() {
  try {
    const r = await fetch(API + '/api/stocks', { headers: { Authorization: 'Bearer ' + getToken() } });
    if (r.ok) SCREENER_STOCKS = await r.json();
  } catch (e) { console.error('Stock list failed:', e); }
}

async function loadCachedData() {
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
    if (Object.keys(SCREENER_CANDLES).length) {
      loadLTP();
      startLTPRefresh();
    }
  } catch (e) { console.error(e); }
}

/* ============================================================
   SECTION 4 — MANUAL FETCH (button → client batches)
   ============================================================ */
async function startFetch() {
  if (FETCHING) return;
  if (!SCREENER_STOCKS.length) { showToast('⚠️ No stocks loaded', ''); return; }

  FETCHING = true;
  const btn = document.getElementById('fetch915Btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';

  const bar = document.getElementById('progressBar');
  bar.style.display = 'block';

  const tokens = SCREENER_STOCKS.map(s => s.token);
  const total = tokens.length;
  let ok = 0, failed = 0;

  // Only fetch tokens we don't have yet
  const missing = tokens.filter(t => !SCREENER_CANDLES[t]);

  // If all cached → just fetch LTP
  if (!missing.length) {
    setPill('✅ Already cached', 'var(--success)');
    updateProgress(total, total);
    FETCHING = false;
    btn.disabled = false;
    btn.textContent = '⚡ Refresh LTP';
    await loadLTP();
    startLTPRefresh();
    return;
  }

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    setPill(`⏳ Fetching ${i + batch.length} / ${missing.length}...`, '#f39c12');

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
            SCREENER_CANDLES[item.token] = {
              open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
            };
            ok++;
          } else failed++;
        }
      }
      renderScreenerTable();
      updateProgress(total - missing.length + i + batch.length, total);
    } catch (e) { failed += batch.length; }

    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  setPill(`✅ Done — ok:${ok} failed:${failed}`, failed ? '#f39c12' : 'var(--success)');
  FETCHING = false;
  btn.disabled = false;
  btn.textContent = '⚡ Fetch 9:15 Candles';

  // Start LTP after candles done
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
   SECTION 5 — LTP (batch, 15s refresh)
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
   SECTION 6 — RENDER TABLE
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

  let loaded = 0, pending = 0;

  body.innerHTML = SCREENER_STOCKS.map(s => {
    const c = SCREENER_CANDLES[s.token];
    const ltp = SCREENER_LTP[s.token];

    if (!c) {
      pending++;
      return `<tr>
        <td><strong>${s.sym}</strong><br><span style="font-size:11px;color:var(--text-muted)">Token: ${s.token}</span></td>
        <td colspan="7" style="color:var(--text-muted);font-size:12px">— pending —</td>
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

  if (count) {
    const total = SCREENER_STOCKS.length;
    count.textContent = pending > 0
      ? `⏳ ${loaded} loaded · ${pending} pending · ${total} total`
      : `✅ ${loaded} / ${total} loaded`;
  }
}

/* ============================================================
   SECTION 7 — HELPERS
   ============================================================ */
function setPill(text, color) {
  const pill = document.getElementById('screenerStatusPill');
  if (!pill) return;
  pill.textContent = text;
  pill.style.color = color || 'var(--text-muted)';
}

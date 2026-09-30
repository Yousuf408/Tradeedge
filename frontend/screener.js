/* ============================================================
   SCREENER.JS
   Auto-loads 9:15 candles on page visit
   Polls progress while background fetch runs
   ============================================================ */

let SCREENER_STOCKS = [];
let SCREENER_CANDLES = {};
let SCREENER_INIT_DONE = false;
let SCREENER_POLL_TIMER = null;

/* ============================================================
   SECTION 1 — INIT (called by navigateTo)
   ============================================================ */
async function initScreener() {
  if (SCREENER_INIT_DONE) {
    // Already loaded — just re-render current state
    renderScreenerTable();
    return;
  }

  const controls = document.querySelector('.screener-controls');
  if (controls) {
    // Hide old strategy dropdown, run button, auto-buy toggle, labels
    ['#strategySelect', '.toggle-wrapper'].forEach(sel => {
      const el = controls.querySelector(sel);
      if (el) el.style.display = 'none';
    });
    controls.querySelectorAll('button, label').forEach(el => el.style.display = 'none');

    // Add status pill
    let pill = document.getElementById('screenerStatusPill');
    if (!pill) {
      pill = document.createElement('span');
      pill.id = 'screenerStatusPill';
      pill.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-muted);padding:6px 14px;background:rgba(108,92,231,0.06);border-radius:20px';
      pill.textContent = 'Loading...';
      controls.appendChild(pill);
    }
  }

  await loadStockList();
  await ensureDataLoaded();
  await fetchAndRender(); 

  SCREENER_INIT_DONE = true;
}

/* ============================================================
   SECTION 2 — LOAD STOCK LIST
   ============================================================ */
async function loadStockList() {
  try {
    const r = await fetch(API + '/api/stocks', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    if (r.ok) SCREENER_STOCKS = await r.json();
  } catch (e) {
    console.error('Failed to load stock list:', e);
  }
}

/* ============================================================
   SECTION 3 — ENSURE DATA LOADED (auto-fetch trigger)
   ============================================================ */
async function ensureDataLoaded() {
  try {
    const r = await fetch(API + '/api/screener/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (d.status === 'ready') {
      setPill('✅ Live — ' + d.date, 'var(--success)');
      await fetchAndRender();
      return;
    }

    if (d.status === 'fetching') {
      setPill(`⏳ Fetching 0 / ${d.total}...`, '#f39c12');
      startProgressPolling();
      return;
    }
  } catch (e) {
    setPill('⚠️ Error — ' + e.message, 'var(--danger)');
  }
}

/* ============================================================
   SECTION 4 — PROGRESS POLLING
   ============================================================ */
function startProgressPolling() {
  if (SCREENER_POLL_TIMER) clearInterval(SCREENER_POLL_TIMER);
  SCREENER_POLL_TIMER = setInterval(async () => {
    try {
      const r = await fetch(API + '/api/screener/status', {
        headers: { Authorization: 'Bearer ' + getToken() }
      });
      const d = await r.json();

      if (d.status === 'fetching') {
        setPill(`⏳ Fetching ${d.progress} / ${d.total}...`, '#f39c12');
        await fetchAndRender();
      } else if (d.status === 'ready') {
        clearInterval(SCREENER_POLL_TIMER);
        SCREENER_POLL_TIMER = null;
        setPill('✅ Live — ' + d.date, 'var(--success)');
        await fetchAndRender();
      } else if (d.status === 'error') {
        clearInterval(SCREENER_POLL_TIMER);
        SCREENER_POLL_TIMER = null;
        setPill('❌ Error — ' + (d.error || 'unknown'), 'var(--danger)');
      }
    } catch (e) {
      console.error('Poll error:', e);
    }
  }, 3000);
}

/* ============================================================
   SECTION 5 — FETCH ALL CANDLES + RENDER
   ============================================================ */
async function fetchAndRender() {
  try {
    const r = await fetch(API + '/api/screener/data', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    SCREENer_CANDLES = {};   // reset
    SCREENER_CANDLES = {};
    if (d.results) {
      for (const item of d.results) {
        const c = item.candle;
        if (Array.isArray(c) && c.length >= 5) {
          SCREENER_CANDLES[item.token] = {
            open: c[1], high: c[2], low: c[3], close: c[4],
            volume: c[5] || 0
          };
        }
      }
    }
    renderScreenerTable();
  } catch (e) {
    console.error('Fetch data failed:', e);
  }
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
    <th>9:15 Open</th>
    <th>9:15 High</th>
    <th>9:15 Low</th>
    <th>9:15 Close</th>
    <th>Range %</th>
    <th>Volume</th>
  </tr>`;

  const loaded = Object.keys(SCREENER_CANDLES).length;

  body.innerHTML = SCREENER_STOCKS.map(s => {
    const c = SCREENER_CANDLES[s.token];
    if (!c) {
      return `<tr>
        <td><strong>${s.sym}</strong><br><span style="font-size:11px;color:var(--text-muted)">Token: ${s.token}</span></td>
        <td colspan="6" style="color:var(--text-muted);font-size:12px">— waiting —</td>
      </tr>`;
    }
    const rangePct = (((c.high - c.low) / c.low) * 100).toFixed(2);
    return `<tr>
      <td><strong>${s.sym}</strong><br><span style="font-size:11px;color:var(--text-muted)">Token: ${s.token}</span></td>
      <td>₹${c.open.toFixed(2)}</td>
      <td style="color:var(--success);font-weight:600">₹${c.high.toFixed(2)}</td>
      <td style="color:var(--danger);font-weight:600">₹${c.low.toFixed(2)}</td>
      <td>₹${c.close.toFixed(2)}</td>
      <td>${rangePct}%</td>
      <td>${c.volume ? c.volume.toLocaleString() : '—'}</td>
    </tr>`;
  }).join('');

  if (count) count.textContent = `${loaded} / ${SCREENER_STOCKS.length} loaded`;
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

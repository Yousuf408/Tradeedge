/* ============================================================
   SCREENER.JS
   Live 9:15 candle fetcher for Nifty 500 via Angel One
   Self-contained — injects its own UI into the Screener page
   ============================================================ */

let SCREENER_TOKENS = [];        // [{sym, token}, ...]
let SCREENER_915 = {};           // { token: {open, high, low, close} }
let SCREENER_LOCKED = false;     // prevent double-click during fetch

/* ============================================================
   SECTION 1 — INITIAL SETUP (called from app.js or on load)
   ============================================================ */
async function initScreener() {
  // Add the fetch button into the existing screener panel
  const controls = document.querySelector('.screener-controls');
  if (!controls || document.getElementById('fetch915Btn')) return;

  // Hide the old strategy dropdown + old run button (we replaced the flow)
  const oldSelect = document.getElementById('strategySelect');
  const oldRunBtn = controls.querySelector('button.btn-primary');
  if (oldSelect) oldSelect.style.display = 'none';
  if (oldRunBtn) oldRunBtn.style.display = 'none';

  // Insert the new fetch button
  const btn = document.createElement('button');
  btn.id = 'fetch915Btn';
  btn.className = 'btn btn-primary';
  btn.textContent = '⚡ Fetch 9:15 Candles';
  btn.onclick = onFetch915Click;
  controls.insertBefore(btn, controls.firstChild);

  // Load stock list from backend
  try {
    const r = await fetch(API + '/api/stocks', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    if (r.ok) SCREENER_TOKENS = await r.json();
    console.log('Screener: loaded', SCREENER_TOKENS.length, 'stocks');
  } catch (e) {
    console.error('Screener: failed to load stock list', e);
  }

  // Clear the old strategy table
  const body = document.getElementById('screenerBody');
  if (body) body.innerHTML = `<tr><td colspan="15" style="text-align:center;padding:40px;color:var(--text-muted)">
    Click <strong>⚡ Fetch 9:15 Candles</strong> to load live data.
  </td></tr>`;
  const head = document.getElementById('screenerHead');
  if (head) head.innerHTML = '';
  const count = document.getElementById('screenerCount');
  if (count) count.textContent = `${SCREENER_TOKENS.length} stocks ready`;
}

/* ============================================================
   SECTION 2 — BUTTON HANDLER
   ============================================================ */
async function onFetch915Click() {
  if (SCREENER_LOCKED) return;
  if (!SCREENER_TOKENS.length) { showToast('⚠️ No Data', 'Stock list not loaded'); return; }

  // Check if broker session exists by trying a small test
  try {
    const probe = await fetch(API + '/api/screener/fetch-915', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ tokens: [SCREENER_TOKENS[0].token] })
    });
    const d = await probe.json();
    if (probe.status === 401 || (d.error && d.error.includes('Connect broker'))) {
      openBrokerLoginModal();
      return;
    }
  } catch {}

  await fetchAllCandles();
}

/* ============================================================
   SECTION 3 — ANGEL ONE LOGIN MODAL
   ============================================================ */
function openBrokerLoginModal() {
  let modal = document.getElementById('angelLoginModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'angelLoginModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box">
        <h3>🔌 Connect Angel One</h3>
        <div class="modal-sub">Enter your Angel One credentials to fetch live data</div>
        <div class="auth-field">
          <label>Client ID</label>
          <input id="angelClientId" type="text" placeholder="e.g. A12345" />
        </div>
        <div class="auth-field">
          <label>MPIN (4-digit)</label>
          <input id="angelMpin" type="password" placeholder="••••" maxlength="4" />
        </div>
        <div class="auth-field">
          <label>TOTP (6-digit from Google Authenticator)</label>
          <input id="angelTotp" type="text" inputmode="numeric" maxlength="6" placeholder="000000"
                 style="letter-spacing:6px;text-align:center;font-size:18px" />
        </div>
        <div class="modal-error" id="angelLoginError"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="closeAllModals()">Cancel</button>
          <button class="btn btn-primary" id="angelLoginBtn" onclick="submitAngelLogin()">Connect</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('open');
  setTimeout(() => document.getElementById('angelClientId').focus(), 100);
}

async function submitAngelLogin() {
  const clientId = document.getElementById('angelClientId').value.trim();
  const mpin = document.getElementById('angelMpin').value.trim();
  const totp = document.getElementById('angelTotp').value.trim();
  const err = document.getElementById('angelLoginError');
  const btn = document.getElementById('angelLoginBtn');
  err.textContent = '';

  if (!clientId || !mpin || !totp) { err.textContent = 'All fields required'; return; }
  if (totp.length !== 6) { err.textContent = 'TOTP must be 6 digits'; return; }

  btn.textContent = 'Connecting...';
  btn.disabled = true;

  try {
    const r = await fetch(API + '/api/broker/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ clientId, mpin, totp })
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Login failed'; return; }

    closeAllModals();
    showToast('✅ Connected', 'Angel One session active');
    await fetchAllCandles();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.textContent = 'Connect';
    btn.disabled = false;
  }
}

/* ============================================================
   SECTION 4 — FETCH ALL CANDLES (with progress)
   ============================================================ */
async function fetchAllCandles() {
  if (SCREENER_LOCKED) return;
  SCREENER_LOCKED = true;

  const btn = document.getElementById('fetch915Btn');
  const orig = btn.textContent;
  btn.disabled = true;

  const BATCH = 20;      // process 20 stocks per batch
  const DELAY = 7000;    // wait 7 seconds between batches (rate limit safety)
  const total = SCREENER_TOKENS.length;

  SCREENER_915 = {};
  renderScreenerTable();

  for (let i = 0; i < total; i += BATCH) {
    const batch = SCREENER_TOKENS.slice(i, i + BATCH);
    btn.innerHTML = `<span class="spinner"></span> Fetching ${i + 1}–${Math.min(i + BATCH, total)} of ${total}...`;

    try {
      const r = await fetch(API + '/api/screener/fetch-915', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ tokens: batch.map(s => s.token) })
      });
      const d = await r.json();
      if (d.results) {
        for (const item of d.results) {
          if (item.candle) {
            const [ts, o, h, l, c, v] = item.candle;
            SCREENER_915[item.token] = { open: o, high: h, low: l, close: c, volume: v };
          }
        }
        renderScreenerTable();
      }
    } catch (e) {
      console.error('Batch failed', e);
    }

    if (i + BATCH < total) await new Promise(r => setTimeout(r, DELAY));
  }

  btn.textContent = orig;
  btn.disabled = false;
  SCREENER_LOCKED = false;
  showToast('✅ Done', `Fetched ${Object.keys(SCREENER_915).length} of ${total}`);
}

/* ============================================================
   SECTION 5 — RENDER TABLE
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

  const rows = SCREENER_TOKENS.map(s => {
    const c = SCREENER_915[s.token];
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

  body.innerHTML = rows;
  if (count) count.textContent = `${Object.keys(SCREENER_915).length} / ${SCREENER_TOKENS.length} loaded`;
}

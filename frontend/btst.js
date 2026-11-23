/* ============================================================
   BTST Frontend Logic (btst.js) - Auto Live Feed + Auto Trade
   ============================================================ */

const API = ''; 

// --- BULLETPROOF TOKEN FETCHER FOR IFRAME ---
const getToken = () => {
  // 1. Try getting the function directly from the main window (Parent)
  try {
    if (window.parent && typeof window.parent.getToken === 'function') {
      const pToken = window.parent.getToken();
      if (pToken) return pToken;
    }
  } catch (e) {
    // Ignore cross-origin errors if any
  }
  
  // 2. Fallback to LocalStorage (trying all common keys)
  const keys = ['ta_token', 'token', 'jwt', 'auth_token', 'access_token'];
  for (let k of keys) {
    const val = localStorage.getItem(k);
    if (val) return val;
  }
  return '';
};

const getUserId = () => localStorage.getItem('ta_user') || localStorage.getItem('username') || 'admin';

const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (v, d = 2) => v === null || v === undefined ? '—' : Number(v).toFixed(d);
const pctClass = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

const formatDateOnly = (dateStr) => {
  if (!dateStr) return '—';
  return String(dateStr).split('T')[0]; 
};

const formatDateTimeNoSec = (ts) => {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().replace('T', ' ').slice(0, 16);
  } catch { return '—'; }
};

let scanData = [];
let liveSSE = null;
let latestTicks = {}; 
let motherHighMap = {}; 

$('scanDate').value = today();

// ─── 1. LIVE SSE CONNECTION ───────────────────────────────
function startSSE() {
  if (liveSSE) return;
  const token = getToken();
  
  if (!token) {
    $('liveStatus').textContent = '🔴 Auth token missing (Check login)';
    $('liveStatus').style.color = 'var(--danger)';
    return;
  }

  const url = `${API}/api/screener/stream?token=${encodeURIComponent(token)}`;
  liveSSE = new EventSource(url);
  
  liveSSE.onopen = () => {
    $('liveStatus').textContent = '🟢 Live Feed Connected';
    $('liveStatus').style.color = 'var(--success)';
  };

  liveSSE.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ltp' && msg.ticks) {
        Object.assign(latestTicks, msg.ticks);
        updateLiveUI(msg.ticks);
      }
    } catch (err) {}
  };

  liveSSE.onerror = () => {
    $('liveStatus').textContent = '🔴 Reconnecting...';
    $('liveStatus').style.color = 'var(--warning)';
  };
}

// ─── 2. UPDATE DOM IN REAL-TIME ───────────────────────────
function updateLiveUI(ticks) {
  let anyBreakout = false;
  
  for (const [token, price] of Object.entries(ticks)) {
    const data = motherHighMap[token];
    if (!data || !data.trEl) continue;

    if (data.ltpEl) {
      data.ltpEl.textContent = '₹' + (+price).toFixed(2);
    }

    if (price > data.mother_high && !data.trEl.classList.contains('live-broken')) {
      data.trEl.classList.add('live-broken');
      anyBreakout = true;
      data.badgeEl.innerHTML = `<span class="badge b-yes" style="background: var(--warning); color: #000; animation: pulse 1.5s infinite;">🚀 BREAKOUT!</span>`;
      data.trEl.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
    }
  }

  if (anyBreakout) document.title = `🚀 BREAKOUT DETECTED!`;
}

// ─── 3. RUN SCAN ──────────────────────────────────────────
async function runScan() {
  const date = $('scanDate').value;
  $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 20px; color: var(--text-muted);">Scanning ${date}... (this may take a few seconds)</td></tr>`;
  
  try {
    const res = await fetch(`${API}/api/btst/scan?date=${date}`, {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const json = await res.json();
    
    if (!json.success) throw new Error(json.error);
    
    scanData = json.data;
    motherHighMap = {}; 
    
    render(json);
    
  } catch (e) {
    $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 20px; color: var(--danger);">Error: ${e.message}</td></tr>`;
  }
}

// ─── 4. RENDER UI ─────────────────────────────────────────
function render({ data, isLive, scanMs }) {
  const total = data.length;
  const broke = data.filter(d => d.breakout_ts).length;
  const confirmed = data.filter(d => d.is_breakout === 'Yes').length;
  
  let sumChg = 0, validChg = 0;
  data.forEach(d => {
    if (d.change_pct !== null) { sumChg += Number(d.change_pct); validChg++; }
  });
  const avgChg = validChg ? (sumChg / validChg) : 0;

  $('summary').innerHTML = `
    <div class="card"><div class="card-label">Setups Found</div><div class="card-val">${total}</div></div>
    <div class="card"><div class="card-label">Intraday Breakouts</div><div class="card-val" style="color: var(--warning)">${broke}</div></div>
    <div class="card"><div class="card-label">Confirmed (Close)</div><div class="card-val" style="color: var(--success)">${confirmed}</div></div>
    <div class="card"><div class="card-label">Avg Change %</div><div class="card-val ${pctClass(avgChg)}">${validChg ? avgChg.toFixed(2) : '0.00'}%</div></div>
    <div class="card"><div class="card-label">Scan Time</div><div class="card-val" style="font-size: 14px; margin-top: 6px;">${scanMs}ms</div></div>
  `;

  if (!data.length) {
    $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 40px; color: var(--text-muted);">No Inside Bar setups found for this date.</td></tr>`;
    return;
  }

  $('tbody').innerHTML = data.map((d, i) => {
    let badge = `<span class="badge b-no">❌ No</span>`;
    if (d.is_breakout === 'Yes') {
      badge = `<span class="badge b-yes">✅ Yes (Confirmed)</span>`;
    } else if (d.breakout_ts) {
      badge = `<span class="badge b-warn">⚠️ False Break</span>`;
    } else if (isLive) {
      badge = `<span class="badge b-wait">⏳ Waiting</span>`;
    }

    const currentLtp = latestTicks[d.token] ? '₹' + (+latestTicks[d.token]).toFixed(2) : '—';

    motherHighMap[d.token] = { mother_high: Number(d.mother_high), trEl: null, badgeEl: null, ltpEl: null };

    return `<tr data-token="${d.token}">
      <td>${i + 1}</td>
      <td><span class="sym">${d.sym}</span></td>
      <td class="ltp-cell" style="font-weight:700;">${currentLtp}</td>
      <td>${formatDateOnly(d.mother_date)}</td>
      <td class="${pctClass(d.change_pct)}">${d.change_pct != null ? d.change_pct + '%' : '—'}</td>
      <td class="${pctClass(d.t1_pct)}">${d.t1_pct != null ? d.t1_pct + '%' : '—'}</td>
      <td>${d.breakout_rvol != null ? fmt(d.breakout_rvol, 2) + 'x' : '—'}</td>
      <td>${formatDateTimeNoSec(d.breakout_ts)}</td>
      <td class="action-cell">${badge}</td>
      <td>₹${fmt(d.mother_high)}</td>
      <td>${d.days_inside}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#tbody tr').forEach(tr => {
    const token = tr.dataset.token;
    if (motherHighMap[token]) {
      motherHighMap[token].trEl = tr;
      motherHighMap[token].badgeEl = tr.querySelector('.action-cell');
      motherHighMap[token].ltpEl = tr.querySelector('.ltp-cell');
    }
  });
}

// ─── 5. AUTO-TRADE CONTROLS ───────────────────────────────
$('startAutoBtn').addEventListener('click', async () => {
  if (!scanData || scanData.length === 0) {
    alert('Please scan a date first to load the watchlist.');
    return;
  }

  const mode = $('tradeMode').value;
  const product = $('productType').value;
  const qty = parseInt($('tradeQty').value) || 1;

  if (mode === 'REAL') {
    const confirmReal = confirm(`⚠️ WARNING: You are about to place REAL money orders via Kotak Neo.\n\nQty: ${qty}\nProduct: ${product}\n\nAre you sure?`);
    if (!confirmReal) return;
  }

  const stocksToTrade = scanData.filter(d => d.is_breakout !== 'Yes').map(d => ({
    sym: d.sym,
    token: d.token,
    mother_high: d.mother_high
  }));

  if (stocksToTrade.length === 0) {
    alert('All stocks in this scan have already broken out. Scan a new date/watchlist.');
    return;
  }

  try {
    const res = await fetch(`${API}/api/btst/start`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getToken()
      },
      body: JSON.stringify({
        userId: getUserId(),
        stocks: stocksToTrade,
        config: { tradeMode: mode, productType: product, qty: qty }
      })
    });
    
    const json = await res.json();
    if (json.success) {
      $('startAutoBtn').style.display = 'none';
      $('stopAutoBtn').style.display = 'inline-flex';
      $('liveStatus').innerHTML = `<span style="color: var(--warning); font-weight: 700;">🚀 Auto-Trading ACTIVE (${mode} - ${product})</span>`;
    } else {
      alert('Error: ' + json.error);
    }
  } catch (err) {
    alert('Failed to start Auto-Trade: ' + err.message);
  }
});

$('stopAutoBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${API}/api/btst/stop`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getToken()
      },
      body: JSON.stringify({ userId: getUserId() })
    });
    
    if (res.ok) {
      $('startAutoBtn').style.display = 'inline-flex';
      $('stopAutoBtn').style.display = 'none';
      $('liveStatus').innerHTML = `<span style="color: var(--success);">🟢 Live Feed Connected (Auto-Trade Stopped)</span>`;
    }
  } catch (err) {
    alert('Failed to stop Auto-Trade: ' + err.message);
  }
});

// ─── 6. INIT ──────────────────────────────────────────────
$('scanBtn').addEventListener('click', runScan);

window.addEventListener('load', () => {
  startSSE(); 
  runScan();  
});

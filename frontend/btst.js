/* ============================================================
   BTST Frontend Logic (btst.js) - Auto-Scan, Live Feed & UI Filter
   ============================================================ */

const API = ''; 

// Bulletproof token fetcher for iframe context
const getToken = () => {
  try {
    if (window.parent && typeof window.parent.getToken === 'function') {
      const pToken = window.parent.getToken();
      if (pToken && pToken !== 'undefined') return pToken;
    }
  } catch (e) {}
  
  const keys = ['ta_token', 'token', 'jwt', 'auth_token', 'access_token', 'ta_auth', 'ta_auth_token'];
  for (let k of keys) {
    const val = localStorage.getItem(k);
    if (val && val.length > 20 && val !== 'undefined' && val !== 'null') return val;
  }
  return '';
};

const getUserId = () => localStorage.getItem('ta_user') || localStorage.getItem('username') || 'admin';
const $ = id => document.getElementById(id);
const fmt = (v, d = 2) => v === null || v === undefined ? '—' : Number(v).toFixed(d);
const pctClass = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

// Helper: Get Last Working Day (Yesterday)
function getLastWorkingDay() {
  let d = new Date();
  d.setDate(d.getDate() - 1); // Start with yesterday
  while (d.getDay() === 0 || d.getDay() === 6) { // Skip Sat/Sun
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

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

// Set default date on load
$('scanDate').value = getLastWorkingDay();

// ─── 1. LIVE SSE CONNECTION ───────────────────────────────
function startSSE() {
  if (liveSSE) return;
  const token = getToken();
  if (!token) {
    $('liveStatus').textContent = '🔴 Auth token missing';
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

// ─── 2. UPDATE DOM (LTP + Dynamic Change %) ───────────────
function updateLiveUI(ticks) {
  for (const [token, price] of Object.entries(ticks)) {
    const data = motherHighMap[token];
    if (!data || !data.trEl) continue;

    // Update LTP
    if (data.ltpEl) {
      data.ltpEl.textContent = '₹' + (+price).toFixed(2);
    }

    // Update Change % dynamically based on LTP vs Mother High
    if (data.changePctEl && data.mother_high) {
      const pct = ((price - data.mother_high) / data.mother_high) * 100;
      data.changePctEl.className = `change-pct-cell ${pctClass(pct)}`;
      data.changePctEl.textContent = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
    }

    // Update Breakout Badge (if not already flagged)
    if (price > data.mother_high && !data.trEl.classList.contains('live-broken')) {
      data.trEl.classList.add('live-broken');
      data.badgeEl.innerHTML = `<span class="badge b-wait" style="animation: pulse 1.5s infinite;">⏳ Touched (Wait 5m)</span>`;
      data.trEl.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
    }
  }
}

// ─── 3. RUN SCAN ──────────────────────────────────────────
async function runScan() {
  const date = $('scanDate').value;
  $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 20px; color: var(--text-muted);">Scanning ${date}... (this may take a few seconds)</td></tr>`;
  
  // Stop live monitor if running
  if ($('stopAutoBtn').style.display === 'inline-flex') {
      $('stopAutoBtn').click();
  }

  try {
    const res = await fetch(`${API}/api/btst/scan?date=${date}`, {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const json = await res.json();
    
    if (!json.success) throw new Error(json.error);
    
    // Keep ALL data for the Auto-Trader (including ❌ No)
    scanData = json.data; 
    motherHighMap = {}; 
    
    // Fetch initial LTPs to populate the table immediately
    if (scanData.length > 0) {
      const tokens = scanData.map(d => d.token);
      try {
        const ltpRes = await fetch(`${API}/api/screener/ltp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
          body: JSON.stringify({ tokens })
        });
        const ltpJson = await ltpRes.json();
        if (ltpJson.results) {
          ltpJson.results.forEach(r => {
            if (r.ltp) latestTicks[r.token] = r.ltp;
          });
        }
      } catch (err) {}
    }

    // FILTER DATA FOR UI (Only show Yes or False Break)
    const uiData = scanData.filter(d => d.is_breakout === 'Yes' || d.breakout_ts != null);
    
    // RENDER UI WITH FILTERED DATA
    render({ 
      data: uiData, 
      totalScanned: scanData.length, 
      isLive: json.isLive, 
      scanMs: json.scanMs 
    });

    // Auto-Start Paper Trade if there are setups (Uses the full scanData)
    if (scanData.length > 0 && $('tradeMode').value === 'PAPER') {
      const stocksToTrade = scanData.filter(d => d.is_breakout !== 'Yes').map(d => ({
        sym: d.sym, token: d.token, mother_high: d.mother_high
      }));
      
      if (stocksToTrade.length > 0 && $('startAutoBtn').style.display !== 'none') {
        $('startAutoBtn').click();
      }
    }
    
  } catch (e) {
    $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 20px; color: var(--danger);">Error: ${e.message}</td></tr>`;
  }
}

// ─── 4. RENDER UI ─────────────────────────────────────────
function render({ data, totalScanned, isLive, scanMs }) {
  const broke = data.filter(d => d.breakout_ts).length;
  const confirmed = data.filter(d => d.is_breakout === 'Yes').length;
  
  let sumChg = 0, validChg = 0;
  data.forEach(d => {
    if (d.change_pct !== null) { sumChg += Number(d.change_pct); validChg++; }
  });
  const avgChg = validChg ? (sumChg / validChg) : 0;

  // UPDATE SUMMARY: Show Total Scanned (background) + UI Filtered counts
  $('summary').innerHTML = `
    <div class="card"><div class="card-label">Total Setups</div><div class="card-val">${totalScanned || data.length}</div></div>
    <div class="card"><div class="card-label">Intraday Breakouts</div><div class="card-val" style="color: var(--warning)">${broke}</div></div>
    <div class="card"><div class="card-label">Confirmed (Close)</div><div class="card-val" style="color: var(--success)">${confirmed}</div></div>
    <div class="card"><div class="card-label">Avg Change %</div><div class="card-val ${pctClass(avgChg)}">${validChg ? avgChg.toFixed(2) : '0.00'}%</div></div>
    <div class="card"><div class="card-label">Scan Time</div><div class="card-val" style="font-size: 14px; margin-top: 6px;">${scanMs}ms</div></div>
  `;

  if (!data.length) {
    $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 40px; color: var(--text-muted);">No breakouts found for this date.</td></tr>`;
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
    
    // Calculate dynamic change % for initial render
    let currentPct = d.change_pct;
    if (latestTicks[d.token] && d.mother_high) {
       currentPct = ((latestTicks[d.token] - d.mother_high) / d.mother_high) * 100;
    }

    motherHighMap[d.token] = { mother_high: Number(d.mother_high), trEl: null, badgeEl: null, ltpEl: null, changePctEl: null };

    return `<tr data-token="${d.token}">
      <td>${i + 1}</td>
      <td><span class="sym">${d.sym}</span></td>
      <td class="ltp-cell" style="font-weight:700;">${currentLtp}</td>
      <td>${formatDateOnly(d.mother_date)}</td>
      <td class="change-pct-cell ${pctClass(currentPct)}">${currentPct != null ? currentPct.toFixed(2) + '%' : '—'}</td>
      <td class="${pctClass(d.t1_pct)}">${d.t1_pct != null ? d.t1_pct + '%' : '—'}</td>
      <td>${d.breakout_rvol != null ? fmt(d.breakout_rvol, 2) + 'x' : '—'}</td>
      <td>${formatDateTimeNoSec(d.breakout_ts)}</td>
      <td class="action-cell">${badge}</td>
      <td>₹${fmt(d.mother_high)}</td>
      <td>${d.days_inside}</td>
    </tr>`;
  }).join('');

  // Cache elements for real-time SSE updates
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const token = tr.dataset.token;
    if (motherHighMap[token]) {
      motherHighMap[token].trEl = tr;
      motherHighMap[token].badgeEl = tr.querySelector('.action-cell');
      motherHighMap[token].ltpEl = tr.querySelector('.ltp-cell');
      motherHighMap[token].changePctEl = tr.querySelector('.change-pct-cell');
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

  // Uses the FULL scanData (including ❌ No) so it can monitor them
  const stocksToTrade = scanData.filter(d => d.is_breakout !== 'Yes').map(d => ({
    sym: d.sym,
    token: d.token,
    mother_high: d.mother_high
  }));

  if (stocksToTrade.length === 0) {
    if (mode === 'REAL') alert('All stocks in this scan have already broken out.');
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

// ─── 6. INIT & EVENTS ─────────────────────────────────────
$('scanDate').addEventListener('change', runScan); // Auto scan when date changes

window.addEventListener('load', () => {
  startSSE(); 
  runScan();  // Auto scan immediately on page load
});

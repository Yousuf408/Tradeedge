/* ============================================================
   BTST Frontend Logic (btst.js)
   ============================================================ */

const API = ''; // Assuming same origin
const getToken = () => localStorage.getItem('token') || '';

const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (v, d = 2) => v === null || v === undefined ? '—' : Number(v).toFixed(d);
const pctClass = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

let scanData = [];
let liveSSE = null;
let motherHighMap = {}; // token -> { mother_high, trEl }

$('scanDate').value = today();

// ─── 1. RUN SCAN ──────────────────────────────────────────
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
    motherHighMap = {}; // reset
    
    render(json);
    $('liveStatus').textContent = json.isLive ? 'Ready for Live Monitor' : `Backtest mode (${date})`;
    
  } catch (e) {
    $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 20px; color: var(--danger);">Error: ${e.message}</td></tr>`;
  }
}

// ─── 2. RENDER UI ─────────────────────────────────────────
function render({ data, date, isLive, scanMs }) {
  // Summary Cards
  const total = data.length;
  const broke = data.filter(d => d.breakout_time_ist).length;
  const confirmed = data.filter(d => d.is_breakout === 'Yes').length;
  
  let sumChg = 0, validChg = 0;
  data.forEach(d => {
    if (d.change_pct !== null) { sumChg += Number(d.change_pct); validChg++; }
  });
  const avgChg = validChg ? (sumChg / validChg) : 0;

  $('summary').innerHTML = `
    <div class="card">
      <div class="card-label">Setups Found</div>
      <div class="card-val">${total}</div>
    </div>
    <div class="card">
      <div class="card-label">Intraday Breakouts</div>
      <div class="card-val" style="color: var(--warning)">${broke}</div>
    </div>
    <div class="card">
      <div class="card-label">Confirmed (Close)</div>
      <div class="card-val" style="color: var(--success)">${confirmed}</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Change %</div>
      <div class="card-val ${pctClass(avgChg)}">${validChg ? avgChg.toFixed(2) : '0.00'}%</div>
    </div>
    <div class="card">
      <div class="card-label">Scan Time</div>
      <div class="card-val" style="font-size: 14px; margin-top: 6px;">${scanMs}ms</div>
    </div>
  `;

  // Table Rows
  if (!data.length) {
    $('tbody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding: 40px; color: var(--text-muted);">No Inside Bar setups found for this date.</td></tr>`;
    return;
  }

  $('tbody').innerHTML = data.map((d, i) => {
    let badge = `<span class="badge b-no">❌ No Breakout</span>`;
    if (d.is_breakout === 'Yes') {
      badge = `<span class="badge b-yes">✅ BUY (Confirmed)</span>`;
    } else if (d.breakout_time_ist) {
      badge = `<span class="badge b-warn">⚠️ False Break</span>`;
    } else if (isLive) {
      badge = `<span class="badge b-wait">⏳ Waiting</span>`;
    }

    // Store reference for live updating
    motherHighMap[d.token] = { 
      mother_high: d.mother_high, 
      trEl: null, 
      badgeEl: null 
    };

    return `<tr data-token="${d.token}">
      <td>${i + 1}</td>
      <td>
        <span class="sym">${d.sym}</span>
        <div style="font-size: 10px; color: var(--text-muted);">${d.token}</div>
      </td>
      <td><strong>₹${fmt(d.mother_high)}</strong></td>
      <td>₹${fmt(d.mother_low)}</td>
      <td>${fmt(d.inside_low)} – ${fmt(d.inside_high)}</td>
      <td>${d.days_inside}</td>
      <td class="${pctClass(d.change_pct)}">${d.change_pct != null ? d.change_pct + '%' : '—'}</td>
      <td class="${pctClass(d.t1_pct)}">${d.t1_pct != null ? d.t1_pct + '%' : '—'}</td>
      <td>${d.breakout_time_ist || '—'}</td>
      <td>${d.breakout_rvol != null ? fmt(d.breakout_rvol, 1) + 'x' : '—'}</td>
      <td class="action-cell">${badge}</td>
    </tr>`;
  }).join('');

  // Cache DOM elements for live updating
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const token = tr.dataset.token;
    if (motherHighMap[token]) {
      motherHighMap[token].trEl = tr;
      motherHighMap[token].badgeEl = tr.querySelector('.action-cell');
    }
  });
}

// ─── 3. LIVE MONITOR (SSE) ────────────────────────────────
function toggleLive() {
  const btn = $('liveBtn');
  
  if (liveSSE) {
    // STOP
    liveSSE.close();
    liveSSE = null;
    btn.textContent = '📡 Live Monitor: OFF';
    btn.classList.remove('active');
    $('liveStatus').textContent = 'Monitor stopped.';
    return;
  }

  if (!scanData.length) {
    alert('Please run a scan first to load the watchlist.');
    return;
  }

  // START
  btn.textContent = '⏹ Stop Live Monitor';
  btn.classList.add('active');
  $('liveStatus').textContent = 'Connecting to live feed...';
  
  const token = getToken();
  const url = `${API}/api/screener/stream?token=${encodeURIComponent(token)}`;
  
  liveSSE = new EventSource(url);
  
  liveSSE.onopen = () => {
    $('liveStatus').textContent = '🟢 Live monitoring active. Waiting for breakout...';
  };

  liveSSE.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ltp' && msg.ticks) {
        checkLiveBreakouts(msg.ticks);
      }
    } catch (err) {}
  };

  liveSSE.onerror = () => {
    $('liveStatus').textContent = '🔴 SSE Connection lost. Reconnecting...';
  };
}

function checkLiveBreakouts(ticks) {
  let anyBreakout = false;
  
  for (const [token, price] of Object.entries(ticks)) {
    const data = motherHighMap[token];
    if (!data || !data.trEl) continue;

    // Only trigger if we haven't already marked it as broken live
    if (price > data.mother_high && !data.trEl.classList.contains('live-broken')) {
      data.trEl.classList.add('live-broken');
      anyBreakout = true;

      // Update badge
      data.badgeEl.innerHTML = `<span class="badge b-yes" style="background: var(--warning); color: #000; animation: pulse 1.5s infinite;">🚀 BREAKOUT!</span>`;
      
      // Update row highlight
      data.trEl.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
      
      // Flash title
      document.title = `🚀 BREAKOUT: ${data.trEl.querySelector('.sym').textContent}`;
    }
  }

  if (anyBreakout) {
    $('liveStatus').innerHTML = `<span style="color: var(--warning); font-weight: 700;">🚀 Breakout detected! Check highlighted rows.</span>`;
  }
}

// ─── 4. EVENTS ────────────────────────────────────────────
$('scanBtn').addEventListener('click', () => {
  if (liveSSE) toggleLive(); // stop live if running
  runScan();
});

$('liveBtn').addEventListener('click', toggleLive);

// Auto-run on load
window.addEventListener('load', runScan);

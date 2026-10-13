/* ============================================================
   ORDERS.JS — v1.0
   AutoTrader positions page (Entry / SL / T1 / T2 / Net P&L)
   - 3s poll on /api/auto/positions jab page active ho
   - Self-hooked: nav click [data-page="orders"] pe load+poll
   - Koi app.js dependency nahi (page switch generic ho ya na ho)
   ============================================================ */

let ORDERS_DATA = { date: null, total: 0, positions: [] };
let ORDERS_TIMER = null;

async function loadOrders() {
  try {
    const r = await fetch(API + '/api/auto/positions', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();
    if (d && d.positions) {
      ORDERS_DATA = d;
      renderOrders();
    }
  } catch (e) { console.error('Orders load failed:', e); }
}

function ordersPageActive() {
  const el = document.getElementById('page-orders');
  return !!(el && el.classList.contains('active'));
}

function startOrdersPoll() {
  if (ORDERS_TIMER) return;
  ORDERS_TIMER = setInterval(() => {
    if (ordersPageActive()) loadOrders();
  }, 3000);
}

/* Nav click hook — app.js pe depend nahi karta */
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-page="orders"]');
  if (link) { loadOrders(); startOrdersPoll(); }
});

/* ---------- helpers ---------- */
function ordTime(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    const ist = new Date(dt.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(11, 19);
  } catch { return '—'; }
}

function ordINR(v) {
  if (v == null || v === undefined) return '—';
  return '₹' + (+v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ordStatus(p) {
  if (p.status === 'open') {
    if (p.stage >= 2) return '<span style="color:#6C5CE7;font-weight:800">🟢 OPEN · T2✓ trail</span>';
    if (p.stage === 1) return '<span style="color:#F5A623;font-weight:800">🟢 OPEN · T1✓</span>';
    return '<span style="color:var(--success);font-weight:800">🟢 OPEN</span>';
  }
  const rsn = p.exitReason || 'EXIT';
  const col = rsn === 'SL' ? 'var(--danger)'
            : (rsn === 'EOD_15:00' ? 'var(--text-secondary)' : '#6C5CE7');
  return `<span style="color:${col};font-weight:800">⏹ ${rsn}</span>`;
}

/* ---------- render ---------- */
function renderOrders() {
  const stats = document.getElementById('ordersStats');
  const wrap = document.getElementById('ordersTable');
  if (!wrap) return;

  const ps = ORDERS_DATA.positions || [];
  const open = ps.filter(p => p.status === 'open');
  const closed = ps.filter(p => p.status !== 'open');
  const wins = closed.filter(p => p.pnl > 0).length;
  const total = ORDERS_DATA.total ?? 0;
  const tCol = total > 0 ? 'var(--success)' : total < 0 ? 'var(--danger)' : 'var(--text-primary)';

  if (stats) {
    stats.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-soft);border-radius:12px;padding:14px 20px;min-width:150px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:1px">NET P&L</div>
        <div style="font-size:20px;font-weight:800;color:${tCol}">${total >= 0 ? '+' : ''}${ordINR(total)}</div>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border-soft);border-radius:12px;padding:14px 20px;min-width:90px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:1px">OPEN</div>
        <div style="font-size:20px;font-weight:800;color:var(--success)">${open.length}</div>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border-soft);border-radius:12px;padding:14px 20px;min-width:90px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:1px">CLOSED</div>
        <div style="font-size:20px;font-weight:800">${closed.length}</div>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border-soft);border-radius:12px;padding:14px 20px;min-width:90px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:1px">WINS</div>
        <div style="font-size:20px;font-weight:800;color:var(--success)">${wins}</div>
      </div>`;
  }

  const rows = ps.map(p => {
    const pnlCol = p.pnl > 0 ? 'var(--success)' : p.pnl < 0 ? 'var(--danger)' : 'var(--text-secondary)';
    const t1hit = (p.stage >= 1 || (p.exitPrice != null && p.exitPrice >= p.t1));
    const t2hit = (p.stage >= 2 || (p.exitPrice != null && p.exitPrice >= p.t2));
    return `<tr>
      <td style="font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted);white-space:nowrap">${ordTime(p.entryAt)}</td>
      <td><span class="sym">${p.sym}</span><span class="tok">${p.token}</span></td>
      <td style="white-space:nowrap">${ordStatus(p)}</td>
      <td style="font-weight:700">${p.qty}</td>
      <td style="font-weight:700;white-space:nowrap">${ordINR(p.entry)}</td>
      <td style="white-space:nowrap">${p.ltp ? ordINR(p.ltp) : '—'}</td>
      <td style="color:#F5A623;font-weight:700;white-space:nowrap">${ordINR(p.slLive ?? p.sl)}</td>
      <td style="white-space:nowrap;color:${t1hit ? 'var(--success)' : 'var(--text-muted)'}">${ordINR(p.t1)} ${t1hit ? '✓' : ''}</td>
      <td style="white-space:nowrap;color:${t2hit ? 'var(--success)' : 'var(--text-muted)'}">${ordINR(p.t2)} ${t2hit ? '✓' : ''}</td>
      <td style="color:${pnlCol};font-weight:800;white-space:nowrap">${p.pnl >= 0 ? '+' : ''}${ordINR(p.pnl)}<br>
          <span style="font-size:10px;font-weight:600">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%</span></td>
      <td style="font-size:11px;color:var(--text-muted);white-space:nowrap">${p.status === 'open' ? '—' : (p.exitReason || '') + ' @ ' + ordTime(p.exitAt)}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="table-modern">
    <thead><tr>
      <th>TIME</th><th>STOCK</th><th>STATUS</th><th>QTY</th><th>ENTRY</th><th>LTP</th>
      <th>SL (live)</th><th>T1 (+1.5%)</th><th>T2 (+2%)</th><th>NET P&L</th><th>EXIT</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="11" style="text-align:center;padding:50px;color:var(--text-muted)">
      No orders yet — chip list 9:15 pe lock hoti hai, RSI ≥70 wale stocks pe auto entry hoti hai
    </td></tr>`}</tbody>
  </table>`;
}

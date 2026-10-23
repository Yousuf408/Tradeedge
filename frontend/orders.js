/* ============================================================
   ORDERS.JS — v2.2 (Clean, Compact, Professional UI)
   ============================================================ */

let ORDERS_DATA = { date: null, total: 0, positions: [] };
let ORDERS_TIMER = null;

/* ============================================================
   SECTION 1 — LOAD + POLL
   ============================================================ */
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

/* ============================================================
   SECTION 2 — NAV CLICK HOOK
   ============================================================ */
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-page="orders"]');
  if (!link) return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = document.getElementById('page-orders');
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav-links a').forEach(a =>
    a.classList.toggle('active', a.getAttribute('data-page') === 'orders'));
  loadOrders();
  startOrdersPoll();
});

/* ============================================================
   SECTION 3 — HELPERS
   ============================================================ */
function ordTime(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    const ist = new Date(dt.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(11, 16); // HH:MM
  } catch { return '—'; }
}

function ordINR(v) {
  if (v == null || v === undefined) return '—';
  return '₹' + (+v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ordShortINR(v) {
  if (v == null || v === undefined) return '—';
  return '₹' + (+v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Clean State Column
function ordState(p) {
  if (p.status === 'open') {
    if (p.stage >= 3) return '<span style="color:#6C5CE7;font-weight:700">🟢 OPEN (T2 Trail)</span>';
    if (p.stage === 2) return '<span style="color:#6C5CE7;font-weight:700">🟢 OPEN (T1 Trail)</span>';
    if (p.stage === 1) return '<span style="color:#F5A623;font-weight:700">🟢 OPEN (BE)</span>';
    return '<span style="color:var(--success);font-weight:700">🟢 OPEN</span>';
  }
  
  const rsn = p.exitReason || 'EXIT';
  const col = rsn.includes('SL') ? 'var(--danger)' : 'var(--text-secondary)';
  return `<span style="color:${col};font-weight:700">🔴 EXIT: ${rsn}</span><br>
          <span style="font-size:10px;color:var(--text-muted)">${ordTime(p.exitAt)}</span>`;
}

/* ============================================================
   SECTION 4 — RENDER
   ============================================================ */
function renderOrders() {
  const stats = document.getElementById('ordersStats');
  const wrap = document.getElementById('ordersTable');
  if (!wrap) return;

  const ps = ORDERS_DATA.positions || [];
  const open = ps.filter(p => p.status === 'open');
  const closed = ps.filter(p => p.status !== 'open');
  const wins = closed.filter(p => p.pnl > 0).length;
  const losses = closed.filter(p => p.pnl <= 0).length;
  
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
  const deployedCapital = open.reduce((sum, p) => sum + (p.entry * p.qty), 0);
  
  const total = ORDERS_DATA.total ?? 0;
  const tCol = total > 0 ? 'var(--success)' : total < 0 ? 'var(--danger)' : 'var(--text-primary)';

  /* ---- Compact Stats Row ---- */
  if (stats) {
    const card = (label, value, color, subtext = '') => `
      <div style="background:var(--bg-secondary); border:1px solid var(--border-soft); border-radius:8px; padding:8px 12px; min-width:90px;">
        <div style="font-size:9px; font-weight:700; color:var(--text-muted); letter-spacing:0.5px;">${label}</div>
        <div style="font-size:16px; font-weight:800; color:${color || 'var(--text-primary)'}; margin-top:2px;">${value}</div>
        ${subtext ? `<div style="font-size:9px; color:var(--text-muted); margin-top:2px;">${subtext}</div>` : ''}
      </div>`;
      
    stats.innerHTML =
      card('NET P&L', `${total >= 0 ? '+' : ''}${ordShortINR(total)}`, tCol) +
      card('WIN RATE', `${winRate}%`, winRate >= 50 ? 'var(--success)' : '#F5A623', `${wins} W / ${losses} L`) +
      card('OPEN / CLOSED', `${open.length} / ${closed.length}`, 'var(--text-primary)') +
      card('DEPLOYED', `${ordShortINR(deployedCapital)}`, '#6C5CE7', 'Margin Used');
  }

  /* ---- Positions Table ---- */
  const rows = ps.map(p => {
    const pnlCol = p.pnl > 0 ? 'var(--success)' : p.pnl < 0 ? 'var(--danger)' : 'var(--text-secondary)';
    const t1hit = (p.stage >= 2 || (p.exitPrice != null && p.exitPrice >= p.t1));
    const t2hit = (p.stage >= 3 || (p.exitPrice != null && p.exitPrice >= p.t2));
    
    const isShort = p.side === 'SELL';
    const typeText = isShort ? 'SHORT' : 'LONG';
    const typeBg = isShort ? 'rgba(255,71,87,0.15)' : 'rgba(46,213,115,0.15)';
    const typeCol = isShort ? 'var(--danger)' : 'var(--success)';
    const capitalUsed = p.entry * p.qty;

    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05); font-size:12px;">
      <td style="padding:6px 8px; color:var(--text-muted); font-family:monospace;">${ordTime(p.entryAt)}</td>
      <td style="padding:6px 8px; font-weight:700; font-size:13px;">${p.sym}</td>
      <td style="padding:6px 8px;">
        <span style="background:${typeBg}; color:${typeCol}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:800;">
          ${typeText}
        </span>
      </td>
      <td style="padding:6px 8px; font-weight:600;">${p.qty}</td>
      <td style="padding:6px 8px; font-weight:700;">${ordINR(p.entry)}</td>
      <td style="padding:6px 8px;">${p.ltp ? ordINR(p.ltp) : '—'}</td>
      <td style="padding:6px 8px; color:#F5A623; font-weight:700;">${ordINR(p.slLive ?? p.sl)}</td>
      <td style="padding:6px 8px; color:${t1hit ? 'var(--success)' : 'var(--text-muted)'}">${ordINR(p.t1)} ${t1hit ? '✓' : ''}</td>
      <td style="padding:6px 8px; color:${t2hit ? 'var(--success)' : 'var(--text-muted)'}">${ordINR(p.t2)} ${t2hit ? '✓' : ''}</td>
      <td style="padding:6px 8px; color:var(--text-muted); font-size:11px;">${ordINR(capitalUsed)}</td>
      <td style="padding:6px 8px; color:${pnlCol}; font-weight:800;">
        ${p.pnl >= 0 ? '+' : ''}${ordINR(p.pnl)} <br>
        <span style="font-size:10px;">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%</span>
      </td>
      <td style="padding:6px 8px;">${ordState(p)}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="table-modern" style="width:100%; text-align:left; border-collapse:collapse;">
    <thead>
      <tr style="border-bottom:1px solid var(--border-soft); color:var(--text-muted); font-size:11px;">
        <th style="padding:8px 8px;">TIME</th>
        <th style="padding:8px 8px;">STOCK</th>
        <th style="padding:8px 8px;">TYPE</th>
        <th style="padding:8px 8px;">QTY</th>
        <th style="padding:8px 8px;">ENTRY</th>
        <th style="padding:8px 8px;">LTP</th>
        <th style="padding:8px 8px;">SL (live)</th>
        <th style="padding:8px 8px;">T1</th>
        <th style="padding:8px 8px;">T2</th>
        <th style="padding:8px 8px;">VALUE</th>
        <th style="padding:8px 8px;">NET P&L</th>
        <th style="padding:8px 8px;">STATE / EXIT</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="12" style="text-align:center;padding:40px;color:var(--text-muted);font-size:12px;">
      No positions found.
    </td></tr>`}
    </tbody>
  </table>`;
}

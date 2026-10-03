/* ============================================================
   APP.JS
   Portfolio + Settings + Theme toggle
   Loaded LAST — uses showToast from admin.js
   ============================================================ */


/* ============================================================
   SECTION 1 — THEME (light / dark)
   ============================================================ */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('ta_theme', theme);
  updateThemeIcon(theme);
}

function toggleTheme() {
  const current = localStorage.getItem('ta_theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  if (typeof showToast === 'function') {
    showToast(
      next === 'dark' ? '🌙 Dark Mode' : '☀️ Light Mode',
      `Theme switched to ${next}`
    );
  }
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('themeIcon');
  if (!icon) return;
  icon.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// Apply saved theme on load
(function initTheme() {
  const saved = localStorage.getItem('ta_theme') || 'light';
  applyTheme(saved);
})();


/* ============================================================
   SECTION 2 — PORTFOLIO
   ============================================================ */
function loadPortfolio() {
  const holdings = [
    { symbol: 'RELIANCE', qty: 10, avg: 2810, current: 2856 },
    { symbol: 'TCS',      qty: 5,  avg: 3890, current: 3920 },
    { symbol: 'INFY',     qty: 15, avg: 1520, current: 1545 },
    { symbol: 'HDFC',     qty: 8,  avg: 1700, current: 1680 }
  ];
  const totalValue = holdings.reduce((s, h) => s + h.current * h.qty, 0);
  const invested   = holdings.reduce((s, h) => s + h.avg * h.qty, 0);
  const totalPnl   = totalValue - invested;
  const pct        = Math.round(totalPnl / invested * 100);

  document.getElementById('portfolioStats').innerHTML = `
    <div class="stat-box"><div class="label">💰 Total Value</div><div class="value">₹${totalValue.toLocaleString()}</div><div class="sub ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '↑' : '↓'} ₹${Math.abs(totalPnl).toLocaleString()}</div></div>
    <div class="stat-box"><div class="label">📊 Invested</div><div class="value">₹${invested.toLocaleString()}</div><div class="sub" style="color:var(--text-muted)">${Math.round(invested / totalValue * 100)}% allocated</div></div>
    <div class="stat-box"><div class="label">💵 Available Cash</div><div class="value">₹${Math.round(totalValue * 0.32).toLocaleString()}</div><div class="sub" style="color:var(--text-muted)">32% free</div></div>
    <div class="stat-box"><div class="label">📈 Total P&L</div><div class="value" style="color:${totalPnl >= 0 ? 'var(--success)' : 'var(--danger)'}">${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toLocaleString()}</div><div class="sub ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%</div></div>`;

  document.getElementById('holdingsTable').innerHTML = `
    <table class="table-modern">
      <thead><tr><th>Symbol</th><th>Qty</th><th>Avg Price</th><th>Current</th><th>P&L</th><th>Action</th></tr></thead>
      <tbody>${holdings.map(h => {
        const pnl = (h.current - h.avg) * h.qty;
        return `<tr>
          <td><strong>${h.symbol}</strong></td>
          <td>${h.qty}</td>
          <td>₹${h.avg}</td>
          <td>₹${h.current}</td>
          <td style="color:${pnl >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600">${pnl >= 0 ? '+' : ''}₹${pnl}</td>
          <td><button class="btn btn-danger btn-sm" onclick="showToast('📤 Sold','${h.symbol} sold')">Sell</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}


/* ============================================================
   SECTION 3 — SETTINGS: BROKER FIELDS TOGGLE
   ============================================================ */
function toggleBrokerFields() {
  const b = document.getElementById('brokerSelect').value;
  document.getElementById('dhanFields').style.display = b === 'dhan' ? 'grid' : 'none';
  document.getElementById('otherBrokerFields').style.display = (b && b !== 'dhan') ? 'block' : 'none';
}


/* ============================================================
   SECTION 4 — INIT
   ============================================================ */
toggleBrokerFields();

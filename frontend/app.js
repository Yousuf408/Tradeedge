/* ============================================================
   APP.JS
   Contains: Trading platform pages — Screener, Portfolio, Settings
   Loaded AFTER admin.js (uses showToast, DOM, currentUser from admin.js)
   ============================================================ */


/* ============================================================
   SECTION 1 — APP STATE
   ============================================================ */
let autoBuyEnabled = false;


/* ============================================================
   SECTION 2 — HELPERS
   ============================================================ */
const chgSpan = c =>
  `<span style="color:${c.includes('+') ? GREEN : RED}">${c}</span>`;


/* ============================================================
   SECTION 3 — STRATEGY DATA
   All strategies rendered on Screener page.
   Format: { name, icon, entryRule, risk, columns[], rows[][] }
   ============================================================ */
const STRATEGIES = {
  advanceorb: {
    name: 'Advance ORB',
    icon: '📈',
    entryRule: 'Opening Range Breakout',
    risk: '2%',
    columns: [
      'Symbol','Price','CHG%','GAP%','Volume','RELVOL','Inside',
      'Breakout','200 EMA','9:15 HIGH','PREV HIGH','MaxQty','Sector'
    ],
    rows: [
      ['NEPHROPLUS','67.65','+7.37%','+1.04%','379.0K','1.41x','✗','Waiting','630.82','2,654.10','2,640.25','0','Health Services'],
      ['PANGJL','2','+7.37%','+1.04%','379.0K','1.41x','✗','Waiting','630.82','2,654.10','2,640.25','0','Health Services'],
      ['SEDEMAC','63.60','+5.97%','+0.86%','2.5M','4.31x','✗','Waiting','2,695.1','2,739.00','2,748.00','0','Consumer Durability'],
      ['ELIGIBL','2,775.20','+3.74%','+0.22%','156.0K','1.96x','✗','Waiting','2,695.1','2,739.00','2,748.00','0','Process Industries'],
      ['APOLLO','40.94','+3.67%','+0.00%','13.7M','1.60x','✗','Waiting','2,695.1','2,739.00','2,748.00','0','Technology Services'],
      ['SENDOC','39.61','+3.67%','+0.45%','5.5M','1.82x','✗','Waiting','2,695.1','2,739.00','2,748.00','0','Technology Services']
    ]
  },

  smartmoney: {
    name: 'SmartMoney',
    icon: '💰',
    entryRule: 'Breakout + Volume Confirmation',
    risk: '2.5%',
    columns: [
      'Symbol','Max Qty','Price / Chg%','Volume / Rel Vol','Signal Time',
      'POC / Gap','Signal Price / % Chg','Prev High','Candle Status'
    ],
    rows: [
      ['CYIENTDLM','179',`698.15<br>${chgSpan('+12.06%')}`,'12.9M<br>N/A','N/A','N/A<br>N/A','N/A','9:45','9:40 9:45 9:50'],
      ['LOTUSDEV','768',`162.70<br>${chgSpan('+9.81%')}`,'18.4M<br>N/A','N/A','N/A<br>N/A','N/A','9:45','9:40 9:45 9:50'],
      ['BLUESTONE','161',`776.05<br>${chgSpan('+6.51%')}`,'29.5M<br>N/A','N/A','N/A<br>N/A','N/A','9:45','9:40 9:45 9:50'],
      ['PNGJLM','196',`636.60<br>${chgSpan('+5.97%')}`,'2.5M<br>N/A','N/A','N/A<br>N/A','N/A','9:45','9:40 9:45 9:50'],
      ['BAJAJ_AUTO','',`10998.50<br>${chgSpan('+5.72%')}`,'1.4M<br>N/A','N/A','N/A<br>N/A','N/A','9:45','9:40 9:45 9:50']
    ]
  },

  bigplayers: {
    name: 'Big Players',
    icon: '🏢',
    entryRule: 'Support & Resistance',
    risk: '1.8%',
    columns: ['Symbol','Price','CHG%','Breakout','Support Price','MaxQty'],
    rows: [
      ['RELIANCE','2856.40','+2.1%','Active','2,800.00','100'],
      ['TCS','3920.00','+0.8%','Waiting','3,850.00','50'],
      ['INFY','1545.00','+3.4%','Active','1,500.00','75'],
      ['HDFC','1680.00','-1.2%','Waiting','1,650.00','60'],
      ['SBIN','785.00','+1.8%','Active','760.00','120'],
      ['BHARTI','1234.00','+0.3%','Waiting','1,200.00','40']
    ]
  }
};


/* ============================================================
   SECTION 4 — SCREENER
   Table rendering, strategy switch, run screener, order button
   ============================================================ */
function onStrategyChange() {
  const s = STRATEGIES[document.getElementById('strategySelect').value];
  if (!s) return;

  // Strategy details panel
  document.getElementById('infoStrategy').textContent = s.icon + ' ' + s.name;
  document.getElementById('infoRule').textContent = s.entryRule;
  document.getElementById('infoRisk').textContent = s.risk;

  // Table header
  document.getElementById('screenerHead').innerHTML =
    `<tr>${[...s.columns, 'Action'].map(c => `<th>${c}</th>`).join('')}</tr>`;

  // Table body
  const tbody = document.getElementById('screenerBody');
  if (!s.rows.length) {
    tbody.innerHTML = `<tr><td colspan="${s.columns.length + 1}" style="text-align:center;padding:40px;color:var(--text-muted)">No stocks found.</td></tr>`;
  } else {
    tbody.innerHTML = s.rows.map(r =>
      `<tr>${r.map(c => `<td>${c}</td>`).join('')}` +
      `<td><button class="btn-place-order btn-sm" onclick="placeOrder('${r[0]}')" ${autoBuyEnabled ? 'disabled' : ''}>Place Order</button></td></tr>`
    ).join('');
  }

  document.getElementById('screenerCount').textContent = `Showing ${s.rows.length} stocks`;
}

function toggleAutoBuyMode() {
  autoBuyEnabled = document.getElementById('autoBuyToggle').checked;
  const status = document.getElementById('toggleStatus');
  status.textContent = autoBuyEnabled ? 'ON' : 'OFF';
  status.classList.toggle('active', autoBuyEnabled);

  if (autoBuyEnabled) {
    showToast('🤖 Auto Buy ON', 'Auto-buy enabled for current strategy');
    const s = STRATEGIES[document.getElementById('strategySelect').value];
    const symbols = s.rows.map(r => r[0]);
    showToast('🚀 Auto-Buy All', `Buying ${symbols.length} stocks`);
  } else {
    showToast('👤 Manual Mode ON', 'Click Place Order to buy');
  }
  onStrategyChange();
}

function runScreener(e) {
  const btn = e?.target;
  const orig = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Running...';
  btn.disabled = true;

  setTimeout(() => {
    onStrategyChange();
    showToast('✅ Screener Complete', 'Stocks updated');
    btn.innerHTML = orig;
    btn.disabled = false;
  }, 600);
}

function placeOrder(symbol) {
  if (autoBuyEnabled) {
    showToast('⚠️ Auto Buy ON', 'Disable Auto Buy for manual orders');
    return;
  }
  showToast('📝 Order Placed', `Order placed for ${symbol}`);
}


/* ============================================================
   SECTION 5 — PORTFOLIO
   Holdings table with P&L, allocation stats
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
    <div class="stat-box"><div class="label">📈 Total P&L</div><div class="value" style="color:${totalPnl >= 0 ? GREEN : RED}">${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toLocaleString()}</div><div class="sub ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%</div></div>`;

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
          <td style="color:${pnl >= 0 ? GREEN : RED};font-weight:600">${pnl >= 0 ? '+' : ''}₹${pnl}</td>
          <td><button class="btn btn-danger btn-sm" onclick="showToast('📤 Sold','${h.symbol} sold')">Sell</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}


/* ============================================================
   SECTION 6 — SETTINGS
   Broker dropdown → show/hide credential fields
   ============================================================ */
function toggleBrokerFields() {
  const b = document.getElementById('brokerSelect').value;
  document.getElementById('dhanFields').style.display = b === 'dhan' ? 'grid' : 'none';
  document.getElementById('otherBrokerFields').style.display = (b && b !== 'dhan') ? 'block' : 'none';
}


/* ============================================================
   SECTION 7 — INIT (runs once on page load)
   ============================================================ */
onStrategyChange();
toggleBrokerFields();

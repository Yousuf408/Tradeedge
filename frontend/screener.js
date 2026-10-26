/* ============================================================
   SCREENER.JS  — v4.8.2 (RVOL UI + Columns Removed)
   ============================================================ */

let SCREENER_ALL_STOCKS = [];
let SCREENER_LTP = {};
let SCREENER_PREV_CLOSE = {};
let SCREENER_PIVOT = {};
let SCREENER_BS = {};
let SCREENER_PREOPEN = {};
let SCREENER_DAY_OPEN = {};
let SCREENER_RSI = {};
let SCREENER_LEVERAGE = {};
let SCREENER_MARGIN_PS = {};
let SCREENER_CHIPS = [];
let SCREENER_LASTUPD = {};
let SCREENER_VWAP = {};
let SCREENER_RSI_FIRST = {};
let SCREENER_INIT_DONE = false;
let SCREENER_SSE = null;
let FETCHING = false;
let QUOTE_FETCHING = false;
let DAYHLC_FETCHING = false;
let EOD_FETCHING = false;
let HISTORICAL_FETCHING = false;

let SCREENER_MOMENTUM_FILTER = 'open_gain';
let SCREENER_SORT_BY = 'change';
let SCREENER_SORT_DIR = 'desc';

const OPEN_GAIN_MIN_PCT = 0.95;
const OPEN_GAIN_MAX_GAP_PCT = 3.0;
const OPEN_GAIN_REQUIRE_POSITIVE_CHANGE = true;
let OPEN_GAIN_RANK = {};
let OPEN_GAIN_RERENDER_TIMER = null;

const SELL_OPEN_GAIN_MAX_PCT = -1.0;
const SELL_GAP_MAX_PCT = 3.0;
const SELL_REQUIRE_NEGATIVE_CHANGE = true;
let SELL_CANDIDATE_RANK = {};

let SCREENER_ACTIVE_STRATEGY = 'momentum';

const NIFTY50_TOKEN = '99926000';
const BANKNIFTY_TOKEN = '99926009';
const INDIAVIX_TOKEN = '99926017';
const INDEX_TOKENS = [NIFTY50_TOKEN, BANKNIFTY_TOKEN, INDIAVIX_TOKEN];

let TICKER_DATA = {
  [NIFTY50_TOKEN]: { name: 'NIFTY 50', ltp: 0, prev: 0 },
  [BANKNIFTY_TOKEN]: { name: 'BANK NIFTY', ltp: 0, prev: 0 },
  [INDIAVIX_TOKEN]: { name: 'INDIA VIX', ltp: 0, prev: 0 }
};
let TICKER_BREADTH = { adv: 0, dec: 0 };

let PER_TRADE = Number(localStorage.getItem('ta_capital') || 25000);
let SIDE_MODE = localStorage.getItem('ta_side_mode') || 'MIX';

const BATCH_SIZE = 20;
const BATCH_DELAY = 150;

/* ============================================================
   SECTION 1 — INIT
   ============================================================ */
async function initScreener() {
  if (SCREENER_INIT_DONE) {
    renderScreenerTable();
    startSSE();
    return;
  }
  setupControls();
  postCapital();
  postSideMode();
  await loadStockList();
  await loadLTP();
  await loadChips();
  SCREENER_INIT_DONE = true;
  startSSE();
}

/* ============================================================
   SECTION 2 — CONTROLS
   ============================================================ */
function setupControls() {
  const controls = document.querySelector('.screener-controls');
  if (!controls) return;

  ['#strategySelect', '.toggle-wrapper'].forEach(sel => {
    const el = controls.querySelector(sel);
    if (el) el.style.display = 'none';
  });
  controls.querySelectorAll('button, label').forEach(el => el.style.display = 'none');

  renderStrategyControls();
}

function renderStrategyControls() {
  const controls = document.querySelector('.screener-controls');
  if (!controls) return;

  controls.style.display = 'flex';
  controls.style.flexWrap = 'wrap';
  controls.style.gap = '6px';
  controls.style.alignItems = 'center';

  const btnStyle = 'style="padding:6px 10px;font-size:12px;white-space:nowrap"';

  let strategyButtons = `
    <button id="fetchBSBtn" class="btn btn-primary" ${btnStyle} onclick="startBSFetch()">💹 Fetch Buy/Sell</button>
    <button id="fetchHistoricalBtn" class="btn btn-outline" ${btnStyle} onclick="startHistoricalFetch()">📥 Fetch Historical</button>
    <button id="fetchEODBtn" class="btn btn-outline" ${btnStyle} onclick="startEODClosesFetch()">⚙️ Fetch EOD Closes</button>`;
  // ✅ REMOVED: fetchPreopenBtn

  controls.innerHTML = `
    ${strategyButtons}
    <label style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-left:2px">Capital ₹</label>
    <input id="perTradeInput" type="number" value="${PER_TRADE}" min="100"
           style="width:86px;padding:6px 8px;border:1.5px solid var(--border-soft);border-radius:8px;
                  font-size:12px;font-family:inherit;background:var(--bg-secondary);color:var(--text-primary)"
           onchange="onPerTradeChange()" />
    <label style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-left:2px">Mode</label>
    <select id="sideModeSelect"
            style="padding:6px 8px;border:1.5px solid var(--border-soft);border-radius:8px;
                   font-size:12px;font-family:inherit;background:var(--bg-secondary);
                   color:var(--text-primary);cursor:pointer;font-weight:700"
            onchange="onSideModeChange()">
      <option value="MIX"  ${SIDE_MODE === 'MIX'  ? 'selected' : ''}>🔀 Mix (50/50)</option>
      <option value="BUY"  ${SIDE_MODE === 'BUY'  ? 'selected' : ''}>📈 Buy Only</option>
      <option value="SELL" ${SIDE_MODE === 'SELL' ? 'selected' : ''}>📉 Sell Only</option>
    </select>
    <div id="progressBar" style="display:none;width:100%;margin-top:8px">
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;height:6px;overflow:hidden">
        <div id="progressFill" style="background:var(--gradient-brand);height:100%;width:0%;transition:width 0.3s"></div>
      </div>
      <div id="progressText" style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center">0 / 0</div>
    </div>`;

  const panelGlass = controls.closest('.panel-glass');
  if (panelGlass && !document.getElementById('stageChips')) {
    const chips = document.createElement('div');
    chips.id = 'stageChips';
    chips.className = 'filter-chips';
    const tableWrap = panelGlass.querySelector('.table-wrap');
    panelGlass.insertBefore(chips, tableWrap);
  }
}

function onPerTradeChange() {
  PER_TRADE = +document.getElementById('perTradeInput').value || 25000;
  localStorage.setItem('ta_capital', String(PER_TRADE));
  postCapital();
  renderScreenerTable();
}

let CAPITAL_POST_TIMER = null;
function postCapital() {
  clearTimeout(CAPITAL_POST_TIMER);
  CAPITAL_POST_TIMER = setTimeout(async () => {
    try {
      await fetch(API + '/api/auto/capital', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ value: PER_TRADE })
      });
    } catch (e) { console.error('Capital sync failed:', e); }
  }, 600);
}

function onSideModeChange() {
  const sel = document.getElementById('sideModeSelect');
  if (!sel) return;
  SIDE_MODE = sel.value;
  localStorage.setItem('ta_side_mode', SIDE_MODE);
  postSideMode();
  if (typeof showToast === 'function') {
    showToast('🎯 Mode Set', `Auto-trade: ${SIDE_MODE === 'MIX' ? 'Mix (50/50)' : SIDE_MODE + ' only'}`);
  }
}

let SIDE_MODE_POST_TIMER = null;
function postSideMode() {
  clearTimeout(SIDE_MODE_POST_TIMER);
  SIDE_MODE_POST_TIMER = setTimeout(async () => {
    try {
      await fetch(API + '/api/auto/side-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ value: SIDE_MODE })
      });
    } catch (e) { console.error('Side mode sync failed:', e); }
  }, 400);
}

async function loadChips() {
  try {
    const r = await fetch(API + '/api/screener/chips', {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();
    if (d && d.chips) { SCREENER_CHIPS = d.chips; renderScreenerTable(); }
  } catch (e) { console.error('Chips load failed:', e); }
}

/* ============================================================
   SECTION 2.1 — FILTERS + CHIPS
   ============================================================ */

function setMomentumFilter(key) {
  SCREENER_MOMENTUM_FILTER = key;
  if (key === 'open_gain') {
    SCREENER_SORT_BY = 'change';
    SCREENER_SORT_DIR = 'desc';
  } else if (key === 'sell_candidates') {
    SCREENER_SORT_BY = 'change';
    SCREENER_SORT_DIR = 'asc';   
  } else {
    SCREENER_SORT_BY = 'change';
    SCREENER_SORT_DIR = 'desc';
  }
  renderScreenerTable();
}

function scheduleOpenGainRerender() {
  if (SCREENER_MOMENTUM_FILTER !== 'open_gain' &&
      SCREENER_MOMENTUM_FILTER !== 'sell_candidates') return;
  if (OPEN_GAIN_RERENDER_TIMER) return;
  OPEN_GAIN_RERENDER_TIMER = setTimeout(() => {
    OPEN_GAIN_RERENDER_TIMER = null;
    if (SCREENER_MOMENTUM_FILTER === 'open_gain' ||
        SCREENER_MOMENTUM_FILTER === 'sell_candidates') {
      renderScreenerTable();
    }
  }, 2000);
}

function countOpenGainStocks() {
  let n = 0;
  for (const s of SCREENER_ALL_STOCKS) if (passesOpenGain(s.token)) n++;
  return n;
}

function countSellCandidates() {
  let n = 0;
  for (const s of SCREENER_ALL_STOCKS) if (passesSellCandidate(s.token)) n++;
  return n;
}

function renderChips() {
  const el = document.getElementById('stageChips');
  if (!el) return;

  if (SCREENER_ACTIVE_STRATEGY === 'momentum') {
    const chip = (key, label) => {
      const active = SCREENER_MOMENTUM_FILTER === key ? 'active' : '';
      return `<button class="filter-chip ${active}" onclick="setMomentumFilter('${key}')">${label}</button>`;
    };
    const ogCount = countOpenGainStocks();
    const scCount = countSellCandidates();
    
    el.innerHTML =
      chip('open_gain', `🏆 Top Performing (${ogCount})`) +
      chip('sell_candidates', `📉 Top Shorts (${scCount})`) +
      chip('all', 'All') +
      chip('rsi_chips', '🔒 RSI Chips');
      
    el.style.display = '';
    return;
  }

  el.style.display = '';
}

/* ============================================================
   SECTION 2.2 — SORTING
   ============================================================ */
function setSort(field) {
  if (SCREENER_SORT_BY === field) {
    SCREENER_SORT_DIR = SCREENER_SORT_DIR === 'desc' ? 'asc' : 'desc';
  } else {
    SCREENER_SORT_BY = field;
    SCREENER_SORT_DIR = 'desc';
  }
  renderScreenerTable();
}

function sortIndicator(field) {
  if (SCREENER_SORT_BY === field) return '<span style="opacity:0.3;margin-left:4px">↕</span>';
  return SCREENER_SORT_DIR === 'desc'
    ? '<span style="margin-left:4px">▼</span>'
    : '<span style="margin-left:4px">▲</span>';
}

function getSortValue(stock, field) {
  if (field === 'change') {
    const v = computeChangePct(stock.token);
    return v === null ? -Infinity : v;
  }
  if (field === 'open_gain') {
    const og = computeOpenGainPct(stock.token);
    return og === null ? -Infinity : og;
  }
  if (field === 'ltp') return SCREENER_LTP[stock.token] ?? -Infinity;
  if (field === 'rsi') return SCREENER_RSI[stock.token] ?? -Infinity;
  if (field === 'rvol') return SCREENER_BS[stock.token]?.rvol ?? -Infinity;
  return 0;
}

function sortStocks(stocks) {
  const field = SCREENER_SORT_BY;
  const dir = SCREENER_SORT_DIR;
  return [...stocks].sort((sa, sb) => {
    const va = getSortValue(sa, field);
    const vb = getSortValue(sb, field);
    return dir === 'desc' ? vb - va : va - vb;
  });
}

/* ============================================================
   SECTION 3.1 — HELPERS
   ============================================================ */
function computeChangePct(token) {
  const ltp = SCREENER_LTP[token];
  const prevClose = SCREENER_PREV_CLOSE[token];
  if (!ltp || !prevClose || prevClose <= 0) return null;
  return ((ltp - prevClose) / prevClose) * 100;
}

function computeGapPct(token) {
  const dayOpen = SCREENER_DAY_OPEN[token];
  const prev = SCREENER_PREV_CLOSE[token];
  if (!dayOpen || !prev || prev <= 0) return null;
  return ((dayOpen - prev) / prev) * 100;
}

function computeOpenGainPct(token) {
  const ltp = SCREENER_LTP[token];
  const dayOpen = SCREENER_DAY_OPEN[token];
  const o = dayOpen != null ? +dayOpen : null;
  if (!ltp || !o || o <= 0) return null;
  return ((+ltp - o) / o) * 100;
}

function passesOpenGain(token) {
  const og = computeOpenGainPct(token);
  if (og === null || og < OPEN_GAIN_MIN_PCT) return false;
  if (OPEN_GAIN_REQUIRE_POSITIVE_CHANGE) {
    const chg = computeChangePct(token);
    if (chg === null || chg <= 0) return false;
  }
  const gap = computeGapPct(token);
  if (gap !== null && gap >= OPEN_GAIN_MAX_GAP_PCT) return false;
  return true;
}

function passesSellCandidate(token) {
  const og = computeOpenGainPct(token);
  if (og === null || og > SELL_OPEN_GAIN_MAX_PCT) return false;
  if (SELL_REQUIRE_NEGATIVE_CHANGE) {
    const chg = computeChangePct(token);
    if (chg === null || chg >= 0) return false;
  }
  const gap = computeGapPct(token);
  if (gap !== null && gap > SELL_GAP_MAX_PCT) return false;
  return true;
}

function renderOpenGainSub(token) {
  const og = computeOpenGainPct(token);
  if (og === null) return '';
  const pos = og >= 0;
  const color = pos ? 'var(--success)' : 'var(--danger)';
  return `<span class="ogain-sub" style="display:block;font-size:10px;font-weight:700;color:${color}">${pos ? '+' : ''}${og.toFixed(2)}% open</span>`;
}

function computeMaxQty(token, ltp) {
  const lev = SCREENER_LEVERAGE[token];
  if (!ltp || ltp <= 0) return '—';
  if (!lev || lev <= 0) return '—';
  if (!PER_TRADE || PER_TRADE <= 0) return '—';
  const qty = Math.floor((PER_TRADE * lev) / ltp);
  return qty > 0 ? qty : '—';
}

function formatPriceINR(v) {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTimeOnly(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    const ist = new Date(dt.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(11, 16);
  } catch { return ''; }
}

function formatTimeIST(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(11, 19);
  } catch { return '—'; }
}

function formatQty(n) {
  if (n == null) return '—';
  if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(1) + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

/* ============================================================
   SECTION 3.2 — TICKER RENDER
   ============================================================ */
function renderTicker() {
  const el = document.getElementById('tickerContent');
  if (!el) return;

  let html = '';
  
  for (const [token, data] of Object.entries(TICKER_DATA)) {
    if (!data.ltp) continue;

    let pct = 0;
    let isPos = true;
    let colorClass = 'pos';
    let arrow = '▲';
    let sign = '+';
    let showChange = false;

    if (data.prev > 0) {
      showChange = true;
      const diff = data.ltp - data.prev;
      pct = (diff / data.prev) * 100;
      isPos = diff >= 0;
      colorClass = isPos ? 'pos' : 'neg';
      arrow = isPos ? '▲' : '▼';
      sign = isPos ? '+' : '';
    }

    const finalClass = colorClass; 
    const changeText = showChange ? `${arrow} ${sign}${pct.toFixed(2)}%` : '';

    html += `<div class="ticker-item">
      ${data.name}
      <span class="val ${finalClass}">${data.ltp.toFixed(2)} <span style="font-size:10px">${changeText}</span></span>
    </div>`;
  }

  if (TICKER_BREADTH.adv > 0 || TICKER_BREADTH.dec > 0) {
    html += `<div class="ticker-item">
      MARKET BREADTH
      <span class="val"><span class="pos">🟢 ${TICKER_BREADTH.adv} Adv</span> &nbsp;|&nbsp; <span class="neg">🔴 ${TICKER_BREADTH.dec} Dec</span></span>
    </div>`;
  }

  el.innerHTML = html || `<div class="ticker-item">Waiting for market data...</div>`;
}

/* ============================================================
   SECTION 3.3 — FAST CELL UPDATE (SSE LTP)
   ============================================================ */
function updateLTPCells(ticks, vwaps, rsis) {
  const rows = document.querySelectorAll('#screenerBody tr[data-token]');
  if (!rows.length) return;
  const rowMap = {};
  rows.forEach(r => { rowMap[r.dataset.token] = r; });

  for (const [token, price] of Object.entries(ticks)) {
    SCREENER_LTP[token] = price;
    const row = rowMap[token];
    if (!row) continue;

    const ltpEl = row.querySelector('.ltp-cell');
    if (ltpEl) ltpEl.textContent = '₹' + (+price).toFixed(2);

    const chgEl = row.querySelector('.change-cell');
    if (chgEl) {
      const pct = computeChangePct(token);
      if (pct === null) {
        chgEl.innerHTML = '<span style="color:var(--text-muted)">—</span>';
      } else {
        const isPos = pct >= 0;
        const color = isPos ? 'var(--success)' : 'var(--danger)';
        chgEl.innerHTML = `<span style="color:${color};font-weight:700">${isPos ? '+' : ''}${pct.toFixed(2)}%</span>`;
      }
    }

    const ogEl = row.querySelector('.ogain-cell');
    if (ogEl) ogEl.innerHTML = renderOpenGainSub(token);

    const mqEl = row.querySelector('.maxqty-cell');
    if (mqEl) {
      mqEl.textContent = computeMaxQty(token, +price);
    }

    if (vwaps && vwaps[token] != null) {
      SCREENER_VWAP[token] = vwaps[token];
      const vwEl = row.querySelector('.vwap-cell');
      if (vwEl) vwEl.textContent = '₹' + (+vwaps[token]).toFixed(2);
    }

    if (rsis && rsis[token] != null) {
      SCREENER_RSI[token] = rsis[token];
      const rsiEl = row.querySelector('.rsi-cell');
      if (rsiEl) rsiEl.innerHTML = renderRSICell(token);
    }
  }
}

/* ============================================================
   SECTION 3.4 — BUY/SELL CELL
   ============================================================ */
function renderBuySellCell(token) {
  const bs = SCREENER_BS[token];
  if (!bs || bs.buyQty == null || bs.sellQty == null) {
    return '<span style="color:var(--text-muted)">—</span>';
  }
  const total = bs.buyQty + bs.sellQty;
  if (total <= 0) return '<span style="color:var(--text-muted)">—</span>';
  const buyPct = (bs.buyQty / total) * 100;
  const sellPct = 100 - buyPct;
  const color = buyPct > 55 ? 'var(--success)' : buyPct < 45 ? 'var(--danger)' : 'var(--text-secondary)';
  const arrow = buyPct > 55 ? '▲' : buyPct < 45 ? '▼' : '•';
  return `
    <div style="display:flex;flex-direction:column;gap:2px;min-width:80px">
      <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:${color}">
        <span>${arrow} ${buyPct.toFixed(0)}%</span>
        <span style="color:var(--text-muted);font-weight:500">${sellPct.toFixed(0)}%</span>
      </div>
      <div style="background:rgba(225,112,85,0.25);border-radius:3px;height:6px;overflow:hidden;position:relative">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${buyPct}%;background:var(--success)"></div>
      </div>
      <div style="font-size:9px;color:var(--text-muted);font-family:ui-monospace,monospace">${(+bs.buyQty).toLocaleString('en-IN')} / ${(+bs.sellQty).toLocaleString('en-IN')}</div>
    </div>`;
}

/* ============================================================
   SECTION 3.5 — RSI CELL
   ============================================================ */
function renderRSICell(token) {
  const rsi = SCREENER_RSI[token];
  if (rsi == null) return '<span style="color:var(--text-muted)">—</span>';

  const v = +rsi;
  let color = 'var(--text-primary)';
  let badge = '';
  if (v >= 70) { color = 'var(--danger)'; badge = ' 🔥'; }
  else if (v >= 65) { color = '#F5A623'; }
  else if (v <= 30) { color = 'var(--success)'; }

  return `<span style="color:${color};font-weight:700">${v.toFixed(1)}${badge}</span>`;
}

/* ============================================================
   SECTION 4 — LOAD STOCK LIST + CACHED DATA
   ============================================================ */
async function loadStockList() {
  try {
    const r = await fetch(API + '/api/stocks', { headers: { Authorization: 'Bearer ' + getToken() } });
    if (r.ok) SCREENER_ALL_STOCKS = await r.json();
  } catch (e) { console.error('Stock list failed:', e); }
}

/* ============================================================
   SECTION 5.3 — MANUAL BUY/SELL
   ============================================================ */
async function startBSFetch() {
  const btn = document.getElementById('fetchBSBtn');
  if (!btn) return;
  if (btn.disabled) return;

  const ok = confirm('Fetch Buy/Sell + Volume snapshot for all stocks now?');
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '⏳ Fetching Buy/Sell...';

  try {
    const r = await fetch(API + '/api/admin/force-bs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (!r.ok) {
      showToast('⚠️ Failed', d.error || `HTTP ${r.status}`);
    } else {
      showToast('✅ Buy/Sell + Volume Saved', `${d.saved}/${d.total} stocks · ${d.date}`);
      await loadLTP();
    }
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }

  btn.disabled = false;
  btn.textContent = '💹 Fetch Buy/Sell';
}

/* ============================================================
   SECTION 5.5 — MANUAL EOD CLOSES FETCH
   ============================================================ */
async function startEODClosesFetch() {
  const btn = document.getElementById('fetchEODBtn');
  if (!btn) return;
  if (EOD_FETCHING) return;

  const ok = confirm('Fetch EOD closes (last 20 one-min) for all stocks now?\nThis will take ~3-5 minutes. Use this for first-time setup.');
  if (!ok) return;

  EOD_FETCHING = true;
  btn.disabled = true;
  btn.textContent = '⏳ Fetching EOD... (~3-5 min)';

  try {
    const r = await fetch(API + '/api/admin/force-day-hlc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (!r.ok) {
      showToast('⚠️ Failed', d.error || `HTTP ${r.status}`);
    } else {
      showToast('✅ EOD Closes Saved', 'RSI-ready for next trading day');
      await loadLTP();
    }
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }

  EOD_FETCHING = false;
  btn.disabled = false;
  btn.textContent = '⚙️ Fetch EOD Closes';
}

/* ============================================================
   SECTION 5.6 — FETCH HISTORICAL
   ============================================================ */
async function startHistoricalFetch() {
  const btn = document.getElementById('fetchHistoricalBtn');
  if (!btn) return;
  if (HISTORICAL_FETCHING) return;

  const ok = confirm(
    '📥 Fetch Historical (Angel REST)\n\n' +
    'Ye last 10 working days ka 1-min + 5-min candle Angel REST se fetch karega ' +
    '(dono intervals alag-alag API call — 776 calls, rate-limit safe) ' +
    'aur ws_1min_close / ws_5min_close columns overwrite karega.\n\n' +
    'Saare 388 stocks — approx 8-9 minutes (400ms+900ms gaps).\n\n' +
    'Continue?'
  );
  if (!ok) return;

  HISTORICAL_FETCHING = true;
  btn.disabled = true;
  btn.textContent = '⏳ Historical fetch... (~8-9 min)';
  showToast('📥 Historical Fetch', 'Starting Angel REST backfill...');

  try {
    const r = await fetch(API + '/api/admin/fetch-historical', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ days: 10 })
    });
    const d = await r.json();

    if (!r.ok) {
      showToast('⚠️ Failed', d.error || `HTTP ${r.status}`);
    } else {
      const s = d.summary || {};
      showToast(
        '✅ Historical Saved',
        `${s.ok || 0} ok · ${s.skipped || 0} skipped · ${s.failed || 0} failed · ` +
        `${s.days_saved || 0} days · ${d.elapsed_sec || 0}s`
      );
      await loadLTP();
    }
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }

  HISTORICAL_FETCHING = false;
  btn.disabled = false;
  btn.textContent = '📥 Fetch Historical';
}

function updateProgress(done, total) {
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = `${done} / ${total} (${pct}%)`;
}

/* ============================================================
   SECTION 6 — LTP (initial load only; live updates via SSE)
   ============================================================ */
async function loadLTP() {
  const baseList = SCREENER_ALL_STOCKS;
  const tokens = baseList.map(s => s.token);
  
  for (const t of INDEX_TOKENS) {
      if (!tokens.includes(t)) tokens.push(t);
  }
  
  if (!tokens.length) return;

  try {
    const r = await fetch(API + '/api/screener/ltp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ tokens })
    });
    const d = await r.json();
    if (d.results) {
      for (const item of d.results) {
        if (item.ltp) SCREENER_LTP[item.token] = item.ltp;
        if (item.prevClose) SCREENER_PREV_CLOSE[item.token] = item.prevClose;
        if (item.pivot) SCREENER_PIVOT[item.token] = item.pivot;
        if (item.preopenPrice != null) SCREENER_PREOPEN[item.token] = { price: item.preopenPrice };
        if (item.dayOpen != null) SCREENER_DAY_OPEN[item.token] = item.dayOpen;
        if (item.rsi != null) SCREENER_RSI[item.token] = item.rsi;
        if (item.serverTime) SCREENER_LASTUPD[item.token] = item.serverTime;
        if (item.vwap != null) SCREENER_VWAP[item.token] = item.vwap;
        if (item.rsiFirst != null) SCREENER_RSI_FIRST[item.token] = item.rsiFirst;
        if (item.leverage != null) SCREENER_LEVERAGE[item.token] = item.leverage;
        if (item.marginPerShare != null) SCREENER_MARGIN_PS[item.token] = item.marginPerShare;

        if (item.buyQty != null || item.sellQty != null || item.rank != null || item.rvol != null) {
          const existing = SCREENER_BS[item.token] || {};
          SCREENER_BS[item.token] = {
            buyQty: item.buyQty ?? existing.buyQty,
            sellQty: item.sellQty ?? existing.sellQty,
            volume: item.bsVolume ?? existing.volume,
            rvol: item.rvol ?? existing.rvol,
            rank: item.rank ?? existing.rank
          };
        }

        if (INDEX_TOKENS.includes(item.token)) {
          TICKER_DATA[item.token].ltp = item.ltp || 0;
          TICKER_DATA[item.token].prev = item.prevClose || 0;
        }
      }
    }
    renderTicker();
    renderScreenerTable();
  } catch (e) { console.error('LTP failed:', e); }
}

/* ============================================================
   SECTION 6.1 — SSE
   ============================================================ */
function startSSE() {
  if (SCREENER_SSE) return;
  const url = API + '/api/screener/stream?token=' + encodeURIComponent(getToken());
  SCREENER_SSE = new EventSource(url);

  SCREENER_SSE.addEventListener('hello', () => {
    console.log('📡 SSE connected');
  });

  SCREENER_SSE.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      if (msg.type === 'ltp' && msg.ticks) {
        if (msg.prevCloses) {
          for (const [t, pc] of Object.entries(msg.prevCloses)) {
            SCREENER_PREV_CLOSE[t] = pc;
          }
        }

        for (const token of INDEX_TOKENS) {
          if (msg.ticks[token] !== undefined) {
            TICKER_DATA[token].ltp = msg.ticks[token];
            TICKER_DATA[token].prev = SCREENER_PREV_CLOSE[token] || msg.prevCloses?.[token] || TICKER_DATA[token].prev;
          }
        }

        if (msg.breadth) {
          TICKER_BREADTH = msg.breadth;
        }
        
        renderTicker();
        updateLTPCells(msg.ticks, msg.vwaps, msg.rsis);
        scheduleOpenGainRerender();
      }
      else if (msg.type === 'bs' && msg.bs) {
        for (const [token, v] of Object.entries(msg.bs)) {
          SCREENER_BS[token] = { 
            buyQty: v.buyQty, 
            sellQty: v.sellQty, 
            volume: v.volume, 
            rvol: v.rvol, 
            rank: v.rank 
          };
          if (v.preopenPrice != null) SCREENER_PREOPEN[token] = { price: v.preopenPrice };
          if (v.dayOpen != null) SCREENER_DAY_OPEN[token] = v.dayOpen;
          if (v.rsi != null) SCREENER_RSI[token] = v.rsi;
          if (v.leverage != null) SCREENER_LEVERAGE[token] = v.leverage;
          if (v.marginPerShare != null) SCREENER_MARGIN_PS[token] = v.marginPerShare;
          if (v.vwap != null) SCREENER_VWAP[token] = v.vwap;
          if (v.rsiFirst != null) SCREENER_RSI_FIRST[token] = v.rsiFirst;
          if (v.prevClose != null) SCREENER_PREV_CLOSE[token] = v.prevClose;
        }
        renderScreenerTable();
      }
      else if (msg.type === 'chip' && msg.chips) {
        SCREENER_CHIPS = msg.chips;
        renderScreenerTable();
      }
    } catch {}
  };

  SCREENER_SSE.onerror = () => {
    console.warn('📡 SSE dropped — reconnecting...');
  };
}

function stopSSE() {
  if (SCREENER_SSE) {
    SCREENER_SSE.close();
    SCREENER_SSE = null;
  }
}

/* ============================================================
   SECTION 8 — RENDER
   ============================================================ */
function renderScreenerTable() {
  const head = document.getElementById('screenerHead');
  const body = document.getElementById('screenerBody');
  const count = document.getElementById('screenerCount');
  if (!head || !body) return;

  if (SCREENER_ACTIVE_STRATEGY === 'momentum') {
    const isOpenGainTab = SCREENER_MOMENTUM_FILTER === 'open_gain';
    const isSellTab = SCREENER_MOMENTUM_FILTER === 'sell_candidates';
    const showRankCol = isOpenGainTab || isSellTab;
    
    // ✅ UPDATED COLSPAN (Removed Pre-Open, 20 EMA, Action)
    const COLSPAN = showRankCol ? 11 : 10;

    // ✅ REMOVED: PRE-OPEN, 20 EMA, ACTION Headers
    head.innerHTML = `<tr>
      ${showRankCol ? `<th class="th-sortable" style="width:46px" onclick="setSort('change')"
          title="${isSellTab ? 'Short rank — Change % (Lowest first)' : 'Top Performing rank — Change % (Highest first)'}">#${sortIndicator('change')}</th>` : ''}
      <th>Stock / Company</th>
      <th class="th-sortable" onclick="setSort('ltp')">LTP ${sortIndicator('ltp')}<br>
          <span class="th-sub" onclick="event.stopPropagation();setSort('change')">Change % ${sortIndicator('change')}</span></th>
      <th>DAY OPEN</th>
      <th class="th-sortable" onclick="setSort('rsi')">RSI ${sortIndicator('rsi')}</th>
      <th>RSI 9:15 🔒</th>
      <th>B/S VOLUME</th>
      <th class="th-sortable" onclick="setSort('rvol')">VOLUME ${sortIndicator('rvol')}</th>
      <th>VWAP</th>
      <th>MAXQTY</th>
      <th>LAST UPDATE</th>
    </tr>`;

    let filtered = [...SCREENER_ALL_STOCKS];

    if (SCREENER_MOMENTUM_FILTER === 'open_gain') {
      filtered = filtered.filter(s => passesOpenGain(s.token));
    } else if (SCREENER_MOMENTUM_FILTER === 'sell_candidates') {
      filtered = filtered.filter(s => passesSellCandidate(s.token));
    } else if (SCREENER_MOMENTUM_FILTER === 'rsi_chips') {
      const chipTokens = new Set(SCREENER_CHIPS.map(c => String(c.token)));
      filtered = filtered.filter(s => chipTokens.has(String(s.token)));
      const rankBy = {};
      SCREENER_CHIPS.forEach(c => { rankBy[String(c.token)] = c.rank; });
      filtered.sort((a, b) => (rankBy[String(a.token)] ?? 999) - (rankBy[String(b.token)] ?? 999));
    }

    OPEN_GAIN_RANK = {};
    SELL_CANDIDATE_RANK = {};

    if (SCREENER_MOMENTUM_FILTER === 'open_gain') {
      [...filtered]
        .sort((a, b) => getSortValue(b, 'change') - getSortValue(a, 'change'))
        .forEach((s, i) => { OPEN_GAIN_RANK[String(s.token)] = i + 1; });
    } else if (SCREENER_MOMENTUM_FILTER === 'sell_candidates') {
      [...filtered]
        .sort((a, b) => getSortValue(a, 'change') - getSortValue(b, 'change'))
        .forEach((s, i) => { SELL_CANDIDATE_RANK[String(s.token)] = i + 1; });
    }

    const sorted = sortStocks(filtered);

    if (!sorted.length) {
      let emptyMsg;
      if (SCREENER_MOMENTUM_FILTER === 'rsi_chips') {
        emptyMsg = `🔒 No RSI chips locked today.<br>
            <span style="font-size:11px">Chips lock at 9:15 (top-10 rank · gap ≤3% · RSI ≥70)</span>`;
      } else if (SCREENER_MOMENTUM_FILTER === 'open_gain') {
        emptyMsg = `🏆 Abhi koi stock DAY OPEN se <b>+${OPEN_GAIN_MIN_PCT.toFixed(2)}%</b> (change% positive, gap-up < ${OPEN_GAIN_MAX_GAP_PCT}%) nahi hai.<br>
            <span style="font-size:11px">Live ticks pe har 2 second auto-refresh</span>`;
      } else if (SCREENER_MOMENTUM_FILTER === 'sell_candidates') {
        emptyMsg = `📉 Abhi koi stock DAY OPEN se <b>${SELL_OPEN_GAIN_MAX_PCT.toFixed(2)}%</b> neeche (change% negative, gap-up < ${SELL_GAP_MAX_PCT}%) nahi hai.<br>
            <span style="font-size:11px">Live ticks pe har 2 second auto-refresh</span>`;
      } else {
        emptyMsg = `Loading stocks...<br>Please wait a few seconds.`;
      }
      body.innerHTML = `<tr><td colspan="${COLSPAN}" style="text-align:center;padding:60px;color:var(--text-muted)">
            ${emptyMsg}
          </td></tr>`;
      if (count) count.textContent = `0 / ${SCREENER_ALL_STOCKS.length}`;
      renderChips();
      return;
    }

    body.innerHTML = sorted.map(s => {
      const ltp = SCREENER_LTP[s.token];
      const bs = SCREENER_BS[s.token];
      const dayOpen = SCREENER_DAY_OPEN[s.token];

      const maxQty = computeMaxQty(s.token, ltp);

      const changePct = computeChangePct(s.token);
      let changeLine;
      if (changePct === null) {
        changeLine = '<span style="color:var(--text-muted)">—</span>';
      } else {
        const isPos = changePct >= 0;
        const color = isPos ? 'var(--success)' : 'var(--danger)';
        changeLine = `<span style="color:${color};font-weight:700">${isPos ? '+' : ''}${changePct.toFixed(2)}%</span>`;
      }

      // ✅ REMOVED preopenCell logic
      const dayOpenCell = dayOpen
        ? `<span style="font-weight:700">₹${(+dayOpen).toFixed(2)}</span><span class="ogain-cell">${renderOpenGainSub(s.token)}</span>`
        : '<span style="color:var(--text-muted)">—</span><span class="ogain-cell"></span>';

      const lastUpdate = formatTimeIST(SCREENER_LASTUPD[s.token]);
      const rowClass = '';

      const rankNum = (isSellTab ? SELL_CANDIDATE_RANK : OPEN_GAIN_RANK)[String(s.token)];

      // ✅ REMOVED PRE-OPEN, 20 EMA, ACTION <td> elements
      return `<tr class="${rowClass}" data-token="${s.token}">
        ${showRankCol ? `<td style="font-weight:800;color:${isSellTab ? 'var(--danger)' : '#6C5CE7'};font-size:12px;text-align:center">${rankNum ?? '—'}</td>` : ''}
        <td><span class="sym">${s.sym}</span><span class="tok">${s.token}</span></td>
        <td style="white-space:nowrap">
          <span class="cell-primary ltp-cell">${ltp ? '₹' + (+ltp).toFixed(2) : '—'}</span>
          <span class="cell-sub change-cell">${changeLine}</span>
        </td>
        <td style="white-space:nowrap">${dayOpenCell}</td>
        <td class="rsi-cell" style="white-space:nowrap">${renderRSICell(s.token)}</td>
        <td style="white-space:nowrap;font-weight:700;color:#F5A623">${SCREENER_RSI_FIRST[s.token] != null ? (+SCREENER_RSI_FIRST[s.token]).toFixed(1) : '—'}</td>
        <td style="white-space:nowrap">${renderBuySellCell(s.token)}</td>
        <td style="white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px">
          ${bs?.volume ? formatQty(bs.volume) : '—'} 
          ${bs?.rvol ? `<span style="color:${bs.rvol >= 2 ? 'var(--success)' : '#F5A623'}; font-size:10px; margin-left:4px">(${bs.rvol}x)</span>` : ''}
        </td>
        <td class="vwap-cell" style="white-space:nowrap;font-weight:700;color:#6C5CE7">${SCREENER_VWAP[s.token] != null ? '₹' + (+SCREENER_VWAP[s.token]).toFixed(2) : '—'}</td>
        <td class="maxqty-cell" style="font-weight:700;color:#6C5CE7">${maxQty}</td>
        <td style="color:var(--text-muted);font-size:11px;font-family:ui-monospace,monospace">${lastUpdate}</td>
      </tr>`;
    }).join('');

    if (count) count.textContent = `${sorted.length} / ${SCREENER_ALL_STOCKS.length} shown`;
    renderChips();
    return;
  }
}

/* ============================================================
   SECTION 9 — ORDER PLACEHOLDER
   ============================================================ */
function placeOrder(sym) {
  showToast('📝 Order', `Buy signal for ${sym} — order placement coming soon`);
}

/* ============================================================
   SECTION 10.1 — SAFETY STUBS
   ============================================================ */
function loadCachedData() { return Promise.resolve(); }
function startFetch() { if (typeof showToast === 'function') showToast('⚠️ Removed', 'Advance ORB fetch hata diya gaya'); }
function startQuoteFetch() { if (typeof showToast === 'function') showToast('⚠️ Removed', 'Advance ORB fetch hata diya gaya'); }
function startDayHLCFetch() { if (typeof showToast === 'function') showToast('⚠️ Removed', 'Advance ORB fetch hata diya gaya'); }
function startPreopenFetch() { } // ✅ Safety Stub
function onStrategyChange() { }
function setStageFilter() { }
function renderChipBar() { }
function updateNiftyHeader() { } // Safety stub

/* ============================================================
   SECTION 10 — HELPERS
   ============================================================ */
function setPill(text, color) {
  const pill = document.getElementById('screenerStatusPill');
  if (!pill) return;
  pill.textContent = text;
  pill.style.color = color || 'var(--text-muted)';
}

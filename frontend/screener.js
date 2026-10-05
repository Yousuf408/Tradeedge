/* ============================================================
   SCREENER.JS  — v1.8
   ORB + timestamps + cachedTokens + SSE + NIFTY 50 header
   + Filter chips + Column sort + Entry-signal row highlight
   + Compact controls (no Ready pill, no range hint)

   CHANGELOG v1.8 (2026-10-05):
   - Removed "Ready" status pill (redundant)
   - Removed "Range ≤ …" hint text
   - NIFTY header: arrow ▲ ▼ between LTP and change
   - NIFTY color matches direction (whole row colored)
   ============================================================ */

let SCREENER_ALL_STOCKS = [];
let SCREENER_STOCKS = [];
let SCREENER_ALL_CANDLES = {};
let SCREENER_CACHED_TOKENS = new Set();
let SCREENER_LTP = {};
let SCREENER_PREV_CLOSE = {};
let SCREENER_ORB = {};
let SCREENER_INIT_DONE = false;
let SCREENER_LTP_TIMER = null;
let SCREENER_SSE = null;
let FETCHING = false;

let SCREENER_STAGE_FILTER = 'all';
let SCREENER_SORT_BY = 'change';
let SCREENER_SORT_DIR = 'desc';

const NIFTY50_TOKEN = '99926000';

const CURRENT_STRATEGY = 'advance_orb';
const STRATEGY_FILTER = { maxRangePct: 1.5, minPrice: 150, maxPrice: 3500 };

let PER_TRADE = 10000;
const BATCH_SIZE = 20;
const BATCH_DELAY = 150;

/* ============================================================
   SECTION 1 — INIT
   ============================================================ */
async function initScreener() {
  if (SCREENER_INIT_DONE) {
    renderScreenerTable();
    if (!SCREENER_LTP_TIMER) startLTPRefresh();
    startSSE();
    return;
  }
  setupControls();
  await loadStockList();
  await loadCachedData();
  SCREENER_INIT_DONE = true;
  startSSE();
}

/* ============================================================
   SECTION 2 — CONTROLS + CHIPS
   ============================================================ */
function setupControls() {
  const controls = document.querySelector('.screener-controls');
  if (!controls) return;

  ['#strategySelect', '.toggle-wrapper'].forEach(sel => {
    const el = controls.querySelector(sel);
    if (el) el.style.display = 'none';
  });
  controls.querySelectorAll('button, label').forEach(el => el.style.display = 'none');

  /* Compact control bar — Ready pill and Range hint removed */
  controls.innerHTML = `
    <button id="fetch915Btn" class="btn btn-primary" onclick="startFetch()">⚡ Fetch 9:15 Candles</button>
    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-left:8px">Per-Trade ₹</label>
    <input id="perTradeInput" type="number" value="10000" min="100"
           style="width:110px;padding:7px 12px;border:1.5px solid var(--border-soft);border-radius:8px;
                  font-size:13px;font-family:inherit;background:var(--bg-secondary);color:var(--text-primary)"
           onchange="onPerTradeChange()" />
    <div id="progressBar" style="display:none;width:100%;margin-top:8px">
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;height:6px;overflow:hidden">
        <div id="progressFill" style="background:var(--gradient-brand);height:100%;width:0%;transition:width 0.3s"></div>
      </div>
      <div id="progressText" style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center">0 / 0</div>
    </div>`;

  /* Inject filter chips container between panel-head and table-wrap */
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
  PER_TRADE = +document.getElementById('perTradeInput').value || 10000;
  renderScreenerTable();
}

/* ============================================================
   SECTION 2.1 — STAGE CATEGORIZATION
   ============================================================ */
function categorizeStock(stock) {
  const orb = SCREENER_ORB[stock.token] || {};
  if (orb.entrySignal) return 'entry';
  if (orb.lowBroken)   return 'lowbrok';
  return 'waiting';
}

function setStageFilter(key) {
  SCREENER_STAGE_FILTER = key;
  renderScreenerTable();
}

function renderChips() {
  const el = document.getElementById('stageChips');
  if (!el) return;

  const counts = { all: 0, entry: 0, lowbrok: 0, waiting: 0 };
  for (const s of SCREENER_STOCKS) {
    counts.all++;
    counts[categorizeStock(s)]++;
  }

  const chip = (key, label, count) => {
    const active = SCREENER_STAGE_FILTER === key ? 'active' : '';
    return `<button class="filter-chip ${active}" onclick="setStageFilter('${key}')">
      ${label} <span class="chip-count">${count}</span>
    </button>`;
  };

  el.innerHTML =
    chip('all', 'All', counts.all) +
    chip('entry', '🎯 Entry Signal', counts.entry) +
    chip('lowbrok', '⬇️ Low Broken', counts.lowbrok) +
    chip('waiting', '⏸️ Waiting', counts.waiting);
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
  if (SCREENER_SORT_BY !== field) return '<span style="opacity:0.3;margin-left:4px">↕</span>';
  return SCREENER_SORT_DIR === 'desc'
    ? '<span style="margin-left:4px">▼</span>'
    : '<span style="margin-left:4px">▲</span>';
}

function getSortValue(stock, field) {
  const candle = SCREENER_ALL_CANDLES[stock.token];
  if (field === 'change') {
    const v = computeChangePct(stock.token);
    return v === null ? -Infinity : v;
  }
  if (field === 'ltp') {
    return SCREENER_LTP[stock.token] ?? -Infinity;
  }
  if (field === 'range') {
    if (!candle) return -Infinity;
    return ((candle.high - candle.low) / candle.low) * 100;
  }
  if (field === 'stage') {
    const orb = SCREENER_ORB[stock.token] || {};
    if (orb.entrySignal)       return 4;
    if (orb.pullbackConfirmed) return 3;
    if (orb.lowBroken)         return 2;
    return 1;
  }
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
   SECTION 3 — FILTER (strategy)
   ============================================================ */
function passesFilter(candle) {
  if (!candle) return false;
  const rangePct = ((candle.high - candle.low) / candle.low) * 100;
  if (rangePct > STRATEGY_FILTER.maxRangePct) return false;
  if (candle.close < STRATEGY_FILTER.minPrice || candle.close > STRATEGY_FILTER.maxPrice) return false;
  return true;
}

function recomputeFilteredStocks() {
  SCREENER_STOCKS = SCREENER_ALL_STOCKS.filter(s => passesFilter(SCREENER_ALL_CANDLES[s.token]));
}

/* ============================================================
   SECTION 3.1 — CHANGE % HELPERS
   ============================================================ */
function computeChangePct(token) {
  const ltp = SCREENER_LTP[token];
  const prevClose = SCREENER_PREV_CLOSE[token];
  if (!ltp || !prevClose || prevClose <= 0) return null;
  return ((ltp - prevClose) / prevClose) * 100;
}

function formatPriceINR(v) {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ============================================================
   SECTION 3.2 — NIFTY 50 HEADER
   Format:  22,555.75  ▲ +133.80 (+0.60%)  — whole row colored
   ============================================================ */
function updateNiftyHeader() {
  const ltpEl = document.getElementById('niftyLtp');
  const chgEl = document.getElementById('niftyChange');
  if (!ltpEl || !chgEl) return;

  const ltp = SCREENER_LTP[NIFTY50_TOKEN];
  const prev = SCREENER_PREV_CLOSE[NIFTY50_TOKEN];

  if (!ltp) {
    ltpEl.textContent = '—';
    ltpEl.style.color = 'var(--text-primary)';
    chgEl.textContent = '';
    return;
  }

  const ltpText = formatPriceINR(ltp);

  if (prev && prev > 0) {
    const diff = ltp - prev;
    const pct = (diff / prev) * 100;
    const isPos = diff >= 0;
    const color = isPos ? 'var(--success)' : 'var(--danger)';
    const arrow = isPos ? '▲' : '▼';
    const sign = isPos ? '+' : '';

    ltpEl.textContent = ltpText;
    ltpEl.style.color = color;
    chgEl.textContent = `${arrow} ${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
    chgEl.style.color = color;
  } else {
    ltpEl.textContent = ltpText;
    ltpEl.style.color = 'var(--text-primary)';
    chgEl.textContent = '';
  }
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

async function loadCachedData() {
  try {
    const r = await fetch(API + '/api/screener/data?strategy=' + CURRENT_STRATEGY, {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();
    if (!d.ok) return;

    SCREENER_ALL_CANDLES = {};
    if (d.results) {
      for (const item of d.results) {
        const c = item.candle;
        if (Array.isArray(c) && c.length >= 5) {
          SCREENER_ALL_CANDLES[item.token] = {
            open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
          };
        }
      }
    }

    if (Array.isArray(d.cachedTokens)) {
      d.cachedTokens.forEach(t => SCREENER_CACHED_TOKENS.add(String(t)));
    }

    recomputeFilteredStocks();
    renderScreenerTable();

    if (Object.keys(SCREENER_ALL_CANDLES).length) {
      await loadLTP();
      startLTPRefresh();
    }
  } catch (e) { console.error(e); }
}

/* ============================================================
   SECTION 5 — FETCH
   ============================================================ */
async function startFetch() {
  if (FETCHING) return;
  if (!SCREENER_ALL_STOCKS.length) { showToast('⚠️ No stocks', ''); return; }

  FETCHING = true;
  const btn = document.getElementById('fetch915Btn');
  btn.disabled = true;
  btn.textContent = '⏳ Fetching...';
  document.getElementById('progressBar').style.display = 'block';

  const allTokens = SCREENER_ALL_STOCKS.map(s => s.token);
  const total = allTokens.length;
  let ok = 0, failed = 0;

  const missing = allTokens.filter(t => !SCREENER_CACHED_TOKENS.has(String(t)));

  if (!missing.length) {
    updateProgress(total, total);
    FETCHING = false;
    btn.disabled = false;
    btn.textContent = '⚡ Refresh';
    await loadLTP();
    startLTPRefresh();
    startSSE();
    return;
  }

  updateProgress(total - missing.length, total);

  const alreadyCached = total - missing.length;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);

    try {
      const r = await fetch(API + '/api/screener/fetch-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ tokens: batch })
      });
      const d = await r.json();
      if (d.results) {
        for (const item of d.results) {
          const c = item.candle;
          if (Array.isArray(c) && c.length >= 5) {
            SCREENER_ALL_CANDLES[item.token] = {
              open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
            };
            SCREENER_CACHED_TOKENS.add(String(item.token));
            ok++;
          } else failed++;
        }
      }
    } catch (e) {
      failed += batch.length;
    }

    const done = alreadyCached + i + batch.length;
    recomputeFilteredStocks();
    renderScreenerTable();
    updateProgress(done, total);

    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  FETCHING = false;
  btn.disabled = false;
  btn.textContent = '⚡ Refresh';

  await loadLTP();
  startLTPRefresh();
  startSSE();
}

function updateProgress(done, total) {
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = `${done} / ${total} (${pct}%)`;
}

/* ============================================================
   SECTION 6 — LTP + ORB state (REST poll, 30s backup)
   ============================================================ */
async function loadLTP() {
  const tokens = SCREENER_STOCKS.map(s => s.token);
  if (!tokens.includes(NIFTY50_TOKEN)) tokens.push(NIFTY50_TOKEN);

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
        if (item.token !== NIFTY50_TOKEN) {
          SCREENER_ORB[item.token] = {
            lowBroken: !!item.lowBroken,
            pullbackConfirmed: !!item.pullbackConfirmed,
            entrySignal: !!item.entrySignal,
            newLowAt: item.newLowAt || null,
            pullbackAt: item.pullbackAt || null,
            breakoutAt: item.breakoutAt || null,
            serverTime: item.serverTime || null
          };
        }
      }
    }
    updateNiftyHeader();
    renderScreenerTable();
  } catch (e) { console.error('LTP failed:', e); }
}

function startLTPRefresh() {
  if (SCREENER_LTP_TIMER) clearInterval(SCREENER_LTP_TIMER);
  SCREENER_LTP_TIMER = setInterval(() => loadLTP(), 30000);
}

/* ============================================================
   SECTION 6.1 — SSE real-time LTP push
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
        let any = false;
        let niftyTouched = false;
        for (const [token, price] of Object.entries(msg.ticks)) {
          SCREENER_LTP[token] = price;
          any = true;
          if (token === NIFTY50_TOKEN) niftyTouched = true;
        }
        if (niftyTouched) updateNiftyHeader();
        if (any) renderScreenerTable();
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
   SECTION 7 — ORB STAGE + TIME HELPERS
   ============================================================ */
function resolveOrbStage(token, candle, ltp) {
  const orb = SCREENER_ORB[token] || { lowBroken: false, pullbackConfirmed: false, entrySignal: false };

  if (orb.entrySignal)       return { label: '🎯 ENTRY', color: '#6C5CE7', weight: 700 };
  if (orb.pullbackConfirmed) return { label: '↩️ PULLBACK', color: 'var(--text-secondary)', weight: 600 };
  if (orb.lowBroken)         return { label: '⬇️ LOW BROKEN', color: 'var(--text-secondary)', weight: 600 };
  if (ltp && candle) {
    if (ltp > candle.high) return { label: '⏸️ Above High', color: 'var(--text-muted)', weight: 500 };
    return { label: '⏸️ Inside Range', color: 'var(--text-muted)', weight: 500 };
  }
  return { label: '— waiting —', color: 'var(--text-muted)', weight: 500 };
}

function formatTimeIST(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(11, 19);
  } catch { return '—'; }
}

/* ============================================================
   SECTION 8 — RENDER
   ============================================================ */
function renderScreenerTable() {
  const head = document.getElementById('screenerHead');
  const body = document.getElementById('screenerBody');
  const count = document.getElementById('screenerCount');
  if (!head || !body) return;

  head.innerHTML = `<tr>
    <th>Stock / Company</th>
    <th class="th-sortable" onclick="setSort('ltp')">LTP ${sortIndicator('ltp')}<br>
        <span class="th-sub" onclick="event.stopPropagation();setSort('change')">Change % ${sortIndicator('change')}</span></th>
    <th class="th-sortable" onclick="setSort('range')">9:15 Range (H / L) ${sortIndicator('range')}</th>
    <th>Target / SL</th>
    <th>MAXQTY</th>
    <th>NEW LOW</th>
    <th>PULLBACK</th>
    <th>BREAKOUT</th>
    <th>LAST UPDATE</th>
    <th class="th-sortable" onclick="setSort('stage')">ORB STAGE ${sortIndicator('stage')}</th>
    <th>ACTION</th>
  </tr>`;

  if (!SCREENER_STOCKS.length) {
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:60px;color:var(--text-muted)">
      No stocks match the strategy filter yet.<br>
      Click <strong>⚡ Fetch 9:15 Candles</strong> to load data.
    </td></tr>`;
    if (count) count.textContent = `0 / ${SCREENER_ALL_STOCKS.length} match filter`;
    renderChips();
    return;
  }

  let filtered = SCREENER_STOCKS;
  if (SCREENER_STAGE_FILTER !== 'all') {
    filtered = filtered.filter(s => categorizeStock(s) === SCREENER_STAGE_FILTER);
  }

  const sorted = sortStocks(filtered);

  if (!sorted.length) {
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-muted)">
      No stocks in this category.
    </td></tr>`;
    if (count) count.textContent = `${SCREENER_STOCKS.length} / ${SCREENER_ALL_STOCKS.length} match filter`;
    renderChips();
    return;
  }

  body.innerHTML = sorted.map(s => {
    const c = SCREENER_ALL_CANDLES[s.token];
    const ltp = SCREENER_LTP[s.token];
    const orb = SCREENER_ORB[s.token] || {};

    const sl = c.low;
    const target = c.high * 1.01;
    const risk = ltp ? (ltp - sl) : (c.high - c.low);
    const maxQty = risk > 0 ? Math.floor(PER_TRADE / risk) : '—';
    const stage = resolveOrbStage(s.token, c, ltp);

    const changePct = computeChangePct(s.token);
    let changeLine;
    if (changePct === null) {
      changeLine = '<span style="color:var(--text-muted)">—</span>';
    } else {
      const isPos = changePct >= 0;
      const color = isPos ? 'var(--success)' : 'var(--danger)';
      changeLine = `<span style="color:${color};font-weight:700">${isPos ? '+' : ''}${changePct.toFixed(2)}%</span>`;
    }

    const newLowTime    = formatTimeIST(orb.newLowAt);
    const pullbackTime  = formatTimeIST(orb.pullbackAt);
    const breakoutTime  = formatTimeIST(orb.breakoutAt);
    const lastUpdate    = formatTimeIST(orb.serverTime);

    const rowClass = orb.entrySignal ? 'row-signal' : '';

    return `<tr class="${rowClass}">
      <td><span class="sym">${s.sym}</span><span class="tok">${s.token}</span></td>
      <td style="white-space:nowrap">
        <span class="cell-primary">${ltp ? '₹' + ltp.toFixed(2) : '—'}</span>
        <span class="cell-sub">${changeLine}</span>
      </td>
      <td style="white-space:nowrap">
        <span class="cell-primary" style="color:var(--success)">H: ₹${c.high.toFixed(2)}</span>
        <span class="cell-sub" style="color:var(--danger)">L: ₹${c.low.toFixed(2)}</span>
      </td>
      <td style="white-space:nowrap">
        <span class="cell-primary" style="color:#6C5CE7">T: ₹${target.toFixed(2)}</span>
        <span class="cell-sub" style="color:var(--text-secondary)">SL: ₹${sl.toFixed(2)}</span>
      </td>
      <td style="font-weight:700;color:#6C5CE7">${maxQty}</td>
      <td class="cell-time">${newLowTime}</td>
      <td class="cell-time">${pullbackTime}</td>
      <td class="cell-time">${breakoutTime}</td>
      <td style="color:var(--text-muted);font-size:11px;font-family:ui-monospace,monospace">${lastUpdate}</td>
      <td style="color:${stage.color};font-weight:${stage.weight};font-size:11px">${stage.label}</td>
      <td>${orb.entrySignal
        ? `<button class="btn btn-success btn-sm" onclick="placeOrder('${s.sym}')">Buy</button>`
        : '<span style="color:var(--text-muted);font-size:11px">—</span>'}</td>
    </tr>`;
  }).join('');

  if (count) count.textContent = `${sorted.length} / ${SCREENER_ALL_STOCKS.length} shown`;
  renderChips();
}

/* ============================================================
   SECTION 9 — ORDER PLACEHOLDER
   ============================================================ */
function placeOrder(sym) {
  showToast('📝 Order', `Buy signal for ${sym} — order placement coming soon`);
}

/* ============================================================
   SECTION 10 — HELPERS
   ============================================================ */
function setPill(text, color) {
  const pill = document.getElementById('screenerStatusPill');
  if (!pill) return;
  pill.textContent = text;
  pill.style.color = color || 'var(--text-muted)';
}

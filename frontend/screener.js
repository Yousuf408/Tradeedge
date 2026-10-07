/* ============================================================
   SCREENER.JS  — v2.4
   + Strategy dropdown (Advance ORB / Momentum)
   + Pivot column
   + Manual "Fetch Day H/L/C" button (admin only)
   + Null-safe guards
   ============================================================ */

let SCREENER_ALL_STOCKS = [];
let SCREENER_STOCKS = [];
let SCREENER_ALL_CANDLES = {};
let SCREENER_CACHED_TOKENS = new Set();
let SCREENER_LTP = {};
let SCREENER_PREV_CLOSE = {};
let SCREENER_QUOTE = {};
let SCREENER_PIVOT = {};
let SCREENER_ORB = {};
let SCREENER_INIT_DONE = false;
let SCREENER_LTP_TIMER = null;
let SCREENER_SSE = null;
let FETCHING = false;
let QUOTE_FETCHING = false;
let DAYHLC_FETCHING = false;

let SCREENER_STAGE_FILTER = 'all';
let SCREENER_SORT_BY = 'change';
let SCREENER_SORT_DIR = 'desc';
let SCREENER_ACTIVE_STRATEGY = 'advance_orb';

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

  controls.innerHTML = `
    <select id="strategyDropdown" onchange="onStrategyChange(this.value)"
            style="padding:7px 14px;border:1.5px solid var(--border-soft);border-radius:8px;
                   font-size:13px;font-weight:600;font-family:inherit;
                   background:var(--bg-secondary);color:var(--text-primary);cursor:pointer">
      <option value="advance_orb">🔍 Advance ORB</option>
      <option value="momentum">🚀 Momentum</option>
    </select>
    <button id="fetch915Btn" class="btn btn-primary" onclick="startFetch()">⚡ Fetch 9:15 Candles</button>
    <button id="fetchQuoteBtn" class="btn btn-outline" onclick="startQuoteFetch()">📊 Fetch Quote H/L</button>
    <button id="fetchDayHLCBtn" class="btn btn-outline" onclick="startDayHLCFetch()">📅 Fetch Day H/L/C</button>
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

  const dd = document.getElementById('strategyDropdown');
  if (dd) dd.value = SCREENER_ACTIVE_STRATEGY;

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

function onStrategyChange(value) {
  SCREENER_ACTIVE_STRATEGY = value;
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
   SECTION 3 — FILTER
   ============================================================ */
function passesFilter(candle) {
  if (!candle) return false;
  const rangePct = ((candle.high - candle.low) / candle.low) * 100;
  if (rangePct > STRATEGY_FILTER.maxRangePct) return false;
  if (candle.close < STRATEGY_FILTER.minPrice || candle.close > STRATEGY_FILTER.maxPrice) return false;
  return true;
}

function recomputeFilteredStocks() {
  if (SCREENER_CACHED_TOKENS.size === 0) {
    SCREENER_STOCKS = [...SCREENER_ALL_STOCKS];
    return;
  }
  SCREENER_STOCKS = SCREENER_ALL_STOCKS.filter(s => passesFilter(SCREENER_ALL_CANDLES[s.token]));
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

/* ============================================================
   SECTION 3.2 — NIFTY 50 HEADER
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
   SECTION 3.3 — FAST CELL UPDATE (SSE LTP)
   ============================================================ */
function updateLTPCells(ticks) {
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

    const pivotEl = row.querySelector('.pivot-cell');
    if (pivotEl && SCREENER_PIVOT[token]) {
      const pivot = SCREENER_PIVOT[token];
      const above = (+price) >= pivot;
      const color = above ? 'var(--success)' : 'var(--danger)';
      const arrow = above ? '▲' : '▼';
      pivotEl.innerHTML = `<span style="color:${color};font-weight:700">${arrow} ₹${pivot.toFixed(2)}</span>`;
    }
  }
}

/* ============================================================
   SECTION 3.4 — ORB ROW FAST UPDATE
   ============================================================ */
function updateORBRow(token, state) {
  SCREENER_ORB[token] = {
    lowBroken: state.lowBroken,
    pullbackConfirmed: state.pullbackConfirmed,
    entrySignal: state.entrySignal,
    newLowAt: state.firstLowBreakAt,
    pullbackAt: state.firstPullbackAt,
    breakoutAt: state.firstEntryAt,
    lowBreakPrice: state.firstLowBreakPrice,
    pullbackPrice: state.firstPullbackPrice,
    entryPrice: state.firstEntryPrice,
    targetHit: state.targetHit,
    targetHitAt: state.targetHitAt,
    slHit: state.slHit,
    slHitAt: state.slHitAt
  };

  const row = document.querySelector(`#screenerBody tr[data-token="${token}"]`);
  if (!row) return;

  const nlCell = row.querySelector('.cell-newlow');
  if (nlCell) {
    nlCell.innerHTML = state.lowBroken
      ? renderTimePrice(state.firstLowBreakAt, state.firstLowBreakPrice)
      : '—';
  }

  const pbCell = row.querySelector('.cell-pullback');
  if (pbCell) {
    pbCell.innerHTML = state.pullbackConfirmed
      ? renderTimePrice(state.firstPullbackAt, state.firstPullbackPrice)
      : '—';
  }

  const boCell = row.querySelector('.cell-breakout');
  if (boCell) {
    boCell.innerHTML = state.entrySignal
      ? renderTimePrice(state.firstEntryAt, state.firstEntryPrice)
      : '—';
  }

  const stageCell = row.querySelector('.cell-stage');
  if (stageCell) {
    const stage = resolveOrbStage(token, SCREENER_ALL_CANDLES[token], SCREENER_LTP[token]);
    stageCell.style.color = stage.color;
    stageCell.style.fontWeight = stage.weight;
    stageCell.textContent = stage.label;
  }

  const tslCell = row.querySelector('.cell-targetsl');
  if (tslCell && SCREENER_ALL_CANDLES[token]) {
    tslCell.innerHTML = renderTargetSL(SCREENER_ALL_CANDLES[token], SCREENER_ORB[token]);
  }

  if (state.entrySignal) row.classList.add('row-signal');
  else row.classList.remove('row-signal');

  const actionCell = row.querySelector('.cell-action');
  if (actionCell) {
    const stock = SCREENER_ALL_STOCKS.find(s => String(s.token) === String(token));
    actionCell.innerHTML = state.entrySignal
      ? `<button class="btn btn-success btn-sm" onclick="placeOrder('${stock?.sym || token}')">Buy</button>`
      : '<span style="color:var(--text-muted);font-size:11px">—</span>';
  }
}

function renderTimePrice(isoStr, price) {
  if (!isoStr) return '—';
  const t = formatTimeIST(isoStr);
  const p = (price !== null && price !== undefined) ? '₹' + (+price).toFixed(2) : '';
  return `<span class="cell-time" style="display:block">${t}</span>` +
         (p ? `<span style="display:block;font-size:10px;color:var(--text-muted);font-family:ui-monospace,monospace">${p}</span>` : '');
}

function renderTargetSL(c, orb) {
  const target = c.high * 1.01;
  const sl = c.low;

  let targetLine = `<span class="cell-primary" style="color:#6C5CE7">T: ₹${target.toFixed(2)}</span>`;
  let slLine = `<span class="cell-sub" style="color:var(--text-secondary)">SL: ₹${sl.toFixed(2)}</span>`;

  if (orb?.targetHit) {
    targetLine = `<span class="cell-primary" style="color:var(--success)">T: ₹${target.toFixed(2)} <span style="font-size:13px">✓</span></span>`;
    slLine = `<span class="cell-sub" style="color:var(--text-muted);text-decoration:line-through">SL: ₹${sl.toFixed(2)}</span>`;
  } else if (orb?.slHit) {
    targetLine = `<span class="cell-primary" style="color:var(--text-muted);text-decoration:line-through">T: ₹${target.toFixed(2)}</span>`;
    slLine = `<span class="cell-sub" style="color:var(--danger)">SL: ₹${sl.toFixed(2)} <span style="font-size:13px">✗</span></span>`;
  }

  return targetLine + slLine;
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

    if (d.quotes) {
      for (const [token, q] of Object.entries(d.quotes)) {
        SCREENER_QUOTE[token] = { high: q.high, low: q.low, fetchedAt: q.fetchedAt };
      }
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
   SECTION 5 — FETCH 9:15 (REST)
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
    } catch (e) { failed += batch.length; }

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

/* ============================================================
   SECTION 5.1 — FETCH QUOTE
   ============================================================ */
async function startQuoteFetch() {
  if (QUOTE_FETCHING) return;
  if (!SCREENER_ALL_STOCKS.length) { showToast('⚠️ No stocks', ''); return; }

  QUOTE_FETCHING = true;
  const btn = document.getElementById('fetchQuoteBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Quote fetch...';
  document.getElementById('progressBar').style.display = 'block';

  const allTokens = SCREENER_ALL_STOCKS.map(s => String(s.token));
  const total = allTokens.length;
  let ok = 0, failed = 0;
  const QUOTE_BATCH = 50;

  for (let i = 0; i < allTokens.length; i += QUOTE_BATCH) {
    const batch = allTokens.slice(i, i + QUOTE_BATCH);

    try {
      const r = await fetch(API + '/api/screener/fetch-quote-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ tokens: batch })
      });
      const d = await r.json();
      if (d.results) {
        for (const item of d.results) {
          SCREENER_QUOTE[String(item.token)] = {
            high: item.high,
            low: item.low,
            fetchedAt: d.fetchedAt
          };
          SCREENER_CACHED_TOKENS.add(String(item.token));

          if (!SCREENER_ALL_CANDLES[item.token]) {
            SCREENER_ALL_CANDLES[item.token] = {
              open: item.open || item.low,
              high: item.high,
              low: item.low,
              close: item.close || item.high,
              volume: 0
            };
          }
          ok++;
        }
        failed += (batch.length - (d.results?.length || 0));
      } else {
        failed += batch.length;
      }
    } catch (e) { failed += batch.length; }

    recomputeFilteredStocks();
    renderScreenerTable();
    updateProgress(i + batch.length, total);
  }

  QUOTE_FETCHING = false;
  btn.disabled = false;
  btn.textContent = '📊 Refresh Quote';

  const ts = formatTimeOnly(new Date().toISOString());
  showToast('📊 Quote Done', `${ok} fetched · ${failed} failed · at ${ts} IST`);

  await loadLTP();
  startLTPRefresh();
  startSSE();
}

/* ============================================================
   SECTION 5.2 — MANUAL DAY H/L/C + PIVOT FETCH
   ============================================================ */
async function startDayHLCFetch() {
  const btn = document.getElementById('fetchDayHLCBtn');
  if (!btn) return;
  if (DAYHLC_FETCHING) return;

  const ok = confirm(
    'Fetch day High/Low/Close + Pivot for all stocks now?\n\n' +
    '• Server will call Quote API for all 387 stocks\n' +
    '• Takes ~5–8 seconds\n' +
    '• Overwrites existing day_high/day_low/day_close/pivot\n\n' +
    'Continue?'
  );
  if (!ok) return;

  DAYHLC_FETCHING = true;
  btn.disabled = true;
  btn.textContent = '⏳ Fetching day H/L/C...';

  try {
    const r = await fetch(API + '/api/admin/force-day-hlc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }
    });
    const d = await r.json();

    if (!r.ok) {
      showToast('⚠️ Failed', d.error || `HTTP ${r.status}`);
    } else {
      showToast(
        '✅ Day H/L/C Saved',
        `${d.saved}/${d.total} stocks · ${d.date}`
      );
      await loadLTP();
    }
  } catch (e) {
    showToast('⚠️ Error', e.message);
  }

  DAYHLC_FETCHING = false;
  btn.disabled = false;
  btn.textContent = '📅 Fetch Day H/L/C';
}

function updateProgress(done, total) {
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = `${done} / ${total} (${pct}%)`;
}

/* ============================================================
   SECTION 6 — LTP POLL (30s backup)
   ============================================================ */
async function loadLTP() {
  const tokens = SCREENER_STOCKS.map(s => s.token);
  if (!tokens.includes(NIFTY50_TOKEN)) tokens.push(NIFTY50_TOKEN);
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
        if (item.highQuote) {
          SCREENER_QUOTE[item.token] = {
            high: item.highQuote,
            low: item.lowQuote,
            fetchedAt: item.quoteFetchedAt
          };
        }
        if (item.token !== NIFTY50_TOKEN) {
          SCREENER_ORB[item.token] = {
            lowBroken: !!item.lowBroken,
            pullbackConfirmed: !!item.pullbackConfirmed,
            entrySignal: !!item.entrySignal,
            newLowAt: item.newLowAt || null,
            pullbackAt: item.pullbackAt || null,
            breakoutAt: item.breakoutAt || null,
            lowBreakPrice: item.lowBreakPrice ?? null,
            pullbackPrice: item.pullbackPrice ?? null,
            entryPrice: item.entryPrice ?? null,
            targetHit: !!item.targetHit,
            targetHitAt: item.targetHitAt || null,
            slHit: !!item.slHit,
            slHitAt: item.slHitAt || null,
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
        if (msg.ticks[NIFTY50_TOKEN] !== undefined) {
          SCREENER_LTP[NIFTY50_TOKEN] = msg.ticks[NIFTY50_TOKEN];
          updateNiftyHeader();
        }
        updateLTPCells(msg.ticks);
      }
      else if (msg.type === 'orb' && msg.token && msg.state) {
        updateORBRow(msg.token, msg.state);
      }
      else if (msg.type === 'quote' && msg.quotes) {
        for (const [token, q] of Object.entries(msg.quotes)) {
          SCREENER_QUOTE[token] = { high: q.high, low: q.low, fetchedAt: q.fetchedAt };
        }
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
   SECTION 7 — ORB STAGE RESOLVE
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

/* ============================================================
   SECTION 8 — RENDER
   ============================================================ */
function renderScreenerTable() {
  const head = document.getElementById('screenerHead');
  const body = document.getElementById('screenerBody');
  const count = document.getElementById('screenerCount');
  if (!head || !body) return;

  /* ---- Momentum branch ---- */
  if (SCREENER_ACTIVE_STRATEGY === 'momentum') {
    head.innerHTML = `<tr>
      <th>Stock / Company</th>
      <th>LTP / Chg %</th>
      <th>Pivot</th>
      <th>20 EMA</th>
      <th>9:15 Range (H / L)</th>
      <th>Target / SL</th>
      <th>MAXQTY</th>
      <th>BREAKOUT</th>
      <th>LAST UPDATE</th>
      <th>STAGE</th>
      <th>ACTION</th>
    </tr>`;
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:60px;color:var(--text-muted);line-height:1.9">
      🚀 <strong>Momentum strategy</strong> — columns ready<br>
      <span style="font-size:12px">Logic will be implemented soon.</span>
    </td></tr>`;
    if (count) count.textContent = `Momentum — not active yet`;
    const chips = document.getElementById('stageChips');
    if (chips) chips.style.display = 'none';
    return;
  }

  /* ---- Advance ORB ---- */
  const chipsEl = document.getElementById('stageChips');
  if (chipsEl) chipsEl.style.display = '';

  head.innerHTML = `<tr>
    <th>Stock / Company</th>
    <th class="th-sortable" onclick="setSort('ltp')">LTP ${sortIndicator('ltp')}<br>
        <span class="th-sub" onclick="event.stopPropagation();setSort('change')">Change % ${sortIndicator('change')}</span></th>
    <th>Pivot</th>
    <th class="th-sortable" onclick="setSort('range')">9:15 Range (H / L) ${sortIndicator('range')}</th>
    <th>Quote H / L</th>
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
    body.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:60px;color:var(--text-muted)">
      Loading stocks...<br>
      Click <strong>⚡ Fetch 9:15 Candles</strong> or <strong>📊 Fetch Quote H/L</strong> to load data.
    </td></tr>`;
    if (count) count.textContent = `0 / ${SCREENER_ALL_STOCKS.length}`;
    renderChips();
    return;
  }

  let filtered = SCREENER_STOCKS;
  if (SCREENER_STAGE_FILTER !== 'all') {
    filtered = filtered.filter(s => categorizeStock(s) === SCREENER_STAGE_FILTER);
  }

  const sorted = sortStocks(filtered);

  if (!sorted.length) {
    body.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:40px;color:var(--text-muted)">
      No stocks in this category.
    </td></tr>`;
    if (count) count.textContent = `${SCREENER_STOCKS.length} / ${SCREENER_ALL_STOCKS.length}`;
    renderChips();
    return;
  }

  body.innerHTML = sorted.map(s => {
    const c = SCREENER_ALL_CANDLES[s.token];
    const ltp = SCREENER_LTP[s.token];
    const orb = SCREENER_ORB[s.token] || {};
    const quote = SCREENER_QUOTE[s.token];
    const pivot = SCREENER_PIVOT[s.token];

    const sl = c ? c.low : null;
    const high = c ? c.high : null;
    const target = high ? high * 1.01 : null;
    const risk = (ltp && sl) ? (ltp - sl) : 0;
    const maxQty = risk > 0 ? Math.floor(PER_TRADE / risk) : '—';
    const stage = c
      ? resolveOrbStage(s.token, c, ltp)
      : { label: '⏸️ No 9:15 data', color: 'var(--text-muted)', weight: 500 };

    const changePct = computeChangePct(s.token);
    let changeLine;
    if (changePct === null) {
      changeLine = '<span style="color:var(--text-muted)">—</span>';
    } else {
      const isPos = changePct >= 0;
      const color = isPos ? 'var(--success)' : 'var(--danger)';
      changeLine = `<span style="color:${color};font-weight:700">${isPos ? '+' : ''}${changePct.toFixed(2)}%</span>`;
    }

    let pivotCell;
    if (pivot) {
      const above = ltp ? (+ltp >= pivot) : null;
      if (above === null) {
        pivotCell = `<span style="color:var(--text-muted)">₹${pivot.toFixed(2)}</span>`;
      } else {
        const color = above ? 'var(--success)' : 'var(--danger)';
        const arrow = above ? '▲' : '▼';
        pivotCell = `<span style="color:${color};font-weight:700">${arrow} ₹${pivot.toFixed(2)}</span>`;
      }
    } else {
      pivotCell = '<span style="color:var(--text-muted)">—</span>';
    }

    let quoteCell;
    if (quote) {
      const qt = formatTimeOnly(quote.fetchedAt);
      quoteCell = `
        <span class="cell-primary" style="color:var(--success)">H: ₹${(+quote.high).toFixed(2)}</span>
        <span class="cell-sub" style="color:var(--danger)">L: ₹${(+quote.low).toFixed(2)}</span>
        <span style="display:block;font-size:9px;color:var(--text-muted);margin-top:2px;font-family:ui-monospace,monospace">${qt}</span>`;
    } else {
      quoteCell = '<span style="color:var(--text-muted)">—</span>';
    }

    const newLowCell   = (c && orb.lowBroken) ? renderTimePrice(orb.newLowAt, orb.lowBreakPrice) : '—';
    const pullbackCell = (c && orb.pullbackConfirmed) ? renderTimePrice(orb.pullbackAt, orb.pullbackPrice) : '—';
    const breakoutCell = (c && orb.entrySignal) ? renderTimePrice(orb.breakoutAt, orb.entryPrice) : '—';

    const lastUpdate = formatTimeIST(orb.serverTime);
    const rowClass = orb.entrySignal ? 'row-signal' : '';

    return `<tr class="${rowClass}" data-token="${s.token}">
      <td><span class="sym">${s.sym}</span><span class="tok">${s.token}</span></td>
      <td style="white-space:nowrap">
        <span class="cell-primary ltp-cell">${ltp ? '₹' + (+ltp).toFixed(2) : '—'}</span>
        <span class="cell-sub change-cell">${changeLine}</span>
      </td>
      <td class="pivot-cell" style="white-space:nowrap">${pivotCell}</td>
      <td style="white-space:nowrap">
        ${c ? `<span class="cell-primary" style="color:var(--success)">H: ₹${c.high.toFixed(2)}</span>
               <span class="cell-sub" style="color:var(--danger)">L: ₹${c.low.toFixed(2)}</span>`
            : '<span style="color:var(--text-muted)">—</span>'}
      </td>
      <td style="white-space:nowrap">${quoteCell}</td>
      <td style="white-space:nowrap" class="cell-targetsl">${c ? renderTargetSL(c, orb) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-weight:700;color:#6C5CE7">${maxQty}</td>
      <td class="cell-newlow">${newLowCell}</td>
      <td class="cell-pullback">${pullbackCell}</td>
      <td class="cell-breakout">${breakoutCell}</td>
      <td style="color:var(--text-muted);font-size:11px;font-family:ui-monospace,monospace">${lastUpdate}</td>
      <td class="cell-stage" style="color:${stage.color};font-weight:${stage.weight};font-size:11px">${stage.label}</td>
      <td class="cell-action">${orb.entrySignal
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

/* ============================================================
   APP.JS
   Settings + Theme toggle  (Portfolio page REMOVED 2026-10-13 → Orders page use karo)
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
   SECTION 2 — PORTFOLIO (REMOVED)
   Page hat gayi hai (Orders page replace karta hai).
   No-op stub rakha hai taaki kahin se purana call aaye to error na aaye.
   ============================================================ */
function loadPortfolio() { /* removed — no-op */ }


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

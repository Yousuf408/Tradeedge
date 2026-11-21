/* ============================================================
   APP.JS
   Settings + Theme toggle
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
   ============================================================ */
function loadPortfolio() { /* removed — no-op */ }

/* ============================================================
   SECTION 3 — SETTINGS: BROKER FIELDS TOGGLE
   ============================================================ */
function toggleBrokerFields() {
  const b = document.getElementById('brokerSelect').value;
  
  // Show/Hide Dhan fields
  const dhanDiv = document.getElementById('dhanFields');
  if (dhanDiv) dhanDiv.style.display = (b === 'dhan') ? 'grid' : 'none';
  
  // Show/Hide Kotak fields
  const kotakDiv = document.getElementById('kotakFields');
  if (kotakDiv) kotakDiv.style.display = (b === 'kotak') ? 'grid' : 'none';
  
  // Show/Hide Other fields
  const otherDiv = document.getElementById('otherBrokerFields');
  if (otherDiv) otherDiv.style.display = (b && b !== 'dhan' && b !== 'kotak') ? 'block' : 'none';
}

async function saveBrokerDetails() {
  const broker = document.getElementById('brokerSelect').value;
  if (!broker) return showToast('⚠️ Error', 'Please select a broker first');

  let payload = { broker };

  if (broker === 'kotak') {
    payload.client_id = document.getElementById('kotakUcc').value;
    payload.user_api_key = document.getElementById('kotakApiKey').value;
    payload.totp_secret = document.getElementById('kotakTotpSecret').value;
    payload.mpin = document.getElementById('kotakMpin').value;
    
    if (!payload.client_id || !payload.user_api_key || !payload.totp_secret || !payload.mpin) {
      return showToast('⚠️ Missing Fields', 'Please fill all Kotak details');
    }
  } else {
    return showToast('⚠️ Not Supported', 'Only Kotak is implemented for saving right now');
  }

  try {
    // API and getToken() are defined in screener.js, which loads before app.js
    const res = await fetch(API + '/api/user/broker-credentials', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getToken()
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    
    if (data.success) {
      showToast('✅ Saved', 'Broker details saved successfully');
    } else {
      showToast('❌ Error', data.error || 'Failed to save');
    }
  } catch (err) {
    showToast('❌ Error', 'Network error');
  }
}

/* ============================================================
   SECTION 4 — INIT
   ============================================================ */
toggleBrokerFields();

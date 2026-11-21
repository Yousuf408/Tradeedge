/* ============================================================
   SECTION 3 — SETTINGS: BROKER FIELDS TOGGLE
   ============================================================ */
function toggleBrokerFields() {
  const b = document.getElementById('brokerSelect').value;
  
  // Show/Hide Dhan fields
  document.getElementById('dhanFields').style.display = (b === 'dhan') ? 'grid' : 'none';
  
  // Show/Hide Kotak fields
  const kotakDiv = document.getElementById('kotakFields');
  if (kotakDiv) kotakDiv.style.display = (b === 'kotak') ? 'grid' : 'none';
  
  // Show/Hide Other fields
  const otherDiv = document.getElementById('otherBrokerFields');
  if (otherDiv) otherDiv.style.display = (b && b !== 'dhan' && b !== 'kotak') ? 'block' : 'none';
}

// ADD THIS NEW FUNCTION at the bottom of app.js
async function saveBrokerDetails() {
  const broker = document.getElementById('brokerSelect').value;
  if (!broker) return showToast('⚠️ Error', 'Please select a broker first');

  let payload = { broker };

  if (broker === 'kotak') {
    payload.client_id = document.getElementById('kotakUcc').value;
    payload.user_api_key = document.getElementById('kotakApiKey').value;
    payload.totp_secret = document.getElementById('kotakTotpSecret').value;
    payload.mpin = document.getElementById('kotakMpin').value;
    
    // We also need the mobile number, but we can store it in a generic field if needed.
    // For now, let's assume client_id is UCC.
    if (!payload.client_id || !payload.user_api_key || !payload.totp_secret || !payload.mpin) {
      return showToast('⚠️ Missing Fields', 'Please fill all Kotak details');
    }
  } else {
    return showToast('⚠️ Not Supported', 'Only Kotak is implemented for saving right now');
  }

  try {
    const res = await fetch(API + '/api/user/broker-credentials', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getToken() // Uses your existing getToken()
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

/* ============================================================
   Kotak_Auth.js — Multi-User Authentication for Kotak Neo
   ============================================================
   Flow:
   1. Generate TOTP from user's secret using Node's built-in crypto.
   2. Login (Get View Token).
   3. Validate MPIN (Get Trading Token).
   4. Store session in a Map isolated by userId.
   ============================================================ */

import crypto from 'crypto';

// In-memory session store: Map<userId, { token, sid, baseUrl, lastLogin }>
const kotakSessions = new Map();

/**
 * Generate a 6-digit TOTP code from a Base32 secret.
 * (RFC 6238 standard - no external packages required)
 */
function generateTOTP(secret) {
  // Decode Base32 secret
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  secret = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  
  for (let i = 0; i < secret.length; i++) {
    const val = base32chars.indexOf(secret.charAt(i));
    if (val === -1) throw new Error('Invalid Base32 character in TOTP secret');
    bits += val.toString(2).padStart(5, '0');
  }
  
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  // Calculate time step (30 seconds)
  const epoch = Math.round(new Date().getTime() / 1000.0);
  const time = Math.floor(epoch / 30);
  
  // Create buffer for time
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(time, 4);

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const hmacResult = hmac.digest();

  // Dynamic truncation
  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  return (code % 1000000).toString().padStart(6, '0');
}

/**
 * Main Login Function
 * @param {string} userId - Unique ID of the user in your system
 * @param {Object} creds - { apiKey, mobile, ucc, totpSecret, mpin }
 */
export async function loginKotak(userId, creds) {
  try {
    const totp = generateTOTP(creds.totpSecret);

    // --- Step 2A: Login with TOTP ---
    const loginRes = await fetch('https://mis.kotaksecurities.com/login/1.0/tradeApiLogin', {
      method: 'POST',
      headers: {
        'Authorization': creds.apiKey,
        'neo-fin-key': 'neotradeapi',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mobileNumber: creds.mobile,
        ucc: creds.ucc,
        totp: totp
      })
    });

    const loginData = await loginRes.json();
    if (loginData.data?.status !== 'success') {
      throw new Error(`Login Failed: ${JSON.stringify(loginData)}`);
    }

    const viewToken = loginData.data.token;
    const viewSid = loginData.data.sid;

    // --- Step 2B: Validate with MPIN ---
    const validateRes = await fetch('https://mis.kotaksecurities.com/login/1.0/tradeApiValidate', {
      method: 'POST',
      headers: {
        'Authorization': creds.apiKey,
        'sid': viewSid,
        'Auth': viewToken,
        'neo-fin-key': 'neotradeapi',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mpin: creds.mpin
      })
    });

    const validateData = await validateRes.json();
    if (validateData.data?.status !== 'success') {
      throw new Error(`MPIN Validation Failed: ${JSON.stringify(validateData)}`);
    }

    // --- Save Session for this specific User ---
    const session = {
      token: validateData.data.token,
      sid: validateData.data.sid,
      baseUrl: validateData.data.baseUrl,
      lastLogin: Date.now()
    };

    kotakSessions.set(userId, session);
    console.log(`✅ [Kotak] Logged in successfully for User: ${userId}`);
    
    return { success: true, session };

  } catch (error) {
    console.error(`❌ [Kotak] Login Error for User ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get active session for a user.
 * If session doesn't exist or is older than 12 hours, it returns null.
 */
export function getKotakSession(userId) {
  const session = kotakSessions.get(userId);
  if (!session) return null;
  
  // Kotak sessions typically expire in 24h, we'll refresh if older than 12h
  if (Date.now() - session.lastLogin > 12 * 60 * 60 * 1000) {
    kotakSessions.delete(userId);
    return null;
  }
  
  return session;
}

/**
 * Clear session (Logout)
 */
export function logoutKotak(userId) {
  kotakSessions.delete(userId);
}

/* ============================================================
   admin.js — Admin + Auth + Users + Triggers
   Ek jagah saara admin/user related kaam.
   server.js se sirf deps lega, kuch bhi wapas import nahi.
   ============================================================ */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export function registerAdminRoutes(app, deps) {
  const {
    db, SECRET,
    auth, adminOnly, log,
    getIST, getPreviousTradingDay, getScreenerPhase,
    STOCKS, bsCache,
    fetchDayHLC, autoFetchBS,
    fetchPreopenRaw, parsePreopen,
    fetchPrevDayClosesEOD, computeRSI,
    getPrevDayLastClosesBatch,
    loadHolidaysFromDB
  } = deps;

  /* ============================================================
     TOTP HELPERS (local to admin)
     ============================================================ */
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(str) {
    str = str.toUpperCase().replace(/=+$/, '');
    let bits = '';
    for (const c of str) {
      const v = B32.indexOf(c);
      if (v === -1) continue;
      bits += v.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
  }

  function totpAt(secret, counter) {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(counter, 4);
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(buf);
    const sig = hmac.digest();
    const off = sig[sig.length - 1] & 0x0f;
    const code = ((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16)
               | ((sig[off + 2] & 0xff) << 8)  | (sig[off + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  }

  function verifyTotpServer(secret, input) {
    const step = Math.floor(Date.now() / 1000 / 30);
    return [step - 1, step, step + 1].some(c => totpAt(secret, c) === input);
  }

  /* ============================================================
     USER HELPERS (local to admin)
     ============================================================ */
  async function generateUsername(fullName, mobile) {
    const first = (fullName || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const last4 = (mobile || '').replace(/\D/g, '').slice(-4);
    const base = (first || 'user') + last4;
    let candidate = base, i = 1;
    while (true) {
      const { rows } = await db.query('SELECT 1 FROM users WHERE username=$1', [candidate]);
      if (!rows.length) return candidate;
      candidate = base + i++;
    }
  }

  const generatePassword = (fullName, mobile) => {
    const first = (fullName || '').trim().split(/\s+/)[0] || 'User';
    const base = (first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()).replace(/[^A-Za-z]/g, '') || 'User';
    const last4 = (mobile || '').replace(/\D/g, '').slice(-4) || '0000';
    const sp = '!#%&*'[crypto.randomInt(5)];
    const rand = crypto.randomBytes(3).toString('hex').slice(0, 4);
    return `${base}@${last4}${sp}${rand}`;
  };

  /* ============================================================
     ROOT
     ============================================================ */
  app.get('/', (req, res) => res.json({ ok: true, service: 'tradealgo-backend', mode: 'dual-rest-quote-bs' }));

  /* ============================================================
     AUTH
     ============================================================ */
  app.post('/api/login', async (req, res) => {
    const { input, password } = req.body;
    const clean = (input || '').trim().toLowerCase();
    if (!clean || !password) return res.status(400).json({ error: 'Missing fields' });

    const digits = clean.replace(/\D/g, '');
    const { rows } = await db.query(
      "SELECT * FROM users WHERE username=$1 OR (mobile=$2 AND $2 <> '')",
      [clean, digits.length >= 10 ? digits : '__none__']
    );
    const user = rows[0];
    const lockKey = user?.username || clean;

    const lock = await db.query('SELECT * FROM login_attempts WHERE username=$1', [lockKey]);
    if (lock.rows[0]?.locked_until > new Date()) {
      const mins = Math.ceil((new Date(lock.rows[0].locked_until) - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many attempts. Try in ${mins} min.` });
    }

    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      const c = (lock.rows[0]?.count || 0) + 1;
      if (c >= 3) {
        await db.query("INSERT INTO login_attempts (username, count, locked_until) VALUES ($1,0,NOW()+INTERVAL '15 minutes') ON CONFLICT (username) DO UPDATE SET count=0, locked_until=NOW()+INTERVAL '15 minutes'", [lockKey]);
      } else {
        await db.query("INSERT INTO login_attempts (username, count) VALUES ($1,$2) ON CONFLICT (username) DO UPDATE SET count=$2", [lockKey, c]);
      }
      await log(lockKey, 'LOGIN_FAILED', `Input: ${clean}`, 'danger');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await db.query('DELETE FROM login_attempts WHERE username=$1', [lockKey]);

    if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
    if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Subscription expired', expired: true, expiresAt: user.expires_at });
    }

    const pendingToken = jwt.sign({ username: user.username, purpose: 'login-pending' }, SECRET, { expiresIn: '5m' });
    res.json({
      ok: true, pendingToken, username: user.username, name: user.name,
      needsSetup: !user.totp_secret, hasTotp: !!user.totp_secret
    });
  });

  app.post('/api/complete-login', async (req, res) => {
    const { pendingToken, totpCode, totpSecret } = req.body;
    if (!pendingToken) return res.status(400).json({ error: 'Missing session token' });

    let payload;
    try { payload = jwt.verify(pendingToken, SECRET); }
    catch { return res.status(401).json({ error: 'Login session expired. Please sign in again.' }); }
    if (payload.purpose !== 'login-pending') return res.status(401).json({ error: 'Invalid session' });

    const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [payload.username]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
    if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Subscription expired', expired: true, expiresAt: user.expires_at });
    }

    const code = String(totpCode || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter a 6-digit code' });

    if (!user.totp_secret) {
      if (!totpSecret || typeof totpSecret !== 'string') return res.status(400).json({ error: 'TOTP secret required for setup' });
      if (!verifyTotpServer(totpSecret, code)) {
        await log(user.username, 'TOTP_SETUP_FAILED', 'Bad code during setup', 'danger');
        return res.status(401).json({ error: 'Code did not match. Check your authenticator app.' });
      }
      await db.query('UPDATE users SET totp_secret=$1 WHERE username=$2', [totpSecret, user.username]);
      await log(user.username, 'TOTP_ENABLED', `User: ${user.username}`, 'success');
    } else {
      if (!verifyTotpServer(user.totp_secret, code)) {
        await log(user.username, 'LOGIN_TOTP_FAILED', 'Bad TOTP code', 'danger');
        return res.status(401).json({ error: 'Invalid code' });
      }
    }

    const sessionId = crypto.randomUUID();
    await db.query('UPDATE users SET session_id=$1, last_active=NOW() WHERE username=$2', [sessionId, user.username]);
    const token = jwt.sign({ username: user.username, role: user.role, sessionId }, SECRET, { expiresIn: '7h' });
    await log(user.username, 'LOGIN_SUCCESS', `User: ${user.username}`, 'success');

    res.json({
      ok: true, token,
      user: { name: user.name, username: user.username, role: user.role, plan: user.plan, expiresAt: user.expires_at, mobile: user.mobile, sessionId }
    });
  });

  app.get('/api/session-check', auth, async (req, res) => {
    const { rows } = await db.query('SELECT session_id, disabled, role, expires_at FROM users WHERE username=$1', [req.user.username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User gone' });
    if (user.disabled) return res.status(401).json({ error: 'Disabled' });
    if (user.session_id !== req.user.sessionId) return res.status(401).json({ error: 'Logged in elsewhere' });
    if (user.role !== 'admin' && user.expires_at && new Date(user.expires_at) < new Date()) return res.status(401).json({ error: 'Expired' });
    res.json({ ok: true });
  });

  app.post('/api/logout', auth, async (req, res) => {
    await log(req.user.username, 'LOGOUT', `User: ${req.user.username}`, 'info');
    res.json({ ok: true });
  });

  /* ============================================================
     FORGOT PASSWORD
     ============================================================ */
  app.post('/api/forgot-password/check', async (req, res) => {
    const { input } = req.body;
    const clean = (input || '').trim().toLowerCase();
    if (!clean) return res.status(400).json({ error: 'Enter username or mobile' });

    const digits = clean.replace(/\D/g, '');
    const { rows } = await db.query(
      "SELECT username, name, totp_secret, disabled FROM users WHERE username=$1 OR (mobile=$2 AND $2 <> '')",
      [clean, digits.length >= 10 ? digits : '__none__']
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'No account found' });
    if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
    if (!user.totp_secret) return res.status(400).json({ error: 'No 2FA set up' });
    res.json({ ok: true, username: user.username, name: user.name });
  });

  app.post('/api/forgot-password/reset', async (req, res) => {
    const { input, totpCode, newPassword } = req.body;
    const clean = (input || '').trim().toLowerCase();
    if (!clean || !totpCode || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

    const digits = clean.replace(/\D/g, '');
    const { rows } = await db.query(
      "SELECT * FROM users WHERE username=$1 OR (mobile=$2 AND $2 <> '')",
      [clean, digits.length >= 10 ? digits : '__none__']
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'No account found' });
    if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
    if (!user.totp_secret) return res.status(400).json({ error: 'No 2FA set up' });

    if (!verifyTotpServer(user.totp_secret, String(totpCode).trim())) {
      await log(user.username, 'FORGOT_PASSWORD_FAILED', 'Bad TOTP', 'danger');
      return res.status(401).json({ error: 'Invalid code' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash=$1, session_id=NULL WHERE username=$2', [hash, user.username]);
    await log(user.username, 'PASSWORD_RESET_SELF', `User: ${user.username}`, 'warn');
    res.json({ ok: true });
  });

  /* ============================================================
     CHANGE PASSWORD + PROFILE
     ============================================================ */
  app.post('/api/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });

    const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [req.user.username]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!await bcrypt.compare(currentPassword, user.password_hash)) {
      await log(req.user.username, 'PASSWORD_CHANGE_FAILED', 'Wrong current password', 'danger');
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const newSessionId = crypto.randomUUID();
    await db.query('UPDATE users SET password_hash=$1, session_id=$2 WHERE username=$3', [hash, newSessionId, req.user.username]);
    const token = jwt.sign({ username: user.username, role: user.role, sessionId: newSessionId }, SECRET, { expiresIn: '7h' });
    await log(req.user.username, 'PASSWORD_CHANGED', `User: ${req.user.username}`, 'success');
    res.json({ ok: true, token, sessionId: newSessionId });
  });

  app.put('/api/me', auth, async (req, res) => {
    const { name, mobile } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const cleanMobile = (mobile || '').replace(/\D/g, '') || null;
    try {
      if (cleanMobile) {
        const dup = await db.query('SELECT username FROM users WHERE mobile=$1 AND username<>$2', [cleanMobile, req.user.username]);
        if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
      }
      await db.query('UPDATE users SET name=$1, mobile=$2 WHERE username=$3', [name.trim(), cleanMobile, req.user.username]);
      await log(req.user.username, 'PROFILE_UPDATED', `User: ${req.user.username}`, 'success');
      res.json({ ok: true, name: name.trim(), mobile: cleanMobile });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ============================================================
     USERS CRUD
     ============================================================ */
  app.get('/api/users', auth, adminOnly, async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, name, username, mobile, role, plan, expires_at AS "expiresAt",
              disabled, last_active AS "lastActive", created_at AS "createdAt"
       FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  });

  app.post('/api/users', auth, adminOnly, async (req, res) => {
    let { name, mobile, password, plan, expiresAt } = req.body;
    if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile required' });
    const cleanMobile = String(mobile).replace(/\D/g, '');
    if (cleanMobile.length < 10) return res.status(400).json({ error: 'Mobile must be 10 digits' });

    const username = await generateUsername(name, cleanMobile);
    if (!password) password = generatePassword(name, cleanMobile);
    const hash = await bcrypt.hash(password, 10);

    try {
      await db.query(
        `INSERT INTO users (name, username, mobile, password_hash, plan, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [name.trim(), username, cleanMobile, hash, plan || 'Demo', expiresAt]
      );
      await log(req.user.username, 'USER_CREATED', `${name} (@${username})`, 'success');
      res.json({ ok: true, username, password, mobile: cleanMobile });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Mobile already registered' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/users/:username', auth, adminOnly, async (req, res) => {
    const target = req.params.username;
    const { name, mobile, plan, role } = req.body;
    const existing = await db.query('SELECT username FROM users WHERE username=$1', [target]);
    if (!existing.rows.length) return res.status(404).json({ error: 'User not found' });

    const cleanMobile = mobile ? String(mobile).replace(/\D/g, '') : null;
    try {
      if (cleanMobile) {
        const dup = await db.query('SELECT username FROM users WHERE mobile=$1 AND username<>$2', [cleanMobile, target]);
        if (dup.rows.length) return res.status(409).json({ error: 'Mobile already in use' });
      }
      await db.query('UPDATE users SET name=$1, mobile=$2, plan=$3, role=$4 WHERE username=$5', [name, cleanMobile, plan, role, target]);
      await log(req.user.username, 'USER_UPDATED', `${target}`, 'success');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/users/:username/renew', auth, adminOnly, async (req, res) => {
    const { days } = req.body;
    await db.query(
      `UPDATE users SET expires_at = GREATEST(COALESCE(expires_at, CURRENT_DATE), CURRENT_DATE) + ($1 || ' days')::interval WHERE username=$2`,
      [days, req.params.username]
    );
    await log(req.user.username, 'USER_RENEWED', `${req.params.username} ${days > 0 ? '+' : ''}${days}d`, 'success');
    res.json({ ok: true });
  });

  app.post('/api/users/:username/set-expiry', auth, adminOnly, async (req, res) => {
    const { expiresAt } = req.body;
    if (!expiresAt) return res.status(400).json({ error: 'expiresAt required' });
    await db.query('UPDATE users SET expires_at=$1 WHERE username=$2', [expiresAt, req.params.username]);
    await log(req.user.username, 'USER_EXPIRY_SET', `${req.params.username} → ${expiresAt}`, 'success');
    res.json({ ok: true });
  });

  app.post('/api/users/:username/reset', auth, adminOnly, async (req, res) => {
    const { rows } = await db.query('SELECT name, mobile FROM users WHERE username=$1', [req.params.username]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const temp = generatePassword(u.name, u.mobile || '0000');
    const hash = await bcrypt.hash(temp, 10);
    await db.query('UPDATE users SET password_hash=$1, totp_secret=NULL, session_id=NULL WHERE username=$2', [hash, req.params.username]);
    await log(req.user.username, 'PASSWORD_RESET', req.params.username, 'warn');
    res.json({ ok: true, temp });
  });

  app.post('/api/users/:username/disable', auth, adminOnly, async (req, res) => {
    await db.query('UPDATE users SET disabled = NOT disabled, session_id = NULL WHERE username=$1', [req.params.username]);
    res.json({ ok: true });
  });

  app.delete('/api/users/:username', auth, adminOnly, async (req, res) => {
    await db.query('DELETE FROM users WHERE username=$1', [req.params.username]);
    await log(req.user.username, 'USER_DELETED', req.params.username, 'danger');
    res.json({ ok: true });
  });

  /* ============================================================
     AUDIT + PRICES
     ============================================================ */
  app.get('/api/audit', auth, adminOnly, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  });

  app.delete('/api/audit', auth, adminOnly, async (req, res) => {
    await db.query('DELETE FROM audit_log');
    res.json({ ok: true });
  });

  app.get('/api/prices', auth, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM prices');
    const out = {};
    rows.forEach(r => out[r.plan] = r.amount);
    res.json(out);
  });

  app.put('/api/prices', auth, adminOnly, async (req, res) => {
    const { Demo, Pro } = req.body;
    await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Demo || 0, 'Demo']);
    await db.query('UPDATE prices SET amount=$1 WHERE plan=$2', [Pro || 0, 'Pro']);
    res.json({ ok: true });
  });

  /* ============================================================
     TRADING HOLIDAYS
     ============================================================ */
  app.get('/api/admin/holidays', auth, adminOnly, async (req, res) => {
    const { rows } = await db.query('SELECT date::text AS date, reason FROM trading_holidays ORDER BY date ASC');
    res.json(rows);
  });

  app.post('/api/admin/holidays', auth, adminOnly, async (req, res) => {
    const { date, reason } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    try {
      await db.query(
        'INSERT INTO trading_holidays (date, reason) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET reason=EXCLUDED.reason',
        [date, reason || null]
      );
      await loadHolidaysFromDB();
      await log(req.user.username, 'HOLIDAY_ADDED', `${date} — ${reason || ''}`, 'success');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/holidays/:date', auth, adminOnly, async (req, res) => {
    try {
      await db.query('DELETE FROM trading_holidays WHERE date=$1', [req.params.date]);
      await loadHolidaysFromDB();
      await log(req.user.username, 'HOLIDAY_REMOVED', req.params.date, 'warn');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ============================================================
     ADMIN TRIGGERS
     ============================================================ */

  /* Force Day H/L/C */
  app.post('/api/admin/force-day-hlc', auth, adminOnly, async (req, res) => {
    try {
      await fetchDayHLC();
      const p = getScreenerPhase();
      const { rows } = await db.query(
        `SELECT COUNT(*) AS cnt FROM angel_15m_candle WHERE date=$1 AND day_high IS NOT NULL`,
        [p.date]
      );
      res.json({ ok: true, date: p.date, saved: +rows[0].cnt, total: STOCKS.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* Force Buy/Sell */
  app.post('/api/admin/force-bs', auth, adminOnly, async (req, res) => {
    try {
      await autoFetchBS();
      const p = getScreenerPhase();
      const { rows } = await db.query(
        `SELECT COUNT(*) AS cnt FROM strategy_bs_snapshot
         WHERE date=$1 AND strategy_id=$2 AND buy_qty IS NOT NULL`,
        [p.date, 'momentum']
      );
      res.json({ ok: true, date: p.date, saved: +rows[0].cnt, total: STOCKS.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* Force Pre-Open */
  app.post('/api/admin/fetch-preopen', auth, adminOnly, async (req, res) => {
    try {
      const json = await fetchPreopenRaw();
      const { matched, unmatchedSyms, nseTotal } = parsePreopen(json);
      const fetchedAt = new Date();
      const p = getScreenerPhase();
      const dbErrors = [];

      for (const m of matched) {
        const existing = bsCache.get(m.token) || {};
        bsCache.set(m.token, {
          buyQty: existing.buyQty ?? null,
          sellQty: existing.sellQty ?? null,
          ltp: existing.ltp ?? null,
          volume: existing.volume ?? null,
          rank: existing.rank ?? null,
          preopenPrice: m.price,
          preopenAt: fetchedAt,
          dayOpen: existing.dayOpen ?? null,
          rsi: existing.rsi ?? null
        });

        if (p.date) {
          try {
            await db.query(
              `UPDATE strategy_bs_snapshot SET preopen_price=$1, preopen_at=$2
               WHERE date=$3 AND token=$4 AND strategy_id=$5`,
              [m.price, fetchedAt, p.date, m.token, 'momentum']
            );
          } catch (e) { dbErrors.push(`${m.sym}: ${e.message}`); }
        }
      }

      console.log(`🌅 Preopen fetch: NSE=${nseTotal}, matched=${matched.length}, unmatched=${unmatchedSyms.length}`);
      if (unmatchedSyms.length) console.log(`🌅 Unmatched (first 20): ${unmatchedSyms.slice(0, 20).join(', ')}`);
      if (dbErrors.length) console.log(`❌ Preopen DB errors (first 5):`, dbErrors.slice(0, 5));

      res.json({
        ok: true, date: p.date, nseTotal,
        matched: matched.length,
        unmatchedCount: unmatchedSyms.length,
        unmatchedSample: unmatchedSyms.slice(0, 30),
        dbErrors: dbErrors.slice(0, 5),
        fetchedAt
      });
    } catch (e) {
      console.error('Preopen fetch failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /* Force EOD Closes (today) */
  app.post('/api/admin/force-eod-closes', auth, adminOnly, async (req, res) => {
    try {
      await fetchPrevDayClosesEOD();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* Force EOD Closes (specific date) */
  app.post('/api/admin/force-eod-closes-date', auth, adminOnly, async (req, res) => {
    try {
      const date = req.body?.date || req.query?.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
      }
      const onlyMissing = req.body?.onlyMissing !== false && req.query?.onlyMissing !== 'false';

      let tokensToFetch = STOCKS.map(s => String(s.token));
      if (onlyMissing) {
        const { rows } = await db.query(
          `SELECT token FROM strategy_bs_snapshot
           WHERE date=$1 AND strategy_id='momentum' AND min_1_close IS NOT NULL`,
          [date]
        );
        const saved = new Set(rows.map(r => String(r.token)));
        tokensToFetch = tokensToFetch.filter(t => !saved.has(t));
      }

      console.log(`📈 EOD[${date}]: fetching ${tokensToFetch.length} tokens (onlyMissing=${onlyMissing})...`);
      const t0 = Date.now();
      const data = await getPrevDayLastClosesBatch(tokensToFetch, date, 20);
      let saved = 0;

      for (const [token, candles] of data) {
        const closes = candles.map(c => c.close);
        const ts = candles.map(c => c.ts);
        try {
          await db.query(
            `UPDATE strategy_bs_snapshot SET min_1_close=$1, min_1_ts=$2
             WHERE date=$3 AND token=$4 AND strategy_id='momentum'`,
            [closes, ts, date, token]
          );
          saved++;
        } catch {}
      }
      console.log(`✅ EOD[${date}]: saved ${saved}/${tokensToFetch.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
      res.json({ ok: true, date, requested: tokensToFetch.length, saved, elapsedSec: Math.round((Date.now() - t0) / 1000) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* Compute RSI (auto-detect latest date) */
  app.post('/api/admin/compute-rsi', auth, adminOnly, async (req, res) => {
    try {
      const dateParam = req.body?.date || req.query?.date;
      let targetDate = dateParam;

      if (!targetDate) {
        const { rows } = await db.query(
          `SELECT date::text AS d FROM strategy_bs_snapshot
           WHERE strategy_id='momentum' AND min_1_close IS NOT NULL
           ORDER BY date DESC LIMIT 1`
        );
        if (!rows.length) return res.json({ ok: false, error: 'No min_1_close data found' });
        targetDate = rows[0].d;
      }

      const { rows: dataRows } = await db.query(
        `SELECT token, sym, min_1_close FROM strategy_bs_snapshot
         WHERE date=$1 AND strategy_id='momentum' AND min_1_close IS NOT NULL`,
        [targetDate]
      );

      const out = [];
      for (const r of dataRows) {
        const closes = r.min_1_close.map(Number);
        if (closes.length < 14) continue;
        const prev13 = closes.slice(-14, -1);
        const current = closes[closes.length - 1];
        const rsi = computeRSI(prev13, current);
        if (rsi == null) continue;
        const v = +rsi.toFixed(2);
        try {
          await db.query(
            `UPDATE strategy_bs_snapshot SET rsi=$1
             WHERE date=$2 AND token=$3 AND strategy_id='momentum'`,
            [v, targetDate, r.token]
          );
        } catch {}
        out.push({ sym: r.sym, rsi: v });
      }

      out.sort((a, b) => b.rsi - a.rsi);
      console.log(`🧪 Compute-RSI: ${out.length} saved for ${targetDate}`);
      res.json({ ok: true, date: targetDate, count: out.length, top10: out.slice(0, 10), bottom10: out.slice(-10) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

const TELESOM_CONFIG = {
  senderID: process.env.TELESOM_SENDER_ID,
  username: process.env.TELESOM_USERNAME,
  password: process.env.TELESOM_PASSWORD,
  clientRef: process.env.TELESOM_CLIENT_REF,
  baseUrl: process.env.TELESOM_BASE_URL || 'https://sms.mytelesom.com/'
};

const WAAFI_CONFIG = {
  merchantUid: process.env.WAAFI_MERCHANT_UID,
  apiUserId: process.env.WAAFI_API_USER_ID,
  apiKey: process.env.WAAFI_API_KEY,
  baseUrl: process.env.WAAFI_BASE_URL || 'https://api.waafipay.net'
};

const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

const otpStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) otpStore.delete(phone);
  }
}, 10 * 60 * 1000);

function getCredentials(phone) {
  const clean = phone.replace(/\D/g, '');
  return { email: `user_${clean}@hodanclinic.com`, password: `HodanClinic_${clean}_Secure2024!`, cleanPhone: clean };
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateTelesomHashKey(username, password, to, msg, fromId, date, secretKey) {
  const encodedMsg = msg.replace(/ /g, '%20');
  const hashString = `${username}|${password}|${to}|${encodedMsg}|${fromId}|${date}|${secretKey}`;
  return crypto.createHash('md5').update(hashString).digest('hex').toUpperCase();
}

function getTodayDate() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}/${month}/${year}`;
}

async function firebaseAuthRequest(endpoint, body) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FIREBASE_WEB_API_KEY}`;
  try {
    const res = await axios.post(url, body, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
    return { success: true, data: res.data };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

async function sendTelesomSMS(phone, message) {
  console.log('[SMS] Starting sendTelesomSMS to:', phone);

  if (!TELESOM_CONFIG.senderID || !TELESOM_CONFIG.username || !TELESOM_CONFIG.password) {
    console.log('[SMS] ERROR: Telesom not configured');
    return { success: false, error: 'Telesom not configured' };
  }

  const baseUrl = TELESOM_CONFIG.baseUrl.replace(/\/$/, '');
  const cleanPhone = phone.replace(/\D/g, '');
  const today = getTodayDate();

  console.log('[SMS] Config:', { baseUrl, senderID: TELESOM_CONFIG.senderID, username: TELESOM_CONFIG.username, phone: cleanPhone, date: today });

  // Method 1: POST with MD5 hash (official documented API)
  try {
    const url = `${baseUrl}/index.php/Gway/sendsms/`;
    const encodedMsg = message.replace(/ /g, '%20');
    const hashKey = generateTelesomHashKey(
      TELESOM_CONFIG.username,
      TELESOM_CONFIG.password,
      cleanPhone,
      encodedMsg,
      TELESOM_CONFIG.senderID,
      today,
      TELESOM_CONFIG.clientRef || ''
    );

    console.log('[SMS] Trying POST with hash. URL:', url);
    console.log('[SMS] Hash key:', hashKey);

    const params = new URLSearchParams();
    params.append('username', TELESOM_CONFIG.username);
    params.append('password', TELESOM_CONFIG.password);
    params.append('to', cleanPhone);
    params.append('msg', encodedMsg);
    params.append('from', TELESOM_CONFIG.senderID);
    params.append('date', today);
    params.append('key', hashKey);

    const res = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    console.log('[SMS] POST response:', res.data);
    return { success: true, data: res.data };
  } catch (err) {
    console.log('[SMS] POST failed:', err.message);
    if (err.response) {
      console.log('[SMS] POST error response:', err.response.data);
    }
  }

  // Method 2: Simple GET fallback
  try {
    const msg = encodeURIComponent(message);
    const url = `${baseUrl}/send?senderID=${encodeURIComponent(TELESOM_CONFIG.senderID)}&recipient=${encodeURIComponent(cleanPhone)}&message=${msg}&username=${encodeURIComponent(TELESOM_CONFIG.username)}&password=${encodeURIComponent(TELESOM_CONFIG.password)}`;

    console.log('[SMS] Trying GET fallback. URL:', url);

    const res = await axios.get(url, { timeout: 15000 });
    console.log('[SMS] GET response:', res.data);
    return { success: true, data: res.data };
  } catch (err) {
    console.log('[SMS] GET failed:', err.message);
    if (err.response) {
      console.log('[SMS] GET error response:', err.response.data);
    }
  }

  // Method 3: Simple POST fallback
  try {
    const url = `${baseUrl}/send`;
    console.log('[SMS] Trying simple POST fallback. URL:', url);

    const res = await axios.post(url, {
      senderID: TELESOM_CONFIG.senderID,
      recipient: cleanPhone,
      message: message,
      username: TELESOM_CONFIG.username,
      password: TELESOM_CONFIG.password
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });

    console.log('[SMS] Simple POST response:', res.data);
    return { success: true, data: res.data };
  } catch (err2) {
    console.log('[SMS] Simple POST failed:', err2.message);
    if (err2.response) {
      console.log('[SMS] Simple POST error response:', err2.response.data);
    }
    return { success: false, error: err2.message, details: err2.response?.data };
  }
}

async function initiateWaafiPayment(phone, amount, description) {
  if (!WAAFI_CONFIG.merchantUid || !WAAFI_CONFIG.apiKey) {
    return { success: false, error: 'WAAFI not configured' };
  }
  try {
    const res = await axios.post(`${WAAFI_CONFIG.baseUrl}/api/payment`, {
      merchantUid: WAAFI_CONFIG.merchantUid, apiUserId: WAAFI_CONFIG.apiUser_ID,
      apiKey: WAAFI_CONFIG.apiKey, phone, amount, description
    }, { timeout: 15000 });
    return { success: true, data: res.data };
  } catch (err) {
    return { success: false, error: err.message, details: err.response?.data };
  }
}

app.get('/health', (req, res) => {
  res.json({ healthy: true, firebase: !!FIREBASE_WEB_API_KEY, timestamp: new Date().toISOString() });
});

app.get('/debug', (req, res) => {
  res.json({
    telesom_url: TELESOM_CONFIG.baseUrl,
    telesom_sender_set: !!TELESOM_CONFIG.senderID,
    telesom_username_set: !!TELESOM_CONFIG.username,
    telesom_password_set: !!TELESOM_CONFIG.password,
    telesom_client_ref_set: !!TELESOM_CONFIG.clientRef,
    waafi_merchant_set: !!WAAFI_CONFIG.merchantUid,
    firebase_web_api_key_set: !!FIREBASE_WEB_API_KEY,
    otp_store_size: otpStore.size,
    today_date: getTodayDate()
  });
});

app.post('/api/send-otp', async (req, res) => {
  console.log('[OTP] Received request:', req.body);
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });
    const cleanPhone = phone.replace(/\D/g, '');
    const otp = generateOtp();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStore.set(cleanPhone, { code: otp, expiresAt, attempts: 0 });

    console.log('[OTP] Generated OTP:', otp, 'for phone:', cleanPhone);

    const smsResult = await sendTelesomSMS(cleanPhone, `Your Hodan Skin Clinic OTP is: ${otp}. Valid for 5 minutes.`);

    console.log('[OTP] SMS result:', smsResult);

    res.json({ success: true, message: 'OTP sent', otp: otp, smsDelivered: smsResult.success, smsError: smsResult.error || null, smsDetails: smsResult.data || null });
  } catch (err) {
    console.log('[OTP] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ success: false, error: 'Phone and OTP code required' });
    const cleanPhone = phone.replace(/\D/g, '');
    const stored = otpStore.get(cleanPhone);
    if (!stored) return res.status(400).json({ success: false, error: 'OTP not found or expired' });
    if (Date.now() > stored.expiresAt) { otpStore.delete(cleanPhone); return res.status(400).json({ success: false, error: 'OTP expired' }); }
    if (stored.code !== code) {
      stored.attempts++;
      if (stored.attempts >= 3) { otpStore.delete(cleanPhone); return res.status(400).json({ success: false, error: 'Too many failed attempts. Request a new OTP.' }); }
      return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }
    otpStore.delete(cleanPhone);
    res.json({ success: true, message: 'OTP verified', phone: cleanPhone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });
    const { email, password, cleanPhone } = getCredentials(phone);
    let result = await firebaseAuthRequest('signUp', { email, password, returnSecureToken: true });
    if (!result.success && result.error === 'EMAIL_EXISTS') {
      result = await firebaseAuthRequest('signInWithPassword', { email, password, returnSecureToken: true });
    }
    if (!result.success) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, uid: result.data.localId, email: result.data.email, idToken: result.data.idToken, refreshToken: result.data.refreshToken, expiresIn: result.data.expiresIn, phone: cleanPhone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });
    const { email, password, cleanPhone } = getCredentials(phone);
    const result = await firebaseAuthRequest('signInWithPassword', { email, password, returnSecureToken: true });
    if (!result.success) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, uid: result.data.localId, email: result.data.email, idToken: result.data.idToken, refreshToken: result.data.refreshToken, expiresIn: result.data.expiresIn, phone: cleanPhone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/user/:uid', async (req, res) => {
  res.json({ success: true, uid: req.params.uid, message: 'User data available via client-side auth' });
});

app.post('/api/payment', async (req, res) => {
  try {
    const { phone, amount, description } = req.body;
    if (!phone || !amount) return res.status(400).json({ success: false, error: 'Phone and amount required' });
    const result = await initiateWaafiPayment(phone, amount, description);
    res.json({ success: result.success, message: result.success ? 'Payment initiated' : 'Payment failed', error: result.error || null, waafiResponse: result.data || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hodan Skin Clinic API running on port ${PORT}`);
});

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
  sharedSecret: process.env.TELESOM_SHARED_SECRET,
  baseUrl: process.env.TELESOM_BASE_URL || 'https://smsgateway.mytelesom.com/'
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

function generateTelesomAuthKey(senderID, timestamp, username, password, sharedSecret) {
  const data = senderID + timestamp + username + password;
  return crypto.createHmac('sha256', sharedSecret).update(data).digest('base64');
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
  if (!TELESOM_CONFIG.senderID || !TELESOM_CONFIG.username || !TELESOM_CONFIG.password) {
    return { success: false, error: 'Telesom not configured' };
  }
  const baseUrl = TELESOM_CONFIG.baseUrl.replace(/\/$/, '');
  if (TELESOM_CONFIG.sharedSecret) {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const authKey = generateTelesomAuthKey(TELESOM_CONFIG.senderID, timestamp, TELESOM_CONFIG.username, TELESOM_CONFIG.password, TELESOM_CONFIG.sharedSecret);
      const res = await axios.post(`${baseUrl}/send`, {
        senderID: TELESOM_CONFIG.senderID, recipient: phone, message,
        username: TELESOM_CONFIG.username, password: TELESOM_CONFIG.password, timestamp, authKey
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      return { success: true, data: res.data };
    } catch (err) {}
  }
  try {
    const url = `${baseUrl}/send?senderID=${encodeURIComponent(TELESOM_CONFIG.senderID)}&recipient=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}&username=${encodeURIComponent(TELESOM_CONFIG.username)}&password=${encodeURIComponent(TELESOM_CONFIG.password)}`;
    const res = await axios.get(url, { timeout: 15000 });
    return { success: true, data: res.data };
  } catch (err) {
    try {
      const res = await axios.post(`${baseUrl}/send`, {
        senderID: TELESOM_CONFIG.senderID, recipient: phone, message,
        username: TELESOM_CONFIG.username, password: TELESOM_CONFIG.password
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      return { success: true, data: res.data };
    } catch (err2) {
      return { success: false, error: err2.message, details: err2.response?.data };
    }
  }
}

async function initiateWaafiPayment(phone, amount, description) {
  if (!WAAFI_CONFIG.merchantUid || !WAAFI_CONFIG.apiKey) {
    return { success: false, error: 'WAAFI not configured' };
  }
  try {
    const res = await axios.post(`${WAAFI_CONFIG.baseUrl}/api/payment`, {
      merchantUid: WAAFI_CONFIG.merchantUid, apiUserId: WAAFI_CONFIG.apiUserId,
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
    telesom_shared_secret_set: !!TELESOM_CONFIG.sharedSecret,
    waafi_merchant_set: !!WAAFI_CONFIG.merchantUid,
    firebase_web_api_key_set: !!FIREBASE_WEB_API_KEY,
    otp_store_size: otpStore.size
  });
});

app.post('/api/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });
    const cleanPhone = phone.replace(/\D/g, '');
    const otp = generateOtp();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStore.set(cleanPhone, { code: otp, expiresAt, attempts: 0 });
    const smsResult = await sendTelesomSMS(cleanPhone, `Your Hodan Skin Clinic OTP is: ${otp}. Valid for 5 minutes.`);
    res.json({ success: true, message: 'OTP sent', otp: otp, smsDelivered: smsResult.success, smsError: smsResult.error || null });
  } catch (err) {
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

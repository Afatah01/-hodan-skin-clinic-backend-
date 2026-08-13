/**
 * Hodan Skin Clinic - Backend API
 * Deploy to: Render.com (FREE tier)
 * Handles: Telesom SMS OTP, WAAFI Payments, Firebase Admin Auth
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');

// ─── Firebase Admin SDK ───────────────────────────────────────
let admin = null;
let firebaseApp = null;

try {
  const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';
  // Handle all possible newline formats
  const formattedKey = rawKey
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: formattedKey
  };

  if (serviceAccount.projectId && serviceAccount.clientEmail && formattedKey.includes('BEGIN PRIVATE KEY')) {
    admin = require('firebase-admin');
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.projectId}-default-rtdb.firebaseio.com`
    });
    console.log('[Backend] Firebase Admin initialized');
  } else {
    console.log('[Backend] Firebase credentials incomplete');
  }
} catch (err) {
  console.log('[Backend] Firebase Admin error:', err.message);
}

// ─── Express App ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Health Check ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Hodan Skin Clinic API is running',
    firebase: firebaseApp ? 'connected' : 'not configured',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ healthy: true });
});

// ─── TELESOM SMS API ─────────────────────────────────────────

/* Send OTP via Telesom SMS */
app.post('/api/sms/send-otp', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const cleanPhone = phone.replace(/\D/g, '');
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  const otpData = {
    code: otp,
    phone: cleanPhone,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    verified: false
  };

  try {
    if (admin) {
      await admin.database().ref(`otps/${cleanPhone}`).set(otpData);
    }

    const telesomUsername = process.env.TELESOM_USERNAME;
    const telesomPassword = process.env.TELESOM_PASSWORD;
    const senderId = process.env.TELESOM_SENDER_ID || 'HodanClinic';

    if (telesomUsername && telesomPassword) {
      const messageEn = `Your Hodan Skin Clinic verification code is: ${otp}. Valid for 10 minutes.`;
      const messageSo = `Koodhkaaga xaqiijinta Hodan Skin Clinic waa: ${otp}. Waxa uu shaqeeyaa 10 daqiiqo.`;
      const message = `${messageSo}\n${messageEn}`;

      await axios.post('https://sms.telesom.com/api/v1/send', {
        username: telesomUsername,
        password: telesomPassword,
        to: cleanPhone,
        from: senderId,
        text: message,
        client_ref: process.env.TELESOM_CLIENT_REF || 'TLS-238'
      });

      console.log('[SMS] OTP sent to:', cleanPhone);
    } else {
      console.log('[SMS] Telesom credentials not set. OTP:', otp);
    }

    res.json({ success: true, message: 'OTP sent', phone: cleanPhone });
  } catch (err) {
    console.error('[SMS] Error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP', details: err.message });
  }
});

/* Verify OTP */
app.post('/api/sms/verify-otp', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  const cleanPhone = phone.replace(/\D/g, '');

  try {
    let otpData = null;
    if (admin) {
      const snapshot = await admin.database().ref(`otps/${cleanPhone}`).once('value');
      otpData = snapshot.val();
    }

    if (!otpData) return res.status(400).json({ error: 'OTP not found or expired' });
    if (otpData.code !== code) return res.status(400).json({ error: 'Invalid OTP' });
    if (Date.now() > otpData.expiresAt) return res.status(400).json({ error: 'OTP expired' });

    if (admin) {
      await admin.database().ref(`otps/${cleanPhone}`).update({ verified: true });
    }

    res.json({ success: true, message: 'OTP verified' });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

/* Send welcome SMS after registration */
app.post('/api/sms/welcome', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  try {
    const telesomUsername = process.env.TELESOM_USERNAME;
    const telesomPassword = process.env.TELESOM_PASSWORD;

    if (telesomUsername && telesomPassword) {
      const msgSo = `Soo dhawoow ${name || ''}! Waad ku guuleysatay diiwaangelinta Hodan Skin Clinic.`;
      const msgEn = `Welcome ${name || ''}! You have successfully registered with Hodan Skin Clinic.`;

      await axios.post('https://sms.telesom.com/api/v1/send', {
        username: telesomUsername,
        password: telesomPassword,
        to: phone.replace(/\D/g, ''),
        from: process.env.TELESOM_SENDER_ID || 'HodanClinic',
        text: `${msgSo}\n${msgEn}`,
        client_ref: process.env.TELESOM_CLIENT_REF || 'TLS-238'
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WAAFI PAYMENT API ──────────────────────────────────────

/* Process WAAFI Payment */
app.post('/api/pay', async (req, res) => {
  const { phone, amount, orderId, description } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });

  try {
    const waafiApiKey = process.env.WAAFI_API_KEY;
    const waafiMerchantId = process.env.WAAFI_MERCHANT_ID;
    const waafiAccountId = process.env.WAAFI_ACCOUNT_ID;

    if (!waafiApiKey || !waafiMerchantId) {
      return res.status(500).json({ error: 'WAAFI credentials not configured' });
    }

    const cleanPhone = phone.replace(/\D/g, '');

    const payload = {
      merchantId: waafiMerchantId,
      apiKey: waafiApiKey,
      accountId: waafiAccountId,
      accountType: 'MERCHANT',
      amount: parseFloat(amount),
      currency: 'USD',
      description: description || 'Hodan Skin Clinic Payment',
      reference: orderId || `ORD-${Date.now()}`,
      phone: cleanPhone.startsWith('252') ? cleanPhone : '252' + cleanPhone.replace(/^0+/, '')
    };

    const response = await axios.post(
      'https://api.waafipay.net/api/v1/payment',
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    res.json({
      success: true,
      transactionId: response.data?.transactionId || response.data?.reference,
      status: response.data?.status || 'PENDING',
      message: response.data?.message || 'Payment initiated'
    });
  } catch (err) {
    console.error('[Payment] Error:', err.message);
    res.status(500).json({ error: 'Payment failed', details: err.message });
  }
});

/* Check WAAFI Payment Status */
app.post('/api/pay/status', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'Transaction ID required' });

  try {
    const waafiApiKey = process.env.WAAFI_API_KEY;
    const waafiMerchantId = process.env.WAAFI_MERCHANT_ID;

    const response = await axios.post(
      'https://api.waafipay.net/api/v1/payment/status',
      {
        merchantId: waafiMerchantId,
        apiKey: waafiApiKey,
        transactionId
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    res.json({
      success: true,
      status: response.data?.status || 'UNKNOWN',
      data: response.data
    });
  } catch (err) {
    res.status(500).json({ error: 'Status check failed', details: err.message });
  }
});

// ─── FIREBASE ADMIN AUTH API ────────────────────────────────

/* Create user with Firebase Admin */
app.post('/api/auth/create-user', async (req, res) => {
  const { phone, fullName } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not configured' });

  const cleanPhone = phone.replace(/\D/g, '');
  const email = `${cleanPhone}@hodanclinic.com`;
  const password = `HodanClinic_${cleanPhone}_Secure2024!`;

  try {
    try {
      const existingUser = await admin.auth().getUserByEmail(email);
      return res.status(409).json({ error: 'User already exists', uid: existingUser.uid });
    } catch {
      // user doesn't exist, continue
    }

    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      phoneNumber: cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`,
      displayName: fullName || 'Patient',
      emailVerified: true
    });

    await admin.database().ref(`users/${userRecord.uid}`).set({
      uid: userRecord.uid,
      fullName: fullName || 'Patient',
      phoneNumber: cleanPhone,
      email: email,
      createdAt: new Date().toISOString()
    });

    const customToken = await admin.auth().createCustomToken(userRecord.uid);
    res.json({ success: true, uid: userRecord.uid, token: customToken });
  } catch (err) {
    console.error('[Auth] Create user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* Sign in with Firebase Admin */
app.post('/api/auth/signin', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not configured' });

  const cleanPhone = phone.replace(/\D/g, '');
  const email = `${cleanPhone}@hodanclinic.com`;

  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    const customToken = await admin.auth().createCustomToken(userRecord.uid);
    res.json({ success: true, uid: userRecord.uid, token: customToken });
  } catch (err) {
    res.status(404).json({ error: 'User not found' });
  }
});

/* Get user profile from RTDB */
app.get('/api/user/:uid', async (req, res) => {
  const { uid } = req.params;
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not configured' });

  try {
    const snapshot = await admin.database().ref(`users/${uid}`).once('value');
    const userData = snapshot.val();
    if (!userData) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: userData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Hodan Skin Clinic API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

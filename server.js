const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// FIREBASE ADMIN SETUP
// ============================================================
let admin = null;
let db = null;
let firebaseInitialized = false;

try {
  const adminModule = require('firebase-admin');
  admin = adminModule;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';

  if (!projectId) console.error('[FIREBASE ERROR] FIREBASE_PROJECT_ID is missing!');
  if (!clientEmail) console.error('[FIREBASE ERROR] FIREBASE_CLIENT_EMAIL is missing!');
  if (!rawKey) console.error('[FIREBASE ERROR] FIREBASE_PRIVATE_KEY is missing!');

  if (projectId && clientEmail && rawKey) {
    let formattedKey = rawKey;
    if (formattedKey.startsWith('"') && formattedKey.endsWith('"')) {
      formattedKey = formattedKey.slice(1, -1);
    }
    if (formattedKey.includes('\\n')) formattedKey = formattedKey.replace(/\\n/g, '\n');
    if (formattedKey.includes('\\r')) formattedKey = formattedKey.replace(/\\r/g, '\r');
    formattedKey = formattedKey.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const serviceAccount = {
      projectId: projectId,
      clientEmail: clientEmail,
      privateKey: formattedKey
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`
    });

    db = admin.database();
    firebaseInitialized = true;
    console.log('[FIREBASE] Firebase Admin initialized SUCCESSFULLY!');
  } else {
    console.error('[FIREBASE] Firebase Admin NOT initialized - missing credentials');
  }
} catch (error) {
  console.error('[FIREBASE] Firebase Admin initialization failed:', error.message);
}

// ============================================================
// TELESOM SMS CONFIG
// ============================================================
const TELESOM_CONFIG = {
  username: process.env.TELESOM_USERNAME || 'USERNAME_q4edmLRZ',
  password: process.env.TELESOM_PASSWORD || 'PASSWORD_XlPs5KKK',
  senderId: process.env.TELESOM_SENDER_ID || 'HodanClinic',
  clientRef: process.env.TELESOM_CLIENT_REF || 'TLS-238'
};

// ============================================================
// WAAFI PAY CONFIG
// ============================================================
const WAAFI_CONFIG = {
  merchantUid: process.env.WAAFI_MERCHANT_UID || 'M0914341',
  apiUserId: process.env.WAAFI_API_USER_ID || '1009066',
  apiKey: process.env.WAAFI_API_KEY || 'API-pTYuClu2Yc1AjqKKLp7Y1vjBnH5',
  baseUrl: 'https://api.waafipay.net/v1'
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanPhoneNumber(phone) {
  let cleaned = phone.replace(/\s/g, '').replace(/[+\-]/g, '');
  if (cleaned.startsWith('252')) cleaned = cleaned.substring(3);
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  return cleaned;
}

function createEmailFromPhone(phone) {
  const clean = cleanPhoneNumber(phone);
  return `user_${clean}@hodanclinic.com`;
}

function createPassword(phone) {
  const clean = cleanPhoneNumber(phone);
  return `HodanClinic_${clean}_Secure2024!`;
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ healthy: true, firebase: firebaseInitialized, timestamp: new Date().toISOString() });
});

// ============================================================
// DEBUG ENDPOINT
// ============================================================
app.get('/debug', (req, res) => {
  res.json({
    firebase_project_id_set: !!process.env.FIREBASE_PROJECT_ID,
    firebase_client_email_set: !!process.env.FIREBASE_CLIENT_EMAIL,
    firebase_private_key_set: !!process.env.FIREBASE_PRIVATE_KEY,
    firebase_initialized: firebaseInitialized,
    telesom_username_set: !!process.env.TELESOM_USERNAME,
    waafi_merchant_set: !!process.env.WAAFI_MERCHANT_UID
  });
});

// ============================================================
// 1. SEND OTP ENDPOINT
// ============================================================
app.post('/api/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }

    const otp = generateOTP();
    const cleanPhone = cleanPhoneNumber(phone);
    const fullPhone = '252' + cleanPhone;

    // Save OTP to Firebase RTDB
    if (db) {
      await db.ref(`otps/${cleanPhone}`).set({
        code: otp,
        createdAt: Date.now(),
        attempts: 0
      });
    }

    const smsMessage = `Your Hodan Skin Clinic verification code is: ${otp}. Valid for 5 minutes.`;
    
    // Try to send SMS via Telesom
    let smsSent = false;
    let smsError = null;
    try {
      const telesomUrl = `https://sms.ahmedtelesom.com/SendSMS.aspx?` +
        `User=${encodeURIComponent(TELESOM_CONFIG.username)}` +
        `&Pass=${encodeURIComponent(TELESOM_CONFIG.password)}` +
        `&Phone=${encodeURIComponent(fullPhone)}` +
        `&Text=${encodeURIComponent(smsMessage)}` +
        `&Sender=${encodeURIComponent(TELESOM_CONFIG.senderId)}` +
        `&ClientRef=${encodeURIComponent(TELESOM_CONFIG.clientRef)}`;

      const smsResponse = await axios.get(telesomUrl, { timeout: 15000 });
      smsSent = true;
      console.log('Telesom SMS sent to', fullPhone, 'Response:', smsResponse.data);
    } catch (err) {
      smsError = err.message;
      console.error('Telesom SMS error:', err.message);
    }
    
    res.json({
      success: true,
      message: smsSent ? 'OTP sent successfully' : 'OTP generated (SMS service issue, use debug code below)',
      phone: fullPhone,
      otp: otp,  // Always return OTP for debug/testing
      smsSent: smsSent,
      smsError: smsError
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 2. VERIFY OTP ENDPOINT (just checks code, doesn't create user)
// ============================================================
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ success: false, error: 'Phone and code required' });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    const email = createEmailFromPhone(phone);

    // Check OTP from Firebase RTDB
    let otpValid = false;
    if (db) {
      const otpSnapshot = await db.ref(`otps/${cleanPhone}`).once('value');
      const otpData = otpSnapshot.val();
      if (otpData && otpData.code === code) {
        otpValid = true;
        await db.ref(`otps/${cleanPhone}`).remove();
      }
    } else {
      // If no DB, accept any code for testing
      otpValid = true;
    }

    if (!otpValid) {
      return res.status(400).json({ success: false, verified: false, error: 'Invalid OTP' });
    }

    // Check if user already exists
    let userExists = false;
    let uid = null;
    if (admin) {
      try {
        const userRecord = await admin.auth().getUserByEmail(email);
        userExists = true;
        uid = userRecord.uid;
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          userExists = false;
        }
      }
    }

    res.json({
      success: true,
      verified: true,
      userExists: userExists,
      uid: uid,
      phone: '+252' + cleanPhone
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 3. REGISTER USER ENDPOINT (creates user + returns custom token)
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { phone, fullName } = req.body;
    if (!phone || !fullName) {
      return res.status(400).json({ success: false, error: 'Phone and fullName required' });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    const email = createEmailFromPhone(phone);
    const password = createPassword(phone);
    const displayName = fullName.trim();

    if (!admin || !db) {
      return res.status(500).json({ success: false, error: 'Firebase not initialized' });
    }

    // Create user in Firebase Auth
    let uid;
    try {
      const userRecord = await admin.auth().createUser({
        email: email,
        password: password,
        displayName: displayName,
        phoneNumber: '+252' + cleanPhone
      });
      uid = userRecord.uid;
      console.log('[REGISTER] User created:', uid);
    } catch (err) {
      if (err.code === 'auth/email-already-exists' || err.code === 'auth/phone-number-already-exists') {
        // User already exists, get their UID
        const existingUser = await admin.auth().getUserByEmail(email);
        uid = existingUser.uid;
        console.log('[REGISTER] User already exists:', uid);
      } else {
        throw err;
      }
    }

    // Save user profile to RTDB
    await db.ref(`users/${uid}`).set({
      fullName: displayName,
      phone: '+252' + cleanPhone,
      email: email,
      createdAt: Date.now()
    });

    // Generate custom token for client-side auth
    const customToken = await admin.auth().createCustomToken(uid);

    res.json({
      success: true,
      message: 'User registered successfully',
      uid: uid,
      customToken: customToken,
      email: email
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 4. LOGIN USER ENDPOINT (returns custom token for existing user)
// ============================================================
app.post('/api/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone required' });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    const email = createEmailFromPhone(phone);

    if (!admin) {
      return res.status(500).json({ success: false, error: 'Firebase not initialized' });
    }

    // Find user by email
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        return res.status(404).json({ success: false, error: 'User not found. Please sign up first.' });
      }
      throw err;
    }

    // Generate custom token
    const customToken = await admin.auth().createCustomToken(userRecord.uid);

    // Update last login
    if (db) {
      await db.ref(`users/${userRecord.uid}`).update({
        lastLoginAt: Date.now()
      });
    }

    res.json({
      success: true,
      message: 'Login successful',
      uid: userRecord.uid,
      customToken: customToken
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 5. GET USER PROFILE
// ============================================================
app.get('/api/user/:uid', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, error: 'Database not connected' });
    }
    const snapshot = await db.ref(`users/${req.params.uid}`).once('value');
    res.json({ success: true, user: snapshot.val() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 6. UPDATE USER PROFILE
// ============================================================
app.put('/api/user/:uid', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, error: 'Database not connected' });
    }
    await db.ref(`users/${req.params.uid}`).update(req.body);
    res.json({ success: true, message: 'Profile updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 7. WAAFI PAYMENT ENDPOINT
// ============================================================
app.post('/api/payment', async (req, res) => {
  try {
    const { phone, amount, description, userId } = req.body;
    
    if (!phone || !amount) {
      return res.status(400).json({ success: false, error: 'Phone and amount are required' });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    const fullPhone = '252' + cleanPhone;
    const paymentInvoice = `HODAN-${Date.now()}`;

    const waafiPayload = {
      merchantUid: WAAFI_CONFIG.merchantUid,
      apiUserId: WAAFI_CONFIG.apiUserId,
      apiKey: WAAFI_CONFIG.apiKey,
      paymentMethod: 'MWALLET_ACCOUNT',
      amount: amount.toString(),
      currency: 'USD',
      description: description || 'Hodan Skin Clinic Payment',
      accountNo: fullPhone,
      accountName: 'Hodan Clinic Customer',
      invoiceId: paymentInvoice,
      callbackUrl: 'https://hodan-skin-clinic-api.onrender.com/api/payment/waafi/callback'
    };

    try {
      const waafiResponse = await axios.post(
        `${WAAFI_CONFIG.baseUrl}/payment`,
        waafiPayload,
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );

      if (db) {
        await db.ref(`payments/${paymentInvoice}`).set({
          phone: fullPhone,
          amount: amount,
          currency: 'USD',
          description: description || 'Hodan Skin Clinic Payment',
          invoiceId: paymentInvoice,
          userId: userId || null,
          status: 'pending',
          waafiResponse: waafiResponse.data,
          createdAt: Date.now()
        });
      }

      res.json({
        success: true,
        message: 'Payment request sent',
        transactionId: paymentInvoice,
        phone: fullPhone,
        amount: amount,
        waafiResponse: waafiResponse.data
      });
    } catch (waafiError) {
      console.error('WAAFI payment error:', waafiError.message);
      res.json({
        success: false,
        message: 'Payment request failed',
        error: waafiError.message,
        transactionId: paymentInvoice
      });
    }
  } catch (error) {
    console.error('Payment endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 8. CHECK PAYMENT STATUS
// ============================================================
app.get('/api/payment/status/:transactionId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, error: 'Database not connected' });
    }
    const snapshot = await db.ref(`payments/${req.params.transactionId}`).once('value');
    const payment = snapshot.val();
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    res.json({ success: true, status: payment.status, payment: payment });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// WAAFI PAYMENT CALLBACK
// ============================================================
app.post('/api/payment/waafi/callback', async (req, res) => {
  try {
    const { invoiceId, status, transactionId } = req.body;
    console.log('WAAFI Callback received:', req.body);
    if (db && invoiceId) {
      await db.ref(`payments/${invoiceId}`).update({
        status: status || 'completed',
        transactionId: transactionId || null,
        callbackReceived: true,
        callbackData: req.body,
        updatedAt: Date.now()
      });
    }
    res.json({ success: true, message: 'Callback received' });
  } catch (error) {
    console.error('WAAFI callback error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('Hodan Skin Clinic API running on port', PORT);
  console.log('Health check: /health');
  console.log('Debug info: /debug');
  console.log('Firebase connected:', firebaseInitialized);
  console.log('Telesom SMS configured:', !!TELESOM_CONFIG.username);
  console.log('WAAFI Pay configured:', !!WAAFI_CONFIG.merchantUid);
  console.log('========================================');
});

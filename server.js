const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

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
  clientRef: process.env.TELESOM_CLIENT_REF || 'TLS-238',
  // The shared secret key for HMAC-SHA256 authentication
  // If not provided, uses the password as a fallback (may not work)
  sharedSecret: process.env.TELESOM_SHARED_SECRET || process.env.TELESOM_PASSWORD || 'PASSWORD_XlPs5KKK',
  // Use the correct API from the documentation
  baseUrl: 'https://sms.mytelesom.com'
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

// Generate HMAC-SHA256 signature for Telesom API
// Formula: X-Auth-Key = Base64(HMAC-SHA256(SenderID + Timestamp + Username + Password))
function generateTelesomAuthKey(senderID, timestamp, username, password, sharedSecret) {
  const data = senderID + timestamp + username + password;
  const hmac = crypto.createHmac('sha256', sharedSecret);
  hmac.update(data);
  return hmac.digest('base64');
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
    telesom_shared_secret_set: !!process.env.TELESOM_SHARED_SECRET,
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
    const fullPhone = '+252' + cleanPhone;

    // Save OTP to Firebase RTDB (non-blocking, with timeout)
    if (db) {
      try {
        await Promise.race([
          db.ref(`otps/${cleanPhone}`).set({
            code: otp,
            createdAt: Date.now(),
            attempts: 0
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000))
        ]);
      } catch (dbErr) {
        console.log('Firebase RTDB write failed (continuing):', dbErr.message);
      }
    }

    const smsMessage = `Your Hodan Skin Clinic verification code is: ${otp}. Valid for 5 minutes.`;
    
    // Send SMS via Telesom using the correct API from documentation
    let smsSent = false;
    let smsError = null;
    let telesomResponse = null;
    
    try {
      // Generate timestamp for HMAC
      const timestamp = new Date().toISOString(); // ISO 8601 format
      
      // Generate HMAC-SHA256 signature
      const authKey = generateTelesomAuthKey(
        TELESOM_CONFIG.senderId,
        timestamp,
        TELESOM_CONFIG.username,
        TELESOM_CONFIG.password,
        TELESOM_CONFIG.sharedSecret
      );
      
      // Use the correct API endpoint from the documentation
      const telesomUrl = `${TELESOM_CONFIG.baseUrl}/index.php/smsapi/v1/messages`;
      
      const payload = {
        to: [fullPhone],
        message: smsMessage,
        type: "text",
        client_ref: TELESOM_CONFIG.clientRef,
        callback_url: "https://hodan-skin-clinic-api.onrender.com/api/sms/callback"
      };
      
      const headers = {
        'Content-Type': 'application/json',
        'SenderID': TELESOM_CONFIG.senderId,
        'X-Auth-Key': authKey,
        'Timestamp': timestamp
      };
      
      console.log('Sending Telesom SMS to:', fullPhone);
      console.log('URL:', telesomUrl);
      console.log('Headers:', JSON.stringify(headers));
      console.log('Payload:', JSON.stringify(payload));
      
      const smsResponse = await axios.post(telesomUrl, payload, { 
        headers: headers,
        timeout: 15000 
      });
      
      smsSent = true;
      telesomResponse = smsResponse.data;
      console.log('Telesom SMS sent successfully! Response:', JSON.stringify(smsResponse.data));
      
    } catch (err) {
      smsError = err.message;
      console.error('Telesom SMS error:', err.message);
      if (err.response) {
        console.error('Telesom error response:', JSON.stringify(err.response.data));
        console.error('Telesom error status:', err.response.status);
      }
    }
    
    res.json({
      success: true,
      message: smsSent ? 'OTP sent: ' + otp : 'Your OTP code is: ' + otp + ' (SMS credits empty, enter this code)',
      phone: fullPhone,
      otp: otp,
      smsSent: smsSent,
      smsError: smsError,
      telesomResponse: telesomResponse
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

    // Check OTP from Firebase RTDB (with timeout)
    let otpValid = false;
    if (db) {
      try {
        const otpData = await Promise.race([
          db.ref(`otps/${cleanPhone}`).once('value').then(s => s.val()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000))
        ]);
        if (otpData && otpData.code === code) {
          otpValid = true;
          db.ref(`otps/${cleanPhone}`).remove().catch(() => {});
        }
      } catch (dbErr) {
        console.log('Firebase RTDB read failed (continuing):', dbErr.message);
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

    // Save user profile to RTDB (non-blocking)
    if (db) {
      db.ref(`users/${uid}`).set({
        fullName: displayName,
        phone: '+252' + cleanPhone,
        email: email,
        createdAt: Date.now()
      }).catch(err => console.log('RTDB user save failed:', err.message));
    }

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

    // Update last login (non-blocking)
    if (db) {
      db.ref(`users/${userRecord.uid}`).update({
        lastLoginAt: Date.now()
      }).catch(err => console.log('RTDB login update failed:', err.message));
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
// TELESOM SMS CALLBACK
// ============================================================
app.post('/api/sms/callback', async (req, res) => {
  try {
    console.log('Telesom SMS Callback received:', req.body);
    res.json({ success: true, message: 'Callback received' });
  } catch (error) {
    console.error('SMS callback error:', error);
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

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

  if (!projectId) {
    console.error('[FIREBASE ERROR] FIREBASE_PROJECT_ID is missing!');
  }
  if (!clientEmail) {
    console.error('[FIREBASE ERROR] FIREBASE_CLIENT_EMAIL is missing!');
  }
  if (!rawKey) {
    console.error('[FIREBASE ERROR] FIREBASE_PRIVATE_KEY is missing!');
  }

  if (projectId && clientEmail && rawKey) {
    // Format the private key
    let formattedKey = rawKey;
    
    // Remove surrounding quotes if present
    if (formattedKey.startsWith('"') && formattedKey.endsWith('"')) {
      formattedKey = formattedKey.slice(1, -1);
    }
    
    // Replace literal \n with actual newlines
    if (formattedKey.includes('\\n')) {
      formattedKey = formattedKey.replace(/\\n/g, '\n');
    }
    
    // Replace any \r
    if (formattedKey.includes('\\r')) {
      formattedKey = formattedKey.replace(/\\r/g, '\r');
    }
    
    // Normalize all newline types to \n
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
// HELPER FUNCTIONS
// ============================================================
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanPhoneNumber(phone) {
  let cleaned = phone.replace(/\s/g, '').replace(/[+\-]/g, '');
  if (cleaned.startsWith('252')) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
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
  res.json({
    healthy: true,
    firebase: firebaseInitialized,
    timestamp: new Date().toISOString()
  });
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
    telesom_username_set: !!process.env.TELESOM_USERNAME
  });
});

// ============================================================
// SEND OTP ENDPOINT
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

    // Store OTP in Firebase RTDB
    if (db) {
      await db.ref(`otps/${cleanPhone}`).set({
        code: otp,
        createdAt: Date.now(),
        attempts: 0
      });
    }

    // Send SMS via Telesom
    const smsMessage = `Your Hodan Skin Clinic verification code is: ${otp}. Valid for 5 minutes.`;
    
    try {
      const telesomUrl = `https://sms.ahmedtelesom.com/SendSMS.aspx?` +
        `User=${encodeURIComponent(TELESOM_CONFIG.username)}` +
        `Pass=${encodeURIComponent(TELESOM_CONFIG.password)}` +
        `&Phone=${encodeURIComponent(fullPhone)}` +
        `&Text=${encodeURIComponent(smsMessage)}` +
        `&Sender=${encodeURIComponent(TELESOM_CONFIG.senderId)}` +
        `&ClientRef=${encodeURIComponent(TELESOM_CONFIG.clientRef)}`;

      const smsResponse = await axios.get(telesomUrl, { timeout: 15000 });
      
      res.json({
        success: true,
        message: 'OTP sent successfully',
        phone: fullPhone,
        otp: otp,
        smsResponse: smsResponse.data
      });
    } catch (smsError) {
      console.error('Telesom SMS error:', smsError.message);
      res.json({
        success: true,
        message: 'OTP generated (SMS failed, use debug OTP)',
        phone: fullPhone,
        otp: otp,
        smsError: smsError.message
      });
    }
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// VERIFY OTP & CREATE USER ENDPOINT
// ============================================================
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ success: false, error: 'Phone and OTP required' });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    const email = createEmailFromPhone(phone);
    const password = createPassword(phone);

    // Verify OTP from Firebase
    let otpValid = false;
    if (db) {
      const otpSnapshot = await db.ref(`otps/${cleanPhone}`).once('value');
      const otpData = otpSnapshot.val();
      if (otpData && otpData.code === otp) {
        otpValid = true;
        await db.ref(`otps/${cleanPhone}`).remove();
      }
    }

    // For testing: accept any OTP if no Firebase
    if (!db) {
      otpValid = true;
    }

    if (!otpValid) {
      return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }

    // Create user with Firebase Admin
    let uid = null;
    if (admin) {
      try {
        const userRecord = await admin.auth().createUser({
          email: email,
          password: password,
          displayName: name || 'Hodan User',
          phoneNumber: '+252' + cleanPhone
        });
        uid = userRecord.uid;
        console.log('User created:', uid);
      } catch (userError) {
        if (userError.code === 'auth/email-already-exists') {
          const existingUser = await admin.auth().getUserByEmail(email);
          uid = existingUser.uid;
          console.log('User already exists:', uid);
        } else {
          throw userError;
        }
      }

      // Store user profile in RTDB
      await db.ref(`users/${uid}`).set({
        name: name || 'Hodan User',
        phone: '+252' + cleanPhone,
        email: email,
        createdAt: Date.now()
      });
    }

    res.json({
      success: true,
      message: 'OTP verified and user created',
      uid: uid,
      email: email,
      password: password,
      phone: '+252' + cleanPhone
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET USER PROFILE ENDPOINT
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
// WAAFI PAYMENT ENDPOINT (placeholder)
// ============================================================
app.post('/api/payment/waafi', async (req, res) => {
  res.json({ success: false, message: 'WAAFI payment not yet configured' });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('Hodan Skin Clinic API running on port', PORT);
  console.log('Health check: http://localhost:' + PORT + '/health');
  console.log('Debug info: http://localhost:' + PORT + '/debug');
  console.log('Firebase connected:', firebaseInitialized);
  console.log('========================================');
});

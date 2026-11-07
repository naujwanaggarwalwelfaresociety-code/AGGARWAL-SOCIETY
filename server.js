const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const Member = require('./models/Member');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MONGODB_URI = process.env.MONGODB_URI;

// Ensure local storage directory & file exist
const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_DB_FILE = path.join(DATA_DIR, 'members.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_DB_FILE)) fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify([]), 'utf8');

let isMongoConnected = false;

// Connect to MongoDB if URI is provided (with quick timeouts for cloud resilience)
if (MONGODB_URI && MONGODB_URI.trim().startsWith('mongodb')) {
  mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000
  })
    .then(() => {
      isMongoConnected = true;
      console.log('✅ Connected to MongoDB successfully!');
    })
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err.message);
      console.log('🔄 Falling back to local JSON storage for seamless operation.');
    });
} else {
  console.log('ℹ️ MONGODB_URI not configured in .env. Running on local JSON storage mode.');
}

// Local JSON Storage Helpers (fallback)
function getLocalMembers() {
  try {
    const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveLocalMembers(members) {
  fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(members, null, 2), 'utf8');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Cloud Platform Health Check Route
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Simple Auth Middleware for Admin Routes
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized. Admin password required.' });
}

// --- API ROUTES ---

// 1. Admin Login Endpoint
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: ADMIN_PASSWORD, message: 'Login successful' });
  }
  return res.status(401).json({ success: false, message: 'Invalid Admin Password.' });
});

// 2. High-Performance Paginated Admin Members API (Supports 50 rows/page, Lakhs of records)
app.get('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const isExport = req.query.all === 'true';
    const limit = isExport ? 100000 : Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();

    if (isMongoConnected) {
      const query = {};
      if (status && status !== 'all') {
        query.paymentStatus = status;
      }
      if (search) {
        const cleanDigits = search.replace(/\D/g, '');
        const searchOr = [
          { fullName: { $regex: search, $options: 'i' } },
          { memberId: { $regex: search, $options: 'i' } },
          { address: { $regex: search, $options: 'i' } }
        ];
        if (cleanDigits) {
          searchOr.push({ mobileNo: { $regex: cleanDigits } });
        }
        query.$or = searchOr;
      }

      const totalCount = await Member.countDocuments(query);
      const members = await Member.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      return res.json({
        success: true,
        count: members.length,
        totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit) || 1,
        members
      });
    } else {
      // Local JSON File Mode
      let members = getLocalMembers();
      if (status && status !== 'all') {
        members = members.filter(m => (m.paymentStatus || '').toLowerCase() === status.toLowerCase());
      }
      if (search) {
        const q = search.toLowerCase();
        const cleanDigits = search.replace(/\D/g, '');
        members = members.filter(m =>
          (m.fullName && m.fullName.toLowerCase().includes(q)) ||
          (m.memberId && m.memberId.toString().toLowerCase().includes(q)) ||
          (m.address && m.address.toLowerCase().includes(q)) ||
          (cleanDigits && m.mobileNo && m.mobileNo.replace(/\D/g, '').includes(cleanDigits))
        );
      }

      const totalCount = members.length;
      members.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      const paginatedMembers = isExport ? members : members.slice(skip, skip + limit);

      return res.json({
        success: true,
        count: paginatedMembers.length,
        totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit) || 1,
        members: paginatedMembers
      });
    }
  } catch (err) {
    console.error('Fetch members error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch members: ' + err.message });
  }
});

// 3. Search Member by Member ID or Mobile Number
app.get('/api/members/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, message: 'Search query required.' });
    }

    const cleanQ = q.replace(/\D/g, '');
    let member = null;

    if (isMongoConnected) {
      member = await Member.findOne({
        $or: [
          { memberId: q },
          { memberId: cleanQ },
          { mobileNo: cleanQ },
          { fullName: { $regex: new RegExp('^' + q + '$', 'i') } }
        ]
      });
    } else {
      const members = getLocalMembers();
      member = members.find(m => 
        (m.memberId && m.memberId.toString() === q) ||
        (cleanQ && m.memberId && m.memberId.toString().replace(/\D/g, '') === cleanQ) ||
        (cleanQ && m.mobileNo && m.mobileNo.replace(/\D/g, '') === cleanQ) ||
        (m.fullName && m.fullName.toLowerCase() === q.toLowerCase())
      );
    }

    if (!member) {
      return res.status(404).json({ success: false, message: `No record found matching "${q}".` });
    }

    return res.json({ success: true, member });
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ success: false, message: 'Search failed.' });
  }
});

// 4. Register New Member
app.post('/api/members', async (req, res) => {
  try {
    const data = req.body;

    if (!data.fullName || !data.mobileNo) {
      return res.status(400).json({ success: false, message: 'Name and Mobile Number are required.' });
    }

    const cleanMobile = data.mobileNo.replace(/\D/g, '');

    // Check for existing mobile number
    let existing = null;
    if (isMongoConnected) {
      existing = await Member.findOne({ mobileNo: cleanMobile });
    } else {
      const members = getLocalMembers();
      existing = members.find(m => (m.mobileNo || '').replace(/\D/g, '') === cleanMobile);
    }

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A member with mobile number ${data.mobileNo} is already registered with Member ID: ${existing.memberId}`
      });
    }

    // Generate unique sequential Member ID
    let nextIdNumber = 1001;
    if (isMongoConnected) {
      const last = await Member.findOne().sort({ createdAt: -1 });
      if (last && last.memberId) {
        const parsed = parseInt(last.memberId.replace(/\D/g, ''), 10);
        if (!isNaN(parsed)) nextIdNumber = parsed + 1;
      }
    } else {
      const members = getLocalMembers();
      if (members.length > 0) {
        const last = members[members.length - 1];
        if (last && last.memberId) {
          const parsed = parseInt(last.memberId.replace(/\D/g, ''), 10);
          if (!isNaN(parsed)) nextIdNumber = parsed + 1;
        }
      }
    }

    const memberId = nextIdNumber.toString();
    const receiptNo = `NAWS-REC-${memberId}`;

    const newMemberData = {
      ...data,
      mobileNo: cleanMobile,
      memberId,
      receiptNo,
      joiningDate: data.joiningDate || new Date().toLocaleDateString('en-GB').replace(/\//g, '-'),
      validityUpto: data.validityUpto || '31-12-2026',
      designation: data.designation || 'Member',
      paymentStatus: data.paymentStatus || 'Pending',
      amountPaid: data.amountPaid ? Number(data.amountPaid) : 1100,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (isMongoConnected) {
      const saved = await Member.create(newMemberData);
      return res.json({ success: true, memberId, member: saved });
    } else {
      const members = getLocalMembers();
      members.push(newMemberData);
      saveLocalMembers(members);
      return res.json({ success: true, memberId, member: newMemberData });
    }
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ success: false, message: 'Server error saving member: ' + err.message });
  }
});

// 5. Update Payment Status / Details (Verification)
app.put('/api/members/:memberId/payment', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { paymentStatus, transactionRef, payerUpiId, amountPaid } = req.body;

    if (isMongoConnected) {
      const member = await Member.findOne({
        $or: [{ memberId }, { memberId: memberId.replace(/\D/g, '') }]
      });

      if (!member) {
        return res.status(404).json({ success: false, message: 'Member record not found.' });
      }

      if (paymentStatus) member.paymentStatus = paymentStatus;
      if (transactionRef) member.transactionRef = transactionRef;
      if (payerUpiId) member.payerUpiId = payerUpiId;
      if (amountPaid) member.amountPaid = Number(amountPaid);
      member.updatedAt = new Date();

      await member.save();
      return res.json({ success: true, member });
    } else {
      const members = getLocalMembers();
      const idx = members.findIndex(m => 
        (m.memberId && m.memberId.toString() === memberId) ||
        (m.memberId && m.memberId.toString().replace(/\D/g, '') === memberId.replace(/\D/g, ''))
      );

      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Member record not found.' });
      }

      if (paymentStatus) members[idx].paymentStatus = paymentStatus;
      if (transactionRef) members[idx].transactionRef = transactionRef;
      if (payerUpiId) members[idx].payerUpiId = payerUpiId;
      if (amountPaid) members[idx].amountPaid = Number(amountPaid);
      members[idx].updatedAt = new Date().toISOString();

      saveLocalMembers(members);
      return res.json({ success: true, member: members[idx] });
    }
  } catch (err) {
    console.error('Update payment error:', err);
    return res.status(500).json({ success: false, message: 'Update failed: ' + err.message });
  }
});

// 6. Delete Member (Admin Only)
app.delete('/api/admin/members/:memberId', requireAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;

    if (isMongoConnected) {
      const result = await Member.deleteOne({
        $or: [{ memberId }, { memberId: memberId.replace(/\D/g, '') }]
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'Member not found.' });
      }
      return res.json({ success: true, message: 'Member deleted successfully.' });
    } else {
      const members = getLocalMembers();
      const initialLen = members.length;
      const filtered = members.filter(m => 
        m.memberId !== memberId && 
        (m.memberId ? m.memberId.toString().replace(/\D/g, '') !== memberId.replace(/\D/g, '') : true)
      );

      if (filtered.length === initialLen) {
        return res.status(404).json({ success: false, message: 'Member not found.' });
      }

      saveLocalMembers(filtered);
      return res.json({ success: true, message: 'Member deleted successfully.' });
    }
  } catch (err) {
    console.error('Delete member error:', err);
    return res.status(500).json({ success: false, message: 'Delete failed.' });
  }
});

// 7. Route for Admin Dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Global Error Handler (catches invalid JSON body, etc.)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, message: 'Invalid JSON payload provided.' });
  }
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// Start Server - explicitly bind to 0.0.0.0 for Cloud & Docker compatibility
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Naujwan Aggarwal Welfare Society Portal is live!`);
  console.log(`🌐 Listening on:               0.0.0.0:${PORT}`);
  console.log(`📱 Public Registration Portal: http://localhost:${PORT}`);
  console.log(`👑 Owner Admin Dashboard:      http://localhost:${PORT}/admin`);
  console.log(`💾 Storage Engine:             ${isMongoConnected ? 'MongoDB' : 'Local File (data/members.json)'}`);
  console.log(`====================================================`);
});

// Graceful shutdown handling for Cloud Orchestrators (Render / Railway / Docker SIGTERM)
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Closing HTTP server gracefully...');
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT signal. Closing HTTP server gracefully...');
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });
});


// -------------------------------------------------------------
// CRASH-PREVENTION & RENDER 24/7 KEEP-ALIVE SYSTEM
// -------------------------------------------------------------

// 1. Prevent unexpected Node process exits from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('🛡️ Process Guard - Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🛡️ Process Guard - Unhandled Promise Rejection at:', promise, 'reason:', reason);
});

// 2. Automatic Keep-Alive Self-Pinger (Keeps Render Free Tier 24/7 Awake)
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
if (APP_URL) {
  const PING_INTERVAL_MS = 12 * 60 * 1000; // Ping every 12 mins (Render sleeps after 15 mins)
  setInterval(async () => {
    try {
      const pingUrl = APP_URL.endsWith('/') ? `${APP_URL}health` : `${APP_URL}/health`;
      const res = await fetch(pingUrl);
      console.log(`[Keep-Alive] Pinged ${pingUrl} (HTTP ${res.status}) at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.warn(`[Keep-Alive] Ping warning:`, err.message);
    }
  }, PING_INTERVAL_MS);
  console.log(`⏱️ Render Keep-Alive Active: Pinging ${APP_URL} every 12 minutes to prevent sleep.`);
}

const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {}

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

// Helpers for Local JSON Database Mode
function getLocalMembers() {
  try {
    if (!fs.existsSync(LOCAL_DB_FILE)) return [];
    const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Error reading local members.json:', e);
    return [];
  }
}

function saveLocalMembers(members) {
  try {
    fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(members, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving local members.json:', e);
  }
}

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Cloud Platform Health Check Route
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Security Guard for Admin Routes
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

// 2. Admin Statistics API
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    if (isMongoConnected) {
      const totalMembers = await Member.countDocuments();
      const completedPayments = await Member.countDocuments({ paymentStatus: 'Completed' });
      const pendingPayments = await Member.countDocuments({ paymentStatus: 'Pending' });

      const sumAgg = await Member.aggregate([
        { $match: { paymentStatus: 'Completed' } },
        { $group: { _id: null, total: { $sum: '$amountPaid' } } }
      ]);
      const totalFundsCollected = sumAgg.length > 0 ? (sumAgg[0].total || 0) : 0;

      return res.json({
        success: true,
        stats: {
          totalMembers,
          completedPayments,
          pendingPayments,
          totalFundsCollected,
          storageMode: 'MongoDB Atlas'
        }
      });
    } else {
      const members = getLocalMembers();
      const totalMembers = members.length;
      const completedPayments = members.filter(m => (m.paymentStatus || '').toLowerCase() === 'completed').length;
      const pendingPayments = members.filter(m => (m.paymentStatus || '').toLowerCase() === 'pending').length;
      const totalFundsCollected = members
        .filter(m => (m.paymentStatus || '').toLowerCase() === 'completed')
        .reduce((sum, m) => sum + (Number(m.amountPaid) || 1100), 0);

      return res.json({
        success: true,
        stats: {
          totalMembers,
          completedPayments,
          pendingPayments,
          totalFundsCollected,
          storageMode: 'Local JSON Storage'
        }
      });
    }
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch statistics.' });
  }
});

// 3. High-Performance Paginated Admin Members API (Supports 50 rows/page, Lakhs of records)
app.get('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const isExport = req.query.all === 'true';
    const limit = isExport ? 100000 : Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();
    const constituency = (req.query.constituency || '').trim();

    const isAllStatus = !status || status.toLowerCase() === 'all';
    const isAllConstituency = !constituency || constituency.toLowerCase() === 'all';

    if (isMongoConnected) {
      const query = {};
      if (!isAllStatus) {
        query.paymentStatus = { $regex: new RegExp('^' + status + '$', 'i') };
      }
      if (!isAllConstituency) {
        query.constituency = { $regex: new RegExp('^' + constituency + '$', 'i') };
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
      if (!isAllStatus) {
        members = members.filter(m => (m.paymentStatus || '').toLowerCase() === status.toLowerCase());
      }
      if (!isAllConstituency) {
        members = members.filter(m => (m.constituency || '').toLowerCase() === constituency.toLowerCase());
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

// 4. Search Member by Member ID or Mobile Number
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

// 5. Register New Member
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
    return res.status(500).json({ success: false, message: 'Registration failed: ' + err.message });
  }
});

// 6. Verify / Update Member Payment Status
app.put('/api/members/:memberId/payment', requireAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;
    const { paymentStatus, amountPaid, transactionRef } = req.body;

    const updateFields = {
      paymentStatus: paymentStatus || 'Completed',
      amountPaid: amountPaid ? Number(amountPaid) : 1100,
      transactionRef: transactionRef || '',
      updatedAt: new Date().toISOString()
    };

    if (isMongoConnected) {
      const updated = await Member.findOneAndUpdate(
        { $or: [{ memberId }, { memberId: memberId.replace(/\D/g, '') }] },
        { $set: updateFields },
        { new: true }
      );
      if (!updated) {
        return res.status(404).json({ success: false, message: 'Member not found.' });
      }
      return res.json({ success: true, member: updated });
    } else {
      const members = getLocalMembers();
      const idx = members.findIndex(m => 
        m.memberId === memberId || 
        (m.memberId && m.memberId.toString().replace(/\D/g, '') === memberId.replace(/\D/g, ''))
      );
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Member not found.' });
      }
      members[idx] = { ...members[idx], ...updateFields };
      saveLocalMembers(members);
      return res.json({ success: true, member: members[idx] });
    }
  } catch (err) {
    console.error('Payment update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update payment.' });
  }
});

// 7. Delete Member Record (Admin only)
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

// 8. Route for Admin Dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, message: 'Invalid JSON payload provided.' });
  }
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// Start Server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Naujwan Aggarwal Welfare Society Portal is live!`);
  console.log(`🌐 Listening on:               0.0.0.0:${PORT}`);
  console.log(`📱 Public Registration Portal: http://localhost:${PORT}`);
  console.log(`👑 Owner Admin Dashboard:      http://localhost:${PORT}/admin`);
  console.log(`💾 Storage Engine:             ${isMongoConnected ? 'MongoDB' : 'Local File (data/members.json)'}`);
  console.log(`====================================================`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Closing HTTP server gracefully...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Received SIGINT signal. Closing HTTP server gracefully...');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('🛡️ Process Guard - Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🛡️ Process Guard - Unhandled Promise Rejection at:', promise, 'reason:', reason);
});

// Automatic Keep-Alive Self-Pinger for Render
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
if (APP_URL) {
  const PING_INTERVAL_MS = 12 * 60 * 1000;
  setInterval(async () => {
    try {
      const pingUrl = APP_URL.endsWith('/') ? `${APP_URL}health` : `${APP_URL}/health`;
      const res = await fetch(pingUrl);
      console.log(`[Keep-Alive] Pinged ${pingUrl} (HTTP ${res.status}) at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.warn(`[Keep-Alive] Ping warning:`, err.message);
    }
  }, PING_INTERVAL_MS);
}

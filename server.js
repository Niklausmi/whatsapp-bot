const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// Multer for file uploads
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ─── WhatsApp Client ───────────────────────────────────────────────────────────
let client = null;
let clientStatus = 'disconnected'; // disconnected | qr | connecting | ready
let currentQR = null;
let groups = [];

function createClient() {
  if (client) {
    try { client.destroy(); } catch (e) {}
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    currentQR = await QRCode.toDataURL(qr);
    clientStatus = 'qr';
    io.emit('status', { status: 'qr', qr: currentQR });
    console.log('QR generated');
  });

  client.on('authenticated', () => {
    clientStatus = 'connecting';
    currentQR = null;
    io.emit('status', { status: 'connecting' });
    console.log('Authenticated');
  });

  client.on('ready', async () => {
    clientStatus = 'ready';
    currentQR = null;
    // Fetch groups
    try {
      const chats = await client.getChats();
      groups = chats
        .filter(c => c.isGroup)
        .map(c => ({ id: c.id._serialized, name: c.name, participants: c.participants?.length || 0 }));
    } catch (e) {
      groups = [];
    }
    io.emit('status', { status: 'ready' });
    io.emit('groups', groups);
    console.log('WhatsApp Ready!');
  });

  client.on('disconnected', (reason) => {
    clientStatus = 'disconnected';
    groups = [];
    io.emit('status', { status: 'disconnected', reason });
    console.log('Disconnected:', reason);
  });

  client.initialize();
}

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Frontend connected');
  // Send current state immediately
  socket.emit('status', { status: clientStatus, qr: currentQR });
  if (groups.length) socket.emit('groups', groups);

  socket.on('disconnect', () => console.log('Frontend disconnected'));
});

// ─── REST API ──────────────────────────────────────────────────────────────────

// Start / connect WhatsApp
app.post('/api/connect', (req, res) => {
  if (clientStatus === 'ready') return res.json({ success: true, status: 'already_ready' });
  createClient();
  res.json({ success: true, message: 'Initializing WhatsApp...' });
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
  if (client) {
    try { await client.logout(); } catch (e) {}
    try { await client.destroy(); } catch (e) {}
    client = null;
  }
  clientStatus = 'disconnected';
  groups = [];
  io.emit('status', { status: 'disconnected' });
  res.json({ success: true });
});

// Status
app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, qr: currentQR });
});

// Get groups
app.get('/api/groups', (req, res) => {
  res.json({ groups });
});

// Get group members
app.get('/api/groups/:groupId/members', async (req, res) => {
  if (clientStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp not ready' });
  try {
    const chat = await client.getChatById(req.params.groupId);
    const members = chat.participants.map(p => ({
      number: p.id.user,
      id: p.id._serialized,
      isAdmin: p.isAdmin
    }));
    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse Excel file → return contacts
app.post('/api/parse-excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.unlinkSync(req.file.path);

    // Auto-detect columns
    const sample = data[0] || {};
    const keys = Object.keys(sample);

    const contacts = data.map((row, i) => {
      // Try common column name patterns for phone
      const numberKey = keys.find(k =>
        /phone|number|mobile|cell|whatsapp|no\.|tel/i.test(k)
      ) || keys[0];
      // Try common column name patterns for message
      const msgKey = keys.find(k =>
        /message|msg|text|content/i.test(k)
      );
      // Try common column name patterns for name
      const nameKey = keys.find(k =>
        /name|contact|person/i.test(k)
      );

      return {
        id: i,
        number: String(row[numberKey] || '').replace(/\D/g, ''),
        name: nameKey ? String(row[nameKey] || '') : '',
        message: msgKey ? String(row[msgKey] || '') : '',
        rawRow: row
      };
    }).filter(c => c.number.length >= 7);

    res.json({ contacts, columns: keys, total: contacts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send messages
app.post('/api/send', async (req, res) => {
  if (clientStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp not ready' });

  const { recipients, template, delay = 3000 } = req.body;
  // recipients: [{ number, name, customMessage }]
  // template: string with {{name}} placeholders

  if (!recipients?.length) return res.status(400).json({ error: 'No recipients' });

  const jobId = Date.now().toString();
  res.json({ success: true, jobId, total: recipients.length });

  // Run async
  (async () => {
    let sent = 0, failed = 0;

    for (const recipient of recipients) {
      const number = String(recipient.number).replace(/\D/g, '');
      const chatId = number.includes('@') ? number : `${number}@c.us`;

      // Build message
      let message = recipient.customMessage || template || '';
      message = message.replace(/\{\{name\}\}/gi, recipient.name || number);
      message = message.replace(/\{\{number\}\}/gi, number);

      try {
        await client.sendMessage(chatId, message);
        sent++;
        io.emit('send_progress', {
          jobId, sent, failed,
          total: recipients.length,
          current: { number, status: 'sent' }
        });
      } catch (e) {
        failed++;
        io.emit('send_progress', {
          jobId, sent, failed,
          total: recipients.length,
          current: { number, status: 'failed', error: e.message }
        });
      }

      // Delay between messages to avoid ban
      if (sent + failed < recipients.length) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

    io.emit('send_complete', { jobId, sent, failed, total: recipients.length });
  })();
});

// ─── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../')));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, '../index.html'));
  }
  next();
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

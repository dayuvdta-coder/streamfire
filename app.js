const express = require('express');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const { randomBytes } = require('crypto');
require('dotenv').config();
const { ensureRuntimeDirs, getUploadPath, getDbPath } = require('./src/config/runtimePaths');

if (!String(process.env.UPLOAD_PATH || '').trim()) {
  process.env.UPLOAD_PATH = getUploadPath();
}
if (!String(process.env.DB_PATH || '').trim()) {
  process.env.DB_PATH = getDbPath();
}

const runtimePaths = ensureRuntimeDirs();
const UPLOAD_PATH = runtimePaths.uploadPath;
const DB_DIR = runtimePaths.dbDir;

const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim() || randomBytes(32).toString('hex');
if (!String(process.env.SESSION_SECRET || '').trim()) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  console.warn('[BOOT] SESSION_SECRET is empty; generated ephemeral secret for this runtime.');
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
global.io = io;

const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const db = require('./src/models/database');
const PORT = process.env.PORT || 7575;
const PUBLIC_IP = process.env.PUBLIC_IP || process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost';
const ACTIVITY_LOG_LIMIT = Math.max(100, Math.min(2000, Number(process.env.ACTIVITY_LOG_LIMIT || 500)));
const HTTP_REQUEST_LOGS = String(process.env.HTTP_REQUEST_LOGS ?? (process.env.NODE_ENV === 'production' ? '0' : '1')) === '1';
const streamRoutes = require('./src/routes/streamRoutes');
const uploadRoutes = require('./src/routes/uploadRoutes');
const galleryRoutes = require('./src/routes/galleryRoutes');
const videoRoutes = require('./src/routes/videoRoutes');
const instagramRoutes = require('./src/routes/instagramRoutes');
const multiChatRoutes = require('./src/routes/multiChatRoutes');
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const systemRoutes = require('./src/routes/systemRoutes');
const instagramService = require('./src/services/instagramLiveService');
const multiChatService = require('./src/services/multiPlatformChatService');
const { checkAuth, checkSetup } = require('./src/middleware/auth');
const i18n = require('./src/middleware/i18n');

global.streamProcesses = {};
global.activityLogs = [];

app.use(cors());
app.use((req, res, next) => {
  if (HTTP_REQUEST_LOGS) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_PATH));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DB_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(checkSetup);
app.use((req, res, next) => {
  if (req.path.startsWith('/uploads') ||
    req.path.startsWith('/css') ||
    req.path.startsWith('/js') ||
    req.path.startsWith('/img') ||
    req.path.startsWith('/login') ||
    req.path.startsWith('/setup') ||
    req.path.startsWith('/logout')) {
    return next();
  }
  checkAuth(req, res, next);
});

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

app.use(i18n);

app.use('/api/system', systemRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/api/multichat', multiChatRoutes);
global.addLog = (message, type = 'info') => {
  const log = {
    time: new Date().toLocaleTimeString(),
    message,
    type
  };
  global.activityLogs.push(log);
  if (global.activityLogs.length > ACTIVITY_LOG_LIMIT) global.activityLogs.shift();
  io.emit('newLog', log);
};

app.get('/', (req, res) => {
  db.all("SELECT * FROM videos WHERE filename IS NOT NULL AND filename != '' ORDER BY id DESC", [], (err, rows) => {
    const videos = (rows || []).map(v => {
      try {
        v.destinations = v.destinations ? JSON.parse(v.destinations) : [];
      } catch (e) {
        v.destinations = [];
      }
      return v;
    });

    res.render('index', {
      title: 'Streamingku',
      videos: videos,
      error: err ? err.message : null,
      path: '/'
    });
  });
});

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/gallery', galleryRoutes);
app.use('/api/video', videoRoutes);

io.on('connection', (socket) => {
  socket.emit('logsInit', (global.activityLogs || []).slice());

  const statusList = Object.keys(global.streamProcesses).map(id => {
    const item = global.streamProcesses[id] || {};
    return {
      videoId: id,
      pid: item.pid || null,
      running: !item.restarting,
      restarting: Boolean(item.restarting),
      restartCount: Number(item.restartCount || 0),
      startTime: item.startTime || null,
    };
  });
  socket.emit('streamStatuses', statusList);
});

app.use((req, res) => {
  if (HTTP_REQUEST_LOGS) {
    console.log(`[${new Date().toISOString()}] 404 FALLTHROUGH: ${req.method} ${req.path}`);
  }
  res.status(404).send('Route not found');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} sedang dipakai proses lain.`);
    console.error(`Hentikan proses lama dulu (contoh: fuser -k ${PORT}/tcp atau pkill -f "node app.js"), lalu jalankan ulang.`);
  } else {
    console.error('Server listen error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`Streamingku Running!`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Public:  http://${PUBLIC_IP}:${PORT}`);
  console.log(`==================================================\n`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Closing resources...`);
  await instagramService.close().catch(() => { });
  await multiChatService.close().catch(() => { });
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

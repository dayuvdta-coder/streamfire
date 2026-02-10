const express = require('express');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
global.io = io;

const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const db = require('./src/models/database');
const PORT = process.env.PORT || 7575;
const PUBLIC_IP = process.env.PUBLIC_IP || 'localhost';
const streamRoutes = require('./src/routes/streamRoutes');
const uploadRoutes = require('./src/routes/uploadRoutes');
const galleryRoutes = require('./src/routes/galleryRoutes');
const videoRoutes = require('./src/routes/videoRoutes');
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const systemRoutes = require('./src/routes/systemRoutes');
const { checkAuth, checkSetup } = require('./src/middleware/auth');
const i18n = require('./src/middleware/i18n');

global.streamProcesses = {};
global.activityLogs = [];

app.use(cors());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
  secret: process.env.SESSION_SECRET || 'secret_key',
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
global.addLog = (message, type = 'info') => {
  const log = {
    time: new Date().toLocaleTimeString(),
    message,
    type
  };
  global.activityLogs.push(log);
  if (global.activityLogs.length > 50) global.activityLogs.shift();
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
      title: 'StreamFire',
      videos: videos,
      error: err ? err.message : null,
      path: '/'
    });
  });
});

app.get('/donation', (req, res) => {
  res.render('donation', { title: 'Support Developer', path: '/donation' });
});

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/gallery', galleryRoutes);
app.use('/api/video', videoRoutes);

io.on('connection', (socket) => {
  const statusList = Object.keys(global.streamProcesses).map(id => ({
    videoId: id, running: true
  }));
  socket.emit('streamStatuses', statusList);
});

app.use((req, res) => {
  console.log(`[${new Date().toISOString()}] 404 FALLTHROUGH: ${req.method} ${req.path}`);
  res.status(404).send('Route not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`StreamFire Running!`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Public:  http://${PUBLIC_IP}:${PORT}`);
  console.log(`==================================================\n`);
});
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');

function resolveRuntimePath(rawValue, fallbackAbsPath) {
  const raw = String(rawValue || '').trim();
  if (!raw) return fallbackAbsPath;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(APP_ROOT, raw);
}

function getUploadPath() {
  return resolveRuntimePath(process.env.UPLOAD_PATH, path.join(APP_ROOT, 'public', 'uploads'));
}

function getDbPath() {
  return resolveRuntimePath(process.env.DB_PATH, path.join(APP_ROOT, 'db', 'streamfire.db'));
}

function getLogPath() {
  return resolveRuntimePath(process.env.LOG_PATH, path.join(APP_ROOT, 'logs'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureRuntimeDirs() {
  const uploadPath = getUploadPath();
  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);
  const logPath = getLogPath();

  ensureDir(dbDir);
  ensureDir(uploadPath);
  ensureDir(path.join(uploadPath, 'thumbnails'));
  ensureDir(path.join(uploadPath, 'avatars'));
  ensureDir(logPath);

  return {
    appRoot: APP_ROOT,
    uploadPath,
    dbPath,
    dbDir,
    logPath,
  };
}

module.exports = {
  APP_ROOT,
  resolveRuntimePath,
  getUploadPath,
  getDbPath,
  getLogPath,
  ensureRuntimeDirs,
};

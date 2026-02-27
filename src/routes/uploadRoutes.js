const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = 'ffmpeg';
const ytDlpPath = process.env.YT_DLP_BIN || 'yt-dlp';
const db = require('../models/database');
const logger = require('../utils/logger');
const { getUploadPath } = require('../config/runtimePaths');
const router = express.Router();

const MAX_UPLOAD_BYTES = 2048 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.flv', '.ts']);

function ensureUploadDir() {
  const uploadPath = getUploadPath();
  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }
  return uploadPath;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, ensureUploadDir());
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '.mp4');
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const output = String(stderr || stdout || `exit code ${code}`).trim();
        reject(new Error(output || `Command "${command}" failed`));
      }
    });
  });
}

function safeTitle(raw, fallback) {
  const value = String(raw || '').trim();
  if (value) return value.slice(0, 120);
  return String(fallback || 'Downloaded Video').slice(0, 120);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function makeUniqueBaseName(prefix = 'video') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}

async function generateThumbnail(videoFilePath, filename) {
  const thumbnailDir = path.join(getUploadPath(), 'thumbnails');
  if (!fs.existsSync(thumbnailDir)) fs.mkdirSync(thumbnailDir, { recursive: true });
  const thumbnailPath = path.join(thumbnailDir, `${filename}.jpg`);
  await runCommand(ffmpegPath, ['-y', '-i', videoFilePath, '-ss', '00:00:01', '-vframes', '1', thumbnailPath]);
  return path.basename(thumbnailPath);
}

function saveToDatabase(title, filename, thumbnailName) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO videos (title, filename, thumbnail, views) VALUES (?, ?, ?, 0)',
      [title, filename, thumbnailName || null],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function findDownloadedFile(uploadPath, baseName) {
  const files = fs.readdirSync(uploadPath)
    .filter((name) => name.startsWith(`${baseName}.`) && !name.endsWith('.part'))
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => {
      const abs = path.join(uploadPath, name);
      const stat = fs.statSync(abs);
      return {
        abs,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0] ? files[0].abs : '';
}

async function persistVideo({ title, filename, absoluteVideoPath }) {
  let thumbnailName = null;

  try {
    thumbnailName = await generateThumbnail(absoluteVideoPath, filename);
  } catch (err) {
    logger.error(`Thumbnail failed for ${filename}: ${err.message}`);
  }

  const videoId = await saveToDatabase(title, filename, thumbnailName);
  return { videoId, thumbnailName };
}

router.post('/local', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const fallbackTitle = path.parse(req.file.originalname || req.file.filename || '').name || 'Uploaded Video';
  const title = safeTitle(req.body && req.body.title, fallbackTitle);

  try {
    const result = await persistVideo({
      title,
      filename: req.file.filename,
      absoluteVideoPath: req.file.path,
    });
    res.json({ message: 'Success', videoId: result.videoId });
  } catch (err) {
    logger.error(`Local upload DB insert error: ${err.message}`);
    res.status(500).json({ message: 'DB Error: ' + err.message });
  }
});

router.post('/url', async (req, res) => {
  const sourceUrl = String(req.body && (req.body.url || req.body.sourceUrl) || '').trim();

  if (!isHttpUrl(sourceUrl)) {
    return res.status(400).json({ message: 'Link tidak valid. Gunakan URL http/https.' });
  }

  const uploadPath = ensureUploadDir();
  const baseName = makeUniqueBaseName('yt');
  const outputTemplate = path.join(uploadPath, `${baseName}.%(ext)s`);

  try {
    await runCommand(ytDlpPath, [
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',
      '--no-part',
      '--max-filesize',
      '2G',
      '--merge-output-format',
      'mp4',
      '-f',
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
      '-o',
      outputTemplate,
      sourceUrl,
    ]);
  } catch (err) {
    logger.error(`yt-dlp download failed (${sourceUrl}): ${err.message}`);
    return res.status(500).json({ message: `Download gagal: ${err.message}` });
  }

  const downloadedPath = findDownloadedFile(uploadPath, baseName);
  if (!downloadedPath) {
    logger.error(`Download completed but file not found for ${sourceUrl}`);
    return res.status(500).json({ message: 'Download selesai, tapi file video tidak ditemukan.' });
  }

  const filename = path.basename(downloadedPath);
  const fallbackTitle = path.parse(filename).name.replace(/[-_]+/g, ' ').trim() || 'Downloaded Video';
  const title = safeTitle(req.body && req.body.title, fallbackTitle);

  try {
    const result = await persistVideo({
      title,
      filename,
      absoluteVideoPath: downloadedPath,
    });
    return res.json({
      message: 'Success',
      videoId: result.videoId,
      filename,
    });
  } catch (err) {
    logger.error(`Failed to save downloaded video ${filename}: ${err.message}`);
    return res.status(500).json({ message: 'Video terdownload, tapi gagal masuk galeri.' });
  }
});

module.exports = router;

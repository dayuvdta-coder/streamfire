const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../models/database');
const logger = require('../utils/logger');
const { getUploadPath } = require('../config/runtimePaths');

const router = express.Router();
const FFMPEG_BIN = String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';

function parseVideoId(raw) {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function getVideoById(videoId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, filename, thumbnail, title FROM videos WHERE id = ?', [videoId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function insertVideo({ title, filename, thumbnail }) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO videos (title, filename, thumbnail, views, destinations, start_time) VALUES (?, ?, ?, 0, ?, NULL)',
      [title, filename, thumbnail || null, '[]'],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function deleteVideoFromDb(videoId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM videos WHERE id = ?', [videoId], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => { });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeWatermarkPosition(value) {
  const allowed = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
  return allowed.has(value) ? value : 'bottom-right';
}

function resolveWatermarkPosition(position, margin) {
  switch (position) {
    case 'top-left':
      return { x: `${margin}`, y: `${margin}` };
    case 'top-right':
      return { x: `w-tw-${margin}`, y: `${margin}` };
    case 'bottom-left':
      return { x: `${margin}`, y: `h-th-${margin}` };
    case 'center':
      return { x: '(w-tw)/2', y: '(h-th)/2' };
    case 'bottom-right':
    default:
      return { x: `w-tw-${margin}`, y: `h-th-${margin}` };
  }
}

function escapeDrawText(raw) {
  return String(raw || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const lines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const tail = lines.slice(-8).join(' | ');
      reject(new Error(tail || `ffmpeg exited with code ${code}`));
    });
  });
}

async function generateThumbnail(videoFilePath, thumbnailFilePath) {
  const args = ['-y', '-i', videoFilePath, '-ss', '00:00:01', '-vframes', '1', thumbnailFilePath];
  await runFfmpeg(args);
}

router.post('/:id/watermark', async (req, res) => {
  const videoId = parseVideoId(req.params.id);
  if (!videoId) {
    return res.status(400).json({ ok: false, error: 'Video ID tidak valid.' });
  }

  const watermarkText = String(req.body.watermarkText || '').trim().slice(0, 100);
  if (!watermarkText) {
    return res.status(400).json({ ok: false, error: 'Teks watermark wajib diisi.' });
  }

  const uploadPath = getUploadPath();
  const position = sanitizeWatermarkPosition(String(req.body.position || 'bottom-right').trim());
  const fontSize = Math.round(clampNumber(req.body.fontSize, 16, 96, 28));
  const opacity = clampNumber(req.body.opacity, 0.15, 1, 0.85);
  const margin = Math.round(clampNumber(req.body.margin, 8, 80, 24));
  const outputTitleInput = String(req.body.outputTitle || '').trim().slice(0, 120);

  let row;
  try {
    row = await getVideoById(videoId);
  } catch (err) {
    logger.error(`Failed to load video ${videoId}: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Gagal membaca data video.' });
  }

  if (!row || !row.filename) {
    return res.status(404).json({ ok: false, error: 'Video tidak ditemukan.' });
  }

  const inputPath = path.join(uploadPath, row.filename);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ ok: false, error: 'File video sumber tidak ditemukan.' });
  }

  const srcBase = path.parse(row.filename).name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 80) || 'video';
  const stamp = Date.now();
  const outputFilename = `${srcBase}-wm-${stamp}.mp4`;
  const outputPath = path.join(uploadPath, outputFilename);
  const thumbFilename = `${outputFilename}.jpg`;
  const thumbPath = path.join(uploadPath, 'thumbnails', thumbFilename);
  const escapedText = escapeDrawText(watermarkText);
  const pos = resolveWatermarkPosition(position, margin);
  const boxOpacity = clampNumber(opacity * 0.55, 0.2, 0.8, 0.45);
  const filter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white@${opacity.toFixed(2)}:box=1:boxcolor=black@${boxOpacity.toFixed(2)}:boxborderw=14:x=${pos.x}:y=${pos.y}`;

  try {
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vf',
      filter,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
  } catch (err) {
    logger.error(`Watermark ffmpeg failed for video ${videoId}: ${err.message}`);
    await safeUnlink(outputPath);
    return res.status(500).json({ ok: false, error: `Gagal proses watermark: ${err.message}` });
  }

  try {
    await generateThumbnail(outputPath, thumbPath);
  } catch (err) {
    logger.warn(`Thumbnail generation failed for ${outputFilename}: ${err.message}`);
  }

  const outputTitle = outputTitleInput || `${row.title || 'Video'} (Watermark)`;

  try {
    const newId = await insertVideo({
      title: outputTitle,
      filename: outputFilename,
      thumbnail: fs.existsSync(thumbPath) ? thumbFilename : null,
    });

    return res.json({
      ok: true,
      message: 'Video watermark berhasil dibuat.',
      video: {
        id: newId,
        title: outputTitle,
        filename: outputFilename,
        thumbnail: fs.existsSync(thumbPath) ? thumbFilename : null,
      },
    });
  } catch (err) {
    logger.error(`Failed to save edited video ${outputFilename}: ${err.message}`);
    await safeUnlink(outputPath);
    await safeUnlink(thumbPath);
    return res.status(500).json({ ok: false, error: 'Gagal menyimpan video hasil edit.' });
  }
});

router.delete('/:id', async (req, res) => {
  const videoId = parseVideoId(req.params.id);
  if (!videoId) {
    return res.status(400).json({ ok: false, message: 'Video ID tidak valid.' });
  }

  let row;
  try {
    row = await getVideoById(videoId);
  } catch (err) {
    logger.error(`Error finding video ${videoId}: ${err.message}`);
    return res.status(500).json({ ok: false, message: 'Gagal membaca data video.' });
  }

  if (!row) {
    return res.status(404).json({ ok: false, message: 'Video not found' });
  }

  const streamState = global.streamProcesses[String(videoId)] || global.streamProcesses[videoId];
  if (streamState) {
    try {
      if (streamState.proc) streamState.proc.kill('SIGKILL');
      delete global.streamProcesses[String(videoId)];
      delete global.streamProcesses[videoId];
      global.io.emit('streamStatus', { videoId, running: false, restarting: false });
    } catch (e) {
      logger.error(`Error killing process for video ${videoId}: ${e.message}`);
    }
  }

  const uploadPath = getUploadPath();
  const videoPath = row.filename ? path.join(uploadPath, row.filename) : '';
  const thumbCandidateA = row.thumbnail ? path.join(uploadPath, 'thumbnails', row.thumbnail) : '';
  const thumbCandidateB = row.thumbnail ? path.join(uploadPath, row.thumbnail) : '';

  await Promise.all([
    safeUnlink(videoPath),
    safeUnlink(thumbCandidateA),
    safeUnlink(thumbCandidateB),
  ]);

  try {
    await deleteVideoFromDb(videoId);
    logger.info(`Video ${videoId} deleted successfully`);
    return res.json({ ok: true, message: 'Video deleted successfully' });
  } catch (err) {
    logger.error(`Error deleting video ${videoId} from database: ${err.message}`);
    return res.status(500).json({ ok: false, message: 'Failed to delete video' });
  }
});

module.exports = router;

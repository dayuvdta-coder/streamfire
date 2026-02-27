const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../models/database');
const logger = require('../utils/logger');
const { getUploadPath } = require('../config/runtimePaths');

const router = express.Router();
const FFMPEG_BIN = String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
const WATERMARK_JOB_TTL_MS = Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Number(process.env.WATERMARK_JOB_TTL_MS || (6 * 60 * 60 * 1000))));
const WATERMARK_PROGRESS_INTERVAL_MS = Math.max(2000, Math.min(60000, Number(process.env.WATERMARK_PROGRESS_INTERVAL_MS || 5000)));
const watermarkJobs = new Map();

function parseVideoId(raw) {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function createJobId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}`;
}

function pruneWatermarkJobs() {
  const now = Date.now();
  for (const [jobId, job] of watermarkJobs.entries()) {
    if ((now - Number(job.updatedAtMs || job.createdAtMs || 0)) > WATERMARK_JOB_TTL_MS) {
      watermarkJobs.delete(jobId);
    }
  }
}

function createWatermarkJob(extra = {}) {
  pruneWatermarkJobs();
  const now = Date.now();
  const id = createJobId();
  const job = {
    id,
    type: 'watermark',
    status: 'queued',
    message: 'Job watermark diterima.',
    error: null,
    video: null,
    createdAtMs: now,
    updatedAtMs: now,
    ...extra,
  };
  watermarkJobs.set(id, job);
  return job;
}

function updateWatermarkJob(jobId, patch = {}) {
  const current = watermarkJobs.get(jobId);
  if (!current) return null;
  const updated = {
    ...current,
    ...patch,
    updatedAtMs: Date.now(),
  };
  watermarkJobs.set(jobId, updated);
  return updated;
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

function emitRuntimeLog(message, level = 'info') {
  const text = String(message || '').trim();
  if (!text) return;

  try {
    if (typeof global.addLog === 'function') {
      global.addLog(text, level === 'error' ? 'error' : (level === 'warn' ? 'warning' : 'info'));
    }
  } catch (_) {
    // Ignore runtime log forwarding errors
  }

  if (level === 'error') logger.error(text);
  else if (level === 'warn') logger.warn(text);
  else logger.info(text);
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

function parseClockToMs(raw) {
  const m = String(raw || '').trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return 0;
  return Math.max(0, Math.round(((hh * 3600) + (mm * 60) + ss) * 1000));
}

function formatDurationMs(rawMs) {
  const ms = Math.max(0, Number(rawMs) || 0);
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

function runFfmpeg(args, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const progressEveryMs = Math.max(1000, Math.min(60000, Number(options.progressEveryMs || WATERMARK_PROGRESS_INTERVAL_MS)));

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stderrBuf = '';
    const progress = {
      outTimeMs: 0,
      speed: '',
      lastEmitAt: 0,
    };

    const emitProgress = (force = false, state = 'continue') => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - progress.lastEmitAt < progressEveryMs) return;
      progress.lastEmitAt = now;
      onProgress({
        outTimeMs: progress.outTimeMs,
        speed: progress.speed,
        state,
      });
    };

    const consumeLine = (lineRaw) => {
      const line = String(lineRaw || '').trim();
      if (!line || !onProgress) return;
      const sep = line.indexOf('=');
      if (sep < 1) return;
      const key = line.slice(0, sep);
      const value = line.slice(sep + 1);

      if (key === 'out_time') {
        progress.outTimeMs = Math.max(progress.outTimeMs, parseClockToMs(value));
        return;
      }
      if (key === 'out_time_ms' || key === 'out_time_us') {
        const micro = Number(value);
        if (Number.isFinite(micro) && micro >= 0) {
          progress.outTimeMs = Math.max(progress.outTimeMs, Math.round(micro / 1000));
        }
        return;
      }
      if (key === 'speed') {
        progress.speed = value || progress.speed;
        return;
      }
      if (key === 'progress') {
        emitProgress(value === 'end', value || 'continue');
      }
    };

    proc.stderr.on('data', (chunk) => {
      const part = chunk.toString();
      stderr += part;
      if (!onProgress) return;

      stderrBuf += part;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      if (onProgress && stderrBuf) consumeLine(stderrBuf);
      emitProgress(true, code === 0 ? 'end' : 'error');
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

async function runWatermarkJob({
  jobId,
  videoId,
  watermarkText,
  position,
  fontSize,
  opacity,
  margin,
  outputTitleInput,
  onProgress,
}) {
  const update = typeof onProgress === 'function' ? onProgress : () => { };
  const uploadPath = getUploadPath();
  const fastMode = String(process.env.WATERMARK_FAST_MODE || '1') === '1';
  const preset = String(process.env.WATERMARK_PRESET || (fastMode ? 'ultrafast' : 'veryfast')).trim() || (fastMode ? 'ultrafast' : 'veryfast');
  const crf = Math.round(clampNumber(process.env.WATERMARK_CRF, 18, 38, fastMode ? 28 : 23));
  const maxWidth = Math.round(clampNumber(process.env.WATERMARK_MAX_WIDTH, 640, 3840, 1280));
  const maxHeight = Math.round(clampNumber(process.env.WATERMARK_MAX_HEIGHT, 360, 3840, 720));
  const maxFps = Math.round(clampNumber(process.env.WATERMARK_MAX_FPS, 15, 60, 30));
  const audioBitrateK = Math.round(clampNumber(process.env.WATERMARK_AUDIO_BITRATE_K, 64, 320, 96));
  const threads = Math.round(clampNumber(process.env.WATERMARK_THREADS, 0, 32, 0));

  update('Memuat data video...');
  let row;
  try {
    row = await getVideoById(videoId);
  } catch (err) {
    logger.error(`Failed to load video ${videoId}: ${err.message}`);
    throw new Error('Gagal membaca data video.');
  }

  if (!row || !row.filename) {
    throw new Error('Video tidak ditemukan.');
  }

  const inputPath = path.join(uploadPath, row.filename);
  if (!fs.existsSync(inputPath)) {
    throw new Error('File video sumber tidak ditemukan.');
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
  const drawTextFilter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white@${opacity.toFixed(2)}:box=1:boxcolor=black@${boxOpacity.toFixed(2)}:boxborderw=14:x=${pos.x}:y=${pos.y}`;
  const filterParts = [];
  if (fastMode) {
    filterParts.push(`fps=${maxFps}`);
    filterParts.push(`scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`);
  }
  filterParts.push(drawTextFilter);
  const filter = filterParts.join(',');

  update('Menjalankan FFmpeg...');
  const ffmpegStartMs = Date.now();
  emitRuntimeLog(`[Watermark][${jobId || '-'}] start video=${videoId} fastMode=${fastMode ? 1 : 0} preset=${preset} crf=${crf}`);

  try {
    let lastLogLine = '';
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
      preset,
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-threads',
      String(threads),
      '-c:a',
      'aac',
      '-b:a',
      `${audioBitrateK}k`,
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:2',
      '-nostats',
      outputPath,
    ], {
      progressEveryMs: WATERMARK_PROGRESS_INTERVAL_MS,
      onProgress: (p) => {
        const t = formatDurationMs(p.outTimeMs);
        const speed = String(p.speed || '').trim() || '?x';
        const message = `Menjalankan FFmpeg... ${t} @ ${speed}`;
        update(message);
        const logLine = `[Watermark][${jobId || '-'}] video=${videoId} time=${t} speed=${speed}`;
        if (logLine !== lastLogLine) {
          lastLogLine = logLine;
          emitRuntimeLog(logLine);
        }
      },
    });
    const elapsedSec = Math.max(1, Math.round((Date.now() - ffmpegStartMs) / 1000));
    emitRuntimeLog(`[Watermark][${jobId || '-'}] ffmpeg selesai dalam ${elapsedSec}s untuk video=${videoId}`);
  } catch (err) {
    logger.error(`Watermark ffmpeg failed for video ${videoId}: ${err.message}`);
    safeUnlink(outputPath);
    throw new Error(`Gagal proses watermark: ${err.message}`);
  }

  update('Membuat thumbnail...');
  try {
    await generateThumbnail(outputPath, thumbPath);
  } catch (err) {
    logger.warn(`Thumbnail generation failed for ${outputFilename}: ${err.message}`);
  }

  update('Menyimpan hasil ke galeri...');
  const outputTitle = outputTitleInput || `${row.title || 'Video'} (Watermark)`;

  try {
    const newId = await insertVideo({
      title: outputTitle,
      filename: outputFilename,
      thumbnail: fs.existsSync(thumbPath) ? thumbFilename : null,
    });

    return {
      id: newId,
      title: outputTitle,
      filename: outputFilename,
      thumbnail: fs.existsSync(thumbPath) ? thumbFilename : null,
    };
  } catch (err) {
    logger.error(`Failed to save edited video ${outputFilename}: ${err.message}`);
    safeUnlink(outputPath);
    safeUnlink(thumbPath);
    throw new Error('Gagal menyimpan video hasil edit.');
  }
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

  const payload = {
    videoId,
    watermarkText,
    position: sanitizeWatermarkPosition(String(req.body.position || 'bottom-right').trim()),
    fontSize: Math.round(clampNumber(req.body.fontSize, 16, 96, 28)),
    opacity: clampNumber(req.body.opacity, 0.15, 1, 0.85),
    margin: Math.round(clampNumber(req.body.margin, 8, 80, 24)),
    outputTitleInput: String(req.body.outputTitle || '').trim().slice(0, 120),
  };

  const job = createWatermarkJob({
    videoId,
    watermarkText,
    message: 'Job watermark dimulai...',
  });
  emitRuntimeLog(`[Watermark][${job.id}] queued untuk video=${videoId}`);

  res.status(202).json({
    ok: true,
    queued: true,
    jobId: job.id,
    status: job.status,
    message: 'Proses watermark berjalan di background.',
  });

  (async () => {
    updateWatermarkJob(job.id, { status: 'processing', message: 'Memulai proses watermark...' });
    try {
      const video = await runWatermarkJob({
        jobId: job.id,
        ...payload,
        onProgress: (message) => {
          updateWatermarkJob(job.id, { status: 'processing', message: String(message || 'Processing...').slice(0, 160) });
        },
      });

      updateWatermarkJob(job.id, {
        status: 'done',
        message: 'Video watermark berhasil dibuat.',
        error: null,
        video,
      });
      emitRuntimeLog(`[Watermark][${job.id}] done video=${videoId} outputVideoId=${video.id}`);
    } catch (err) {
      updateWatermarkJob(job.id, {
        status: 'failed',
        message: 'Proses watermark gagal.',
        error: err.message || 'Unknown error',
      });
      emitRuntimeLog(`[Watermark][${job.id}] failed video=${videoId}: ${err.message || 'Unknown error'}`, 'error');
    }
  })();
});

router.get('/watermark-job/:jobId', (req, res) => {
  pruneWatermarkJobs();
  const jobId = String(req.params.jobId || '').trim();
  if (!jobId) {
    return res.status(400).json({ ok: false, error: 'Job ID wajib diisi.' });
  }

  const job = watermarkJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job watermark tidak ditemukan.' });
  }

  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    message: job.message || '',
    error: job.error || null,
    video: job.video || null,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
  });
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

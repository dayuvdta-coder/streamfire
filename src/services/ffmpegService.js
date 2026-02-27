const ffmpegStatic = require('ffmpeg-static');
const { spawn, spawnSync } = require('child_process');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const RESTART_BASE_DELAY_MS = asPositiveInt(process.env.FFMPEG_RESTART_BASE_DELAY_MS, 3000);
const RESTART_MAX_DELAY_MS = asPositiveInt(process.env.FFMPEG_RESTART_MAX_DELAY_MS, 60000);

function resolveFfmpegBinary() {
  const candidates = [];

  if (process.env.FFMPEG_PATH) {
    candidates.push(String(process.env.FFMPEG_PATH).trim());
  }

  if (process.env.FFMPEG_USE_SYSTEM !== '0') {
    candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg');
  }

  if (ffmpegStatic) {
    candidates.push(ffmpegStatic);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
      if (!probe.error && probe.status === 0) {
        return candidate;
      }
    } catch (_) {
      // try next candidate
    }
  }

  return ffmpegStatic || 'ffmpeg';
}

const ffmpegBinary = resolveFfmpegBinary();
logger.info(`FFmpeg binary selected: ${ffmpegBinary}`);

function calcRestartDelayMs(restartCount) {
  const factor = Math.max(0, Number(restartCount) - 1);
  return Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * Math.pow(2, factor));
}

function startStream(sourceInput, settings = { bitrate: '2500k', resolution: '1280x720', fps: 30 }, loop = false, customRtmp, options = {}) {
  const inputIsUrl = Boolean(options && options.inputIsUrl);
  let inputTarget = String(sourceInput || '').trim();

  if (!inputTarget) {
    logger.error('FATAL: Input source is empty.');
    return null;
  }

  if (!inputIsUrl) {
    let absolutePath = inputTarget;
    if (!fs.existsSync(absolutePath)) {
      absolutePath = path.resolve(process.cwd(), inputTarget);
    }

    if (!fs.existsSync(absolutePath)) {
      logger.error(`FATAL: Video missing: ${absolutePath}`);
      return null;
    }
    inputTarget = absolutePath;
  } else {
    loop = false;
  }

  const bitrate = settings.bitrate || '2500k';
  const fps = settings.fps || '30';
  const bufSize = (parseInt(bitrate) * 2) + 'k';

  let targetRes = settings.resolution || '1280x720';
  let [w, h] = targetRes.split('x').map(Number);
  if (w % 2 !== 0) w--;
  if (h % 2 !== 0) h--;
  if (w === 854) w = 852;

  const vfFilter = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;

  const args = [
    ...(inputIsUrl ? [] : ['-re']),
    ...(loop ? ['-stream_loop', '-1'] : []),

    '-thread_queue_size', '1024',
    ...(inputIsUrl ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
    '-i', inputTarget,

    '-threads', '0',

    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',

    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-minrate', bitrate,
    '-bufsize', bufSize,

    '-pix_fmt', 'yuv420p',
    '-g', (parseInt(fps) * 2).toString(),
    '-r', fps,

    '-vf', vfFilter,

    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '44100',
    '-b:a', '128k',
  ];

  const destinations = (Array.isArray(customRtmp) ? customRtmp : [customRtmp])
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (destinations.length === 0) {
    logger.error('FATAL: Missing RTMP destination.');
    return null;
  }

  args.push('-map', '0:v:0', '-map', '0:a?');

  if (destinations.length === 1) {
    args.push('-f', 'flv', destinations[0]);
  } else {
    const destinationStr = destinations.map((url) => `[f=flv:onfail=ignore]${url}`).join('|');
    args.push('-f', 'tee', destinationStr);
  }

  logger.info(`System FFmpeg Start: ${w}x${h} @ ${fps}fps (outputs=${destinations.length}, source=${inputIsUrl ? 'url' : 'file'})`);

  const proc = spawn(ffmpegBinary, args);
  let lastLog = '';

  proc.on('error', (err) => {
    logger.error(`FFmpeg spawn failed (${ffmpegBinary}): ${err.message}`);
  });

  proc.stderr.on('data', data => {
    lastLog = data.toString();
  });

  proc.on('close', (code, signal) => {
    if (code !== 0 && code !== 255 && signal !== 'SIGTERM') {
      logger.error(`FFmpeg Error (${signal || code}). Log: ${lastLog.slice(-300)}`);
    } else {
      logger.info(`Stream stopped.`);
    }

    let matchedVideoId = null;
    let matchedInfo = null;

    for (let videoId in global.streamProcesses) {
      if (global.streamProcesses[videoId].pid === proc.pid) {
        matchedVideoId = videoId;
        matchedInfo = global.streamProcesses[videoId];
        break;
      }
    }

    if (!matchedVideoId || !matchedInfo) {
      return;
    }

    if (matchedInfo.owner === 'instagram') {
      return;
    }

    const shouldRestart = Boolean(matchedInfo.keepAlive) && !matchedInfo.manualStop;

    if (shouldRestart) {
      matchedInfo.restarting = true;
      matchedInfo.restartCount = Number(matchedInfo.restartCount || 0) + 1;
      const delayMs = calcRestartDelayMs(matchedInfo.restartCount);

      if (matchedInfo.restartTimer) {
        clearTimeout(matchedInfo.restartTimer);
      }

      logger.warn(
        `FFmpeg process for video ${matchedVideoId} stopped. Reconnect attempt ${matchedInfo.restartCount} in ${delayMs}ms.`
      );
      if (typeof global.addLog === 'function') {
        global.addLog(
          `Stream #${matchedVideoId} disconnected, reconnecting in ${Math.ceil(delayMs / 1000)}s (attempt ${matchedInfo.restartCount}).`,
          'warning'
        );
      }

      global.io.emit('streamStatus', {
        videoId: matchedVideoId,
        running: false,
        restarting: true,
        restartCount: matchedInfo.restartCount,
        restartInMs: delayMs,
        startTime: matchedInfo.startTime || null,
      });

      matchedInfo.restartTimer = setTimeout(() => {
        const current = global.streamProcesses[matchedVideoId];
        if (!current || current.manualStop || !current.keepAlive) {
          return;
        }

        const restarted = startStream(
          current.videoPath,
          current.settings || settings,
          current.loop || false,
          current.customRtmp || customRtmp,
          current.inputOptions || {}
        );

        if (!restarted) {
          logger.error(`Reconnect failed for video ${matchedVideoId}. Removing from active streams.`);
          delete global.streamProcesses[matchedVideoId];
          if (typeof global.addLog === 'function') {
            global.addLog(`Reconnect stream #${matchedVideoId} failed permanently.`, 'error');
          }
          global.io.emit('streamStatus', { videoId: matchedVideoId, running: false, restarting: false });
          return;
        }

        current.proc = restarted;
        current.pid = restarted.pid;
        current.restarting = false;
        current.restartTimer = null;
        current.startTime = new Date().toISOString();

        if (typeof global.addLog === 'function') {
          global.addLog(`Stream #${matchedVideoId} reconnected (pid=${restarted.pid}).`, 'success');
        }
        global.io.emit('streamStatus', {
          videoId: matchedVideoId,
          pid: restarted.pid,
          running: true,
          restarting: false,
          restartCount: current.restartCount || 0,
          startTime: current.startTime,
        });
      }, delayMs);
      return;
    }

    if (matchedInfo.restartTimer) {
      clearTimeout(matchedInfo.restartTimer);
    }
    delete global.streamProcesses[matchedVideoId];
    global.io.emit('streamStatus', { videoId: matchedVideoId, running: false, restarting: false });
  });

  return proc;
}

module.exports = { startStream };

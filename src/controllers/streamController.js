const path = require('path');
const db = require('../models/database');
const { startStream } = require('../services/ffmpegService');
const instagramService = require('../services/instagramLiveService');
const { resolveSourceUrl } = require('../services/sourceResolverService');
const logger = require('../utils/logger');
const { getUploadPath } = require('../config/runtimePaths');

function sanitizeStreamSettings(settings = {}) {
  return {
    resolution: settings?.resolution || '1280x720',
    bitrate: settings?.bitrate || '2500k',
    fps: settings?.fps || '30',
  };
}

function normalizeDestinations(customRtmp) {
  return (Array.isArray(customRtmp) ? customRtmp : [customRtmp])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function buildBaseStreamState({ pid, proc, videoPath, settings, loop, customRtmp, keepAlive, owner = null, inputOptions = null }) {
  return {
    pid,
    proc,
    videoPath,
    settings,
    loop: Boolean(loop),
    customRtmp,
    keepAlive: Boolean(keepAlive),
    manualStop: false,
    restarting: false,
    restartCount: 0,
    restartTimer: null,
    startTime: new Date().toISOString(),
    owner,
    inputOptions: inputOptions || undefined,
  };
}

function findActiveUrlStream(streamId = '') {
  const normalizedId = String(streamId || '').trim();
  const entries = Object.entries(global.streamProcesses || {});
  for (const [id, info] of entries) {
    if (!info || info.owner !== 'url') continue;
    if (normalizedId && id !== normalizedId) continue;
    return { id, info };
  }
  return null;
}

function startLiveStream(req, res) {
  const { videoId, settings, loop, customRtmp, keepAlive } = req.body;

  db.get('SELECT filename FROM videos WHERE id = ?', [videoId], (err, row) => {
    if (err || !row) {
      logger.error(`Stream error: ${err || 'Video not found in DB'}`);
      return res.status(404).json({ error: 'Video not found in database' });
    }

    if (global.streamProcesses[videoId]) {
      return res.status(400).json({ error: 'Stream is already running!' });
    }

    try {
      const uploadPath = getUploadPath();
      const videoPath = path.join(uploadPath, row.filename);
      const safeSettings = sanitizeStreamSettings(settings || {});
      const safeLoop = Boolean(loop);
      const safeDestinations = normalizeDestinations(customRtmp);
      const autoReconnect = keepAlive !== false;
      const proc = startStream(videoPath, safeSettings, safeLoop, safeDestinations);

      if (!proc) {
        logger.error(`Failed to start FFmpeg for video ${videoId}. Path=${videoPath}`);
        return res.status(500).json({ error: 'Gagal start FFmpeg. Cek file video dan RTMP destination.' });
      }

      global.streamProcesses[videoId] = {
        ...buildBaseStreamState({
          pid: proc.pid,
          proc,
          videoPath,
          settings: safeSettings,
          loop: safeLoop,
          customRtmp: safeDestinations,
          keepAlive: autoReconnect,
        }),
      };
      db.run("UPDATE videos SET views = views + 1, destinations = ?, start_time = datetime('now', 'localtime'), resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
        [JSON.stringify(safeDestinations), safeSettings.resolution, safeSettings.bitrate, safeSettings.fps, safeLoop ? 1 : 0, videoId]);

      global.io.emit('streamStatus', {
        videoId,
        pid: proc.pid,
        running: true,
        restarting: false,
        restartCount: 0,
        startTime: global.streamProcesses[videoId].startTime,
      });
      res.json({ message: 'Streaming started!', pid: proc.pid, keepAlive: autoReconnect });

    } catch (error) {
      logger.error(`Critical Stream Error: ${error.message}`);
      res.status(500).json({ error: 'Internal Server Error during start' });
    }
  });
}

function saveStreamConfig(req, res) {
  const { videoId, settings, loop, customRtmp } = req.body;

  db.run("UPDATE videos SET destinations = ?, resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
    [JSON.stringify(customRtmp), settings.resolution, settings.bitrate, settings.fps, loop ? 1 : 0, videoId],
    function (err) {
      if (err) {
        logger.error(`Config save error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to save config' });
      }
      res.json({ message: 'Configuration saved!' });
    }
  );
}

async function startUrlStream(req, res) {
  const { sourceUrl, settings, customRtmp } = req.body || {};
  const rawSourceUrl = String(sourceUrl || '').trim();

  if (!rawSourceUrl) {
    return res.status(400).json({ error: 'Source URL wajib diisi.' });
  }

  if (findActiveUrlStream()) {
    return res.status(400).json({ error: 'URL stream sudah berjalan. Stop dulu sebelum start baru.' });
  }

  const safeDestinations = normalizeDestinations(customRtmp);
  if (!safeDestinations.length) {
    return res.status(400).json({ error: 'RTMP destination wajib diisi minimal 1.' });
  }

  const safeSettings = sanitizeStreamSettings(settings || {});

  let resolved;
  try {
    resolved = await resolveSourceUrl(rawSourceUrl);
  } catch (err) {
    logger.error(`URL resolver failed: ${err.message}`);
    return res.status(400).json({ error: err.message || 'Gagal resolve source URL.' });
  }

  const proc = startStream(
    resolved.resolvedUrl,
    safeSettings,
    false,
    safeDestinations,
    { inputIsUrl: true }
  );

  if (!proc) {
    return res.status(500).json({ error: 'Gagal start FFmpeg dari source URL.' });
  }

  const streamId = `url-${Date.now()}`;
  global.streamProcesses[streamId] = {
    ...buildBaseStreamState({
      pid: proc.pid,
      proc,
      videoPath: resolved.resolvedUrl,
      settings: safeSettings,
      loop: false,
      customRtmp: safeDestinations,
      keepAlive: false,
      owner: 'url',
      inputOptions: { inputIsUrl: true },
    }),
    sourceUrl: rawSourceUrl,
    sourceProvider: resolved.provider,
  };

  global.io.emit('streamStatus', {
    videoId: streamId,
    pid: proc.pid,
    running: true,
    restarting: false,
    restartCount: 0,
    startTime: global.streamProcesses[streamId].startTime,
  });

  if (typeof global.addLog === 'function') {
    global.addLog(`URL stream started (${resolved.provider}) pid=${proc.pid}`, 'success');
  }

  return res.json({
    ok: true,
    message: 'URL stream started!',
    streamId,
    pid: proc.pid,
    sourceProvider: resolved.provider,
  });
}

function stopUrlStream(req, res) {
  const requestedId = String(req.body?.streamId || '').trim();
  const active = findActiveUrlStream(requestedId);

  if (!active) {
    return res.json({ ok: true, message: 'URL stream already stopped' });
  }

  const { id, info } = active;
  try {
    info.manualStop = true;
    info.keepAlive = false;
    info.restarting = false;
    if (info.restartTimer) clearTimeout(info.restartTimer);
    if (info.proc) info.proc.kill('SIGKILL');
    delete global.streamProcesses[id];

    global.io.emit('streamStatus', { videoId: id, running: false, restarting: false });

    if (typeof global.addLog === 'function') {
      global.addLog(`URL stream stopped (${id}).`, 'info');
    }

    return res.json({ ok: true, message: 'URL stream stopped', streamId: id });
  } catch (err) {
    logger.error(`Error stopping URL stream ${id}: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Failed to stop URL stream' });
  }
}

function getUrlStreamStatus(_req, res) {
  const active = findActiveUrlStream();
  if (!active) {
    return res.json({ ok: true, status: { running: false } });
  }

  const { id, info } = active;
  return res.json({
    ok: true,
    status: {
      running: true,
      streamId: id,
      pid: info.pid || null,
      sourceUrl: info.sourceUrl || '',
      sourceProvider: info.sourceProvider || 'direct',
      startTime: info.startTime || null,
      restarting: Boolean(info.restarting),
      restartCount: Number(info.restartCount || 0),
    },
  });
}

function stopLiveStream(req, res) {
  const { videoId } = req.body;

  if (!global.streamProcesses[videoId]) {
    db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
    global.io.emit('streamStatus', { videoId, running: false, restarting: false });
    return res.json({ message: 'Stream already stopped' });
  }

  try {
    const processInfo = global.streamProcesses[videoId];
    if (processInfo && processInfo.owner === 'instagram') {
      instagramService.stopStream()
        .then(() => {
          db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
          global.io.emit('streamStatus', { videoId, running: false, restarting: false });
          res.json({ message: 'Streaming stopped!' });
        })
        .catch((e) => {
          logger.error(`Error stopping IG stream: ${e.message}`);
          res.status(500).json({ error: 'Failed to stop Instagram stream' });
        });
      return;
    }

    if (processInfo) {
      processInfo.manualStop = true;
      processInfo.keepAlive = false;
      processInfo.restarting = false;
      if (processInfo.restartTimer) {
        clearTimeout(processInfo.restartTimer);
      }
    }
    if (processInfo && processInfo.proc) {
      processInfo.proc.kill('SIGKILL');
    }
    delete global.streamProcesses[videoId];
    db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
    global.io.emit('streamStatus', { videoId, running: false, restarting: false });
    res.json({ message: 'Streaming stopped!' });
  } catch (e) {
    logger.error(`Error stopping stream: ${e.message}`);
    res.status(500).json({ error: 'Failed to stop stream' });
  }
}

module.exports = {
  startLiveStream,
  stopLiveStream,
  saveStreamConfig,
  startUrlStream,
  stopUrlStream,
  getUrlStreamStatus,
};

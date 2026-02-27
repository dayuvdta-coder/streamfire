const db = require('../models/database');
const { startStream } = require('../services/ffmpegService');
const instagramService = require('../services/instagramLiveService');
const logger = require('../utils/logger');
const { getUploadPath } = require('../config/runtimePaths');

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
      const videoPath = require('path').join(uploadPath, row.filename);
      const safeSettings = {
        resolution: settings?.resolution || '1280x720',
        bitrate: settings?.bitrate || '2500k',
        fps: settings?.fps || '30',
      };
      const safeLoop = Boolean(loop);
      const safeDestinations = Array.isArray(customRtmp)
        ? customRtmp.filter((x) => String(x || '').trim())
        : [String(customRtmp || '').trim()].filter(Boolean);
      const autoReconnect = keepAlive !== false;
      const proc = startStream(videoPath, safeSettings, safeLoop, safeDestinations);

      if (!proc) {
        logger.error(`Failed to start FFmpeg for video ${videoId}. Path=${videoPath}`);
        return res.status(500).json({ error: 'Gagal start FFmpeg. Cek file video dan RTMP destination.' });
      }

      global.streamProcesses[videoId] = {
        pid: proc.pid,
        proc,
        videoPath,
        settings: safeSettings,
        loop: safeLoop,
        customRtmp: safeDestinations,
        keepAlive: autoReconnect,
        manualStop: false,
        restarting: false,
        restartCount: 0,
        restartTimer: null,
        startTime: new Date().toISOString(),
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

module.exports = { startLiveStream, stopLiveStream, saveStreamConfig };

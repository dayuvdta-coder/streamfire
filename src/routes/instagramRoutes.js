const express = require('express');
const instagramService = require('../services/instagramLiveService');

const router = express.Router();

router.post('/session/login-cookie', async (req, res) => {
  try {
    const result = await instagramService.loginWithCookie(req.body.cookie);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/session/login-credentials', async (req, res) => {
  try {
    const result = await instagramService.loginWithCredentials({
      username: req.body.username,
      password: req.body.password,
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/setup', async (req, res) => {
  try {
    const result = await instagramService.setupLive({
      title: req.body.title,
      audience: req.body.audience,
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/start-stream', async (req, res) => {
  try {
    const rawVideoId = Number(req.body.videoId);
    if (!Number.isFinite(rawVideoId) || rawVideoId <= 0) {
      throw new Error('videoId tidak valid.');
    }

    const result = await instagramService.startStreamFromVideo({
      videoId: rawVideoId,
      settings: req.body.settings || {},
      loop: Boolean(req.body.loop),
      streamUrl: req.body.streamUrl,
      streamKey: req.body.streamKey,
      multiRtmp: req.body.multiRtmp,
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/stream/stop', async (_req, res) => {
  try {
    const result = await instagramService.stopStream();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/go', async (req, res) => {
  try {
    let autoStarted = false;
    const current = await instagramService.getStatus();
    if (!current.ffmpeg?.online) {
      const rawVideoId = Number(req.body.videoId);
      if (Number.isFinite(rawVideoId) && rawVideoId > 0) {
        await instagramService.startStreamFromVideo({
          videoId: rawVideoId,
          settings: req.body.settings || {},
          loop: Boolean(req.body.loop),
          streamUrl: req.body.streamUrl,
          streamKey: req.body.streamKey,
          multiRtmp: req.body.multiRtmp,
        });
        autoStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }
    }

    const result = await instagramService.goLive();
    res.json({ ok: true, result, autoStartedFfmpeg: autoStarted });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/end', async (_req, res) => {
  try {
    const result = await instagramService.endLive();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/live/comments', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 60);
    const result = await instagramService.getLiveComments(limit);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/comment', async (req, res) => {
  try {
    const result = await instagramService.sendLiveComment(req.body.message);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/live/auto-reply/settings', async (_req, res) => {
  try {
    const result = await instagramService.getAutoReplySettings();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/auto-reply/settings', async (req, res) => {
  try {
    const result = await instagramService.configureAutoReply(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live/auto-reply/run-once', async (_req, res) => {
  try {
    const result = await instagramService.runAutoReplyOnce();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/status', async (_req, res) => {
  try {
    const status = await instagramService.getStatus();
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

module.exports = router;

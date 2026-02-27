const express = require('express');
const multiChatService = require('../services/multiPlatformChatService');

const router = express.Router();

router.get('/settings', (_req, res) => {
  try {
    const result = multiChatService.getSettings();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/settings', (req, res) => {
  try {
    const result = multiChatService.updateSettings(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/auto-reply/settings', async (_req, res) => {
  try {
    const result = await multiChatService.getAutoReplySettings();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/auto-reply/settings', async (req, res) => {
  try {
    const result = await multiChatService.configureAutoReply(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/auto-reply/run-once', async (_req, res) => {
  try {
    const result = await multiChatService.runAutoReplyOnce();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/:platform/comments', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 80);
    const result = await multiChatService.fetchComments(req.params.platform, limit);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/:platform/comment', async (req, res) => {
  try {
    const message = req.body?.message;
    const result = await multiChatService.sendComment(req.params.platform, message);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

module.exports = router;

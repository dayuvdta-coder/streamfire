const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const mistralService = require('./mistralService');

const DEFAULT_YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_FB_API_BASE = 'https://graph.facebook.com/v20.0';
const MULTI_CHAT_AUTO_REPLY_POLL_MS = 7000;
const MULTI_CHAT_AUTO_REPLY_USER_WINDOW_MS = Math.max(60000, asInt(process.env.MULTI_CHAT_AUTO_REPLY_USER_WINDOW_MS, 900000));
const MULTI_CHAT_AUTO_REPLY_MAX_REPLIES_PER_COMMENT = Math.max(1, Math.min(5, asInt(process.env.MULTI_CHAT_AUTO_REPLY_MAX_REPLIES_PER_COMMENT, 3)));
const MULTI_CHAT_AUTO_REPLY_MAX_FOLLOWUP_DELAY_SEC = Math.max(3, Math.min(600, asInt(process.env.MULTI_CHAT_AUTO_REPLY_MAX_FOLLOWUP_DELAY_SEC, 180)));

function asInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizePlatform(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'youtube' || v === 'yt') return 'youtube';
  if (v === 'facebook' || v === 'fb') return 'facebook';
  return '';
}

function clampLimit(value, min = 1, max = 200, fallback = 60) {
  const n = asInt(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeTemplateItem(item, idx) {
  const keywords = Array.isArray(item?.keywords)
    ? item.keywords
    : String(item?.keywords || '')
      .split(',')
      .map((x) => x.trim());
  const cleanedKeywords = keywords
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
  const reply = String(item?.reply || '').trim();
  if (!cleanedKeywords.length || !reply) return null;
  return {
    id: String(item?.id || `tpl-${idx + 1}`),
    keywords: cleanedKeywords,
    reply: reply.slice(0, 300),
  };
}

function normalizeFollowUpTemplates(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  const cleaned = source
    .map((entry) => cleanText(entry, 260))
    .filter(Boolean)
    .slice(0, 20);
  return cleaned.length ? cleaned : [
    'Kak @{username}, kalau cocok langsung checkout/DM ya.',
    'Stok terbatas kak @{username}, kalau mau saya bantu proses sekarang.',
  ];
}

function defaultAutoReplyConfig() {
  return {
    enabled: false,
    mode: 'template_first', // template_first | template_only | ai_only
    cooldownSec: 20,
    maxRepliesPerUser: 2,
    repliesPerComment: 1,
    followUpEnabled: false,
    followUpDelaySec: 18,
    pollMs: MULTI_CHAT_AUTO_REPLY_POLL_MS,
    priceText: '',
    systemPrompt: 'Kamu admin live shop multi platform. Balas singkat, ramah, jelas, dan dorong checkout/DM.',
    platforms: {
      youtube: true,
      facebook: true,
    },
    templates: [
      {
        id: 'harga',
        keywords: ['harga', 'price', 'berapa'],
        reply: 'Halo @{username}, untuk harga {price}. Jika cocok, langsung checkout/DM ya.',
      },
      {
        id: 'stok',
        keywords: ['stok', 'ready', 'tersedia'],
        reply: 'Ready kak @{username}. Mau saya bantu proses order sekarang?',
      },
      {
        id: 'order',
        keywords: ['order', 'beli', 'checkout'],
        reply: 'Siap kak @{username}, langsung checkout/DM ya biar cepat diproses.',
      },
    ],
    followUpTemplates: [
      'Kak @{username}, kalau cocok langsung checkout/DM ya.',
      'Stok terbatas kak @{username}, kalau mau saya bantu proses sekarang.',
    ],
  };
}

function sanitizeAutoReplyConfig(input, fallback = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const modeRaw = String(source.mode || fallback.mode || 'template_first').trim();
  const mode = ['template_first', 'template_only', 'ai_only'].includes(modeRaw) ? modeRaw : 'template_first';
  const templatesRaw = Array.isArray(source.templates) ? source.templates : fallback.templates || [];
  const templates = templatesRaw
    .map((item, idx) => normalizeTemplateItem(item, idx))
    .filter(Boolean)
    .slice(0, 60);
  const followUpTemplates = normalizeFollowUpTemplates(
    Array.isArray(source.followUpTemplates) ? source.followUpTemplates : null,
    Array.isArray(fallback.followUpTemplates) ? fallback.followUpTemplates : defaultAutoReplyConfig().followUpTemplates
  );

  const sourcePlatforms = source.platforms && typeof source.platforms === 'object' ? source.platforms : {};
  const fallbackPlatforms = fallback.platforms && typeof fallback.platforms === 'object' ? fallback.platforms : {};

  return {
    enabled: Boolean(source.enabled ?? fallback.enabled),
    mode,
    cooldownSec: Math.max(0, Math.min(600, asInt(source.cooldownSec, asInt(fallback.cooldownSec, 20)))),
    maxRepliesPerUser: Math.max(1, Math.min(20, asInt(source.maxRepliesPerUser, asInt(fallback.maxRepliesPerUser, 2)))),
    repliesPerComment: Math.max(1, Math.min(MULTI_CHAT_AUTO_REPLY_MAX_REPLIES_PER_COMMENT, asInt(source.repliesPerComment, asInt(fallback.repliesPerComment, 1)))),
    followUpEnabled: Boolean(source.followUpEnabled ?? fallback.followUpEnabled),
    followUpDelaySec: Math.max(3, Math.min(MULTI_CHAT_AUTO_REPLY_MAX_FOLLOWUP_DELAY_SEC, asInt(source.followUpDelaySec, asInt(fallback.followUpDelaySec, 18)))),
    pollMs: Math.max(3000, Math.min(30000, asInt(source.pollMs, asInt(fallback.pollMs, MULTI_CHAT_AUTO_REPLY_POLL_MS)))),
    priceText: String(source.priceText ?? fallback.priceText ?? '').trim().slice(0, 180),
    systemPrompt: String(source.systemPrompt ?? fallback.systemPrompt ?? defaultAutoReplyConfig().systemPrompt).trim().slice(0, 1200),
    platforms: {
      youtube: Boolean(sourcePlatforms.youtube ?? fallbackPlatforms.youtube ?? true),
      facebook: Boolean(sourcePlatforms.facebook ?? fallbackPlatforms.facebook ?? true),
    },
    templates: templates.length ? templates : defaultAutoReplyConfig().templates,
    followUpTemplates,
  };
}

function renderTemplateReply(template, ctx) {
  return String(template || '')
    .replaceAll('{username}', String(ctx.username || '').trim())
    .replaceAll('{message}', String(ctx.message || '').trim())
    .replaceAll('{price}', String(ctx.priceText || '').trim())
    .replace(/\s+/g, ' ')
    .trim();
}

function commentTrackingKey(platform, commentId) {
  const p = normalizePlatform(platform);
  const id = String(commentId || '').trim();
  if (!p || !id) return '';
  return `${p}:${id}`;
}

function userTrackingKey(platform, username) {
  const p = normalizePlatform(platform);
  const u = String(username || '').trim().toLowerCase();
  if (!p || !u) return '';
  return `${p}:${u}`;
}

class MultiPlatformChatService {
  constructor() {
    this.configPath = path.resolve(process.cwd(), 'db', 'multichat.settings.json');
    this.autoReplyConfigPath = path.resolve(process.cwd(), 'db', 'multichat.autoreply.json');
    this.autoReplyTimer = null;
    this.autoReplyProcessing = false;
    this.followUpTimers = new Set();

    this.state = {
      settings: {
        youtube: {
          streamId: '',
          liveChatId: '',
          accessToken: '',
          apiKey: '',
          selfChannelId: '',
        },
        facebook: {
          liveVideoId: '',
          pageAccessToken: '',
          pageId: '',
        },
      },
      comments: {
        youtube: [],
        facebook: [],
      },
      lastFetchedAt: {
        youtube: null,
        facebook: null,
      },
      autoReply: {
        ...defaultAutoReplyConfig(),
        processedCommentIds: [],
        repliedCommentIds: [],
        userReplyStats: {},
        lastRunAt: null,
        lastReplyAt: null,
        lastError: null,
      },
    };

    this.loadSettingsFromDisk();
    this.loadAutoReplyConfigFromDisk();
    if (this.state.autoReply.enabled) {
      this.startAutoReplyLoop();
    }
  }

  addLog(message, type = 'info') {
    const safe = `[CHAT] ${message}`;
    logger[type] ? logger[type](safe) : logger.info(safe);
    if (typeof global.addLog === 'function') {
      global.addLog(safe, type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'info');
    }
  }

  sanitizeSettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    const yt = source.youtube && typeof source.youtube === 'object' ? source.youtube : {};
    const fb = source.facebook && typeof source.facebook === 'object' ? source.facebook : {};

    return {
      youtube: {
        streamId: cleanText(yt.streamId, 100),
        liveChatId: cleanText(yt.liveChatId, 150),
        accessToken: cleanText(yt.accessToken, 5000),
        apiKey: cleanText(yt.apiKey, 500),
        selfChannelId: cleanText(yt.selfChannelId, 160),
      },
      facebook: {
        liveVideoId: cleanText(fb.liveVideoId, 120),
        pageAccessToken: cleanText(fb.pageAccessToken, 5000),
        pageId: cleanText(fb.pageId, 120),
      },
    };
  }

  loadSettingsFromDisk() {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(String(raw || '{}'));
      this.state.settings = this.sanitizeSettings(parsed);
    } catch (err) {
      this.addLog(`Failed loading multi-chat settings: ${err.message}`, 'warn');
    }
  }

  saveSettingsToDisk() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify(this.state.settings, null, 2);
      try {
        fs.writeFileSync(this.configPath, body, 'utf8');
      } catch (err) {
        if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
          fs.unlinkSync(this.configPath);
          fs.writeFileSync(this.configPath, body, 'utf8');
          this.addLog('Recovered multi-chat settings file permissions by replacing file.', 'warn');
          return;
        }
        throw err;
      }
    } catch (err) {
      this.addLog(`Failed saving multi-chat settings: ${err.message}`, 'warn');
    }
  }

  loadAutoReplyConfigFromDisk() {
    try {
      if (!fs.existsSync(this.autoReplyConfigPath)) return;
      const raw = fs.readFileSync(this.autoReplyConfigPath, 'utf8');
      const parsed = JSON.parse(String(raw || '{}'));
      const safe = sanitizeAutoReplyConfig(parsed, this.state.autoReply);
      this.state.autoReply = {
        ...this.state.autoReply,
        ...safe,
      };
    } catch (err) {
      this.addLog(`Failed loading multi-chat auto-reply config: ${err.message}`, 'warn');
    }
  }

  saveAutoReplyConfigToDisk() {
    try {
      const dir = path.dirname(this.autoReplyConfigPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        enabled: this.state.autoReply.enabled,
        mode: this.state.autoReply.mode,
        cooldownSec: this.state.autoReply.cooldownSec,
        maxRepliesPerUser: this.state.autoReply.maxRepliesPerUser,
        repliesPerComment: this.state.autoReply.repliesPerComment,
        followUpEnabled: this.state.autoReply.followUpEnabled,
        followUpDelaySec: this.state.autoReply.followUpDelaySec,
        pollMs: this.state.autoReply.pollMs,
        priceText: this.state.autoReply.priceText,
        systemPrompt: this.state.autoReply.systemPrompt,
        platforms: this.state.autoReply.platforms,
        templates: this.state.autoReply.templates,
        followUpTemplates: this.state.autoReply.followUpTemplates,
      };
      const body = JSON.stringify(payload, null, 2);
      try {
        fs.writeFileSync(this.autoReplyConfigPath, body, 'utf8');
      } catch (err) {
        if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
          fs.unlinkSync(this.autoReplyConfigPath);
          fs.writeFileSync(this.autoReplyConfigPath, body, 'utf8');
          this.addLog('Recovered multi-chat auto-reply config file permissions by replacing file.', 'warn');
          return;
        }
        throw err;
      }
    } catch (err) {
      this.addLog(`Failed saving multi-chat auto-reply config: ${err.message}`, 'warn');
    }
  }

  getSettings() {
    return {
      youtube: { ...this.state.settings.youtube },
      facebook: { ...this.state.settings.facebook },
    };
  }

  updateSettings(next) {
    this.state.settings = this.sanitizeSettings(next);
    this.saveSettingsToDisk();
    this.addLog('Multi-platform chat settings updated.');
    return this.getSettings();
  }

  getPublicAutoReplyState() {
    return {
      enabled: Boolean(this.state.autoReply.enabled),
      mode: this.state.autoReply.mode,
      cooldownSec: this.state.autoReply.cooldownSec,
      maxRepliesPerUser: this.state.autoReply.maxRepliesPerUser,
      repliesPerComment: this.state.autoReply.repliesPerComment,
      followUpEnabled: Boolean(this.state.autoReply.followUpEnabled),
      followUpDelaySec: this.state.autoReply.followUpDelaySec,
      pollMs: this.state.autoReply.pollMs,
      priceText: this.state.autoReply.priceText || '',
      systemPrompt: this.state.autoReply.systemPrompt || '',
      platforms: {
        youtube: Boolean(this.state.autoReply.platforms?.youtube),
        facebook: Boolean(this.state.autoReply.platforms?.facebook),
      },
      templates: this.state.autoReply.templates || [],
      followUpTemplates: this.state.autoReply.followUpTemplates || [],
      mistralConfigured: mistralService.isConfigured(),
      processedCount: (this.state.autoReply.processedCommentIds || []).length,
      repliedCount: (this.state.autoReply.repliedCommentIds || []).length,
      lastRunAt: this.state.autoReply.lastRunAt || null,
      lastReplyAt: this.state.autoReply.lastReplyAt || null,
      lastError: this.state.autoReply.lastError || null,
      running: Boolean(this.autoReplyTimer),
      processing: Boolean(this.autoReplyProcessing),
      pendingFollowUps: this.followUpTimers.size,
    };
  }

  async configureAutoReply(input) {
    const next = sanitizeAutoReplyConfig(input, this.state.autoReply);
    this.state.autoReply = {
      ...this.state.autoReply,
      ...next,
      lastError: null,
    };
    this.saveAutoReplyConfigToDisk();

    if (this.state.autoReply.enabled) {
      this.stopAutoReplyLoop();
      this.startAutoReplyLoop();
    } else {
      this.stopAutoReplyLoop();
    }

    this.addLog(
      `Multi-chat auto-reply ${this.state.autoReply.enabled ? 'enabled' : 'disabled'} (mode=${this.state.autoReply.mode}).`,
      'info'
    );
    return this.getPublicAutoReplyState();
  }

  async getAutoReplySettings() {
    return this.getPublicAutoReplyState();
  }

  startAutoReplyLoop() {
    if (this.autoReplyTimer) return;
    const pollMs = Math.max(3000, Math.min(30000, Number(this.state.autoReply.pollMs) || MULTI_CHAT_AUTO_REPLY_POLL_MS));
    this.autoReplyTimer = setInterval(() => {
      this.processAutoReplyTick().catch((err) => {
        this.state.autoReply.lastError = err.message || String(err);
      });
    }, pollMs);
    this.addLog(`Multi-chat auto-reply loop started (${pollMs}ms).`);
  }

  stopAutoReplyLoop() {
    if (this.autoReplyTimer) {
      clearInterval(this.autoReplyTimer);
      this.autoReplyTimer = null;
      this.addLog('Multi-chat auto-reply loop stopped.');
    }
    this.clearFollowUpTimers();
  }

  clearFollowUpTimers() {
    if (!this.followUpTimers || !this.followUpTimers.size) return;
    for (const timer of Array.from(this.followUpTimers)) {
      clearTimeout(timer);
      this.followUpTimers.delete(timer);
    }
  }

  rememberProcessedComment(platform, commentId) {
    const key = commentTrackingKey(platform, commentId);
    if (!key) return;
    const list = this.state.autoReply.processedCommentIds || [];
    if (!list.includes(key)) {
      list.push(key);
      if (list.length > 3000) list.splice(0, list.length - 3000);
    }
    this.state.autoReply.processedCommentIds = list;
  }

  wasCommentProcessed(platform, commentId) {
    const key = commentTrackingKey(platform, commentId);
    if (!key) return false;
    return (this.state.autoReply.processedCommentIds || []).includes(key);
  }

  rememberRepliedComment(platform, commentId) {
    const key = commentTrackingKey(platform, commentId);
    if (!key) return;
    const list = this.state.autoReply.repliedCommentIds || [];
    if (!list.includes(key)) {
      list.push(key);
      if (list.length > 3000) list.splice(0, list.length - 3000);
    }
    this.state.autoReply.repliedCommentIds = list;
  }

  hasRepliedComment(platform, commentId) {
    const key = commentTrackingKey(platform, commentId);
    if (!key) return false;
    return (this.state.autoReply.repliedCommentIds || []).includes(key);
  }

  findReplyTemplate(commentText) {
    const text = String(commentText || '').toLowerCase();
    const templates = Array.isArray(this.state.autoReply.templates) ? this.state.autoReply.templates : [];
    for (const template of templates) {
      const keys = Array.isArray(template?.keywords) ? template.keywords : [];
      if (!keys.length) continue;
      const matched = keys.some((key) => key && text.includes(String(key).toLowerCase()));
      if (matched) return template;
    }
    return null;
  }

  canAutoReplyToComment(platform, comment) {
    if (!comment) return false;
    const username = String(comment.username || '').trim().toLowerCase();
    if (!username) return false;
    if (this.hasRepliedComment(platform, comment.id)) return false;

    if (platform === 'youtube') {
      const selfChannelId = String(this.state.settings.youtube?.selfChannelId || '').trim();
      if (comment.isChatOwner) return false;
      if (selfChannelId && String(comment.authorChannelId || '').trim() === selfChannelId) return false;
    }

    if (platform === 'facebook') {
      const pageId = String(this.state.settings.facebook?.pageId || '').trim();
      if (pageId && String(comment.authorId || '').trim() === pageId) return false;
    }

    const stats = this.state.autoReply.userReplyStats || {};
    const key = userTrackingKey(platform, username);
    if (!key) return false;
    const row = stats[key] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= MULTI_CHAT_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    const cooldownMs = Math.max(0, Number(this.state.autoReply.cooldownSec || 0) * 1000);
    if (cooldownMs > 0 && row.lastAt && now - Number(row.lastAt) < cooldownMs) return false;
    if (Number(row.count || 0) >= Number(this.state.autoReply.maxRepliesPerUser || 1)) return false;
    return true;
  }

  markAutoReplySent(platform, comment) {
    if (!comment) return;
    const username = String(comment.username || '').trim().toLowerCase();
    const key = userTrackingKey(platform, username);
    if (!key) return;

    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[key] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= MULTI_CHAT_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    row.count = Number(row.count || 0) + 1;
    row.lastAt = now;
    stats[key] = row;
    this.state.autoReply.userReplyStats = stats;
    this.state.autoReply.lastReplyAt = new Date().toISOString();
    this.rememberRepliedComment(platform, comment.id);
  }

  canSendFollowUpToUser(platform, comment) {
    if (!comment) return false;
    const username = String(comment.username || '').trim().toLowerCase();
    const key = userTrackingKey(platform, username);
    if (!key) return false;

    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[key] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= MULTI_CHAT_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    if (Number(row.count || 0) >= Number(this.state.autoReply.maxRepliesPerUser || 1)) return false;
    return true;
  }

  markFollowUpSent(platform, comment) {
    if (!comment) return;
    const username = String(comment.username || '').trim().toLowerCase();
    const key = userTrackingKey(platform, username);
    if (!key) return;

    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[key] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= MULTI_CHAT_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    row.count = Number(row.count || 0) + 1;
    row.lastAt = now;
    stats[key] = row;
    this.state.autoReply.userReplyStats = stats;
    this.state.autoReply.lastReplyAt = new Date().toISOString();
  }

  async generateAiReply(platform, comment) {
    const username = String(comment?.username || '').trim();
    const text = String(comment?.text || '').trim();
    const systemPrompt = `${this.state.autoReply.systemPrompt || ''}\n` +
      'Jawab maksimal 1 kalimat pendek (maks 160 karakter), bahasa Indonesia santai jualan, tanpa spam.';
    const userPrompt =
      `Platform: ${platform}.\n` +
      `Komentar viewer dari @${username}: "${text}".\n` +
      `Jika relevan, sisipkan info harga: ${this.state.autoReply.priceText || '-'}.\n` +
      'Buat balasan admin live shop yang ramah, jelas, dan dorong closing (checkout/DM).';

    const raw = await mistralService.generateReply({
      systemPrompt,
      userPrompt,
      maxTokens: 120,
      temperature: 0.5,
    });

    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 170);
  }

  async chooseAutoReply(platform, comment) {
    const mode = this.state.autoReply.mode;
    const template = this.findReplyTemplate(comment.text);
    const context = {
      username: comment.username,
      message: comment.text,
      priceText: this.state.autoReply.priceText || '-',
    };

    if (mode === 'template_only') {
      if (!template) return null;
      return renderTemplateReply(template.reply, context);
    }

    if (mode === 'ai_only') {
      if (!mistralService.isConfigured()) return null;
      return this.generateAiReply(platform, comment);
    }

    if (template) {
      return renderTemplateReply(template.reply, context);
    }
    if (!mistralService.isConfigured()) return null;
    return this.generateAiReply(platform, comment);
  }

  async generateAiFollowUpReply(platform, comment, previousReply, stepIndex) {
    const username = String(comment?.username || '').trim();
    const text = String(comment?.text || '').trim();
    const prev = String(previousReply || '').trim();
    const systemPrompt = `${this.state.autoReply.systemPrompt || ''}\n` +
      'Ini follow-up komentar live. Jawab 1 kalimat singkat (maks 140 karakter), sopan, natural, tanpa spam.';
    const userPrompt =
      `Platform: ${platform}.\n` +
      `Komentar asli @${username}: "${text}".\n` +
      `Balasan sebelumnya: "${prev || '-'}".\n` +
      `Ini follow-up ke-${Number(stepIndex || 1)}. Info harga: ${this.state.autoReply.priceText || '-'}.\n` +
      'Buat follow-up yang mendorong checkout/DM tanpa copy paste kalimat sebelumnya.';

    const raw = await mistralService.generateReply({
      systemPrompt,
      userPrompt,
      maxTokens: 100,
      temperature: 0.45,
    });

    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  async chooseFollowUpReply(platform, comment, previousReply, stepIndex = 1) {
    const templates = Array.isArray(this.state.autoReply.followUpTemplates) ? this.state.autoReply.followUpTemplates : [];
    if (templates.length) {
      const idx = Math.max(0, Number(stepIndex || 1) - 1) % templates.length;
      const rendered = renderTemplateReply(templates[idx], {
        username: comment.username,
        message: comment.text,
        priceText: this.state.autoReply.priceText || '-',
      });
      if (rendered && rendered !== previousReply) return rendered;
    }
    if (!mistralService.isConfigured()) return null;
    const ai = await this.generateAiFollowUpReply(platform, comment, previousReply, stepIndex);
    if (!ai || ai === previousReply) return null;
    return ai;
  }

  scheduleFollowUpReplies(platform, comment, initialReplyText) {
    const total = Math.max(1, Number(this.state.autoReply.repliesPerComment || 1));
    if (!this.state.autoReply.followUpEnabled) return;
    if (total <= 1) return;

    const delaySec = Math.max(3, Number(this.state.autoReply.followUpDelaySec || 18));
    const extraCount = Math.max(0, total - 1);
    let lastReply = String(initialReplyText || '').trim();

    for (let i = 1; i <= extraCount; i += 1) {
      const timer = setTimeout(async () => {
        this.followUpTimers.delete(timer);
        try {
          if (!this.state.autoReply.enabled) return;
          if (!this.canSendFollowUpToUser(platform, comment)) return;

          const text = await this.chooseFollowUpReply(platform, comment, lastReply, i);
          if (!text) return;

          await this.sendComment(platform, text);
          this.markFollowUpSent(platform, comment);
          lastReply = text;
          this.addLog(
            `Auto follow-up ${platform} -> @${comment.username}: ${text.slice(0, 70)}${text.length > 70 ? '...' : ''}`
          );
        } catch (err) {
          this.addLog(`Auto follow-up ${platform} error: ${err.message || String(err)}`, 'warn');
        }
      }, delaySec * i * 1000);
      this.followUpTimers.add(timer);
    }
  }

  async processAutoReplyTick(force = false) {
    if (this.autoReplyProcessing) return;
    if (!this.state.autoReply.enabled && !force) return;

    this.autoReplyProcessing = true;
    const errors = [];

    try {
      const targets = [];
      if (this.state.autoReply.platforms?.youtube) targets.push('youtube');
      if (this.state.autoReply.platforms?.facebook) targets.push('facebook');

      for (const platform of targets) {
        let comments = [];
        try {
          const result = await this.fetchComments(platform, 80);
          comments = Array.isArray(result?.items) ? result.items : [];
        } catch (err) {
          errors.push(`${platform}: ${err.message || String(err)}`);
          continue;
        }

        if (!comments.length) continue;

        const ordered = comments.slice().reverse();
        for (const comment of ordered) {
          if (!comment || !comment.id) continue;
          if (this.wasCommentProcessed(platform, comment.id)) continue;
          this.rememberProcessedComment(platform, comment.id);

          if (!this.canAutoReplyToComment(platform, comment)) continue;

          const replyText = await this.chooseAutoReply(platform, comment);
          if (!replyText) continue;

          try {
            await this.sendComment(platform, replyText);
            this.markAutoReplySent(platform, comment);
            this.scheduleFollowUpReplies(platform, comment, replyText);
            this.addLog(
              `Auto-reply ${platform} -> @${comment.username}: ${replyText.slice(0, 70)}${replyText.length > 70 ? '...' : ''}`
            );
          } catch (err) {
            errors.push(`send ${platform}: ${err.message || String(err)}`);
          }

          // Batasi 1 reply per platform per tick untuk menghindari spam burst.
          break;
        }
      }

      this.state.autoReply.lastRunAt = new Date().toISOString();
      this.state.autoReply.lastError = errors.length ? errors.join(' | ').slice(0, 800) : null;
    } finally {
      this.autoReplyProcessing = false;
    }
  }

  async runAutoReplyOnce() {
    await this.processAutoReplyTick(true);
    return this.getPublicAutoReplyState();
  }

  mergeComments(platform, freshItems) {
    const key = normalizePlatform(platform);
    if (!key) return [];
    const fresh = Array.isArray(freshItems) ? freshItems : [];
    const merged = [...(this.state.comments[key] || []), ...fresh];
    const map = new Map();
    for (const item of merged) {
      const id = cleanText(item?.id, 200);
      if (!id) continue;
      map.set(id, {
        id,
        platform: key,
        username: cleanText(item?.username, 120),
        text: cleanText(item?.text, 400),
        at: item?.at || new Date().toISOString(),
        authorChannelId: cleanText(item?.authorChannelId, 160),
        authorId: cleanText(item?.authorId, 120),
        isChatOwner: Boolean(item?.isChatOwner),
      });
    }
    this.state.comments[key] = Array.from(map.values()).slice(-400);
    this.state.lastFetchedAt[key] = new Date().toISOString();
    return this.state.comments[key];
  }

  async resolveYouTubeLiveChatId() {
    const yt = this.state.settings.youtube;
    if (yt.liveChatId) return yt.liveChatId;
    if (!yt.streamId) throw new Error('YouTube streamId/videoId belum diisi.');

    const params = new URLSearchParams({
      part: 'liveStreamingDetails',
      id: yt.streamId,
    });
    if (yt.apiKey) params.set('key', yt.apiKey);

    const headers = {};
    if (yt.accessToken) {
      headers.Authorization = `Bearer ${yt.accessToken}`;
    }

    const response = await fetch(`${DEFAULT_YT_API_BASE}/videos?${params.toString()}`, { headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`YouTube API error: ${detail}`);
    }

    const liveChatId = data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId || '';
    if (!liveChatId) {
      throw new Error('activeLiveChatId tidak ditemukan. Pastikan video sedang live.');
    }
    this.state.settings.youtube.liveChatId = liveChatId;
    this.saveSettingsToDisk();
    return liveChatId;
  }

  async fetchYouTubeComments(limit = 60) {
    const yt = this.state.settings.youtube;
    const liveChatId = await this.resolveYouTubeLiveChatId();
    const maxResults = clampLimit(limit, 1, 200, 60);

    const params = new URLSearchParams({
      liveChatId,
      part: 'id,snippet,authorDetails',
      maxResults: String(maxResults),
    });
    if (yt.apiKey) params.set('key', yt.apiKey);

    const headers = {};
    if (yt.accessToken) headers.Authorization = `Bearer ${yt.accessToken}`;

    const response = await fetch(`${DEFAULT_YT_API_BASE}/liveChat/messages?${params.toString()}`, { headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`YouTube comments error: ${detail}`);
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    const normalized = items.map((it) => ({
      id: cleanText(it?.id || '', 200),
      username: cleanText(it?.authorDetails?.displayName || 'unknown', 120),
      text: cleanText(it?.snippet?.displayMessage || '', 400),
      at: it?.snippet?.publishedAt || new Date().toISOString(),
      authorChannelId: cleanText(it?.authorDetails?.channelId || '', 160),
      isChatOwner: Boolean(it?.authorDetails?.isChatOwner),
    })).filter((x) => x.id && x.text);

    return this.mergeComments('youtube', normalized);
  }

  async sendYouTubeComment(message) {
    const yt = this.state.settings.youtube;
    if (!yt.accessToken) {
      throw new Error('YouTube accessToken dibutuhkan untuk kirim komentar.');
    }
    const liveChatId = await this.resolveYouTubeLiveChatId();
    const text = cleanText(message, 180);
    if (!text) throw new Error('Komentar kosong.');

    const params = new URLSearchParams({ part: 'snippet' });
    if (yt.apiKey) params.set('key', yt.apiKey);

    const response = await fetch(`${DEFAULT_YT_API_BASE}/liveChat/messages?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${yt.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          liveChatId,
          type: 'textMessageEvent',
          textMessageDetails: {
            messageText: text,
          },
        },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`YouTube send error: ${detail}`);
    }

    this.addLog(`YouTube comment sent: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`);
    await this.fetchYouTubeComments(80).catch(() => { });
    return { sent: true, message: text };
  }

  async fetchFacebookComments(limit = 60) {
    const fb = this.state.settings.facebook;
    if (!fb.liveVideoId) throw new Error('Facebook liveVideoId belum diisi.');
    if (!fb.pageAccessToken) throw new Error('Facebook pageAccessToken belum diisi.');

    const params = new URLSearchParams({
      fields: 'id,from{name,id},message,created_time',
      order: 'reverse_chronological',
      limit: String(clampLimit(limit, 1, 100, 60)),
      access_token: fb.pageAccessToken,
    });

    const response = await fetch(`${DEFAULT_FB_API_BASE}/${encodeURIComponent(fb.liveVideoId)}/comments?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) {
      const detail = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`Facebook comments error: ${detail}`);
    }

    const items = Array.isArray(data?.data) ? data.data : [];
    const normalized = items.map((it) => ({
      id: cleanText(it?.id || '', 200),
      username: cleanText(it?.from?.name || 'unknown', 120),
      text: cleanText(it?.message || '', 400),
      at: it?.created_time || new Date().toISOString(),
      authorId: cleanText(it?.from?.id || '', 120),
    })).filter((x) => x.id && x.text);

    return this.mergeComments('facebook', normalized);
  }

  async sendFacebookComment(message) {
    const fb = this.state.settings.facebook;
    if (!fb.liveVideoId) throw new Error('Facebook liveVideoId belum diisi.');
    if (!fb.pageAccessToken) throw new Error('Facebook pageAccessToken belum diisi.');
    const text = cleanText(message, 180);
    if (!text) throw new Error('Komentar kosong.');

    const body = new URLSearchParams({
      message: text,
      access_token: fb.pageAccessToken,
    });
    const response = await fetch(`${DEFAULT_FB_API_BASE}/${encodeURIComponent(fb.liveVideoId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) {
      const detail = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`Facebook send error: ${detail}`);
    }

    this.addLog(`Facebook comment sent: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`);
    await this.fetchFacebookComments(80).catch(() => { });
    return { sent: true, message: text };
  }

  async fetchComments(platform, limit = 60) {
    const key = normalizePlatform(platform);
    if (!key) throw new Error('Platform tidak valid. Gunakan youtube/facebook.');
    if (key === 'youtube') {
      const items = await this.fetchYouTubeComments(limit);
      return {
        platform: key,
        items: items.slice(-clampLimit(limit, 1, 200, 60)),
        fetchedAt: this.state.lastFetchedAt[key],
      };
    }
    const items = await this.fetchFacebookComments(limit);
    return {
      platform: key,
      items: items.slice(-clampLimit(limit, 1, 200, 60)),
      fetchedAt: this.state.lastFetchedAt[key],
    };
  }

  async sendComment(platform, message) {
    const key = normalizePlatform(platform);
    if (!key) throw new Error('Platform tidak valid. Gunakan youtube/facebook.');
    if (key === 'youtube') {
      const sent = await this.sendYouTubeComment(message);
      return {
        platform: key,
        ...sent,
        items: (this.state.comments.youtube || []).slice(-80),
      };
    }
    const sent = await this.sendFacebookComment(message);
    return {
      platform: key,
      ...sent,
      items: (this.state.comments.facebook || []).slice(-80),
    };
  }

  async close() {
    this.stopAutoReplyLoop();
  }
}

module.exports = new MultiPlatformChatService();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const db = require('../models/database');
const { startStream } = require('./ffmpegService');
const mistralService = require('./mistralService');
const logger = require('../utils/logger');

const ALLOWED_AUDIENCE = new Set(['Public', 'Practice', 'Close friends']);
const DEFAULT_IG_HEADLESS = parseBooleanEnv(process.env.IG_HEADLESS ?? process.env.HEADLESS, true);
const DEFAULT_IG_LIVE_WIDTH = sanitizeEvenNumber(process.env.IG_LIVE_WIDTH, 720);
const DEFAULT_IG_LIVE_HEIGHT = sanitizeEvenNumber(process.env.IG_LIVE_HEIGHT, 1280);
const IG_FFMPEG_RESTART_BASE_DELAY_MS = toPositiveInt(process.env.IG_FFMPEG_RESTART_BASE_DELAY_MS, 3000);
const IG_FFMPEG_RESTART_MAX_DELAY_MS = toPositiveInt(process.env.IG_FFMPEG_RESTART_MAX_DELAY_MS, 60000);
const IG_GO_LIVE_WAIT_MS = toPositiveInt(process.env.IG_GO_LIVE_WAIT_MS, 180000);
const IG_AUTO_REPLY_POLL_MS = toPositiveInt(process.env.IG_AUTO_REPLY_POLL_MS, 7000);
const IG_AUTO_REPLY_MAX_PER_TICK = Math.max(1, Math.min(5, toPositiveInt(process.env.IG_AUTO_REPLY_MAX_PER_TICK, 2)));
const IG_AUTO_REPLY_DEDUPE_TTL_MS = toPositiveInt(process.env.IG_AUTO_REPLY_DEDUPE_TTL_MS, 45000);
const IG_AUTO_REPLY_REPLY_DEDUPE_TTL_MS = toPositiveInt(process.env.IG_AUTO_REPLY_REPLY_DEDUPE_TTL_MS, 45000);
const IG_AUTO_REPLY_USER_WINDOW_MS = Math.max(60000, toPositiveInt(process.env.IG_AUTO_REPLY_USER_WINDOW_MS, 900000));
const IG_AUTO_REPLY_MAX_REPLIES_PER_COMMENT = Math.max(1, Math.min(5, toPositiveInt(process.env.IG_AUTO_REPLY_MAX_REPLIES_PER_COMMENT, 3)));
const IG_AUTO_REPLY_MAX_FOLLOWUP_DELAY_SEC = Math.max(3, Math.min(600, toPositiveInt(process.env.IG_AUTO_REPLY_MAX_FOLLOWUP_DELAY_SEC, 180)));
const IG_CHAT_NETWORK_RECENT_MS = toPositiveInt(process.env.IG_CHAT_NETWORK_RECENT_MS, 60000);
const IG_CHAT_NETWORK_MAX_RESPONSE_BYTES = toPositiveInt(process.env.IG_CHAT_NETWORK_MAX_RESPONSE_BYTES, 750000);
const IG_CHAT_WS_FRAME_MAX_BYTES = toPositiveInt(process.env.IG_CHAT_WS_FRAME_MAX_BYTES, 500000);
const IG_CHAT_ENABLE_WS = parseBooleanEnv(process.env.IG_CHAT_ENABLE_WS, true);
const IG_CHAT_ALLOW_DOM_FALLBACK = parseBooleanEnv(process.env.IG_CHAT_ALLOW_DOM_FALLBACK, false);
const IG_CHAT_SYSTEM_MSG_RE = /joined|bergabung|is watching|started watching|mengikuti|pinned|pin|sent|mengirim|menyukai|followed|menyukai siaran|menonton/i;
const IG_CHAT_BLOCKED_USERNAMES = new Set([
  'instagram',
  'meta',
  'about',
  'privacy',
  'terms',
  'api',
  'jobs',
  'locations',
  'help',
  'threads',
  'english',
]);

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function sanitizeEvenNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const integer = Math.floor(parsed);
  return integer % 2 === 0 ? integer : integer - 1;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function sanitizeAudience(value) {
  return ALLOWED_AUDIENCE.has(value) ? value : 'Public';
}

function readableError(err) {
  if (!err) return 'Unknown error';
  const stripAnsi = (value) => String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (typeof err === 'string') return stripAnsi(err);
  if (err.message) return stripAnsi(err.message);
  return stripAnsi(String(err));
}

function cleanText(value, max = 500) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Number(max) || 500));
}

function normalizeChatUsername(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0] || '';
  return first.replace(/^@+/, '').replace(/:$/, '').trim();
}

function isLikelyIgChatUsername(value) {
  const username = normalizeChatUsername(value);
  if (!username) return false;
  if (!/^[A-Za-z0-9._]{1,40}$/.test(username)) return false;
  if (IG_CHAT_BLOCKED_USERNAMES.has(username.toLowerCase())) return false;
  if (/^\d+(?:[.,]\d+)?[kmb]?$/i.test(username)) return false;
  return true;
}

function isLikelySystemChatMessage(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (text.length < 2 || text.length > 300) return true;
  if (/^(follow|lebih lanjut|more|view all|see translation|reply)$/i.test(text)) return true;
  return IG_CHAT_SYSTEM_MSG_RE.test(text);
}

function toIsoTimestamp(value) {
  if (!value && value !== 0) return new Date().toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return new Date().toISOString();
  }
  const str = String(value || '').trim();
  if (!str) return new Date().toISOString();
  const asNum = Number(str);
  if (Number.isFinite(asNum) && asNum > 0) {
    const ms = asNum > 10_000_000_000 ? asNum : asNum * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

function parseCookieString(cookieString) {
  if (!cookieString || typeof cookieString !== 'string') return [];
  return cookieString
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return null;
      const name = part.slice(0, idx).trim();
      let value = part.slice(idx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      // Instagram sometimes stores escaped octal-ish delimiters like \054 for commas.
      value = value.replace(/\\054/g, ',').replace(/\\x2C/gi, ',');
      if (!name) return null;
      return {
        name,
        value,
        domain: '.instagram.com',
        path: '/',
      };
    })
    .filter(Boolean);
}

function sanitizeResolution(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) {
    return `${DEFAULT_IG_LIVE_WIDTH}x${DEFAULT_IG_LIVE_HEIGHT}`;
  }
  const width = sanitizeEvenNumber(Number(match[1]), DEFAULT_IG_LIVE_WIDTH);
  const height = sanitizeEvenNumber(Number(match[2]), DEFAULT_IG_LIVE_HEIGHT);
  return `${Math.max(width, 240)}x${Math.max(height, 240)}`;
}

function buildIngestUrl(streamUrl, streamKey) {
  const safeUrl = String(streamUrl || '').trim().replace(/\/+$/, '');
  const safeKey = String(streamKey || '').trim().replace(/^\/+/, '');
  if (!safeUrl || !safeKey) return null;
  return `${safeUrl}/${safeKey}`;
}

function parseIngestCredentials(streamUrlInput, streamKeyInput) {
  let streamUrl = String(streamUrlInput || '').trim();
  let streamKey = String(streamKeyInput || '').trim();

  const fromUrl = streamUrl.match(/^(rtmps?:\/\/[^/\s]+(?::\d+)?\/rtmp)\/(.+)$/i);
  if (fromUrl) {
    streamUrl = fromUrl[1];
    if (!streamKey) {
      streamKey = fromUrl[2];
    }
  }

  const fromKey = streamKey.match(/^(rtmps?:\/\/[^/\s]+(?::\d+)?\/rtmp)\/(.+)$/i);
  if (fromKey) {
    if (!streamUrl) {
      streamUrl = fromKey[1];
    }
    streamKey = fromKey[2];
  }

  streamUrl = String(streamUrl || '').trim().replace(/\/+$/, '');
  streamKey = String(streamKey || '').trim().replace(/^\/+/, '');

  return {
    streamUrl: streamUrl || null,
    streamKey: streamKey || null,
    ingest: buildIngestUrl(streamUrl, streamKey),
  };
}

function normalizeRtmpDestinations(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '')
      .split(/[\n,]/g);
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function uniqueDestinations(destinations) {
  const seen = new Set();
  const list = [];
  for (const value of destinations || []) {
    const key = String(value || '').trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  return list;
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
    'Kak @{username}, kalau mau lanjut checkout langsung DM ya.',
    'Stok berjalan kak @{username}, kalau cocok langsung amankan sekarang ya.',
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
    pollMs: IG_AUTO_REPLY_POLL_MS,
    priceText: '',
    systemPrompt: 'Kamu admin live shop Instagram. Balas singkat, ramah, fokus closing jualan, dan ajak DM/checkout.',
    templates: [
      {
        id: 'harga',
        keywords: ['harga', 'price', 'berapa'],
        reply: 'Halo @{username}, untuk harga {price}. Kalau mau checkout langsung DM ya.',
      },
      {
        id: 'stok',
        keywords: ['stok', 'ready', 'tersedia'],
        reply: 'Ready kak @{username}. Kalau mau amankan sekarang langsung DM ya.',
      },
      {
        id: 'order',
        keywords: ['order', 'beli', 'checkout'],
        reply: 'Siap kak @{username}, untuk order cepat langsung DM admin ya.',
      },
    ],
    followUpTemplates: [
      'Kak @{username}, kalau mau lanjut checkout langsung DM ya.',
      'Stok berjalan kak @{username}, kalau cocok langsung amankan sekarang ya.',
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

  return {
    enabled: Boolean(source.enabled ?? fallback.enabled),
    mode,
    cooldownSec: Math.max(0, Math.min(600, toPositiveInt(source.cooldownSec, toPositiveInt(fallback.cooldownSec, 20)))),
    maxRepliesPerUser: Math.max(1, Math.min(20, toPositiveInt(source.maxRepliesPerUser, toPositiveInt(fallback.maxRepliesPerUser, 2)))),
    repliesPerComment: Math.max(1, Math.min(IG_AUTO_REPLY_MAX_REPLIES_PER_COMMENT, toPositiveInt(source.repliesPerComment, toPositiveInt(fallback.repliesPerComment, 1)))),
    followUpEnabled: Boolean(source.followUpEnabled ?? fallback.followUpEnabled),
    followUpDelaySec: Math.max(3, Math.min(IG_AUTO_REPLY_MAX_FOLLOWUP_DELAY_SEC, toPositiveInt(source.followUpDelaySec, toPositiveInt(fallback.followUpDelaySec, 18)))),
    pollMs: Math.max(3000, Math.min(30000, toPositiveInt(source.pollMs, toPositiveInt(fallback.pollMs, IG_AUTO_REPLY_POLL_MS)))),
    priceText: String(source.priceText ?? fallback.priceText ?? '').trim().slice(0, 180),
    systemPrompt: String(source.systemPrompt ?? fallback.systemPrompt ?? defaultAutoReplyConfig().systemPrompt).trim().slice(0, 1200),
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

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function calcIgRestartDelayMs(restartCount) {
  const factor = Math.max(0, Number(restartCount) - 1);
  return Math.min(IG_FFMPEG_RESTART_MAX_DELAY_MS, IG_FFMPEG_RESTART_BASE_DELAY_MS * Math.pow(2, factor));
}

class InstagramLiveService {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.browserInitPromise = null;
    this.headless = DEFAULT_IG_HEADLESS;

    this.queue = Promise.resolve();
    this.operationActive = false;
    this.ffmpegRestartTimer = null;
    this.ffmpegManualStop = false;
    this.ffmpegStartConfig = null;
    this.ffmpegProc = null;
    this.autoReplyTimer = null;
    this.autoReplyProcessing = false;
    this.autoReplyConfigPath = path.resolve(process.cwd(), 'db', 'instagram.autoreply.json');
    this.boundPages = new WeakSet();
    this.chatNetworkSourceLogged = false;
    this.followUpTimers = new Set();

    this.state = {
      cookieString: '',
      loggedIn: false,
      username: null,
      live: {
        title: '',
        audience: 'Public',
        streamUrl: null,
        streamKey: null,
        pageUrl: null,
        goLiveReady: false,
        isLive: false,
      },
      ffmpeg: {
        running: false,
        restarting: false,
        restartCount: 0,
        pid: null,
        videoId: null,
        startTime: null,
        resolution: `${DEFAULT_IG_LIVE_WIDTH}x${DEFAULT_IG_LIVE_HEIGHT}`,
        bitrate: '3500k',
        fps: '30',
        loop: false,
        destinations: [],
        lastError: null,
      },
      chat: {
        items: [],
        lastFetchedAt: null,
        networkLastAt: null,
      },
      autoReply: {
        ...defaultAutoReplyConfig(),
        processedCommentIds: [],
        repliedCommentIds: [],
        processedCommentAt: {},
        repliedCommentAt: {},
        userReplyStats: {},
        lastRunAt: null,
        lastReplyAt: null,
        lastError: null,
      },
    };

    this.loadAutoReplyConfigFromDisk();
  }

  addLog(message, type = 'info') {
    const safe = `[IG] ${message}`;
    logger[type] ? logger[type](safe) : logger.info(safe);
    if (typeof global.addLog === 'function') {
      global.addLog(safe, type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'info');
    }
  }

  hasRecentNetworkComments(recentMs = IG_CHAT_NETWORK_RECENT_MS) {
    const value = this.state.chat.networkLastAt;
    if (!value) return false;
    const ts = Date.parse(String(value));
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= Math.max(3000, Number(recentMs) || IG_CHAT_NETWORK_RECENT_MS);
  }

  async isOnLiveSurface() {
    try {
      await this.ensurePage();
      const currentUrl = String(this.page?.url?.() || '').toLowerCase();
      if (/\/live\//i.test(currentUrl) || /broadcast/i.test(currentUrl) || /live\/producer/i.test(currentUrl)) {
        return true;
      }

      return await this.page.evaluate(() => {
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => Boolean(el && (el.offsetParent || el.getClientRects().length));
        const hasLiveButton = Array.from(document.querySelectorAll('button,[role="button"]')).some((el) => {
          const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          if (!text) return false;
          return (
            text === 'go live' ||
            text === 'go live now' ||
            text === 'end live' ||
            text === 'end video' ||
            text === 'siarkan langsung' ||
            text === 'akhiri siaran langsung' ||
            text === 'live video'
          );
        });
        if (hasLiveButton) return true;

        const composerNodes = Array.from(
          document.querySelectorAll('textarea, input[type="text"], div[contenteditable="true"], [role="textbox"]')
        );
        const hasLiveComposer = composerNodes.some((el) => {
          if (!isVisible(el)) return false;
          const marker = normalize(
            `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('data-testid') || ''}`
          );
          if (!marker) return false;
          return /comment|komentar|chat|message|pesan|reply|balas|add a comment|say something|tulis/.test(marker);
        });
        if (hasLiveComposer) return true;

        const hasLiveMeta = Boolean(
          document.querySelector('[aria-label*="live" i], [aria-label*="siaran langsung" i], [aria-label*="live video" i], a[href*="/live/"]')
        );
        return hasLiveMeta;
      });
    } catch (_) {
      return false;
    }
  }

  async ensureLiveSurface() {
    const nowOnLive = await this.isOnLiveSurface();
    if (nowOnLive) return true;

    const candidateUrls = [];
    if (this.state.live?.pageUrl) candidateUrls.push(String(this.state.live.pageUrl));
    if (this.state.live?.isLive && this.state.username) {
      candidateUrls.push(`https://www.instagram.com/${String(this.state.username).replace(/^@/, '')}/live/`);
    }

    for (const url of candidateUrls) {
      if (!url) continue;
      try {
        await this.gotoInstagram(url, { timeout: 30000 });
        if (await this.isOnLiveSurface()) {
          return true;
        }
      } catch (_) {
        // ignore and try next fallback
      }
    }
    return false;
  }

  bindPageEvents(page) {
    if (!page) return;
    if (this.boundPages.has(page)) return;
    this.boundPages.add(page);

    page.on('response', (response) => {
      this.captureCommentsFromResponse(response).catch(() => { });
    });

    if (IG_CHAT_ENABLE_WS) {
      page.on('websocket', (ws) => {
        try {
          const wsUrl = String(ws?.url?.() || '');
          if (!/instagram\.com/i.test(wsUrl)) return;
        } catch (_) {
          return;
        }
        ws.on('framereceived', (event) => {
          const payload = event && Object.prototype.hasOwnProperty.call(event, 'payload') ? event.payload : '';
          this.captureCommentsFromSocketFrame(payload).catch(() => { });
        });
      });
    }
  }

  shouldInspectNetworkResponse(url, contentType) {
    const u = String(url || '').toLowerCase();
    if (!u || !u.includes('instagram.com')) return false;

    const isLiveApi =
      /\/api\/v1\/live\//i.test(u) ||
      /\/live\//i.test(u) ||
      /\/broadcast\//i.test(u);
    if (!isLiveApi) return false;

    if (!/(comment|get_comment|live_comment|broadcast|livechat|realtime)/i.test(u)) return false;
    if (/\/api\/v1\/media\//i.test(u)) return false;
    if (/\/api\/v1\/tags\//i.test(u)) return false;

    const ct = String(contentType || '').toLowerCase();
    if (ct && !/(json|javascript|text\/plain)/i.test(ct)) return false;
    return true;
  }

  normalizeNetworkComment(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const textCandidates = [
      raw.text,
      raw.message,
      raw.content,
      raw.body,
      raw.comment,
      raw?.text_message?.text,
      raw?.node?.text,
      raw?.node?.message,
      raw?.node?.content,
      raw?.snippet?.displayMessage,
    ];
    let text = '';
    for (const candidate of textCandidates) {
      const value = cleanText(candidate, 300);
      if (value) {
        text = value;
        break;
      }
    }
    if (!text || isLikelySystemChatMessage(text)) return null;

    const userCandidates = [
      raw.username,
      raw?.user?.username,
      raw?.author?.username,
      raw?.owner?.username,
      raw?.commenter?.username,
      raw?.from?.username,
      raw?.from?.name,
      raw?.node?.username,
      raw?.node?.user?.username,
      raw?.node?.owner?.username,
    ];
    let username = '';
    for (const candidate of userCandidates) {
      const value = normalizeChatUsername(candidate);
      if (value) {
        username = value;
        break;
      }
    }
    if (!isLikelyIgChatUsername(username)) return null;

    const idCandidates = [
      raw.pk,
      raw.comment_pk,
      raw.comment_id,
      raw.id,
      raw.client_context,
      raw?.node?.id,
      raw?.node?.pk,
    ];
    let id = '';
    for (const candidate of idCandidates) {
      const value = cleanText(candidate, 180);
      if (value) {
        id = value;
        break;
      }
    }

    const at = toIsoTimestamp(
      raw.created_at_utc ??
      raw.created_at ??
      raw.created_time ??
      raw.timestamp ??
      raw.taken_at ??
      raw?.node?.created_at ??
      raw?.node?.created_at_utc
    );

    const fallbackId = `ig:${username}|${text}|${at}`;
    return {
      id: cleanText(id ? `ig:${id}` : fallbackId, 220),
      username,
      text,
      at,
      source: 'network',
    };
  }

  extractNetworkCommentsFromPayload(payload, maxItems = 120) {
    if (!payload || typeof payload !== 'object') return [];

    const queue = [payload];
    const visited = new Set();
    const out = [];
    let scanned = 0;

    while (queue.length && scanned < 1400 && out.length < maxItems) {
      const current = queue.shift();
      scanned += 1;
      if (!current) continue;

      if (Array.isArray(current)) {
        for (const item of current.slice(0, 140)) {
          queue.push(item);
        }
        continue;
      }
      if (typeof current !== 'object') continue;
      if (visited.has(current)) continue;
      visited.add(current);

      const normalized = this.normalizeNetworkComment(current);
      if (normalized) out.push(normalized);

      for (const [key, value] of Object.entries(current).slice(0, 100)) {
        if (!value || typeof value !== 'object') continue;
        const k = String(key || '').toLowerCase();
        if (
          Array.isArray(value) ||
          k.includes('comment') ||
          k.includes('message') ||
          k.includes('broadcast') ||
          k.includes('live') ||
          k === 'data' ||
          k === 'items' ||
          k === 'edges' ||
          k === 'node' ||
          k === 'payload'
        ) {
          queue.push(value);
        }
      }
    }

    const map = new Map();
    for (const item of out) {
      if (!item || !item.id) continue;
      map.set(item.id, item);
    }
    return Array.from(map.values()).slice(-maxItems);
  }

  async captureCommentsFromResponse(response) {
    if (!response || !this.state.loggedIn) return;

    const url = String(response.url() || '');
    const headers = response.headers ? response.headers() : {};
    const contentType = String(headers['content-type'] || headers['Content-Type'] || '');
    if (!this.shouldInspectNetworkResponse(url, contentType)) return;

    const status = Number(response.status ? response.status() : 0);
    if (status >= 400) return;

    let body = '';
    try {
      body = await response.text();
    } catch (_) {
      return;
    }

    const raw = String(body || '').trim();
    if (!raw) return;
    if (raw.length > IG_CHAT_NETWORK_MAX_RESPONSE_BYTES) return;
    const first = raw[0];
    if (first !== '{' && first !== '[') return;

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    const comments = this.extractNetworkCommentsFromPayload(parsed, 120);
    if (!comments.length) return;

    if (!this.hasRecentNetworkComments()) {
      this.state.chat.items = (this.state.chat.items || []).filter((item) => item && item.source === 'network');
    }
    this.mergeFreshComments(comments);
    this.state.chat.lastFetchedAt = new Date().toISOString();
    this.state.chat.networkLastAt = this.state.chat.lastFetchedAt;

    if (!this.chatNetworkSourceLogged) {
      this.chatNetworkSourceLogged = true;
      this.addLog(`Live chat source switched to Instagram network feed (${comments.length} item).`);
    }
  }

  async captureCommentsFromSocketFrame(payload) {
    if (!payload || !this.state.loggedIn) return;

    let text = '';
    if (typeof payload === 'string') {
      text = payload;
    } else if (Buffer.isBuffer(payload)) {
      text = payload.toString('utf8');
    } else if (payload && typeof payload.toString === 'function') {
      text = payload.toString();
    }

    const raw = String(text || '').trim();
    if (!raw) return;
    if (raw.length > IG_CHAT_WS_FRAME_MAX_BYTES) return;
    if (!/(comment|live|broadcast|message|text|username)/i.test(raw)) return;

    let parsed = null;
    const firstJsonIdx = raw.indexOf('{');
    const firstArrIdx = raw.indexOf('[');
    const startIdx = [firstJsonIdx, firstArrIdx].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    if (startIdx >= 0) {
      const candidate = raw.slice(startIdx);
      try {
        parsed = JSON.parse(candidate);
      } catch (_) {
        parsed = null;
      }
    }
    if (!parsed || typeof parsed !== 'object') return;

    const comments = this.extractNetworkCommentsFromPayload(parsed, 120);
    if (!comments.length) return;

    if (!this.hasRecentNetworkComments()) {
      this.state.chat.items = (this.state.chat.items || []).filter((item) => item && item.source === 'network');
    }
    this.mergeFreshComments(comments);
    this.state.chat.lastFetchedAt = new Date().toISOString();
    this.state.chat.networkLastAt = this.state.chat.lastFetchedAt;

    if (!this.chatNetworkSourceLogged) {
      this.chatNetworkSourceLogged = true;
      this.addLog(`Live chat source switched to Instagram websocket feed (${comments.length} item).`);
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
      this.addLog(`Failed loading auto-reply config: ${readableError(err)}`, 'warn');
    }
  }

  saveAutoReplyConfigToDisk() {
    try {
      const dir = path.dirname(this.autoReplyConfigPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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
        templates: this.state.autoReply.templates,
        followUpTemplates: this.state.autoReply.followUpTemplates,
      };
      const body = JSON.stringify(payload, null, 2);
      try {
        fs.writeFileSync(this.autoReplyConfigPath, body, 'utf8');
      } catch (err) {
        if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
          // Recover from stale root-owned file by replacing it.
          fs.unlinkSync(this.autoReplyConfigPath);
          fs.writeFileSync(this.autoReplyConfigPath, body, 'utf8');
          this.addLog('Recovered auto-reply config file permissions by replacing file.', 'warn');
          return;
        }
        throw err;
      }
    } catch (err) {
      this.addLog(`Failed saving auto-reply config: ${readableError(err)}`, 'warn');
    }
  }

  getPublicAutoReplyState() {
    const processedMap = this.state.autoReply.processedCommentAt || {};
    const repliedMap = this.state.autoReply.repliedCommentAt || {};
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
      templates: this.state.autoReply.templates || [],
      followUpTemplates: this.state.autoReply.followUpTemplates || [],
      mistralConfigured: mistralService.isConfigured(),
      processedCount: Object.keys(processedMap).length,
      repliedCount: Object.keys(repliedMap).length,
      lastRunAt: this.state.autoReply.lastRunAt || null,
      lastReplyAt: this.state.autoReply.lastReplyAt || null,
      lastError: this.state.autoReply.lastError || null,
      running: Boolean(this.autoReplyTimer),
      processing: Boolean(this.autoReplyProcessing),
      pendingFollowUps: this.followUpTimers.size,
    };
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

  rememberProcessedComment(commentId) {
    const key = String(commentId || '').trim();
    if (!key) return;
    const list = this.state.autoReply.processedCommentIds || [];
    if (!list.includes(key)) {
      list.push(key);
      if (list.length > 1200) list.splice(0, list.length - 1200);
    }
    this.state.autoReply.processedCommentIds = list;

    const now = Date.now();
    const map = this.state.autoReply.processedCommentAt || {};
    map[key] = now;
    for (const [id, ts] of Object.entries(map)) {
      if (now - Number(ts || 0) > 15 * 60 * 1000) {
        delete map[id];
      }
    }
    this.state.autoReply.processedCommentAt = map;
  }

  wasCommentProcessed(commentId) {
    const key = String(commentId || '').trim();
    if (!key) return false;
    const map = this.state.autoReply.processedCommentAt || {};
    const ts = Number(map[key] || 0);
    if (!ts) return false;
    return Date.now() - ts < IG_AUTO_REPLY_DEDUPE_TTL_MS;
  }

  rememberRepliedComment(commentId) {
    const key = String(commentId || '').trim();
    if (!key) return;
    const list = this.state.autoReply.repliedCommentIds || [];
    if (!list.includes(key)) {
      list.push(key);
      if (list.length > 1200) list.splice(0, list.length - 1200);
    }
    this.state.autoReply.repliedCommentIds = list;

    const now = Date.now();
    const map = this.state.autoReply.repliedCommentAt || {};
    map[key] = now;
    for (const [id, ts] of Object.entries(map)) {
      if (now - Number(ts || 0) > 15 * 60 * 1000) {
        delete map[id];
      }
    }
    this.state.autoReply.repliedCommentAt = map;
  }

  hasRepliedComment(commentId) {
    const key = String(commentId || '').trim();
    if (!key) return false;
    const map = this.state.autoReply.repliedCommentAt || {};
    const ts = Number(map[key] || 0);
    if (!ts) return false;
    return Date.now() - ts < IG_AUTO_REPLY_REPLY_DEDUPE_TTL_MS;
  }

  runExclusive(task) {
    const wrapped = async () => {
      this.operationActive = true;
      try {
        return await task();
      } finally {
        this.operationActive = false;
      }
    };

    const run = this.queue.then(wrapped, wrapped);
    this.queue = run.catch(() => { });
    return run;
  }

  async configureAutoReply(input) {
    return this.runExclusive(async () => {
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
        `Auto-reply ${this.state.autoReply.enabled ? 'enabled' : 'disabled'} (mode=${this.state.autoReply.mode}).`,
        'info'
      );

      return this.getPublicAutoReplyState();
    });
  }

  async getAutoReplySettings() {
    return this.getPublicAutoReplyState();
  }

  startAutoReplyLoop() {
    if (this.autoReplyTimer) return;
    const pollMs = Math.max(3000, Math.min(30000, Number(this.state.autoReply.pollMs) || IG_AUTO_REPLY_POLL_MS));
    this.autoReplyTimer = setInterval(() => {
      this.processAutoReplyTick().catch((err) => {
        this.state.autoReply.lastError = readableError(err);
      });
    }, pollMs);
    this.addLog(`Auto-reply loop started (${pollMs}ms).`);
  }

  stopAutoReplyLoop() {
    if (this.autoReplyTimer) {
      clearInterval(this.autoReplyTimer);
      this.autoReplyTimer = null;
      this.addLog('Auto-reply loop stopped.');
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

  isLikelyLiveSessionActive() {
    if (this.hasRecentNetworkComments()) return true;
    if (this.state.live?.isLive) return true;
    if (this.state.live?.goLiveReady && (this.state.ffmpeg?.running || this.state.ffmpeg?.restarting)) return true;
    if (this.state.ffmpeg?.running && (this.state.live?.streamUrl || this.state.live?.streamKey)) return true;
    const currentUrl = String(this.page?.url?.() || '').toLowerCase();
    if (/\/live\//i.test(currentUrl) || /broadcast/i.test(currentUrl) || /live\/producer/i.test(currentUrl)) return true;
    return false;
  }

  canAutoReplyToComment(comment) {
    if (!comment) return false;
    const username = String(comment.username || '').trim().toLowerCase();
    const me = String(this.state.username || '').trim().toLowerCase();
    if (!username || username === me) return false;
    if (this.hasRepliedComment(comment.id)) return false;

    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[username] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= IG_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    const cooldownMs = Math.max(0, Number(this.state.autoReply.cooldownSec || 0) * 1000);
    if (cooldownMs > 0 && row.lastAt && now - Number(row.lastAt) < cooldownMs) return false;
    if (Number(row.count || 0) >= Number(this.state.autoReply.maxRepliesPerUser || 1)) return false;
    return true;
  }

  markAutoReplySent(comment) {
    if (!comment) return;
    const username = String(comment.username || '').trim().toLowerCase();
    if (!username) return;
    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[username] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= IG_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    row.count = Number(row.count || 0) + 1;
    row.lastAt = now;
    stats[username] = row;
    this.state.autoReply.userReplyStats = stats;
    this.state.autoReply.lastReplyAt = new Date().toISOString();
    this.rememberRepliedComment(comment.id);
  }

  canSendFollowUpToUser(comment) {
    if (!comment) return false;
    const username = String(comment.username || '').trim().toLowerCase();
    if (!username) return false;

    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[username] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= IG_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    if (Number(row.count || 0) >= Number(this.state.autoReply.maxRepliesPerUser || 1)) return false;
    return true;
  }

  markFollowUpSent(comment) {
    if (!comment) return;
    const username = String(comment.username || '').trim().toLowerCase();
    if (!username) return;

    const stats = this.state.autoReply.userReplyStats || {};
    const row = stats[username] || { count: 0, lastAt: 0, windowStartAt: 0 };
    const now = Date.now();
    if (!row.windowStartAt || now - Number(row.windowStartAt) >= IG_AUTO_REPLY_USER_WINDOW_MS) {
      row.count = 0;
      row.windowStartAt = now;
    }
    row.count = Number(row.count || 0) + 1;
    row.lastAt = now;
    stats[username] = row;
    this.state.autoReply.userReplyStats = stats;
    this.state.autoReply.lastReplyAt = new Date().toISOString();
  }

  async generateAiReply(comment) {
    const username = String(comment?.username || '').trim();
    const text = String(comment?.text || '').trim();
    const systemPrompt = `${this.state.autoReply.systemPrompt || ''}\n` +
      `Jawab maksimal 1 kalimat pendek (maks 160 karakter), tanpa emoji berlebihan, bahasa Indonesia santai jualan.\n` +
      `Jika relevan, sisipkan info harga: ${this.state.autoReply.priceText || '-'}.`;
    const userPrompt =
      `Komentar viewer dari @${username}: "${text}".\n` +
      'Buat balasan admin live shop yang ramah, jelas, dan mendorong closing (DM/checkout).';
    const raw = await mistralService.generateReply({
      systemPrompt,
      userPrompt,
      maxTokens: 120,
      temperature: 0.5,
    });
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 170);
  }

  async chooseAutoReply(comment) {
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
      return this.generateAiReply(comment);
    }

    if (template) {
      return renderTemplateReply(template.reply, context);
    }
    if (!mistralService.isConfigured()) return null;
    return this.generateAiReply(comment);
  }

  async generateAiFollowUpReply(comment, previousReply, stepIndex) {
    const username = String(comment?.username || '').trim();
    const text = String(comment?.text || '').trim();
    const prev = String(previousReply || '').trim();
    const systemPrompt = `${this.state.autoReply.systemPrompt || ''}\n` +
      'Ini follow-up komentar live. Jawab 1 kalimat singkat (maks 140 karakter), sopan, tanpa spam, tetap mendorong checkout/DM.';
    const userPrompt =
      `Komentar asli @${username}: "${text}".\n` +
      `Balasan sebelumnya: "${prev || '-'}".\n` +
      `Ini follow-up ke-${Number(stepIndex || 1)}. Info harga: ${this.state.autoReply.priceText || '-'}.\n` +
      'Buat follow-up natural, jangan copy paste kalimat sebelumnya.';
    const raw = await mistralService.generateReply({
      systemPrompt,
      userPrompt,
      maxTokens: 100,
      temperature: 0.45,
    });
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  async chooseFollowUpReply(comment, previousReply, stepIndex = 1) {
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
    const ai = await this.generateAiFollowUpReply(comment, previousReply, stepIndex);
    if (!ai) return null;
    if (ai === previousReply) return null;
    return ai;
  }

  scheduleFollowUpReplies(comment, initialReplyText) {
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
          if (!this.state.autoReply.enabled || !this.state.loggedIn) return;
          if (this.operationActive) return;
          if (!this.isLikelyLiveSessionActive()) return;
          if (!this.canSendFollowUpToUser(comment)) return;
          const onLive = await this.ensureLiveSurface();
          if (!onLive) return;

          const text = await this.chooseFollowUpReply(comment, lastReply, i);
          if (!text) return;

          await this.sendLiveComment(text);
          this.markFollowUpSent(comment);
          lastReply = text;
          this.addLog(`Auto follow-up sent to @${comment.username}: ${text.slice(0, 70)}${text.length > 70 ? '...' : ''}`);
        } catch (err) {
          this.addLog(`Auto follow-up error: ${readableError(err)}`, 'warn');
        }
      }, delaySec * i * 1000);
      this.followUpTimers.add(timer);
    }
  }

  async processAutoReplyTick(force = false) {
    if (this.autoReplyProcessing) return;
    if (!this.state.autoReply.enabled && !force) return;
    if (!this.state.loggedIn || !this.page) return;
    if (!force && this.operationActive) return;
    if (!force && !this.isLikelyLiveSessionActive()) {
      this.state.autoReply.lastRunAt = new Date().toISOString();
      this.state.autoReply.lastError = null;
      return;
    }

    this.autoReplyProcessing = true;
    try {
      const commentsResult = await this.getLiveComments(80).catch(() => ({ items: [] }));
      const comments = Array.isArray(commentsResult?.items) ? commentsResult.items : [];
      if (!comments.length) {
        this.state.autoReply.lastRunAt = new Date().toISOString();
        return;
      }

      let replied = false;
      let sentCount = 0;
      const ordered = comments.slice().reverse();
      for (const comment of ordered) {
        if (!comment || !comment.id) continue;
        if (this.wasCommentProcessed(comment.id)) continue;

        if (!this.canAutoReplyToComment(comment)) continue;

        const replyText = await this.chooseAutoReply(comment);
        if (!replyText) {
          this.rememberProcessedComment(comment.id);
          continue;
        }

        await this.sendLiveComment(replyText);
        this.markAutoReplySent(comment);
        this.rememberProcessedComment(comment.id);
        this.scheduleFollowUpReplies(comment, replyText);
        this.addLog(`Auto-reply sent to @${comment.username}: ${replyText.slice(0, 70)}${replyText.length > 70 ? '...' : ''}`);
        replied = true;
        sentCount += 1;
        if (sentCount >= IG_AUTO_REPLY_MAX_PER_TICK) break;
      }

      this.state.autoReply.lastRunAt = new Date().toISOString();
      this.state.autoReply.lastError = null;

      if (!replied) {
        // no-op when nothing to reply
      }
    } catch (err) {
      this.state.autoReply.lastError = readableError(err);
      this.addLog(`Auto-reply error: ${this.state.autoReply.lastError}`, 'warn');
    } finally {
      this.autoReplyProcessing = false;
    }
  }

  async runAutoReplyOnce() {
    await this.processAutoReplyTick(true);
    return this.getPublicAutoReplyState();
  }

  async ensureBrowser() {
    if (this.browser && typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    if (this.browser) return;

    if (this.browserInitPromise) {
      await this.browserInitPromise;
      return;
    }

    this.browserInitPromise = (async () => {
      const launchOptions = {
        headless: this.headless,
        chromiumSandbox: false,
      };

      if (process.env.CHROME_PATH) {
        launchOptions.executablePath = process.env.CHROME_PATH;
      } else if (fs.existsSync('/opt/google/chrome/chrome')) {
        launchOptions.executablePath = '/opt/google/chrome/chrome';
      }

      this.addLog(`Launching browser (headless=${String(launchOptions.headless)})...`);

      try {
        this.browser = await chromium.launch(launchOptions);
      } catch (err) {
        if (!this.headless) {
          this.addLog(`Headed launch failed: ${readableError(err)}. Retrying headless.`, 'warn');
          this.headless = true;
          launchOptions.headless = true;
          this.browser = await chromium.launch(launchOptions);
        } else {
          throw err;
        }
      }

      await this.resetContext();
    })();

    try {
      await this.browserInitPromise;
    } finally {
      this.browserInitPromise = null;
    }
  }

  async resetContext() {
    await this.ensureBrowser();
    try {
      if (this.context) await this.context.close();
    } catch (_) {
      // ignore close errors
    }

    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 900 },
    });
    this.page = await this.context.newPage();
    this.bindPageEvents(this.page);
  }

  async ensurePage() {
    await this.ensureBrowser();
    if (!this.context) {
      await this.resetContext();
      return;
    }
    if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
      this.page = await this.context.newPage();
      this.bindPageEvents(this.page);
    }
  }

  async recyclePage() {
    await this.ensureBrowser();
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close({ runBeforeUnload: false });
      }
    } catch (_) {
      // ignore close errors
    }
    this.page = await this.context.newPage();
    this.bindPageEvents(this.page);
  }

  async gotoInstagram(url = 'https://www.instagram.com/', options = {}) {
    const timeout = Number(options.timeout || 45000);
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.ensurePage();
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await this.page.waitForTimeout(1600);
        return;
      } catch (err) {
        lastErr = err;
        this.addLog(`Navigation attempt ${attempt}/3 failed: ${readableError(err)}`, 'warn');
        if (attempt < 3) {
          await this.recyclePage();
        }
      }
    }

    throw lastErr || new Error(`Failed to open ${url}`);
  }

  async applyCookies(cookieString) {
    await this.ensureBrowser();
    const cookies = parseCookieString(cookieString);
    if (!cookies.length) {
      throw new Error('Cookie string kosong atau tidak valid.');
    }
    await this.context.clearCookies();
    await this.context.addCookies(cookies);
  }

  async detectLoginStateAndUsername() {
    await this.ensurePage();

    const homeProbe = await this.page.evaluate(() => {
      const path = location.pathname || '';
      const isLoginPath = /\/accounts\/login/.test(path);
      const hasLoginInput =
        !!document.querySelector(
          'input[name="username"], input[name="email"], input[name="password"], input[name="pass"], form input[type="password"]'
        );

      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href') || '')
        .filter(Boolean);
      const blocked = new Set(['/explore/', '/accounts/', '/reels/', '/direct/inbox/', '/']);
      const hit = links.find((href) => {
        if (!/^\/[A-Za-z0-9._]+\/?$/.test(href)) return false;
        return !blocked.has(href);
      });

      return {
        isLoginPath,
        hasLoginInput,
        username: hit ? hit.replaceAll('/', '').trim() || null : null,
      };
    });

    let username = homeProbe.username || null;
    let loggedIn = !homeProbe.isLoginPath && !homeProbe.hasLoginInput;

    if (!loggedIn || !username) {
      try {
        await this.gotoInstagram('https://www.instagram.com/accounts/edit/');
        await this.page.waitForTimeout(1200);
        const editProbe = await this.page.evaluate(() => {
          const path = location.pathname || '';
          const isLoginPath = /\/accounts\/login/.test(path);
          const hasLoginInput =
            !!document.querySelector(
              'input[name="username"], input[name="email"], input[name="password"], input[name="pass"], form input[type="password"]'
            );
          const input = document.querySelector('input[name="username"]');
          const value = (input && input.value ? input.value : '').trim();
          return { isLoginPath, hasLoginInput, username: value || null };
        });
        if (editProbe.username) username = editProbe.username;
        loggedIn = !editProbe.isLoginPath && !editProbe.hasLoginInput;
      } catch (_) {
        // ignore fallback errors
      }
    }

    return {
      loggedIn,
      username,
      pageUrl: this.page.url(),
      pageTitle: await this.page.title(),
    };
  }

  async loginWithCookie(cookieString) {
    return this.runExclusive(async () => {
      const cookie = await this.resolveCookieInput(cookieString);
      if (!cookie) {
        throw new Error('Cookie belum diisi.');
      }
      if (!cookie.includes('=')) {
        throw new Error('Cookie tidak valid. Isi cookie string lengkap atau path file cookie yang benar.');
      }

      await this.gotoInstagram();
      await this.applyCookies(cookie);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2200);

      const auth = await this.detectLoginStateAndUsername();
      if (!auth.loggedIn) {
        this.state.loggedIn = false;
        this.state.username = null;
        throw new Error(`Cookie invalid/expired. Redirected to login page (${auth.pageUrl}).`);
      }

      this.state.cookieString = cookie;
      this.state.loggedIn = true;
      this.state.username = auth.username || null;
      this.state.chat.items = [];
      this.state.chat.lastFetchedAt = null;
      this.state.chat.networkLastAt = null;
      this.chatNetworkSourceLogged = false;
      if (this.state.autoReply.enabled) {
        this.addLog('Auto-reply armed. Loop akan aktif saat stream/live berjalan.');
      }
      this.addLog(`Cookie login success${this.state.username ? ` as @${this.state.username}` : ''}.`);
      return {
        loggedIn: this.state.loggedIn,
        username: this.state.username,
        pageUrl: auth.pageUrl,
      };
    });
  }

  async clickByRole(role, name) {
    await this.ensurePage();
    const locator = this.page.getByRole(role, { name }).first();
    try {
      await locator.click({ timeout: 7000 });
      return;
    } catch (_) {
      await locator.click({ timeout: 7000, force: true });
    }
  }

  async clickByTextRegex(regex, selectors = 'a,button,[role="button"],div[role="button"],span[role="button"]') {
    await this.ensurePage();
    const source = regex instanceof RegExp ? regex.source : String(regex || '');
    const flags = regex instanceof RegExp ? regex.flags : 'i';
    if (!source) return false;

    const clicked = await this.page.evaluate(({ source, flags, selectors }) => {
      const pattern = new RegExp(source, flags);
      const isVisible = (el) => Boolean(el && (el.offsetParent || el.getClientRects().length));
      const candidates = Array.from(document.querySelectorAll(selectors));
      const target = candidates.find((el) => {
        if (!isVisible(el)) return false;
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        if (!text) return false;
        return pattern.test(text);
      });
      if (!target) return false;
      target.click();
      return true;
    }, { source, flags, selectors });
    return Boolean(clicked);
  }

  async clickUi(regex) {
    const steps = [
      async () => this.clickByRole('link', regex),
      async () => this.clickByRole('button', regex),
      async () => {
        const ok = await this.clickByTextRegex(regex);
        if (!ok) throw new Error('not found');
      },
    ];

    let lastErr = null;
    for (const step of steps) {
      try {
        await step();
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`UI element not found: ${String(regex)}`);
  }

  setLiveCredentials({ streamUrl, streamKey, title, audience, goLiveReady } = {}) {
    const parsed = parseIngestCredentials(streamUrl, streamKey);
    if (parsed.streamUrl) this.state.live.streamUrl = parsed.streamUrl;
    if (parsed.streamKey) this.state.live.streamKey = parsed.streamKey;
    if (title !== undefined) this.state.live.title = String(title || '').trim();
    if (audience !== undefined) this.state.live.audience = sanitizeAudience(audience);
    if (goLiveReady !== undefined) this.state.live.goLiveReady = Boolean(goLiveReady);
    return parsed;
  }

  async resolveCookieInput(cookieInput) {
    const raw = String(cookieInput || '').trim();
    if (!raw) {
      const candidates = [
        process.env.IG_COOKIE_FILE,
        path.resolve(process.cwd(), 'cookie'),
        path.resolve(process.cwd(), '../cookie'),
      ].filter(Boolean);
      for (const filePath of candidates) {
        try {
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) continue;
          const content = await fs.promises.readFile(filePath, 'utf8');
          const trimmed = String(content || '').trim();
          if (trimmed) return trimmed;
        } catch (_) {
          // try next candidate
        }
      }
      return '';
    }
    if (raw.includes('=') || raw.includes(';')) return raw;
    const looksPath = raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.includes(path.sep);
    if (!looksPath) return raw;

    try {
      const stat = await fs.promises.stat(raw);
      if (!stat.isFile()) return raw;
      const content = await fs.promises.readFile(raw, 'utf8');
      const trimmed = String(content || '').trim();
      return trimmed || raw;
    } catch (_) {
      return raw;
    }
  }

  findExternalInstagramFfmpeg() {
    const entries = Object.entries(global.streamProcesses || {});
    for (const [videoId, item] of entries) {
      if (!item) continue;
      const destinations = Array.isArray(item.customRtmp)
        ? item.customRtmp
        : item.customRtmp
          ? [item.customRtmp]
          : [];
      const hasInstagramDest = destinations.some((value) => {
        const target = String(value || '');
        return /instagram\.com/i.test(target) || /\.fbcdn\.net/i.test(target);
      });
      if (!hasInstagramDest) continue;
      const pid = Number(item.pid || 0);
      if (!pid || !isProcessAlive(pid)) continue;
      return {
        pid,
        videoId: Number(videoId),
        startTime: item.startTime || null,
      };
    }
    return null;
  }

  async setupLive({ title, audience }) {
    return this.runExclusive(async () => {
      if (!this.state.loggedIn) {
        throw new Error('Belum login Instagram. Jalankan login via cookie dulu.');
      }

      const safeAudience = sanitizeAudience(audience);
      const safeTitle = String(title || '').trim() || 'Live via Streamingku';
      const audienceRoleName =
        safeAudience === 'Public'
          ? /Public|Publik/i
          : safeAudience === 'Practice'
            ? /Practice|Latihan/i
            : /Close friends|Teman dekat/i;

      await this.gotoInstagram('https://www.instagram.com/');
      await this.clickUi(/New post|Buat postingan baru/i);
      await this.page.waitForTimeout(700);
      await this.clickUi(/Live video|Video siaran langsung/i);
      await this.page.waitForTimeout(1300);

      try {
        await this.page.getByRole('textbox', { name: /Add a title|Tambahkan judul/i }).first().fill(safeTitle);
      } catch (_) {
        await this.page.evaluate((value) => {
          const candidates = Array.from(
            document.querySelectorAll('input[type="text"], textarea, input[placeholder*="title" i], input[placeholder*="judul" i]')
          );
          const el = candidates.find((node) => Boolean(node && (node.offsetParent || node.getClientRects().length)));
          if (el) {
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, safeTitle);
      }

      try {
        await this.clickUi(/Audience|Pemirsa/i);
        await this.page.waitForTimeout(350);
        await this.clickUi(audienceRoleName);
        await this.page.waitForTimeout(500);
      } catch (_) {
        this.addLog('Audience selector not found, continuing with default audience from UI.', 'warn');
      }

      let creds = await this.waitStreamCredentials(7000);
      for (let step = 0; step < 6 && (!creds || !creds.streamUrl || !creds.streamKey); step += 1) {
        const clickedNext = await this.clickNextButton();
        if (!clickedNext) break;
        await this.page.waitForTimeout(1600);
        creds = await this.waitStreamCredentials(9000);
      }

      const normalized = this.setLiveCredentials({
        streamUrl: creds?.streamUrl,
        streamKey: creds?.streamKey,
        title: safeTitle,
        audience: safeAudience,
        goLiveReady: creds?.goLiveEnabled,
      });
      this.state.live.pageUrl = this.page?.url?.() || this.state.live.pageUrl;
      this.state.live.isLive = false;

      if (!normalized.streamUrl || !normalized.streamKey) {
        throw new Error('Gagal mengambil stream URL/key dari halaman Instagram Live.');
      }

      this.addLog(`Live setup ready. Audience=${safeAudience}.`);

      return {
        title: safeTitle,
        audience: safeAudience,
        streamUrl: normalized.streamUrl,
        streamKey: normalized.streamKey,
        goLiveReady: Boolean(creds?.goLiveEnabled),
      };
    });
  }

  async extractStreamCredentials() {
    if (!this.page) return null;
    return this.page.evaluate(() => {
      const values = Array.from(document.querySelectorAll('input,textarea,[role="textbox"],code'))
        .map((el) => (el.value || el.textContent || '').trim())
        .filter(Boolean);

      const text = document.body?.innerText || '';
      const blob = `${values.join('\n')}\n${text}`;

      const fullIngestMatch = blob.match(/rtmps?:\/\/[^\s"'`]*live-upload\.instagram\.com(?::\d+)?\/rtmp\/[^\s"'`]+/i);
      let streamUrl = null;
      let streamKey = null;

      if (fullIngestMatch) {
        const full = fullIngestMatch[0].trim();
        const parsed = full.match(/^(rtmps?:\/\/[^/\s]+(?::\d+)?\/rtmp)\/(.+)$/i);
        if (parsed) {
          streamUrl = parsed[1];
          streamKey = parsed[2];
        }
      }

      if (!streamUrl) {
        const urlCandidate =
          blob.match(/rtmps?:\/\/[^\s"'`]*live-upload\.instagram\.com(?::\d+)?\/rtmp\b\/?/i) ||
          blob.match(/rtmps?:\/\/[^\s"'`]+\/rtmp\b\/?/i);
        if (urlCandidate) {
          streamUrl = String(urlCandidate[0] || '').replace(/\/+$/, '');
        }
      }

      if (!streamKey) {
        const keyCandidate =
          values.find((value) => /\?s_bl=|\&s_fbp=|\&a=/.test(value)) ||
          values.find((value) => /^[A-Za-z0-9._-]{8,}\?.+/.test(value)) ||
          values.find((value) => /^[A-Za-z0-9._-]{8,}$/.test(value)) ||
          (blob.match(/[A-Za-z0-9._-]{8,}\?[^\s\n"'`]+/) || [null])[0];
        streamKey = keyCandidate ? String(keyCandidate).trim() : null;
      }

      if (streamUrl && /\/rtmp\/.+/i.test(streamUrl)) {
        const parsed = streamUrl.match(/^(rtmps?:\/\/[^/\s]+(?::\d+)?\/rtmp)\/(.+)$/i);
        if (parsed) {
          streamUrl = parsed[1];
          if (!streamKey) {
            streamKey = parsed[2];
          }
        }
      }

      if (!streamKey && fullIngestMatch) {
        const parsed = String(fullIngestMatch[0]).match(/^(rtmps?:\/\/[^/\s]+(?::\d+)?\/rtmp)\/(.+)$/i);
        if (parsed) {
          streamKey = parsed[2];
          if (!streamUrl) streamUrl = parsed[1];
        }
      }

      streamUrl = streamUrl ? String(streamUrl).replace(/\/+$/, '') : null;
      streamKey = streamKey ? String(streamKey).replace(/^\/+/, '') : null;

      const goLiveEnabled = Array.from(document.querySelectorAll('button')).some((btn) => {
        const btnText = String(btn.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const disabled = Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true');
        return (
          (btnText === 'go live' ||
            btnText === 'go live now' ||
            btnText === 'live now' ||
            btnText === 'siarkan langsung' ||
            btnText === 'mulai siaran langsung') &&
          !disabled
        );
      });

      return {
        streamUrl: streamUrl || null,
        streamKey: streamKey || null,
        goLiveEnabled,
      };
    });
  }

  async waitStreamCredentials(timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const creds = await this.extractStreamCredentials().catch(() => null);
      if (creds && creds.streamUrl && creds.streamKey) {
        return creds;
      }
      await this.page.waitForTimeout(1200);
    }
    return null;
  }

  async clickNextButton() {
    await this.ensurePage();
    const clicked = await this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],div[role="button"]'));
      const target = candidates.find((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) return false;
        const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (disabled) return false;
        return /^Next$/i.test(text) || /^Berikutnya$/i.test(text) || /^Continue$/i.test(text) || /^Lanjutkan$/i.test(text);
      });
      if (!target) return false;
      target.click();
      return true;
    });
    return Boolean(clicked);
  }

  async readLiveComments(limit = 60) {
    await this.ensurePage();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
    const blockedUsernames = Array.from(IG_CHAT_BLOCKED_USERNAMES.values());
    const systemPattern = IG_CHAT_SYSTEM_MSG_RE.source;
    const items = await this.page.evaluate((maxItems, blocked, sysPattern) => {
      const isVisible = (el) => Boolean(el && (el.offsetParent || el.getClientRects().length));
      const blockedUsernames = new Set((Array.isArray(blocked) ? blocked : []).map((x) => String(x || '').toLowerCase()));
      const sysRe = new RegExp(sysPattern || '', 'i');
      const isLikelyUsername = (value) => {
        const username = String(value || '').replace(/^@+/, '').replace(/:$/, '').trim();
        if (!username) return '';
        if (!/^[A-Za-z0-9._]{1,40}$/.test(username)) return '';
        if (blockedUsernames.has(username.toLowerCase())) return '';
        if (/^\d+(?:[.,]\d+)?[kmb]?$/i.test(username)) return '';
        return username;
      };

      const rootCandidates = Array.from(
        document.querySelectorAll(
          '[aria-label*="comment" i], [aria-label*="komentar" i], [aria-label*="chat" i], [aria-label*="pesan" i], main, section, aside'
        )
      ).filter(isVisible);

      const roots = rootCandidates.filter((el) => {
        const marker = `${el.getAttribute('aria-label') || ''} ${el.id || ''} ${el.className || ''}`.toLowerCase();
        const hasChatInput = !!el.querySelector(
          'textarea[placeholder*="comment" i], textarea[aria-label*="comment" i], input[placeholder*="comment" i], [contenteditable="true"]'
        );
        return /comment|komentar|chat|pesan|message|live/i.test(marker) || hasChatInput;
      });

      const scanRoots = (roots.length ? roots : rootCandidates).slice(0, 8);
      if (!scanRoots.length) scanRoots.push(document.body);

      const seen = new Set();
      const rows = [];
      const nodes = [];

      for (const root of scanRoots) {
        const localNodes = Array.from(root.querySelectorAll('li, [role="listitem"], div'));
        for (const node of localNodes) {
          nodes.push(node);
          if (nodes.length >= 2200) break;
        }
        if (nodes.length >= 2200) break;
      }

      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const raw = String(node.innerText || '').trim();
        if (!raw || raw.length < 3 || raw.length > 240) continue;
        if (!raw.includes('\n')) continue;

        const lines = raw
          .split('\n')
          .map((line) => String(line || '').trim())
          .filter(Boolean);
        if (lines.length < 2) continue;

        const header = String(lines[0] || '').trim();
        const usernameMatch = header.match(/^@?([A-Za-z0-9._]{1,40})\b/);
        const username = isLikelyUsername(usernameMatch ? usernameMatch[1] : header);
        const message = String(lines.slice(1).join(' ') || '').trim();
        if (!username || !message) continue;
        if (message.length > 220) continue;
        if (message.length < 2) continue;
        if (/^(follow|lebih lanjut|more|view all|see translation|reply)$/i.test(message)) continue;
        if (sysRe.test(message)) {
          continue;
        }

        const id = `${username}|${message}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          username,
          text: message,
          at: new Date().toISOString(),
          source: 'dom',
        });
      }

      return rows.slice(-maxItems);
    }, safeLimit, blockedUsernames, systemPattern);
    return Array.isArray(items) ? items : [];
  }

  mergeFreshComments(freshItems) {
    const fresh = Array.isArray(freshItems) ? freshItems : [];
    if (!fresh.length) return;
    const merged = [...this.state.chat.items, ...fresh];
    const map = new Map();
    for (const item of merged) {
      const key = String(item?.id || `${item?.username || ''}|${item?.text || ''}`).trim();
      if (!key) continue;
      if (map.has(key)) map.delete(key);
      map.set(key, {
        id: key,
        username: String(item.username || '').trim(),
        text: String(item.text || '').trim(),
        at: item.at || new Date().toISOString(),
        source: item.source || 'dom',
      });
    }
    this.state.chat.items = Array.from(map.values()).slice(-300);
  }

  async getLiveComments(limit = 60) {
    return this.runExclusive(async () => {
      if (!this.state.loggedIn || !this.page) {
        return {
          items: this.state.chat.items.slice(-Math.max(1, Math.min(200, Number(limit) || 60))),
          fetchedAt: this.state.chat.lastFetchedAt,
        };
      }

      if (!this.isLikelyLiveSessionActive()) {
        const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
        return {
          items: this.state.chat.items.slice(-safeLimit),
          fetchedAt: this.state.chat.lastFetchedAt,
        };
      }

      const onLiveSurface = await this.ensureLiveSurface();
      if (!onLiveSurface && !this.hasRecentNetworkComments()) {
        const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
        return {
          items: this.state.chat.items.slice(-safeLimit),
          fetchedAt: this.state.chat.lastFetchedAt,
        };
      }

      if (IG_CHAT_ALLOW_DOM_FALLBACK && !this.hasRecentNetworkComments()) {
        const fresh = await this.readLiveComments(limit).catch(() => []);
        this.mergeFreshComments(fresh);
        this.state.chat.lastFetchedAt = new Date().toISOString();
      } else if (!this.state.chat.lastFetchedAt) {
        this.state.chat.lastFetchedAt = this.state.chat.networkLastAt || new Date().toISOString();
      }

      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
      return {
        items: this.state.chat.items.slice(-safeLimit),
        fetchedAt: this.state.chat.lastFetchedAt,
      };
    });
  }

  async sendLiveComment(message) {
    return this.runExclusive(async () => {
      const text = String(message || '').replace(/\s+/g, ' ').trim();
      if (!text) {
        throw new Error('Komentar kosong.');
      }
      if (!this.state.loggedIn || !this.page) {
        throw new Error('Belum ada sesi Instagram aktif.');
      }
      const onLiveSurface = await this.ensureLiveSurface();
      if (!onLiveSurface) {
        throw new Error('Halaman Instagram live belum aktif. Buka halaman live dulu.');
      }

      const composeState = await this.page.evaluate(() => {
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => Boolean(el && (el.offsetParent || el.getClientRects().length));
        const isDisabled = (el) => Boolean(
          el?.disabled || el?.getAttribute?.('aria-disabled') === 'true' || el?.getAttribute?.('disabled') !== null
        );
        const composerRe = /comment|komentar|chat|message|pesan|reply|balas|add a comment|say something|tulis/i;
        const sendRe = /post|send|kirim|komentar|comment|reply|balas|chat/i;
        document.querySelectorAll('[data-streamfire-composer]').forEach((el) => {
          el.removeAttribute('data-streamfire-composer');
        });
        document.querySelectorAll('[data-streamfire-send-btn]').forEach((el) => {
          el.removeAttribute('data-streamfire-send-btn');
        });

        const candidates = Array.from(
          document.querySelectorAll('textarea, input[type="text"], div[contenteditable="true"], [role="textbox"]')
        ).filter((el) => isVisible(el) && !isDisabled(el));

        const scored = candidates.map((el) => {
          const marker = normalize(
            `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('data-testid') || ''}`
          );
          const rect = el.getBoundingClientRect();
          const localButtons = Array.from((el.closest('form,[role="form"],section,article,div') || document).querySelectorAll('button,[role="button"],div[role="button"],span[role="button"]'))
            .filter((btn) => isVisible(btn) && !isDisabled(btn));
          const hasSendNear = localButtons.some((btn) => {
            const bMark = normalize(btn.innerText || btn.textContent || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.getAttribute('data-testid') || '');
            return sendRe.test(bMark);
          });

          let score = 0;
          if (composerRe.test(marker)) score += 6;
          if (el.getAttribute('contenteditable') === 'true') score += 1;
          if (String(el.getAttribute('role') || '').toLowerCase() === 'textbox') score += 1;
          if (hasSendNear) score += 3;
          if (rect.bottom > window.innerHeight * 0.45) score += 1;
          if (rect.width > 120) score += 1;

          return { el, marker, score };
        }).sort((a, b) => b.score - a.score);

        const target = (scored[0] && scored[0].score > 0 ? scored[0].el : null) || candidates[0] || null;
        if (!target) {
          return {
            reason: 'composer_not_found',
            foundComposer: false,
            hasSendButton: false,
          };
        }

        target.setAttribute('data-streamfire-composer', '1');
        let hasSendButton = false;
        const roots = [];
        let node = target;
        for (let i = 0; i < 6 && node; i += 1) {
          roots.push(node);
          node = node.parentElement;
        }

        for (const root of roots) {
          const buttons = Array.from((root || document).querySelectorAll('button,[role="button"],div[role="button"],span[role="button"]'))
            .filter((btn) => isVisible(btn) && !isDisabled(btn));
          const sendBtn = buttons.find((btn) => {
            const bMark = normalize(btn.innerText || btn.textContent || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.getAttribute('data-testid') || '');
            if (!bMark) return false;
            return sendRe.test(bMark);
          });
          if (sendBtn) {
            sendBtn.setAttribute('data-streamfire-send-btn', '1');
            hasSendButton = true;
            break;
          }
        }

        return {
          reason: hasSendButton ? 'ready' : 'button_not_found',
          foundComposer: true,
          hasSendButton,
        };
      });

      if (!composeState?.foundComposer) {
        throw new Error('Input komentar tidak ditemukan di halaman live.');
      }

      const composer = this.page.locator('[data-streamfire-composer="1"]').first();
      await composer.click({ timeout: 2000 }).catch(() => { });
      await this.page.keyboard.press('Control+A').catch(() => { });
      await this.page.keyboard.press('Backspace').catch(() => { });
      try {
        await composer.fill(text, { timeout: 2200 });
      } catch (_) {
        await this.page.keyboard.type(text, { delay: 20 }).catch(() => { });
      }

      const normalizedLower = text.toLowerCase();
      const encoded = encodeURIComponent(text).toLowerCase();
      const encodedPlus = encoded.replace(/%20/g, '+');
      const sendResponsePromise = this.page.waitForResponse((response) => {
        try {
          const req = response.request();
          if (String(req.method() || '').toUpperCase() !== 'POST') return false;
          const url = String(req.url() || '').toLowerCase();
          if (!url.includes('instagram.com')) return false;
          if (!/(comment|broadcast|live|bloks|realtime)/i.test(url)) return false;
          const body = String(req.postData() || '').toLowerCase();
          if (!body) return false;
          return body.includes(normalizedLower) || body.includes(encoded) || body.includes(encodedPlus);
        } catch (_) {
          return false;
        }
      }, { timeout: 5500 }).catch(() => null);

      let sendMethod = 'enter';
      let actionTriggered = false;
      if (composeState.hasSendButton) {
        actionTriggered = await this.page.locator('[data-streamfire-send-btn="1"]').first().click({ timeout: 2000 })
          .then(() => true)
          .catch(() => false);
        if (actionTriggered) {
          sendMethod = 'local-button';
        }
      }

      if (!actionTriggered) {
        await composer.press('Enter').catch(() => this.page.keyboard.press('Enter').catch(() => { }));
        actionTriggered = true;
        sendMethod = 'enter';
      }

      await this.page.waitForTimeout(450);
      const sendResponse = await sendResponsePromise;
      if (sendResponse && sendResponse.status() >= 400) {
        throw new Error(`Instagram reject komentar (HTTP ${sendResponse.status()}).`);
      }

      const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const expectedText = normalize(text);
      const selfName = normalize(this.state.username);
      let confirmed = false;

      for (let i = 0; i < 10; i += 1) {
        const list = Array.isArray(this.state.chat.items) ? this.state.chat.items.slice(-140) : [];
        confirmed = list.some((item) => {
          const u = normalize(item?.username);
          const t = normalize(item?.text);
          if (!u || !t) return false;
          if (selfName && u !== selfName) return false;
          return t === expectedText || t.includes(expectedText) || expectedText.includes(t);
        });
        if (confirmed) break;

        const fresh = await this.readLiveComments(80).catch(() => []);
        if (fresh.length) {
          this.mergeFreshComments(fresh);
          this.state.chat.lastFetchedAt = new Date().toISOString();
        }
        await this.page.waitForTimeout(450);
      }

      if (!confirmed && !sendResponse) {
        throw new Error('Komentar belum terdeteksi masuk ke chat IG. Coba ulang 1x setelah live stabil.');
      }

      const responseStatus = sendResponse ? sendResponse.status() : null;
      this.addLog(
        `Comment sent via ${sendMethod}${responseStatus ? ` (HTTP ${responseStatus})` : ''}${confirmed ? '' : ' [unconfirmed-feed]'}: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`
      );

      return {
        sent: true,
        confirmed,
        message: text,
        via: sendMethod,
        responseStatus,
        comments: this.state.chat.items.slice(-80),
      };
    });
  }

  async getGoLiveButtonState() {
    await this.ensurePage();
    return this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const matched = buttons.find((btn) => {
        const text = String(btn.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        return (
          text === 'go live' ||
          text === 'go live now' ||
          text === 'live now' ||
          text === 'siarkan langsung' ||
          text === 'mulai siaran langsung'
        );
      });
      if (!matched) {
        return { found: false, enabled: false };
      }
      const disabled = Boolean(matched.disabled || matched.getAttribute('aria-disabled') === 'true');
      return { found: true, enabled: !disabled };
    });
  }

  async clickGoLiveButton() {
    await this.ensurePage();
    const clicked = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find((btn) => {
        const text = String(btn.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const disabled = Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true');
        if (disabled) return false;
        return (
          text === 'go live' ||
          text === 'go live now' ||
          text === 'live now' ||
          text === 'siarkan langsung' ||
          text === 'mulai siaran langsung'
        );
      });
      if (!target) return false;
      target.click();
      return true;
    });
    return Boolean(clicked);
  }

  async waitGoLiveEnabled(timeoutMs = IG_GO_LIVE_WAIT_MS) {
    await this.ensurePage();
    const started = Date.now();
    let lastAdvanceAt = 0;

    while (Date.now() - started < timeoutMs) {
      const state = await this.getGoLiveButtonState();
      if (state.enabled) return true;

      const elapsed = Date.now() - started;
      if (!state.found && elapsed - lastAdvanceAt >= 8000) {
        const clickedNext = await this.clickNextButton().catch(() => false);
        if (clickedNext) {
          this.addLog('Advancing Instagram Live step (Next/Continue)...');
        }

        const dismissed = await this.clickByTextRegex(/Not now|Nanti saja|Skip|Lewati|Close|Tutup|OK|Got it|Allow|Izinkan/i)
          .catch(() => false);
        if (dismissed) {
          this.addLog('Dismissed a blocking popup while waiting Go Live.');
        }
        lastAdvanceAt = elapsed;
      }

      await this.page.waitForTimeout(1500);
    }

    return false;
  }

  async goLive() {
    return this.runExclusive(async () => {
      if (!this.state.ffmpeg.running) {
        if (this.state.ffmpeg.restarting) {
          throw new Error('FFmpeg sedang reconnect. Tunggu sampai status FFMPEG ONLINE lalu klik Go Live lagi.');
        }
        const external = this.findExternalInstagramFfmpeg();
        if (external) {
          this.state.ffmpeg.running = true;
          this.state.ffmpeg.pid = external.pid;
          this.state.ffmpeg.videoId = external.videoId;
          this.state.ffmpeg.startTime = external.startTime || new Date().toISOString();
          this.addLog(`Detected external IG FFmpeg stream (pid=${external.pid}) and using it for Go Live.`);
        } else {
          throw new Error('FFmpeg belum jalan. Start stream IG dulu.');
        }
      }

      const ready = await this.waitGoLiveEnabled(IG_GO_LIVE_WAIT_MS);
      if (!ready) {
        throw new Error(`Tombol Go live tidak aktif dalam ${Math.ceil(IG_GO_LIVE_WAIT_MS / 1000)} detik.`);
      }

      const clicked = await this.clickGoLiveButton();

      if (!clicked) {
        throw new Error('Tombol Go live belum siap atau tidak ditemukan.');
      }

      await this.page.waitForTimeout(1800);
      const liveState = await this.isLive();
      this.state.live.isLive = liveState;
      this.state.live.pageUrl = this.page?.url?.() || this.state.live.pageUrl;
      this.addLog(liveState ? 'Go live clicked successfully.' : 'Go live clicked, waiting live state.');
      return { isLive: liveState };
    });
  }

  async isLive() {
    if (!this.page) return false;
    return this.page.evaluate(() => {
      const text = document.body?.innerText || '';
      return (
        text.includes('End live video') ||
        text.includes('Akhiri video siaran langsung') ||
        text.includes('\nLIVE\n')
      );
    });
  }

  getVideoRow(videoId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT id, filename, title FROM videos WHERE id = ?', [videoId], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      });
    });
  }

  ensureVideoPath(filename) {
    const uploadPath = process.env.UPLOAD_PATH || 'public/uploads';
    const relative = path.join(uploadPath, filename || '');
    const absolute = path.resolve(process.cwd(), relative);
    if (!fs.existsSync(absolute)) return null;
    return absolute;
  }

  clearFfmpegState() {
    this.state.ffmpeg.running = false;
    this.state.ffmpeg.restarting = false;
    this.state.ffmpeg.restartCount = 0;
    this.state.ffmpeg.pid = null;
    this.state.ffmpeg.videoId = null;
    this.state.ffmpeg.startTime = null;
    this.state.ffmpeg.loop = false;
    this.state.ffmpeg.destinations = [];
    this.state.ffmpeg.lastError = null;
    this.ffmpegProc = null;
  }

  clearIgRestartTimer() {
    if (this.ffmpegRestartTimer) {
      clearTimeout(this.ffmpegRestartTimer);
      this.ffmpegRestartTimer = null;
    }
  }

  updateVideoStartTime(videoId, started) {
    const id = Number(videoId);
    if (!Number.isFinite(id) || id <= 0) return;
    const sql = started
      ? "UPDATE videos SET start_time = datetime('now', 'localtime') WHERE id = ?"
      : "UPDATE videos SET start_time = NULL WHERE id = ?";
    db.run(sql, [id], () => { });
  }

  setDashboardStreamState({
    videoId,
    pid,
    proc,
    running,
    restarting,
    restartCount,
    startTime,
    videoPath,
    settings,
    loop,
    destinations,
    ingest,
  }) {
    const id = Number(videoId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!global.streamProcesses) {
      global.streamProcesses = {};
    }

    const current = global.streamProcesses[id] || {};
    global.streamProcesses[id] = {
      ...current,
      owner: 'instagram',
      pid: pid || null,
      proc: proc || current.proc || null,
      videoPath: videoPath || current.videoPath || null,
      settings: settings || current.settings || null,
      loop: loop !== undefined ? Boolean(loop) : Boolean(current.loop),
      customRtmp: Array.isArray(destinations)
        ? destinations
        : (ingest ? [ingest] : current.customRtmp || []),
      keepAlive: false,
      manualStop: false,
      restarting: Boolean(restarting),
      restartCount: Number(restartCount || 0),
      restartTimer: null,
      startTime: startTime || current.startTime || new Date().toISOString(),
      igManaged: true,
    };

    if (global.io && typeof global.io.emit === 'function') {
      global.io.emit('streamStatus', {
        videoId: id,
        pid: pid || null,
        running: Boolean(running),
        restarting: Boolean(restarting),
        restartCount: Number(restartCount || 0),
        startTime: global.streamProcesses[id].startTime,
      });
    }
  }

  clearDashboardStreamState(videoId) {
    const id = Number(videoId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (global.streamProcesses && global.streamProcesses[id]) {
      delete global.streamProcesses[id];
    }
    if (global.io && typeof global.io.emit === 'function') {
      global.io.emit('streamStatus', { videoId: id, running: false, restarting: false });
    }
  }

  attachFfmpegProcess(proc, config) {
    if (!proc) return;
    proc.on('close', (code, signal) => {
      this.onInstagramFfmpegClosed(code, signal, config);
    });
  }

  onInstagramFfmpegClosed(code, signal, config) {
    const normalStop = signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGKILL' || code === 0 || code === 255;
    if (!normalStop) {
      this.state.ffmpeg.lastError = `ffmpeg exited code=${code} signal=${signal || 'none'}`;
    }
    this.ffmpegProc = null;

    if (this.ffmpegManualStop || !this.ffmpegStartConfig) {
      this.clearDashboardStreamState(config?.videoId || this.state.ffmpeg.videoId);
      this.updateVideoStartTime(config?.videoId || this.state.ffmpeg.videoId, false);
      this.clearFfmpegState();
      return;
    }

    this.state.ffmpeg.running = false;
    this.state.ffmpeg.restarting = true;
    this.state.ffmpeg.pid = null;
    this.state.ffmpeg.restartCount = Number(this.state.ffmpeg.restartCount || 0) + 1;
    const delayMs = calcIgRestartDelayMs(this.state.ffmpeg.restartCount);
    this.setDashboardStreamState({
      videoId: config?.videoId || this.state.ffmpeg.videoId,
      pid: null,
      proc: null,
      running: false,
      restarting: true,
      restartCount: this.state.ffmpeg.restartCount,
      startTime: this.state.ffmpeg.startTime || new Date().toISOString(),
      videoPath: config?.videoPath,
      settings: config?.settings,
      loop: config?.loop,
      destinations: config?.outputs || (config?.ingest ? [config.ingest] : []),
      ingest: config?.ingest,
    });
    this.addLog(
      `IG FFmpeg disconnected. Reconnecting in ${Math.ceil(delayMs / 1000)}s (attempt ${this.state.ffmpeg.restartCount}).`,
      'warn'
    );

    this.clearIgRestartTimer();
    this.ffmpegRestartTimer = setTimeout(() => {
      if (this.ffmpegManualStop || !this.ffmpegStartConfig) {
        this.clearFfmpegState();
        return;
      }

      const restarted = startStream(
        this.ffmpegStartConfig.videoPath,
        this.ffmpegStartConfig.settings,
        this.ffmpegStartConfig.loop,
        this.ffmpegStartConfig.outputs || [this.ffmpegStartConfig.ingest]
      );

      if (!restarted) {
        this.state.ffmpeg.restarting = false;
        this.state.ffmpeg.running = false;
        this.state.ffmpeg.lastError = 'Gagal reconnect ffmpeg ke ingest Instagram.';
        this.clearDashboardStreamState(config?.videoId || this.state.ffmpeg.videoId);
        this.updateVideoStartTime(config?.videoId || this.state.ffmpeg.videoId, false);
        this.addLog(this.state.ffmpeg.lastError, 'error');
        return;
      }

      this.ffmpegProc = restarted;
      this.state.ffmpeg.running = true;
      this.state.ffmpeg.restarting = false;
      this.state.ffmpeg.pid = restarted.pid;
      this.state.ffmpeg.startTime = new Date().toISOString();
      this.state.ffmpeg.destinations = config?.outputs || (config?.ingest ? [config.ingest] : this.state.ffmpeg.destinations);
      this.setDashboardStreamState({
        videoId: config?.videoId || this.state.ffmpeg.videoId,
        pid: restarted.pid,
        proc: restarted,
        running: true,
        restarting: false,
        restartCount: this.state.ffmpeg.restartCount || 0,
        startTime: this.state.ffmpeg.startTime,
        videoPath: config?.videoPath,
        settings: config?.settings,
        loop: config?.loop,
        destinations: config?.outputs || (config?.ingest ? [config.ingest] : []),
        ingest: config?.ingest,
      });
      this.updateVideoStartTime(config?.videoId || this.state.ffmpeg.videoId, true);
      this.addLog(`IG FFmpeg reconnected (pid=${restarted.pid}).`, 'success');
      this.attachFfmpegProcess(restarted, this.ffmpegStartConfig);
    }, delayMs);
  }

  async startStreamFromVideo({ videoId, settings, loop, streamUrl, streamKey, multiRtmp }) {
    return this.runExclusive(async () => {
      if (String(streamUrl || '').trim() || String(streamKey || '').trim()) {
        this.setLiveCredentials({ streamUrl, streamKey });
      }
      if (!this.state.live.streamUrl || !this.state.live.streamKey) {
        throw new Error('Stream URL/Key belum tersedia. Jalankan setup live atau isi manual stream URL + key.');
      }
      if (this.state.ffmpeg.running || this.state.ffmpeg.restarting) {
        throw new Error('Stream Instagram sedang berjalan. Stop dulu sebelum start baru.');
      }
      if (global.streamProcesses && global.streamProcesses[videoId]) {
        throw new Error('Video ini sedang dipakai stream lain. Stop stream itu dulu.');
      }

      const row = await this.getVideoRow(videoId);
      if (!row || !row.filename) {
        throw new Error('Video tidak ditemukan di database Streamingku.');
      }

      const videoPath = this.ensureVideoPath(row.filename);
      if (!videoPath) {
        throw new Error('File video tidak ditemukan di server.');
      }

      const normalized = parseIngestCredentials(this.state.live.streamUrl, this.state.live.streamKey);
      this.state.live.streamUrl = normalized.streamUrl;
      this.state.live.streamKey = normalized.streamKey;
      const ingest = normalized.ingest;
      if (!ingest) {
        throw new Error('Ingest Instagram belum valid.');
      }
      const mirrors = normalizeRtmpDestinations(multiRtmp).filter((url) => /^rtmps?:\/\//i.test(url));
      const outputs = uniqueDestinations([ingest, ...mirrors]);

      const safeSettings = {
        resolution: sanitizeResolution(settings?.resolution),
        bitrate: String(settings?.bitrate || '3500k'),
        fps: String(settings?.fps || '30'),
      };
      const shouldLoop = Boolean(loop);

      const proc = startStream(videoPath, safeSettings, shouldLoop, outputs);
      if (!proc) {
        throw new Error('Gagal start FFmpeg untuk stream Instagram.');
      }

      this.ffmpegManualStop = false;
      this.clearIgRestartTimer();
      this.ffmpegStartConfig = {
        videoPath,
        settings: safeSettings,
        loop: shouldLoop,
        ingest,
        outputs,
        videoId: Number(videoId),
      };

      this.state.ffmpeg.running = true;
      this.state.ffmpeg.restarting = false;
      this.state.ffmpeg.restartCount = 0;
      this.state.ffmpeg.pid = proc.pid;
      this.state.ffmpeg.videoId = Number(videoId);
      this.state.ffmpeg.startTime = new Date().toISOString();
      this.state.ffmpeg.resolution = safeSettings.resolution;
      this.state.ffmpeg.bitrate = safeSettings.bitrate;
      this.state.ffmpeg.fps = safeSettings.fps;
      this.state.ffmpeg.loop = shouldLoop;
      this.state.ffmpeg.destinations = outputs;
      this.state.ffmpeg.lastError = null;
      this.state.live.isLive = false;
      this.ffmpegProc = proc;

      this.setDashboardStreamState({
        videoId: Number(videoId),
        pid: proc.pid,
        proc,
        running: true,
        restarting: false,
        restartCount: 0,
        startTime: this.state.ffmpeg.startTime,
        videoPath,
        settings: safeSettings,
        loop: shouldLoop,
        destinations: outputs,
        ingest,
      });
      db.run(
        "UPDATE videos SET destinations = ?, start_time = datetime('now', 'localtime'), resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
        [JSON.stringify(outputs), safeSettings.resolution, safeSettings.bitrate, safeSettings.fps, shouldLoop ? 1 : 0, Number(videoId)],
        () => { }
      );

      if (this.state.autoReply.enabled) {
        this.startAutoReplyLoop();
      }

      this.attachFfmpegProcess(proc, this.ffmpegStartConfig);

      this.addLog(`IG FFmpeg started for video #${videoId} (pid=${proc.pid}).`);
      return {
        pid: proc.pid,
        videoId: Number(videoId),
        title: row.title,
        resolution: safeSettings.resolution,
        bitrate: safeSettings.bitrate,
        fps: safeSettings.fps,
        loop: shouldLoop,
        destinations: outputs,
        outputsCount: outputs.length,
      };
    });
  }

  async stopStreamInternal() {
    if (!this.state.ffmpeg.running && !this.state.ffmpeg.restarting && !this.state.ffmpeg.pid) {
      return { stopped: false };
    }

    const activeVideoId = this.state.ffmpeg.videoId || this.ffmpegStartConfig?.videoId || null;
    this.ffmpegManualStop = true;
    this.clearIgRestartTimer();
    const activePid = this.state.ffmpeg.pid;
    const processInfo = Object.values(global.streamProcesses || {}).find((item) => item && item.pid === activePid);
    if (activePid && processInfo && processInfo.proc) {
      processInfo.proc.kill('SIGKILL');
    } else if (activePid) {
      try {
        process.kill(activePid, 'SIGKILL');
      } catch (_) {
        // process already stopped
      }
    }

    this.clearFfmpegState();
    this.ffmpegProc = null;
    this.ffmpegStartConfig = null;
    this.stopAutoReplyLoop();
    this.clearDashboardStreamState(activeVideoId);
    this.updateVideoStartTime(activeVideoId, false);
    this.addLog('IG FFmpeg stopped.');
    return { stopped: true };
  }

  async stopStream() {
    return this.runExclusive(async () => {
      return this.stopStreamInternal();
    });
  }

  async endLive() {
    return this.runExclusive(async () => {
      await this.ensurePage();

      await this.page.evaluate(() => {
        const endButton = Array.from(document.querySelectorAll('button')).find((button) => {
          const text = (button.innerText || '').trim();
          return /End live video|Akhiri video siaran langsung/i.test(text);
        });
        if (endButton) endButton.click();
      });
      await this.page.waitForTimeout(1200);

      await this.page.evaluate(() => {
        const confirm = Array.from(document.querySelectorAll('button')).find((button) => {
          const text = (button.innerText || '').trim();
          return /^Discard$/i.test(text) || /^End$/i.test(text) || /^Akhiri$/i.test(text);
        });
        if (confirm) confirm.click();
      });

      await this.page.waitForTimeout(900);
      this.state.live.isLive = false;
      await this.stopStreamInternal();
      this.addLog('End-live flow triggered.');
      return { ended: true };
    });
  }

  async getStatus() {
    let onLiveSurface = false;
    let currentUrl = null;
    const external = this.findExternalInstagramFfmpeg();
    if (external && (!this.state.ffmpeg.running || !isProcessAlive(this.state.ffmpeg.pid))) {
      this.state.ffmpeg.running = true;
      this.state.ffmpeg.pid = external.pid;
      this.state.ffmpeg.videoId = external.videoId;
      this.state.ffmpeg.startTime = external.startTime || this.state.ffmpeg.startTime || new Date().toISOString();
      this.setDashboardStreamState({
        videoId: external.videoId,
        pid: external.pid,
        proc: null,
        running: true,
        restarting: false,
        restartCount: this.state.ffmpeg.restartCount || 0,
        startTime: this.state.ffmpeg.startTime,
      });
    }

    if (!external && this.state.ffmpeg.running && !isProcessAlive(this.state.ffmpeg.pid)) {
      this.clearDashboardStreamState(this.state.ffmpeg.videoId);
      this.updateVideoStartTime(this.state.ffmpeg.videoId, false);
      this.clearFfmpegState();
    }

    if (!this.operationActive && this.page) {
      try {
        const [liveState, creds] = await Promise.all([
          this.isLive().catch(() => false),
          this.extractStreamCredentials().catch(() => null),
        ]);
        this.state.live.isLive = Boolean(liveState);
        currentUrl = this.page?.url?.() || null;
        onLiveSurface = await this.isOnLiveSurface().catch(() => false);
        if (currentUrl) this.state.live.pageUrl = currentUrl;
        if (creds) {
          this.state.live.streamUrl = creds.streamUrl || this.state.live.streamUrl;
          this.state.live.streamKey = creds.streamKey || this.state.live.streamKey;
          this.state.live.goLiveReady = Boolean(creds.goLiveEnabled);
        }
      } catch (_) {
        // no-op on passive status refresh
      }
    }

    return {
      loggedIn: this.state.loggedIn,
      username: this.state.username,
      browser: {
        ready: Boolean(this.browser),
        headless: this.headless,
      },
      live: {
        title: this.state.live.title,
        audience: this.state.live.audience,
        streamUrl: this.state.live.streamUrl || null,
        streamKey: this.state.live.streamKey || null,
        pageUrl: this.state.live.pageUrl || currentUrl || null,
        onLiveSurface: Boolean(onLiveSurface),
        streamUrlReady: Boolean(this.state.live.streamUrl),
        streamKeyReady: Boolean(this.state.live.streamKey),
        goLiveReady: Boolean(this.state.live.goLiveReady),
        isLive: Boolean(this.state.live.isLive),
      },
      ffmpeg: {
        running: this.state.ffmpeg.running,
        online: this.state.ffmpeg.running || this.state.ffmpeg.restarting,
        restarting: this.state.ffmpeg.restarting,
        restartCount: this.state.ffmpeg.restartCount,
        pid: this.state.ffmpeg.pid,
        videoId: this.state.ffmpeg.videoId,
        startTime: this.state.ffmpeg.startTime,
        resolution: this.state.ffmpeg.resolution,
        bitrate: this.state.ffmpeg.bitrate,
        fps: this.state.ffmpeg.fps,
        loop: this.state.ffmpeg.loop,
        destinations: this.state.ffmpeg.destinations || [],
        destinationsCount: Array.isArray(this.state.ffmpeg.destinations) ? this.state.ffmpeg.destinations.length : 0,
        lastError: this.state.ffmpeg.lastError,
      },
      chat: {
        items: this.state.chat.items || [],
        count: Array.isArray(this.state.chat.items) ? this.state.chat.items.length : 0,
        lastFetchedAt: this.state.chat.lastFetchedAt || null,
        networkLastAt: this.state.chat.networkLastAt || null,
        source: this.hasRecentNetworkComments() ? 'network' : (IG_CHAT_ALLOW_DOM_FALLBACK ? 'dom' : 'network-wait'),
      },
      autoReply: this.getPublicAutoReplyState(),
      active: this.operationActive,
    };
  }

  async close() {
    await this.stopStreamInternal().catch(() => { });
    this.stopAutoReplyLoop();
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (_) {
        // ignore close errors
      }
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

module.exports = new InstagramLiveService();

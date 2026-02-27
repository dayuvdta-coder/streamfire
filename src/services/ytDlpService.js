const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('../utils/logger');

const ytDlpPath = String(process.env.YT_DLP_BIN || 'yt-dlp').trim() || 'yt-dlp';
const ytDlpTimeoutMs = Math.max(30_000, Math.min(1_800_000, Number(process.env.YTDLP_TIMEOUT_MS || 600_000)));

let warnedMissingCookies = false;

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isYoutubeUrl(value) {
  return /(?:youtube\.com|youtu\.be)/i.test(String(value || '').trim());
}

function normalizeErrorMessage(input) {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function getCommonArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--force-ipv4',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--retry-sleep',
    '2',
  ];

  const proxy = String(process.env.YTDLP_PROXY || '').trim();
  if (proxy) {
    args.push('--proxy', proxy);
  }

  const cookiesFile = String(process.env.YTDLP_COOKIES_FILE || '').trim();
  if (cookiesFile) {
    if (fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    } else if (!warnedMissingCookies) {
      warnedMissingCookies = true;
      logger.warn(`YTDLP_COOKIES_FILE is set but file not found: ${cookiesFile}`);
    }
  }

  return args;
}

function runCommand(command, args = [], timeoutMs = ytDlpTimeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        // ignore kill errors
      }
      finish(new Error(`yt-dlp timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
      } else {
        const raw = normalizeErrorMessage(stderr || stdout || `exit code ${code}`);
        finish(new Error(raw || `Command "${command}" failed`));
      }
    });
  });
}

async function runYtDlpAttempts({ sourceUrl, purpose, attempts }) {
  const errors = [];

  for (const attempt of attempts) {
    try {
      return await runCommand(ytDlpPath, attempt.args);
    } catch (err) {
      const msg = normalizeErrorMessage(err.message);
      errors.push(`[${attempt.name}] ${msg}`);
      logger.warn(`yt-dlp ${purpose} attempt "${attempt.name}" failed for ${sourceUrl}: ${msg}`);
    }
  }

  const merged = errors.join(' | ');
  const got403 = /403|forbidden/i.test(merged);
  let hint = '';
  if (isYoutubeUrl(sourceUrl) && got403) {
    hint = ' (403 dari YouTube. Coba update yt-dlp/redeploy terbaru atau isi YTDLP_COOKIES_FILE untuk video terbatas.)';
  }

  throw new Error(`${merged || 'yt-dlp gagal tanpa detail.'}${hint}`.slice(0, 1800));
}

function buildYoutubeResolveAttempts(sourceUrl) {
  const common = getCommonArgs();
  return [
    {
      name: 'android-best',
      args: [...common, '--extractor-args', 'youtube:player_client=android', '-f', 'best', '-g', sourceUrl],
    },
    {
      name: 'web-best',
      args: [...common, '--extractor-args', 'youtube:player_client=web', '-f', 'best', '-g', sourceUrl],
    },
    {
      name: 'plain-best',
      args: [...common, '-f', 'best', '-g', sourceUrl],
    },
  ];
}

async function resolveYoutubeDirectUrl(sourceUrl) {
  const output = await runYtDlpAttempts({
    sourceUrl,
    purpose: 'resolve',
    attempts: buildYoutubeResolveAttempts(sourceUrl),
  });

  const lines = String(output.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const resolved = lines.find((line) => isHttpUrl(line)) || '';
  if (!resolved) {
    throw new Error('yt-dlp tidak mengembalikan direct URL yang valid.');
  }

  return resolved;
}

function buildDownloadAttempts(sourceUrl, outputTemplate, maxFileSize = '2G') {
  const common = [
    ...getCommonArgs(),
    '--restrict-filenames',
    '--no-part',
    '--max-filesize',
    String(maxFileSize || '2G'),
    '-o',
    outputTemplate,
  ];

  if (isYoutubeUrl(sourceUrl)) {
    return [
      {
        name: 'youtube-android-mp4',
        args: [
          ...common,
          '--extractor-args',
          'youtube:player_client=android',
          '--merge-output-format',
          'mp4',
          '-f',
          'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
          sourceUrl,
        ],
      },
      {
        name: 'youtube-web-remux',
        args: [
          ...common,
          '--extractor-args',
          'youtube:player_client=web',
          '--remux-video',
          'mp4',
          '-f',
          'bv*+ba/b',
          sourceUrl,
        ],
      },
      {
        name: 'youtube-plain-best',
        args: [
          ...common,
          '--remux-video',
          'mp4',
          '-f',
          'best',
          sourceUrl,
        ],
      },
    ];
  }

  return [
    {
      name: 'generic-mp4',
      args: [...common, '--merge-output-format', 'mp4', '-f', 'b[ext=mp4]/best', sourceUrl],
    },
    {
      name: 'generic-best',
      args: [...common, '--remux-video', 'mp4', '-f', 'best', sourceUrl],
    },
  ];
}

async function downloadVideoToTemplate({ sourceUrl, outputTemplate, maxFileSize = '2G' }) {
  if (!isHttpUrl(sourceUrl)) {
    throw new Error('Link tidak valid. Gunakan URL http/https.');
  }

  const attempts = buildDownloadAttempts(sourceUrl, outputTemplate, maxFileSize);
  await runYtDlpAttempts({
    sourceUrl,
    purpose: 'download',
    attempts,
  });
}

module.exports = {
  isHttpUrl,
  isYoutubeUrl,
  resolveYoutubeDirectUrl,
  downloadVideoToTemplate,
};

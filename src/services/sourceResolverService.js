const { spawn } = require('child_process');

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isYoutubeUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /(?:youtube\.com|youtu\.be)/i.test(raw);
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const msg = String(stderr || stdout || `exit code ${code}`).trim();
        reject(new Error(msg));
      }
    });
  });
}

async function resolveYoutubeSource(url) {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--prefer-free-formats',
    '-f',
    'best',
    '-g',
    url,
  ];

  let output;
  try {
    output = await runCommand('yt-dlp', args);
  } catch (err) {
    throw new Error(`Gagal resolve link YouTube. Pastikan yt-dlp terinstall. Detail: ${err.message}`);
  }

  const lines = String(output.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const resolved = lines[0] || '';

  if (!isHttpUrl(resolved)) {
    throw new Error('yt-dlp tidak mengembalikan direct media URL yang valid.');
  }

  return {
    provider: 'youtube',
    originalUrl: url,
    resolvedUrl: resolved,
  };
}

async function resolveSourceUrl(inputUrl) {
  const sourceUrl = String(inputUrl || '').trim();
  if (!isHttpUrl(sourceUrl)) {
    throw new Error('Source URL tidak valid. Gunakan link http/https.');
  }

  if (isYoutubeUrl(sourceUrl)) {
    return resolveYoutubeSource(sourceUrl);
  }

  return {
    provider: 'direct',
    originalUrl: sourceUrl,
    resolvedUrl: sourceUrl,
  };
}

module.exports = {
  resolveSourceUrl,
  isYoutubeUrl,
};

const {
  isHttpUrl,
  isYoutubeUrl,
  resolveYoutubeDirectUrl,
} = require('./ytDlpService');

async function resolveYoutubeSource(url) {
  try {
    const resolved = await resolveYoutubeDirectUrl(url);
    return {
      provider: 'youtube',
      originalUrl: url,
      resolvedUrl: resolved,
    };
  } catch (err) {
    throw new Error(`Gagal resolve link YouTube. Pastikan yt-dlp terinstall. Detail: ${err.message}`);
  }
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

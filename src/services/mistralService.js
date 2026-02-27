const DEFAULT_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const DEFAULT_BASE_URL = process.env.MISTRAL_API_BASE_URL || 'https://api.mistral.ai/v1';

function getApiKey() {
  return String(process.env.MISTRAL_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(getApiKey());
}

async function generateReply({
  systemPrompt,
  userPrompt,
  model = DEFAULT_MODEL,
  temperature = 0.6,
  maxTokens = 140,
  timeoutMs = 20000,
}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY belum di-set.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 20000));

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: Number(temperature) || 0.6,
        max_tokens: Math.max(50, Math.min(500, Number(maxTokens) || 140)),
        messages: [
          { role: 'system', content: String(systemPrompt || '').trim() },
          { role: 'user', content: String(userPrompt || '').trim() },
        ],
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
      throw new Error(`Mistral API error: ${detail}`);
    }

    const message = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(message)
      ? message.map((part) => (typeof part === 'string' ? part : part?.text || '')).join(' ')
      : String(message || '');

    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) {
      throw new Error('Mistral API mengembalikan balasan kosong.');
    }
    return clean;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isConfigured,
  generateReply,
};

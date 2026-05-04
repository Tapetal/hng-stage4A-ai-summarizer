/**
 * Background Service Worker — the ONLY place the API key lives.
 * Receives messages from the popup, calls the AI API, returns results.
 * API key is read from chrome.storage.local (user-provided, never hardcoded).
 */

'use strict';
const GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_MODEL = 'gpt-5.4-mini';
const BACKEND_SUMMARIZE_URL = 'https://hng-stage4a-ai-summarizer.onrender.com/summarize';
const PROVIDER_COOLDOWN_KEY = 'providerCooldowns';
const DEFAULT_COOLDOWN_SECONDS = {
  gemini: 90,
  openai: 30,
};
const SUMMARY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'array',
      items: { type: 'string' },
      description: 'Three to five concise bullet points summarizing the page.',
    },
    key_insights: {
      type: 'array',
      items: { type: 'string' },
      description: 'Two to three non-duplicate insights, implications, or notable patterns.',
    },
    reading_time_minutes: {
      type: 'number',
      description: 'Estimated reading time for the original page content in minutes.',
    },
    keyPhrases: {
      type: 'array',
      items: { type: 'string' },
      description: 'Four to six short phrases from the page that are useful for highlighting.',
    },
  },
  required: ['summary', 'key_insights', 'reading_time_minutes', 'keyPhrases'],
};
const providerCooldownsMemory = {};
const SENTENCE_END_RE = /(?<=[.!?])\s+/;
const HEADLINE_SPLIT_RE = /\s+(?=(?:[A-Z][a-z]+|[A-Z]{2,})\s+(?:[a-z]+|[A-Z][a-z]+|[A-Z]{2,})\b)/g;

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimiter = {
  requests: [],
  limit: 10,
  windowMs: 60 * 1000,
  check() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    if (this.requests.length >= this.limit) {
      const oldest = this.requests[0];
      const waitSec = Math.ceil((this.windowMs - (now - oldest)) / 1000);
      throw new Error(`Rate limit reached. Please wait ${waitSec}s.`);
    }
    this.requests.push(now);
  },
};

// ── In-flight request lock ────────────────────────────────────────────────────
let aiRequestInFlight = false;

function acquireAiRequestLock() {
  if (aiRequestInFlight) {
    throw new Error('REQUEST_IN_PROGRESS');
  }
  aiRequestInFlight = true;
}

function releaseAiRequestLock() {
  aiRequestInFlight = false;
}

// ── Provider cooldown helpers ─────────────────────────────────────────────────
async function getProviderCooldownUntil(provider) {
  return new Promise(resolve => {
    chrome.storage.local.get([PROVIDER_COOLDOWN_KEY], result => {
      const cooldowns = result[PROVIDER_COOLDOWN_KEY] || {};
      resolve(Math.max(providerCooldownsMemory[provider] || 0, cooldowns[provider] || 0));
    });
  });
}

async function assertProviderCooldown(provider) {
  const cooldownUntil = await getProviderCooldownUntil(provider);
  const waitSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);

  if (waitSeconds > 0) {
    const label = provider === 'openai' ? 'OpenAI' : 'Gemini';
    throw new Error(formatCooldownError(provider, waitSeconds, `${label} is cooling down after a rate-limit response.`));
  }
}

function setProviderCooldown(provider, retrySeconds) {
  const baseSeconds = Number.isFinite(retrySeconds) && retrySeconds > 0
    ? Math.ceil(retrySeconds) + 15
    : DEFAULT_COOLDOWN_SECONDS[provider] || 60;
  const cooldownSeconds = Math.max(baseSeconds, DEFAULT_COOLDOWN_SECONDS[provider] || 60);
  const cooldownUntil = Date.now() + cooldownSeconds * 1000;

  providerCooldownsMemory[provider] = cooldownUntil;

  chrome.storage.local.get([PROVIDER_COOLDOWN_KEY], result => {
    const cooldowns = result[PROVIDER_COOLDOWN_KEY] || {};
    cooldowns[provider] = cooldownUntil;
    chrome.storage.local.set({ [PROVIDER_COOLDOWN_KEY]: cooldowns });
  });

  return cooldownSeconds;
}

function getRetrySecondsFromMessage(message) {
  const retryMatch = String(message || '').match(/retry in ([\d.]+)s/i);
  return retryMatch ? Math.ceil(Number(retryMatch[1])) : null;
}

function formatCooldownError(provider, waitSeconds, reason) {
  const extra = provider === 'gemini'
    ? ' Cached summaries still work, and you can switch to OpenAI in Settings if needed.'
    : '';
  return `COOLDOWN:${provider}:${waitSeconds}:${reason} Please wait ${waitSeconds} seconds before trying again.${extra}`;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
async function getCached(url) {
  return new Promise(resolve => {
    chrome.storage.local.get(['summaryCache'], result => {
      const cache = result.summaryCache || {};
      resolve(cache[url] || null);
    });
  });
}

async function setCached(url, summary) {
  return new Promise(resolve => {
    chrome.storage.local.get(['summaryCache'], result => {
      const cache = result.summaryCache || {};
      cache[url] = { ...summary, cachedAt: Date.now() };
      // Keep cache to last 50 entries
      const keys = Object.keys(cache);
      if (keys.length > 50) {
        const oldest = keys.sort((a, b) => (cache[a].cachedAt || 0) - (cache[b].cachedAt || 0));
        oldest.slice(0, keys.length - 50).forEach(k => delete cache[k]);
      }
      chrome.storage.local.set({ summaryCache: cache }, resolve);
    });
  });
}

function hasSummaryContent(summary) {
  return Array.isArray(summary?.bullets) && summary.bullets.some(item => String(item).trim());
}

// ── API key retrieval ─────────────────────────────────────────────────────────
async function getApiKey() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['apiKey', 'apiProvider'], result => {
      if (!result.apiKey) {
        reject(new Error('NO_API_KEY'));
      } else {
        resolve({ key: result.apiKey, provider: result.apiProvider || 'gemini' });
      }
    });
  });
}

// ── Build AI prompt ───────────────────────────────────────────────────────────
function buildPrompt(title, text, estimatedReadingTime) {
  return `You are a helpful assistant that summarizes web pages.

Return ONLY valid JSON in this exact format:
{
  "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],
  "key_insights": ["insight 1", "insight 2"],
  "reading_time_minutes": ${estimatedReadingTime || 1},
  "keyPhrases": ["phrase 1", "phrase 2", "phrase 3"]
}

Rules:
- summary: 3 to 5 concise bullet points covering what the page says.
- key_insights: 2 to 3 deeper takeaways about what matters most. Do not repeat summary bullets.
- reading_time_minutes: use the provided page reading time unless the content clearly suggests otherwise.
- keyPhrases: 4 to 6 short phrases copied or closely paraphrased from the page for highlighting.
- Keep language simple, factual, and clear.
- Do not include markdown or text outside the JSON.

Title: "${title}"

Estimated page reading time: ${estimatedReadingTime || 1} minutes

Page content:
${text.slice(0, 6000)}`;
}

function splitReadableItems(text) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = cleaned
    .split(SENTENCE_END_RE)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 45 && sentence.length <= 240);

  if (sentences.length >= 3) return sentences;

  return cleaned
    .split(HEADLINE_SPLIT_RE)
    .map(item => item.trim())
    .filter(item => item.length >= 25 && item.length <= 180)
    .filter((item, index, items) => items.findIndex(other => other.toLowerCase() === item.toLowerCase()) === index);
}

function createFallbackSummary(title, text, wordCount, estimatedReadingTime) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  const readableItems = splitReadableItems(cleaned);

  const bullets = readableItems.slice(0, 5).map(item => item.replace(/\s+/g, ' ').trim());
  if (!bullets.length && cleaned) {
    bullets.push(cleaned.slice(0, 220));
  }

  const words = cleaned.match(/\b[\w'-]{4,}\b/g) || [];
  const stopWords = new Set([
    'about', 'after', 'again', 'also', 'because', 'before', 'being', 'could',
    'from', 'have', 'into', 'more', 'most', 'other', 'over', 'said', 'that',
    'their', 'there', 'these', 'they', 'this', 'through', 'under', 'when',
    'where', 'which', 'while', 'with', 'would',
  ]);
  const counts = {};
  words.forEach(word => {
    const key = word.toLowerCase();
    if (!stopWords.has(key)) counts[key] = (counts[key] || 0) + 1;
  });
  const keyPhrases = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);

  return {
    bullets,
    insights: [
      `The page appears to be a roundup or index, so the extracted content is mostly headline-style items.`,
      `The most visible topics include ${keyPhrases.slice(0, 4).join(', ') || 'the main items listed on the page'}.`,
    ],
    keyPhrases,
    title,
    wordCount: wordCount || words.length || 0,
    estimatedReadingTime: estimatedReadingTime || Math.max(1, Math.ceil((wordCount || words.length || 1) / 200)),
    fallback: true,
  };
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseJsonSchema: SUMMARY_RESPONSE_SCHEMA,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(formatGeminiError(err, response.status));
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return raw;
}

function formatGeminiError(err, status) {
  const rawMessage = err?.error?.message || `Gemini API error: ${status}`;

  if (status === 429 || /quota|rate limit|retry/i.test(rawMessage)) {
    const cooldownSeconds = setProviderCooldown('gemini', getRetrySecondsFromMessage(rawMessage));
    return formatCooldownError('gemini', cooldownSeconds, 'Gemini free-tier quota reached.');
  }

  if (/api key not valid|invalid api key|permission denied/i.test(rawMessage)) {
    return 'Gemini rejected the API key. Check that the key is correct and enabled in Google AI Studio.';
  }

  return rawMessage;
}

// ── OpenAI API call ───────────────────────────────────────────────────────────
async function callOpenAI(apiKey, prompt) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      store: false,
      max_output_tokens: 1600,
      reasoning: { effort: 'minimal' },
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'page_summary',
          strict: false,
          schema: SUMMARY_RESPONSE_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const rawMessage = err?.error?.message || `OpenAI API error: ${response.status}`;
    if (response.status === 429 || /quota|rate limit/i.test(rawMessage)) {
      const cooldownSeconds = setProviderCooldown('openai', getRetrySecondsFromMessage(rawMessage));
      throw new Error(formatCooldownError('openai', cooldownSeconds, 'OpenAI rate limit or quota reached.'));
    }
    throw new Error(rawMessage);
  }

  const data = await response.json();
  return extractOpenAIText(data);
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') {
    return data.output_text;
  }

  if (data?.status === 'incomplete') {
    const reason = data?.incomplete_details?.reason || 'unknown reason';
    throw new Error(`OpenAI response was incomplete (${reason}). Please try again.`);
  }

  const chunks = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value?.summary) || Array.isArray(value?.key_insights)) {
      chunks.push(JSON.stringify(value));
      return;
    }

    if (value.parsed && typeof value.parsed === 'object') {
      chunks.push(JSON.stringify(value.parsed));
      return;
    }

    if (value.json && typeof value.json === 'object') {
      chunks.push(JSON.stringify(value.json));
      return;
    }

    if (typeof value.text === 'string') chunks.push(value.text);
    if (typeof value.output_text === 'string') chunks.push(value.output_text);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    Object.values(value).forEach(visit);
  };
  visit(data?.output || data);

  return chunks.join('\n');
}

// ── Parse AI response ─────────────────────────────────────────────────────────
function parseAIResponse(raw) {
  const normalizeStringList = value => {
    if (Array.isArray(value)) {
      return value
        .map(item => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') {
            return String(item.text || item.summary || item.point || item.insight || '').trim();
          }
          return '';
        })
        .filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(/\n+/)
        .map(line => line.replace(/^[-•*\d.)\s]+/, '').trim())
        .filter(Boolean);
    }

    return [];
  };

  const findListByKey = (value, keys, allowDirectArray = false) => {
    if (!value || typeof value !== 'object') return [];

    if (Array.isArray(value)) {
      if (allowDirectArray) {
        const direct = normalizeStringList(value);
        if (direct.length) return direct;
      }

      for (const item of value) {
        const nested = findListByKey(item, keys);
        if (nested.length) return nested;
      }
      return [];
    }

    for (const key of keys) {
      const match = normalizeStringList(value[key]);
      if (match.length) return match;

      const nested = findListByKey(value[key], keys, true);
      if (nested.length) return nested;
    }

    for (const child of Object.values(value)) {
      const nested = findListByKey(child, keys);
      if (nested.length) return nested;
    }

    return [];
  };

  try {
    // Strip markdown code fences and recover the first JSON object if the model adds prose.
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned.match(/\[[\s\S]*\]/)?.[0] || cleaned;
    const parsed = JSON.parse(jsonText);

    const bullets = findListByKey(parsed, [
      'summary',
      'bullets',
      'bulletPoints',
      'summaryBullets',
      'keyPoints',
      'points',
      'mainPoints',
    ]);
    const insights = findListByKey(parsed, ['key_insights', 'insights', 'keyInsights', 'takeaways', 'observations']);
    const keyPhrases = findListByKey(parsed, ['keyPhrases', 'keywords', 'phrases', 'terms']);

    return {
      bullets,
      insights,
      keyPhrases,
    };
  } catch (_) {
    // If JSON fails, extract bullet lines heuristically
    const lines = raw.split('\n').filter(l => l.trim().match(/^[-•*]|^\d+[.)]/));
    return {
      bullets: lines.slice(0, 6).map(l => l.replace(/^[-•*\d.)\s]+/, '').trim()),
      insights: [],
      keyPhrases: [],
    };
  }
}

function normalizeParsedSummary(parsed) {
  const cleanList = list => {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map(item => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(item => {
        if (!item) return false;
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  const bullets = cleanList(parsed.bullets);
  const bulletKeys = new Set(bullets.map(item => item.toLowerCase()));

  return {
    bullets,
    insights: cleanList(parsed.insights).filter(item => !bulletKeys.has(item.toLowerCase())),
    keyPhrases: cleanList(parsed.keyPhrases).slice(0, 6),
  };
}

// ── Main summarize handler ────────────────────────────────────────────────────
async function summarizePage(payload) {
  const { title, text, url, wordCount, estimatedReadingTime, forceRefresh = false } = payload;

  if (!text || text.trim().length < 50) {
    throw new Error('Not enough content to summarize on this page.');
  }

  // Cache check
  if (!forceRefresh) {
    const cached = await getCached(url);
    if (hasSummaryContent(cached) && !cached.fallback) {
      return { ...cached, fromCache: true };
    }
  }

  acquireAiRequestLock();

  try {
    // Rate limit
    rateLimiter.check();

    const prompt = buildPrompt(title, text, estimatedReadingTime);
    const response = await fetch(BACKEND_SUMMARIZE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        content: text,
        estimatedReadingTime,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Backend request failed');
    }

    const data = await response.json();
    const raw = data.text || '';

    let parsed = normalizeParsedSummary(parseAIResponse(raw));
    if (!hasSummaryContent(parsed)) {
      parsed = createFallbackSummary(title, text, wordCount, estimatedReadingTime);
    }

    if (!hasSummaryContent(parsed)) {
      throw new Error('The AI returned an empty summary. Please try again.');
    }

    const result = {
      ...parsed,
      title,
      url,
      wordCount: wordCount || 0,
      estimatedReadingTime: estimatedReadingTime || 1,
      generatedAt: new Date().toISOString(),
      fromCache: false,
    };

    if (!result.fallback) {
      await setCached(url, result);
    }
    return result;
  } finally {
    releaseAiRequestLock();
  }
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    case 'SUMMARIZE': {
      summarizePage(message.payload)
        .then(result => sendResponse({ success: true, data: result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async
    }

    case 'SAVE_SETTINGS': {
      chrome.storage.local.set({
        apiKey: message.apiKey,
        apiProvider: message.provider,
      }, () => sendResponse({ success: true }));
      return true;
    }

    case 'GET_SETTINGS': {
      sendResponse({
        hasKey: true,
        provider: 'backend',
      });
      return true;
    }

    case 'CLEAR_CACHE': {
      chrome.storage.local.remove('summaryCache', () =>
        sendResponse({ success: true })
      );
      return true;
    }

    default:
      return false;
  }
});

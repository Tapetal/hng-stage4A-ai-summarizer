/**
 * Background Service Worker — the ONLY place the API key lives.
 * Receives messages from the popup, calls the AI API, returns results.
 * API key is read from chrome.storage.local (user-provided, never hardcoded).
 */

'use strict';

const GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_MODEL = 'gpt-4o-mini';

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
function buildPrompt(title, text, mode) {
  const modes = {
    full: `You are a helpful assistant that summarizes web articles clearly and concisely.

Analyze the following article and provide a structured summary in this exact JSON format:
{
  "bullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "insights": ["insight 1", "insight 2", "insight 3"],
  "keyPhrases": ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "phrase 5"]
}

Rules:
- bullets: 4-6 concise bullet points covering the main content
- insights: 2-3 deeper observations or implications
- keyPhrases: 4-6 important terms/phrases from the article (for highlighting)
- Be factual, neutral, and clear
- Output ONLY valid JSON, no markdown, no explanation

Article title: "${title}"

Article content:
${text}`,

    brief: `Summarize this article in exactly 3 bullet points. Return JSON only:
{"bullets": ["point 1", "point 2", "point 3"], "insights": [], "keyPhrases": []}

Article: "${title}"
${text.slice(0, 3000)}`,
  };

  return modes[mode] || modes.full;
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
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return raw;
}

// ── OpenAI API call ───────────────────────────────────────────────────────────
async function callOpenAI(apiKey, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
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

  try {
    // Strip markdown code fences and recover the first JSON object if the model adds prose.
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
    const parsed = JSON.parse(jsonText);

    const bullets = normalizeStringList(
      parsed.bullets || parsed.summary || parsed.summaryBullets || parsed.keyPoints || parsed.points
    );
    const insights = normalizeStringList(parsed.insights || parsed.keyInsights || parsed.takeaways);
    const keyPhrases = normalizeStringList(parsed.keyPhrases || parsed.keywords || parsed.phrases);

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

// ── Main summarize handler ────────────────────────────────────────────────────
async function summarizePage(payload) {
  const { title, text, url, wordCount, estimatedReadingTime, mode = 'full', forceRefresh = false } = payload;

  if (!text || text.trim().length < 50) {
    throw new Error('Not enough content to summarize on this page.');
  }

  // Cache check
  if (!forceRefresh) {
    const cached = await getCached(url);
    if (hasSummaryContent(cached)) {
      return { ...cached, fromCache: true };
    }
  }

  // Rate limit
  rateLimiter.check();

  // Get API credentials
  const { key, provider } = await getApiKey();

  const prompt = buildPrompt(title, text, mode);
  let raw;

  if (provider === 'openai') {
    raw = await callOpenAI(key, prompt);
  } else {
    raw = await callGemini(key, prompt);
  }

  const parsed = parseAIResponse(raw);
  if (!hasSummaryContent(parsed)) {
    throw new Error('The AI returned an empty summary. Please try again or switch to 3 bullets mode.');
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

  await setCached(url, result);
  return result;
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
      chrome.storage.local.get(['apiKey', 'apiProvider'], result => {
        sendResponse({
          hasKey: !!result.apiKey,
          provider: result.apiProvider || 'gemini',
        });
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

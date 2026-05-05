# AI Page Summarizer — Chrome Extension

A Manifest V3 Chrome Extension that extracts content from any webpage and summarizes it using AI (Google Gemini or OpenAI). Get bullet-point summaries, key insights, estimated reading time, and optional in-page highlighting — all in a clean popup UI.

---

## Demo Video
https://drive.google.com/file/d/1gphrdSjqUkQ2VGT_G4CYtrnrElsatxtj/view?usp=drive_link

---

## Installation (Local / Unpacked)

> This extension is **not** on the Chrome Web Store. Install it locally:

1. **Download or clone** this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `extension/` folder, which contains `manifest.json`.
6. The extension icon (✨) appears in your toolbar

---

## Setup — No API Key Required

This extension uses a secure backend proxy hosted on Render.

- Users do NOT need to provide any API key
- All AI requests are handled securely by the backend
- API keys are never exposed in the frontend

Backend URL:
https://hng-stage4a-ai-summarizer.onrender.com

### Option A — Google Gemini (recommended, has free tier)
1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Create a free API key
3. Click the extension icon → ⚙️ Settings → select **Google Gemini** → paste key → Save

### Option B — OpenAI
1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create an API key (requires billing)
3. Click the extension icon → ⚙️ Settings → select **OpenAI GPT-5.4 Mini** → paste key → Save

---

## Troubleshooting

### Gemini quota reached

If Gemini returns a quota or rate-limit message, wait for the retry window shown in the popup and try again. Normal cached summaries do not call the API again, but clicking refresh or clearing cache will request a new AI summary.

The popup disables summarize/refresh actions during the cooldown window so early retries do not reset the provider's timer.

For demos, use one or two reliable article pages and avoid repeatedly refreshing the same page unless you need a fresh response.

---

## How to Use

1. Navigate to any article, blog post, or news page
2. Click the **AI Summarizer** icon in the toolbar
3. Click **Summarize**
4. Read the bullet-point summary and key insights
5. Click **🔦** to highlight key phrases on the page
6. Click **📋** to copy the summary to clipboard

---

## File Structure

```
hng-stage4A-ai-summarizer/
├── backend/
│   ├── server.js                  # Node/Express backend proxy for Gemini API
│   ├── package.json               # Backend dependencies and scripts
│   └── package-lock.json
│
├── extension/
│   ├── manifest.json              # Manifest V3 config
│   ├── icons/
│   │   ├── icon16.png
│   │   ├── icon32.png
│   │   ├── icon48.png
│   │   └── icon128.png
│   └── src/
│       ├── background/
│       │   └── service-worker.js  # Messaging, caching, backend proxy calls
│       ├── content/
│       │   └── content-script.js  # Content extraction + highlighting
│       ├── popup/
│       │   ├── popup.html         # Extension popup UI
│       │   ├── popup.css          # Styles and theme handling
│       │   └── popup.js           # Popup controller
│       └── utils/
│           ├── sanitize.js        # XSS prevention helpers
│           └── readability.js     # Heuristic content extractor
│
└── README.md
```

---

## Architecture

### Message Flow

```
Popup UI
  │
  ├─ sendMessage(EXTRACT_CONTENT) ──▶ Content Script
  │                                    └─ Returns { title, text, wordCount, estimatedReadingTime }
  │
  └─ sendMessage(SUMMARIZE) ───────▶ Background Service Worker
                                       ├─ Checks chrome.storage cache
                                       ├─ Sends page content to backend proxy
                                       └─ Returns normalized summary to popup

Backend Proxy
  │
  └─ POST /summarize ──────────────▶ Gemini API
                                      └─ Returns structured JSON summary
```

### Components

**Background Service Worker (`service-worker.js`)**
- The only place that holds or uses the API key
- Reads key from `chrome.storage.local` on demand — never from code
- Calls Gemini (`gemini-2.5-flash` via `generativelanguage.googleapis.com`) or OpenAI (`gpt-5.4-mini` via the OpenAI Responses API)
- Parses AI JSON response into `{ bullets, insights, keyPhrases }`
- Caches results per URL in `chrome.storage.local` (max 50 entries)
- Enforces a soft rate limit (10 requests/minute)
- Stores provider cooldowns after quota/rate-limit responses to prevent repeated failed requests
- Uses an in-flight request lock so duplicate popup clicks cannot trigger parallel AI calls
- Falls back to a local extractive summary if a provider returns no usable text

**Content Script (`content-script.js`)**
- Runs on all pages (`<all_urls>`) at `document_idle`
- Extracts readable text using heuristics: prefers `<article>`, `<main>`, `[role="main"]`
- Falls back to paragraph-density scoring over `<div>` candidates
- Strips navigation, headers, footers, sidebars, ads, scripts
- Truncates to 8,000 characters to stay within AI context budgets
- Handles `HIGHLIGHT_PHRASES` and `CLEAR_HIGHLIGHTS` messages for in-page highlights

**Popup (`popup.html` / `popup.js`)**
- Queries the active tab, sends `EXTRACT_CONTENT` to the content script
- Sends `SUMMARIZE` to the background worker
- Renders bullets and insights using `textContent` (XSS-safe, no `innerHTML` on user data)
- Supports dark/light mode toggle (persisted to `localStorage`)
- Copy-to-clipboard button for the summary

---

## AI Integration & Security

The extension uses a backend proxy to securely communicate with the Gemini API.

Flow:
Extension → Backend (Render) → Gemini API

- API keys are stored only on the backend
- No secrets are exposed in the extension
- Backend handles prompt formatting and response parsing

The AI prompt requests one structured JSON response:

```json
{
  "summary": ["...", "...", "..."],
  "key_insights": ["...", "..."],
  "reading_time_minutes": 6,
  "keyPhrases": ["...", "...", "..."]
}
```

Temperature is set to `0.3` for consistent, factual summaries. The response is parsed with `JSON.parse`, normalized for the popup UI, and falls back to heuristic line-splitting if the model returns malformed output.

Gemini uses the current stable Flash model, `gemini-2.5-flash`. Older `gemini-1.5-*` model names are retired and can return `model not found` errors. OpenAI uses `gpt-5.4-mini` through the Responses API.

---

## Security Decisions

| Concern | Decision |
|---------|----------|
| API key exposure | Key lives only in `chrome.storage.local`, read only by the background service worker. Never in content scripts, popup JS, or any committed file. |
| XSS prevention | All AI-generated text is injected via `textContent` (not `innerHTML`). In-page highlights use `createTextNode` and `createElement`. |
| Permissions | Minimal: `activeTab`, `storage`, `scripting`. No broad host permissions beyond the two AI APIs. |
| Message validation | All incoming messages are validated (`typeof msg.type === 'string'`) before processing. |
| Content sanitization | The `sanitize.js` utility strips HTML entities if any string must be embedded in HTML context. |

---

## Trade-offs and Limitations

- **Uses backend proxy** — AI requests are routed through a secure Node.js backend to prevent API key exposure.
- **localStorage for theme** — popup `localStorage` is extension-scoped (safe), but separate from `chrome.storage`. Theme preference is popup-only.
- **8,000 char truncation** — long pages are truncated. This covers most articles but may miss details on very long documents.
- **Content script injection** — some browser-internal pages (`chrome://`, `chrome-extension://`) block content scripts. The popup handles this gracefully with an error message.
- **Rate limiting is soft** — the 10 req/min limit is per browser session (not persisted). Reloading resets it.
- **Passwords / sensitive fields** — content extraction ignores `<form>` elements, but users should be aware that extension content scripts can technically read page text.

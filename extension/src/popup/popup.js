/**
 * Popup controller.
 * Communicates with content-script (for extraction) and service-worker (for AI).
 * Never touches API keys directly.
 */

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setText(id, text) { $(id).textContent = text; }

function sanitize(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sendToBackground(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function sendToContentScript(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab   = null;
let pageData     = null;
let summaryData  = null;
let highlighted  = false;
let isSummarizing = false;
let cooldownTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  await loadSettings();
  await initPage();
  bindEvents();
});

async function ensureContentScript(tabId) {
  // First try pinging — if content script is already there, it responds
  try {
    await sendToContentScript(tabId, { type: 'EXTRACT_CONTENT' });
    return true; // already injected
  } catch (_) {
    // Not injected yet — inject it now
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content-script.js'],
    });
    // Small delay to let the script initialise its listener
    await new Promise(r => setTimeout(r, 150));
    return true;
  } catch (err) {
    console.warn('Could not inject content script:', err.message);
    return false;
  }
}

async function initPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    if (!tab?.id) {
      showError('Could not access the current tab.');
      return;
    }

    // Show page title immediately from tab info
    setText('page-title', tab.title || 'Untitled page');

    // Restricted pages (chrome://, edge://, about:, extension pages)
    const url = tab.url || '';
    if (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.startsWith('devtools:')
    ) {
      $('page-meta').textContent = 'Extension cannot run on this page.';
      $('btn-summarize').disabled = true;
      return;
    }

    // Ensure content script is injected, then extract
    const injected = await ensureContentScript(tab.id);
    if (!injected) {
      $('page-meta').textContent = 'Could not inject on this page.';
      $('btn-summarize').disabled = true;
      return;
    }

    try {
      const response = await sendToContentScript(tab.id, { type: 'EXTRACT_CONTENT' });
      if (response?.success) {
        pageData = response;
        setText('page-title', response.title || tab.title || 'Untitled');
        $('page-meta').textContent =
          `~${(response.wordCount || 0).toLocaleString()} words · ${response.estimatedReadingTime || 1} min read`;
      } else {
        $('page-meta').textContent = 'Could not extract content from this page.';
      }
    } catch (err) {
      $('page-meta').textContent = 'Content unavailable.';
      console.warn('Extract error:', err.message);
    }
  } catch (err) {
    showError('Error initialising: ' + err.message);
  }
}

async function loadSettings() {
  const res = await sendToBackground({ type: 'GET_SETTINGS' });
  if (!res.hasKey) {
    show('no-key-notice');
    $('btn-summarize').disabled = true;
  } else {
    hide('no-key-notice');
    $('btn-summarize').disabled = false;
    $('select-provider').value = res.provider || 'backend';
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Summarize
  $('btn-summarize').addEventListener('click', handleSummarize);

  // Settings toggle
  $('btn-settings').addEventListener('click', () => {
    $('settings-panel').classList.toggle('hidden');
  });

  // Save settings
  $('btn-save-settings').addEventListener('click', saveSettings);

  // Clear cache
  $('btn-clear-cache').addEventListener('click', async () => {
    await sendToBackground({ type: 'CLEAR_CACHE' });
    showSettingsMsg('Cache cleared!', 'success');
  });

  // Toggle API key visibility
  $('btn-toggle-key').addEventListener('click', () => {
    const input = $('input-apikey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Open settings from notice
  $('open-settings-link').addEventListener('click', () => {
    show('settings-panel');
  });

  // Reset / clear summary
  $('btn-reset').addEventListener('click', resetSummary);

  // Refresh (force new API call)
  $('btn-refresh').addEventListener('click', () => handleSummarize(true));

  // Copy summary
  $('btn-copy').addEventListener('click', copySummary);

  // Highlight toggle
  $('btn-highlight').addEventListener('click', toggleHighlight);

  // Clear highlights
  $('btn-clear-highlights').addEventListener('click', clearHighlights);

  // Theme toggle
  $('btn-theme').addEventListener('click', toggleTheme);
}

// ── Summarize ────────────────────────────────────────────────────────────────
async function handleSummarize(forceRefresh = false) {
  if (!currentTab?.id || isSummarizing) return;

  let cooldownSeconds = 0;
  isSummarizing = true;
  hideError();
  hide('summary-section');
  show('loading');
  setSummaryActionsDisabled(true);

  try {
    // Re-inject if needed before extracting
    if (!pageData || !pageData.text) {
      await ensureContentScript(currentTab.id);
      pageData = await sendToContentScript(currentTab.id, { type: 'EXTRACT_CONTENT' });
    }

    if (!pageData?.success || !pageData?.text) {
      throw new Error('Could not extract readable content from this page. Try a different article.');
    }

    const response = await sendToBackground({
      type: 'SUMMARIZE',
      payload: {
        title:               pageData.title,
        text:                pageData.text,
        url:                 pageData.url,
        wordCount:           pageData.wordCount,
        estimatedReadingTime: pageData.estimatedReadingTime,
        forceRefresh:        forceRefresh === true,
      },
    });

    if (!response.success) {
      if (response.error === 'NO_API_KEY') {
        show('settings-panel');
        throw new Error('Please add your API key in Settings first.');
      }
      throw new Error(response.error || 'Unknown error from AI.');
    }

    summaryData = response.data;
    renderSummary(summaryData);

  } catch (err) {
    const cooldown = parseCooldownError(err.message);
    if (cooldown) {
      cooldownSeconds = cooldown.seconds;
      showError(cooldown.message);
      disableSummaryActionsTemporarily(cooldown.seconds);
    } else if (err.message === 'REQUEST_IN_PROGRESS') {
      showError('A summary request is already processing. Please wait for it to finish.');
    } else {
      showError(err.message);
    }
  } finally {
    hide('loading');
    isSummarizing = false;
    if (!cooldownSeconds) {
      setSummaryActionsDisabled(false);
    }
  }
}

// ── Render summary ───────────────────────────────────────────────────────────
function renderSummary(data) {
  // Cache badge
  $('cache-badge').textContent = data.fallback
    ? 'Page highlights'
    : data.fromCache
      ? 'Cached'
      : '';

  // Bullets
  const bulletsList = $('bullets-list');
  bulletsList.innerHTML = '';
  (data.bullets || []).forEach(b => {
    const li = document.createElement('li');
    li.textContent = b; // safe — textContent, not innerHTML
    bulletsList.appendChild(li);
  });

  // Insights
  const insightsList = $('insights-list');
  insightsList.innerHTML = '';
  if (data.insights && data.insights.length > 0) {
    data.insights.forEach(i => {
      const li = document.createElement('li');
      li.textContent = i;
      insightsList.appendChild(li);
    });
    show('insights-block');
  } else {
    hide('insights-block');
  }

  // Stats
  $('stat-words').textContent = `${(data.wordCount || 0).toLocaleString()} words`;
  $('stat-time').textContent  = `~${data.estimatedReadingTime || 1} min read`;
  $('stat-generated').textContent = data.generatedAt
    ? `Generated ${new Date(data.generatedAt).toLocaleTimeString()}`
    : '';

  // Show highlight button if we have keyPhrases
  if (data.keyPhrases && data.keyPhrases.length > 0) {
    show('btn-highlight');
  }

  show('summary-section');
}

// ── Highlight ────────────────────────────────────────────────────────────────
async function toggleHighlight() {
  if (!currentTab?.id || !summaryData?.keyPhrases) return;
  try {
    await ensureContentScript(currentTab.id);
    await sendToContentScript(currentTab.id, {
      type: 'HIGHLIGHT_PHRASES',
      phrases: summaryData.keyPhrases,
    });
    highlighted = true;
    hide('btn-highlight');
    show('btn-clear-highlights');
  } catch (_) {}
}

async function clearHighlights() {
  if (!currentTab?.id) return;
  try {
    await ensureContentScript(currentTab.id);
    await sendToContentScript(currentTab.id, { type: 'CLEAR_HIGHLIGHTS' });
    highlighted = false;
    show('btn-highlight');
    hide('btn-clear-highlights');
  } catch (_) {}
}

// ── Copy ──────────────────────────────────────────────────────────────────────
async function copySummary() {
  if (!summaryData) return;
  const lines = [];
  if (summaryData.title) lines.push(`# ${summaryData.title}\n`);
  lines.push('## Summary');
  (summaryData.bullets || []).forEach(b => lines.push(`• ${b}`));
  if (summaryData.insights?.length) {
    lines.push('\n## Key Insights');
    summaryData.insights.forEach(i => lines.push(`• ${i}`));
  }
  lines.push(`\n~${summaryData.wordCount} words · ~${summaryData.estimatedReadingTime} min read`);

  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    $('btn-copy').textContent = '✅';
    setTimeout(() => { $('btn-copy').textContent = '📋'; }, 2000);
  } catch (_) {
    $('btn-copy').textContent = '❌';
    setTimeout(() => { $('btn-copy').textContent = '📋'; }, 2000);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetSummary() {
  summaryData = null;
  hide('summary-section');
  hide('btn-highlight');
  hide('btn-clear-highlights');
  hideError();
  highlighted = false;
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function saveSettings() {
  const key      = $('input-apikey').value.trim();
  const provider = $('select-provider').value;

  if (provider === 'backend') {
    showSettingsMsg('Backend proxy is configured. No API key needed.', 'success');
    return;
  }

  if (!key) {
    showSettingsMsg('API key is required.', 'error');
    return;
  }

  const res = await sendToBackground({
    type:     'SAVE_SETTINGS',
    apiKey:   key,
    provider,
  });

  if (res.success) {
    showSettingsMsg('Settings saved!', 'success');
    $('input-apikey').value = '';
    await loadSettings();
  } else {
    showSettingsMsg('Failed to save.', 'error');
  }
}

function showSettingsMsg(msg, type) {
  const el = $('settings-msg');
  el.textContent = msg;
  el.className = `settings-msg ${type}`;
  show('settings-msg');
  setTimeout(() => hide('settings-msg'), 3000);
}

// ── Error ──────────────────────────────────────────────────────────────────────
function showError(msg) {
  setText('error-msg', msg);
  show('error-box');
}
function hideError() {
  hide('error-box');
}

function parseCooldownError(message) {
  const match = String(message || '').match(/^COOLDOWN:([^:]+):(\d+):(.*)$/);
  if (!match) return null;

  return {
    provider: match[1],
    seconds: Math.max(1, Number(match[2]) || 1),
    message: match[3],
  };
}

function setSummaryActionsDisabled(disabled) {
  ['btn-summarize', 'btn-refresh'].forEach(id => {
    const button = $(id);
    if (button) button.disabled = disabled;
  });
}

function disableSummaryActionsTemporarily(seconds) {
  const summarizeButton = $('btn-summarize');
  const refreshButton = $('btn-refresh');
  const originalHtml = summarizeButton.dataset.originalHtml || summarizeButton.innerHTML;
  summarizeButton.dataset.originalHtml = originalHtml;

  if (cooldownTimer) {
    clearInterval(cooldownTimer);
  }

  let remaining = Math.max(1, seconds);
  const render = () => {
    summarizeButton.innerHTML = `<span class="btn-icon">⏳</span> Wait ${remaining}s`;
    if (refreshButton) refreshButton.title = `Wait ${remaining}s`;
  };

  setSummaryActionsDisabled(true);
  render();

  cooldownTimer = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      summarizeButton.innerHTML = originalHtml;
      if (refreshButton) refreshButton.title = 'Refresh';
      setSummaryActionsDisabled(false);
      return;
    }

    render();
  }, 1000);
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function loadTheme() {
  const saved = localStorage.getItem('ai-summarizer-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('btn-theme').textContent = '☀️';
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('ai-summarizer-theme', 'light');
    $('btn-theme').textContent = '🌙';
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('ai-summarizer-theme', 'dark');
    $('btn-theme').textContent = '☀️';
  }
}

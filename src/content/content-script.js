/**
 * Content script — runs in page context.
 * Listens for EXTRACT_CONTENT message from background/popup,
 * extracts readable text using heuristics, and returns it.
 *
 * NOTE: No API keys ever touch this file.
 */

(function () {
  'use strict';

  // ── Noise removal ──────────────────────────────────────────────────────────
  function removeNoise(root) {
    const selectors = [
      'script', 'style', 'noscript', 'nav', 'header', 'footer',
      'aside', 'form', 'iframe', 'svg',
      '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
      '[role="contentinfo"]',
    ];
    selectors.forEach(sel => {
      try { root.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {}
    });
  }

  // ── Find best content container ─────────────────────────────────────────────
  function findContainer(doc) {
    const preferred = [
      'article', '[role="main"]', 'main',
      '.post-content', '.article-body', '.entry-content',
      '.article-content', '.story-body', '.content-body',
      '#article', '#main-content', '#content',
    ];
    for (const sel of preferred) {
      try {
        const el = doc.querySelector(sel);
        if (el && (el.innerText || el.textContent || '').trim().length > 200) {
          return el;
        }
      } catch (_) {}
    }

    // Paragraph-density fallback
    const candidates = Array.from(doc.querySelectorAll('div, section'));
    let best = doc.body;
    let bestScore = 0;
    candidates.forEach(el => {
      const pCount = el.querySelectorAll('p').length;
      const textLen = (el.innerText || el.textContent || '').trim().length;
      const score = textLen * 0.4 + pCount * 40;
      if (score > bestScore && !el.matches('nav,header,footer,aside')) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  // ── Extract blocks of text ──────────────────────────────────────────────────
  function extractBlocks(container) {
    const allowed = new Set(['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','TD','TH']);
    const blocks = [];

    function walk(el) {
      for (const child of el.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (allowed.has(child.tagName)) {
          const text = (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length > 25) blocks.push(text);
        } else {
          walk(child);
        }
      }
    }

    walk(container);
    return blocks;
  }

  // ── Main extraction ─────────────────────────────────────────────────────────
  function extractContent() {
    try {
      const clone = document.cloneNode(true);
      removeNoise(clone);
      const container = findContainer(clone);
      const blocks = extractBlocks(container);
      const text = blocks.join('\n\n').slice(0, 8000);

      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

      return {
        success: true,
        title: document.title || '',
        url: location.href,
        text: text || 'Could not extract readable content from this page.',
        wordCount,
        estimatedReadingTime: Math.max(1, Math.round(wordCount / 200)),
      };
    } catch (err) {
      return {
        success: false,
        title: document.title || '',
        url: location.href,
        text: '',
        error: err.message,
      };
    }
  }

  // ── Highlight handler ───────────────────────────────────────────────────────
  function highlightPhrases(phrases) {
    if (!Array.isArray(phrases) || phrases.length === 0) return;

    // Remove any previous highlights
    document.querySelectorAll('.ai-summarizer-highlight').forEach(el => {
      el.outerHTML = el.innerHTML;
    });

    const body = document.body;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodesToReplace = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentNode;
      if (!parent || ['SCRIPT','STYLE','NOSCRIPT'].includes(parent.tagName)) continue;
      for (const phrase of phrases) {
        if (phrase.length < 4) continue;
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(${escaped})`, 'gi');
        if (re.test(node.textContent)) {
          nodesToReplace.push({ node, phrase });
          break;
        }
      }
    }

    // Replace in reverse order to preserve positions
    nodesToReplace.reverse().forEach(({ node, phrase }) => {
      try {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(${escaped})`, 'gi');
        const frag = document.createDocumentFragment();
        const parts = node.textContent.split(re);
        parts.forEach(part => {
          if (re.test(part)) {
            const mark = document.createElement('mark');
            mark.className = 'ai-summarizer-highlight';
            mark.style.cssText = 'background:#fef08a;border-radius:2px;padding:0 2px;';
            mark.textContent = part;
            frag.appendChild(mark);
          } else {
            frag.appendChild(document.createTextNode(part));
          }
        });
        node.parentNode.replaceChild(frag, node);
      } catch (_) {}
    });
  }

  function clearHighlights() {
    document.querySelectorAll('.ai-summarizer-highlight').forEach(el => {
      const text = document.createTextNode(el.textContent);
      el.parentNode.replaceChild(text, el);
    });
  }

  // ── Message listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'EXTRACT_CONTENT':
        sendResponse(extractContent());
        return false;

      case 'HIGHLIGHT_PHRASES':
        if (Array.isArray(message.phrases)) {
          highlightPhrases(message.phrases);
        }
        sendResponse({ success: true });
        return false;

      case 'CLEAR_HIGHLIGHTS':
        clearHighlights();
        sendResponse({ success: true });
        return false;

      default:
        return false;
    }
  });
})();

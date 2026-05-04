/**
 * Heuristic readability extractor.
 * Prefers <article>, <main>, or falls back to density-based paragraph extraction.
 * Strips nav, header, footer, sidebar, ads, scripts, styles.
 */
export function extractReadableContent(document) {
  // Clone so we don't mutate the live DOM
  const doc = document.cloneNode(true);

  // Remove noise elements
  const noise = [
    'script', 'style', 'noscript', 'nav', 'header', 'footer',
    'aside', 'form', 'iframe', 'svg', 'button', 'select', 'input',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '[role="contentinfo"]', '.nav', '.navbar', '.sidebar', '.footer',
    '.header', '.menu', '.cookie', '.ad', '.ads', '.advertisement',
    '.social', '.share', '.comment', '#comments', '#sidebar',
    '#navigation', '#nav', '#header', '#footer'
  ];

  noise.forEach(selector => {
    try {
      doc.querySelectorAll(selector).forEach(el => el.remove());
    } catch (_) { /* ignore invalid selectors */ }
  });

  // Prefer semantic containers
  const preferredSelectors = [
    'article',
    '[role="main"]',
    'main',
    '.post-content',
    '.article-content',
    '.entry-content',
    '.content',
    '#content',
    '#main',
  ];

  let container = null;
  for (const sel of preferredSelectors) {
    const el = doc.querySelector(sel);
    if (el) { container = el; break; }
  }

  // Fall back to paragraph-density scoring across divs
  if (!container) {
    const candidates = Array.from(doc.querySelectorAll('div, section'));
    let best = null;
    let bestScore = 0;
    candidates.forEach(el => {
      const text = el.innerText || el.textContent || '';
      const paragraphs = el.querySelectorAll('p').length;
      const score = text.length * 0.5 + paragraphs * 30;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    container = best || doc.body;
  }

  // Extract text from paragraphs + headings in order
  const blocks = [];
  const allowedTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE'];

  const walk = (el) => {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (allowedTags.includes(child.tagName)) {
          const text = (child.innerText || child.textContent || '').trim();
          if (text.length > 20) blocks.push(text);
        } else {
          walk(child);
        }
      }
    }
  };

  walk(container);

  const joined = blocks.join('\n\n');

  // Truncate to ~8000 chars to stay within typical AI context budgets
  return joined.slice(0, 8000);
}

/**
 * Estimate reading time in minutes from a word count.
 */
export function estimateReadingTime(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return { words, minutes };
}

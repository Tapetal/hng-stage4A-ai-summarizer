/**
 * Sanitize a string for safe injection into the DOM as text content.
 * Prevents XSS by stripping any HTML tags and encoding entities.
 */
export function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Validate that an incoming extension message has the expected shape.
 */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.type !== 'string') return false;
  return true;
}

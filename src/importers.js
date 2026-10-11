const mammoth = require('mammoth');
const sanitizeHtml = require('sanitize-html');

// `marked` v13+ ships ESM only, so it cannot be require()d from this CommonJS
// module. Load it lazily via dynamic import() and memoize the promise.
let markedPromise;
const loadMarked = () => (markedPromise ??= import('marked').then((m) => m.marked));

// Allow-list mirrors what the editor can produce, so import never introduces
// markup the editor can't represent (and blocks XSS).
const SANITIZE = {
  allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a'],
  // Quill 2 renders every list as <ol> and stores the kind on the <li> as
  // data-list="bullet|ordered|checked". Dropping it would silently turn all
  // bullet lists into numbered ones on the next load.
  allowedAttributes: { a: ['href'], li: ['data-list', 'data-list-id'], '*': ['class'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedClasses: { '*': [/^ql-/] },
};
const clean = (html) => sanitizeHtml(html || '', SANITIZE);
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SUPPORTED = ['.txt', '.md', '.docx'];

async function importFile(originalName, buffer) {
  const ext = (originalName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    const err = new Error(`Unsupported file type "${ext || 'unknown'}". Supported: ${SUPPORTED.join(', ')}`);
    err.status = 415; throw err;
  }
  const title = originalName.replace(/\.[^.]+$/, '').slice(0, 120) || 'Imported document';
  let html;
  if (ext === '.txt') {
    const paras = buffer.toString('utf8').replace(/\r\n/g, '\n').split(/\n{2,}/).filter((p) => p.trim());
    html = paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  } else if (ext === '.md') {
    const marked = await loadMarked();
    html = marked.parse(buffer.toString('utf8'), { gfm: true });
  } else {
    try {
      html = (await mammoth.convertToHtml({ buffer })).value;
    } catch {
      const err = new Error('Could not read this .docx file. Is it a valid Word document?');
      err.status = 422; throw err;
    }
  }
  return { title, content: clean(html) };
}

module.exports = { importFile, clean, SUPPORTED };

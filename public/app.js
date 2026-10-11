/* Vanilla JS SPA. All user-provided strings go through textContent (via h()) — never innerHTML. */
const $ = (s) => document.querySelector(s);
const app = $('#app');
let me = null;
let cleanup = () => {};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && el.append(c.nodeType ? c : document.createTextNode(c)));
  return el;
}

async function api(method, url, body) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch(url, { method, headers: body && !isForm ? { 'content-type': 'application/json' } : {}, body: isForm ? body : body && JSON.stringify(body) });
  } catch { throw Object.assign(new Error('Network error — check your connection'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
const fmtDate = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const badge = (role) => h('span', { class: `badge ${role}` }, role === 'owner' ? 'Owned' : `Shared · ${role}`);

// ---- routing ---------------------------------------------------------------
async function route() {
  cleanup(); cleanup = () => {};
  $('#banner').hidden = true;
  const m = location.hash.match(/^#\/doc\/(\w+)/);
  try {
    if (!me) { try { me = await api('GET', '/api/me'); } catch { me = null; } }
    renderWho();
    if (!me) return renderLogin();
    return m ? await renderEditor(m[1]) : await renderHome();
  } catch (e) {
    if (e.status === 401) { me = null; renderWho(); return renderLogin(); }
    app.replaceChildren(h('div', { class: 'empty' }, e.message, ' ', h('a', { href: '#/' }, 'Back to documents')));
  }
}
window.addEventListener('hashchange', route);

function renderWho() {
  const w = $('#who'); w.hidden = !me; w.replaceChildren();
  if (!me) return;
  w.append(h('span', {}, `${me.name} (${me.email})`),
    h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); me = null; location.hash = '#/'; route(); } }, 'Switch user'));
}

// ---- login -----------------------------------------------------------------
async function renderLogin() {
  const users = await api('GET', '/api/users');
  app.replaceChildren(h('div', { class: 'login' },
    h('h1', {}, 'Ajaia Docs'),
    h('p', { class: 'hint' }, 'Demo build with mocked auth. Pick a seeded user — open a second browser profile or window to act as another user at the same time.'),
    h('div', { class: 'users' }, users.map((u) => h('button', { class: 'btn', onclick: async () => { me = await api('POST', '/api/login', { userId: u.id }); route(); } },
      u.name, h('small', {}, u.email))))));
}

// ---- home ------------------------------------------------------------------
async function renderHome() {
  const { owned, shared } = await api('GET', '/api/documents');
  const list = (docs, empty) => docs.length
    ? h('ul', { class: 'list' }, docs.map((d) => h('li', {}, h('a', { class: 'row', href: `#/doc/${d.id}` },
        h('span', { class: 't' }, d.title), badge(d.role),
        h('span', { class: 'm' }, d.role === 'owner' ? fmtDate(d.updatedAt) : `${d.owner.name} · ${fmtDate(d.updatedAt)}`)))))
    : h('div', { class: 'empty' }, empty);

  const file = h('input', { type: 'file', accept: '.txt,.md,.docx', hidden: true, onchange: async () => {
    if (!file.files[0]) return;
    const fd = new FormData(); fd.append('file', file.files[0]);
    try { const { id } = await api('POST', '/api/documents/import', fd); location.hash = `#/doc/${id}`; }
    catch (e) { toast(e.message); } finally { file.value = ''; }
  } });

  app.replaceChildren(
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => { const { id } = await api('POST', '/api/documents', {}); location.hash = `#/doc/${id}`; } }, '+ New document'),
      h('button', { class: 'btn', onclick: () => file.click() }, 'Upload file'),
      h('span', { class: 'hint' }, 'Upload supports .txt, .md and .docx (max 2 MB) and creates a new editable document.'), file),
    h('h2', {}, 'My documents'), list(owned, 'No documents yet. Create one or upload a file.'),
    h('h2', {}, 'Shared with me'), list(shared, 'Nothing has been shared with you yet.'));
}

// ---- editor ----------------------------------------------------------------
async function renderEditor(id) {
  const doc = await api('GET', `/api/documents/${id}`);
  const canEdit = doc.role !== 'viewer';
  let version = doc.version, dirty = false, saving = false, blocked = false, timer;

  const status = h('span', { class: 'status' }, canEdit ? 'Saved' : '');
  const setStatus = (t, err) => { status.textContent = t; status.classList.toggle('err', !!err); };
  const title = h('input', { class: 'title', value: doc.title, maxlength: 120, 'aria-label': 'Document title', disabled: !canEdit });

  const editorEl = h('div', {});
  const toolbar = h('div', {});
  toolbar.innerHTML = `<span class="ql-formats"><select class="ql-header"><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option><option selected></option></select></span>
    <span class="ql-formats"><button class="ql-bold" title="Bold"></button><button class="ql-italic" title="Italic"></button><button class="ql-underline" title="Underline"></button></span>
    <span class="ql-formats"><button class="ql-list" value="ordered" title="Numbered list"></button><button class="ql-list" value="bullet" title="Bulleted list"></button></span>
    <span class="ql-formats"><button class="ql-clean" title="Clear formatting"></button></span>`; // static markup, no user data
  if (!canEdit) toolbar.hidden = true;

  const shareBtn = doc.role === 'owner' ? h('button', { class: 'btn', onclick: openShare }, 'Share') : null;
  const delBtn = doc.role === 'owner' ? h('button', { class: 'btn danger', onclick: async () => {
    if (!confirm(`Delete "${doc.title}" for everyone? This can't be undone.`)) return;
    await api('DELETE', `/api/documents/${id}`); location.hash = '#/';
  } }, 'Delete') : null;

  app.replaceChildren(
    h('div', { class: 'editor-head' }, h('a', { class: 'btn', href: '#/' }, '← All documents'), title, status, badge(doc.role), shareBtn, delBtn),
    !canEdit ? h('div', { class: 'readonly-note' }, `You have view-only access. ${doc.owner.name} owns this document.`) : null,
    h('div', { id: 'editor-wrap' }, toolbar, editorEl));

  const quill = new Quill(editorEl, { theme: 'snow', readOnly: !canEdit, modules: { toolbar }, placeholder: canEdit ? 'Start writing…' : '' });
  // clipboard.convert() takes an {html, text} object, not a bare string —
  // passing a string yields an empty delta and silently loads a blank document.
  const html = doc.content || '';
  const plain = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  quill.setContents(quill.clipboard.convert({ html, text: plain }), 'silent');

  async function save() {
    if (!dirty || saving || blocked) return;
    saving = true; dirty = false; setStatus('Saving…');
    // Only re-queue automatically for failures that can succeed on retry.
    // Validation/conflict errors must wait for the next edit, otherwise the
    // debounce turns into an endless request loop.
    let retry = true;
    try {
      const r = await api('PUT', `/api/documents/${id}`, { title: title.value, content: quill.root.innerHTML, version });
      version = r.version; setStatus(dirty ? 'Unsaved changes' : 'Saved');
    } catch (e) {
      dirty = true;
      if (e.status === 409 || e.status === 403 || e.status === 404) {
        blocked = true; retry = false; setStatus('Not saved', true);
        const b = $('#banner'); b.hidden = false;
        b.replaceChildren(e.message + ' ', h('button', { class: 'btn', onclick: route }, 'Reload latest'));
      } else if (e.status >= 400 && e.status < 500) {
        retry = false; setStatus('Not saved — ' + e.message, true);
      } else {
        setStatus('Offline — retrying…', true);
      }
    } finally { saving = false; if (dirty && !blocked && retry) schedule(); }
  }
  function schedule(ms = 900) { clearTimeout(timer); timer = setTimeout(save, ms); }
  const touch = () => { if (!canEdit) return; dirty = true; setStatus('Unsaved changes'); schedule(); };
  quill.on('text-change', (_d, _o, src) => src === 'user' && touch());
  title.addEventListener('input', touch);
  const flush = () => { clearTimeout(timer); save(); };
  title.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', flush);
  const warn = (e) => { if (dirty) e.preventDefault(); };
  window.addEventListener('beforeunload', warn);
  cleanup = () => { flush(); document.removeEventListener('visibilitychange', flush); window.removeEventListener('beforeunload', warn); };

  // ---- share dialog (owner) ----
  function openShare() {
    let shares = doc.shares || [];
    const list = h('ul', { class: 'shares' });
    const email = h('input', { type: 'email', placeholder: 'Email, e.g. bob@ajaia.test', 'aria-label': 'Email to share with' });
    const role = h('select', { 'aria-label': 'Permission' }, h('option', { value: 'viewer' }, 'Can view'), h('option', { value: 'editor' }, 'Can edit'));
    const err = h('div', { class: 'status err', style: 'text-align:left' });
    const dlg = h('dialog', {}, h('h3', {}, 'Share “' + doc.title + '”'),
      h('div', { class: 'field' }, email, role, h('button', { class: 'btn primary', onclick: add }, 'Share')), err, list,
      h('div', { class: 'actions', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Done')));
    const draw = () => list.replaceChildren(...(shares.length ? shares.map((s) => h('li', {},
      h('span', { class: 'n' }, s.name, h('div', { class: 'hint' }, s.email)), badge(s.role),
      h('button', { class: 'btn link', onclick: async () => { await api('DELETE', `/api/documents/${id}/shares/${s.id}`); shares = shares.filter((x) => x.id !== s.id); doc.shares = shares; draw(); } }, 'Remove')))
      : [h('li', { class: 'hint' }, 'Not shared with anyone yet.')]));
    async function add() {
      err.textContent = '';
      try {
        const s = await api('POST', `/api/documents/${id}/shares`, { email: email.value, role: role.value });
        shares = [...shares.filter((x) => x.id !== s.id), s]; doc.shares = shares; email.value = ''; draw();
      } catch (e) { err.textContent = e.message; }
    }
    email.addEventListener('keydown', (e) => e.key === 'Enter' && add());
    dlg.addEventListener('close', () => dlg.remove());
    draw(); document.body.append(dlg); dlg.showModal(); email.focus();
  }
}

route();

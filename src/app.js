const express = require('express');
const multer = require('multer');
const path = require('path');
const { openDb, newId, SEED_USERS } = require('./db');
const auth = require('./auth');
const { importFile, clean, SUPPORTED } = require('./importers');

const MAX_UPLOAD = 2 * 1024 * 1024;
const MAX_CONTENT = 1_000_000; // chars of HTML
const httpError = (status, message) => Object.assign(new Error(message), { status });

function createApp(db = openDb()) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });
  app.use(express.json({ limit: '2mb' }));

  // ---- helpers -------------------------------------------------------------
  const q = {
    user: db.prepare('SELECT id,email,name FROM users WHERE id=?'),
    userByEmail: db.prepare('SELECT id,email,name FROM users WHERE email=?'),
    doc: db.prepare('SELECT d.*, u.name AS owner_name, u.email AS owner_email FROM documents d JOIN users u ON u.id=d.owner_id WHERE d.id=?'),
    share: db.prepare('SELECT role FROM shares WHERE doc_id=? AND user_id=?'),
  };
  // Single source of truth for authorization. Returns null for "no access",
  // and callers map that to 404 so we never reveal that a doc exists.
  function roleFor(doc, userId) {
    if (!doc) return null;
    if (doc.owner_id === userId) return 'owner';
    return q.share.get(doc.id, userId)?.role ?? null;
  }
  function load(req, { need = 'viewer' } = {}) {
    const doc = q.doc.get(req.params.id);
    const role = roleFor(doc, req.user.id);
    if (!role) throw httpError(404, 'Document not found');
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (rank[role] < rank[need]) throw httpError(403, need === 'owner' ? 'Only the owner can do this' : 'You have view-only access');
    return { doc, role };
  }
  const summary = (d, role) => ({
    id: d.id, title: d.title, role, owner: { name: d.owner_name, email: d.owner_email }, updatedAt: d.updated_at,
  });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const cleanTitle = (t) => {
    if (typeof t !== 'string' || !t.trim()) throw httpError(400, 'Title is required');
    return t.trim().slice(0, 120);
  };

  // ---- auth ----------------------------------------------------------------
  app.get('/api/users', (_req, res) => res.json(SEED_USERS));
  app.post('/api/login', (req, res) => {
    const user = q.user.get(req.body?.userId);
    if (!user) throw httpError(400, 'Unknown user');
    auth.issue(res, user.id);
    res.json(user);
  });
  app.post('/api/logout', (_req, res) => { res.clearCookie('sid'); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => {
    const user = q.user.get(auth.parse(req) || '');
    user ? res.json(user) : res.status(401).json({ error: 'Not signed in' });
  });

  // everything below requires a session
  app.use('/api', (req, _res, next) => {
    const user = q.user.get(auth.parse(req) || '');
    if (!user) return next(httpError(401, 'Please sign in'));
    req.user = user; next();
  });

  // ---- documents -----------------------------------------------------------
  app.get('/api/documents', (req, res) => {
    const owned = db.prepare(`SELECT d.*, u.name owner_name, u.email owner_email FROM documents d JOIN users u ON u.id=d.owner_id
      WHERE d.owner_id=? ORDER BY d.updated_at DESC`).all(req.user.id).map((d) => summary(d, 'owner'));
    const shared = db.prepare(`SELECT d.*, u.name owner_name, u.email owner_email, s.role FROM shares s
      JOIN documents d ON d.id=s.doc_id JOIN users u ON u.id=d.owner_id
      WHERE s.user_id=? ORDER BY d.updated_at DESC`).all(req.user.id).map((d) => summary(d, d.role));
    res.json({ owned, shared });
  });

  app.post('/api/documents', (req, res) => {
    const title = req.body?.title ? cleanTitle(req.body.title) : 'Untitled document';
    const id = newId();
    db.prepare('INSERT INTO documents (id,owner_id,title) VALUES (?,?,?)').run(id, req.user.id, title);
    res.status(201).json({ id });
  });

  app.post('/api/documents/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, `Choose a file to upload (${SUPPORTED.join(', ')})`);
    const { title, content } = await importFile(req.file.originalname, req.file.buffer);
    const id = newId();
    db.prepare('INSERT INTO documents (id,owner_id,title,content) VALUES (?,?,?,?)').run(id, req.user.id, title, content);
    res.status(201).json({ id });
  }));

  app.get('/api/documents/:id', (req, res) => {
    const { doc, role } = load(req);
    const shares = role === 'owner'
      ? db.prepare('SELECT u.id,u.name,u.email,s.role FROM shares s JOIN users u ON u.id=s.user_id WHERE s.doc_id=? ORDER BY u.name').all(doc.id)
      : undefined;
    res.json({ ...summary(doc, role), content: doc.content, version: doc.version, shares });
  });

  app.put('/api/documents/:id', (req, res) => {
    const { doc, role } = load(req, { need: 'editor' });
    const { title, content, version } = req.body || {};
    if (!Number.isInteger(version)) throw httpError(400, 'version is required');
    if (title === undefined && content === undefined) throw httpError(400, 'Nothing to update');
    const newTitle = title === undefined ? doc.title : cleanTitle(title);
    if (content !== undefined && (typeof content !== 'string' || content.length > MAX_CONTENT)) throw httpError(400, 'Content is invalid or too large');
    const newContent = content === undefined ? doc.content : clean(content);
    // Compare-and-swap: a stale writer gets 409 instead of silently clobbering.
    const r = db.prepare(`UPDATE documents SET title=?, content=?, version=version+1, updated_at=datetime('now')
      WHERE id=? AND version=?`).run(newTitle, newContent, doc.id, version);
    if (!r.changes) throw httpError(409, 'This document was changed by someone else. Reload to get the latest version.');
    res.json({ version: version + 1, role });
  });

  app.delete('/api/documents/:id', (req, res) => {
    const { doc } = load(req, { need: 'owner' });
    db.prepare('DELETE FROM documents WHERE id=?').run(doc.id);
    res.json({ ok: true });
  });

  // ---- sharing -------------------------------------------------------------
  app.post('/api/documents/:id/shares', (req, res) => {
    const { doc } = load(req, { need: 'owner' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role || 'viewer';
    if (!['viewer', 'editor'].includes(role)) throw httpError(400, 'Role must be viewer or editor');
    const target = q.userByEmail.get(email);
    if (!target) throw httpError(404, `No user with email ${email || '(empty)'}. Try ${SEED_USERS.map((u) => u.email).join(', ')}`);
    if (target.id === doc.owner_id) throw httpError(400, 'You already own this document');
    db.prepare(`INSERT INTO shares (doc_id,user_id,role) VALUES (?,?,?)
      ON CONFLICT(doc_id,user_id) DO UPDATE SET role=excluded.role`).run(doc.id, target.id, role);
    res.status(201).json({ ...target, role });
  });

  app.delete('/api/documents/:id/shares/:userId', (req, res) => {
    const { doc } = load(req, { need: 'owner' });
    db.prepare('DELETE FROM shares WHERE doc_id=? AND user_id=?').run(doc.id, req.params.userId);
    res.json({ ok: true });
  });

  // ---- static + errors -----------------------------------------------------
  app.use('/vendor/quill', express.static(path.join(__dirname, '../node_modules/quill/dist')));
  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.code === 'LIMIT_FILE_SIZE') err = httpError(413, `File too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`);
    // Malformed JSON: replace body-parser's parser message with a stable one.
    if (err.type === 'entity.parse.failed') err = httpError(400, 'Malformed JSON body');
    // Multer's other rejections are client mistakes, not server faults.
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      err = httpError(400, 'Upload exactly one file in the "file" field');
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });
  return app;
}
module.exports = { createApp };

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const { docx } = require('./helpers/docx');

let server, base;
before(async () => {
  server = createApp(openDb(':memory:')).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// Sign in and return just the session cookie for that user.
async function loginCookie(userId) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) });
  return r.headers.get('set-cookie').split(';')[0];
}

// Tiny client that keeps a session cookie per user.
async function as(userId) {
  const cookie = await loginCookie(userId);
  const call = async (method, url, body, raw) => {
    const res = await fetch(base + url, {
      method, headers: { cookie, ...(raw ? {} : { 'content-type': 'application/json' }) },
      body: raw ? body : body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return call;
}

test('requires sign-in', async () => {
  const r = await fetch(`${base}/api/documents`);
  assert.equal(r.status, 401);
});

test('create, rename, edit, reload preserves formatting', async () => {
  const alice = await as('u_alice');
  const { body: { id } } = await alice('POST', '/api/documents', {});
  const doc = (await alice('GET', `/api/documents/${id}`)).body;
  const html = '<h1>Plan</h1><p><strong>bold</strong> <em>it</em> <u>u</u></p><ul><li>a</li></ul>';
  const put = await alice('PUT', `/api/documents/${id}`, { title: 'Roadmap', content: html, version: doc.version });
  assert.equal(put.status, 200);
  const again = (await alice('GET', `/api/documents/${id}`)).body;
  assert.equal(again.title, 'Roadmap');
  assert.equal(again.content, html);
});

test('sharing: owner/shared distinction, role enforcement, revoke, hidden from strangers', async () => {
  const alice = await as('u_alice'), bob = await as('u_bob'), carol = await as('u_carol');
  const { body: { id } } = await alice('POST', '/api/documents', { title: 'Secret' });

  assert.equal((await bob('GET', `/api/documents/${id}`)).status, 404, 'no access before share');

  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'bob@ajaia.test', role: 'viewer' })).status, 201);
  const list = (await bob('GET', '/api/documents')).body;
  assert.equal(list.shared.find((d) => d.id === id).role, 'viewer');
  assert.equal(list.owned.length, 0);

  const v = (await bob('GET', `/api/documents/${id}`)).body;
  assert.equal((await bob('PUT', `/api/documents/${id}`, { content: '<p>x</p>', version: v.version })).status, 403);
  assert.equal((await bob('POST', `/api/documents/${id}/shares`, { email: 'carol@ajaia.test' })).status, 403);

  await alice('POST', `/api/documents/${id}/shares`, { email: 'bob@ajaia.test', role: 'editor' }); // upgrade
  assert.equal((await bob('PUT', `/api/documents/${id}`, { content: '<p>x</p>', version: v.version })).status, 200);

  assert.equal((await carol('GET', `/api/documents/${id}`)).status, 404);
  await alice('DELETE', `/api/documents/${id}/shares/u_bob`);
  assert.equal((await bob('GET', `/api/documents/${id}`)).status, 404, 'revoked');
});

test('stale version is rejected with 409', async () => {
  const alice = await as('u_alice');
  const { body: { id } } = await alice('POST', '/api/documents', {});
  const d = (await alice('GET', `/api/documents/${id}`)).body;
  await alice('PUT', `/api/documents/${id}`, { content: '<p>1</p>', version: d.version });
  assert.equal((await alice('PUT', `/api/documents/${id}`, { content: '<p>2</p>', version: d.version })).status, 409);
});

test('validation: empty title, bad share inputs, script stripped', async () => {
  const alice = await as('u_alice');
  const { body: { id } } = await alice('POST', '/api/documents', {});
  const d = (await alice('GET', `/api/documents/${id}`)).body;
  assert.equal((await alice('PUT', `/api/documents/${id}`, { title: '  ', version: d.version })).status, 400);
  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'nobody@x.com' })).status, 404);
  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'alice@ajaia.test' })).status, 400);
  await alice('PUT', `/api/documents/${id}`, { content: '<p>hi<script>alert(1)</script></p><img src=x onerror=alert(1)>', version: d.version });
  assert.equal((await alice('GET', `/api/documents/${id}`)).body.content, '<p>hi</p>');
});

test('upload: .md and .txt become documents; bad types rejected', async () => {
  const alice = await as('u_alice');
  const send = (name, text) => { const f = new FormData(); f.append('file', new Blob([text]), name); return alice('POST', '/api/documents/import', f, true); };

  const md = await send('notes.md', '# Title\n\nSome **bold** text\n\n- one\n- two');
  assert.equal(md.status, 201);
  const d = (await alice('GET', `/api/documents/${md.body.id}`)).body;
  assert.equal(d.title, 'notes');
  assert.match(d.content, /<h1>Title<\/h1>/);
  assert.match(d.content, /<strong>bold<\/strong>/);
  assert.match(d.content, /<ul>/);

  const txt = await send('a.txt', 'line one\nline two\n\n<b>para</b>');
  assert.match((await alice('GET', `/api/documents/${txt.body.id}`)).body.content, /&lt;b&gt;para/);

  assert.equal((await send('x.exe', 'nope')).status, 415);
});

test('upload: .docx import keeps heading, bold and lists', async () => {
  const alice = await as('u_alice');
  const buf = docx([['h1', 'Quarterly Plan'], ['p', 'Intro.'], ['bold', 'Important'], ['ul', ['Alpha', 'Beta']]]);
  const f = new FormData(); f.append('file', new Blob([buf]), 'report.docx');
  const r = await alice('POST', '/api/documents/import', f, true);
  assert.equal(r.status, 201);

  const d = (await alice('GET', `/api/documents/${r.body.id}`)).body;
  assert.equal(d.title, 'report');
  assert.match(d.content, /<h1>Quarterly Plan<\/h1>/);
  assert.match(d.content, /<strong>Important<\/strong>/);
  assert.match(d.content, /<ul><li>Alpha<\/li><li>Beta<\/li><\/ul>/);
});

test('upload: corrupt .docx is 422, wrong field is 400, oversized is 413', async () => {
  const alice = await as('u_alice');
  const withField = (field, name, data) => {
    const f = new FormData(); f.append(field, new Blob([data]), name); return alice('POST', '/api/documents/import', f, true);
  };

  assert.equal((await withField('file', 'broken.docx', Buffer.from('definitely not a zip'))).status, 422);
  assert.equal((await withField('attachment', 'ok.txt', 'hello')).status, 400);

  const big = 'x'.repeat(2 * 1024 * 1024 + 1024);
  assert.equal((await withField('file', 'big.txt', big)).status, 413);
});

test('session cookie is signed: forged or tampered cookies are rejected', async () => {
  const real = await loginCookie('u_alice');
  const [id, sig] = real.split('=')[1].split('.');
  assert.equal(id, 'u_alice');

  // Re-sign a *different* user id with the victim's signature.
  const swapped = `sid=u_carol.${sig}`;
  assert.equal((await fetch(`${base}/api/documents`, { headers: { cookie: swapped } })).status, 401, 'id swapped, signature kept');

  // Invent a signature from scratch.
  const madeUp = `sid=u_alice.${'0'.repeat(sig.length)}`;
  assert.equal((await fetch(`${base}/api/documents`, { headers: { cookie: madeUp } })).status, 401, 'invented signature');

  // No cookie at all.
  assert.equal((await fetch(`${base}/api/documents`)).status, 401);
});

test('sanitizer keeps editor output and strips active content', async () => {
  const alice = await as('u_alice');
  const { body: { id } } = await alice('POST', '/api/documents', {});
  const d = (await alice('GET', `/api/documents/${id}`)).body;

  const editorHtml = '<h2>H</h2><ol><li class="ql-indent-1">a</li></ol><ul><li>b</li></ul>'
    + '<p class="ql-align-center">c</p><a href="https://ok.test">link</a><blockquote><u>q</u></blockquote>';
  const hostile = '<a href="javascript:alert(1)">x</a><svg onload=alert(1)></svg>'
    + '<iframe src="https://evil.test"></iframe><p style="position:fixed" onclick="evil()">s</p>';

  await alice('PUT', `/api/documents/${id}`, { content: editorHtml + hostile, version: d.version });
  const saved = (await alice('GET', `/api/documents/${id}`)).body.content;

  for (const keep of ['<h2>H</h2>', 'ql-indent-1', '<ul><li>b</li></ul>', 'ql-align-center', 'https://ok.test', '<u>q</u>']) {
    assert.ok(saved.includes(keep), `expected ${keep} to survive`);
  }
  for (const drop of ['javascript:', '<svg', '<iframe', 'onclick', 'style=', 'position:fixed']) {
    assert.ok(!saved.includes(drop), `expected ${drop} to be stripped`);
  }
});

test('malformed JSON body returns a clean 400', async () => {
  const cookie = await loginCookie('u_alice');
  const res = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"title":',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Malformed JSON body');
});

test('unknown document id is 404, unknown api route is 404', async () => {
  const alice = await as('u_alice');
  assert.equal((await alice('GET', '/api/documents/does_not_exist')).status, 404);
  assert.equal((await alice('GET', '/api/nope')).status, 404);
  assert.equal((await alice('DELETE', '/api/documents/does_not_exist')).status, 404);
});

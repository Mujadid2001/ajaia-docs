const crypto = require('crypto');

// better-sqlite3 ships a prebuilt native binary tied to the Node ABI. On a
// mismatched runtime it loads and then *segfaults* with no message, so fail
// loudly and early instead. See package.json "engines".
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  throw new Error(
    `Ajaia Docs requires Node 22.12+ (found ${process.version}). ` +
    'Older runtimes cannot load the better-sqlite3 native module.'
  );
}

const Database = require('better-sqlite3');

const SEED_USERS = [
  { id: 'u_alice', email: 'alice@ajaia.test', name: 'Alice Nguyen' },
  { id: 'u_bob', email: 'bob@ajaia.test', name: 'Bob Martins' },
  { id: 'u_carol', email: 'carol@ajaia.test', name: 'Carol Haddad' },
];

function openDb(file = process.env.DB_PATH || './data/app.db') {
  if (file !== ':memory:') require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',   -- sanitized HTML
      version INTEGER NOT NULL DEFAULT 1, -- optimistic concurrency token
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS shares (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (doc_id, user_id));
    CREATE INDEX IF NOT EXISTS idx_docs_owner ON documents(owner_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
  `);
  const ins = db.prepare('INSERT OR IGNORE INTO users (id,email,name) VALUES (@id,@email,@name)');
  SEED_USERS.forEach((u) => ins.run(u));
  return db;
}

const newId = () => crypto.randomBytes(8).toString('hex');
module.exports = { openDb, newId, SEED_USERS };

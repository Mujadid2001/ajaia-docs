const crypto = require('crypto');
// Mock auth: pick a seeded user, get a signed httpOnly cookie. Deliberately NOT
// production auth — see ARCHITECTURE.md for what replaces it.
const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');

function issue(res, userId) {
  res.cookie('sid', `${userId}.${sign(userId)}`, {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5, secure: process.env.NODE_ENV === 'production',
  });
}
function parse(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const [id, sig] = decodeURIComponent(m[1]).split('.');
  if (!id || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}
module.exports = { issue, parse };

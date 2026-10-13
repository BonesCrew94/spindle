'use strict';
/*
 * Spindle sync server
 * -------------------
 * Serves the Spindle app AND its sync API from one origin, so the browser
 * never deals with CORS.
 *
 * Accounts are real: passwords are hashed with scrypt, sessions are
 * HttpOnly cookies, and each account can only read and write its own
 * listening history. No database and no npm packages - Node's standard
 * library and JSON files on disk.
 *
 * Creating the FIRST account needs the one-time setup code printed to the
 * log at startup, so a server that is briefly reachable before you get to
 * it cannot be claimed by someone else.
 *
 * env:
 *   PORT            default 8088
 *   DATA_DIR        default /data        (accounts, sessions, state)
 *   PUBLIC_DIR      default /srv/public  (index.html, icons, sw.js)
 *   SECURE_COOKIES  set to 1 when reached only over HTTPS
 *   SESSION_DAYS    default 30
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const dns     = require('dns').promises;
const net     = require('net');

const PORT        = parseInt(process.env.PORT || '8088', 10);
const DATA_DIR    = process.env.DATA_DIR   || '/data';
const PUBLIC_DIR  = process.env.PUBLIC_DIR || '/srv/public';
const SECURE_COOK = process.env.SECURE_COOKIES === '1';
const SESSION_MS  = (parseInt(process.env.SESSION_DAYS || '30', 10)) * 864e5;
const MAX_BODY    = 8 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'state'), { recursive: true });

const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const TOKEN_FILE    = path.join(DATA_DIR, 'setup-token.txt');

/* ------------------------------------------------------------------ disk */

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
/* temp file + rename, so a crash mid-write can't truncate anything */
function writeJSON(file, obj) {
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

let users    = readJSON(USERS_FILE, {});      // lowercased name -> {name,salt,hash,created}
let sessions = readJSON(SESSIONS_FILE, {});   // token -> {user, created, seen}

/* ------------------------------------------------------------ passwords */
/*
 * scrypt is deliberately slow and memory-hard, which is what you want here:
 * it makes guessing expensive even if someone walks off with users.json.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
}
function makeUser(name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { name, salt, hash: hashPassword(password, salt), created: Date.now() };
}
/* constant-time compare so response timing can't leak the hash */
function passwordMatches(user, password) {
  const attempt = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored  = Buffer.from(user.hash, 'hex');
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

/* ---------------------------------------------------------- setup token */
/*
 * The very first account is the one moment this server cannot authenticate:
 * there is nobody to check against yet. Leaving that open would mean whoever
 * reaches the port first owns the server, so instead a one-time token is
 * generated at startup and printed to the log. Creating the first account
 * requires it, and it is destroyed the moment that account exists.
 *
 * It is written to DATA_DIR/setup-token.txt as well, for anyone who misses
 * the log line. That file disappears with the first account.
 */

/* No 0/O/1/I - this gets read off a terminal and typed into a phone */
const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeToken() {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i && i % 5 === 0) out += '-';
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;                                  // XXXXX-XXXXX-XXXXX-XXXXX
}

let setupToken = null;

function loadOrCreateToken() {
  if (Object.keys(users).length) {             // already set up, nothing to guard
    setupToken = null;
    try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (e) {}
    return;
  }
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) { setupToken = existing; return; }
  } catch (e) {}
  setupToken = makeToken();
  try {
    fs.writeFileSync(TOKEN_FILE, setupToken + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('[spindle-sync] could not write ' + TOKEN_FILE + ': ' + e.message);
  }
}

function burnToken() {
  setupToken = null;
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (e) {}
}

/* constant-time, and tolerant of the dashes and case being typed differently */
function tokenMatches(given) {
  if (!setupToken || typeof given !== 'string') return false;
  const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const a = Buffer.from(norm(given)), b = Buffer.from(norm(setupToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- naming */

function cleanName(n) {
  if (typeof n !== 'string') return null;
  const s = n.trim().slice(0, 40);
  return /^[A-Za-z0-9 _-]{1,40}$/.test(s) ? s : null;
}
const keyOf = n => n.toLowerCase();
const stateFile = n => path.join(DATA_DIR, 'state', encodeURIComponent(keyOf(n)) + '.json');

/* --------------------------------------------------------------- session */

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  Object.keys(sessions).forEach(t => {
    if (now - (sessions[t].seen || sessions[t].created) > SESSION_MS) {
      delete sessions[t]; changed = true;
    }
  });
  if (changed) writeJSON(SESSIONS_FILE, sessions);
}

function newSession(userName) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[token] = { user: keyOf(userName), created: Date.now(), seen: Date.now() };
  writeJSON(SESSIONS_FILE, sessions);
  return token;
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie).sp_session;
  if (!token) return null;
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - (s.seen || s.created) > SESSION_MS) {
    delete sessions[token]; writeJSON(SESSIONS_FILE, sessions); return null;
  }
  /* only rewrite the file when the timestamp has meaningfully moved */
  if (Date.now() - s.seen > 36e5) { s.seen = Date.now(); writeJSON(SESSIONS_FILE, sessions); }
  return users[s.user] || null;
}

function cookieHeader(token, maxAgeSeconds) {
  const bits = [
    'sp_session=' + (token || ''),
    'Path=/',
    'HttpOnly',                 // JavaScript can't read it, so XSS can't steal it
    'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds
  ];
  if (SECURE_COOK) bits.push('Secure');
  return bits.join('; ');
}

/* ------------------------------------------------- login rate limiting */
/* Keeps someone from grinding through passwords. In-memory is fine: a
   restart clearing it is not a meaningful weakness at this scale. */
const attempts = new Map();
const ATTEMPT_WINDOW = 15 * 60 * 1000, ATTEMPT_MAX = 10;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW) { attempts.delete(ip); return false; }
  return rec.count >= ATTEMPT_MAX;
}
function noteAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW) attempts.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}
const clearAttempts = ip => attempts.delete(ip);

/* ------------------------------------------------------------- responses */

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',             '.png':'image/png',
  '.ico':'image/x-icon',              '.webmanifest':'application/manifest+json',
  '.md':'text/plain; charset=utf-8'
};

function sendJSON(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body);
}

/* ------------------------------------------------------------- app state */

const EMPTY = () => ({ feeds:{}, progress:{}, queue:{items:[],u:0}, playlists:{}, prefs:{}, rev:0, updated:0 });
const readState  = name => readJSON(stateFile(name), EMPTY());
const writeState = (name, s) => writeJSON(stateFile(name), s);

/*
 * Every syncable value carries `u`, when it last changed on some device.
 * Merging is per-key newest-wins: two devices editing DIFFERENT episodes
 * both keep their changes; only a real conflict on the SAME episode
 * resolves to whichever happened later.
 */
const newer = (a, b) => ((a && a.u) || 0) >= ((b && b.u) || 0) ? a : b;

function mergeState(server, client) {
  const out = EMPTY();

  // subscriptions - unsubscribes are tombstones, not deletions, so a removal
  // on one device isn't resurrected by the other's stale copy
  new Set([...Object.keys(server.feeds||{}), ...Object.keys(client.feeds||{})]).forEach(url => {
    const win = newer((server.feeds||{})[url], (client.feeds||{})[url]);
    if (win) out.feeds[url] = win;
  });

  new Set([...Object.keys(server.progress||{}), ...Object.keys(client.progress||{})]).forEach(g => {
    const win = newer((server.progress||{})[g], (client.progress||{})[g]);
    if (win) out.progress[g] = win;
  });

  // the queue is ordered, so it moves as a whole rather than item by item
  out.queue = newer(server.queue, client.queue) || {items:[],u:0};

  // playlists merge one list at a time - editing different playlists on two
  // devices keeps both edits; the same list resolves to the later change.
  // Deleted lists leave a tombstone so they don't come back.
  new Set([...Object.keys(server.playlists||{}), ...Object.keys(client.playlists||{})]).forEach(id => {
    const win = newer((server.playlists||{})[id], (client.playlists||{})[id]);
    if (win) out.playlists[id] = win;
  });

  new Set([...Object.keys(server.prefs||{}), ...Object.keys(client.prefs||{})]).forEach(k => {
    const win = newer((server.prefs||{})[k], (client.prefs||{})[k]);
    if (win) out.prefs[k] = win;
  });

  out.rev = (server.rev || 0) + 1;
  out.updated = Date.now();
  return out;
}

/* --------------------------------------------------- outbound fetching */
/*
 * Browsers can't fetch most podcast feeds directly - hosts rarely send CORS
 * headers - so the server does it. No CORS, no third party in the path.
 */
function isPrivateAddr(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT / Tailscale
    return false;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

async function assertPublicHost(target) {
  let u;
  try { u = new URL(target); } catch (e) { throw new Error('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https are allowed');
  const { address } = await dns.lookup(u.hostname);
  if (isPrivateAddr(address)) throw new Error('refusing to fetch a private address');
  return u;
}

async function fetchUpstream(target, accept) {
  await assertPublicHost(target);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(target, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Spindle/1.0 (+podcast client)', 'Accept': accept || '*/*' }
    });
    return { status: r.status, ok: r.ok, body: await r.text(),
             type: r.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------- static */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(path.resolve(PUBLIC_DIR) + path.sep) &&
       full !== path.resolve(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // the service worker must never be stale or updates can't land
      'Cache-Control': (rel === '/sw.js' || rel === '/index.html') ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const clientIP = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress || 'unknown';

/* --------------------------------------------------------------- router */

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (!url.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  }

  try {
    const noUsers = Object.keys(users).length === 0;

    /* ---------- open endpoints ---------- */

    // Tells the app whether to show "create the first account" or "log in".
    if (url === '/api/auth/status' && req.method === 'GET') {
      const me = sessionUser(req);
      return sendJSON(res, 200, {
        setupNeeded: noUsers,
        /* whether the first-account form needs to ask for the setup token.
           The token itself is never sent anywhere. */
        tokenRequired: noUsers && !!setupToken,
        user: me ? me.name : null,
        secure: SECURE_COOK
      });
    }

    if (url === '/api/auth/login' && req.method === 'POST') {
      const ip = clientIP(req);
      if (tooManyAttempts(ip))
        return sendJSON(res, 429, { error: 'too many attempts, wait 15 minutes' });

      const body = await readBody(req);
      const name = cleanName(body.name);
      const user = name ? users[keyOf(name)] : null;

      /* same response either way so this can't be used to enumerate accounts */
      if (!user || typeof body.password !== 'string' || !passwordMatches(user, body.password)) {
        noteAttempt(ip);
        return sendJSON(res, 401, { error: 'wrong name or password' });
      }
      clearAttempts(ip);
      const token = newSession(user.name);
      return sendJSON(res, 200, { user: user.name },
        { 'Set-Cookie': cookieHeader(token, Math.floor(SESSION_MS / 1000)) });
    }

    // First account is open (nothing to protect yet). After that you must
    // already be signed in to add a household member.
    if (url === '/api/auth/register' && req.method === 'POST') {
      const me = sessionUser(req);
      if (!noUsers && !me)
        return sendJSON(res, 401, { error: 'sign in first to add another account' });

      const body = await readBody(req);

      /* The first account is the only one nobody can be asked to authorise,
         so it is gated on the token printed at startup instead. Rate limited
         with the login attempts, so it cannot be guessed at speed. */
      if (noUsers) {
        const ip = clientIP(req);
        if (tooManyAttempts(ip))
          return sendJSON(res, 429, { error: 'too many attempts, wait 15 minutes' });
        if (!setupToken)
          return sendJSON(res, 500, { error: 'no setup token on this server - check the container log' });
        if (!tokenMatches(body.token)) {
          noteAttempt(ip);
          return sendJSON(res, 401, { error: 'that setup code is not right' });
        }
        clearAttempts(ip);
      }

      const name = cleanName(body.name);
      if (!name) return sendJSON(res, 400, { error: 'name: 1-40 chars, letters, numbers, space, _ or -' });
      if (typeof body.password !== 'string' || body.password.length < 8)
        return sendJSON(res, 400, { error: 'password must be at least 8 characters' });
      if (users[keyOf(name)]) return sendJSON(res, 409, { error: 'that name is taken' });

      users[keyOf(name)] = makeUser(name, body.password);
      writeJSON(USERS_FILE, users);
      if (!fs.existsSync(stateFile(name))) writeState(name, EMPTY());

      // creating the first account signs you straight in, and spends the
      // setup token - there is a real account to authenticate against now
      if (noUsers) {
        burnToken();
        const token = newSession(name);
        return sendJSON(res, 201, { user: name },
          { 'Set-Cookie': cookieHeader(token, Math.floor(SESSION_MS / 1000)) });
      }
      return sendJSON(res, 201, { user: name });
    }

    /* ---------- everything below needs a session ---------- */

    const me = sessionUser(req);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });

    if (url === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie).sp_session;
      if (token) { delete sessions[token]; writeJSON(SESSIONS_FILE, sessions); }
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    }

    if (url === '/api/auth/password' && req.method === 'POST') {
      const body = await readBody(req);
      if (!passwordMatches(me, body.current || ''))
        return sendJSON(res, 401, { error: 'current password is wrong' });
      if (typeof body.next !== 'string' || body.next.length < 8)
        return sendJSON(res, 400, { error: 'new password must be at least 8 characters' });

      users[keyOf(me.name)] = makeUser(me.name, body.next);
      writeJSON(USERS_FILE, users);

      /* changing the password ends every other session but this one */
      const keep = parseCookies(req.headers.cookie).sp_session;
      Object.keys(sessions).forEach(t => {
        if (sessions[t].user === keyOf(me.name) && t !== keep) delete sessions[t];
      });
      writeJSON(SESSIONS_FILE, sessions);
      return sendJSON(res, 200, { ok: true });
    }

    if (url === '/api/accounts' && req.method === 'GET')
      return sendJSON(res, 200, { accounts: Object.values(users).map(u => u.name).sort() });

    // Your own state only - there is no way to ask for someone else's.
    if (url === '/api/state' && req.method === 'GET')
      return sendJSON(res, 200, readState(me.name));

    if (url === '/api/state' && req.method === 'POST') {
      const client = await readBody(req);
      const merged = mergeState(readState(me.name), client || {});
      writeState(me.name, merged);
      return sendJSON(res, 200, merged);
    }

    if (url.startsWith('/api/feed?') && req.method === 'GET') {
      const target = new URL(url, 'http://x').searchParams.get('url');
      if (!target) return sendJSON(res, 400, { error: 'missing url parameter' });
      try {
        const up = await fetchUpstream(target, 'application/rss+xml, application/xml, text/xml, */*');
        if (!up.ok) return sendJSON(res, 502, { error: 'the feed host returned ' + up.status });
        if (!/<rss|<feed|<channel/i.test(up.body))
          return sendJSON(res, 502, { error: 'that URL returned ' +
            (up.type.split(';')[0] || 'something') + ', not a podcast feed' });
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(up.body);
      } catch (e) { return sendJSON(res, 502, { error: String(e.message || e) }); }
    }

    if (url.startsWith('/api/search?') && req.method === 'GET') {
      const term = new URL(url, 'http://x').searchParams.get('term');
      if (!term) return sendJSON(res, 400, { error: 'missing term parameter' });
      const target = 'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&term=' +
                     encodeURIComponent(term);
      try {
        const up = await fetchUpstream(target, 'application/json');
        if (!up.ok) return sendJSON(res, 502, { error: 'the directory returned ' + up.status });
        return sendJSON(res, 200, JSON.parse(up.body));
      } catch (e) { return sendJSON(res, 502, { error: String(e.message || e) }); }
    }

    return sendJSON(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return sendJSON(res, 400, { error: String(e.message || e) });
  }
});

/* one-time: adopt profile files from the pre-accounts version */
(function adoptLegacyProfiles() {
  try {
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'))
      .filter(f => !['users.json', 'sessions.json'].includes(f))
      .forEach(f => {
        const target = path.join(DATA_DIR, 'state', f);
        if (!fs.existsSync(target)) {
          fs.renameSync(path.join(DATA_DIR, f), target);
          console.log('[spindle-sync] adopted existing profile: ' + decodeURIComponent(f.slice(0, -5)));
        }
      });
  } catch (e) {}
})();

pruneSessions();
setInterval(pruneSessions, 6 * 3600 * 1000);
loadOrCreateToken();

server.listen(PORT, '0.0.0.0', () => {
  const names = Object.values(users).map(u => u.name);
  console.log('[spindle-sync] listening on :' + PORT);
  console.log('[spindle-sync] data    ' + DATA_DIR);
  console.log('[spindle-sync] public  ' + PUBLIC_DIR);
  console.log('[spindle-sync] cookies ' + (SECURE_COOK ? 'Secure (HTTPS only)' : 'not Secure - set SECURE_COOKIES=1 behind HTTPS'));
  console.log('[spindle-sync] accounts ' + (names.length ? names.join(', ') : 'none yet'));

  /* Loud on purpose. Someone deploying this needs to see it, and it is the
     one piece of information that is useless the moment it has been used. */
  if (setupToken) {
    const bar = '='.repeat(52);
    console.log('\n' + bar);
    console.log('  FIRST RUN - setup code for creating your account:');
    console.log('');
    console.log('      ' + setupToken);
    console.log('');
    console.log('  Open the app and enter it. It stops working as soon');
    console.log('  as the first account exists.');
    console.log('  Also saved at ' + TOKEN_FILE);
    console.log(bar + '\n');
  }
});

/* ============================================================================
   Toler Homes — local dev server (zero dependencies, Node 18+)
   ----------------------------------------------------------------------------
   Run:  node server.js     (or double-click start-tolerhomes.bat)
   Open: http://localhost:4500

   Endpoints
     POST   /api/login              { workspace, email, password } -> { ok, user, token }
     POST   /api/logout
     GET    /api/me
     GET    /auth/google/start      (scaffold; fill in creds below)
     GET    /auth/google/callback   (exchanges code, gates by allow-list)
     GET    /api/users              owner-only: list logins
     POST   /api/users              owner-only: add login
     PATCH  /api/users              owner-only: toggle google/active/role/name
     DELETE /api/users?email=       owner-only: remove login
     PATCH  /api/workspace          owner-only: set allowed Google domains
     GET    /api/homes              list projects
     POST   /api/homes              add a home/property
     POST   /api/homes/sub          add a subcontractor
     POST   /api/homes/po           add a purchase order
     POST   /api/homes/inspection   add an inspection/permit
     PATCH  /api/homes/listing      edit listing & sale (+ stage)
     PATCH  /api/homes/budget       edit a budget division
     PATCH  /api/homes/stage        move a home to another stage

   Passwords are salted SHA-256 (salt:hash), never plain text.
   users.json + homes.json are auto-seeded on first run, then you own them.
============================================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4500;
const ROOT = __dirname;
// DATA_DIR lets a host mount a persistent disk for the JSON data (set it in
// production, e.g. /var/data). Locally it defaults to the app folder.
const DATA_DIR = process.env.DATA_DIR || ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
// Serve static from ./public locally, or from the repo root when deployed flat.
const PUBLIC = fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public') : ROOT;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HOMES_FILE = path.join(DATA_DIR, 'homes.json');
const HOMES_SEED = path.join(ROOT, 'homes.seed.json');

/* ---- Google OAuth (scaffold) ----------------------------------------------
   Turn on real Google sign-in:
   1. Create an OAuth client at https://console.cloud.google.com/apis/credentials
      Authorized redirect URI:  http://localhost:4500/auth/google/callback
   2. Set clientId/clientSecret below (or env GOOGLE_CLIENT_ID / _SECRET). Restart.
   Google authenticates the account; your allow-list decides who gets in. */
// Credentials load order: google-oauth.json (gitignore it!) -> env vars -> blank.
let GOOGLE_FILE = {};
try { if (fs.existsSync(path.join(ROOT, 'google-oauth.json')))
  GOOGLE_FILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'google-oauth.json'), 'utf8')); } catch (e) {}
const GOOGLE = {
  clientId: GOOGLE_FILE.client_id || process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: GOOGLE_FILE.client_secret || process.env.GOOGLE_CLIENT_SECRET || '',
  redirect: GOOGLE_FILE.redirect || process.env.GOOGLE_REDIRECT || `http://localhost:${PORT}/auth/google/callback`,
};

// Anthropic key for the AI schedule builder. anthropic.json -> env -> blank.
let AI_FILE = {};
try { if (fs.existsSync(path.join(ROOT, 'anthropic.json')))
  AI_FILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'anthropic.json'), 'utf8')); } catch (e) {}
const AI = {
  apiKey: AI_FILE.api_key || process.env.ANTHROPIC_API_KEY || '',
  model: AI_FILE.model || 'claude-sonnet-4-6',
};

/* ---- password helpers ---------------------------------------------------- */
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}
function makeUser(company_id, email, password, role, display_name, google) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { company_id, email: email.toLowerCase(), display_name, role,
    active: true, google: google !== false,
    password_salt: salt, password_hash: hashPassword(password, salt) };
}

/* ---- users store --------------------------------------------------------- */
// Master accounts can sign in to ANY workspace and act as owner.
const MASTER = new Set(['alex.toler@tolercorp.com']);

function seedUsers() {
  const users = [
    makeUser('linkgrid-homes', 'momentumautowerke@gmail.com', 'demo', 'owner', 'Momentum Autowerke', true),
    makeUser('linkgrid-homes', 'alex.toler@tolercorp.com', 'demo', 'master', 'Alex Toler (Master)', true),
  ];
  const db = { workspaces: {
    'tolercorp': { display_name: 'Toler Corp App', auth_method: 'password+google', allowed_domains: [] },
    'linkgrid-homes': { display_name: 'LinkGrid Homes', auth_method: 'password+google', allowed_domains: [] }
  }, users };
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
  return db;
}
// Workspaces an email may enter: master -> all; others -> their active memberships.
function accessibleWorkspaces(db, email) {
  email = String(email || '').toLowerCase();
  const all = Object.keys(db.workspaces).map(slug => ({ slug, display_name: db.workspaces[slug].display_name }));
  if (MASTER.has(email)) return all;
  const mine = new Set(db.users.filter(u => u.email === email && u.active).map(u => u.company_id));
  return all.filter(w => mine.has(w.slug));
}
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return seedUsers();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function saveUsers(db) { fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2)); }
function domainOk(ws, email) {
  const list = (ws && ws.allowed_domains) || [];
  if (!list.length) return true;
  const dom = email.split('@')[1] || '';
  return list.map(d => d.toLowerCase()).includes(dom.toLowerCase());
}

/* ---- homes (project) store ----------------------------------------------- */
function defaultBudget() {
  return ['Sitework & Demo','Foundation','Framing','Roofing','Mechanical / Plumbing / Electrical',
    'Windows & Doors','Exterior Finishes','Interior Finishes','Landscape & Hardscape','General Conditions']
    .map(div => ({ div, budget: 0, committed: 0, actual: 0 }));
}
/* AI-assisted schedule builder. Reads the home's size, design status, and
   selections to size each phase, then lays out sequential dates from the
   project start. Rules-based today; swap in an LLM call here if you wire up
   an API key (the parent portal already ships @anthropic-ai/sdk). */
function generateSchedule(h) {
  const f = Math.max(0.8, (Number(h.sqft) || 4000) / 4000);   // size factor
  const designReady = h.design && /permit|complete|on file/i.test(h.design.plansStatus || '');
  const selectionsOpen = (h.selections || []).some(s => /open/i.test(s.status || ''));
  const phases = [
    ['Permitting & mobilization', designReady ? 3 : 8],
    ['Site work & foundation', Math.round(6 * f)],
    ['Framing', Math.round(10 * f)],
    ['Roof, windows & dry-in', Math.round(5 * f)],
    ['MEP rough-in', Math.round(7 * f)],
    ['Insulation & drywall', Math.round(5 * f)],
    ['Interior finishes & millwork', Math.round(12 * f) + (selectionsOpen ? 2 : 0)],
    ['Exterior & landscape', Math.round(5 * f)],
    ['Punch list, final & CO', 3],
  ];
  let cur = new Date((h.start && /^\d{4}-\d{2}-\d{2}$/.test(h.start)) ? h.start : new Date().toISOString().slice(0, 10));
  const out = [];
  for (const [name, weeks] of phases) {
    const start = new Date(cur);
    const end = new Date(cur); end.setDate(end.getDate() + weeks * 7);
    out.push({ name, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), status: 'Not started' });
    cur = new Date(end);
  }
  return out;
}
/* Real-model schedule via the Anthropic API (zero-dep fetch). Falls back to the
   rules-based generateSchedule() when no key is set or anything goes wrong. */
async function aiGenerateSchedule(h) {
  if (!AI.apiKey) return { schedule: generateSchedule(h), source: 'rules' };
  try {
    const sel = (h.selections || []).map(s => `${s.category}: ${s.status}`).join('; ') || 'none logged';
    const prompt =
      `You are a construction scheduler for spec-home development projects. Build a realistic, sequential phased construction schedule for a home the builder is developing to sell.\n` +
      `Home: ${h.name || 'home'}, ${h.sqft || '?'} sq ft. Current stage: "${h.stage}". Project start: ${h.start || 'today'}.\n` +
      `Plan status: ${(h.design && h.design.plansStatus) || 'unknown'}. Open selections: ${sel}.\n` +
      `Return ONLY a JSON array (no prose, no markdown) of 7-11 phases. Each element: ` +
      `{"name": string, "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "status": "Not started"|"In progress"|"Complete"}. ` +
      `Phases must be sequential and dated forward from the start.`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': AI.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI.model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    const m = text.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    if (Array.isArray(arr) && arr.length)
      return { schedule: arr.map(x => ({ name: String(x.name || ''), start: x.start || null, end: x.end || null, status: x.status || 'Not started' })), source: 'ai' };
  } catch (e) { /* fall through to rules */ }
  return { schedule: generateSchedule(h), source: 'rules' };
}
function loadHomes() {
  if (!fs.existsSync(HOMES_FILE)) {
    const seed = fs.existsSync(HOMES_SEED) ? fs.readFileSync(HOMES_SEED, 'utf8') : '[]';
    fs.writeFileSync(HOMES_FILE, seed);
  }
  return JSON.parse(fs.readFileSync(HOMES_FILE, 'utf8'));
}
function saveHomes(h) { fs.writeFileSync(HOMES_FILE, JSON.stringify(h, null, 2)); }
function nextHomeId(homes) {
  let n = 0; homes.forEach(h => { const m = /TH-(\d+)/.exec(h.id || ''); if (m) n = Math.max(n, +m[1]); });
  return 'TH-' + String(n + 1).padStart(2, '0');
}
const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };

/* ---- sessions ------------------------------------------------------------ */
const SESSIONS = new Map();
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function publicUser(u) {
  return { company_id: u.company_id, email: u.email, display_name: u.display_name, role: u.role };
}
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }); return out;
}
function sessionUser(req) { return SESSIONS.get(parseCookies(req).th_session) || null; }
function requireOwner(req) { const u = sessionUser(req); return (u && u.company_id && (u.role === 'owner' || u.role === 'master')) ? u : null; }
// A signed-in user who has selected a workspace.
function wsUser(req) { const u = sessionUser(req); return (u && u.company_id) ? u : null; }
// True only if the home belongs to the user's current workspace.
function ownsHome(u, h) { return !!(u && h && (h.company_id || 'linkgrid-homes') === u.company_id); }

/* ---- http helpers -------------------------------------------------------- */
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml',
  '.png':'image/png', '.json':'application/json', '.ico':'image/x-icon' };
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  const base = path.basename(file).toLowerCase(), ext = path.extname(file).toLowerCase();
  if (base === 'server.js' || ['.md', '.bat', '.json', '.yaml', '.yml'].includes(ext)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* ============================== ROUTES ==================================== */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // ---- POST /api/login ----
  // Sign in with email + password only. Returns the workspaces this account may
  // enter; the client then picks one via /api/select-workspace.
  if (url === '/api/login' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    const em = String(email || '').trim().toLowerCase();
    const pw = String(password || '');
    if (!em || !pw) return send(res, 400, { error: 'missing_fields' });
    const db = loadUsers();
    const rows = db.users.filter(u => u.email === em && (u.active || MASTER.has(em)));
    const matched = rows.find(u => hashPassword(pw, u.password_salt) === u.password_hash);
    if (!matched) return send(res, 401, { error: 'invalid_credentials' });
    const workspaces = accessibleWorkspaces(db, em);
    if (!workspaces.length) return send(res, 403, { error: 'no_workspace_access' });
    const sess = { email: em, display_name: matched.display_name, role: MASTER.has(em) ? 'master' : null, company_id: null, master: MASTER.has(em) };
    const token = newToken(); SESSIONS.set(token, sess);
    return send(res, 200, { ok: true, email: em, workspaces },
      { 'Set-Cookie': `th_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
  }

  // Pick a workspace after login. Scopes the session to that workspace.
  if (url === '/api/select-workspace' && req.method === 'POST') {
    const sess = sessionUser(req); if (!sess) return send(res, 401, { error: 'not_signed_in' });
    const { workspace } = await readBody(req); const ws = String(workspace || '').toLowerCase();
    const db = loadUsers(); if (!db.workspaces[ws]) return send(res, 404, { error: 'unknown_workspace' });
    if (!accessibleWorkspaces(db, sess.email).some(w => w.slug === ws)) return send(res, 403, { error: 'no_access' });
    let role = 'master', display_name = sess.display_name;
    if (!sess.master) {
      const row = db.users.find(u => u.company_id === ws && u.email === sess.email && u.active);
      if (!row) return send(res, 403, { error: 'no_access' });
      role = row.role; display_name = row.display_name;
    }
    sess.company_id = ws; sess.role = role; sess.display_name = display_name; sess.workspace_name = db.workspaces[ws].display_name;
    return send(res, 200, { ok: true, user: { email: sess.email, display_name, role, company_id: ws, workspace_name: sess.workspace_name } });
  }

  // List the workspaces the signed-in account may enter (for the switcher).
  if (url === '/api/my-workspaces') {
    const sess = sessionUser(req); if (!sess) return send(res, 401, { error: 'not_signed_in' });
    return send(res, 200, { ok: true, email: sess.email, current: sess.company_id || null, workspaces: accessibleWorkspaces(loadUsers(), sess.email) });
  }

  // ---- POST /api/logout ----
  if (url === '/api/logout' && req.method === 'POST') {
    const t = parseCookies(req).th_session; if (t) SESSIONS.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'th_session=; Path=/; Max-Age=0' });
  }

  // ---- GET /api/me ----
  if (url === '/api/me') {
    const sess = sessionUser(req);
    if (!sess) return send(res, 401, { error: 'not_signed_in' });
    if (!sess.company_id) return send(res, 200, { ok: true, pending: true, email: sess.email, workspaces: accessibleWorkspaces(loadUsers(), sess.email) });
    return send(res, 200, { ok: true, user: { email: sess.email, display_name: sess.display_name, role: sess.role, company_id: sess.company_id, workspace_name: sess.workspace_name } });
  }

  // ---- GET /auth/google/start ----
  if (url === '/auth/google/start') {
    if (!GOOGLE.clientId) return send(res, 200, { configured: false,
      message: 'Google sign-in is not configured yet. Add a Google OAuth client id/secret in server.js, then restart.' });
    const p = new URLSearchParams({ client_id: GOOGLE.clientId, redirect_uri: GOOGLE.redirect,
      response_type: 'code', scope: 'openid email profile', access_type: 'online', prompt: 'select_account' });
    return send(res, 200, { configured: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` });
  }

  // ---- GET /auth/google/callback ----
  if (url === '/auth/google/callback') {
    try {
      const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('code');
      if (!code || !GOOGLE.clientId) throw new Error('missing code or config');
      const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret,
          redirect_uri: GOOGLE.redirect, grant_type: 'authorization_code' }) })).json();
      const info = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
      const email = String(info.email || '').toLowerCase();
      const db = loadUsers();
      let workspaces;
      if (MASTER.has(email)) workspaces = accessibleWorkspaces(db, email);
      else workspaces = db.users
        .filter(u => u.email === email && u.active && u.google !== false && domainOk(db.workspaces[u.company_id], email))
        .map(u => ({ slug: u.company_id, display_name: db.workspaces[u.company_id].display_name }));
      if (!workspaces.length) { res.writeHead(302, { Location: '/?error=not_authorized' }); return res.end(); }
      const disp = (db.users.find(u => u.email === email) || {}).display_name || email.split('@')[0];
      const sess = { email, display_name: disp, role: MASTER.has(email) ? 'master' : null, company_id: null, master: MASTER.has(email) };
      const t = newToken(); SESSIONS.set(t, sess);
      res.writeHead(302, { 'Set-Cookie': `th_session=${t}; Path=/; HttpOnly; SameSite=Lax`, Location: '/' });
      return res.end();
    } catch (e) { res.writeHead(302, { Location: '/?error=google_failed' }); return res.end(); }
  }

  // ---- /api/users (OWNER-ONLY: manage who can log in, incl. Google) ----
  if (url === '/api/users') {
    const owner = requireOwner(req);
    if (!owner) return send(res, 403, { error: 'owner_only' });
    const db = loadUsers(); const ws = owner.company_id;

    if (req.method === 'GET') {
      const users = db.users.filter(u => u.company_id === ws)
        .map(u => ({ email: u.email, display_name: u.display_name, role: u.role, active: u.active, google: u.google !== false }));
      return send(res, 200, { ok: true, workspace: ws, allowed_domains: db.workspaces[ws].allowed_domains || [], users });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!email.includes('@')) return send(res, 400, { error: 'valid_email_required' });
      if (db.users.find(u => u.company_id === ws && u.email === email)) return send(res, 409, { error: 'user_exists' });
      const nu = makeUser(ws, email, b.password || 'changeme', b.role || 'pm', b.display_name || email.split('@')[0], b.google !== false);
      db.users.push(nu); saveUsers(db);
      return send(res, 200, { ok: true, user: { email: nu.email, display_name: nu.display_name, role: nu.role, active: nu.active, google: nu.google } });
    }
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const u = db.users.find(x => x.company_id === ws && x.email === email);
      if (!u) return send(res, 404, { error: 'not_found' });
      if (typeof b.google === 'boolean') u.google = b.google;
      if (typeof b.active === 'boolean') u.active = b.active;
      if (b.role) u.role = String(b.role);
      if (b.display_name) u.display_name = String(b.display_name);
      saveUsers(db);
      return send(res, 200, { ok: true, user: { email: u.email, display_name: u.display_name, role: u.role, active: u.active, google: u.google !== false } });
    }
    if (req.method === 'DELETE') {
      const email = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('email');
      const before = db.users.length;
      db.users = db.users.filter(u => !(u.company_id === ws && u.email === String(email || '').toLowerCase()));
      saveUsers(db);
      return send(res, 200, { ok: true, removed: before - db.users.length });
    }
  }

  // ---- PATCH /api/workspace (OWNER-ONLY: allowed Google domains) ----
  if (url === '/api/workspace' && req.method === 'PATCH') {
    const owner = requireOwner(req); if (!owner) return send(res, 403, { error: 'owner_only' });
    const b = await readBody(req); const db = loadUsers();
    if (Array.isArray(b.allowed_domains))
      db.workspaces[owner.company_id].allowed_domains = b.allowed_domains.map(d => String(d).trim().toLowerCase()).filter(Boolean);
    saveUsers(db);
    return send(res, 200, { ok: true, allowed_domains: db.workspaces[owner.company_id].allowed_domains });
  }

  // ---- /api/homes (any signed-in user) ----
  if (url === '/api/homes') {
    const u = sessionUser(req); if (!u) return send(res, 401, { error: 'not_signed_in' });
    if (!u.company_id) return send(res, 409, { error: 'no_workspace_selected' });
    if (req.method === 'GET') return send(res, 200, { ok: true, homes: loadHomes().filter(h => (h.company_id || 'linkgrid-homes') === u.company_id) });
    if (req.method === 'POST') {
      const b = await readBody(req); const homes = loadHomes(); const id = nextHomeId(homes);
      const home = {
        id, company_id: u.company_id, name: b.name || 'New Home', address: b.address || '', lot: b.lot || '',
        stage: b.stage || 'Acquisition', sqft: num(b.sqft), beds: num(b.beds), baths: num(b.baths),
        start: b.start || '', targetList: b.targetList || '',
        land: num(b.land), landClosing: num(b.landClosing),
        soft: { 'Architecture & Design': num(b.softDesign), 'Permits & Fees': num(b.softPermits),
          'Engineering': num(b.softEng), 'Financing / Carry': num(b.softCarry) },
        budget: defaultBudget(), subs: [], materials: [], inspections: [],
        design: { architect: '', designer: '', plansStatus: 'Not started', selectionsStatus: 'Open' },
        plans: [], selections: [], schedule: [], changeOrders: [],
        financing: { lender: '', loanAmount: 0, rate: 0 }, draws: [], closeout: [],
        listing: { listPrice: num(b.listPrice), listDate: null, status: 'Not listed', salePrice: null, closeDate: null, agent: b.agent || 'TBD' }
      };
      if (num(b.hardEstimate) > 0) home.budget.push({ div: 'Hard cost (estimate)', budget: num(b.hardEstimate), committed: 0, actual: 0 });
      homes.push(home); saveHomes(homes); return send(res, 200, { ok: true, home });
    }
  }

  const findHome = (homes, id) => homes.find(h => h.id === id);
  if (url === '/api/homes/sub' && req.method === 'POST') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    h.subs.push({ trade: b.trade || '', co: b.co || '—', value: num(b.value), status: b.status || 'Bidding' });
    saveHomes(homes); return send(res, 200, { ok: true });
  }
  if (url === '/api/homes/po' && req.method === 'POST') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    h.materials.push({ po: b.po || ('PO-' + Date.now().toString().slice(-4)), vendor: b.vendor || '', item: b.item || '', amount: num(b.amount), status: b.status || 'Ordered' });
    saveHomes(homes); return send(res, 200, { ok: true });
  }
  if (url === '/api/homes/inspection' && req.method === 'POST') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    h.inspections.push({ type: b.type || '', date: b.date || null, status: b.status || 'Pending' });
    saveHomes(homes); return send(res, 200, { ok: true });
  }
  if (url === '/api/homes/listing' && req.method === 'PATCH') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    h.listing = h.listing || {}; const l = h.listing;
    const numKeys = ['listPrice','currentListPrice','acceptedOfferPrice','salePrice','commissionPercent','sellerConcessions','closingCosts','transferTaxes','otherSaleCosts','loanPayoff','daysOnMarket'];
    const strKeys = ['status','agent','listDate','closeDate'];
    for (const k of numKeys) if (b[k] !== undefined && b[k] !== '') l[k] = num(b[k]);
    for (const k of strKeys) if (b[k] !== undefined) l[k] = b[k] || null;
    if (b.stage) h.stage = b.stage;
    saveHomes(homes); return send(res, 200, { ok: true });
  }
  if (url === '/api/homes/budget' && req.method === 'PATCH') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    const row = h.budget.find(x => x.div === b.div); if (!row) return send(res, 404, { error: 'div_not_found' });
    if (b.budget !== undefined) row.budget = num(b.budget);
    if (b.committed !== undefined) row.committed = num(b.committed);
    if (b.actual !== undefined) row.actual = num(b.actual);
    saveHomes(homes); return send(res, 200, { ok: true });
  }
  if (url === '/api/homes/stage' && req.method === 'PATCH') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    if (b.stage) h.stage = b.stage; saveHomes(homes); return send(res, 200, { ok: true });
  }

  // ---- module adds: selection / change order / milestone / draw / closeout ----
  async function addToHome(field, build) {
    const u = wsUser(req); if (!u) { send(res, 401, { error: 'not_signed_in' }); return; }
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(u, h)) { send(res, 404, { error: 'home_not_found' }); return; }
    if (!Array.isArray(h[field])) h[field] = [];
    h[field].push(build(b)); saveHomes(homes); send(res, 200, { ok: true });
  }
  if (url === '/api/homes/selection' && req.method === 'POST')
    return addToHome('selections', b => ({ category: b.category || '', item: b.item || '', allowance: num(b.allowance), actual: num(b.actual), status: b.status || 'Open' }));
  if (url === '/api/homes/changeorder' && req.method === 'POST')
    return addToHome('changeOrders', b => ({ co: b.co || ('CO-' + Date.now().toString().slice(-3)), description: b.description || '', amount: num(b.amount), status: b.status || 'Pending', date: b.date || null }));
  if (url === '/api/homes/milestone' && req.method === 'POST')
    return addToHome('schedule', b => ({ name: b.name || '', start: b.start || null, end: b.end || null, status: b.status || 'Not started' }));
  if (url === '/api/homes/draw' && req.method === 'POST')
    return addToHome('draws', b => ({ num: b.num || '', amount: num(b.amount), date: b.date || null, status: b.status || 'Requested' }));
  if (url === '/api/homes/closeout' && req.method === 'POST')
    return addToHome('closeout', b => ({ item: b.item || '', status: b.status || 'Pending', date: b.date || null }));

  // ---- module edits: design meta, financing meta ----
  if (url === '/api/homes/design' && req.method === 'PATCH') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    h.design = h.design || {};
    ['architect', 'designer', 'plansStatus', 'selectionsStatus'].forEach(k => { if (b[k] !== undefined) h.design[k] = b[k]; });
    if (b.stage) h.stage = b.stage;
    saveHomes(homes); return send(res, 200, { ok: true });
  }
  if (url === '/api/homes/financing' && req.method === 'PATCH') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    h.financing = h.financing || {};
    if (b.lender !== undefined) h.financing.lender = b.lender;
    if (b.loanAmount !== undefined) h.financing.loanAmount = num(b.loanAmount);
    if (b.rate !== undefined) h.financing.rate = num(b.rate);
    saveHomes(homes); return send(res, 200, { ok: true });
  }

  // ---- POST /api/homes/plan-upload?id=..&name=..  (raw binary body) ----
  if (url === '/api/homes/plan-upload' && req.method === 'POST') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const id = q.get('id'); const name = (q.get('name') || 'plan.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
    const homes = loadHomes(); const h = findHome(homes, id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const dir = path.join(PUBLIC, 'uploads', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      if (!Array.isArray(h.plans)) h.plans = [];
      h.plans.push({ name, size: buf.length, uploadedAt: new Date().toISOString().slice(0, 10), url: `/uploads/${id}/${name}` });
      if (h.design) h.design.plansStatus = 'Plans on file';
      saveHomes(homes); send(res, 200, { ok: true, plan: h.plans[h.plans.length - 1] });
    });
    return;
  }

  // ---- POST /api/homes/ai-schedule  (generate a construction schedule) ----
  if (url === '/api/homes/ai-schedule' && req.method === 'POST') {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const b = await readBody(req); const homes = loadHomes(); const h = findHome(homes, b.id);
    if (!h || !ownsHome(_u, h)) return send(res, 404, { error: 'home_not_found' });
    const g = await aiGenerateSchedule(h); h.schedule = g.schedule; saveHomes(homes);
    return send(res, 200, { ok: true, schedule: h.schedule, source: g.source });
  }
  if (url === '/api/ai-status')
    return send(res, 200, { ok: true, configured: !!AI.apiKey, model: AI.apiKey ? AI.model : null });

  // ---- edit/delete any array row (subs, materials, inspections, selections,
  //      changeOrders, schedule, draws, closeout) ----
  if (url === '/api/homes/item' && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const _u = wsUser(req); if (!_u) return send(res, 401, { error: 'not_signed_in' });
    const ITEM_FIELDS = new Set(['subs', 'materials', 'inspections', 'selections', 'changeOrders', 'schedule', 'draws', 'closeout']);
    let field, id, index, patch;
    if (req.method === 'PATCH') { const b = await readBody(req); field = b.field; id = b.id; index = b.index; patch = b.patch || {}; }
    else { const q = new URL(req.url, `http://localhost:${PORT}`).searchParams; field = q.get('field'); id = q.get('id'); index = parseInt(q.get('index'), 10); }
    if (!ITEM_FIELDS.has(field)) return send(res, 400, { error: 'bad_field' });
    const homes = loadHomes(); const h = findHome(homes, id);
    if (!h || !ownsHome(_u, h) || !Array.isArray(h[field]) || !h[field][index]) return send(res, 404, { error: 'not_found' });
    if (req.method === 'DELETE') { h[field].splice(index, 1); }
    else {
      const row = h[field][index];
      for (const k of Object.keys(patch))
        row[k] = ['value', 'amount', 'allowance', 'actual'].includes(k) ? num(patch[k]) : patch[k];
    }
    saveHomes(homes); return send(res, 200, { ok: true });
  }

  // ---- POST /api/feedback (comment -> store + optional email) ----
  if (url === '/api/feedback' && req.method === 'POST') {
    const b = await readBody(req);
    const msg = String(b.message || '').slice(0, 5000).trim();
    if (!msg) return send(res, 400, { error: 'empty' });
    const entry = { message: msg, page: String(b.page || ''), user: String(b.user || 'anon'), at: new Date().toISOString() };
    try {
      const FB = path.join(DATA_DIR, 'feedback.json');
      const arr = fs.existsSync(FB) ? JSON.parse(fs.readFileSync(FB, 'utf8')) : [];
      arr.push(entry); fs.writeFileSync(FB, JSON.stringify(arr, null, 2));
    } catch (e) {}
    if (process.env.RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: process.env.FEEDBACK_FROM || 'LinkGrid Homes <onboarding@resend.dev>',
            to: ['alex.toler@tolercorp.com'],
            subject: `LinkGrid comment from ${entry.user}`,
            text: `${entry.message}\n\n— Page: ${entry.page}\n— From: ${entry.user}\n— At: ${entry.at}`,
          }),
        });
      } catch (e) {}
    }
    return send(res, 200, { ok: true });
  }

  // ---- static ----
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 404, { error: 'not_found' });
});

loadUsers(); loadHomes();
server.listen(PORT, () => {
  console.log(`\n  LinkGrid Homes dev server running`);
  console.log(`  ->  http://localhost:${PORT}\n`);
  console.log(`  Login: alex.toler@tolercorp.com (master) or momentumautowerke@gmail.com (client)  /  demo`);
  console.log(`  Google sign-in: ${GOOGLE.clientId ? 'configured' : 'not configured (password login works now)'}\n`);
});
// build: editable-v1

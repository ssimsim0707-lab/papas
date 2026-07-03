// ============================================================================
// Papa's Almanac — account sync + Web Push backend
//   • Accounts (sign up / log in) so his planner is saved and viewable on any
//     device, kept in sync.  • Real push reminders even when the app is closed.
//   • Storage = libSQL: a local file in dev, free Turso (persistent) in prod.
// Run locally:  node server.mjs
// In prod set:  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, PORT, CONTACT
// ============================================================================
import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createClient } from '@libsql/client';
import webpush from 'web-push';

const PORT = process.env.PORT || 4400;
const CONTACT = process.env.CONTACT || 'mailto:winningedgedefence@gmail.com';
const DAY = 86400000;

/* ---------- database (local file OR Turso) ---------- */
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:almanac.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});
const one  = async (sql, args=[]) => (await db.execute(args.length ? { sql, args } : sql)).rows[0] || null;
const many = async (sql, args=[]) => (await db.execute(args.length ? { sql, args } : sql)).rows;
const run  = async (sql, args=[]) => db.execute(args.length ? { sql, args } : sql);

await db.executeMultiple(`
  CREATE TABLE IF NOT EXISTS kv       (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS users    (id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT, hash TEXT, created INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, created INTEGER);
  CREATE TABLE IF NOT EXISTS states   (user_id TEXT PRIMARY KEY, json TEXT, updated INTEGER);
  CREATE TABLE IF NOT EXISTS subs     (endpoint TEXT PRIMARY KEY, user_id TEXT, data TEXT, added INTEGER);
  CREATE TABLE IF NOT EXISTS pushed   (id TEXT PRIMARY KEY, ts INTEGER);
  CREATE TABLE IF NOT EXISTS memberships (email TEXT, owner_id TEXT, person_id TEXT, role TEXT, PRIMARY KEY(email, owner_id));
`);
const kvGet = async (k, d=null) => { const r = await one('SELECT v FROM kv WHERE k=?', [k]); return r ? r.v : d; };
const kvSet = (k, v) => run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, v]);

/* ---------- VAPID keys (generated once) ---------- */
let vapidPub = await kvGet('vapidPublic'), vapidPriv = await kvGet('vapidPrivate');
if (!vapidPub || !vapidPriv) {
  const keys = webpush.generateVAPIDKeys();
  vapidPub = keys.publicKey; vapidPriv = keys.privateKey;
  await kvSet('vapidPublic', vapidPub); await kvSet('vapidPrivate', vapidPriv);
  console.log('🔑 Generated VAPID keys.');
}
webpush.setVapidDetails(CONTACT, vapidPub, vapidPriv);

/* ---------- auth ---------- */
const uid = () => randomBytes(9).toString('hex');
const hashPw = (pw) => { const salt = randomBytes(16).toString('hex'); return { salt, hash: scryptSync(pw, salt, 64).toString('hex') }; };
const verifyPw = (pw, salt, hash) => { const h = scryptSync(pw, salt, 64), s = Buffer.from(hash, 'hex'); return h.length === s.length && timingSafeEqual(h, s); };
async function newSession(userId){ const token = randomBytes(24).toString('hex'); await run('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)', [token, userId, Date.now()]); return token; }
function tokenOf(req){ const a = req.headers['authorization'] || ''; return a.startsWith('Bearer ') ? a.slice(7) : (req.headers['x-token'] || ''); }
async function userFromReq(req){
  const token = tokenOf(req); if (!token) return null;
  const s = await one('SELECT user_id FROM sessions WHERE token=?', [token]); if (!s) return null;
  return await one('SELECT id,email FROM users WHERE id=?', [s.user_id]);
}

/* ---------- per-user state ---------- */
async function getState(userId){ const r = await one('SELECT json,updated FROM states WHERE user_id=?', [userId]); return r ? { state: JSON.parse(r.json), updatedAt: Number(r.updated) } : { state: null, updatedAt: 0 }; }
async function setState(userId, state){ const now = Date.now(); await run('INSERT INTO states(user_id,json,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated=excluded.updated', [userId, JSON.stringify(state), now]); return now; }

/* ---------- team CRM: memberships ---------- */
// A "person" in the admin's People list that has an email becomes a member who can log in.
async function syncMemberships(ownerId, state){
  await run('DELETE FROM memberships WHERE owner_id=?', [ownerId]);
  for (const p of (state.people || [])) {
    const em = String(p.email || '').trim().toLowerCase();
    if (em) await run('INSERT OR REPLACE INTO memberships(email,owner_id,person_id,role) VALUES(?,?,?,?)', [em, ownerId, p.id, 'member']);
  }
}
async function membershipFor(email){ return await one('SELECT owner_id,person_id,role FROM memberships WHERE email=? LIMIT 1', [String(email||'').toLowerCase()]); }
async function pushToPerson(ownerId, personId, title, body, tag){
  const m = await one('SELECT email FROM memberships WHERE owner_id=? AND person_id=?', [ownerId, personId]);
  if (!m) return;
  const u = await one('SELECT id FROM users WHERE email=?', [m.email]);
  if (u) await pushUser(u.id, title, body, tag);
}

/* ---------- push ---------- */
async function subsForUser(userId){ return (await many('SELECT endpoint,data FROM subs WHERE user_id=?', [userId])).map(r => ({ endpoint: r.endpoint, ...JSON.parse(r.data) })); }
const saveSub = (userId, sub) => run('INSERT INTO subs(endpoint,user_id,data,added) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, data=excluded.data', [sub.endpoint, userId, JSON.stringify(sub), Date.now()]);
const dropSub = (endpoint) => run('DELETE FROM subs WHERE endpoint=?', [endpoint]);
const wasPushed = async (id) => !!(await one('SELECT 1 AS x FROM pushed WHERE id=?', [id]));
const markPushed = (id) => run('INSERT OR REPLACE INTO pushed(id,ts) VALUES(?,?)', [id, Date.now()]);
async function pushUser(userId, title, body, tag){
  const subs = await subsForUser(userId); if (!subs.length) return;
  const payload = JSON.stringify({ title, body, tag });
  await Promise.all(subs.map(async (s) => { try { await webpush.sendNotification(s, payload); } catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await dropSub(s.endpoint); } }));
}

/* ---------- reminder scheduler (per user) ---------- */
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function relDay(d){ const t=new Date(); t.setHours(0,0,0,0); const x=new Date(d); x.setHours(0,0,0,0); const diff=Math.round((x-t)/DAY); if(diff===0)return'today'; if(diff===1)return'tomorrow'; if(diff===-1)return'yesterday'; return d.toLocaleDateString([], {weekday:'long', day:'numeric', month:'short'}); }
const dayKey = (d) => { const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
const clampDom = (y,m,dom) => Math.min(dom, new Date(y,m+1,0).getDate());
function recurOccursOn(r,d){
  switch(r.freq){
    case 'daily': return true;
    case 'weekly': return d.getDay()===Number(r.weekday);
    case 'monthly': return d.getDate()===clampDom(d.getFullYear(),d.getMonth(),Number(r.dom));
    case 'yearly': return d.getMonth()===Number(r.month) && d.getDate()===clampDom(d.getFullYear(),Number(r.month),Number(r.day));
  } return false;
}
async function checkUser(userId, state){
  if (!state) return;
  const name = (state.profile && state.profile.name) || 'Papa';
  const now = Date.now();
  for (const t of (state.tasks || [])) {
    if (t.done || !t.due) continue;
    const due = new Date(t.due), dueMs = due.getTime();
    if (t.headsUp !== false) { const id = `${userId}:${t.id}:b24`; if (now >= dueMs - DAY && now < dueMs && !(await wasPushed(id))) { await pushUser(userId, `📅 Heads up, ${name}!`, `"${t.title}" is due ${relDay(due)} at ${fmtTime(due)}.`, 'b'+t.id); for (const pid of (t.peopleIds||[])) await pushToPerson(userId, pid, '📅 Task tomorrow', `"${t.title}" is due ${relDay(due)} at ${fmtTime(due)}.`, 'mb'+t.id); await markPushed(id); } }
    const id = `${userId}:${t.id}:due`; const fireAt = dueMs - (t.lead || 0) * 60000;
    if (now >= fireAt && !(await wasPushed(id))) { await pushUser(userId, '🎯 Mission time!', `"${t.title}" is due (${fmtTime(due)}).`, 'd'+t.id); for (const pid of (t.peopleIds||[])) await pushToPerson(userId, pid, '🎯 Task due', `"${t.title}" is due now (${fmtTime(due)}).`, 'md'+t.id); await markPushed(id); }
  }
  const today = new Date(), tk = dayKey(today), tomo = new Date(now + DAY), tmk = dayKey(tomo);
  for (const r of (state.recurring || [])) {
    const [H,M] = (r.time || '09:00').split(':').map(Number);
    if (recurOccursOn(r, today)) { const at = new Date(); at.setHours(H||9, M||0, 0, 0); const id = `${userId}:${r.id}:${tk}`;
      if (now >= at.getTime() && !(await wasPushed(id))) { const age = (r.kind==='birthday'&&r.birthYear)?` (turns ${today.getFullYear()-Number(r.birthYear)})`:''; await pushUser(userId, r.kind==='birthday'?'🎂 Birthday today!':'🔁 Recurring reminder', `${r.title}${r.kind==='birthday'?' is today':''}${age}.`, 'r'+r.id); await markPushed(id); } }
    if (r.kind==='birthday' && recurOccursOn(r, tomo)) { const id = `${userId}:${r.id}:pre:${tmk}`; if (!(await wasPushed(id))) { await pushUser(userId, '🎂 Birthday tomorrow', `${r.title} is tomorrow — don't forget!`, 'rp'+r.id); await markPushed(id); } }
  }
}
async function checkAll(){ for (const row of await many('SELECT user_id,json FROM states')) { try { await checkUser(row.user_id, JSON.parse(row.json)); } catch {} } }

/* ---------- HTTP ---------- */
function cors(res){ res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Token'); }
const json = (res, code, obj) => { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b=''; req.on('data', c=>b+=c); req.on('end', ()=>{ try{ resolve(b?JSON.parse(b):{}); }catch{ resolve({}); } }); });
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204).end(); return; }
    if (url === '/' || url === '/api/health') { const c = await one('SELECT COUNT(*) AS c FROM users'); return json(res, 200, { ok: true, app: "Papa's Almanac", users: Number(c.c) }); }
    if (url === '/api/vapid') return json(res, 200, { publicKey: vapidPub });
    if (url === '/api/tick') { await checkAll(); return json(res, 200, { ok: true }); }

    if (url === '/api/signup' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const em = String(email||'').trim().toLowerCase();
      if (!validEmail(em)) return json(res, 400, { error: 'Please enter a valid email.' });
      if (String(password||'').length < 6) return json(res, 400, { error: 'Password must be at least 6 characters.' });
      if (await one('SELECT 1 AS x FROM users WHERE email=?', [em])) return json(res, 409, { error: 'That email already has an account — try logging in.' });
      const id = uid(); const { salt, hash } = hashPw(password);
      await run('INSERT INTO users(id,email,salt,hash,created) VALUES(?,?,?,?,?)', [id, em, salt, hash, Date.now()]);
      return json(res, 200, { token: await newSession(id), email: em });
    }
    if (url === '/api/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const em = String(email||'').trim().toLowerCase();
      const u = await one('SELECT id,salt,hash FROM users WHERE email=?', [em]);
      if (!u || !verifyPw(String(password||''), u.salt, u.hash)) return json(res, 401, { error: 'Wrong email or password.' });
      return json(res, 200, { token: await newSession(u.id), email: em });
    }
    if (url === '/api/logout' && req.method === 'POST') { const tok = tokenOf(req); if (tok) await run('DELETE FROM sessions WHERE token=?', [tok]); return json(res, 200, { ok: true }); }

    const user = await userFromReq(req);
    if (!user) return json(res, 401, { error: 'Please log in.' });

    if (url === '/api/me') {
      const m = await membershipFor(user.email);
      if (m) { const st = await getState(m.owner_id); return json(res, 200, { email:user.email, role:'member', personId:m.person_id, ownerId:m.owner_id, adminName:(st.state && st.state.profile && st.state.profile.name) || 'the team' }); }
      return json(res, 200, { email: user.email, role: 'admin' });
    }
    if (url === '/api/state' && req.method === 'GET') { const { state, updatedAt } = await getState(user.id); return json(res, 200, { state, updatedAt }); }
    if (url === '/api/state' && req.method === 'PUT') { const body = await readBody(req); if (!body.state) return json(res, 400, { error: 'no state' }); const updatedAt = await setState(user.id, body.state); await syncMemberships(user.id, body.state); checkUser(user.id, body.state); return json(res, 200, { ok: true, updatedAt }); }
    if (url === '/api/subscribe' && req.method === 'POST') { const body = await readBody(req); if (body.subscription && body.subscription.endpoint) { await saveSub(user.id, body.subscription); return json(res, 200, { ok: true }); } return json(res, 400, { error: 'no subscription' }); }

    // ----- team member endpoints -----
    if (url === '/api/member' && req.method === 'GET') {
      const m = await membershipFor(user.email); if (!m) return json(res, 403, { error: 'You are not on a team yet.' });
      const { state } = await getState(m.owner_id);
      if (!state) return json(res, 200, { adminName:'the team', tasks:[], categories:[] });
      const categories = (state.categories||[]).map(c => ({ id:c.id, name:c.name, emoji:c.emoji, color:c.color }));
      const tasks = (state.tasks||[]).filter(t => (t.peopleIds||[]).includes(m.person_id));
      return json(res, 200, { adminName:(state.profile&&state.profile.name)||'the team', tasks, categories });
    }
    if (url === '/api/member/task' && req.method === 'POST') {
      const m = await membershipFor(user.email); if (!m) return json(res, 403, { error: 'not a member' });
      const body = await readBody(req);
      const { state } = await getState(m.owner_id); if (!state) return json(res, 404, { error:'no workspace' });
      const t = (state.tasks||[]).find(x => x.id===body.taskId && (x.peopleIds||[]).includes(m.person_id));
      if (!t) return json(res, 404, { error:'task not found' });
      if (typeof body.progress === 'number') { t.progress = Math.max(0, Math.min(100, body.progress)); t.done = t.progress>=100; }
      if (typeof body.done === 'boolean') { t.done = body.done; t.progress = body.done?100:(t.progress||0); }
      t.doneAt = t.done ? Date.now() : null;
      await setState(m.owner_id, state);
      return json(res, 200, { ok:true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); json(res, 500, { error: 'server error' }); }
}).listen(PORT, () => console.log(`\n  🫡  Papa's Almanac server on http://localhost:${PORT}\n`));

setInterval(() => { checkAll().catch(()=>{}); }, 60000);
checkAll().catch(()=>{});

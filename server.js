/**
 * Big Three backend — Railway, Node/Express.
 * Same shape as your other three apps.
 *
 * Environment variables to set in Railway:
 *   ML_TOKEN        MailerLite API token
 *   ML_GROUP_ALL    group id: everyone who signed up
 *   ML_GROUP_NEWS   group id: people who also want your news
 *   ML_GROUP_MATCH  group id: fires the "you have a match" automation
 *   ML_MOON_GROUPS  the 12 moon group ids, comma separated, Aries first
 *   ALLOWED_ORIGIN  where the page lives, e.g. https://bigthree.pages.dev
 */

import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json({limit: '16kb'}));
app.use(cors({
  origin: (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()),
  methods: ['POST', 'GET']
}));

const API = 'https://connect.mailerlite.com/api';
const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
               'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];

// ---------- matching, same rules as the page ----------
function aspect(diff){
  const d = ((diff % 12) + 12) % 12, dd = Math.min(d, 12 - d);
  if(dd === 0) return 5;   // conjunction
  if(dd === 4) return 4;   // trine, same element
  if(dd === 2) return 3;   // sextile, friendly elements
  if(dd === 6) return 2;   // opposition
  if(dd === 3) return 0;   // square
  return 1;
}
const PAIRS = [['moon','moon',3],['sun','moon',3],['moon','sun',3],
               ['rise','moon',2],['moon','rise',2],['sun','sun',2],
               ['sun','rise',1],['rise','sun',1],['rise','rise',1]];

function score(a, b){
  const withRise = a.rise !== null && b.rise !== null;
  let raw = 0, weight = 0;
  for(const [pa, pb, w] of PAIRS){
    if(!withRise && (pa === 'rise' || pb === 'rise')) continue;
    raw += w * aspect(a[pa] - b[pb]);
    weight += w;
  }
  return Math.round(raw / (weight * 5) * 100);
}

// The best score a person can reach depends on their own chart: some top out
// near 100, others near 50. A fixed threshold would leave the low ones never
// matching, so everyone is measured against their own ceiling.
function ceiling(p){
  let best = 0;
  const withRise = p.rise !== null;
  for(let s = 0; s < 12; s++) for(let m = 0; m < 12; m++){
    if(withRise){ for(let r = 0; r < 12; r++) best = Math.max(best, score(p, {sun:s, moon:m, rise:r})); }
    else best = Math.max(best, score(p, {sun:s, moon:m, rise:null}));
  }
  return best;
}

// Moon carries three times the weight of anything else, so a strong match
// almost always has a Moon that sits well against theirs. Reading only those
// groups keeps us clear of MailerLite's own rate limit as the list grows.
function candidateMoons(moon){
  const out = [];
  for(let m = 0; m < 12; m++) if(aspect(moon - m) >= 3) out.push(m);
  return out;
}

// ---------- MailerLite ----------
async function ml(path, options = {}){
  const r = await fetch(API + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${process.env.ML_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {})
    }
  });
  if(!r.ok && r.status !== 404) throw new Error(`MailerLite ${path} ${r.status}`);
  if(r.status === 404 || r.status === 204) return null;
  return r.json();
}

async function groupMembers(groupId){
  const out = [];
  for(let page = 1; page <= 50; page++){
    const res = await ml(`/groups/${groupId}/subscribers?limit=1000&page=${page}`);
    const rows = res?.data || [];
    out.push(...rows);
    if(rows.length < 1000) break;
  }
  return out;
}

const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

function toProfile(row){
  const f = row.fields || {};
  if(f.sun === null || f.sun === undefined || f.sun === '') return null;
  return {
    id: row.id,
    email: row.email,
    name: f.name || 'Someone',
    sun: Number(f.sun), moon: Number(f.moon), rise: num(f.rise),
    shareEmail: String(f.share_email) === '1'
  };
}

const signsOf = p => p.rise === null
  ? `${SIGNS[p.sun]} · ${SIGNS[p.moon]}`
  : `${SIGNS[p.sun]} · ${SIGNS[p.moon]} · ${SIGNS[p.rise]}`;

// Write the match onto the subscriber, then drop them into the group that
// fires the automation. Removing first lets it fire again next time.
async function notify(person, other, points){
  await ml('/subscribers', {
    method: 'POST',
    body: JSON.stringify({
      email: person.email,
      fields: {
        match_name: other.name,
        match_signs: signsOf(other),
        match_score: String(points),
        // only revealed when both sides ticked the box
        match_email: (person.shareEmail && other.shareEmail) ? other.email : ''
      }
    })
  });
  try { await ml(`/subscribers/${person.id}/groups/${process.env.ML_GROUP_MATCH}`, {method:'DELETE'}); }
  catch { /* they were not in it, fine */ }
  await ml(`/subscribers/${person.id}/groups/${process.env.ML_GROUP_MATCH}`, {method:'POST'});
}

// Look through everyone who confirmed their address and return the best
// match, or null if nobody clears the bar for both sides.
async function findMatch(me){
  const moonGroups = String(process.env.ML_MOON_GROUPS || '').split(',').map(s => s.trim());
  const myCeiling = ceiling(me);
  const seen = new Set([me.email]);

  let best = null, bestPoints = 0;
  for(const m of candidateMoons(me.moon)){
    const gid = moonGroups[m];
    if(!gid) continue;
    for(const row of await groupMembers(gid)){
      if(row.status !== 'active') continue;      // skip unconfirmed and unsubscribed
      if(seen.has(row.email)) continue;
      seen.add(row.email);
      const other = toProfile(row);
      if(!other) continue;

      const points = score(me, other);
      if(points <= bestPoints) continue;
      if(points < 0.85 * myCeiling) continue;
      if(points < 0.85 * ceiling(other)) continue;
      best = other; bestPoints = points;
    }
  }
  return best ? {other: best, points: bestPoints} : null;
}

// ---------- routes ----------
app.get('/health', (_req, res) => res.json({ok: true}));

app.post('/api/signup', async (req, res) => {
  const b = req.body || {};
  const name  = String(b.name || '').trim().slice(0, 40);
  const email = String(b.email || '').trim().toLowerCase();
  const sun = num(b.sun), moon = num(b.moon), rise = num(b.rise);

  const valid = n => n !== null && Number.isInteger(n) && n >= 0 && n < 12;
  if(name.length < 2) return res.status(400).json({error: 'Name too short'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({error: 'Bad email'});
  if(!valid(sun) || !valid(moon)) return res.status(400).json({error: 'Bad signs'});
  if(rise !== null && !valid(rise)) return res.status(400).json({error: 'Bad rising'});

  const moonGroups = String(process.env.ML_MOON_GROUPS || '').split(',').map(s => s.trim());
  const groups = [process.env.ML_GROUP_ALL, moonGroups[moon]].filter(Boolean);
  if(b.news) groups.push(process.env.ML_GROUP_NEWS);

  const me = {email, name, sun, moon, rise, shareEmail: !!b.shareEmail};

  try {
    // MailerLite sends its own confirmation email when the group has double
    // opt-in on, and holds them as unconfirmed until they click.
    const saved = await ml('/subscribers', {
      method: 'POST',
      body: JSON.stringify({
        email,
        fields: {
          name,
          sun: String(sun),
          moon: String(moon),
          rise: rise === null ? '' : String(rise),
          share_email: b.shareEmail ? '1' : '0',
          signed_up_at: new Date().toISOString().slice(0, 10)
        },
        groups
      })
    });
    me.id = saved?.data?.id;

    const hit = await findMatch(me);
    if(hit && me.id){
      await notify(me, hit.other, hit.points);
      await notify(hit.other, me, hit.points);
    }

    res.json({ok: true, matched: !!hit});
  } catch (err) {
    console.error('signup failed:', err.message);
    res.status(502).json({error: 'Could not save right now'});
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`big three backend on ${port}`));

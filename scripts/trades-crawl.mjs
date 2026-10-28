// Finds dynasty trades in leagues like ours and records each player's implied value
// (what was paid for them, priced with that day's FantasyCalc snapshot) into fc/players/<id>.json.
//
// Leagues are discovered by snowballing out from our league's managers via Sleeper's public API.
// League IDs and seen-trade IDs live in .crawl-state (kept in the Actions cache, never committed),
// so the public repo only holds: player id, date, implied value.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const LEAGUE_ID = "1311997710454226944";
const API = "https://api.sleeper.app/v1";
const STATE = ".crawl-state";
const OUT = "fc";
const MAX_HOPS = 2;            // our managers -> their leagues -> those managers -> their leagues
const MAX_USERS = 4000;
const MAX_LEAGUES = 2500;
const REDISCOVER_DAYS = 7;     // league discovery runs weekly; trade checks run nightly
const TEAMS_MIN = 10, TEAMS_MAX = 12;
const REQ_PER_SEC = 12;        // ~720 calls/min, under Sleeper's 1,000/min guidance
const SNAP_WINDOW = 3;         // days either side of a trade to accept a snapshot
const MIN_PLAYER_VALUE = 500;  // only record dots for players with real market value
const RATIO_MIN = 0.25, RATIO_MAX = 3;  // drop implied values wildly off market (collusion, typos)
const KEEP_DAYS = 400;

/* ---------- throttled fetch ---------- */
let nextSlot = 0, calls = 0;
async function get(url, tries = 4) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1000 / REQ_PER_SEC;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  calls++;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "2-minute-drill-crawler" } });
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) throw new Error(String(r.status));
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    if (tries <= 1) return null;
    await new Promise((r) => setTimeout(r, (5 - tries) * 2000));
    return get(url, tries - 1);
  }
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

/* ---------- league format ---------- */
const numQbs = (lg) => { const rp = lg.roster_positions || []; return rp.includes("SUPER_FLEX") || rp.filter((p) => p === "QB").length >= 2 ? 2 : 1; };
const pprOf = (lg) => { const rec = lg.scoring_settings?.rec; const v = typeof rec === "number" ? rec : 1; return v >= 1 ? 1 : v > 0 ? 0.5 : 0; };

/* ---------- FantasyCalc snapshots ---------- */
function normPicks(raw) {
  const gen = {}, spec = {};
  for (const [name, e] of Object.entries(raw || {})) {
    const ys = name.match(/(20\d{2})/); if (!ys) continue;
    let round = null, generic = false, m;
    if ((m = name.match(/\b(\d)\.\d{1,2}\b/))) round = +m[1];
    else if ((m = name.match(/\b(\d)(?:st|nd|rd|th)\b/i))) { round = +m[1]; generic = !/early|mid|late/i.test(name); }
    else if ((m = name.match(/round\s*(\d)/i))) { round = +m[1]; generic = true; }
    if (!round) continue;
    const k = ys[1] + "-" + round, b = generic ? gen : spec;
    (b[k] = b[k] || []).push(+e[0] || 0);
  }
  const out = {};
  for (const k of new Set([...Object.keys(gen), ...Object.keys(spec)])) {
    const arr = gen[k] || spec[k]; out[k] = arr.reduce((s, x) => s + x, 0) / arr.length;
  }
  return out;
}
const snapCache = {};
let snapDates = [];
async function snapFor(dateStr) {
  const t0 = Date.parse(dateStr); let best = null, bd = Infinity;
  for (const d of snapDates) { const diff = Math.abs(Date.parse(d) - t0) / 864e5; if (diff <= SNAP_WINDOW && (diff < bd || (diff === bd && d < best))) { best = d; bd = diff; } }
  if (!best) return null;
  if (!(best in snapCache)) {
    const j = await readJSON(`${OUT}/${best}.json`, null);
    snapCache[best] = j ? { players: j.players || {}, picks: normPicks(j.picks) } : null;
  }
  return snapCache[best];
}

/* ---------- main ---------- */
await mkdir(STATE, { recursive: true });
await mkdir(`${OUT}/players`, { recursive: true });
snapDates = ((await readJSON(`${OUT}/index.json`, { dates: [] })).dates || []).sort();
if (!snapDates.length) { console.log("No snapshots yet; nothing to price trades against."); process.exit(0); }

const nfl = await get(`${API}/state/nfl`);
const season = String(nfl?.league_season || nfl?.season || new Date().getFullYear());
const leg = Math.max(1, Number(nfl?.leg || nfl?.week || 1));
const weeks = [leg, leg - 1].filter((w) => w >= 1);

const home = await get(`${API}/league/${LEAGUE_ID}`);
if (!home) throw new Error("Couldn't load home league");
const ref = { qbs: numQbs(home), ppr: pprOf(home) };
const fits = (lg) => lg && lg.settings?.type === 2 && numQbs(lg) === ref.qbs && pprOf(lg) === ref.ppr &&
  (lg.total_rosters || 0) >= TEAMS_MIN && (lg.total_rosters || 0) <= TEAMS_MAX;

/* discovery (weekly) */
let leagues = await readJSON(`${STATE}/leagues.json`, null);
const stale = !leagues || leagues.season !== season || (Date.now() - leagues.updated) / 864e5 > REDISCOVER_DAYS;
if (stale) {
  const found = new Set([LEAGUE_ID]);
  const seenUsers = new Set();
  let frontier = ((await get(`${API}/league/${LEAGUE_ID}/users`)) || []).map((u) => u.user_id);
  for (let hop = 1; hop <= MAX_HOPS && frontier.length; hop++) {
    const users = frontier.filter((u) => !seenUsers.has(u)).slice(0, Math.max(0, MAX_USERS - seenUsers.size));
    users.forEach((u) => seenUsers.add(u));
    const fresh = [];
    const lists = await pool(users, 6, (u) => get(`${API}/user/${u}/leagues/nfl/${season}`));
    for (const list of lists) for (const lg of list || []) {
      if (found.size >= MAX_LEAGUES) break;
      if (fits(lg) && !found.has(lg.league_id)) { found.add(lg.league_id); fresh.push(lg.league_id); }
    }
    if (hop < MAX_HOPS) {
      const userLists = await pool(fresh, 6, (id) => get(`${API}/league/${id}/users`));
      frontier = [...new Set(userLists.flatMap((l) => (l || []).map((u) => u.user_id)))];
    }
    console.log(`Hop ${hop}: ${users.length} managers checked, ${found.size} comparable leagues so far`);
  }
  leagues = { season, updated: Date.now(), ids: [...found] };
  await writeFile(`${STATE}/leagues.json`, JSON.stringify(leagues));
}

/* nightly trade check */
const seen = await readJSON(`${STATE}/seen.json`, {});
const pruneBefore = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
for (const id of Object.keys(seen)) if (seen[id] < pruneBefore) delete seen[id];

const points = {};   // sid -> [[date, implied]]
let tradesNew = 0, tradesPriced = 0;
const jobs = leagues.ids.flatMap((id) => weeks.map((w) => [id, w]));
const results = await pool(jobs, 6, ([id, w]) => get(`${API}/league/${id}/transactions/${w}`));

for (const txns of results) for (const t of txns || []) {
  if (t.type !== "trade" || t.status !== "complete" || seen[t.transaction_id]) continue;
  const date = new Date(t.status_updated || t.created).toISOString().slice(0, 10);
  seen[t.transaction_id] = date; tradesNew++;
  const rids = t.roster_ids || [];
  if (rids.length !== 2) continue;                 // 3-team trades can't be split cleanly
  const snap = await snapFor(date); if (!snap) continue;

  let unpriced = false;
  const val = (a) => {
    if (a.kind === "player") return snap.players[a.pid]?.[0] || 0;
    const v = snap.picks[a.season + "-" + a.round]; if (v == null) unpriced = true; return v || 0;
  };
  const sides = rids.map((rid) => {
    const ins = [];
    for (const [pid, r] of Object.entries(t.adds || {})) if (r === rid) ins.push({ kind: "player", pid: String(pid) });
    for (const dp of t.draft_picks || []) if (dp.owner_id === rid) ins.push({ kind: "pick", season: String(dp.season), round: dp.round });
    return ins;
  });
  const totals = sides.map((ins) => ins.reduce((s, a) => s + val(a), 0));
  if (unpriced) continue;
  tradesPriced++;
  sides.forEach((ins, i) => {
    const paid = totals[1 - i];
    for (const a of ins) {
      if (a.kind !== "player") continue;
      const market = val(a);
      if (market < MIN_PLAYER_VALUE) continue;
      const implied = paid - (totals[i] - market);
      const ratio = implied / market;
      if (ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
      (points[a.pid] = points[a.pid] || []).push([date, Math.round(implied)]);
    }
  });
}

const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
for (const [sid, pts] of Object.entries(points)) {
  const path = `${OUT}/players/${sid}.json`;
  const f = await readJSON(path, { h: [], t: [] });
  f.t = [...(f.t || []), ...pts].filter(([d]) => d >= cutoff).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  f.h = f.h || [];
  await writeFile(path, JSON.stringify(f));
}
await writeFile(`${STATE}/seen.json`, JSON.stringify(seen));

console.log(`${leagues.ids.length} leagues, ${calls} API calls, ${tradesNew} new trades, ${tradesPriced} priced, ` +
  `${Object.values(points).reduce((s, p) => s + p.length, 0)} dots across ${Object.keys(points).length} players`);

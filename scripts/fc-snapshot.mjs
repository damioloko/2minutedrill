// Saves today's FantasyCalc dynasty values for the league's format:
//   fc/YYYY-MM-DD.json      full snapshot (used to value transactions on the day)
//   fc/index.json           list of snapshot dates
//   fc/players/<id>.json    per-player value history { h:[[date,value]], t:[[date,implied]] }
// FantasyCalc's public API only serves current values, so this builds the history.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const LEAGUE_ID = "1311997710454226944";
const OUT = "fc";
const KEEP_DAYS = 400;

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "2-minute-drill-snapshot" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

const league = await getJSON(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`);
const rp = league.roster_positions || [];
const numQbs = rp.includes("SUPER_FLEX") || rp.filter((p) => p === "QB").length >= 2 ? 2 : 1;
const rec = typeof league.scoring_settings?.rec === "number" ? league.scoring_settings.rec : 1;
const ppr = rec >= 1 ? 1 : rec > 0 ? 0.5 : 0;
const numTeams = league.total_rosters || 10;
const params = { isDynasty: true, numQbs, numTeams, ppr };

const rows = await getJSON(
  `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`
);
if (!Array.isArray(rows) || rows.length < 50) throw new Error(`Unexpected FantasyCalc response (${rows?.length} rows)`);

const players = {}, picks = {};
for (const r of rows) {
  const p = r.player || {};
  const entry = [Math.round(+r.value || 0), Math.round(+r.trend30Day || 0)];
  if (p.position === "PICK") picks[p.name] = entry;
  else if (p.sleeperId) players[String(p.sleeperId)] = entry;
}

const date = new Date().toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
await mkdir(`${OUT}/players`, { recursive: true });
await writeFile(`${OUT}/${date}.json`, JSON.stringify({ date, params, players, picks }));

const index = await readJSON(`${OUT}/index.json`, { dates: [] });
index.dates = [...new Set([...(index.dates || []), date])].sort();
await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));

for (const [sid, [value]] of Object.entries(players)) {
  if (value <= 0) continue;
  const path = `${OUT}/players/${sid}.json`;
  const f = await readJSON(path, { h: [], t: [] });
  f.h = (f.h || []).filter(([d]) => d !== date && d >= cutoff);
  f.h.push([date, value]);
  f.h.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  f.t = f.t || [];
  await writeFile(path, JSON.stringify(f));
}

console.log(`Saved ${Object.keys(players).length} players and ${Object.keys(picks).length} picks for ${date}`);

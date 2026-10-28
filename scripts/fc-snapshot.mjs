// Saves today's FantasyCalc dynasty values for the league's format to fc/YYYY-MM-DD.json
// and lists the date in fc/index.json. Run daily by .github/workflows/fc-snapshot.yml.
// FantasyCalc's public API only serves current values, so this builds the history.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const LEAGUE_ID = "1311997710454226944";
const OUT = "fc";

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "2-minute-drill-snapshot" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
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
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/${date}.json`, JSON.stringify({ date, params, players, picks }));

let index = { dates: [] };
try { index = JSON.parse(await readFile(`${OUT}/index.json`, "utf8")); } catch {}
index.dates = [...new Set([...(index.dates || []), date])].sort();
await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));

console.log(`Saved ${Object.keys(players).length} players and ${Object.keys(picks).length} picks for ${date}`);

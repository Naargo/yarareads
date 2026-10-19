// Basic usage numbers, from the live database. No personal data: counts only.
// Visits and countries come from Cloudflare Web Analytics (dashboard > Analytics & Logs > Web Analytics > yarareads.finereli.com),
// and request/error metrics from Workers > yara-reads > Metrics.
// Usage: node tools/stats.mjs [--local]
import { execFileSync } from 'node:child_process';

const where = process.argv.includes('--local') ? '--local' : '--remote';
const q = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'yara-reads', where, '--json', '--command', sql], { encoding: 'utf8' }))[0].results;
const one = (sql) => Object.values(q(sql)[0] ?? {})[0] ?? 0;
const since = (days) => `ts >= datetime('now', '-${days} days')`;

console.log('SIGNED OUT (anonymous counts)');
for (const d of [7, 30]) {
  const r = q(`SELECT sum(type = 'open') AS opened, sum(type = 'finish') AS finished, sum(type = 'page') AS pages FROM public_events WHERE ${since(d)}`)[0];
  console.log(`  last ${String(d).padStart(2)} days: ${r.opened ?? 0} books opened, ${r.finished ?? 0} finished, ${r.pages ?? 0} pages read`);
}
const top = q(`SELECT story_id, count(*) AS n FROM public_events WHERE type = 'open' AND ${since(30)} GROUP BY story_id ORDER BY n DESC LIMIT 5`);
if (top.length) console.log('  most opened (30d):', top.map((t) => `${t.story_id} ${t.n}`).join(', '));

console.log('ACCOUNTS');
console.log(`  total ${one('SELECT count(*) FROM accounts')}, seen in the last 7 days ${one(`SELECT count(*) FROM accounts WHERE seen_at >= datetime('now', '-7 days')`)}, last 30 days ${one(`SELECT count(*) FROM accounts WHERE seen_at >= datetime('now', '-30 days')`)}`);
const f = q(`SELECT sum(type = 'finish') AS finished, sum(type = 'page') AS pages FROM events WHERE sub != 'family' AND ${since(30)}`)[0];
console.log(`  signed-in reading, last 30 days: ${f.finished ?? 0} finished, ${f.pages ?? 0} pages`);

console.log('AGENTS');
console.log(`  approved agents ${one(`SELECT count(DISTINCT client_id) FROM mcp_tokens WHERE kind = 'refresh' AND expires_at > strftime('%s', 'now')`)}, books added by agents or accounts ${one("SELECT count(*) FROM stories WHERE owner IS NOT NULL AND owner != 'family'")}`);

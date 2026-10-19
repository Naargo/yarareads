// Copies the live inventory (edited in the grown-ups section) from D1 into content/inventory.json.
// Usage: node tools/pull.mjs [--local] [--owner <sub>]   (default: the 'family' account, or whoever claimed it: pass their sub)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ownerArg = process.argv.indexOf('--owner');
const owner = (ownerArg > 0 ? process.argv[ownerArg + 1] : 'family').replace(/'/g, '');
const where = process.argv.includes('--local') ? '--local' : '--remote';
const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'yara-reads', where, '--json',
  '--command', `SELECT body FROM account_inventory WHERE sub = '${owner}'`], { encoding: 'utf8' });
const body = JSON.parse(out)[0].results[0]?.body;
if (!body) throw new Error('no inventory in D1');
const old = JSON.parse(readFileSync('content/inventory.json', 'utf8'));
writeFileSync('content/inventory.json', JSON.stringify({ _note: old._note, ...JSON.parse(body) }, null, 2) + '\n');
console.log('pulled inventory into content/inventory.json');

// Which account a push or pull is for: --owner <email or Google id>, else $OWNER_EMAIL. An email is looked up in the
// accounts table (an account is recorded the first time it opens the library, so sign in once first).
import { execFileSync } from 'node:child_process';

export function owner(where) {
  const i = process.argv.indexOf('--owner');
  return account((i > 0 ? process.argv[i + 1] : process.env.OWNER_EMAIL) || '', where);
}

// An email or Google id -> the Google id.
export function account(who, where) {
  if (!who.includes('@')) return who.replace(/'/g, '') || null;
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'yara-reads', where, '--json', '--command',
    `SELECT sub FROM accounts WHERE email = '${who.replace(/'/g, '')}'`], { encoding: 'utf8' });
  const sub = JSON.parse(out)[0].results[0]?.sub;
  if (!sub) throw new Error(`${who} hasn't signed in yet: open the app with that account once, then try again`);
  return sub;
}

// Pushes all stories to D1, and their page images to R2. Refuses if one of our stories has words
// Yara can't read (books from home are exempt: they're what they are).
// The inventory lives in D1 (edited in the app); pass --inventory to overwrite it from
// content/inventory.json. Run `node tools/pull.mjs` first so you check against the live one.
// Usage: node tools/push.mjs [--local] [--inventory] [--images] [--owner <email or id>] [--share <email or id,...>] [--only <story id>]   (--images uploads page pictures to R2)
// Books from home are private to one account: --owner (or $OWNER_EMAIL) says whose. --inventory writes that account's inventory.
// --share lets other accounts (the rest of the family) see the books from home pushed too (story_readers).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { owner as findOwner, account } from './owner.mjs';
import { compile, storyFiles, inventory, isHomeBook, imageFile } from './build.mjs';

const where = process.argv.includes('--local') ? '--local' : '--remote';
const owner = findOwner(where);
const shareArg = process.argv.includes('--share') ? process.argv[process.argv.indexOf('--share') + 1] : '';
const readers = shareArg.split(',').filter(Boolean).map((who) => account(who, where));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = [];
if (process.argv.includes('--inventory')) {
  if (!owner) throw new Error('--inventory needs --owner <email or id> (or $OWNER_EMAIL)');
  const { _note, ...inv } = inventory;
  sql.push(`INSERT OR REPLACE INTO account_inventory (sub, body, updated_at) VALUES (${q(owner)}, ${q(JSON.stringify(inv))}, CURRENT_TIMESTAMP);`);
}
let stories = 0;
const images = new Set();
// Pictures are cached on devices for a long time, and a redrawn picture keeps its R2 key, so the stored story
// points at "toby-1/3.jpg?v=<hash of the file>": a new picture is a new URL, and every device fetches it.
const versioned = (key) => key && `${key}?v=${createHash('sha1').update(readFileSync(imageFile(key))).digest('hex').slice(0, 10)}`;
// --only <id>: push just that story (and its pictures), leaving the others as they are in D1
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
for (const file of storyFiles()) {
  const { story, unknown } = compile(JSON.parse(readFileSync(file, 'utf8')));
  if (only && story.id !== only) continue;
  for (const key of [story.coverImage, ...story.pages.map((p) => p.image)].filter(Boolean)) {
    if (!imageFile(key)) throw new Error(`${story.id}: missing image ${key}`);
    images.add(key);
  }
  if (isHomeBook(story) && !owner) throw new Error(`${story.id} is a book from home: needs --owner <email or id> (or $OWNER_EMAIL)`);
  if (unknown.size && !isHomeBook(story)) {
    console.error(`${story.id}: unreadable words: ${[...unknown.keys()].join(', ')}`);
    process.exit(1);
  }
  story.coverImage = versioned(story.coverImage) || undefined;
  for (const p of story.pages) if (p.image) p.image = versioned(p.image);
  stories++;
  sql.push(
    `INSERT OR REPLACE INTO stories (id, series, number, title, body, owner, updated_at) VALUES (${q(story.id)}, ${q(story.series)}, ${story.number}, ${q(story.title)}, ${q(JSON.stringify(story))}, ${isHomeBook(story) ? q(owner) : 'NULL'}, CURRENT_TIMESTAMP);`,
    ...(isHomeBook(story) ? readers.map((r) => `INSERT OR IGNORE INTO story_readers (story_id, sub) VALUES (${q(story.id)}, ${q(r)});`) : []),
  );
}
mkdirSync('.build', { recursive: true });
writeFileSync('.build/push.sql', sql.join('\n'));
execFileSync('npx', ['wrangler', 'd1', 'execute', 'yara-reads', where, '--file', '.build/push.sql'], { stdio: 'inherit' });
if (process.argv.includes('--images')) {
  for (const key of images) {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `yara-reads-pictures/${key}`, where,
      '--file', imageFile(key), '--content-type', 'image/jpeg'], { stdio: 'ignore' });
    console.log(`uploaded ${key}`);
  }
}
console.log(`pushed ${stories} stories${process.argv.includes('--inventory') ? ' + inventory' : ''} (${where})`);

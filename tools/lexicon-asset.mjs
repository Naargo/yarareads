// Writes public/lexicon.dict (the CMU dictionary plus data/extra.dict, one file) so the worker can compile books that
// agents add. It's served as a static asset and git-ignored; `npm run deploy` runs this first.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const text = ['data/cmudict.dict', 'data/extra.dict'].map((f) => readFileSync(root + f, 'utf8')).join('\n');
writeFileSync(root + 'public/lexicon.dict', text);
console.log(`public/lexicon.dict: ${(text.length / 1e6).toFixed(1)} MB`);

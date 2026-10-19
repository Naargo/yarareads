// Pronunciations from the CMU dictionary (data/cmudict.dict) plus data/extra.dict (names and British pronunciations,
// same format). The logic is in src/lexicon-core.js, which the worker shares.
import { readFileSync } from 'node:fs';
import { makeLexicon } from '../src/lexicon-core.js';

const root = new URL('..', import.meta.url).pathname;
let lexicon;

export function pronunciations(word) {
  lexicon ||= makeLexicon(['data/cmudict.dict', 'data/extra.dict'].map((f) => readFileSync(root + f, 'utf8')));
  return lexicon(word);
}

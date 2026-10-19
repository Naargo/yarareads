// Compiles stories: attaches each word's pronunciations (so the app can decide, against the
// live inventory, how to break it down), and lists words Yara can't read yet.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compileStory } from '../src/compile.js';
import { pronunciations } from './lexicon.mjs';

const root = new URL('..', import.meta.url).pathname;
export const inventory = JSON.parse(readFileSync(join(root, 'content/inventory.json'), 'utf8'));

// Our decodable stories (content/stories, in git) and books from home (content/home/<id>/book.json,
// gitignored: the repo is public and those are other people's books).
export function storyFiles() {
  const stories = join(root, 'content/stories');
  const home = join(root, 'content/home');
  return [
    ...readdirSync(stories).filter((f) => f.endsWith('.json')).sort().map((f) => join(stories, f)),
    ...(existsSync(home) ? readdirSync(home).sort().map((d) => join(home, d, 'book.json')).filter(existsSync) : []),
  ];
}

// Where a page image key ("mittu/1.jpg") lives on disk.
export function imageFile(key) {
  return [join(root, 'content/home', key), join(root, 'content/pictures', key)].find(existsSync);
}

// Books from home aren't written for Yara, so words she can't read are expected, not an error.
export const isHomeBook = (story) => story.kind === 'book';

export function compile(story, inv = inventory) {
  return compileStory(story, inv, pronunciations);
}

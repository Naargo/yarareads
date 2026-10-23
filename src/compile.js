// Compiles a story: attaches each word's pronunciations (so the app can decide, against the live inventory, how to
// break it down), and lists the words that can't be read with that inventory. Shared by tools/ and the worker.
import { classify, tokenize, isWord, normalize, forStory } from '../public/phonics.js';

export function compileStory(story, inv, pronunciations) {
  inv = forStory(inv, story);
  const words = {};
  const unknown = new Map();
  let count = 0;
  story.pages.forEach((page, n) => {
    for (const t of tokenize(`${page.chapter || ''} ${page.text}`).filter(isWord)) {
      count++;
      const w = normalize(t);
      words[w] = pronunciations(t);
      if (classify(t, inv, words[w]).kind === 'unknown') unknown.set(w, [...(unknown.get(w) || []), n + 1]);
    }
  });
  return { story: { ...story, words }, unknown, count };
}

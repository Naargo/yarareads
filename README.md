# Yara Reads

**[Read it: yarareads.finereli.com](https://yarareads.finereli.com)** - free, no account needed.

A reading app for kids who have just learned their phonics sounds and need something real to read. Every word in a story can be
sounded out with the sounds they already know. When they get stuck, they tap the word and its sound buttons appear right there.

I made it for my daughter Yara. She's six and loves glitter, magic and dragons. She'd finished Teach Your Monster to Read and I
couldn't find anything for her to read next that was both a good story and made only of words she could sound out. Her big brother
Tom wrote the first story, and the app is built so there can be many more.

## What's different

- **The help lives on the word.** Tap any word: a dot under single letters, a bar under pairs like "sh" and "ee", an arc joining
  split vowels like a_e. One speaker button lights each sound in turn, then says the word. It never reads whole pages for them.
- **The checker is the point.** Stories are checked word by word against the sounds the child knows, by pronunciation and not
  just spelling ("cake" fails if the child hasn't learned the split a). `npm run check` fails a story with a word they can't read.
- **Bring your own books.** Connect your own agent (Claude, ChatGPT, anything that speaks MCP) and it writes stories inside your
  child's sounds, or types in books you own. It checks its own words, adds pictures, and shows you the result. Only your account sees them.
- **You set what your child knows.** Switch sounds and tricky words on or off. Words with a sound they haven't learned get a dotted
  underline and the new sound shows in purple.

## Run your own

It's a Cloudflare Worker with static assets, D1 for data and R2 for pictures. No build step. If you're a tech dad (or mum) with a
kid who's learning to read, I'd love you to take this and make it yours.

```sh
git clone https://github.com/finereli/yara-reads && cd yara-reads
npm install
npx wrangler d1 create yara-reads          # put the database_id in wrangler.jsonc, with your account_id
npx wrangler r2 bucket create yara-reads-pictures
npx wrangler d1 migrations apply yara-reads --local
node tools/lexicon-asset.mjs               # the word dictionary the worker uses
node tools/push.mjs --local --inventory --images --owner dev   # load the stories (--owner: books from home, if you have any)
npx wrangler dev
```

Then `npm run deploy` when you're happy (edit the `routes` in `wrangler.jsonc` for your domain; deploy needs the dictionary step,
which the script runs for you).

Things to know:

- **It works signed out.** That's the whole app, with the sounds and progress kept in the browser. Accounts (and so agents) use
  `login.finereli.com`, which only serves my own apps. To run accounts yourself, swap in your own sign-in: `public/login.js` and
  `src/verify-login.js` are the only files that know about it.
- **The sounds are my voice**, recorded for the tiles, and they aren't in this repository. Without them the tiles still light up
  but stay quiet. Record your own with `tools/sounds-record.mjs` (see the comment at the top). Words are spoken by Cloudflare
  Workers AI, so deploying needs an account with that enabled.
- **Write a story**: copy `content/stories/toby-1.json`, edit the pages, run `npm run check`. It tells you every word your child can't
  read yet. Never loosen the sounds to make a story pass: rewrite the story. `docs/vocabulary.md` has the queue of what to teach next.
- **Pictures**: `docs/illustration.md` and `tools/illustrate.mjs` describe how the illustrations were made.
- **CLAUDE.md** explains how everything fits together, for you or your agent.
- Usage numbers: `node tools/stats.mjs`.

## Licenses

Code: MIT (`LICENSE`). Stories and pictures: Creative Commons Attribution 4.0 (`content/LICENSE.md`), so remix away and credit
Yara Reads and the authors. Third-party material: `NOTICE.md`.

[Privacy](https://yarareads.finereli.com/privacy) &middot; [Terms](https://yarareads.finereli.com/terms)

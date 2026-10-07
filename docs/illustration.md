# Illustrating books

How the pictures for Julia and Toby were made (Oct 2026), and how to do it again for more chapters
or a new series. Tool: `tools/illustrate.mjs`. Everything it needs is in the repo.

## The short version: illustrating a new chapter

Chapters are drawn as **boards**: the whole chapter as one 4x4 grid of 16 panels, and then the best panel is picked
for each page. Drawn together, the panels keep their own continuity (light, props, places); earlier boards passed
in as references carry it from chapter to chapter. Details in "Boards" below.

1. Write the chapter (it must pass `npm run check`) in `content/stories/toby-N.json`.
2. Draw its board, with the earlier boards it needs as references: always the previous chapter, plus any
   chapter whose places, characters or things come back (the woods from chapter 1, the playhouse from 2...).
   ```
   node tools/illustrate.mjs board toby-8 toby-7 toby-1      # ~2 min, ~$0.15
   ```
3. Look at `content/art/julia-and-toby/boards/toby-8-numbered.jpg` and choose a panel for each page. Panels the
   story doesn't need are just spares. If the board is wrong (a character off-model, the wrong place), draw it again:
   each run is different.
   ```
   node tools/illustrate.mjs pick toby-8 1=1 2=3 3=4 4=6 ...  # page=panel
   node tools/illustrate.mjs cover toby-8 3                  # optional: page 3's picture as the library cover
   node tools/push.mjs --images                              # upload and publish
   ```
4. Commit the board, its numbered preview, the pictures and the story JSON (which records each page's `panel`).
5. Tell Eli which panels went where (send the numbered board); he and Tom review in the app.

A new recurring character needs a sheet first (`illustrate.mjs sheet`, below) and a `cast` entry in the art file,
so every board draws them the same way. A new recurring place doesn't: the first board that shows it becomes its reference.

## The model

- **gpt-image-2** (OpenAI) via **OpenRouter**, since Oct 2026. Key: `OPENROUTER_API_TOKEN` in the environment
  (it has a $5/week limit). About 30 seconds per picture; `pages` draws 5 at once, so a chapter takes about a minute.
- Call: `POST https://openrouter.ai/api/v1/images` (the dedicated image endpoint: chat/completions refuses this model),
  JSON body: `model`, `prompt`, `quality` (`medium`), `aspect_ratio` (`4:3`, sheets `3:4`), `n: 1`, and
  `input_references`: up to 16 `{ type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }`.
  The response has `data[0].b64_json` (a 1536x1152 PNG) and `usage.cost` in dollars; the tool prints the running total.
- **Cost at medium:** $0.049 of output per picture, plus about half a cent to a cent per reference sheet:
  5-7 cents a page. Low is ~1 cent, high ~17 (OpenAI: 1536x1024 low $0.005, medium $0.041, high $0.165).
  Medium looked right for soft watercolor; we haven't needed high.
- Why it replaced FLUX.2 [dev] on Workers AI (~7 cents a page, the first ~120 pictures): characters stay on-model
  (Julia's puffs, freckles, dungarees and red sneakers on every page), it draws the scene that's described rather
  than a figure on a blank background, and it kept text out. A dragon with no reference came out a real dragon,
  where FLUX drew a bear. FLUX is still on the Cloudflare account (`@cf/black-forest-labs/flux-2-dev`, multipart form,
  `input_image_0..3`) if it's ever needed again; see this file's git history for the old tool.

## Boards (whole-chapter grids)

The experiment that beat page-by-page drawing: give gpt-image-2 a whole chapter's raw text plus the character sheets,
and ask for ONE 4x4 grid of 16 panels. Drawn together, the panels keep their continuity without anyone spelling it out:
in chapter 6, once dusk fell it stayed dusk in every later panel, which per-page drawing never managed even with briefs.

```
node tools/illustrate.mjs board toby-1                    # -> content/art/julia-and-toby/boards/toby-1.jpg
node tools/illustrate.mjs board toby-2 toby-1             # earlier boards as references, chosen by content
node tools/illustrate.mjs pick toby-2 1=1 2=3 3=4 ...     # page=panel (panels 1-16, row by row)
node tools/push.mjs --images
```

- **Always 4x4, at 3072x2304** (OpenAI's pixel budget; 3840x2880 is refused). Panels are about 756x564 and are scaled
  up to 1024x768. One fixed grid keeps panel proportions the same everywhere; 16 panels for 8-12 pages leaves spares,
  and the best panel for each page is picked by eye. The model pads extra panels with in-between beats.
- **About $0.15 a board at medium quality** (~1.5 cents a page); high was $0.50 and looked no better.
- **Earlier boards as references** (Eli's idea) carry continuity between chapters: places, props, the playhouse.
  Pick them by content: the previous chapter, plus any chapter whose places or characters come back.
- Only character sheets go in, not setting pictures: the backyard picture drew the playhouse wrong and the board copied it.
- **Pick first; edit the board for a real miss.** 16 panels for 8-12 pages means a few always miss: skip them and use
  the ones that work. When a page has no good panel, edit the board rather than drawing that page alone:
  ```
  node tools/illustrate.mjs edit toby-4 6,7 "In panel 6, the toys shoot up OUT of the playhouse into the open sky..."
  node tools/illustrate.mjs pick toby-4 6=2:6 7=2:7         # panels 6 and 7 of edit 2 (boards/toby-4.2.jpg)
  ```
  The endpoint has no masks, so `edit` passes the board itself as the reference and asks for the same board with only
  those panels changed. It works like inpainting: on Oct 7 the other panels came back almost identical, and the new
  panels match the chapter because the model sees all of it. ~$0.15 an edit. Describe the change in full sentences,
  per panel. Boards fed to later chapters are the originals.
- **Don't describe characters a chapter doesn't have.** Told what the black dragon looks like "if the story has" one,
  the chapter 5 board drew it in its last panel anyway, and chapter 6 copied it from that board. The tool now
  describes a sheetless character only when the chapter's text mentions it.
- `pick` cuts panels along the white gutters (it fails loudly if it doesn't find a 4x4 grid) and records `panel` on the page.
- 3x3 left a blank band; 5x5 made thumbnails and padded the story with repeats.

## Art direction file

`content/art/julia-and-toby.json`:

- `style`: one paragraph appended to every prompt. Ours: soft watercolor with colored-pencil lines, warm light,
  rounded friendly shapes, simple backgrounds, expressive faces; cozy, a little magical.
  **Always end with "No text, no letters, no words anywhere in the image."** Text in a picture would compete
  with the words she's reading, and models love adding signs and labels.
- `size`: `[1024, 768]`, 4:3 landscape. Right for the reader: about half the iPad screen in landscape at 2x,
  full width on a phone. Character sheets are drawn portrait at 768x1024.
- `cast`: one entry per recurring character or object:
  - `look`: a precise visual description (hair, clothes, colours, size). This goes into both the sheet prompt
    and every page prompt that uses the sheet, so write it once and reuse it.
  - `match`: lowercase words that mean "this cast member is in the page" (see cast detection below).
  - `object: true` for things, not characters (the playhouse). Changes the sheet prompt to "the object alone,
    empty, no people or animals". Without it, the playhouse sheets all came with a child standing in front.

### Julia and Toby's cast (approved sheets in content/art/julia-and-toby/)

| Cast | Look | Picked |
|---|---|---|
| julia | 6, curly brown hair in two puffs, freckles, yellow t-shirt, blue denim dungarees, red sneakers | candidate 2 |
| toby | small young dragon (big-dog size), pure white scales shimmering with tiny pink, green and blue sparkles, round friendly face, big dark eyes, small wings, soft rounded spikes, long tail | candidate 2 |
| playhouse | small plastic playhouse, pink walls, window and door, green roof | candidate 2 (object) |

Julia's look is ours, not Tom's; he can change it (edit `look`, redraw her sheet, then redraw the pages she's in).
All candidates are kept in `candidates/` so a different pick is just a copy.

## The per-page method (for one-off redraws)

Before boards (Oct 6), every page was drawn on its own: `illustrate.mjs pages <story> [page ...]`, with the
settings, page briefs and cast below steering each one. It still works for redrawing a single page, but its
pictures don't share light or props with their neighbours the way board panels do.

### Settings (places)

Pages set in the same place should look like the same place, so places get reference pictures too.
`settings` in the art file has one entry per recurring place with a `look`; `node tools/illustrate.mjs sheet "<series>" <setting> 1`
draws an empty landscape view of it, and the pick is copied to `content/art/<series>/<setting>.jpg` like a character sheet.
Each page names its place: `"setting": "backyard"`. The setting picture is passed as the last reference, with
"keep the same place, layout and landmarks, seen from whatever angle suits the scene". A setting without a picture
(Super-Tall Peak, seen once) is described in words only.
A setting's `with` lists cast that always comes along: the backyard brings the playhouse sheet, because without it
the model copied the playhouse from the backyard picture (a wooden cottage with a heart on the door).

Julia and Toby: `backyard` (cream house, back step, lawn, playhouse in the far corner, wooden fence and gate),
`woods` (the clearing past the gate: big oak, mossy stump, fallen log, small pond), `cave` (the black dragon's cave),
`peak` (words only).

Before settings, pages whose `picture` named no place came out on a plain cream background (chapter 1 pages 5-10).

### Page briefs

Every page of Julia and Toby carries a full brief, written by reading the whole book the way an art director would:

- `cast`: exactly who and what is in the picture. Characters with sheets go in as references; props (scooter,
  backpack, kite, paints, teacup, toys, tin can, branch) are `object` cast entries described in words, so the scooter
  stays red from chapter to chapter.
- `setting` and `time` ("a sunny afternoon", "dusk: pink and orange sky..."), so a scene keeps its place and light.
- `picture`: names, not "the girl", and the state of things carried over from earlier pages: paint still on Toby,
  the bent wheel, the tin can stuck in the oak, Toby calm and focused (not happy) while Julia floats.

Why not send the whole book to the image model: it costs little, but image models follow long prompts loosely and
pull in things from other pages. The continuity is worked out once, in text, where it can be read and corrected.
When writing a new chapter, write its briefs the same way, reading the chapters before it.

### Per-page cast

A page can list its cast explicitly, `"cast": ["julia", "toby"]`, which overrides match words. Use it when matching
gets it wrong: chapter 1 page 9 mentions the play house in its text but happens in the woods, and the black dragon
pages (ch7 p10-12) must not get Toby's sheet. A cast member with no sheet (the black dragon) is described in words.

### Prompts

**Sheet:** `<style> Character reference sheet: <look> Shown full body, standing, facing three-quarters toward the
viewer, on a plain warm off-white background. One single figure, centered.` Seeds 1001-1004 for the 4 candidates.

**Page:** `<style> Image 1 is the reference for <look of cast 1> Keep this exact design, colours and outfit.
Image 2 is ... Scene: <page.picture>. The words on this page of the story are: "<page.text>"`

- The scene comes from the page's `picture` field in the story JSON. Write it as a short visual description
  (who, doing what, where, mood): "the dragon looking down guiltily". It's the main lever for a better picture.
- The page text is included for context (emotion, objects mentioned).
- References are passed in cast order, then the setting (gpt-image-2 takes up to 16).

### Cast detection (who's on a page)

A cast member is included when one of its `match` words appears as a whole word in the page's `picture` or
`text` (lowercased, possessive 's stripped). Julia matches julia/girl/she/her; Toby matches toby/dragon;
the playhouse matches "play house"/"playhouse".

Lessons:
- **A missed match draws a generic character.** "patting the dragon's nose" missed Toby (before possessives were
  stripped) and produced a green dragon. If a page shows the wrong-looking character, check its `picture` text
  mentions them by a match word.
- Over-matching is mostly harmless (an extra reference rarely adds a stray character), but watch pronouns:
  "she" also matches Julia when "she" is someone else (a dragon mum). Add an explicit word to the scene instead.
- Scenes with only incidental characters (the cat, the dog, the big dragon on the peak) get no reference;
  they'll vary between pages. If one recurs, give it a cast entry and a sheet.

## After drawing

- **Compression.** gpt-image-2 returns 1536x1152 PNGs (~2.5 MB). `illustrate.mjs` resizes to the art size (1024 wide)
  and re-saves at JPEG quality 80 with mozjpeg (via `sharp`): ~60-100 KB, visually identical at reading size. `node tools/shrink.mjs` does the same for
  pictures added another way. 48 pictures went from 17 MB to 2.8 MB.
- Files: `content/pictures/<story-id>/<page>.jpg`, and the tool sets `page.image` = `"<story-id>/<page>.jpg"`
  in the story JSON. Committed to git (the repo is private).
- Upload: `node tools/push.mjs --images` uploads every referenced picture to the R2 bucket `yara-reads-pictures`
  and republishes the stories. Served at `/api/pictures/<key>` behind the PIN.
- Covers: `illustrate.mjs cover <story> <page>` sets `coverImage`; otherwise the library shows the drawn motif.
- The app picks up new pictures whenever the library opens; no deploy needed.

## Review and redraws

Eli and Tom review in the app. To redraw a page: improve its `picture` description if the problem is content
(wrong action, missing object), then `node tools/illustrate.mjs pages <story> <page>` (each call draws
afresh) and `node tools/push.mjs --images`. If a character drifts off-model, strengthen their `look` or redraw
their sheet; changing a sheet means redrawing every page they appear in.

## Status (Oct 2026)

- **All 7 chapters of Julia and Toby are drawn as boards** (Oct 7) and live; $1.06 for the seven boards at medium.
  Each page's `panel` in the story JSON says which panel it uses ("6", or "2:6" from edit 2); the numbered boards show them all.
- Boards were fed: 2<-1, 3<-2, 4<-2,3, 5<-4,1, 6<-5, 7<-6,1. Chapter 7's board was the best: it found Super-Tall Peak
  and the black dragon on its own.
- Board edits (Oct 7, $0.45): ch3 p2 (Julia painted on Toby instead of on paper), ch4 p6-7 (the toys whirled
  inside the playhouse instead of zooming sky-high), ch5 p1 (the playhouse in the woods).
- Kept as they are: the playhouse near the gate in chapter 7, and the scooter is pink.
- Covers are page pictures (Oct 7), chosen to be distinct per chapter without giving the plot away: ch1 p4, ch2 p2, ch3 p2,
  ch4 p4 (the bee, not the twist), ch5 p3, ch6 p5 (dusk, not the branch), ch7 p7 (never the black dragon).
- Earlier pictures (FLUX drafts, then per-page gpt-image-2) are in git history.
- Sounding out and TTS (roadmap 4) is next, now the pictures are done.

## A new series

1. Write `content/art/<series-slug>.json` (slug of the story's `series` field): style (reuse ours for a matching
   library, or change it), and a cast entry per recurring character/object.
2. Draw 4 sheet candidates each, review them side by side, copy the picks.
3. Test 3-4 pages that mix the cast differently before drawing everything: consistency problems show up there.
4. Draw all pages, upload, review in the app.

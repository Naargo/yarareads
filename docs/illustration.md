# Illustrating books

How the pictures for Julia and Toby were made (Oct 2026), and how to do it again for more chapters
or a new series. Tool: `tools/illustrate.mjs`. Everything it needs is in the repo.

## The short version

1. Write the art direction: `content/art/<series-slug>.json` (style + cast).
2. Draw character-sheet candidates, pick one per cast member, copy it to `content/art/<series-slug>/<cast>.jpg`.
3. Draw the pages: each page's `picture` description becomes a prompt, with the approved sheets of whoever
   appears passed in as reference images. That's what keeps Toby looking like Toby on every page.
4. Upload (`node tools/push.mjs --images`), then review in the app and redraw the misses.

```
node tools/illustrate.mjs sheet "Julia and Toby" toby 4     # 4 candidates -> content/art/julia-and-toby/candidates/
cp content/art/julia-and-toby/candidates/toby-2.jpg content/art/julia-and-toby/toby.jpg
node tools/illustrate.mjs pages toby-3                      # every page of chapter 3
node tools/illustrate.mjs pages toby-3 5 7                  # just pages 5 and 7 (redraws)
node tools/illustrate.mjs cover toby-3 5                    # page 5's picture as the library cover
node tools/push.mjs --images                                # upload to R2 and publish
```

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

## Prompts

**Sheet:** `<style> Character reference sheet: <look> Shown full body, standing, facing three-quarters toward the
viewer, on a plain warm off-white background. One single figure, centered.` Seeds 1001-1004 for the 4 candidates.

**Page:** `<style> Image 1 is the reference for <look of cast 1> Keep this exact design, colours and outfit.
Image 2 is ... Scene: <page.picture>. The words on this page of the story are: "<page.text>"`

- The scene comes from the page's `picture` field in the story JSON. Write it as a short visual description
  (who, doing what, where, mood): "the dragon looking down guiltily". It's the main lever for a better picture.
- The page text is included for context (emotion, objects mentioned).
- References are passed in cast order, at most 4.

## Cast detection (who's on a page)

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

- **Switched to gpt-image-2** (above). Tested 4 pages for $0.24, then drew chapter 1 for real. Next: Eli reviews
  chapter 1 in the app, then the remaining six chapters (~$4 at medium, so they fit the weekly limit).
- Julia and Toby was rewritten (7 chapters, Tom's notes) and published **text only**. Every page's FLUX picture is
  parked as `draftImage` (not shown in the app); `illustrate.mjs pages <id> --missing` treats those pages as undrawn.
  Drafts: `content/pictures/toby-v1-*` (first draft) and `content/pictures/toby-N/` (rewrite, FLUX). Cost so far ~$8.
- Problems seen with FLUX on the rewrite, to check with the new model:
  - Text painted into a picture despite "no text" (ch4 p7, "Crash! Bang! Smash!").
  - **Cast detection matched "dragon" to Toby** on the ominous black-dragon pages (ch7 p10-12), so cute Toby appeared
    in the dark cave. The black dragon needs its own cast entry and sheet, and `match` words must not collide
    ("big black dragon" vs "dragon"). Consider explicit per-page `cast` lists instead of keyword matching.
  - The black dragon itself came out bear-like.
- Mittu and the Yellow Mango: pictures are scans from the book (see CLAUDE.md, books from home), not generated.

## A new series

1. Write `content/art/<series-slug>.json` (slug of the story's `series` field): style (reuse ours for a matching
   library, or change it), and a cast entry per recurring character/object.
2. Draw 4 sheet candidates each, review them side by side, copy the picks.
3. Test 3-4 pages that mix the cast differently before drawing everything: consistency problems show up there.
4. Draw all pages, upload, review in the app.

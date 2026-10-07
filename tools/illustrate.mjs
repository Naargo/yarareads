// Illustrations with OpenAI's gpt-image-2 via OpenRouter (OPENROUTER_API_TOKEN). About 6 cents and 30 s a page at medium.
// (Before Oct 2026 we used FLUX.2 [dev] on Workers AI; gpt-image-2 keeps characters closer and follows scenes better.)
//
// Consistency comes from character sheets: each cast member gets an approved reference image,
// passed to every page that shows them. Art direction lives in content/art/<series>.json.
//
//   node tools/illustrate.mjs sheet <series> <cast> [n]     draw n candidate sheets (default 4)
//                                                            -> content/art/<series>/candidates/<cast>-<i>.jpg
//   (pick one: copy it to content/art/<series>/<cast>.jpg)
//   node tools/illustrate.mjs pages <story-id> [page ...]   draw pages (1-based), set page.image
//   node tools/illustrate.mjs pages <story-id> --missing    draw only pages that have no picture yet
//                                                            -> content/pictures/<story-id>/<page>.jpg
//   node tools/illustrate.mjs cover <story-id> <page>       use that page's picture as the cover
//
// Boards: a whole chapter drawn as one 4x4 grid of 16 panels, so light, props and places carry from panel to panel.
//   node tools/illustrate.mjs board <story-id> [board-id ...]   draw the board, with earlier boards as references
//                                                            -> content/art/<series>/boards/<story-id>.jpg (and a numbered preview)
//   node tools/illustrate.mjs preview <story-id>              numbered preview: boards/<story-id>-numbered.jpg
//   node tools/illustrate.mjs pick <story-id> <page>=<panel> ...   use panel (1-16, row by row) as the page's picture
//
// Then `node tools/push.mjs --images` uploads them.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const root = new URL('..', import.meta.url).pathname;
const MODEL = 'openai/gpt-image-2';
const QUALITY = 'medium';
const PARALLEL = 5; // pages drawn at once // low ~1 cent, medium ~5, high ~17 per picture (plus ~1 cent of reference input)
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Models return big PNGs (gpt-image-2: 1536x1152, ~2.5 MB). Resized to the art size at quality 80 they're ~60 KB
// and look the same at reading size.
export const webJpeg = (buf, width = 1024) =>
  sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality: 80, progressive: true, mozjpeg: true }).toBuffer();

let spent = 0;
async function draw(prompt, refs = [], [width, height] = [1024, 768]) {
  const body = JSON.stringify({
    model: MODEL,
    prompt,
    quality: QUALITY,
    // Big sizes (boards) go as exact pixels, up to OpenAI's budget of about 3072x2304; small ones as an aspect ratio.
    ...(width > 2000 ? { size: `${width}x${height}` } : { aspect_ratio: width > height ? '4:3' : width < height ? '3:4' : '1:1' }),
    input_references: refs.map((file) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(file).toString('base64')}` } })),
    n: 1,
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_TOKEN}`, 'content-type': 'application/json' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    const image = data.data?.[0]?.b64_json;
    if (image) {
      spent += data.usage?.cost || 0;
      return Buffer.from(image, 'base64');
    }
    if (attempt >= 3) throw new Error(`${MODEL} failed: ${res.status} ${JSON.stringify(data.error || data).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

function loadArt(series) {
  const file = join(root, 'content/art', `${slug(series)}.json`);
  return { art: JSON.parse(readFileSync(file, 'utf8')), dir: join(root, 'content/art', slug(series)) };
}

// Who's in a page: the page's own `cast` list if it has one, else cast members whose match words appear in the
// scene description or the text.
function castFor(page, art) {
  if (page.cast) return page.cast;
  const words = ` ${`${page.picture || ''} ${page.text}`.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z ]/g, ' ')} `;
  return Object.entries(art.cast)
    .filter(([, c]) => c.match.some((m) => words.includes(` ${m} `)))
    .map(([id]) => id);
}

// A board at half size with each panel's number in its corner, for choosing panels.
async function preview(dir, id) {
  const W = 1536, H = 1152;
  const nums = Array.from({ length: 16 }, (_, i) => {
    const x = (i % 4) * (W / 4) + 14, y = Math.floor(i / 4) * (H / 4) + 14;
    return `<rect x="${x}" y="${y}" width="58" height="46" rx="10" fill="#3b1f4a" opacity="0.85"/>` +
      `<text x="${x + 29}" y="${y + 34}" font-family="sans-serif" font-size="30" font-weight="bold" fill="#fff" text-anchor="middle">${i + 1}</text>`;
  }).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${nums}</svg>`);
  await sharp(join(dir, 'boards', `${id}.jpg`)).resize(W, H).composite([{ input: svg }]).jpeg({ quality: 82 }).toFile(join(dir, 'boards', `${id}-numbered.jpg`));
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'sheet') {
  const [series, id, n = 4] = args;
  const { art, dir } = loadArt(series);
  const c = art.cast[id] || art.settings[id];
  mkdirSync(join(dir, 'candidates'), { recursive: true });
  const place = !art.cast[id];
  const prompt = place
    ? `${art.style} Reference picture of a place, wide view, empty, no people or animals: ${c.look}`
    : c.object
    ? `${art.style} Reference sheet: ${c.look} The object alone, empty, no people or animals, three-quarter view, on a plain warm off-white background, centered.`
    : `${art.style} Character reference sheet: ${c.look} Shown full body, standing, facing three-quarters toward the viewer, on a plain warm off-white background. One single figure, centered.`;
  for (let i = 1; i <= Number(n); i++) {
    const size = place ? art.size : [768, 1024];
    writeFileSync(join(dir, 'candidates', `${id}-${i}.jpg`), await webJpeg(await draw(prompt, [], size), size[0]));
    console.log(`candidate ${id}-${i}  $${spent.toFixed(2)} so far`);
  }
} else if (cmd === 'pages') {
  const [id, ...which] = args;
  const file = join(root, 'content/stories', `${id}.json`);
  const story = JSON.parse(readFileSync(file, 'utf8'));
  const { art, dir } = loadArt(story.series);
  const out = join(root, 'content/pictures', id);
  mkdirSync(out, { recursive: true });
  // --missing: only pages without a picture (keeps reused ones); numbers: just those; nothing: every page.
  const pages = which.includes('--missing')
    ? story.pages.map((p, i) => (p.image ? 0 : i + 1)).filter(Boolean)
    : which.length ? which.map(Number) : story.pages.map((_, i) => i + 1);
  // Pages are independent, so draw several at once (each takes ~30 s). The story file is rewritten as each one lands.
  const queue = [...pages];
  const worker = async () => {
    for (let n; (n = queue.shift()) !== undefined; ) {
      const page = story.pages[n - 1];
      // References: the sheet of everyone on the page, then the page's setting. Cast without a sheet is described in words.
      // A setting's `with` (the playhouse in the backyard) always comes along, so the place keeps its landmarks right.
      const cast = [...new Set([...castFor(page, art), ...(art.settings?.[page.setting]?.with || [])])];
      const drawn = cast.filter((c) => existsSync(join(dir, `${c}.jpg`)));
      const setting = page.setting && existsSync(join(dir, `${page.setting}.jpg`)) ? page.setting : null;
      const refs = [...drawn, ...(setting ? [setting] : [])].map((c) => join(dir, `${c}.jpg`));
      const who = drawn.map((c, i) => `Image ${i + 1} is the reference for ${art.cast[c].look} Keep this exact design, colours and outfit.`).join(' ');
      const others = cast.filter((c) => !drawn.includes(c)).map((c) => `Also in the scene: ${art.cast[c].look}`).join(' ');
      const place = !page.setting ? ''
        : setting ? `Image ${refs.length} shows the place where this happens: ${art.settings[setting].look} Keep the same place, layout and landmarks, seen from whatever angle suits the scene; it does not need to show all of it.`
        : `The place: ${art.settings[page.setting].look}`;
      const when = page.time ? `Time of day: ${page.time}.` : '';
      const prompt = `${art.style} ${who} ${others} ${place} ${when} Scene: ${page.picture}. The words on this page of the story are: "${page.text}"`.replace(/ +/g, ' ');
      writeFileSync(join(out, `${n}.jpg`), await webJpeg(await draw(prompt, refs, art.size), art.size[0]));
      page.image = `${id}/${n}.jpg`;
      delete page.draftImage;
      writeFileSync(file, JSON.stringify(story, null, 2) + '\n');
      console.log(`${id} page ${n}  [${[...cast, page.setting].filter(Boolean).join(', ') || 'no cast'}]  $${spent.toFixed(2)} so far`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
} else if (cmd === 'board') {
  // The chapter's raw text, the cast sheets and earlier boards; the model works out the scenes itself.
  const [id, ...withBoards] = args;
  const story = JSON.parse(readFileSync(join(root, 'content/stories', `${id}.json`), 'utf8'));
  const { art, dir } = loadArt(story.series);
  const boards = join(dir, 'boards');
  mkdirSync(boards, { recursive: true });
  const sheets = Object.keys(art.cast).filter((c) => existsSync(join(dir, `${c}.jpg`)));
  const refs = [...sheets.map((c) => join(dir, `${c}.jpg`)), ...withBoards.map((b) => join(boards, `${b}.jpg`))];
  const said = [
    ...sheets.map((c, i) => `Image ${i + 1} is ${art.cast[c].look} Keep this exact design.`),
    ...withBoards.map((b, i) => `Image ${sheets.length + i + 1} is the board for an earlier chapter of the same book: keep its places, objects, colours and style.`),
  ].join(' ');
  // Characters without a sheet are described only if this chapter mentions them: told about the black dragon
  // "if the story has" one, the chapter 5 board drew it anyway, two chapters early.
  const chapterText = ` ${story.pages.map((p) => p.text).join(' ').toLowerCase().replace(/[^a-z ]/g, ' ')} `;
  const unsheeted = Object.entries(art.cast)
    .filter(([c, v]) => !sheets.includes(c) && !v.object && v.match.some((m) => chapterText.includes(` ${m} `)))
    .map(([, v]) => `The ${v.match[0]} in this chapter is ${v.look}`).join(' ');
  const text = story.pages.map((p, i) => `Page ${i + 1}: ${p.text}`).join('\n');
  const prompt = `${art.style}

Illustrate this chapter of a children's picture book as ONE image: a 4 by 4 grid of 16 equal picture-book panels, read left to
right, top to bottom, following the story in order. Each panel is its own complete 4:3 illustration of one moment.
Thin plain white gutters between panels. No panel borders, no numbers, no captions, no speech bubbles, no text of any kind.
Keep the characters, places, objects, light and time of day consistent from panel to panel, as one illustrator drawing one book.

Reference images: ${said} ${unsheeted}

The chapter, "${story.title}":
${text}`;
  const png = await draw(prompt, refs, [3072, 2304]);
  // Boards are kept as JPEG at full size: they're references for later boards and the source of every page picture.
  await sharp(png).jpeg({ quality: 88, mozjpeg: true }).toFile(join(boards, `${id}.jpg`));
  await preview(dir, id);
  console.log(`${id} board  $${spent.toFixed(2)}`);
} else if (cmd === 'preview') {
  const story = JSON.parse(readFileSync(join(root, 'content/stories', `${args[0]}.json`), 'utf8'));
  await preview(loadArt(story.series).dir, args[0]);
} else if (cmd === 'pick') {
  // Cut a panel out of the board along its white gutters, scale it to the page size.
  const [id, ...picks] = args;
  const file = join(root, 'content/stories', `${id}.json`);
  const story = JSON.parse(readFileSync(file, 'utf8'));
  const { art, dir } = loadArt(story.series);
  const board = join(dir, 'boards', `${id}.jpg`);
  const { data, info } = await sharp(board).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const white = (v) => v > 235;
  // A gutter column/row is one that's almost all white.
  const colWhite = (x) => { let n = 0; for (let y = 0; y < H; y += 4) n += white(data[y * W + x]); return n / (H / 4) > 0.97; };
  const rowWhite = (y) => { let n = 0; for (let x = 0; x < W; x += 4) n += white(data[y * W + x]); return n / (W / 4) > 0.97; };
  const spans = (len, isWhite) => {
    const out = []; let start = null;
    for (let i = 0; i <= len; i++) {
      const w = i === len || isWhite(i);
      if (!w && start === null) start = i;
      if (w && start !== null) { if (i - start > len / 10) out.push([start, i]); start = null; }
    }
    return out;
  };
  const cols = spans(W, colWhite), rows = spans(H, rowWhite);
  if (cols.length !== 4 || rows.length !== 4) throw new Error(`expected a 4x4 grid, found ${cols.length}x${rows.length}`);
  const out = join(root, 'content/pictures', id);
  mkdirSync(out, { recursive: true });
  for (const pick of picks) {
    const [page, panel] = pick.split('=').map(Number);
    const [x0, x1] = cols[(panel - 1) % 4], [y0, y1] = rows[Math.floor((panel - 1) / 4)];
    const inset = 3; // trims any anti-aliased gutter edge
    const cut = await sharp(board).extract({ left: x0 + inset, top: y0 + inset, width: x1 - x0 - 2 * inset, height: y1 - y0 - 2 * inset })
      .resize(art.size[0], art.size[1], { fit: 'cover' }).toBuffer();
    writeFileSync(join(out, `${page}.jpg`), await webJpeg(cut, art.size[0]));
    story.pages[page - 1].image = `${id}/${page}.jpg`;
    story.pages[page - 1].panel = panel;
    console.log(`${id} page ${page} = panel ${panel}`);
  }
  writeFileSync(file, JSON.stringify(story, null, 2) + '\n');
} else if (cmd === 'cover') {
  const [id, n] = args;
  const file = join(root, 'content/stories', `${id}.json`);
  const story = JSON.parse(readFileSync(file, 'utf8'));
  story.coverImage = `${id}/${n}.jpg`;
  writeFileSync(file, JSON.stringify(story, null, 2) + '\n');
  console.log(`${id} cover = page ${n}`);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 16).join('\n'));
}

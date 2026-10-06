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
    aspect_ratio: width > height ? '4:3' : width < height ? '3:4' : '1:1',
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

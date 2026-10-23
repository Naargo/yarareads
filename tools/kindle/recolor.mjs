// Colors a book from home's black-and-white drawings with an image model via OpenRouter (OPENROUTER_API_TOKEN),
// extending each to 4:3. Consistency comes from a color key (the cast in color, approved first) and from
// coloring a chapter's drawings together on one 4x4 board, like illustrate.mjs.
//
//   node tools/kindle/recolor.mjs key <book>                      -> content/home/<book>/color/key.jpg
//   node tools/kindle/recolor.mjs board <book> <name> <NNN,...>   up to 16 drawings tiled on a grid, colored together
//                                                                  -> color/<name>.jpg (+ <name>-input.jpg, the grid sent)
//   node tools/kindle/recolor.mjs cut <book> <name>               cut the board into color/NNN.jpg (1024x768)
//   node tools/kindle/recolor.mjs one <book> <model> <NNN,...>    each drawing colored alone at full size -> color/final/NNN.jpg
//   node tools/kindle/recolor.mjs bakeoff <book> <model,...> <NNN,...>   the same through several models -> color/bakeoff/
//   node tools/kindle/recolor.mjs cover <book> <model> [aspect]   the book's cover (cover.jpg) redrawn to the library card's shape, title kept -> cover-color.jpg
//
// Every model call's cost goes to color/costs.log; each run prints the book's total so far.
// The cast and their colors live in content/home/<book>/color.json: { style, key: [{ name, look, ref }], panels: {NNN: who is in it},
// settings: {NNN: where it happens}, spreads: {NNN: the capture with the other half of a two-page picture} }.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

// As illustrate.mjs (importing it would run its command line): the art size at quality 80, ~60 KB.
const webJpeg = (buf, width = 1024) =>
  sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality: 80, progressive: true, mozjpeg: true }).toBuffer();

const root = new URL('../..', import.meta.url).pathname;
const [cmd, book, ...args] = process.argv.slice(2);
const dir = join(root, 'content/home', book);
const out = join(dir, 'color');
mkdirSync(out, { recursive: true });
const art = JSON.parse(readFileSync(join(dir, 'color.json'), 'utf8'));
// Boards: N x N cells (RECOLOR_GRID, default 4) on a 3072x2304 sheet, drawn by RECOLOR_MODEL (default gpt-image-2).
const W = 3072, H = 2304, N = Number(process.env.RECOLOR_GRID || 4), GUT = 24;
const CELL_W = Math.floor((W - (N + 1) * GUT) / N), CELL_H = Math.floor((H - (N + 1) * GUT) / N);
const BOARD_MODEL = process.env.RECOLOR_MODEL || 'openai/gpt-image-2';

let spent = 0;
// Books cost real money: no call starts once the book's log passes BUDGET (pass a higher one to go on).
const BUDGET = Number(process.env.RECOLOR_BUDGET || 5);
const total = () => existsSync(join(out, 'costs.log'))
  ? readFileSync(join(out, 'costs.log'), 'utf8').trim().split('\n').reduce((t, l) => t + Number(l.split('$')[1] || 0), 0) : 0;
async function draw(prompt, refs, size, model = 'openai/gpt-image-2', aspect = '4:3') {
  if (total() >= BUDGET) throw new Error(`budget: $${total().toFixed(2)} spent, over $${BUDGET} (RECOLOR_BUDGET)`);
  // OpenAI models take a quality and exact sizes; the others a resolution tier.
  const openai = model.startsWith('openai/');
  const body = JSON.stringify({
    model, prompt, n: 1,
    ...(openai ? { quality: 'medium' } : { resolution: size ? '4K' : '2K' }),
    ...(size && openai ? { size: `${size[0]}x${size[1]}` } : { aspect_ratio: aspect }),
    input_references: refs.map((file) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(file).toString('base64')}` } })),
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_TOKEN}`, 'content-type': 'application/json' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    let image = data.data?.[0]?.b64_json;
    if (!image && data.data?.[0]?.url) image = Buffer.from(await (await fetch(data.data[0].url)).arrayBuffer()).toString('base64');
    if (image) {
      const cost = data.usage?.cost || 0;
      spent += cost;
      appendFileSync(join(out, 'costs.log'), `${new Date().toISOString()}\t${model}\t${[cmd, ...args].join(' ').slice(0, 60)}\t$${cost.toFixed(4)}\n`);
      return Buffer.from(image, 'base64');
    }
    if (attempt >= 3) throw new Error(`image model: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
}

if (cmd === 'key') {
  const refs = art.key.map((c) => join(dir, `${c.ref}.jpg`));
  const prompt = `${art.style}
Draw a color character reference sheet for a children's book: ${art.key.length} characters side by side in two rows on a plain warm off-white background, each one full body, facing three-quarters toward the viewer, well apart from the others. No text, no labels.
${art.key.map((c, i) => `${i + 1}. ${c.look} Image ${i + 1} shows this character as drawn in the book, in black and white: keep that exact design and only add color.`).join('\n')}`;
  await sharp(await draw(prompt, refs, [W, H])).jpeg({ quality: 88, mozjpeg: true }).toFile(join(out, 'key.jpg'));
  console.log(`key.jpg  $${spent.toFixed(2)}`);
} else if (cmd === 'board') {
  // The original drawings, each fitted whole into a 4:3 cell on white with white gutters, in reading order.
  const [name, list] = args;
  const caps = list.split(',');
  const cells = await Promise.all(caps.map(async (n, i) => ({
    // a thin frame marks each panel: the drawings' white backgrounds would otherwise run into the gutters
    input: await sharp(join(dir, `${n}.jpg`)).resize(CELL_W - 12, CELL_H - 12, { fit: 'contain', background: '#fff' })
      .extend({ top: 6, bottom: 6, left: 6, right: 6, background: '#999' }).toBuffer(),
    left: GUT + (i % N) * (CELL_W + GUT), top: GUT + Math.floor(i / N) * (CELL_H + GUT),
  })));
  const input = join(out, `${name}-input.jpg`);
  await sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } }).composite(cells).jpeg({ quality: 90 }).toFile(input);
  const prompt = `${art.style}
Image 1 is a ${N} by ${N} board of ${caps.length} black-and-white drawings from one chapter of a children's book, read left to right, top to bottom${caps.length < N * N ? `; the last ${N * N - caps.length} cells are empty` : ''}.
Draw this same board in full color: the same panels in the same places, separated by the same plain white gutters.
In every panel keep the drawing exactly as it is (the same composition, poses, faces, expressions and line work) and color it.
Each drawing sits inside its 4:3 panel with white space around it: extend the scene naturally so the picture fills the whole panel edge to edge, with no white borders.
Remove any chapter number, shield, title or other lettering: no text anywhere.${caps.length < N * N ? ' Leave the empty cells plain white.' : ''}
Who is in each panel: ${caps.map((n, i) => art.panels?.[n] && `panel ${i + 1}: ${art.panels[n]}`).filter(Boolean).join('; ')}.
Image 2 is the color key for the cast: ${art.key.map((c) => c.name).join(', ')}, left to right, top row then bottom row. Every character must have exactly these colors in every panel.`;
  await sharp(await draw(prompt, [input, join(out, 'key.jpg')], [W, H], BOARD_MODEL)).jpeg({ quality: 88, mozjpeg: true }).toFile(join(out, `${name}.jpg`));
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ caps, n: N, model: BOARD_MODEL }));
  console.log(`${name}.jpg  ${caps.length} panels  $${spent.toFixed(2)}`);
} else if (cmd === 'one' || cmd === 'bakeoff') {
  // One drawing colored on its own at full size, with the color key. bakeoff: the same drawings through several models.
  const [models, list] = cmd === 'one' ? [[args[0]], args[1]] : [args[0].split(','), args[1]];
  const sub = cmd === 'one' ? join(out, 'final') : join(out, 'bakeoff');
  mkdirSync(sub, { recursive: true });
  const jobs = models.flatMap((model) => list.split(',').map((n) => ({ model, n })));
  const run = async ({ model, n }) => {
    // A picture drawn across two pages: both halves side by side, colored as one wide picture.
    const second = art.spreads?.[n];
    // color/annotated/NNN.png: the drawing with a grown-up's green labels on it (what's a road, what's a river)
    const annotated = existsSync(join(out, 'annotated', `${n}.png`));
    let input = annotated ? join(out, 'annotated', `${n}.png`) : join(dir, `${n}.jpg`);
    if (second) {
      const halves = await Promise.all([n, second].map((c) => sharp(join(dir, `${c}.jpg`)).resize({ height: 800 }).toBuffer({ resolveWithObject: true })));
      input = join(out, `spread-${n}.jpg`);
      await sharp({ create: { width: halves[0].info.width + halves[1].info.width, height: 800, channels: 3, background: '#fff' } })
        .composite([{ input: halves[0].data, left: 0, top: 0 }, { input: halves[1].data, left: halves[0].info.width, top: 0 }]).jpeg({ quality: 90 }).toFile(input);
    }
    const aspect = second ? '16:9' : '4:3';
    const prompt = `${art.style}
Image 1 is ${second ? 'one black-and-white picture from a children\'s chapter book that was printed across two facing pages: its left and right halves are side by side. Join them into one seamless picture and draw it' : 'one black-and-white drawing from a children\'s chapter book. Draw this same picture'} in full color.
Keep the drawing exactly as it is: the same composition, poses, faces, expressions and line work. Only add color.
Make it a ${aspect} landscape picture that fills the whole frame edge to edge: where the drawing doesn't reach the edges, extend the scene naturally. No white borders.
Remove any chapter number, shield, title or other lettering: no text anywhere.
${annotated ? 'The green words and green lines on image 1 are notes for you, saying what things are. Follow them, but do not draw them: no green labels, lines or arrows in the picture.' : ''}
${art.settings?.[n] ? `Where it happens: ${art.settings[n]}. Draw the background to match.` : ''}
${art.panels?.[n] ? `Who is in it: ${art.panels[n]}.` : ''}
Image 2 is the color key for the cast: ${art.key.map((c) => c.name).join(', ')}, left to right, top row then bottom row. Every character must have exactly these colors.`;
    const t0 = Date.now();
    try {
      const png = await draw(prompt, [input, join(out, 'key.jpg')], null, model, aspect);
      const file = cmd === 'one' ? join(sub, `${n}.jpg`) : join(sub, `${n}--${model.replace('/', '--')}.jpg`);
      writeFileSync(file, await sharp(png).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer());
      const meta = await sharp(png).metadata();
      console.log(`${model}  ${n}  ${meta.width}x${meta.height}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) { console.log(`${model}  ${n}  FAILED ${e.message.slice(0, 200)}`); }
  };
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(run));
} else if (cmd === 'cover') {
  // The library card is about 10:9, a book cover taller than wide: object-fit crops the title off. Redraw it wider.
  const [model, aspect = '5:4'] = args;
  const prompt = `Image 1 is the front cover of a children's book. Redraw it as a ${aspect} landscape picture: the same artwork, characters, colors and style, with the scene extended naturally at the sides.
Keep the title lettering exactly as on the cover, same font, colors and spelling, complete and uncut: "DRAGON MASTERS" and under it "RISE OF THE EARTH DRAGON". Put the title in the upper middle, with a margin on every side, so nothing touches an edge.
Remove the badge in the top right corner. No other text.
Keep everyone fully inside the frame: Drake the boy and Worm the dragon, his whole head.`;
  const png = await draw(prompt, [join(dir, 'cover.jpg')], null, model, aspect);
  writeFileSync(join(dir, 'cover-color.jpg'), await sharp(png).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer());
  console.log(`cover-color.jpg  ${aspect}  total for ${book}: $${total().toFixed(2)}`);
} else if (cmd === 'cut') {
  // The model keeps the grid only roughly, so find it along the white gutters (as illustrate.mjs pick does).
  const [name] = args;
  const board = join(out, `${name}.jpg`);
  const saved = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  const [caps, n] = Array.isArray(saved) ? [saved, 4] : [saved.caps, saved.n];
  const { data, info } = await sharp(board).greyscale().raw().toBuffer({ resolveWithObject: true });
  const white = (v) => v > 235;
  const colWhite = (x) => { let n = 0; for (let y = 0; y < info.height; y += 4) n += white(data[y * info.width + x]); return n / (info.height / 4) > 0.9; };
  const rowWhite = (y) => { let n = 0; for (let x = 0; x < info.width; x += 4) n += white(data[y * info.width + x]); return n / (info.width / 4) > 0.9; };
  const spans = (len, isWhite) => {
    const r = []; let start = null;
    for (let i = 0; i <= len; i++) {
      const w = i === len || isWhite(i);
      if (!w && start === null) start = i;
      if (w && start !== null) { if (i - start > len / 10) r.push([start, i]); start = null; }
    }
    return r;
  };
  const cols = spans(info.width, colWhite), rows = spans(info.height, rowWhite);
  if (cols.length !== n || rows.length < Math.ceil(caps.length / n)) throw new Error(`${board}: expected a ${n}-wide grid, found ${cols.length}x${rows.length}`);
  for (const [i, c] of caps.entries()) {
    const [x0, x1] = cols[i % n], [y0, y1] = rows[Math.floor(i / n)];
    const cut = await sharp(board).extract({ left: x0 + 3, top: y0 + 3, width: x1 - x0 - 6, height: y1 - y0 - 6 }).resize(Math.min(1600, x1 - x0), Math.round(Math.min(1600, x1 - x0) * 3 / 4), { fit: 'cover' }).toBuffer();
    writeFileSync(join(out, `${c}.jpg`), await webJpeg(cut, 1600));
  }
  console.log(`cut ${caps.length} panels from ${name}`);
}

console.log(`total for ${book}: $${total().toFixed(2)}`);

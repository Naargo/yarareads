// Phoneme experiment 2: instead of spelling a sound for a TTS voice ("sss", "tuh"), describe it to an
// instructable audio model and let it make the noise. OpenAI gpt-audio and gpt-audio-mini via OpenRouter
// (no sound-effects model is offered on Cloudflare or OpenRouter). The takes are added to the Sound lab's
// live manifest next to the TTS ones, so Eli compares them in the same place; existing picks are kept.
//
//   node tools/sounds-describe.mjs [--local]
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const where = process.argv.includes('--local') ? '--local' : '--remote';

// How each sound is made, as a phonics teacher would describe it. Stops get "no uh after it".
const DESCRIBE = {
  s: 'a long hissing "sss", like a snake, about one second, with no vowel after it.',
  m: 'a hummed "mmm" with the lips closed, like something tastes good, about one second.',
  f: 'a long "fff": air blown between the top teeth and the bottom lip, no voice, about one second.',
  sh: 'a long "shhh", like telling someone to be quiet, about one second.',
  n: 'a hummed "nnn" through the nose with the tongue up behind the top teeth, about one second.',
  l: 'a long "lll" with the tongue behind the top teeth, about one second.',
  z: 'a long buzzing "zzz", like a bee, about one second.',
  v: 'a long buzzing "vvv": top teeth on the bottom lip, with voice, about one second.',
  t: 'one short, clipped "t": a quick tap of the tongue, no "uh" after it.',
  p: 'one short, clipped "p": the lips pop, no "uh" after it.',
  k: 'one short, clipped "k" from the back of the mouth, no "uh" after it.',
  b: 'one short "b": the lips bounce, with as little "uh" after it as possible.',
  d: 'one short "d": a tap of the tongue, with as little "uh" after it as possible.',
  g: 'one short, hard "g" as at the start of "got", with as little "uh" after it as possible.',
  a: 'the short vowel "a" as in "ant", British, said once.',
  e: 'the short vowel "e" as in "egg", said once.',
  i: 'the short vowel "i" as in "ink", said once.',
  o: 'the short British vowel "o" as in "on" and "dog", said once.',
  u: 'the short vowel "u" as in "up", said once.',
  ai: 'the long vowel "ai" as in "rain", said once.',
  ee: 'the long vowel "ee" as in "see", said once.',
  igh: 'the vowel "igh" as in "night", which sounds like the word "eye", said once.',
  oa: 'the vowel "oa" as in "boat", British, said once.',
  oo: 'the long vowel "oo" as in "moon", said once.',
  ar: 'the vowel "ar" as in "car", British with no r sound, said once.',
  or: 'the vowel "or" as in "fork", British with no r sound, said once.',
  ur: 'the vowel "ur" as in "fur", British with no r sound, said once.',
  ow: 'the vowel "ow" as in "cow", said once.',
  oi: 'the vowel "oi" as in "coin", said once.',
  ch: 'one short "ch" as in "chip", with no "uh" after it.',
  th: 'a long "th" as in "thin": air between the tongue and the top teeth, no voice, about one second.',
};
const MODELS = { 'gpt-mini': 'openai/gpt-audio-mini', gpt: 'openai/gpt-audio' };

// The model streams 24 kHz 16-bit mono PCM; we wrap it in a WAV header.
async function describe(model, sound) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, modalities: ['text', 'audio'], audio: { voice: 'shimmer', format: 'pcm16' }, stream: true,
      messages: [
        { role: 'system', content: 'You are a British phonics teacher recording sound buttons for a 6-year-old. You output only the requested sound, never words, never commentary.' },
        { role: 'user', content: `Make only the pure phonics sound for "${sound}": ${DESCRIBE[sound]} Nothing before or after it.` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${model} ${sound}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const chunks = [];
  let buf = '', cost = 0;
  for await (const part of res.body) {
    buf += Buffer.from(part).toString();
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const d = JSON.parse(line.slice(5));
      const audio = d.choices?.[0]?.delta?.audio;
      if (audio?.data) chunks.push(Buffer.from(audio.data, 'base64'));
      if (d.usage?.cost) cost = d.usage.cost;
    }
  }
  const pcm = Buffer.concat(chunks);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([h, pcm]), cost };
}

// Start from the live manifest (it holds the TTS takes), and replace only our own voices' takes.
const dir = join(root, 'content/sounds');
const manifestFile = join(dir, 'candidates.json');
mkdirSync(dir, { recursive: true });
execFileSync('npx', ['wrangler', 'r2', 'object', 'get', 'yara-reads-pictures/sounds/candidates.json', where, '--file', manifestFile], { stdio: 'ignore' });
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

let spent = 0;
const jobs = manifest.flatMap((entry) => Object.keys(MODELS).map((voice) => ({ entry, voice })));
const worker = async () => {
  for (let job; (job = jobs.shift()); ) {
    const { entry, voice } = job;
    const key = `candidates/${entry.sound}/${voice}-1.wav`;
    const file = join(dir, key);
    mkdirSync(join(dir, 'candidates', entry.sound), { recursive: true });
    if (!existsSync(file)) {
      const { wav, cost } = await describe(MODELS[voice], entry.sound);
      writeFileSync(file, wav);
      spent += cost;
    }
    entry.takes = [...entry.takes.filter((t) => t.key !== key), { key, voice, text: 'described' }];
    process.stdout.write(`${entry.sound}/${voice} `);
  }
};
await Promise.all([1, 2, 3, 4].map(worker));
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
console.log(`\n$${spent.toFixed(4)}`);

const put = (key, file, type) => execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `yara-reads-pictures/sounds/${key}`,
  where, '--file', file, '--content-type', type], { stdio: 'ignore' });
for (const e of manifest) for (const t of e.takes) if (MODELS[t.voice]) put(t.key, join(dir, t.key), 'audio/wav');
put('candidates.json', manifestFile, 'application/json');
console.log(`uploaded (${where})`);

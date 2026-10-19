// API for Yara Reads. Static files are served from public/; everything under /api/ lands here.

import publicInventory from '../content/inventory.json';
import { verifyLogin } from './verify-login.js';

// Tokens from login.finereli.com are made for one origin; these are ours (wrangler dev serves on 8787).
const AUDIENCE = ['https://yarareads.finereli.com', 'http://localhost:8787'];
// What existed before accounts is held by this account, until env.FAMILY_EMAIL (a secret: Yara's Google account) first
// signs in and adopts it. Its books, inventory, settings and progress then belong to her.
const FAMILY = 'family';
const INVENTORY_SEED = () => { const { _note, ...inv } = publicInventory; return { ...inv, names: [] }; };

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

// Voices for words, from Cloudflare Workers AI. Ids are "<model>:<speaker>"; the grown-ups Voice tab lists these.
// Aura is Deepgram's (mp3); MeloTTS returns base64 WAV in JSON.
const VOICES = {
  'aura-2:pandora': { model: '@cf/deepgram/aura-2-en', speaker: 'pandora', label: 'Pandora', about: 'British woman' },
  'aura-2:draco': { model: '@cf/deepgram/aura-2-en', speaker: 'draco', label: 'Draco', about: 'British man' },
  'aura-2:theia': { model: '@cf/deepgram/aura-2-en', speaker: 'theia', label: 'Theia', about: 'Australian woman' },
  'aura-2:hyperion': { model: '@cf/deepgram/aura-2-en', speaker: 'hyperion', label: 'Hyperion', about: 'Australian man' },
  'aura-2:luna': { model: '@cf/deepgram/aura-2-en', speaker: 'luna', label: 'Luna', about: 'American woman' },
  'aura-2:asteria': { model: '@cf/deepgram/aura-2-en', speaker: 'asteria', label: 'Asteria', about: 'American woman' },
  'aura-2:apollo': { model: '@cf/deepgram/aura-2-en', speaker: 'apollo', label: 'Apollo', about: 'American man' },
};
const DEFAULT_VOICE = 'aura-2:hyperion'; // Eli's pick (Oct 7)

// Say one word in a voice: from the R2 cache (tts2/<voice>/<word>.<ext>), or generated once and stored.
// The word goes in as a sentence ("playing."): as a bare word Aura stops mid-sound and clips the end
// (Hyperion's "playing" ended at full volume, mid "ng"); with the full stop it fades out naturally.
// tts/ holds the old, sometimes clipped bare-word audio; tts2/ is the fixed set.
async function sayWord(env, voiceId, word) {
  const voice = VOICES[voiceId];
  const ext = 'mp3';
  const type = 'audio/mpeg';
  const key = `tts2/${voiceId.replace(':', '-')}/${encodeURIComponent(word)}.${ext}`;
  const cached = await env.PICTURES.get(key);
  if (cached) return { body: cached.body, type };
  const out = voice.speaker
    ? await env.AI.run(voice.model, { text: `${word}.`, speaker: voice.speaker, encoding: 'mp3' })
    : await env.AI.run(voice.model, { prompt: `${word}.`, lang: 'en' });
  let bytes;
  if (out instanceof ReadableStream) bytes = await new Response(out).arrayBuffer();
  else if (out?.audio) bytes = Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0));
  else bytes = out;
  await env.PICTURES.put(key, bytes, { httpMetadata: { contentType: type } });
  return { body: bytes, type };
}

// The public site: the same app on another hostname (env.PUBLIC_HOST), with no sign-in. It only ever shows our
// own stories, never books from home (other people's books), and never touches Yara's data: her inventory,
// settings and events need a sign-in. Parents keep their child's sounds and progress on their own device.
const isPublic = (url, env) => !!env.PUBLIC_HOST && url.hostname === env.PUBLIC_HOST;
const OUR_STORIES = "coalesce(json_extract(body, '$.kind'), 'story') != 'book'";

// What the word card's speaker button does (grown-ups > Voice). soundOut on: sound the word out first (each sound button
// lights and plays its recording), then say it. Off: just say the word. Tapping a sound button to hear it is always on.
const SOUND_DEFAULTS = { soundOut: true };
const soundSettings = async (env, sub) => Object.fromEntries(await Promise.all(Object.entries(SOUND_DEFAULTS).map(async ([k, d]) =>
  [k, (await setting(env, sub, k, d ? '1' : '0')) === '1'])));

async function setting(env, sub, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM account_settings WHERE sub = ? AND key = ?').bind(sub, key).first();
  return row ? row.value : fallback;
}

// Who is asking: a Google sign-in (Bearer token from login.finereli.com). Returns { sub, email, name } or null.
async function account(request, env) {
  const claims = await verifyLogin(request, { audience: AUDIENCE });
  if (!claims) return null;
  if (env.FAMILY_EMAIL && claims.email_verified && claims.email.toLowerCase() === env.FAMILY_EMAIL.toLowerCase()) {
    await adoptFamily(env, claims.sub);
  }
  return { sub: claims.sub, email: claims.email, name: claims.name };
}

// Hand what existed before accounts to this account. Safe to run twice at once (the app makes several requests at
// startup): each step copies from 'family' and then empties it, in one transaction, so the second run finds nothing.
async function adoptFamily(env, sub) {
  if (!(await env.DB.prepare('SELECT 1 FROM account_inventory WHERE sub = ?').bind(FAMILY).first())) return;
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO account_inventory (sub, body, updated_at) SELECT ?, body, updated_at FROM account_inventory WHERE sub = ?').bind(sub, FAMILY),
    env.DB.prepare('DELETE FROM account_inventory WHERE sub = ?').bind(FAMILY),
    env.DB.prepare('INSERT OR REPLACE INTO account_settings (sub, key, value, updated_at) SELECT ?, key, value, updated_at FROM account_settings WHERE sub = ?').bind(sub, FAMILY),
    env.DB.prepare('DELETE FROM account_settings WHERE sub = ?').bind(FAMILY),
    env.DB.prepare('UPDATE events SET sub = ? WHERE sub = ?').bind(sub, FAMILY),
    env.DB.prepare('UPDATE stories SET owner = ? WHERE owner = ?').bind(sub, FAMILY),
  ]);
}

// A story this account may see: the shared library, or its own books.
const VISIBLE = '(owner IS NULL OR owner = ?)';

// The public site's API: the reader's routes, limited to our stories. Everything else (grown-ups' tools,
// Yara's settings and progress) is refused.
async function publicApi(request, env, url, path) {
  const get = request.method === 'GET';
  if (path === '/api/stories' && get) {
    const { results } = await env.DB.prepare(
      `SELECT id, series, number, title, json_extract(body, '$.cover') AS cover,
         json_extract(body, '$.coverImage') AS coverImage, 'story' AS kind, 0 AS finished
       FROM stories WHERE ${OUR_STORIES} ORDER BY series, number`,
    ).all();
    return json(results);
  }
  const storyMatch = path.match(/^\/api\/stories\/([\w-]+)$/);
  if (storyMatch && get) {
    const row = await env.DB.prepare(`SELECT body FROM stories WHERE id = ? AND ${OUR_STORIES}`).bind(storyMatch[1]).first();
    if (!row) return json({ error: 'not found' }, { status: 404 });
    return new Response(row.body, { headers: { 'content-type': 'application/json' } });
  }
  // Only pictures that one of our stories uses.
  const picture = path.match(/^\/api\/pictures\/([\w-]+\/[\w.-]+)$/);
  if (picture && get) {
    const used = await env.DB.prepare(`SELECT 1 FROM stories WHERE ${OUR_STORIES} AND instr(body, ?) > 0 LIMIT 1`)
      .bind(`"${picture[1]}`).first();
    const obj = used && (await env.PICTURES.get(picture[1]));
    if (!obj) return json({ error: 'not found' }, { status: 404 });
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
        'cache-control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, no-cache',
        etag: obj.httpEtag,
      },
    });
  }
  // The phonics sounds the tiles play (Eli's recordings; he chose to share them, Oct 16). Only those: not the
  // AI takes, nor the example words recorded with them.
  const recorded = path.match(/^\/api\/sounds\/(recorded\/[a-z]+\/[a-z-]+\.mp3)$/);
  if (recorded && get) {
    const obj = await env.PICTURES.get(`sounds/${recorded[1]}`);
    if (!obj) return json({ error: 'not found' }, { status: 404 });
    return new Response(obj.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=3600' } });
  }
  // Words already made for the books, in the chosen voice. Never generates new audio (that costs money);
  // a missing word falls back to the browser's voice.
  if (path === '/api/say' && get) {
    const word = (url.searchParams.get('word') || '').toLowerCase().replace(/[^a-z' -]/g, '').trim().slice(0, 40);
    const voiceId = DEFAULT_VOICE;
    const ext = 'mp3';
    const obj = word && (await env.PICTURES.get(`tts2/${voiceId.replace(':', '-')}/${encodeURIComponent(word)}.${ext}`));
    if (!obj) return json({ error: 'not ready' }, { status: 404 });
    return new Response(obj.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400' } });
  }
  if (path === '/api/settings' && get) {
    return json({ voice: DEFAULT_VOICE, voices: {}, public: true, ...SOUND_DEFAULTS });
  }
  // The starting sounds: Teach Your Monster to Read's, which the stories are written for. Edits stay on the device.
  if (path === '/api/inventory' && get) {
    const { _note, ...inv } = publicInventory;
    return json({ ...inv, names: [] });
  }
  if (path === '/api/events' && request.method === 'POST') {
    const e = await request.json().catch(() => ({}));
    if (['open', 'page', 'finish'].includes(e.type)) {
      await env.DB.prepare('INSERT INTO public_events (type, story_id, page) VALUES (?, ?, ?)')
        .bind(e.type, typeof e.storyId === 'string' ? e.storyId.slice(0, 40) : null, Number.isInteger(e.page) ? e.page : null).run();
    }
    return json({ ok: true });
  }
  return json({ error: 'not on the public site' }, { status: 403 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const pub = isPublic(url, env);

    // Crawlers: the public site is indexable once env.PUBLIC_INDEX is '1'; Yara's never is.
    if (path === '/robots.txt') {
      const open = pub && env.PUBLIC_INDEX === '1';
      return new Response(open ? `User-agent: *\nAllow: /\n\nSitemap: https://${url.hostname}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n',
        { headers: { 'content-type': 'text/plain' } });
    }
    if (path === '/sitemap.xml') {
      if (!pub) return new Response('Not found', { status: 404 });
      const loc = (p) => `<url><loc>https://${url.hostname}${p}</loc></url>`;
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
        ['/about', '/', '/llms.txt'].map(loc).join('')}</urlset>\n`, { headers: { 'content-type': 'application/xml' } });
    }

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (pub) {
      return publicApi(request, env, url, path);
    }

    const who = await account(request, env);
    if (!who) return json({ error: 'sign in' }, { status: 401 });
    const sub = who.sub;

    if (path === '/api/stories' && request.method === 'GET') {
      await env.DB.prepare(
        'INSERT INTO accounts (sub, email, name) VALUES (?, ?, ?) ON CONFLICT (sub) DO UPDATE SET email = excluded.email, name = excluded.name, seen_at = CURRENT_TIMESTAMP',
      ).bind(sub, who.email, who.name ?? null).run();
      const { results: stories } = await env.DB.prepare(
        `SELECT id, series, number, title, json_extract(body, '$.cover') AS cover,
           json_extract(body, '$.coverImage') AS coverImage, coalesce(json_extract(body, '$.kind'), 'story') AS kind
         FROM stories WHERE ${VISIBLE} ORDER BY kind = 'book', series, number`,
      ).bind(sub).all();
      const { results: done } = await env.DB.prepare(
        "SELECT story_id, COUNT(*) AS times FROM events WHERE type = 'finish' AND sub = ? GROUP BY story_id",
      ).bind(sub).all();
      const times = Object.fromEntries(done.map((d) => [d.story_id, d.times]));
      return json(stories.map((s) => ({ ...s, finished: times[s.id] || 0 })));
    }

    const storyMatch = path.match(/^\/api\/stories\/([\w-]+)$/);
    if (storyMatch && request.method === 'GET') {
      const row = await env.DB.prepare(`SELECT body FROM stories WHERE id = ? AND ${VISIBLE}`).bind(storyMatch[1], sub).first();
      if (!row) return json({ error: 'not found' }, { status: 404 });
      return new Response(row.body, { headers: { 'content-type': 'application/json' } });
    }

    // Page pictures live in R2, behind sign-in: some are scans of books we own, so only a picture used by a story
    // this account can see is served.
    const picture = path.match(/^\/api\/pictures\/([\w-]+\/[\w.-]+)$/);
    if (picture && request.method === 'GET') {
      const used = await env.DB.prepare(`SELECT 1 FROM stories WHERE ${VISIBLE} AND instr(body, ?) > 0 LIMIT 1`)
        .bind(sub, `"${picture[1]}`).first();
      const obj = used && (await env.PICTURES.get(picture[1]));
      if (!obj) return json({ error: 'not found' }, { status: 404 });
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
          // Stories link pictures as <key>?v=<content hash>, so a versioned URL never changes and can be kept for good.
          // An unversioned request (an old copy of the app) revalidates every time.
          'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
          etag: obj.httpEtag,
        },
      });
    }

    // Phonics sound audio (recordings), also in R2, under sounds/.
    const sound = path.match(/^\/api\/sounds\/([\w./-]+)$/);
    if (sound && request.method === 'GET' && !sound[1].includes('..')) {
      const obj = await env.PICTURES.get(`sounds/${sound[1]}`);
      if (!obj) return json({ error: 'not found' }, { status: 404 });
      return new Response(obj.body, {
        headers: { 'content-type': obj.httpMetadata?.contentType || 'audio/mpeg', 'cache-control': 'private, max-age=3600' },
      });
    }

    // A word, spoken. The voice is the grown-ups' choice unless ?voice= asks for another (the Voice tab's test).
    if (path === '/api/say' && request.method === 'GET') {
      const word = (url.searchParams.get('word') || '').toLowerCase().replace(/[^a-z' -]/g, '').trim().slice(0, 40);
      if (!word) return json({ error: 'no word' }, { status: 400 });
      const asked = url.searchParams.get('voice');
      const voiceId = VOICES[asked] ? asked : await setting(env, sub, 'voice', DEFAULT_VOICE);
      try {
        const { body, type } = await sayWord(env, VOICES[voiceId] ? voiceId : DEFAULT_VOICE, word);
        return new Response(body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' } });
      } catch (e) {
        return json({ error: String(e.message || e).slice(0, 200) }, { status: 502 });
      }
    }

    if (path === '/api/settings' && request.method === 'GET') {
      return json({ voice: await setting(env, sub, 'voice', DEFAULT_VOICE), voices: VOICES, ...(await soundSettings(env, sub)) });
    }
    // Any of: voice, soundOut.
    if (path === '/api/settings' && request.method === 'PUT') {
      const body = await request.json();
      const set = (k, v) => env.DB.prepare('INSERT OR REPLACE INTO account_settings (sub, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').bind(sub, k, v).run();
      if ('voice' in body) {
        if (!VOICES[body.voice]) return json({ error: 'bad voice' }, { status: 400 });
        await set('voice', body.voice);
      }
      for (const k of Object.keys(SOUND_DEFAULTS)) {
        if (k in body) {
          if (typeof body[k] !== 'boolean') return json({ error: `bad ${k}` }, { status: 400 });
          await set(k, body[k] ? '1' : '0');
        }
      }
      return json({ ok: true });
    }

    // What Yara knows. Edited from the grown-ups section.
    if (path === '/api/inventory' && request.method === 'GET') {
      // A new account starts with the Teach Your Monster to Read sounds, which the shared library is written for.
      const row = await env.DB.prepare('SELECT body FROM account_inventory WHERE sub = ?').bind(sub).first();
      return new Response(row ? row.body : JSON.stringify(INVENTORY_SEED()), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (path === '/api/inventory' && request.method === 'PUT') {
      const inv = await request.json();
      const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length < 40);
      if (!strings(inv.graphemes) || !strings(inv.tricky) || !strings(inv.names)) {
        return json({ error: 'bad inventory' }, { status: 400 });
      }
      const body = JSON.stringify({ graphemes: inv.graphemes, tricky: inv.tricky, names: inv.names });
      await env.DB.prepare(
        'INSERT OR REPLACE INTO account_inventory (sub, body, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      ).bind(sub, body).run();
      return json({ ok: true });
    }

    if (path === '/api/events' && request.method === 'POST') {
      const e = await request.json();
      await env.DB.prepare('INSERT INTO events (type, story_id, page, word, detail, sub) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(String(e.type).slice(0, 32), e.storyId ?? null, e.page ?? null, e.word ?? null, e.detail ? String(e.detail).slice(0, 200) : null, sub)
        .run();
      return json({ ok: true });
    }

    // For grown-ups: which words she taps most, i.e. what to practise next.
    if (path === '/api/progress' && request.method === 'GET') {
      const { results: taps } = await env.DB.prepare(
        "SELECT word, COUNT(*) AS taps FROM events WHERE type = 'tap' AND sub = ? GROUP BY word ORDER BY taps DESC LIMIT 40",
      ).bind(sub).all();
      const { results: days } = await env.DB.prepare(
        "SELECT date(ts) AS day, COUNT(DISTINCT story_id) AS stories, SUM(type = 'page') AS pages FROM events WHERE sub = ? GROUP BY day ORDER BY day DESC LIMIT 14",
      ).bind(sub).all();
      // How word audio went on each device (logged by the app every time a word is said).
      const { results: sounds } = await env.DB.prepare(
        "SELECT ts, word, detail FROM events WHERE type = 'say' AND sub = ? ORDER BY id DESC LIMIT 60",
      ).bind(sub).all();
      return json({ taps, days, sounds });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
};

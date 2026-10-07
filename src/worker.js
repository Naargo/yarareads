// API for Yara Reads. Static files are served from public/; everything under /api/ lands here.

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

async function sessionToken(env) {
  const bytes = new TextEncoder().encode(`${env.PIN}:${env.SESSION_SECRET}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookie(request, name) {
  const match = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match && match[1];
}

// Voices for words, from Cloudflare Workers AI. Ids are "<model>:<speaker>"; the grown-ups Voice tab lists these.
// Aura is Deepgram's (mp3); MeloTTS returns base64 WAV in JSON.
const VOICES = {
  'aura-2:pandora': { model: '@cf/deepgram/aura-2-en', speaker: 'pandora', label: 'Pandora', about: 'British woman' },
  'aura-2:draco': { model: '@cf/deepgram/aura-2-en', speaker: 'draco', label: 'Draco', about: 'British man' },
  'aura-1:athena': { model: '@cf/deepgram/aura-1', speaker: 'athena', label: 'Athena', about: 'British woman, older model' },
  'aura-1:helios': { model: '@cf/deepgram/aura-1', speaker: 'helios', label: 'Helios', about: 'British man, older model' },
  'aura-2:theia': { model: '@cf/deepgram/aura-2-en', speaker: 'theia', label: 'Theia', about: 'Australian woman' },
  'aura-2:hyperion': { model: '@cf/deepgram/aura-2-en', speaker: 'hyperion', label: 'Hyperion', about: 'Australian man' },
  'aura-2:luna': { model: '@cf/deepgram/aura-2-en', speaker: 'luna', label: 'Luna', about: 'American woman' },
  'aura-2:asteria': { model: '@cf/deepgram/aura-2-en', speaker: 'asteria', label: 'Asteria', about: 'American woman' },
  'aura-2:apollo': { model: '@cf/deepgram/aura-2-en', speaker: 'apollo', label: 'Apollo', about: 'American man' },
  'melo:en': { model: '@cf/myshell-ai/melotts', label: 'Melo', about: 'Open-source voice' },
};
const DEFAULT_VOICE = 'aura-2:hyperion'; // Eli's pick (Oct 7)

// Say one word in a voice: from the R2 cache (tts2/<voice>/<word>.<ext>), or generated once and stored.
// The word goes in as a sentence ("playing."): as a bare word Aura stops mid-sound and clips the end
// (Hyperion's "playing" ended at full volume, mid "ng"); with the full stop it fades out naturally.
// tts/ holds the old, sometimes clipped bare-word audio; tts2/ is the fixed set.
async function sayWord(env, voiceId, word) {
  const voice = VOICES[voiceId];
  const ext = voiceId.startsWith('melo') ? 'wav' : 'mp3';
  const type = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
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

async function setting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/login' && request.method === 'POST') {
      const { pin } = await request.json().catch(() => ({}));
      if (String(pin) !== String(env.PIN)) return json({ ok: false }, { status: 401 });
      const token = await sessionToken(env);
      return json({ ok: true }, {
        headers: { 'set-cookie': `yr=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` },
      });
    }

    if (cookie(request, 'yr') !== (await sessionToken(env))) return json({ error: 'pin' }, { status: 401 });

    if (path === '/api/stories' && request.method === 'GET') {
      const { results: stories } = await env.DB.prepare(
        `SELECT id, series, number, title, json_extract(body, '$.cover') AS cover,
           json_extract(body, '$.coverImage') AS coverImage, coalesce(json_extract(body, '$.kind'), 'story') AS kind
         FROM stories ORDER BY kind = 'book', series, number`,
      ).all();
      const { results: done } = await env.DB.prepare(
        "SELECT story_id, COUNT(*) AS times FROM events WHERE type = 'finish' GROUP BY story_id",
      ).all();
      const times = Object.fromEntries(done.map((d) => [d.story_id, d.times]));
      return json(stories.map((s) => ({ ...s, finished: times[s.id] || 0 })));
    }

    const storyMatch = path.match(/^\/api\/stories\/([\w-]+)$/);
    if (storyMatch && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT body FROM stories WHERE id = ?').bind(storyMatch[1]).first();
      if (!row) return json({ error: 'not found' }, { status: 404 });
      return new Response(row.body, { headers: { 'content-type': 'application/json' } });
    }

    // Page pictures live in R2, behind the PIN like everything else: some are scans of books we own.
    const picture = path.match(/^\/api\/pictures\/([\w-]+\/[\w.-]+)$/);
    if (picture && request.method === 'GET') {
      const obj = await env.PICTURES.get(picture[1]);
      if (!obj) return json({ error: 'not found' }, { status: 404 });
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
          'cache-control': 'private, max-age=604800',
          etag: obj.httpEtag,
        },
      });
    }

    // Phonics sound audio (candidates and recordings), also in R2, under sounds/.
    const sound = path.match(/^\/api\/sounds\/([\w./-]+)$/);
    if (sound && request.method === 'GET' && !sound[1].includes('..')) {
      const obj = await env.PICTURES.get(`sounds/${sound[1]}`);
      if (!obj) return json({ error: 'not found' }, { status: 404 });
      return new Response(obj.body, {
        headers: { 'content-type': obj.httpMetadata?.contentType || 'audio/mpeg', 'cache-control': 'private, max-age=3600' },
      });
    }

    // Which audio plays for each sound, picked in the Sound lab.
    if (path === '/api/sound-picks' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT sound, key FROM sound_picks').all();
      return json(Object.fromEntries(results.map((r) => [r.sound, r.key])));
    }
    if (path === '/api/sound-picks' && request.method === 'PUT') {
      const { sound: s, key } = await request.json();
      if (typeof s !== 'string' || s.length > 20) return json({ error: 'bad sound' }, { status: 400 });
      if (key) {
        await env.DB.prepare('INSERT OR REPLACE INTO sound_picks (sound, key, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
          .bind(s, String(key).slice(0, 200)).run();
      } else {
        await env.DB.prepare('DELETE FROM sound_picks WHERE sound = ?').bind(s).run();
      }
      return json({ ok: true });
    }

    // A word, spoken. The voice is the grown-ups' choice unless ?voice= asks for another (the Voice tab's test).
    if (path === '/api/say' && request.method === 'GET') {
      const word = (url.searchParams.get('word') || '').toLowerCase().replace(/[^a-z' -]/g, '').trim().slice(0, 40);
      if (!word) return json({ error: 'no word' }, { status: 400 });
      const asked = url.searchParams.get('voice');
      const voiceId = VOICES[asked] ? asked : await setting(env, 'voice', DEFAULT_VOICE);
      try {
        const { body, type } = await sayWord(env, VOICES[voiceId] ? voiceId : DEFAULT_VOICE, word);
        return new Response(body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' } });
      } catch (e) {
        return json({ error: String(e.message || e).slice(0, 200) }, { status: 502 });
      }
    }

    if (path === '/api/settings' && request.method === 'GET') {
      return json({ voice: await setting(env, 'voice', DEFAULT_VOICE), voices: VOICES });
    }
    if (path === '/api/settings' && request.method === 'PUT') {
      const { voice } = await request.json();
      if (!VOICES[voice]) return json({ error: 'bad voice' }, { status: 400 });
      await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .bind('voice', voice).run();
      return json({ ok: true });
    }

    // What Yara knows. Edited from the grown-ups section.
    if (path === '/api/inventory' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT body FROM inventory WHERE id = 1').first();
      return new Response(row ? row.body : '{"graphemes":[],"tricky":[],"names":[]}', {
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
        'INSERT OR REPLACE INTO inventory (id, body, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)',
      ).bind(body).run();
      return json({ ok: true });
    }

    if (path === '/api/events' && request.method === 'POST') {
      const e = await request.json();
      await env.DB.prepare('INSERT INTO events (type, story_id, page, word) VALUES (?, ?, ?, ?)')
        .bind(String(e.type).slice(0, 32), e.storyId ?? null, e.page ?? null, e.word ?? null)
        .run();
      return json({ ok: true });
    }

    // For grown-ups: which words she taps most, i.e. what to practise next.
    if (path === '/api/progress' && request.method === 'GET') {
      const { results: taps } = await env.DB.prepare(
        "SELECT word, COUNT(*) AS taps FROM events WHERE type = 'tap' GROUP BY word ORDER BY taps DESC LIMIT 40",
      ).all();
      const { results: days } = await env.DB.prepare(
        "SELECT date(ts) AS day, COUNT(DISTINCT story_id) AS stories, SUM(type = 'page') AS pages FROM events GROUP BY day ORDER BY day DESC LIMIT 14",
      ).all();
      return json({ taps, days });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
};

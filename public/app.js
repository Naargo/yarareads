import { tokenize, isWord, normalize, classify, unreadable, forStory, letters, CATALOG_GROUPS } from './phonics.js';
import { ICONS, STAR, LOGO, cover } from './art.js';
import { FinereliLogin } from './login.js';

const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BRAND = `<div class="brand">${LOGO}<span class="name">Yara <em>Reads</em></span></div>`;

// ---------- API ----------

// Signing in goes through login.finereli.com (Google). Each account has its own sounds, voice, books and progress.
const login = new FinereliLogin({ storageKey: 'yr.login' });
// Page pictures are plain <img> requests that can't carry the token, so signing in also leaves it in a cookie
// (read-only on the server). Signed out, the cookie is cleared.
const syncSession = () => fetch('/api/session', login.token
  ? { method: 'POST', headers: { authorization: `Bearer ${login.token}` } }
  : { method: 'DELETE' }).catch(() => {});
const loginReady = login.handleRedirect().then(syncSession);

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(login.token && { authorization: `Bearer ${login.token}` }) },
    body: options.body && JSON.stringify(options.body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Signed out, the worker gives the free version (our own books, no sign-in): a child's sounds and finished books stay on
// this device. Signed in, they're kept on the account.
let PUBLIC = false;
const modeReady = loginReady
  .then(() => fetch('/api/settings', { headers: login.token ? { authorization: `Bearer ${login.token}` } : {} }))
  .then((r) => (r.ok ? r.json() : {}))
  .then((s) => {
    PUBLIC = !!s.public;
    if (PUBLIC) login.handleUnauthorized(); // a token the worker no longer accepts
  })
  .catch(() => {});
const local = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('yr.' + k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('yr.' + k, JSON.stringify(v)); } catch {} },
};

function log(type, data = {}) {
  api('events', { method: 'POST', body: { type, ...data } }).catch(() => {});
}

// Books and the sounds list are cached while she reads, and dropped every time the library shows,
// so new books, pictures and inventory changes appear without reinstalling or reloading.
let inventory;
const getInventory = async () => inventory || (inventory = (PUBLIC && local.get('inventory')) || (await api('inventory')));
let storyCache = {};
const getStory = async (id) => storyCache[id] || (storyCache[id] = await api('stories/' + id));
let settings;
const getSettings = async () => settings || (settings = await api('settings'));
const forgetContent = () => {
  gdata = null;
  inventory = null;
  storyCache = {};
  settings = null;
};

// ---------- Speech (single words only) ----------
// Words are spoken by a Cloudflare voice (chosen in grown-ups), generated once and cached in R2 by the
// worker. The word card starts fetching as it opens, so the audio is usually ready by the time the
// sounding out ends. It plays through Web Audio: iOS only allows sound that starts inside a tap, so the
// tap resumes the audio context (unlockAudio), and the word can then play seconds later from a timer.
// The browser's own voice is the fallback if the worker can't say a word.

let audioCtx, playing;
const ctx = () => audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());
function unlockAudio() {
  const c = ctx();
  // iOS: 'suspended' at first, and 'interrupted' after the screen locks or the app goes to the background;
  // resuming only from 'suspended' left the iPad silent until a reload.
  if (c.state !== 'running') c.resume().catch(() => {});
  // A silent sound started inside the tap is what reliably unlocks Web Audio on iOS.
  const s = c.createBufferSource();
  s.buffer = c.createBuffer(1, 1, 22050);
  s.connect(c.destination);
  s.start(0);
  primeSpeech(); // for the fallback voice
}
function stopAudio() {
  try { playing?.stop(); } catch {}
  playing = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

const sayKey = (word) => word.toLowerCase().replace(/[^a-z' -]/g, '').trim();
const wordAudio = new Map(); // "voice|word" -> Promise<{ buffer, why }>: the audio, or why there's none
function loadWord(word, voice) {
  const w = sayKey(word), k = `${voice}|${w}`;
  if (!wordAudio.has(k)) {
    let why = 'fetch';
    wordAudio.set(k, fetch(`/api/say?word=${encodeURIComponent(w)}&voice=${encodeURIComponent(voice)}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`http ${r.status}`))))
      .then((bytes) => { why = 'decode'; return new Promise((ok, fail) => ctx().decodeAudioData(bytes, ok, fail)); }) // callback form: older Safari
      .then((buffer) => ({ buffer }))
      .catch((e) => { wordAudio.delete(k); return { why: `${why} failed: ${e?.message || e}` }; }));
  }
  return wordAudio.get(k);
}
const prefetchWord = (word) => getSettings().then((s) => loadWord(word, s.voice)).catch(() => {});

// Say a word; `button` shows a spinner if the audio isn't ready yet. Resolves when it starts playing.
async function sayWord(word, button, voice) {
  voice ||= (await getSettings().catch(() => ({}))).voice;
  const pending = voice ? loadWord(word, voice) : Promise.resolve({ why: 'no voice setting' });
  const spin = setTimeout(() => button?.classList.add('waiting'), 120);
  const { buffer } = await pending;
  clearTimeout(spin);
  button?.classList.remove('waiting');
  stopAudio();
  if (buffer && audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
  if (!buffer || audioCtx.state !== 'running') return speak(word);
  playing = ctx().createBufferSource();
  playing.buffer = buffer;
  // Fade the last 30 ms: some words stop at full volume, and a hard stop clicks.
  const gain = audioCtx.createGain(), now = audioCtx.currentTime, end = now + buffer.duration;
  gain.gain.setValueAtTime(1, Math.max(now, end - 0.03));
  gain.gain.linearRampToValueAtTime(0, end);
  playing.connect(gain).connect(audioCtx.destination);
  playing.start(now);
}

let voice;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  voice =
    voices.find((v) => v.lang === 'en-GB' && /female|libby|sonia|serena|kate|martha/i.test(v.name)) ||
    voices.find((v) => v.lang === 'en-GB') ||
    voices.find((v) => v.lang.startsWith('en'));
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// The fallback voice needs the same unlock on iOS: a silent utterance inside the tap.
function primeSpeech() {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'en-GB';
  u.rate = 0.7;
  speechSynthesis.speak(u);
}

// ---------- Updates ----------
// The installed app (home screen) has no reload button, so it checks for a new deploy whenever it
// comes back to the foreground, and every 15 minutes while open. Files are served must-revalidate,
// so a reload is all an update takes; the hash route keeps her place.

let version;
async function latestVersion() {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    return res.ok ? (await res.json()).version : null;
  } catch {
    return null; // offline: keep going
  }
}
async function checkForUpdate() {
  const latest = await latestVersion();
  if (version && latest && latest !== version) location.reload();
  return latest;
}
latestVersion().then((v) => (version = v));
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  await checkForUpdate();
  // Back from the background on the library: show it fresh (new books, pictures).
  if (!location.hash.startsWith('#/read') && !location.hash.startsWith('#/grownups')) route();
});
setInterval(checkForUpdate, 15 * 60 * 1000);

// ---------- Router ----------

// Passed the gate this session (survives the grown-ups "Refresh now" reload).
const session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
};
let grownUp = session.get('grownUp') === '1';

async function route() {
  await modeReady;
  await loginReady;
  closePop();
  stopAudio();
  const [, view, id, page] = location.hash.split('/');
  try {
    if (view === 'read' && id) await showReader(id, Number(page) || 0);
    else if (view === 'grownups') grownUp ? await showGrownups(id) : showGate();
    else await showLibrary();
  } catch (e) {
    app.innerHTML = `<div class="end"><h1 class="big">Oops!</h1><p class="said">${esc(e.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- Keypad (grown-ups gate) ----------

function keypad({ title, hint, digits = 4, boxes = false, onCancel, onDone }) {
  let entered = '';
  app.innerHTML = `
    <div class="keyscreen">
      ${BRAND}
      <h2>${title}</h2>
      ${hint ? `<p>${hint}</p>` : ''}
      <div class="slots ${boxes ? 'digits' : ''}">${'<span></span>'.repeat(digits)}</div>
      <div class="keys">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="press" data-k="${n}">${n}</button>`).join('')}
        <span></span>
        <button class="press" data-k="0">0</button>
        <button class="press erase" data-k="back" aria-label="Delete">${ICONS.erase}</button>
      </div>
      ${onCancel ? '<button class="link" data-act="cancel">Back to the books</button>' : ''}
    </div>`;
  const slots = app.querySelector('.slots');
  const paint = () => slots.querySelectorAll('span').forEach((s, i) => {
    s.classList.toggle('on', i < entered.length);
    if (boxes) s.textContent = entered[i] || '';
  });
  const fail = () => {
    entered = '';
    slots.classList.add('shake');
    setTimeout(() => { slots.classList.remove('shake'); paint(); }, 400);
  };
  app.querySelector('.keys').addEventListener('click', async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    entered = k === 'back' ? entered.slice(0, -1) : (entered + k).slice(0, digits);
    paint();
    if (entered.length === digits) (await onDone(entered)) || fail();
  });
  if (onCancel) app.querySelector('[data-act=cancel]').onclick = onCancel;
}

// Like TYM: grown-ups prove it by typing a birth year that makes them an adult.
function showGate() {
  keypad({
    title: 'Grown-ups only',
    hint: 'What year were you born?',
    boxes: true,
    onCancel: () => (location.hash = '#/'),
    onDone: (year) => {
      const age = new Date().getFullYear() - Number(year);
      if (age < 18 || age > 100) return false;
      grownUp = true;
      session.set('grownUp', '1');
      route();
      return true;
    },
  });
}

// ---------- Library ----------

async function showLibrary() {
  forgetContent();
  const stories = await api('stories');
  if (PUBLIC) {
    const done = local.get('finished') || {};
    stories.forEach((s) => (s.finished = done[s.id] || 0));
  }
  const series = [...new Set(stories.map((s) => s.series))];
  const nextUp = stories.find((s) => !s.finished && s.kind !== 'book');
  app.innerHTML = `
    <div class="library">
      <header>${BRAND}</header>
      ${series.map((name) => `
        <h2 class="series-title">${esc(name)}</h2>
        <div class="shelf">
          ${stories.filter((s) => s.series === name).map((s) => `
            <button class="book press ${s === nextUp ? 'next' : ''}" data-id="${esc(s.id)}">
              ${s === nextUp ? '<span class="tag">Read me next</span>' : ''}
              ${s.coverImage
                ? `<span class="art photo"><img src="${pictureUrl(s.coverImage)}" alt=""></span>`
                : `<span class="art" style="background: var(--cover-${esc(s.cover || 'egg')})">${cover(s.cover)}</span>`}
              <span class="meta">
                <span class="num">${s.kind === 'book' ? 'From home' : `Book ${s.number}`}</span>
                <span class="title">${esc(s.title)}</span>
                <span class="stars">${[0, 1, 2].map((i) => STAR(i < s.finished)).join('')}</span>
              </span>
            </button>`).join('')}
        </div>`).join('')}
      <div class="library-foot">
        <button class="grownups-btn" data-act="grownups">${ICONS.lock} Grown-ups</button>
        ${login.user ? '' : `<button class="grownups-btn" data-act="signin">${ICONS.user} Sign in</button>`}
        ${PUBLIC ? '<a class="link" href="/about">What is this?</a>' : ''}
      </div>
    </div>`;
  app.querySelectorAll('.book').forEach((b) => (b.onclick = () => (location.hash = `#/read/${b.dataset.id}/0`)));
  app.querySelector('[data-act=grownups]').onclick = () => (location.hash = '#/grownups');
  const signin = app.querySelector('[data-act=signin]');
  if (signin) signin.onclick = async () => { if (await login.signIn()) location.reload(); };
}

// ---------- Reader ----------

async function showReader(id, pageIndex) {
  const [story, all] = await Promise.all([getStory(id), getInventory()]);
  const inv = forStory(all, story);
  if (pageIndex >= story.pages.length) return showEnd(story);
  if (pageIndex === 0) log('open', { storyId: id });
  log('page', { storyId: id, page: pageIndex });

  const page = story.pages[pageIndex];
  // Words she can't read yet (only in books from home) get a quiet dotted underline.
  const known = (t) => classify(t, inv, story.words?.[normalize(t)] || []).kind !== 'unknown';
  const words = tokenize(page.text).map((t) =>
    isWord(t) ? `<span class="w ${known(t) ? '' : 'new'}" data-word="${esc(t)}">${esc(t)}</span>` : esc(t),
  );
  const next = story.pages[pageIndex + 1];
  if (next?.image) new Image().src = pictureUrl(next.image);
  const last = pageIndex === story.pages.length - 1;

  app.innerHTML = `
    <div class="reader">
      <div class="topbar">
        <button class="round press" data-act="home" aria-label="All books">${ICONS.home}</button>
        <div class="title">${esc(story.title)}</div>
        <span class="spacer"></span>
      </div>
      <div class="sheet ${page.image ? 'with-picture' : ''}">
        ${page.image ? `<div class="picture"><img src="${pictureUrl(page.image)}" alt=""></div>` : ''}
        <div class="text">${words.join('')}</div>
      </div>
      <div class="nav">
        <button class="round press" data-act="prev" ${pageIndex === 0 ? 'disabled' : ''} aria-label="Back">${ICONS.prev}</button>
        <div class="progress">${story.pages.map((_, i) => `<span class="${i <= pageIndex ? 'on' : ''}"></span>`).join('')}</div>
        <button class="round press ${last ? 'ember' : ''}" data-act="next" aria-label="Next">${ICONS.next}</button>
      </div>
    </div>`;

  fitPage();
  // The picture box follows the picture's own shape (--ia in style.css), so the crop stays small.
  const img = app.querySelector('.picture img');
  const shape = () => {
    if (img.naturalWidth) app.querySelector('.sheet').style.setProperty('--ia', img.naturalWidth / img.naturalHeight);
    fitPage();
  };
  if (img) img.complete ? shape() : img.addEventListener('load', shape);

  const go = (i) => (location.hash = `#/read/${id}/${i}`);
  app.querySelector('[data-act=home]').onclick = () => (location.hash = '#/');
  app.querySelector('[data-act=prev]').onclick = () => pageIndex > 0 && go(pageIndex - 1);
  app.querySelector('[data-act=next]').onclick = () => go(pageIndex + 1);
  app.querySelectorAll('.w').forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    openPop(el, story, inv);
  }));
}

const pictureUrl = (key) => `/api/pictures/${key}`;

// Keep the page on one screen: CSS lets the picture shrink first; if the text still
// overflows the sheet, step its size down (never below 20px).
// With a picture, text she can read comes first: shrink it to 34px, then let the picture crop more
// (.tight, up to about a third), and only then shrink the text further.
function fitPage() {
  const sheet = app.querySelector('.sheet'), text = app.querySelector('.text');
  if (!sheet || !text) return;
  text.style.fontSize = '';
  sheet.classList.remove('tight');
  let size = parseFloat(getComputedStyle(text).fontSize);
  const over = () => sheet.scrollHeight > sheet.clientHeight + 1;
  while (over() && size > 20) {
    if (size - 2 < 34 && !sheet.classList.contains('tight') && sheet.classList.contains('with-picture')) {
      sheet.classList.add('tight');
      continue;
    }
    size -= 2;
    text.style.fontSize = `${size}px`;
  }
}
addEventListener('resize', fitPage);
document.fonts?.ready.then(fitPage);

// ---------- Word card: the hint lives right on the word ----------

let pop;
function closePop() {
  if (pop) pop.remove();
  pop = null;
  document.querySelectorAll('.w.active').forEach((w) => w.classList.remove('active'));
}
document.addEventListener('click', (e) => pop && !pop.contains(e.target) && closePop());

function openPop(el, story, inv) {
  closePop();
  const word = el.dataset.word;
  const info = classify(word, inv, story.words?.[normalize(word)] || []);
  el.classList.add('active');
  log('tap', { storyId: story.id, word: normalize(word) });

  pop = document.createElement('div');
  pop.className = 'pop';
  // Anything that can be sounded out gets sound buttons: her words, names, and new words
  // (whose unfamiliar sounds are marked). Only tricky words and the truly irregular stay whole.
  const badge = {
    name: 'A name',
    unknown: info.parts?.some((p) => p.new) ? 'New sounds' : 'New word',
  }[info.kind];
  if (info.parts) {
    pop.innerHTML = `
      <div class="chips">${info.parts.map((p, i) => `<div class="chip ${chipClass(p)}" data-i="${i}">${esc(p.text)}<span class="mark"></span></div>`).join('')}</div>
      ${badge ? `<div class="badge ${info.kind === 'unknown' ? 'new' : ''}">${badge}</div>` : ''}
      <div class="actions">
        <button class="press speak" data-a="sound" aria-label="Sound it out">${ICONS.speaker}</button>
      </div>`;
  } else {
    const badge = { tricky: `${STAR(true)} Tricky word`, name: 'A name', unknown: 'New word' }[info.kind];
    pop.innerHTML = `
      <div class="whole">${esc(word)}</div>
      ${badge ? `<div class="badge">${badge}</div>` : ''}
      <div class="actions"><button class="press speak" data-a="say" aria-label="Say it">${ICONS.speaker}</button></div>`;
  }
  prefetchWord(word); // ready by the end of the sounding out, usually
  // Recorded sounds: loaded only if a setting uses them (grown-ups > Voice).
  const prefs = getSettings().catch(() => ({}));
  if (info.parts) prefetchSounds(info.parts);
  document.body.appendChild(pop);
  fitPop(pop);
  if (info.parts) drawLinks(pop, info.parts);
  place(pop, el);

  // One speaker button. If the word can be sounded out, it always is (tiles light in turn) before
  // the word is said, so the voice never reads a word for her without the sounding out.
  const say = pop.querySelector('[data-a=say]');
  if (say) say.onclick = () => {
    unlockAudio();
    sayWord(word, say);
  };
  const sound = pop.querySelector('[data-a=sound]');
  if (sound) sound.onclick = () => {
    unlockAudio();
    soundOut(pop, word, info.parts, sound);
  };
  // Tap a sound button to hear that one sound (always on); a silent e plays its vowel's sound.
  const card = pop;
  prefs.then(() => {
    if (!info.parts || card !== pop) return;
    card.querySelector('.chips').classList.add('tappable');
    card.querySelectorAll('.chip').forEach((chip) => (chip.onclick = async () => {
      if (card.dataset.busy) return;
      unlockAudio();
      let i = Number(chip.dataset.i);
      if (info.parts[i].silent) i = info.parts.findIndex((p, k) => k < i && p.g === info.parts[i].g && !p.silent);
      const lit = [i, isSplit(info.parts[i]) ? partner(info.parts, i) : -1].filter((k) => k >= 0).map((k) => card.querySelectorAll('.chip')[k]);
      lit.forEach((c) => c.classList.add('lit'));
      const buffers = (await Promise.all(partFiles(info.parts[i]).map(loadSound))).filter(Boolean);
      await playSounds(buffers);
      setTimeout(() => lit.forEach((c) => c.classList.remove('lit')), 150);
    }));
  });
}

// Long words: shrink the tiles until the card fits the screen width.
function fitPop(p) {
  const max = innerWidth - 16;
  let size = 46;
  while (p.offsetWidth > max && size > 20) {
    size -= 2;
    p.style.setProperty('--chip', `${size}px`);
  }
}

// Sound buttons: a dot for one letter, a bar for letters making one sound,
// and for silent e an arc joining the vowel to its e (drawn by drawLinks).
// A sound she hasn't learned yet gets the plum "new" look on top.
const isSplit = (p) => p.g.length === 3 && p.g[1] === '_';
function chipClass(p) {
  const shape = isSplit(p) ? 'split' : p.text.length > 1 ? 'many' : 'one';
  return p.new ? `${shape} new` : shape;
}

// The silent e partner of the vowel at index i: the next silent part with the same grapheme.
const partner = (parts, i) => parts.findIndex((p, k) => k > i && p.silent && p.g === parts[i].g);

function drawLinks(p, parts) {
  if (!parts.some((part) => part.silent)) return;
  const row = p.querySelector('.chips');
  row.classList.add('linked'); // position: relative, so chip offsets are relative to the row
  const chips = row.querySelectorAll('.chip');
  // Layout offsets, not getBoundingClientRect: the card is mid scale-in animation right now.
  const centre = (c) => c.offsetLeft + c.offsetWidth / 2;
  const paths = parts.map((part, i) => {
    if (!isSplit(part) || part.silent) return '';
    const a = chips[i], b = chips[partner(parts, i)];
    const x1 = centre(a), x2 = centre(b), y = a.offsetTop + a.offsetHeight - 6;
    return `<path class="${part.new ? 'new' : ''}" d="M${x1} ${y} Q${(x1 + x2) / 2} ${y + 30} ${x2} ${y}"/>`;
  }).join('');
  row.insertAdjacentHTML('beforeend', `<svg class="links" width="${row.offsetWidth}" height="${row.offsetHeight + 24}">${paths}</svg>`);
}

// ---------- Phonics sounds: recordings of each sound, played as its tile lights ----------
// Recorded from the recording sheet (tools/sounds-record.mjs) into R2 sounds/recorded/<who>/<id>.mp3.
// decode gives each part its sound as ARPAbet ("Z", "K S", "AA R"); this maps it to a recording.
const RECORDED = 'eli';
const SOUND_FILES = {
  S: 's', Z: 'z', M: 'm', F: 'f', N: 'n', L: 'l', R: 'r', V: 'v', SH: 'sh', TH: 'th', DH: 'dh', NG: 'ng',
  T: 't', P: 'p', K: 'k', B: 'b', D: 'd', G: 'g', HH: 'h', JH: 'j', W: 'w', Y: 'y', CH: 'ch', 'K S': 'x', 'K W': 'qu',
  AE: 'a', EH: 'e', IH: 'i', AA: 'o', AO: 'o', AH: 'u', UH: 'oo-short',
  EY: 'ai', IY: 'ee', AY: 'igh', OW: 'oa', UW: 'oo', 'AA R': 'ar', 'AO R': 'or', ER: 'ur', AW: 'ow', OY: 'oi',
  'IH R': 'ear', 'EH R': 'air', 'UH R': 'ure', 'Y UW': 'ue',
};
// A part's recordings in order: the whole sound if there's one for it ("K S" is x), else each phoneme ("AH L" in "little").
const partFiles = (part) => {
  if (!part.sound) return [];
  if (SOUND_FILES[part.sound]) return [SOUND_FILES[part.sound]];
  return part.sound.split(' ').map((ph) => SOUND_FILES[ph]).filter(Boolean);
};
const soundAudio = new Map(); // id -> Promise<AudioBuffer | null>
const loadSound = (id) => {
  if (!soundAudio.has(id)) {
    soundAudio.set(id, fetch(`/api/sounds/recorded/${RECORDED}/${id}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then((bytes) => new Promise((ok, fail) => ctx().decodeAudioData(bytes, ok, fail)))
      .catch(() => { soundAudio.delete(id); return null; }));
  }
  return soundAudio.get(id);
};
const prefetchSounds = (parts) => parts.forEach((p) => partFiles(p).forEach(loadSound));
// Play buffers back to back; resolves when the last one ends.
function playSounds(buffers) {
  return new Promise((done) => {
    if (!buffers.length || !audioCtx || audioCtx.state !== 'running') return done();
    let t = audioCtx.currentTime;
    buffers.forEach((b, k) => {
      const src = audioCtx.createBufferSource();
      src.buffer = b;
      src.connect(audioCtx.destination);
      src.start(t);
      if (k === buffers.length - 1) src.onended = done;
      t += b.duration;
    });
  });
}

// The speaker button. Setting soundOut on (default): light up each sound in turn and play it (a silent-e vowel lights
// with its e), then blend: say the whole word. Off: just say the word (no silent animation; Eli found it odd).
// A tile stays lit for its sound plus a short gap, and at least half a second; with no recording, 650 ms.
async function soundOut(p, word, parts, button) {
  if (p.dataset.busy) return; // one sounding-out at a time
  p.dataset.busy = '1';
  const chips = [...p.querySelectorAll('.chip')];
  if ((await getSettings().catch(() => ({}))).soundOut === false) {
    chips.forEach((c) => c.classList.add('lit'));
    await sayWord(word, button);
    setTimeout(() => chips.forEach((c) => c.classList.remove('lit')), 600);
    delete p.dataset.busy;
    return;
  }
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (const i of parts.map((_, k) => k).filter((k) => !parts[k].silent)) {
    if (!pop || pop !== p) return; // card closed mid-way
    chips.forEach((x) => x.classList.remove('lit'));
    chips[i].classList.add('lit');
    if (isSplit(parts[i])) chips[partner(parts, i)].classList.add('lit');
    const buffers = (await Promise.all(partFiles(parts[i]).map(loadSound))).filter(Boolean);
    const t0 = performance.now();
    await playSounds(buffers);
    const played = performance.now() - t0;
    await wait(buffers.length ? Math.max(500 - played, 180) : 650);
  }
  chips.forEach((c) => c.classList.add('lit'));
  await sayWord(word, button);
  delete p.dataset.busy;
}

function place(p, el) {
  const r = el.getBoundingClientRect();
  const w = p.offsetWidth, h = p.offsetHeight, m = 8;
  const left = Math.max(m, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - m));
  let top = r.top - h - 14;
  if (top < m) top = r.bottom + 14;
  p.style.left = left + 'px';
  p.style.top = top + 'px';
}

// ---------- The End ----------

async function showEnd(story) {
  log('finish', { storyId: story.id });
  if (PUBLIC) {
    const done = local.get('finished') || {};
    done[story.id] = (done[story.id] || 0) + 1;
    local.set('finished', done);
  }
  const stories = await api('stories');
  const next = stories.find((s) => s.series === story.series && s.number === story.number + 1);
  app.innerHTML = `
    <div class="end">
      <h1 class="big">The End</h1>
      <div class="stars">${STAR(true).repeat(3)}</div>
      <p class="said">You read <b>${esc(story.title)}</b>!</p>
      ${next ? `<button class="next press ember">Next: ${esc(next.title)} ${ICONS.next}</button>` : ''}
      <button class="link" data-act="home">All books</button>
    </div>`;
  if (next) app.querySelector('.next').onclick = () => (location.hash = `#/read/${next.id}/0`);
  app.querySelector('[data-act=home]').onclick = () => (location.hash = '#/');
}

// ---------- Grown-ups ----------
// Tabs, one job each: #/grownups/<tab>.

const TABS = [
  ['sounds', 'Sounds'],
  ['words', 'Words'],
  ['books', 'Books'],
  ['voice', 'Voice'],
  ['app', 'App'],
];

// The public site has only the tabs that work on a device: sounds, words and books.
const PUBLIC_TABS = ['sounds', 'words', 'books'];

// Everything the tabs show, loaded once per visit. Tabs render from it at once, and edits change it first and
// save afterwards, so nothing waits on the network.
let gdata;

const adminShell = (tab, body) => {
  const tabs = PUBLIC ? TABS.filter(([t]) => PUBLIC_TABS.includes(t)) : TABS;
  return `
    <div class="admin">
      <header>
        <h1>Grown-ups</h1>
        <button class="done press" data-act="done">${ICONS.check} Done</button>
      </header>
      <nav class="tabs">${tabs.map(([t, label]) => `<a href="#/grownups/${t}" class="${t === tab ? 'on' : ''}">${label}</a>`).join('')}</nav>
      ${body}
    </div>`;
};

async function showGrownups(tab) {
  if (!gdata) {
    app.innerHTML = adminShell(tab, '<section class="panel"><p class="muted">Loading</p></section>');
    app.querySelector('[data-act=done]').onclick = () => (location.hash = '#/');
    const [inv, list, prefs] = await Promise.all([getInventory(), api('stories'), getSettings()]);
    const stories = await Promise.all(list.map((s) => getStory(s.id)));
    gdata = { inv, stories, prefs };
    if (!location.hash.startsWith('#/grownups')) return; // left while loading
    tab = location.hash.split('/')[2];
  }
  renderGrownups(tab);
}

function renderGrownups(tab) {
  const tabs = PUBLIC ? TABS.filter(([t]) => PUBLIC_TABS.includes(t)) : TABS;
  if (!tabs.some(([t]) => t === tab)) tab = tabs[0][0];
  const { inv, stories, prefs } = gdata;

  const tiles = (entries) => entries.map(([g]) =>
    `<button class="tile ${inv.graphemes.includes(g) ? 'on' : ''}" data-g="${esc(g)}">${esc(letters(g))}${
      g.includes(' (') ? `<small>${esc(g.slice(g.indexOf('(') + 1, -1))}</small>` : ''}</button>`).join('');
  const words = (key) => inv[key].map((w) =>
    `<span class="wordchip">${esc(w)}<button data-remove="${key}" data-w="${esc(w)}" aria-label="Remove ${esc(w)}">${ICONS.close}</button></span>`).join('');
  const adder = (key, placeholder) => `
    <form class="adder" data-add="${key}">
      <input name="w" placeholder="${placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="press">${ICONS.plus} Add</button>
    </form>`;

  const panels = {
    sounds: () => `
      <section class="panel">
        <h2>Known sounds <small>${inv.graphemes.length} on</small></h2>
        <p>Tap a sound to switch it on or off. This doesn't change any book. A word with a sound that's off gets a dotted underline,
          its word card shows that sound in purple, and the Books tab lists it as not readable yet. It starts with the sounds from
          Teach Your Monster to Read, which the books are written for.${PUBLIC ? ' This is saved on this device.' : ' New stories are written only with sounds that are on.'}</p>
        ${CATALOG_GROUPS.map(([title, entries]) => `<h3>${esc(title)}</h3><div class="tiles">${tiles(entries)}</div>`).join('')}
      </section>`,
    words: () => `
      <section class="panel">
        <h2>Tricky words <small>${inv.tricky.length}</small></h2>
        <p>Words read on sight, without sounding out.</p>
        <div class="wordlist">${words('tricky')}</div>
        ${adder('tricky', 'Add a tricky word')}
      </section>
      <section class="panel">
        <h2>Names <small>${inv.names.length}</small></h2>
        <p>Characters' names. They count as readable anywhere.</p>
        <div class="wordlist">${words('names')}</div>
        ${adder('names', 'Add a name')}
      </section>`,
    books: () => `
      <section class="panel">
        <h2>Books</h2>
        <p>Whether each book is still readable with the sounds and words set here.</p>
        ${stories.map((s) => {
          const missing = unreadable(s, inv);
          if (s.kind === 'book') {
            const tokens = s.pages.flatMap((p) => tokenize(p.text).filter(isWord)).map(normalize);
            const share = Math.round((100 * tokens.filter((w) => !missing.includes(w)).length) / tokens.length);
            return `<div class="bookrow">
              <span class="dot home">${share}</span>
              <div><b>${esc(s.title)}</b> <span class="muted">from home</span>
                <div>${share}% is readable. Not yet: ${missing.map(esc).join(', ')}</div>
              </div>
            </div>`;
          }
          return `<div class="bookrow">
            <span class="dot ${missing.length ? 'bad' : 'ok'}">${missing.length ? '!' : ICONS.check}</span>
            <div><b>Book ${s.number}: ${esc(s.title)}</b>
              <div>${missing.length ? `Not readable yet: ${missing.map(esc).join(', ')}` : 'Every word is readable.'}</div>
            </div>
          </div>`;
        }).join('')}
      </section>`,
    voice: () => `
      <section class="panel">
        <h2>Voice</h2>
        <p>The voice that says a word after the sounding out, and says tricky words. Tap a voice's speaker to hear it,
          and tap a name to use that voice.</p>
        <div class="voices">
          ${Object.entries(prefs.voices).map(([id, v]) => `
            <div class="voicerow ${id === prefs.voice ? 'chosen' : ''}">
              <button class="press speak try" data-voice="${esc(id)}" aria-label="Hear ${esc(v.label)}">${ICONS.speaker}</button>
              <button class="pick" data-voice="${esc(id)}"><b>${esc(v.label)}</b> <span class="muted">${esc(v.about)}</span></button>
              ${id === prefs.voice ? `<span class="inuse">${ICONS.check} In use</span>` : ''}
            </div>`).join('')}
        </div>
      </section>
      <section class="panel">
        <h2>Speaker button</h2>
        <p>What the speaker button on the word card does.</p>
        ${[['soundOut', 'Sound it out before saying the word', 'The speaker button lights each sound button in turn and plays its sound, then says the word. Off: it just says the word. Tapping a sound button always plays that sound.'],
        ].map(([key, title, about]) => `
          <button class="switchrow" data-setting="${key}" role="switch" aria-checked="${!!prefs[key]}">
            <span><b>${title}</b><span class="muted">${about}</span></span>
            <span class="switch ${prefs[key] ? 'on' : ''}"></span>
          </button>`).join('')}
      </section>`,
    app: () => `
      <section class="panel">
        <h2>App <small>version ${esc(version || 'unknown')}</small></h2>
        <p>The app updates itself, and new books and pictures appear whenever the library opens. If something still looks out of date:</p>
        <button class="press check" data-act="update">Refresh now</button>
      </section>
      ${PUBLIC || !login.user ? '' : `<section class="panel">
        <h2>Account</h2>
        <p>Signed in as <b>${esc(login.user.email)}</b>. Books, sounds, voice and progress belong to this account.</p>
        <button class="press check" data-act="signout">Sign out</button>
      </section>`}`,
  };

  app.innerHTML = adminShell(tab, panels[tab]());

  // Edits show at once and are saved afterwards; a failed save says so.
  const rerender = () => {
    const y = scrollY;
    renderGrownups(tab);
    scrollTo(0, y);
  };
  const failed = () => toast('Could not save');
  const save = () => {
    rerender();
    if (PUBLIC) local.set('inventory', inv);
    else api('inventory', { method: 'PUT', body: inv }).catch(failed);
  };
  const on = (sel, fn) => app.querySelectorAll(sel).forEach((el) => (el.onclick = (e) => fn(el, e)));
  on('[data-act=done]', () => (location.hash = '#/'));
  // A full reload: fresh code, books, pictures and sounds. Lands back here in grown-ups.
  on('[data-act=update]', () => location.reload());
  on('[data-act=signout]', async () => {
    login.signOut();
    await syncSession();
    location.reload();
  });
  on('.tile', (t) => {
    const g = t.dataset.g;
    inv.graphemes = inv.graphemes.includes(g) ? inv.graphemes.filter((x) => x !== g) : [...inv.graphemes, g];
    save();
  });
  on('[data-remove]', (b) => {
    inv[b.dataset.remove] = inv[b.dataset.remove].filter((w) => w !== b.dataset.w);
    save();
  });
  app.querySelectorAll('[data-add]').forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const w = f.w.value.trim();
    if (!w || inv[f.dataset.add].includes(w)) return;
    inv[f.dataset.add] = [...inv[f.dataset.add], w];
    save();
  }));

  if (tab === 'voice') {
    on('.try', (b) => {
      unlockAudio();
      sayWord('dragon', b, b.dataset.voice);
    });
    on('[data-setting]', (b) => {
      const key = b.dataset.setting;
      prefs[key] = !prefs[key];
      rerender();
      api('settings', { method: 'PUT', body: { [key]: prefs[key] } }).catch(failed);
    });
    on('.pick', (b) => {
      prefs.voice = b.dataset.voice;
      rerender();
      api('settings', { method: 'PUT', body: { voice: prefs.voice } }).catch(failed);
    });
  }
}

function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${ICONS.check} ${esc(text)}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

route();

import { tokenize, isWord, normalize, classify, unreadable, forStory, letters, CATALOG_GROUPS } from './phonics.js';
import { ICONS, STAR, LOGO, cover } from './art.js';

const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BRAND = `<div class="brand">${LOGO}<span class="name">Yara <em>Reads</em></span></div>`;

// ---------- API ----------

class NeedPin extends Error {}

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    ...options,
    headers: { 'content-type': 'application/json' },
    body: options.body && JSON.stringify(options.body),
  });
  if (res.status === 401) throw new NeedPin();
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// The public site (no PIN; the worker decides by hostname) keeps a child's sounds and finished books on
// this device, since there's no account. Yara's own site keeps them in D1 as before.
let PUBLIC = false;
const modeReady = fetch('/api/settings').then((r) => (r.ok ? r.json() : {})).then((s) => (PUBLIC = !!s.public)).catch(() => {});
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
// For the sound log: which device, and whether it's the installed app.
const device = () => `${/iPad|iPhone|Android|Macintosh|Windows/.exec(navigator.userAgent)?.[0] || 'other'}${navigator.standalone ? ' app' : ''}`;
const prefetchWord = (word) => getSettings().then((s) => loadWord(word, s.voice)).catch(() => {});

// Say a word; `button` shows a spinner if the audio isn't ready yet. Resolves when it starts playing.
// Every attempt goes in the sound log (grown-ups > App), so intermittent failures can be traced.
async function sayWord(word, button, voice) {
  const t0 = performance.now();
  const ready = wordAudio.has(`${voice || settings?.voice}|${sayKey(word)}`);
  voice ||= (await getSettings().catch(() => ({}))).voice;
  const pending = voice ? loadWord(word, voice) : Promise.resolve({ why: 'no voice setting' });
  const spin = setTimeout(() => button?.classList.add('waiting'), 120);
  const { buffer, why } = await pending;
  clearTimeout(spin);
  button?.classList.remove('waiting');
  stopAudio();
  if (buffer && audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
  const state = audioCtx?.state || 'none';
  const note = (outcome) => log('say', { word: sayKey(word),
    detail: `${outcome} ${Math.round(performance.now() - t0)}ms ${ready ? 'preloaded' : 'loaded'} audio=${state} ${device()}` });
  if (!buffer || state !== 'running') {
    note(`FALLBACK (${why || `audio ${state}`})`);
    return speak(word);
  }
  note('played');
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
  closePop();
  stopAudio();
  const [, view, id, page] = location.hash.split('/');
  try {
    if (view === 'read' && id) await showReader(id, Number(page) || 0);
    else if (view === 'grownups') grownUp ? await showGrownups(id) : showGate();
    else if (view === 'sounds') grownUp ? await showSoundLab() : showGate();
    else await showLibrary();
  } catch (e) {
    if (e instanceof NeedPin) showPin();
    else app.innerHTML = `<div class="end"><h1 class="big">Oops!</h1><p class="said">${esc(e.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- Keypad (PIN and grown-ups gate) ----------

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

function showPin() {
  keypad({
    title: 'Enter the secret number',
    onDone: async (pin) => {
      const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ pin }) });
      if (res.ok) route();
      return res.ok;
    },
  });
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
      <p style="text-align:center; margin-top:40px">
        <button class="grownups-btn" data-act="grownups">${ICONS.lock} Grown-ups</button>
        ${PUBLIC ? '<br><a class="link" href="/about">What is this?</a>' : ''}
      </p>
    </div>`;
  app.querySelectorAll('.book').forEach((b) => (b.onclick = () => (location.hash = `#/read/${b.dataset.id}/0`)));
  app.querySelector('[data-act=grownups]').onclick = () => (location.hash = '#/grownups');
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
      <div class="chips">${info.parts.map((p) => `<div class="chip ${chipClass(p)}">${esc(p.text)}<span class="mark"></span></div>`).join('')}</div>
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

// Light up each sound in turn (a silent-e vowel lights with its e), then blend: say the whole word.
function soundOut(p, word, parts, button) {
  if (p.dataset.busy) return; // one sounding-out at a time
  p.dataset.busy = '1';
  const chips = [...p.querySelectorAll('.chip')];
  const steps = parts.map((_, i) => i).filter((i) => !parts[i].silent);
  steps.forEach((i, n) => setTimeout(() => {
    chips.forEach((x) => x.classList.remove('lit'));
    chips[i].classList.add('lit');
    if (isSplit(parts[i])) chips[partner(parts, i)].classList.add('lit');
  }, n * 650));
  setTimeout(async () => {
    chips.forEach((c) => c.classList.add('lit'));
    await sayWord(word, button);
    delete p.dataset.busy;
  }, steps.length * 650);
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
// Tabs, one job each: #/grownups/<tab>. Practise is first because it's what you check most.

const TABS = [
  ['practise', 'Practise'],
  ['sounds', 'Sounds'],
  ['words', 'Words'],
  ['books', 'Books'],
  ['voice', 'Voice'],
  ['app', 'App'],
];

// The public site has only the tabs that work on a device: sounds, words and books.
const PUBLIC_TABS = ['sounds', 'words', 'books'];

async function showGrownups(tab) {
  const tabs = PUBLIC ? TABS.filter(([t]) => PUBLIC_TABS.includes(t)) : TABS;
  if (!tabs.some(([t]) => t === tab)) tab = tabs[0][0];
  const [inv, list, progress, prefs] = await Promise.all([
    getInventory(), api('stories'), PUBLIC ? { taps: [], days: [] } : api('progress'), getSettings()]);
  const stories = tab === 'books' || tab === 'voice' ? await Promise.all(list.map((s) => getStory(s.id))) : [];

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
    practise: () => `
      <section class="panel">
        <h2>Practise</h2>
        <p>The words she taps most for help. These are the ones to practise together.</p>
        <div class="wordlist">${progress.taps.map((t) => `<span class="wordchip plain">${esc(t.word)}<span class="count">×${t.taps}</span></span>`).join('') || '<span class="days">Nothing yet.</span>'}</div>
        <h3>Recent days</h3>
        <div class="days">${progress.days.map((d) => `${esc(d.day)}: ${d.pages} pages, ${d.stories} books`).join('<br>') || 'Nothing yet.'}</div>
      </section>`,
    sounds: () => `
      <section class="panel">
        <h2>Sounds ${PUBLIC ? 'your child knows' : 'she knows'} <small>${inv.graphemes.length} on</small></h2>
        <p>${PUBLIC
          ? "Tap a sound to switch it on or off. It starts with the sounds from Teach Your Monster to Read, which the books are written for. A word with a sound that's off gets a dotted underline, and its word card shows the new sound in purple. This is saved on this device."
          : "Tap a sound to switch it on or off. Books only use sounds that are on, and a word with a sound that's off stops being one she can sound out."}</p>
        ${CATALOG_GROUPS.map(([title, entries]) => `<h3>${esc(title)}</h3><div class="tiles">${tiles(entries)}</div>`).join('')}
      </section>`,
    words: () => `
      <section class="panel">
        <h2>Tricky words <small>${inv.tricky.length}</small></h2>
        <p>Words ${PUBLIC ? 'your child reads' : 'she reads'} on sight, without sounding out.</p>
        <div class="wordlist">${words('tricky')}</div>
        ${adder('tricky', 'Add a tricky word')}
      </section>
      <section class="panel">
        <h2>Names <small>${inv.names.length}</small></h2>
        <p>Characters' names. ${PUBLIC ? 'They count as readable' : 'She can read these'} anywhere.</p>
        <div class="wordlist">${words('names')}</div>
        ${adder('names', 'Add a name')}
      </section>`,
    books: () => `
      <section class="panel">
        <h2>Books</h2>
        <p>Whether each book is still readable with what ${PUBLIC ? 'your child knows' : 'she knows'}.</p>
        ${stories.map((s) => {
          const missing = unreadable(s, inv);
          if (s.kind === 'book') {
            const tokens = s.pages.flatMap((p) => tokenize(p.text).filter(isWord)).map(normalize);
            const share = Math.round((100 * tokens.filter((w) => !missing.includes(w)).length) / tokens.length);
            return `<div class="bookrow">
              <span class="dot home">${share}</span>
              <div><b>${esc(s.title)}</b> <span class="muted">from home</span>
                <div>She can read ${share}% of it. Not yet: ${missing.map(esc).join(', ')}</div>
              </div>
            </div>`;
          }
          return `<div class="bookrow">
            <span class="dot ${missing.length ? 'bad' : 'ok'}">${missing.length ? '!' : ICONS.check}</span>
            <div><b>Book ${s.number}: ${esc(s.title)}</b>
              <div>${missing.length ? `Words ${PUBLIC ? 'your child' : 'she'} can't read yet: ${missing.map(esc).join(', ')}` : (PUBLIC ? 'Every word is readable.' : 'Every word is one she can read.')}</div>
            </div>
          </div>`;
        }).join('')}
      </section>`,
    voice: () => `
      <section class="panel">
        <h2>Voice</h2>
        <p>The voice that says a word after the sounding out, and says tricky words. Type a word, tap a voice's
          speaker to hear it, and tap a name to use that voice.</p>
        <form class="adder tryword"><input name="w" value="dragon" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Word to try"></form>
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
        <h2>Get the books ready</h2>
        <p>Each word is made once, the first time it's needed, then kept. This makes every word in the books now,
          in the voice in use, so she never waits.</p>
        <button class="press check" data-act="warm">Get every book word ready</button>
        <span class="muted warm-status"></span>
      </section>
      <section class="panel">
        <h2>Sound lab</h2>
        <p>Recordings of each phonics sound for the sound buttons. Listen to the candidates and pick the ones that sound right.</p>
        <button class="press check" data-act="lab">Open the sound lab</button>
      </section>`,
    app: () => `
      <section class="panel">
        <h2>App <small>version ${esc(version || 'unknown')}</small></h2>
        <p>The app updates itself, and new books and pictures appear whenever the library opens. If something still looks out of date:</p>
        <button class="press check" data-act="update">Refresh now</button>
      </section>
      <section class="panel">
        <h2>Sound log <small>last ${progress.sounds?.length || 0}</small></h2>
        <p>Every time a word is said: whether it played, how long it took, whether it was already loaded, the state of the
          audio, and the device. FALLBACK means the app's voice couldn't play and the browser's own voice was tried.</p>
        <div class="soundlog">${(progress.sounds || []).map((e) => `
          <div class="${/FALLBACK/.test(e.detail) ? 'bad' : ''}"><span class="muted">${esc(e.ts.slice(5, 16))}</span>
            <b>${esc(e.word || '')}</b> <span>${esc(e.detail || '')}</span></div>`).join('') || '<span class="days">Nothing yet.</span>'}</div>
      </section>`,
  };

  app.innerHTML = `
    <div class="admin">
      <header>
        <h1>Grown-ups</h1>
        <button class="done press" data-act="done">${ICONS.check} Done</button>
      </header>
      <nav class="tabs">${tabs.map(([t, label]) => `<a href="#/grownups/${t}" class="${t === tab ? 'on' : ''}">${label}</a>`).join('')}</nav>
      ${panels[tab]()}
    </div>`;

  const save = async () => {
    if (PUBLIC) local.set('inventory', inv);
    else await api('inventory', { method: 'PUT', body: inv });
    toast('Saved');
    const y = scrollY;
    await showGrownups(tab);
    scrollTo(0, y);
  };
  const on = (sel, fn) => app.querySelectorAll(sel).forEach((el) => (el.onclick = (e) => fn(el, e)));
  on('[data-act=done]', () => (location.hash = '#/'));
  on('[data-act=lab]', () => (location.hash = '#/sounds'));
  // A full reload: fresh code, books, pictures and sounds. Lands back here in grown-ups.
  on('[data-act=update]', () => location.reload());
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
    const tryWord = () => app.querySelector('.tryword input').value.trim() || 'dragon';
    app.querySelector('.tryword').onsubmit = (e) => {
      e.preventDefault();
      const b = app.querySelector(`.try[data-voice="${prefs.voice}"]`);
      unlockAudio();
      sayWord(tryWord(), b, prefs.voice);
    };
    on('.try', (b) => {
      unlockAudio();
      sayWord(tryWord(), b, b.dataset.voice);
    });
    on('.pick', async (b) => {
      await api('settings', { method: 'PUT', body: { voice: b.dataset.voice } });
      settings = null;
      toast(`${prefs.voices[b.dataset.voice].label} is the voice now`);
      await showGrownups('voice');
    });
    // Every word in every book, made in the voice in use (a few at a time; cached ones are quick).
    on('[data-act=warm]', async (b) => {
      const all = [...new Set(stories.flatMap((s) => s.pages.flatMap((p) => tokenize(p.text).filter(isWord))).map(sayKey))].filter(Boolean);
      const status = app.querySelector('.warm-status');
      b.disabled = true;
      let done = 0, failed = 0;
      const queue = [...all];
      const worker = async () => {
        for (let w; (w = queue.shift()); ) {
          const r = await fetch(`/api/say?word=${encodeURIComponent(w)}&voice=${encodeURIComponent(prefs.voice)}`).catch(() => null);
          if (!r?.ok) failed++;
          status.textContent = `${++done} of ${all.length}${failed ? `, ${failed} failed` : ''}`;
        }
      };
      await Promise.all([1, 2, 3, 4].map(worker));
      status.textContent = failed ? `Done, but ${failed} failed. Try again.` : `All ${all.length} words ready.`;
      b.disabled = false;
    });
  }
}

// ---------- Sound lab (grown-ups) ----------
// Candidate recordings of each pure phonics sound (tools/sounds.mjs). Eli taps to listen and stars
// the one that sounds right; picks are saved, and the sound buttons will play them.

const EXAMPLES = {
  s: 'sun', m: 'map', f: 'fan', sh: 'ship', n: 'net', l: 'leg', z: 'zip', v: 'van', t: 'top', p: 'pig', k: 'kit',
  b: 'bat', d: 'dog', g: 'got', a: 'ant', e: 'egg', i: 'ink', o: 'on', u: 'up', ai: 'rain', ee: 'see',
  igh: 'night', oa: 'boat', oo: 'moon', ar: 'car', or: 'fork', ur: 'fur', ow: 'cow', oi: 'coin', ch: 'chip', th: 'thin',
};
const VOICE_NAMES = { pandora: 'Voice 1', athena: 'Voice 2', melo: 'Voice 3', 'gpt-mini': 'Voice 4', gpt: 'Voice 5' };
let labAudio;

async function showSoundLab() {
  const [manifest, picks] = await Promise.all([
    fetch('/api/sounds/candidates.json').then((r) => (r.ok ? r.json() : [])),
    api('sound-picks'),
  ]);
  const picked = Object.keys(picks).length;
  app.innerHTML = `
    <div class="admin lab">
      <header>
        <h1>Sound lab</h1>
        <button class="done press" data-act="back">${ICONS.back} Grown-ups</button>
      </header>
      <section class="panel">
        <p>Tap a take to hear it. Star the one that sounds like the pure sound from class: "sss", not "suh",
          and a short clipped "t". Leave a sound unstarred if none are right; those will need recording.</p>
        <p class="muted">${picked} of ${manifest.length} sounds picked. Each take is labelled with how it was spelled for the voice.</p>
      </section>
      ${manifest.map(({ sound, takes }) => `
        <section class="panel labrow">
          <div class="labsound"><span class="tile on">${esc(sound)}</span><span class="muted">${esc(EXAMPLES[sound] || '')}</span></div>
          <div class="labtakes">
            ${Object.keys(VOICE_NAMES).map((v) => `
              <div class="labvoice"><span class="muted">${VOICE_NAMES[v]}</span>
                ${takes.filter((t) => t.voice === v).map((t) => `
                  <span class="take ${picks[sound] === t.key ? 'picked' : ''}">
                    <button class="press play" data-key="${esc(t.key)}">${ICONS.speaker} ${esc(t.text)}</button>
                    <button class="star-btn" data-sound="${esc(sound)}" data-key="${esc(t.key)}" aria-label="Pick">${STAR(picks[sound] === t.key)}</button>
                  </span>`).join('')}
              </div>`).join('')}
          </div>
        </section>`).join('') || '<section class="panel"><p>No candidates yet: run node tools/sounds.mjs.</p></section>'}
    </div>`;
  app.querySelector('[data-act=back]').onclick = () => (location.hash = '#/grownups/voice');
  app.querySelectorAll('.play').forEach((b) => (b.onclick = () => {
    labAudio?.pause();
    labAudio = new Audio(`/api/sounds/${b.dataset.key}`);
    labAudio.play();
  }));
  app.querySelectorAll('.star-btn').forEach((b) => (b.onclick = async () => {
    const { sound, key } = b.dataset;
    await api('sound-picks', { method: 'PUT', body: { sound, key: picks[sound] === key ? null : key } });
    const y = scrollY;
    await showSoundLab();
    scrollTo(0, y);
  }));
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

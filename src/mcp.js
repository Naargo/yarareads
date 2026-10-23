// MCP server (Streamable HTTP, JSON replies) so a parent's own agent can add and manage books in their account.
// Connect at /mcp. Agents sign in with OAuth 2.1 (src/mcp-auth.js): the parent approves with Google, and the agent's tokens
// belong to that account. Every book an agent saves is private to it (stories.owner).

import { compileStory } from './compile.js';
import { makeLexicon } from './lexicon-core.js';
import { classify, forStory } from '../public/phonics.js';
import { bearerSub, unauthorized, json, preflight } from './mcp-auth.js';
import GUIDE from './agent-guide.txt';

const MAX_BOOKS = 40, MAX_PAGES = 60, MAX_PAGE_CHARS = 600, MAX_IMAGE = 3 * 1024 * 1024;

export const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

let lexicon;
const getLexicon = (env, origin) => (lexicon ||= env.ASSETS.fetch(new Request(`${origin}/lexicon.dict`))
  .then((r) => { if (!r.ok) throw new Error('the dictionary is not deployed'); return r.text(); })
  .then((t) => makeLexicon([t]))
  .catch((e) => { lexicon = null; throw e; }));

const TOOLS = [
  {
    name: 'guide',
    description: 'Read this first, before writing anything. How Yara Reads works, the one rule every story must follow, the workflow, and how to write the story and make and check its pictures.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sounds',
    description: "The sounds, sight words and names this account's child can read. Write only with these.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_text',
    description: 'Check draft pages against the sounds this account has switched on, without saving. Lists every unreadable word with its pages. Use it until the list is empty.',
    inputSchema: {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'string' }, description: 'The text of each page, in order.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Character names; they count as readable.' },
      },
      required: ['pages'],
    },
  },
  {
    name: 'save_book',
    description: 'Create or replace a book in this account. A "story" is refused if any word is unreadable. Returns the book id. Add pictures afterwards with set_image.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        pages: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, picture: { type: 'string', description: 'What the picture shows (a note, not shown to the child).' } }, required: ['text'] },
        },
        id: { type: 'string', description: 'An existing book id to replace. Omit to create (or replace the book with the same title).' },
        series: { type: 'string', description: 'Heading in the library. Books with the same series are grouped.' },
        number: { type: 'integer', description: 'Order within the series.' },
        kind: { type: 'string', enum: ['story', 'book'], description: '"story" (default) is checked word by word. "book" is a real book the family owns, unchecked.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Character names for this book.' },
        author: { type: 'string' },
      },
      required: ['title', 'pages'],
    },
  },
  {
    name: 'set_image',
    description: 'Set the cover (page 0) or a page picture (page 1, 2, ...) of a book, from an https URL or base64 data. JPEG, PNG or WebP up to 3 MB, landscape 4:3, at least 1024 px wide; send full quality, the server makes the smaller copies. Check each picture first (guide: PICTURES).',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        page: { type: 'integer', description: '0 for the cover, otherwise the page number starting at 1.' },
        url: { type: 'string' },
        base64: { type: 'string', description: 'Image bytes, base64. Use this or url.' },
      },
      required: ['book_id', 'page'],
    },
  },
  {
    name: 'list_books',
    description: "This account's books.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_book',
    description: 'One book: its pages, which pages have pictures, and any words the child cannot read yet.',
    inputSchema: { type: 'object', properties: { book_id: { type: 'string' } }, required: ['book_id'] },
  },
  {
    name: 'delete_book',
    description: 'Delete one of this account\'s books and its pictures. Cannot be undone.',
    inputSchema: { type: 'object', properties: { book_id: { type: 'string' } }, required: ['book_id'] },
  },
  {
    name: 'preview_url',
    description: 'A link that opens the app read-only as this account for one hour, optionally at a book and page. Open it in a browser to check your work.',
    inputSchema: { type: 'object', properties: { book_id: { type: 'string' }, page: { type: 'integer', description: 'Page to open, from 1.' } } },
  },
];

// The same guide as an MCP prompt, for clients that offer prompts (as a slash command, say) rather than reading tools first.
const PROMPTS = [{
  name: 'write_a_book',
  description: 'Write and illustrate a book for this account\'s child, following the Yara Reads guide.',
  arguments: [{ name: 'idea', description: 'What the book should be about (optional).', required: false }],
}];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError && { isError: true }) });
const fail = (t) => text(t, true);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'book';
const ownPrefix = async (sub) => 'u' + (await sha256(sub)).slice(0, 6);

async function inventoryFor(env, sub, seed) {
  const row = await env.DB.prepare('SELECT body FROM account_inventory WHERE sub = ?').bind(sub).first();
  return row ? JSON.parse(row.body) : seed();
}

async function ownBook(env, sub, id) {
  const row = typeof id === 'string' && (await env.DB.prepare('SELECT body FROM stories WHERE id = ? AND owner = ?').bind(id, sub).first());
  return row ? JSON.parse(row.body) : null;
}

const unreadableList = (unknown) => [...unknown].map(([word, pages]) => `${word} (page ${pages.join(', ')})`);

function sniffImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ['png', 'image/png'];
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return ['webp', 'image/webp'];
  return null;
}

async function callTool(name, args, ctx) {
  const { env, sub, origin, seed } = ctx;
  switch (name) {
    case 'guide':
      return text(GUIDE);

    case 'get_sounds': {
      const inv = await inventoryFor(env, sub, seed);
      return text({ sounds: inv.graphemes, sight_words: inv.tricky, names: inv.names,
        note: 'A word is readable if it can be sounded out with these sounds, is a sight word, or is a character name listed on the book.' });
    }

    case 'check_text': {
      const pages = args.pages;
      if (!Array.isArray(pages) || !pages.length || pages.some((p) => typeof p !== 'string')) return fail('pages must be a list of strings');
      const inv = await inventoryFor(env, sub, seed);
      const { unknown, count } = compileStory({ pages: pages.map((t) => ({ text: t })), names: args.names || [] }, inv, await getLexicon(env, origin));
      return text(unknown.size
        ? { readable: false, words: count, unreadable: unreadableList(unknown), next: 'Rewrite those words and check again.' }
        : { readable: true, words: count });
    }

    case 'save_book': {
      const { title, pages } = args;
      if (typeof title !== 'string' || !title.trim() || title.length > 80) return fail('title is required (up to 80 characters)');
      if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES) return fail(`pages must be 1 to ${MAX_PAGES} pages`);
      if (pages.some((p) => typeof p?.text !== 'string' || !p.text.trim() || p.text.length > MAX_PAGE_CHARS)) return fail(`each page needs text of up to ${MAX_PAGE_CHARS} characters`);
      const kind = args.kind === 'book' ? 'book' : 'story';
      const names = (args.names || []).filter((n) => typeof n === 'string').map((n) => n.slice(0, 40)).slice(0, 30);
      const prefix = await ownPrefix(sub);
      const id = typeof args.id === 'string' && args.id ? args.id : `${prefix}-${slug(title)}`;
      if (!id.startsWith(prefix + '-') || !/^[\w-]+$/.test(id)) return fail('id must be a book id from list_books');
      const old = await ownBook(env, sub, id);
      if (!old) {
        const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM stories WHERE owner = ?').bind(sub).first();
        if (n >= MAX_BOOKS) return fail(`this account already has ${MAX_BOOKS} books`);
      }
      const inv = await inventoryFor(env, sub, seed);
      const { story, unknown, count } = compileStory({
        id, kind, title: title.trim(), series: String(args.series || old?.series || 'My books').slice(0, 60),
        number: Number.isInteger(args.number) ? args.number : old?.number || 1,
        cover: old?.cover || 'sparkle', coverImage: old?.coverImage, names,
        ...(args.author && { author: String(args.author).slice(0, 80) }),
        // Pictures stay with their page when only the words change.
        pages: pages.map((p, i) => ({ text: p.text.trim(), ...(p.picture && { picture: String(p.picture).slice(0, 300) }), ...(old?.pages[i]?.image && { image: old.pages[i].image }) })),
      }, inv, await getLexicon(env, origin));
      if (kind === 'story' && unknown.size) {
        return fail({ saved: false, unreadable: unreadableList(unknown), next: 'Rewrite these words (see get_sounds), or use kind "book" if this is a real book the family owns.' });
      }
      await env.DB.prepare('INSERT OR REPLACE INTO stories (id, series, number, title, body, owner, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
        .bind(id, story.series, story.number, story.title, JSON.stringify(story), sub).run();
      const missing = [...unknown.values()].reduce((s, p) => s + p.length, 0);
      return text({ saved: true, book_id: id, pages: pages.length, words: count,
        ...(kind === 'book' && { readable_percent: Math.round((100 * (count - missing)) / count), not_yet: [...unknown.keys()] }),
        next: 'Add pictures with set_image (page 0 is the cover), then preview_url to look at it.' });
    }

    case 'set_image': {
      const story = await ownBook(env, sub, args.book_id);
      if (!story) return fail('no such book in this account');
      const page = args.page;
      if (!Number.isInteger(page) || page < 0 || page > story.pages.length) return fail(`page must be 0 (cover) to ${story.pages.length}`);
      let bytes;
      if (typeof args.url === 'string') {
        if (!/^https:\/\//.test(args.url)) return fail('url must be https');
        const res = await fetch(args.url, { redirect: 'follow' }).catch(() => null);
        if (!res?.ok) return fail(`could not fetch the image (${res ? res.status : 'no response'})`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } else if (typeof args.base64 === 'string') {
        try { bytes = Uint8Array.from(atob(args.base64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0)); } catch { return fail('base64 is not valid'); }
      } else return fail('give a url or base64');
      if (bytes.length > MAX_IMAGE) return fail('image is over 3 MB: resize it');
      const type = sniffImage(bytes);
      if (!type) return fail('image must be a JPEG, PNG or WebP');
      const key = `${story.id}/${page === 0 ? 'cover' : page}.${type[0]}`;
      await env.PICTURES.put(key, bytes, { httpMetadata: { contentType: type[1] } });
      const v = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 5).map((b) => b.toString(16).padStart(2, '0')).join('');
      const url = `${key}?v=${v}`;
      if (page === 0) story.coverImage = url; else story.pages[page - 1].image = url;
      await env.DB.prepare('UPDATE stories SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner = ?').bind(JSON.stringify(story), story.id, sub).run();
      return text({ saved: true, key, bytes: bytes.length });
    }

    case 'list_books': {
      const { results } = await env.DB.prepare('SELECT id, series, number, title, body FROM stories WHERE owner = ? ORDER BY series, number').bind(sub).all();
      return text(results.map((r) => {
        const b = JSON.parse(r.body);
        return { book_id: r.id, title: r.title, series: r.series, number: r.number, kind: b.kind, pages: b.pages.length,
          pictures: b.pages.filter((p) => p.image).length, cover: !!b.coverImage };
      }));
    }

    case 'get_book': {
      const story = await ownBook(env, sub, args.book_id);
      if (!story) return fail('no such book in this account');
      const inv = forStory(await inventoryFor(env, sub, seed), story);
      const unknown = {};
      for (const [w, prons] of Object.entries(story.words || {})) if (classify(w, inv, prons).kind === 'unknown') unknown[w] = true;
      return text({ book_id: story.id, title: story.title, series: story.series, number: story.number, kind: story.kind, names: story.names,
        cover: !!story.coverImage, pages: story.pages.map((p, i) => ({ page: i + 1, text: p.text, picture_note: p.picture, has_image: !!p.image })),
        unreadable_now: Object.keys(unknown) });
    }

    case 'delete_book': {
      const story = await ownBook(env, sub, args.book_id);
      if (!story) return fail('no such book in this account');
      for (let list = await env.PICTURES.list({ prefix: `${story.id}/` }); ; list = await env.PICTURES.list({ prefix: `${story.id}/`, cursor: list.cursor })) {
        if (list.objects.length) await env.PICTURES.delete(list.objects.map((o) => o.key));
        if (!list.truncated) break;
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM story_readers WHERE story_id = ?').bind(story.id),
        env.DB.prepare('DELETE FROM stories WHERE id = ? AND owner = ?').bind(story.id, sub),
      ]);
      return text({ deleted: story.id });
    }

    case 'preview_url': {
      if (args.book_id && !(await ownBook(env, sub, args.book_id))) return fail('no such book in this account');
      const token = 'yrp_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM agent_tokens WHERE expires_at < datetime('now')"),
        env.DB.prepare("INSERT INTO agent_tokens (hash, sub, label, kind, expires_at) VALUES (?, ?, 'preview', 'preview', datetime('now', '+1 hour'))").bind(await sha256(token), sub),
      ]);
      const page = Number.isInteger(args.page) && args.page > 1 ? args.page - 1 : 0;
      return text({ url: `${origin}/?preview=${token}${args.book_id ? `#/read/${args.book_id}/${page}` : ''}`, expires: 'in one hour', read_only: true });
    }
  }
  return fail(`unknown tool ${name}`);
}

async function rpc(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'yara-reads', version: '1.0.0' },
        instructions: 'Adds books to one parent\'s private Yara Reads account. Call the guide tool before writing anything: it has the one rule every word must follow and how to write the story and make its pictures.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'prompts/list': return reply({ prompts: PROMPTS });
    case 'prompts/get': {
      if (msg.params?.name !== 'write_a_book') return error(-32602, `unknown prompt ${msg.params?.name}`);
      const idea = String(msg.params?.arguments?.idea || '').slice(0, 500);
      return reply({
        description: PROMPTS[0].description,
        messages: [{ role: 'user', content: { type: 'text', text: `${GUIDE}\n\nFollow this guide to write and illustrate a book for my child.${idea ? ` The idea: ${idea}` : ' Ask me what they love first.'}` } }],
      });
    }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `unknown tool ${msg.params?.name}`);
      try {
        return reply(await callTool(tool.name, msg.params.arguments || {}, ctx));
      } catch (e) {
        return reply(fail(`${tool.name} failed: ${String(e.message || e).slice(0, 200)}`));
      }
    }
    default:
      return msg.id === undefined ? null : error(-32601, `method not found: ${msg.method}`);
  }
}

export async function handleMcp(request, env, url, { seed }) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'POST JSON-RPC here' }, 405, { allow: 'POST' });
  const sub = await bearerSub(request, env.DB);
  if (!sub) return unauthorized(url.origin);
  const body = await request.json().catch(() => null);
  if (!body) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  const ctx = { env, sub, origin: url.origin, seed };
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => rpc(m, ctx)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });
  return json(Array.isArray(body) ? replies : replies[0]);
}

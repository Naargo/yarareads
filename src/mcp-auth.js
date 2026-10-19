// OAuth 2.1 for MCP clients, after the Accountant's functions/_mcp-auth.ts (which is after notime's): discovery documents,
// dynamic client registration (RFC 7591), authorization code with PKCE (S256 only), rotating refresh tokens. A parent
// approves an agent by signing in with Google through login.finereli.com; the tokens then belong to that account.

import { verifyLoginToken } from './verify-login.js';

const ACCESS_TTL = 24 * 3600;
const REFRESH_TTL = 180 * 86400;
const CODE_TTL = 600;
const LOGIN = (env) => env.LOGIN_ORIGIN || 'https://login.finereli.com';

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const now = () => Math.floor(Date.now() / 1000);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};
export const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { ...cors, 'Cache-Control': 'no-store', ...headers } });
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);
export const preflight = () => new Response(null, { status: 204, headers: cors });

const protectedResource = (origin) =>
  json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['books'], bearer_methods_supported: ['header'], resource_name: 'Yara Reads' });

const authorizationServer = (origin) =>
  json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['books'],
  });

// Where a client may send the parent back to: https, or a local address for agents on a desktop.
const allowedRedirect = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
};

async function register(request, db) {
  const b = await request.json().catch(() => null);
  const uris = Array.isArray(b?.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || !uris.every(allowedRedirect)) return oauthError('invalid_redirect_uri', 'Give one or more https (or localhost) redirect_uris');
  const id = 'mcp_' + randomToken(18);
  const name = typeof b?.client_name === 'string' ? b.client_name.slice(0, 80) : null;
  await db.prepare('INSERT INTO mcp_clients (id, name, redirect_uris) VALUES (?1, ?2, ?3)').bind(id, name, JSON.stringify(uris)).run();
  return json(
    { client_id: id, client_id_issued_at: now(), client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    201,
  );
}

async function client(db, id) {
  const row = await db.prepare('SELECT id, name, redirect_uris FROM mcp_clients WHERE id = ?1').bind(id).first();
  return row ? { ...row, uris: JSON.parse(row.redirect_uris) } : null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/fonts.css">
<body style="font:18px/1.5 Andika,system-ui,sans-serif;background:#fbf5ea;color:#2a2440;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px">
<div style="max-width:26rem"><h1 style="font:600 1.6rem Fredoka,system-ui,sans-serif">${esc(title)}</h1>${body}</div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );

const button = (href, label, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:8px 8px 0 0;padding:12px 22px;border-radius:16px;text-decoration:none;font:600 1.05rem Fredoka,system-ui,sans-serif;${primary ? 'background:#e0533a;color:#fff;box-shadow:0 4px 0 #b53b27' : 'box-shadow:0 0 0 2px #e6dccb inset;color:#6e6585'}">${esc(label)}</a>`;

const withQuery = (base, q) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(q)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
};

// Step 1: the agent sends the parent here. Check what it asks for, keep the request, and ask them to approve by signing in.
async function authorize(url, env) {
  const p = url.searchParams;
  const c = await client(env.DB, p.get('client_id') ?? '');
  const redirect = p.get('redirect_uri') ?? '';
  // Without a known client and one of its own redirect URIs there is nowhere safe to send an error, so say it here.
  if (!c) return page('Unknown app', '<p>This app has not registered with Yara Reads.</p>', 400);
  if (!c.uris.includes(redirect)) return page('Wrong address', '<p>The app asked to come back to an address it did not register.</p>', 400);
  const back = (q) => withQuery(redirect, { ...q, state: p.get('state') });
  if (p.get('response_type') !== 'code') return Response.redirect(back({ error: 'unsupported_response_type' }), 302);
  if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
    return Response.redirect(back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }), 302);
  }
  const id = randomToken(18);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM mcp_pending WHERE created_at < datetime('now', '-1 hour')`),
    env.DB.prepare('INSERT INTO mcp_pending (id, client_id, redirect_uri, state, code_challenge) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, c.id, redirect, p.get('state'), p.get('code_challenge')),
  ]);
  const ret = `${url.origin}/oauth/login?p=${encodeURIComponent(id)}`;
  const who = c.name ? esc(c.name) : 'An app';
  return page(
    'Let an agent add books?',
    `<p><strong>${who}</strong> wants to write, check and add books in your Yara Reads account: stories for your child, and books you own. It can also look at its own work.</p>
<p>It can't see anything outside your books and sounds.</p>
<p>To allow it, sign in with Google. The agent will work in that account.</p>
${button(withQuery(`${LOGIN(env)}/start`, { return: ret }), 'Sign in with Google to allow')}${button(back({ error: 'access_denied' }), 'Cancel', false)}`,
  );
}

// Step 2: back from login.finereli.com. Trade its code for a login token, see who signed in, hand the agent a code for them.
async function loginReturn(url, env, audience) {
  const pendingId = url.searchParams.get('p') ?? '';
  const p = await env.DB
    .prepare('DELETE FROM mcp_pending WHERE id = ?1 RETURNING client_id, redirect_uri, state, code_challenge')
    .bind(pendingId)
    .first();
  if (!p) return page('That request expired', '<p>Start again from the app that asked.</p>', 400);
  const back = (q) => Response.redirect(withQuery(p.redirect_uri, { ...q, state: p.state }), 302);

  const code = url.searchParams.get('finereli_code');
  if (!code) return back({ error: 'access_denied', error_description: url.searchParams.get('finereli_error') ?? 'sign-in cancelled' });
  const res = await fetch(`${LOGIN(env)}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }).catch(() => null);
  const body = res?.ok ? await res.json() : null;
  const claims = body?.token && (await verifyLoginToken(body.token, { audience, issuer: LOGIN(env) }));
  if (!claims) return back({ error: 'access_denied', error_description: 'Sign-in did not check out.' });

  const authCode = randomToken(32);
  await env.DB
    .prepare(`INSERT INTO mcp_tokens (hash, kind, client_id, sub, redirect_uri, code_challenge, expires_at) VALUES (?1, 'code', ?2, ?3, ?4, ?5, ?6)`)
    .bind(await sha256(authCode), p.client_id, claims.sub, p.redirect_uri, p.code_challenge, now() + CODE_TTL)
    .run();
  return back({ code: authCode });
}

async function issue(db, clientId, sub) {
  const access = 'acc_' + randomToken(32);
  const refresh = 'acr_' + randomToken(32);
  await db.batch([
    db.prepare('DELETE FROM mcp_tokens WHERE expires_at < ?1').bind(now()),
    db.prepare(`INSERT INTO mcp_tokens (hash, kind, client_id, sub, expires_at) VALUES (?1, 'access', ?2, ?3, ?4)`).bind(await sha256(access), clientId, sub, now() + ACCESS_TTL),
    db.prepare(`INSERT INTO mcp_tokens (hash, kind, client_id, sub, expires_at) VALUES (?1, 'refresh', ?2, ?3, ?4)`).bind(await sha256(refresh), clientId, sub, now() + REFRESH_TTL),
  ]);
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'books' });
}

// Step 3: the agent trades the code (or a refresh token) for tokens.
async function token(request, db) {
  const type = request.headers.get('Content-Type') ?? '';
  const raw = type.includes('application/json')
    ? await request.json().catch(() => ({}))
    : Object.fromEntries(new URLSearchParams(await request.text()));
  const clientId = raw.client_id ?? '';
  if (!(await client(db, clientId))) return oauthError('invalid_client', 'Unknown client', 401);

  if (raw.grant_type === 'authorization_code') {
    const row = await db
      .prepare(`DELETE FROM mcp_tokens WHERE hash = ?1 AND kind = 'code' RETURNING client_id, sub, redirect_uri, code_challenge, expires_at`)
      .bind(await sha256(raw.code ?? ''))
      .first();
    if (!row || row.expires_at < now() || row.client_id !== clientId) return oauthError('invalid_grant', 'The code is unknown, used or expired');
    if (raw.redirect_uri && raw.redirect_uri !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri does not match');
    if (!raw.code_verifier || (await sha256(raw.code_verifier)) !== row.code_challenge) return oauthError('invalid_grant', 'PKCE check failed');
    return issue(db, clientId, row.sub);
  }

  if (raw.grant_type === 'refresh_token') {
    // One use each: the old refresh token goes as the new pair is made.
    const row = await db
      .prepare(`DELETE FROM mcp_tokens WHERE hash = ?1 AND kind = 'refresh' RETURNING client_id, sub, expires_at`)
      .bind(await sha256(raw.refresh_token ?? ''))
      .first();
    if (!row || row.expires_at < now() || row.client_id !== clientId) return oauthError('invalid_grant', 'The refresh token is unknown, used or expired');
    return issue(db, clientId, row.sub);
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

// Every MCP request: a live access token, resolved to the account that approved it, or nothing.
export async function bearerSub(request, db) {
  const t = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!t) return null;
  const hash = await sha256(t);
  const row = await db.prepare(`SELECT sub, expires_at FROM mcp_tokens WHERE hash = ?1 AND kind = 'access'`).bind(hash).first();
  if (!row || row.expires_at < now()) return null;
  await db.prepare(`UPDATE mcp_tokens SET last_used = datetime('now') WHERE hash = ?1`).bind(hash).run();
  return row.sub;
}

export const unauthorized = (origin) =>
  json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });

// For the Agents tab: which agents this account has approved, and taking it back.
export async function listClients(db, sub) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.created_at,
              (SELECT MAX(last_used) FROM mcp_tokens t WHERE t.client_id = c.id AND t.sub = ?1) AS last_used
       FROM mcp_clients c
       WHERE EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.client_id = c.id AND t.sub = ?1 AND t.kind = 'refresh' AND t.expires_at > ?2)
       ORDER BY c.created_at DESC`,
    )
    .bind(sub, now())
    .all();
  return results;
}

export const revoke = (db, clientId, sub) => db.prepare('DELETE FROM mcp_tokens WHERE client_id = ?1 AND sub = ?2').bind(clientId, sub).run();

// The discovery documents and the OAuth endpoints; null for any other path.
// audience: the origins login.finereli.com may have minted the token for (this app's).
export async function oauthRoute(request, env, url, audience) {
  const { pathname: path, origin } = url;
  if (!path.startsWith('/.well-known/') && !path.startsWith('/oauth/')) return null;
  if (request.method === 'OPTIONS') return preflight();
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return protectedResource(origin);
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') return authorizationServer(origin);
  if (path === '/oauth/register' && request.method === 'POST') return register(request, env.DB);
  if (path === '/oauth/authorize' && request.method === 'GET') return authorize(url, env);
  if (path === '/oauth/login' && request.method === 'GET') return loginReturn(url, env, audience);
  if (path === '/oauth/token' && request.method === 'POST') return token(request, env.DB);
  return null;
}

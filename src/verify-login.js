// Checks a finereli-login token (login.finereli.com): ES256 JWT, public keys from /jwks.json.
// Ported from the pwa kit's login/functions/verify-login.ts v1.

const enc = new TextEncoder();
const dec = new TextDecoder();
let keys = null;

export async function verifyLogin(request, opts) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  return token ? verifyLoginToken(token, opts) : null;
}

export async function verifyLoginToken(token, { audience, issuer = 'https://login.finereli.com' }) {
  try {
    const [head, body, sig] = token.split('.');
    if (!sig) return null;
    const header = JSON.parse(dec.decode(unb64u(head)));
    if (header.alg !== 'ES256') return null;
    const jwk = await findKey(issuer, header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(sig), enc.encode(`${head}.${body}`));
    if (!ok) return null;
    const claims = JSON.parse(dec.decode(unb64u(body)));
    const auds = Array.isArray(audience) ? audience : [audience];
    if (claims.iss !== issuer || !auds.includes(claims.aud) || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

async function findKey(issuer, kid) {
  const fresh = keys && keys.issuer === issuer && Date.now() - keys.at < 3600_000;
  let k = fresh ? keys.list.find((j) => j.kid === kid) : undefined;
  // Refetch at most once a minute for an unknown kid, so junk tokens can't turn every request into a JWKS fetch.
  if (!k && (!fresh || Date.now() - keys.at > 60_000)) {
    const res = await fetch(`${issuer}/jwks.json`);
    if (!res.ok) return undefined;
    keys = { list: (await res.json()).keys, at: Date.now(), issuer };
    k = keys.list.find((j) => j.kid === kid);
  }
  return k;
}

function unb64u(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// A stand-in for login.finereli.com, for testing signed-in behaviour against `wrangler dev` without Google.
// Serves a JWKS on :8788 and prints a token for a made-up account. Needs `LOGIN_ISSUER=http://localhost:8788` in .dev.vars.
// Usage: node tools/dev-login.mjs [email] [sub]     (the server stays up until you stop it; the token is printed once)
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';

const email = process.argv[2] || 'tester@example.com';
const sub = process.argv[3] || 'dev-' + email.split('@')[0];
const issuer = 'http://localhost:8788';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'dev', alg: 'ES256', use: 'sig' };
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const head = b64({ alg: 'ES256', kid: 'dev', typ: 'JWT' });
const body = b64({ iss: issuer, sub, aud: 'http://localhost:8787', exp: Math.floor(Date.now() / 1000) + 86400,
  email, email_verified: true, name: email.split('@')[0], picture: '' });
const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk] }));
}).listen(8788, () => console.log(`${head}.${body}.${sig}`));

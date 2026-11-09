// (1.93) Check of supabase/functions/push/webpush.js outside the browser tests: a payload it encrypts decrypts with the
// reference implementation (http_ece), and its VAPID token verifies (jose). Not part of run.sh (needs npm packages):
//   npm i http_ece@1.2.0 jose@5 && node tests/push_crypto.mjs
import crypto from 'node:crypto';
import ece from 'http_ece';
import * as jose from 'jose';
import { makeVapid, vapidAuth, encrypt, b64u } from '../supabase/functions/push/webpush.js';
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const auth = crypto.randomBytes(16);
const sub = { endpoint: 'https://web.push.apple.com/QGuT', keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
const msg = JSON.stringify({ title: 'Homework · due Tue 10 Nov', body: 'Skript S. 178, Aufgabe 3 ü' });
const out = ece.decrypt(Buffer.from(await encrypt(sub, msg)), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth });
const v = await makeVapid();
const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(await vapidAuth(sub.endpoint, v, 'https://slowoff.github.io/inkwell/'));
const pub = Buffer.from(k, 'base64url');
const { payload } = await jose.jwtVerify(t, await jose.importJWK({ kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, 'ES256'));
const ok = out.toString() === msg && payload.aud === 'https://web.push.apple.com' && payload.exp > Date.now() / 1000;
console.log(ok ? 'ALL OK' : 'FAILED');
if (!ok) process.exit(1);

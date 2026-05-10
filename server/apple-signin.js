// Sign in with Apple — id_token verification.
//
// Apple delivers a JWT (id_token) on every successful auth. We verify
// its signature against Apple's public keys, then trust the `sub`
// (stable Apple user id) and `email` claims. No client_secret JWT
// signing is required for THIS verification step — that's only needed
// when you exchange a `code` for tokens via Apple's /auth/token
// endpoint, which we skip because the id_token is already present in
// the form-post response.
//
// Required env:
//   APPLE_CLIENT_ID  — the Services ID configured in Apple Developer
//                      Portal (e.g. "com.gofirstbrand.web"). The `aud`
//                      claim on every valid id_token must equal this.
//
// Apple's signing keys rotate periodically. We fetch the JWK Set once
// and cache it in memory for an hour. On a kid-not-found we force a
// refetch — covers the keys-rotated-yesterday case without restarting.

const crypto = require('node:crypto');

const JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let _keysCache = null;
let _keysCacheAt = 0;

async function fetchKeys(force = false) {
  if (!force && _keysCache && Date.now() - _keysCacheAt < CACHE_TTL_MS) {
    return _keysCache;
  }
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error(`apple_jwks_${r.status}`);
  const data = await r.json();
  if (!data || !Array.isArray(data.keys)) throw new Error('apple_jwks_malformed');
  _keysCache = data.keys;
  _keysCacheAt = Date.now();
  return _keysCache;
}

function base64urlDecode(s) {
  // Pad to multiple of 4, replace url-safe chars.
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('jwt_malformed');
  const header  = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  const signing = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = base64urlDecode(parts[2]);
  return { header, payload, signing, signature };
}

// Verify the id_token JWT. Throws on any validation failure. Returns
// the decoded payload on success ({ sub, email, ... }).
async function verifyIdentityToken(idToken) {
  const expectedAud = process.env.APPLE_CLIENT_ID;
  if (!expectedAud) throw new Error('apple_client_id_unset');

  const { header, payload, signing, signature } = decodeJwt(idToken);
  if (header.alg !== 'RS256') throw new Error('jwt_alg_unsupported');
  if (!header.kid)            throw new Error('jwt_kid_missing');

  // First try the cached key set; if the kid isn't there, force a
  // refetch (Apple may have rotated their keys recently).
  let keys = await fetchKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('jwt_kid_unknown');

  // Build a public KeyObject from the JWK and verify the RSA signature.
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(
    'RSA-SHA256',
    signing,
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature,
  );
  if (!ok) throw new Error('jwt_signature_invalid');

  // Standard JWT claim checks. Apple's id_tokens expire after ~10
  // minutes; we apply a 30s clock-skew tolerance.
  const now = Math.floor(Date.now() / 1000);
  const skew = 30;
  if (payload.iss !== APPLE_ISSUER) throw new Error('jwt_iss_mismatch');
  if (Array.isArray(payload.aud) ? !payload.aud.includes(expectedAud) : payload.aud !== expectedAud) {
    throw new Error('jwt_aud_mismatch');
  }
  if (typeof payload.exp !== 'number' || now > payload.exp + skew) throw new Error('jwt_expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + skew)  throw new Error('jwt_iat_future');
  if (!payload.sub) throw new Error('jwt_sub_missing');

  return payload;
}

module.exports = { verifyIdentityToken };

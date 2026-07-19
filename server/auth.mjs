import crypto from 'node:crypto';

// PBKDF2 parameters. 200k iterations of SHA-256 is OWASP-recommended for 2024+.
const PBKDF2_ITER = 200_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  (() => {
    console.warn(
      '[auth] AUTH_SECRET not set; using a random ephemeral secret. ' +
        'Tokens will be invalidated on restart. Set AUTH_SECRET in production.',
    );
    return crypto.randomBytes(32).toString('hex');
  })();

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITER,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    iter: PBKDF2_ITER,
  };
}

export function verifyPassword(password, salt, expectedHash, iter) {
  const hash = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, 'hex'),
    iter,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  const a = Buffer.from(expectedHash, 'hex');
  if (hash.length !== a.length) return false;
  return crypto.timingSafeEqual(hash, a);
}

export function signToken(payload) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const b = b64url(JSON.stringify(body));
  const sig = b64url(
    crypto.createHmac('sha256', AUTH_SECRET).update(b).digest(),
  );
  return `${b}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b, sig] = parts;
  const expected = b64url(
    crypto.createHmac('sha256', AUTH_SECRET).update(b).digest(),
  );
  // constant-time compare
  const a = Buffer.from(sig);
  const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(b).toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.exp !== 'number' ||
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return payload;
}

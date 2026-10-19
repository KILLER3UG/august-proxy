// scripts/check-minisign.mjs
//
// The release gate for the updater signature.
//
// `scripts/minisign-verify.mjs` is a hand-written minisign verifier that the
// release pipeline uses to prove the signature it is about to publish verifies
// under the public key the installed app trusts. A verifier that silently
// accepts everything would be worse than no verifier at all — the gate would
// go green while the release stayed broken.
//
// THE FIRST TEST IS NOT A SELF-TEST.
//
// The first version of this gate signed with the same rule the verifier used,
// so the two agreed perfectly and the gate was green while the verifier
// rejected every REAL signature. The rule was wrong: minisign's primary
// signature covers the message ALONE, and the global signature covers
// `signature || trusted_comment` with the comment's prefix and newline
// stripped — not `untrusted_comment || message || trusted_comment`, which is
// what this verifier used to compute.
//
// A signer and a verifier that share a mistake agree. So the first test here
// is a vector that came from OUTSIDE this repository: the `minisign-verify`
// crate's own published test vector (minisign-verify 0.2.5,
// `src/lib.rs` `mod tests::verify`). It is the crate the app verifies with at
// install time (`backend.rs::verifyInstallerSignature`), so if this vector
// does not verify, the release is blocked for the right reason.
//
// Then the synthetic round trip, which covers what the external vector does
// not:
//
//   1. the crate's own vector verifies, and a tampered message does not
//   2. a good signature verifies; a tampered message does not
//   3. a signature made with a different key does not verify
//   4. a signature whose key id disagrees with the trusted key does not
//      verify, and says so
//   5. the public key pinned in tauri.conf.json parses, and its key id is
//      the one the app will compare against
//   6. the key tauri.conf.json pins and the key backend.rs hardcodes are
//      THE SAME KEY
//
// (6) is a second source of truth that used to exist with nothing holding it
// together: the release gate checked tauri.conf.json while the Windows app
// verified against the constant in backend.rs. Rotating one would pass the
// release and break every Windows update.
//
//   node scripts/check-minisign.mjs

import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodeMinisignPublicKey,
  signMinisignForTest,
  verifyMinisign,
} from './minisign-verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriConfPath = join(root, 'frontend', 'desktop', 'src-tauri', 'tauri.conf.json');
const backendRsPath = join(root, 'frontend', 'desktop', 'src-tauri', 'src', 'backend.rs');

const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

/** Raw 32-byte Ed25519 seed and public key from a generated keypair. */
function generateRawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    publicKeyRaw: Buffer.from(spki.subarray(spki.length - 32)),
    secretKeyRaw: Buffer.from(pkcs8.subarray(pkcs8.length - 32)),
  };
}

// ── 1. THE EXTERNAL VECTOR ───────────────────────────────────────────────
// The `minisign-verify` crate's own published test vector. Neither this file
// nor this repository produced it. If the verifier's format is wrong, this is
// what catches it.
const CRATE_PUBLIC_KEY = `untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
`;
const CRATE_SIGNATURE = `untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966	file:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==
`;
const CRATE_MESSAGE = Buffer.from('test', 'utf8');

const crateGood = verifyMinisign(CRATE_PUBLIC_KEY, CRATE_MESSAGE, CRATE_SIGNATURE);
expect(
  crateGood.ok,
  `the minisign-verify crate's own published vector did NOT verify: ${crateGood.reason ?? ''}. ` +
    'The verifier does not implement the minisign format the app verifies with.',
);
const crateTampered = verifyMinisign(
  CRATE_PUBLIC_KEY,
  Buffer.from('Test', 'utf8'),
  CRATE_SIGNATURE,
);
expect(!crateTampered.ok, 'the crate vector verified over a message it was not signed for');

// ── The synthetic round trip ─────────────────────────────────────────────
const MESSAGE = Buffer.from('the artifact that will be published', 'utf8');

const { publicKeyRaw, secretKeyRaw } = generateRawKeypair();
const keyIdBytes = Buffer.from('0011223344556677', 'hex');
const { signatureText, publicKeyText } = signMinisignForTest(
  publicKeyRaw,
  secretKeyRaw,
  MESSAGE,
  keyIdBytes,
);

// 2. A good signature verifies.
const good = verifyMinisign(publicKeyText, MESSAGE, signatureText);
expect(good.ok, `a valid signature did not verify: ${good.reason ?? ''}`);

// 3. A tampered message does not.
const tampered = verifyMinisign(publicKeyText, Buffer.from('a different artifact', 'utf8'), signatureText);
expect(!tampered.ok, 'a signature over a DIFFERENT message verified');

// 4. A signature made with a different key does not.
const other = generateRawKeypair();
const otherSigned = signMinisignForTest(
  other.publicKeyRaw,
  other.secretKeyRaw,
  MESSAGE,
  keyIdBytes,
);
const wrongKey = verifyMinisign(publicKeyText, MESSAGE, otherSigned.signatureText);
expect(!wrongKey.ok, 'a signature made with a DIFFERENT key verified');

// 5. A key id that disagrees is reported as such, not as a generic failure.
const mismatchedId = signMinisignForTest(publicKeyRaw, secretKeyRaw, MESSAGE, Buffer.from('8899aabbccddeeff', 'hex'));
const idMismatch = verifyMinisign(publicKeyText, MESSAGE, mismatchedId.signatureText);
expect(!idMismatch.ok, 'a signature with a mismatched key id verified');
expect(
  !idMismatch.ok && /different key/i.test(idMismatch.reason ?? ''),
  `a key-id mismatch was not reported as one: ${idMismatch.reason ?? ''}`,
);

// 6. The key the app trusts, and the key the release signs against, are one key.
let pinnedKeyId = null;
let pinnedPubkey = null;
try {
  const conf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
  const pubkey = conf?.plugins?.updater?.pubkey;
  expect(typeof pubkey === 'string' && pubkey.length > 0, 'tauri.conf.json has no updater pubkey');
  if (pubkey) {
    pinnedPubkey = pubkey;
    const decoded = decodeMinisignPublicKey(pubkey);
    pinnedKeyId = decoded.keyId;
    expect(decoded.algorithm === 'Ed', `unexpected updater key algorithm "${decoded.algorithm}"`);
    expect(
      decoded.publicKey.length === 32,
      `updater public key is ${decoded.publicKey.length} bytes, expected 32`,
    );
  }
} catch (err) {
  failures.push(`could not read the updater public key: ${err.message}`);
}

try {
  const rs = await readFile(backendRsPath, 'utf8');
  const match = rs.match(/UPDATER_PUBLIC_KEY_B64:\s*&str\s*=\s*"([^"]+)"/);
  expect(!!match, 'backend.rs no longer defines UPDATER_PUBLIC_KEY_B64');
  if (match && pinnedPubkey) {
    expect(
      match[1] === pinnedPubkey,
      'the updater key in tauri.conf.json and the one hardcoded in backend.rs are ' +
        'DIFFERENT. The release would sign against one and every Windows update ' +
        'would verify against the other.',
    );
  }
} catch (err) {
  failures.push(`could not read backend.rs: ${err.message}`);
}

if (failures.length) {
  console.error('[check-minisign] FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `[check-minisign] ok — the crate's own published vector verifies; a tampered ` +
    `message, a foreign key and a mismatched key id are rejected; the pinned ` +
    `updater key (${pinnedKeyId}) is the same key in tauri.conf.json and backend.rs`,
);

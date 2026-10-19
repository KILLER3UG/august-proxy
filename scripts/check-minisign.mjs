// scripts/check-minisign.mjs
//
// The release gate for the updater signature.
//
// `scripts/minisign-verify.mjs` is a hand-written minisign verifier that the
// release pipeline uses to prove the signature it is about to publish
// verifies under the public key the installed app trusts. A verifier that
// silently accepts everything would be worse than no verifier at all — the
// gate would go green while the release stayed broken.
//
// So this script exercises it against a keypair it generates itself:
//
//   1. a good signature verifies
//   2. a tampered message does NOT verify
//   3. a signature made with a different key does NOT verify
//   4. a signature whose key id disagrees with the trusted key does NOT
//      verify, and says so
//   5. the public key pinned in tauri.conf.json parses, and its key id is
//      the one the app will compare against
//
// There is no minisign binary in this repo and no signed release artifact to
// check against, so a synthetic round trip is the only thing that can be
// asserted here. The APP's own check is the authority at install time
// (`backend.rs::verifyInstallerSignature`, the `minisign-verify` crate); this
// is the build-time half.
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

const MESSAGE = Buffer.from('the artifact that will be published', 'utf8');

const { publicKeyRaw, secretKeyRaw } = generateRawKeypair();
const keyIdBytes = Buffer.from('0011223344556677', 'hex');
const { signatureText, publicKeyText } = signMinisignForTest(
  publicKeyRaw,
  secretKeyRaw,
  MESSAGE,
  keyIdBytes,
);

// 1. A good signature verifies.
const good = verifyMinisign(publicKeyText, MESSAGE, signatureText);
expect(good.ok, `a valid signature did not verify: ${good.reason ?? ''}`);

// 2. A tampered message does not.
const tampered = verifyMinisign(publicKeyText, Buffer.from('a different artifact', 'utf8'), signatureText);
expect(!tampered.ok, 'a signature over a DIFFERENT message verified');

// 3. A signature made with a different key does not.
const other = generateRawKeypair();
const otherSigned = signMinisignForTest(
  other.publicKeyRaw,
  other.secretKeyRaw,
  MESSAGE,
  keyIdBytes,
);
const wrongKey = verifyMinisign(publicKeyText, MESSAGE, otherSigned.signatureText);
expect(!wrongKey.ok, 'a signature made with a DIFFERENT key verified');

// 4. A key id that disagrees is reported as such, not as a generic failure.
const mismatchedId = signMinisignForTest(publicKeyRaw, secretKeyRaw, MESSAGE, Buffer.from('8899aabbccddeeff', 'hex'));
const idMismatch = verifyMinisign(publicKeyText, MESSAGE, mismatchedId.signatureText);
expect(!idMismatch.ok, 'a signature with a mismatched key id verified');
expect(
  !idMismatch.ok && /different key/i.test(idMismatch.reason ?? ''),
  `a key-id mismatch was not reported as one: ${idMismatch.reason ?? ''}`,
);

// 5. The public key the app actually trusts parses.
let pinnedKeyId = null;
try {
  const conf = JSON.parse(await readFile(tauriConfPath, 'utf8'));
  const pubkey = conf?.plugins?.updater?.pubkey;
  expect(typeof pubkey === 'string' && pubkey.length > 0, 'tauri.conf.json has no updater pubkey');
  if (pubkey) {
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

if (failures.length) {
  console.error('[check-minisign] FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `[check-minisign] ok — the verifier accepts a good signature, rejects a tampered ` +
    `message, a foreign key and a mismatched key id; the pinned updater key is ${pinnedKeyId}`,
);

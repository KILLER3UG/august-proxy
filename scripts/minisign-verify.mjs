// scripts/minisign-verify.mjs
//
// A minimal minisign verifier, for the ONE place the release pipeline needs it:
// proving that the updater signature it is about to publish verifies under the
// public key the installed app actually trusts.
//
// Why it exists. `tauri.conf.json` pins the updater `pubkey`; the release job
// signs with the private key from the `TAURI_SIGNING_PRIVATE_KEY` secret and
// nothing compares the two. A keypair mismatch is therefore invisible until a
// USER tries to update: the download succeeds, the signature check fails, and
// the app reports the installer as untrustworthy. Every user, every release,
// with the failure pointing at their machine rather than at the pipeline.
//
// What it does NOT do. It is not a replacement for the app's own check —
// `backend.rs::verifyInstallerSignature` uses the `minisign-verify` crate and
// is the authority at install time. This exists so the release FAILS LOUDLY
// at build time instead.
//
// Format (minisign, as implemented by the `minisign` Rust crate and the C
// tool the crate mirrors):
//
//   public key file   "untrusted comment: …\n"
//                     base64( alg[2] || key_id[8] || public_key[32] )
//
//   signature file    "untrusted comment: …\n"
//                     base64( alg[2] || key_id[8] || signature[64] )
//                     "trusted comment: …\n"
//                     base64( global_signature[64] )
//
// The primary signature is over `untrusted_comment || message ||
// trusted_comment` — the comment lines INCLUDED, with their newlines, which
// is what `read_until(b'\n')` keeps on both sides. The global signature is
// over `signature || trusted_comment`.
//
// `alg` is "Ed" for the legacy mode (plain Ed25519 over the message) and "ED"
// for the prehashed mode (BLAKE2b-512 of the message, then Ed25519). The
// public key file always says "Ed"; the SIGNATURE carries the mode.
//
// Tauri's `.sig` asset is ONE base64 line wrapping the four-line minisign
// text, so the wrapper is unwrapped first. Plain minisign text is accepted
// too — the app's `decodeInstallerSignature` accepts both, and this must
// accept exactly what the app will.

import { createHash, createPrivateKey, createPublicKey, sign, verify as ed25519Verify } from 'node:crypto';

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Split a minisign text file into its lines, keeping each line's bytes. */
function readLines(text) {
  const buf = Buffer.from(text, 'utf8');
  const lines = [];
  let pos = 0;
  while (pos < buf.length) {
    const idx = buf.indexOf(0x0a, pos);
    if (idx === -1) {
      lines.push(buf.subarray(pos));
      break;
    }
    lines.push(buf.subarray(pos, idx + 1));
    pos = idx + 1;
  }
  return lines;
}

/** Decode a base64 line into bytes, tolerating CRLF and trailing spaces. */
function decodeLine(line) {
  return Buffer.from(line.toString('utf8').trim(), 'base64');
}

/**
 * The minisign public key text. Accepts the file's own text, or the base64
 * wrapper Tauri uses for the `pubkey` setting.
 */
export function decodeMinisignPublicKey(text) {
  const raw = text.trim();
  let body = raw;
  if (!body.includes('untrusted comment:')) {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (!decoded.includes('untrusted comment:')) {
      throw new Error('public key is neither minisign text nor base64-wrapped minisign text');
    }
    body = decoded;
  }
  const lines = readLines(body).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error('public key is missing its key line');
  const blob = decodeLine(lines[lines.length - 1]);
  if (blob.length !== 42) {
    throw new Error(`public key blob is ${blob.length} bytes, expected 42`);
  }
  return {
    algorithm: blob.subarray(0, 2).toString('latin1'),
    keyId: blob.subarray(2, 10).toString('hex').toUpperCase(),
    publicKey: blob.subarray(10, 42),
  };
}

/**
 * The minisign signature text, unwrapped from Tauri's base64 wrapper.
 * Returns the raw text; `parseMinisignSignature` does the structure.
 */
export function unwrapMinisignSignature(text) {
  const raw = text.trim();
  if (raw.includes('untrusted comment:')) return raw;
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  if (decoded.includes('untrusted comment:')) return decoded;
  throw new Error('signature is neither minisign text nor base64-wrapped minisign text');
}

/** The four-line minisign signature, parsed. */
export function parseMinisignSignature(text) {
  const lines = readLines(unwrapMinisignSignature(text));
  if (lines.length < 4) {
    throw new Error(`signature has ${lines.length} lines, expected 4`);
  }
  const untrustedComment = lines[0];
  const sigBlob = decodeLine(lines[1]);
  const trustedComment = lines[2];
  const globalBlob = decodeLine(lines[3]);
  if (sigBlob.length !== 74) {
    throw new Error(`signature blob is ${sigBlob.length} bytes, expected 74`);
  }
  if (globalBlob.length !== 64) {
    throw new Error(`global signature is ${globalBlob.length} bytes, expected 64`);
  }
  return {
    algorithm: sigBlob.subarray(0, 2).toString('latin1'),
    keyId: sigBlob.subarray(2, 10).toString('hex').toUpperCase(),
    signature: sigBlob.subarray(10, 74),
    globalSignature: globalBlob,
    untrustedComment,
    trustedComment,
  };
}

/** The message the primary signature covers. */
function signedMessage(sig, message) {
  return Buffer.concat([sig.untrustedComment, message, sig.trustedComment]);
}

/** Verify one Ed25519 signature, accepting either minisign algorithm mode. */
function verifyEitherMode(publicKey, message, signature) {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  if (ed25519Verify(null, message, key, signature)) return true;
  // The prehashed variant: BLAKE2b-512 of the message, then Ed25519.
  const hashed = createHash('blake2b512').update(message).digest();
  return ed25519Verify(null, hashed, key, signature);
}

/**
 * Verify a minisign signature over `message` under `publicKeyText`.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }` — a verification failure
 * is a normal outcome here (a wrong key is exactly what the caller wants to
 * hear about), not an exception.
 */
export function verifyMinisign(publicKeyText, message, signatureText) {
  let pk;
  let sig;
  try {
    pk = decodeMinisignPublicKey(publicKeyText);
  } catch (err) {
    return { ok: false, reason: `public key is unusable: ${err.message}` };
  }
  try {
    sig = parseMinisignSignature(signatureText);
  } catch (err) {
    return { ok: false, reason: `signature is unusable: ${err.message}` };
  }
  if (pk.keyId !== sig.keyId) {
    return {
      ok: false,
      reason:
        `signature was made with a different key (key id ${sig.keyId}, ` +
        `trusted key id ${pk.keyId})`,
    };
  }
  if (pk.algorithm !== 'Ed') {
    return { ok: false, reason: `unsupported public key algorithm "${pk.algorithm}"` };
  }
  if (sig.algorithm !== 'Ed' && sig.algorithm !== 'ED') {
    return { ok: false, reason: `unsupported signature algorithm "${sig.algorithm}"` };
  }
  const message2 = signedMessage(sig, message);
  if (!verifyEitherMode(pk.publicKey, message2, sig.signature)) {
    return { ok: false, reason: 'the primary signature does not verify' };
  }
  const globalMessage = Buffer.concat([sig.signature, sig.trustedComment]);
  if (!verifyEitherMode(pk.publicKey, globalMessage, sig.globalSignature)) {
    return { ok: false, reason: 'the global signature does not verify' };
  }
  return { ok: true, keyId: pk.keyId };
}

/**
 * Build a minisign signature over `message`. Exported so the gate can
 * self-test the verifier against a keypair it controls — without a minisign
 * binary and without a real release artifact.
 *
 * `secretKeyRaw` is the 32-byte Ed25519 seed.
 */
export function signMinisignForTest(publicKeyRaw, secretKeyRaw, message, keyIdBytes) {
  const keyId = Buffer.from(keyIdBytes);
  const untrustedComment = Buffer.from('untrusted comment: signature from test key\n', 'utf8');
  const trustedComment = Buffer.from('trusted comment: timestamp:1700000000\n', 'utf8');
  const message2 = Buffer.concat([untrustedComment, message, trustedComment]);
  const signature = signRaw(secretKeyRaw, message2);
  const globalSignature = signRaw(secretKeyRaw, Buffer.concat([signature, trustedComment]));
  const sigBlob = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, signature]);
  const pubBlob = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, publicKeyRaw]);
  return {
    signatureText:
      untrustedComment.toString('utf8') +
      sigBlob.toString('base64') +
      '\n' +
      trustedComment.toString('utf8') +
      globalSignature.toString('base64') +
      '\n',
    publicKeyText:
      'untrusted comment: minisign public key: test\n' + pubBlob.toString('base64') + '\n',
  };
}

/** Sign with a raw Ed25519 seed (32 bytes) via a PKCS8 wrapper. */
function signRaw(secretKeyRaw, message) {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    secretKeyRaw,
  ]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return sign(null, message, key);
}

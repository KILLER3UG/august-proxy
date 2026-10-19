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
// It is NOT the authority at install time. `backend.rs::verifyInstallerSignature`
// uses the `minisign-verify` crate and is. This exists so the release FAILS
// LOUDLY at build time instead.
//
// ── THE FORMAT, AS THE CRATE IMPLEMENTS IT ────────────────────────────────
//
// This file mirrors `minisign-verify` 0.2.5, because that crate is what
// verifies the signature on the user's machine. An earlier version of this
// file got it wrong in a way no self-test could catch, and the difference
// matters:
//
//   public key file   "untrusted comment: …"
//                     base64( alg[2] || key_id[8] || public_key[32] )
//
//   signature file    "untrusted comment: …"
//                     base64( alg[2] || key_id[8] || signature[64] )
//                     "trusted comment: …"
//                     base64( global_signature[64] )
//
// **The primary signature is over the MESSAGE ALONE.** Not the message with
// the comments around it. The `untrusted comment:` line is called UNTRUSTED
// because it is not signed at all; it is free text the signer writes.
//
// **The global signature is over `signature || trusted_comment`**, where
// `trusted_comment` is the comment text with the "trusted comment: " prefix
// REMOVED and WITHOUT a trailing newline. The crate's decoder splits the
// file with Rust's `str::lines()`, which drops the line terminator, and
// `trusted_comment()` then returns `&self.trusted_comment[17..]`.
//
// The earlier version of this file signed
// `untrusted_comment || message || trusted_comment` and used the comment line
// — prefix and newline included — as the global message. Both are wrong, and
// both are wrong in a way that is INVISIBLE to a self-test that signs with
// the same wrong rule. The fix is not "be careful"; it is a test vector that
// came from OUTSIDE this file: the `minisign-verify` crate's own published
// vector, checked in `scripts/check-minisign.mjs`.
//
// `alg` is "Ed" for the legacy mode (plain Ed25519 over the message) and "ED"
// for the prehashed mode (BLAKE2b-512 of the message, then Ed25519). The
// public key file always says "Ed"; the SIGNATURE carries the mode. The app
// verifies with `allow_legacy = true`, so both modes are accepted.
//
// Tauri's `.sig` asset is ONE base64 line wrapping the four-line minisign
// text, so the wrapper is unwrapped first. Plain minisign text is accepted
// too — the app's `decodeInstallerSignature` accepts both, and this must
// accept exactly what the app will.

import { createHash, createPrivateKey, createPublicKey, sign, verify as ed25519Verify } from 'node:crypto';

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Length of the "trusted comment: " prefix the crate strips. */
const TRUSTED_COMMENT_PREFIX = 'trusted comment: ';

/**
 * Split text into lines the way Rust's `str::lines()` does: on `\n`, with a
 * trailing `\r` dropped and the terminator NOT kept. The crate decodes with
 * `.lines()`, so a verifier that keeps the terminator computes a different
 * global message and rejects every valid signature.
 */
function readLines(text) {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Decode a base64 line into bytes, tolerating surrounding whitespace. */
function decodeLine(line) {
  return Buffer.from(line.trim(), 'base64');
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
  const trustedCommentLine = lines[2];
  const globalBlob = decodeLine(lines[3]);
  if (sigBlob.length !== 74) {
    throw new Error(`signature blob is ${sigBlob.length} bytes, expected 74`);
  }
  if (globalBlob.length !== 64) {
    throw new Error(`global signature is ${globalBlob.length} bytes, expected 64`);
  }
  if (!trustedCommentLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error('signature is missing its "trusted comment: " line');
  }
  return {
    algorithm: sigBlob.subarray(0, 2).toString('latin1'),
    keyId: sigBlob.subarray(2, 10).toString('hex').toUpperCase(),
    signature: sigBlob.subarray(10, 74),
    globalSignature: globalBlob,
    untrustedComment,
    // The crate's `trusted_comment()`: the prefix is stripped, and the line
    // terminator is already gone because the file was split with `.lines()`.
    trustedComment: trustedCommentLine.slice(TRUSTED_COMMENT_PREFIX.length),
  };
}

/**
 * The bytes the primary signature covers.
 *
 * The message ALONE for the legacy mode; BLAKE2b-512 of the message for the
 * prehashed mode. The mode is read from the signature's algorithm bytes, the
 * way the crate reads it — never "try both", because "try both" is how a
 * verifier ends up accepting a mode the app would reject.
 */
function primaryMessage(sig, message) {
  if (sig.algorithm === 'ED') {
    return createHash('blake2b512').update(message).digest();
  }
  return message;
}

/** Verify one Ed25519 signature over `data` under a raw public key. */
function verifyRaw(publicKey, data, signature) {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return ed25519Verify(null, data, key, signature);
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
  if (!verifyRaw(pk.publicKey, primaryMessage(sig, message), sig.signature)) {
    return { ok: false, reason: 'the primary signature does not verify' };
  }
  // The global signature covers the primary signature and the trusted
  // comment text — the comment WITHOUT its prefix and WITHOUT a newline.
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!verifyRaw(pk.publicKey, globalMessage, sig.globalSignature)) {
    return { ok: false, reason: 'the global signature does not verify' };
  }
  return { ok: true, keyId: pk.keyId };
}

/**
 * Build a minisign signature over `message`. Exported so the gate can
 * cross-check the verifier against a keypair it controls — but this is NOT
 * the gate's main test. A signer and a verifier that share a mistake agree
 * perfectly, so `scripts/check-minisign.mjs` also verifies the crate's own
 * published vector, which this file did not produce.
 *
 * `secretKeyRaw` is the 32-byte Ed25519 seed.
 */
export function signMinisignForTest(publicKeyRaw, secretKeyRaw, message, keyIdBytes) {
  const keyId = Buffer.from(keyIdBytes);
  const untrustedComment = 'untrusted comment: signature from test key';
  const trustedCommentText = 'timestamp:1700000000';
  // The primary signature covers the MESSAGE ALONE.
  const signature = signRaw(secretKeyRaw, message);
  // The global signature covers the primary signature and the trusted
  // comment text — no prefix, no newline.
  const globalSignature = signRaw(
    secretKeyRaw,
    Buffer.concat([signature, Buffer.from(trustedCommentText, 'utf8')]),
  );
  const sigBlob = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, signature]);
  const pubBlob = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, publicKeyRaw]);
  return {
    signatureText:
      untrustedComment +
      '\n' +
      sigBlob.toString('base64') +
      '\n' +
      TRUSTED_COMMENT_PREFIX +
      trustedCommentText +
      '\n' +
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

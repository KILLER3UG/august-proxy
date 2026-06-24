/**
 * context-scrubber.js — Streaming state machine that strips <memory_context> blocks
 * from SSE text output. Prevents raw memory content from leaking to the UI when
 * opening/closing tags split across streaming deltas.
 *
 * States:
 *   OUTSIDE → SAW_LT → INSIDE → SAW_SLASH → OUTSIDE
 *
 * OUTSIDE: emit text normally, watching for '<'
 * SAW_LT: saw '<' — buffering to check if it opens 'memory_context'
 * INSIDE: inside a <memory_context> block — discard all content, watching for '<'
 * SAW_SLASH: saw '</' inside a block — buffering to check if it closes 'memory_context'
 */

const OPEN_TAG = 'memory_context';
const CLOSE_TAG = '/memory_context';

const OUTSIDE = 0;
const SAW_LT = 1;
const INSIDE = 2;
const SAW_SLASH = 3;

class ContextScrubber {
  constructor() {
    this.reset();
  }

  reset() {
    this._state = OUTSIDE;
    this._buf = '';
    this._tagBuf = '';
  }

  /**
   * Feed a text chunk through the scrubber.
   * @param {string} chunk - The text delta from the model output
   * @returns {string} Cleaned text (may be empty if content was fully inside a memory block)
   */
  feed(chunk) {
    if (!chunk) return '';

    if (this._state === OUTSIDE || this._state === SAW_LT) {
      return this._feedOutside(chunk);
    } else {
      return this._feedInside(chunk);
    }
  }

  _feedOutside(chunk) {
    let result = '';
    let i = 0;

    if (this._state === SAW_LT) {
      // We have a pending '<' — check if this chunk completes '<memory_context'
      const needed = OPEN_TAG.length - 1; // we already have '<', need 'memory_context...>'
      const tagTest = this._buf + chunk.slice(0, Math.min(needed + 10, chunk.length));
      const isClose = tagTest.includes('</');
      if (tagTest.startsWith('<memory_context') || tagTest.startsWith('</memory_context')) {
        if (isClose) {
          // Close tag while outside — skip it entirely, stay OUTSIDE
          this._state = OUTSIDE;
          this._buf = '';
          const closeLen = '</memory_context>'.length - 1; // we already consumed '<'
          const after = chunk.slice(closeLen);
          return result + this._feedOutside(after);
        }
        // Opening tag — enter INSIDE
        const fullTag = this._consumeOpenTag(chunk, needed);
        if (fullTag) {
          this._state = INSIDE;
          this._tagBuf = '';
          const afterTag = chunk.slice(fullTag.length - (this._buf ? this._buf.length : 0));
          this._buf = '';
          return result + this._feedInside(afterTag);
        }
      }
      // Not a memory_context tag — emit the buffered '<' and continue
      result += '<';
      this._state = OUTSIDE;
      this._buf = '';
    }

    for (; i < chunk.length; i++) {
      const c = chunk[i];
      if (c === '<') {
        // Check if this starts a memory_context tag
        const rest = chunk.slice(i + 1);
        if (rest.startsWith('memory_context') || rest.startsWith('/memory_context')) {
          // Full tag in this chunk
          if (rest.startsWith('/memory_context')) {
            // Closing tag while outside — just skip it
            const closeLen = '/memory_context>'.length;
            i += closeLen;
            continue;
          }
          // Opening tag — skip to end of tag and switch to INSIDE
          const tagEnd = rest.indexOf('>');
          if (tagEnd >= 0) {
            i += 1 + tagEnd; // skip to end of >
            this._state = INSIDE;
            return result + this._feedInside(chunk.slice(i + 1));
          } else {
            // Tag not closed in this chunk
            this._state = INSIDE;
            this._buf = chunk.slice(i);
            return result;
          }
        }
        // Could be start of a memory_context tag spanning chunks
        if (rest.length < 'memory_context'.length) {
          // Not enough chars to confirm — buffer
          this._state = SAW_LT;
          this._buf = c;
          return result;
        }
        result += c;
      } else {
        result += c;
      }
    }

    return result;
  }

  _feedInside(chunk) {
    if (!chunk) return '';

    if (this._state === SAW_SLASH) {
      // We saw '</' at end of last chunk — check this one
      const needed = 'memory_context>'.length;
      const tagTest = this._tagBuf + chunk.slice(0, Math.min(needed, chunk.length));
      if (tagTest === '</memory_context>') {
        this._state = OUTSIDE;
        this._tagBuf = '';
        this._buf = '';
        // Skip past the close tag and recurse on remainder
        const after = chunk.slice(needed);
        return this._feedOutside(after);
      }
      // Not a close — it was something else, stay INSIDE
      this._state = INSIDE;
      this._tagBuf = '';
      // Re-process from this chunk (the '</' is in this._buf)
      return this._feedInside(this._buf + chunk);
    }

    let i = 0;
    for (; i < chunk.length; i++) {
      const c = chunk[i];
      if (c === '<') {
        const rest = chunk.slice(i + 1);
        if (rest.startsWith('/memory_context>')) {
          // Full close tag in this chunk
          this._state = OUTSIDE;
          const after = chunk.slice(i + '/memory_context>'.length + 1);
          return this._feedOutside(after);
        }
        if (rest.startsWith('/memory_context')) {
          // Close tag started but '>' in next chunk
          this._state = SAW_SLASH;
          this._tagBuf = chunk.slice(i);
          return '';
        }
        // Could be closing tag spanning boundary
        if (rest === '' || (rest.length < '/memory_context>'.length && '/memory_context>'.startsWith('/' + rest))) {
          this._state = SAW_SLASH;
          this._tagBuf = chunk.slice(i);
          return '';
        }
        // Some other tag — ignore, stay inside
      }
      // else: discard content (we're inside memory_context)
    }

    return '';
  }

  _consumeOpenTag(chunk, needed) {
    // Find the end of the opening tag
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === '>') {
        return chunk.slice(0, i + 1);
      }
    }
    return null;
  }
}

module.exports = { ContextScrubber };

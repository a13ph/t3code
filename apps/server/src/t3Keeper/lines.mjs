// Line framing shared by the keeper and the shim.
//
// A LineSplitter takes Buffers or strings in any chunking and hands out
// whole lines without their trailing "\n". A multi-byte UTF-8 character
// split across two chunks is decoded once, whole.
import { StringDecoder } from 'node:string_decoder';

export class LineSplitter {
  #decoder = new StringDecoder('utf8');
  // the pieces of a line not ended yet; only each new chunk is searched for
  // "\n", so a line of many chunks costs its length once, not per chunk
  #rest = [];
  #onLine;

  constructor(onLine) {
    this.#onLine = onLine;
  }

  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) !== -1) {
      const piece = text.slice(start, nl);
      const line = this.#rest.length > 0 ? this.#rest.join('') + piece : piece;
      this.#rest = [];
      start = nl + 1;
      this.#onLine(line);
    }
    if (start < text.length) this.#rest.push(text.slice(start));
  }

  // Emits a last line that had no "\n" after it, if any.
  end() {
    const tail = this.#rest.join('') + this.#decoder.end();
    this.#rest = [];
    if (tail.length > 0) this.#onLine(tail);
  }
}

export function frame(obj) {
  return JSON.stringify(obj) + '\n';
}

interface CachedText {
  readonly filePath: string | undefined;
  readonly result: string;
}

/**
 * Least-recently-used results of masking whole strings, bounded by stored characters.
 * Pi clones the conversation for every model request, so message objects cannot be
 * cache keys; the text itself is. Hashing a string is far cheaper than rescanning it.
 */
export class TextCache {
  readonly #entries = new Map<string, CachedText>();
  #storedCharacters = 0;

  constructor(
    readonly maxCharacters: number,
    readonly maxEntries: number,
  ) {}

  get(text: string, filePath: string | undefined): string | undefined {
    const entry = this.#entries.get(text);
    if (entry === undefined || entry.filePath !== filePath) return undefined;
    this.#entries.delete(text);
    this.#entries.set(text, entry);
    return entry.result;
  }

  set(text: string, filePath: string | undefined, result: string): void {
    const cost = this.#cost(text, result);
    if (cost > this.maxCharacters / 4) return;
    this.#remove(text);
    this.#entries.set(text, { filePath, result });
    this.#storedCharacters += cost;
    for (const [oldest] of this.#entries) {
      if (this.#storedCharacters <= this.maxCharacters && this.#entries.size <= this.maxEntries) break;
      this.#remove(oldest);
    }
  }

  #cost(text: string, result: string): number {
    // An unchanged result is the same string as its key and stores nothing extra.
    return text.length + (result === text ? 0 : result.length);
  }

  #remove(text: string): void {
    const entry = this.#entries.get(text);
    if (entry === undefined) return;
    this.#entries.delete(text);
    this.#storedCharacters -= this.#cost(text, entry.result);
  }
}

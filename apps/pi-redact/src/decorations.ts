// Prefixes that tools put in front of file lines. The library masks an unquoted assignment
// such as `API_KEY=value` only at the start of a line, so `grep -n`, `cat -n`, and diff
// output would otherwise show the value. The content after the prefix is scanned again.

/** `path:12:` or `path-12-` (grep, git grep, rg), with an optional `col:` (rg --column). */
const GREP_LINE = /([^\s:]+?)([:-])\d+\2(?:\d+\2)?/y;
/**
 * `path:` without a line number (grep -r). One character class keeps the match linear on long
 * lines; `looksLikePath` then requires a `.` or `/`, so `https:` and `key:` do not count.
 */
const GREP_PATH = /([^\s:]+):(?=\S)/y;
const looksLikePath = (text: string) => text.includes(".") || text.includes("/");
/** `    12\t` (cat -n, nl), `12:` (rg headings), `12|` or `12→` (numbered viewers). */
const LINE_NUMBER = /[ \t]*\d+(?:\t|: ?|\| ?|→ ?)/y;
/** Added or removed diff lines; `+++` and `---` file headers are not content. */
const DIFF_MARK = /[+\-<>](?![+-]{2})/y;

export interface LineDecoration {
  /** Index in the full text where the decorated line's content starts. */
  readonly contentStart: number;
  /** File path a grep prefix names, used as the scan's path hint. */
  readonly filePath?: string;
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** The content start of the line at `lineStart` when it carries a known tool prefix. */
export function findLineDecoration(text: string, lineStart: number, lineEnd: number): LineDecoration | undefined {
  let position = lineStart;
  let filePath: string | undefined;
  let grep = matchAt(GREP_LINE, text, position);
  if (!grep) {
    const pathOnly = matchAt(GREP_PATH, text, position);
    if (pathOnly && looksLikePath(pathOnly[1])) grep = pathOnly;
  }
  if (grep) {
    position += grep[0].length;
    filePath = grep[1];
  }
  const lineNumber = matchAt(LINE_NUMBER, text, position);
  if (lineNumber) position += lineNumber[0].length;
  const diffMark = matchAt(DIFF_MARK, text, position);
  if (diffMark) position += diffMark[0].length;
  if (position === lineStart || position >= lineEnd) return undefined;
  return filePath === undefined ? { contentStart: position } : { contentStart: position, filePath };
}

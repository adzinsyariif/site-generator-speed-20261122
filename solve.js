// A fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build()
// returns for the same input: every page, index and tag page, the build
// report and every static file, byte for byte. The behaviour is specified
// by makefun-site's README and its code; this file re-implements that
// behaviour from scratch, tuned for speed:
//
//   - one scanning pass over every string, no regex where a loop will do;
//   - HTML escaping inlined into the scans instead of a replace callback;
//   - Markdown rendered straight to an output array, no token objects;
//   - templates compiled once per case into small JS functions, so a page
//     render is a function call and a few direct property reads, not a
//     tree walk;
//   - slug and long-date results memoised inside one case (a fresh memo
//     per case, so no case ever sees another case's work);
//   - ASCII fast paths wherever Unicode normalisation would be a no-op.
//
// Dependency-free, ES module, no I/O, no clock, no randomness: the answer
// is a pure function of the input.

/** Directories the generator writes itself; no root slug may take one. */
const RESERVED = ['posts', 'tags', 'page'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const hasOwn = Object.hasOwn;

/** Per-case memos, reset at the top of run(). */
let slugCache = new Map();
let longCache = new Map();

/** `text` with & < > " and ' escaped. Returns the input untouched when it holds none of them. */
const SPECIAL_RE = /[&<>"']/;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(text) {
  if (!SPECIAL_RE.test(text)) return text;
  // Long text: a native replace scan beats the per-character loop.
  if (text.length >= 64) return text.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += text.slice(last, i) + rep;
    last = i + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}/gu;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of other characters one "-", none at either end, at most 64 characters, "untitled" when nothing is left. */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = plain
    .replace(/[A-Z]|[^a-zA-Z0-9]+/g, (m) => (m.length === 1 && m >= 'A' && m <= 'Z' ? m.toLowerCase() : '-'))
    .replace(/^-+|-+$/g, '');
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const hit = longCache.get(date);
  if (hit !== undefined) return hit;
  const s = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  longCache.set(date, s);
  return s;
}

/** Whether `c` (a UTF-16 code unit) is JavaScript whitespace. */
function isWsCode(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** isWsCode as a table, for the one pass that classifies every character of every body. */
const WS_TABLE = new Uint8Array(65536);
for (let c = 0; c < 65536; c++) WS_TABLE[c] = isWsCode(c) ? 1 : 0;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing "---" line.
  let pos = nl0 + 1;
  let closeLine = -1;
  let closeEnd = -1;
  let lineNo = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      closeLine = lineNo;
      closeEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl0 + 1;
  for (let ln = 1; ln < closeLine; ln++) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      // A "key: value" line: a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || line[k] !== ':') return { error: `line ${ln + 1} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2);
      else return { error: `line ${ln + 1} is not "key: value"` };
      let rawEnd = raw.length;
      while (rawEnd > 0 && (raw.charCodeAt(rawEnd - 1) === 32 || raw.charCodeAt(rawEnd - 1) === 9)) rawEnd--;
      if (rawEnd < raw.length) raw = raw.slice(0, rawEnd);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `c` may appear in a fence language. */
function isLangChar(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45
  );
}

/** Whether the rest of `line` from `i` holds only spaces and tabs. */
function onlySpaceTab(line, i) {
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  if (!onlySpaceTab(line, j)) return null;
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  return (
    line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaceTab(line, 3)
  );
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  const d = line.charCodeAt(1);
  const e = line.charCodeAt(2);
  if (d !== c || e !== c) return false;
  return onlySpaceTab(line, 3);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  if (n < 2 || n >= line.length) return false;
  return !isWsCode(line.charCodeAt(n));
}

/** A bullet item's text, or null: `- ` or `* ` and the rest. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null: 1 to 9 digits, `. ` and the rest. */
function orderedOf(line) {
  let j = 0;
  while (j < 9 && j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), text: line.slice(j + 2) };
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/**
 * Whether an escape pair formed by the backslashes in [pos, k) swallows
 * `s[k]`: scanning from `pos`, a backslash whose next character is escapable
 * consumes it, and `s[k]` is consumed exactly when such a pair ends at `k`.
 */
function swallowsAt(s, pos, k) {
  let j = s.indexOf('\\', pos);
  while (j !== -1 && j < k) {
    if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      if (j + 1 === k) return true;
      j = s.indexOf('\\', j + 2);
    } else {
      j = s.indexOf('\\', j + 1);
    }
  }
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let pos = from;
  for (;;) {
    const k = s.indexOf(what, pos);
    if (k === -1) return -1;
    if (!swallowsAt(s, pos, k)) return k;
    pos = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let pos = from;
  for (;;) {
    const k = s.indexOf('*', pos);
    if (k === -1) return -1;
    if (swallowsAt(s, pos, k)) {
      pos = k + 1;
    } else if (s[k + 1] === '*') {
      pos = k + 2;
    } else return k;
  }
}

/** Every character inline rendering treats specially: a construct opener or one HTML escapes. */
const INLINE_SPECIAL = /[\\`*[&<>"']/g;
const INLINE_SPLIT = /([\\`*[&<>"'])/;
const INLINE_SPECIAL_TEST = /[\\`*[&<>"']/;
const CONSTRUCT_TEST = /[\\`*\[]/;

/** `s` rendered inline; `link(target)` is a link's href. */
function inlineMd(s, link) {
  if (!INLINE_SPECIAL_TEST.test(s)) return s;
  // With no construct opener present, only the escapes remain: that is escapeHtml.
  if (!CONSTRUCT_TEST.test(s)) return escapeHtml(s);
  // One native split gives every plain run and every special character; the
  // parts alternate text, special, text, ... and tile `s` exactly, so a
  // running offset tracks each part's place. A construct consumes its span
  // of `s` directly and the parts it spans are skipped (a text part it ends
  // inside contributes only its tail).
  const parts = s.split(INLINE_SPLIT);
  const out = [];
  let pos = 0; // the offset in `s` where the current part starts
  let skipUntil = 0; // constructs consume `s` up to here
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    const start = pos;
    pos += part.length;
    if (start + part.length <= skipUntil) continue;
    if (k % 2 === 0) {
      out.push(start < skipUntil ? part.slice(skipUntil - start) : part);
      continue;
    }
    const c = part.charCodeAt(0);
    if (c === 92) {
      // Backslash: before an escapable character it writes that character (escaped).
      const d = s[start + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        out.push(d === '>' ? '&gt;' : d);
        skipUntil = start + 2;
      } else out.push('\\');
    } else if (c === 96) {
      // A backtick opens a code span closed by the next backtick, with at least one character between.
      const close = s.indexOf('`', start + 1);
      if (close > start + 1) {
        out.push('<code>', escapeHtml(s.slice(start + 1, close)), '</code>');
        skipUntil = close + 1;
      } else out.push('`');
    } else if (c === 38) out.push('&amp;');
    else if (c === 60) out.push('&lt;');
    else if (c === 62) out.push('&gt;');
    else if (c === 34) out.push('&quot;');
    else if (c === 39) out.push('&#39;');
    else if (c === 42) {
      if (s[start + 1] === '*') {
        // `**` opens strong, closed by the next `**` not escaped, with at least one character between.
        const end = findUnescaped(s, '**', start + 2);
        if (end > start + 2) {
          out.push('<strong>', inlineMd(s.slice(start + 2, end), link), '</strong>');
          skipUntil = end + 2;
        } else {
          out.push('**');
          skipUntil = start + 2;
        }
      } else {
        // A single `*` opens emphasis, closed by the next single `*`, with at least one character between.
        const end = findSingleStar(s, start + 1);
        if (end > start + 1) {
          out.push('<em>', inlineMd(s.slice(start + 1, end), link), '</em>');
          skipUntil = end + 1;
        } else out.push('*');
      }
    } else {
      // `[text](target)`: the first `]` not escaped closes the text, `(` must follow at once.
      const close = findUnescaped(s, ']', start + 1);
      const t = close !== -1 && s[close + 1] === '(' ? s.indexOf(')', close + 2) : -1;
      const target = t === -1 ? '' : s.slice(close + 2, t);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">', inlineMd(s.slice(start + 1, close), link), '</a>');
        skipUntil = t + 1;
      } else out.push('[');
    }
  }
  return out.join('');
}

/** A line's kind, in one pass: 0 other, 1 blank, 2 fence, 3 heading, 4 thematic break. */
function lineKind(line) {
  if (line.length === 0) return 1;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line) ? 1 : 0;
  if (c0 === 96) return fenceOpen(line) !== null ? 2 : 0;
  if (c0 === 35) return headingOf(line) !== null ? 3 : 0;
  if (c0 === 45 || c0 === 42) return isHr(line) ? 4 : 0;
  return 0;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    // The line's kind, classified once: lineKind's answer, with the fence's
    // language or the heading already parsed when the kind needs them.
    let kind = 0;
    let lang = null;
    let hd = null;
    if (line.length === 0) kind = 1;
    else {
      const c0 = line.charCodeAt(0);
      if (c0 === 32 || c0 === 9) kind = isBlank(line) ? 1 : 0;
      else if (c0 === 96) {
        lang = fenceOpen(line);
        kind = lang !== null ? 2 : 0;
      } else if (c0 === 35) {
        hd = headingOf(line);
        kind = hd !== null ? 3 : 0;
      } else if (c0 === 45 || c0 === 42) kind = isHr(line) ? 4 : 0;
    }
    if (kind === 1) {
      i++;
      continue;
    }
    if (kind === 2) {
      i++;
      const body = [];
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre><code');
      if (lang !== '') out.push(' class="language-', escapeHtml(lang), '"');
      out.push('>');
      if (body.length > 0) out.push(escapeHtml(body.join('\n')), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === 3) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inlineMd(hd.text, link);
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (kind === 4) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // A blockquote: the lines opening on `>`, each with the `>` and one space after it dropped, then trimmed.
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const line = lines[i];
        let a = line.charCodeAt(1) === 32 ? 2 : 1;
        let b = line.length;
        while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
        while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
        if (b > a) body.push(line.slice(a, b));
        i++;
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineMd(body.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const cur = lines[i];
        if (isOrdered) {
          const m = orderedOf(cur);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(cur);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
          continue;
        }
        break;
      }
      const start = isOrdered ? Number(ordered.num) : 1;
      if (isOrdered) out.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
      else out.push('<ul>\n');
      for (const item of items) out.push(`<li>${inlineMd(item.join('\n'), link)}</li>\n`);
      out.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && lineKind(lines[i]) === 0) body.push(trimLine(lines[i++]));
    const html = inlineMd(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {
  constructor(name, reason) {
    super(`template "${name}": ${reason}`);
    this.name = 'TemplateError';
  }
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpaceTabRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        tokens.push({ t: 'text', text });
        text = '';
      }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      onlySpaceTabRange(src, lineStart, open) && onlySpaceTabRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(name, 'an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(name, `an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(name, `{% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template value helpers (the compiled functions call these) ---

/** The value at `path`'s first name in the scope chain, then its own properties. */
function lk1(s, a) {
  while (s !== null && !hasOwn(s.vars, a)) s = s.parent;
  return s === null ? undefined : s.vars[a];
}
function lk2(s, a, b) {
  while (s !== null && !hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[a];
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  return v[b];
}
function lk3(s, a, b, c) {
  while (s !== null && !hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[a];
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !hasOwn(v, c)) return undefined;
  return v[c];
}
function lk4(s, a, b, c, d) {
  while (s !== null && !hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[a];
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !hasOwn(v, c)) return undefined;
  v = v[c];
  if (v === null || typeof v !== 'object' || !hasOwn(v, d)) return undefined;
  return v[d];
}
function lkN(s, path) {
  let v = lk1(s, path[0]);
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** The lk family on a vars object directly, for a head a loop scope is known to hold. */
function lk1v(vars, a) {
  return vars[a];
}
function lk2v(vars, a, b) {
  const v = vars[a];
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  return v[b];
}
function lk3v(vars, a, b, c) {
  let v = vars[a];
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !hasOwn(v, c)) return undefined;
  return v[c];
}
function lk4v(vars, a, b, c, d) {
  let v = vars[a];
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !hasOwn(v, c)) return undefined;
  v = v[c];
  if (v === null || typeof v !== 'object' || !hasOwn(v, d)) return undefined;
  return v[d];
}
function lkNv(vars, path) {
  let v = vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let o = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) o += ', ';
      o += txt(v[i]);
    }
    return o;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The names a node list reads from its invocation scope — a name bound by
 * one of its own loops is supplied internally and does not count — and the
 * templates it includes.
 */
function directHeads(nodes, bound, heads, incs) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) heads.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) heads.add(n.path[0]);
      directHeads(n.then, bound, heads, incs);
      if (n.else !== null) directHeads(n.else, bound, heads, incs);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) heads.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      directHeads(n.body, inner, heads, incs);
    } else if (n.kind === 'include') incs.push(n.name);
  }
}

/** Every name each template reads from its invocation scope, transitively through its includes. */
function templateHeads(parsed) {
  const own = new Map();
  const incs = new Map();
  for (const [name, nodes] of parsed) {
    const heads = new Set();
    const list = [];
    directHeads(nodes, new Set(), heads, list);
    own.set(name, heads);
    incs.set(name, list);
  }
  const all = new Map();
  for (const name of parsed.keys()) all.set(name, new Set(own.get(name)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, list] of incs) {
      const into = all.get(name);
      for (const inc of list) {
        const from = all.get(inc);
        if (from === undefined) continue;
        for (const h of from) {
          if (!into.has(h)) {
            into.add(h);
            changed = true;
          }
        }
      }
    }
  }
  return all;
}

/**
 * Include-result caching. A cached include site's output is a pure function
 * of the include depth and the scope values of the names the included
 * template reads (its entry in SITE_HEADS): those values key a chain of
 * Maps in the per-case context, so a repeat with the same inputs replays
 * the recorded text instead of rendering again.
 */
const SITE_HEADS = [];
let nextSiteId = 0;

/** The cached text for include site `id` at depth `D` in scope `s`, or undefined when not computed yet. */
function ckGet(C, id, D, s) {
  let node = C.k[id];
  if (node === undefined) return undefined;
  const heads = SITE_HEADS[id];
  for (let i = 0; i <= heads.length; i++) {
    if (!(node instanceof Map)) return undefined;
    node = node.get(i === 0 ? D : lk1(s, heads[i - 1]));
    if (node === undefined) return undefined;
  }
  return node;
}

/** Records `str` as include site `id`'s text at depth `D` in scope `s`. */
function ckPut(C, id, D, s, str) {
  let node = C.k[id];
  if (node === undefined) node = C.k[id] = new Map();
  const heads = SITE_HEADS[id];
  for (let i = 0; i <= heads.length; i++) {
    const key = i === 0 ? D : lk1(s, heads[i - 1]);
    if (i === heads.length) {
      node.set(key, str);
      return;
    }
    let next = node.get(key);
    if (next === undefined) {
      next = new Map();
      node.set(key, next);
    }
    node = next;
  }
}

// --- the compiler: a template's node tree becomes one JS function ---

/** The lookup expression for `path` in scope variable `s${d}`. */
function lkCode(path, d, binds) {
  // A head bound by an enclosing loop of this same template (or `loop` itself)
  // is read straight from that loop scope's vars: the chain walk would find
  // exactly that scope first.
  for (let j = d; j >= 1; j--) {
    if (binds[j] === path[0] || path[0] === 'loop') {
      if (path.length > 4) return `lkNv(s${j}.vars,${JSON.stringify(path)})`;
      return `lk${path.length}v(s${j}.vars,${path.map((p) => JSON.stringify(p)).join(',')})`;
    }
  }
  if (path.length > 4) return `lkN(s${d},${JSON.stringify(path)})`;
  return `lk${path.length}(s${d},${path.map((p) => JSON.stringify(p)).join(',')})`;
}

/** The helpers every compiled template takes, in the order the Function constructor binds them. */
const HELPERS = [lk1, lk2, lk3, lk4, lkN, escapeHtml, txt, tr, ckGet, ckPut, lk1v, lk2v, lk3v, lk4v, lkNv];
const HELPER_PARAMS = 's0,out,C,D,lk1,lk2,lk3,lk4,lkN,esc,txt,tr,ckg,ckp,lk1v,lk2v,lk3v,lk4v,lkNv';
const HELPER_ARGS = 'lk1,lk2,lk3,lk4,lkN,esc,txt,tr,ckg,ckp,lk1v,lk2v,lk3v,lk4v,lkNv';

/** JavaScript source rendering `nodes` in scope `s${d}`, appending to `out`. */
function genList(nodes, d, heads, binds) {
  let src = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        src += `out.push(${JSON.stringify(n.text)});`;
        break;
      case 'var':
        src += `_t=${lkCode(n.path, d, binds)};out.push(typeof _t==="string"?esc(_t):esc(txt(_t)));`;
        break;
      case 'raw':
        src += `_t=${lkCode(n.path, d, binds)};out.push(typeof _t==="string"?_t:txt(_t));`;
        break;
      case 'if':
        src += `if(tr(${lkCode(n.path, d, binds)})!==${n.not}){`;
        src += genList(n.then, d, heads, binds);
        if (n.else !== null) {
          src += '}else{';
          src += genList(n.else, d, heads, binds);
        }
        src += '}';
        break;
      case 'for': {
        const a = `_a${d}`;
        const k = `_k${d}`;
        const l = `_l${d}`;
        const v = `_v${d}`;
        const g = `_g${d}`;
        src += `var ${a}=${lkCode(n.path, d, binds)};if(Array.isArray(${a})){var ${l}=${a}.length;var ${v}={};var ${g}={index:0,first:false,last:false,length:${l}};var s${d + 1}={vars:${v},parent:s${d}};for(var ${k}=0;${k}<${l};${k}++){${v}[${JSON.stringify(n.name)}]=${a}[${k}];${v}.loop=${g};${g}.index=${k}+1;${g}.first=${k}===0;${g}.last=${k}===${l}-1;`;
        const binds2 = binds.slice();
        binds2[d + 1] = n.name;
        src += genList(n.body, d + 1, heads, binds2);
        src += '}}';
        break;
      }
      case 'include': {
        const h = heads.get(n.name);
        if (h !== undefined && h.size <= 3 && !h.has('loop')) {
          const id = nextSiteId++;
          SITE_HEADS[id] = [...h];
          src += `if(D<${INCLUDE_DEPTH}){var _r${d}=ckg(C,${id},D,s${d});if(_r${d}!==undefined)out.push(_r${d});else{var _f${d}=C.t[${JSON.stringify(n.name)}];if(_f${d}!==undefined){var _o${d}=[];_f${d}(s${d},_o${d},C,D+1,${HELPER_ARGS});var _w${d}=_o${d}.join("");ckp(C,${id},D,s${d},_w${d});out.push(_w${d});}}}`;
        } else {
          src += `var _f${d}=C.t[${JSON.stringify(n.name)}];if(_f${d}!==undefined&&D<${INCLUDE_DEPTH})_f${d}(s${d},out,C,D+1,${HELPER_ARGS});`;
        }
        break;
      }
    }
  }
  return src;
}

/** `nodes` compiled to a function (scope, out, C, depth, ...helpers). */
function compileTemplate(nodes, heads) {
  return new Function(HELPER_PARAMS, `var _t;${genList(nodes, 0, heads, [null])}`);
}

// ---------------------------------------------------------------- links

/** Whether `t` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) {
      return false;
    }
  }
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it (built once per source, then shared). */
const linkOf = (s) => {
  if (s === null) return null;
  if (s.linkRec !== undefined) return s.linkRec;
  const rec = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  s.linkRec = rec;
  return rec;
};

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.rec ?? (t.rec = { name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const c = s.card;
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  longCache = new Map();

  // Templates, parsed in code-unit order of name. One that does not parse is reported and left out.
  // Compilation is lazy — a template is compiled the first time it renders —
  // so templates no page uses cost no compilation.
  const report = [];
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const heads = templateHeads(parsed);
  const compiled = new Map();
  const ensure = (name) => {
    let fn = compiled.get(name);
    if (fn === undefined) {
      fn = compileTemplate(parsed.get(name), heads);
      compiled.set(name, fn);
    }
    return fn;
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in order: refused, the generator's own directories, a post with no date, a missing layout, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenSet = taken.get(dir);
    if (takenSet === undefined) {
      takenSet = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, takenSet);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenSet);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each source's body rendered to HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkMemo = new Map(); // dir -> Map(target -> resolved url, or null when broken)
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirMemo = linkMemo.get(dir);
    if (dirMemo === undefined) {
      dirMemo = new Map();
      linkMemo.set(dir, dirMemo);
    }
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      let url = dirMemo.get(target);
      if (url === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        url =
          path !== null && bySource.has(path)
            ? `${bySource.get(path).url}${frag}`
            : path !== null && staticPaths.has(path)
              ? `${base}/${path}${frag}`
              : null;
        dirMemo.set(target, url);
      }
      if (url === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return url;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug in code-unit order.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, once per page, shared by its layout and every list that shows it.
  for (const s of kept) s.card = cardOf(s);

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const templateFns = {};
  for (const name of parsed.keys()) {
    Object.defineProperty(templateFns, name, { enumerable: true, get: () => ensure(name) });
  }
  const ctx = { t: templateFns, k: [] };
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    if (!parsed.has(name)) return null;
    const out = [];
    ensure(name)({ vars, parent: rootScope }, out, ctx, 0, ...HELPERS);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

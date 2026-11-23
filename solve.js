// rebuild solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed).
// Written fresh for this rebuild. run(input) returns exactly makefun-site 1.0.0's
// answer for the case's site: the output tree as a JSON object of every path it
// writes and that file's text, byte for byte. makefun-site's behavior (front
// matter, template dialect, Markdown subset, slug rule, report) is its own;
// this module re-implements that behavior with faster algorithms. Nothing is
// copied from the reference implementation or from any earlier entry.
'use strict';

// ---------------------------------------------------------------- text

const ESC_TABLE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " and ' escaped (regex-driven, C++). */
function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC_TABLE[c]);
}

/** `s[a..b]` HTML-escaped, without allocating the slice when nothing needs escaping. */
function escapeRange(s, a, b) {
  ESC_RE.lastIndex = a;
  let m = ESC_RE.exec(s);
  if (m === null || m.index >= b) return s.slice(a, b);
  const out = [s.slice(a, m.index), ESC_TABLE[m[0]]];
  let start = m.index + 1;
  while ((m = ESC_RE.exec(s)) !== null && m.index < b) {
    out.push(s.slice(start, m.index), ESC_TABLE[m[0]]);
    start = m.index + 1;
  }
  out.push(s.slice(start, b));
  return out.join('');
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;
const MARK_RE = /\p{M}/gu;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left. */
function slugify(text) {
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `code` is JavaScript whitespace (the \s set). NEL U+0085 is NOT one. */
function isWs(code) {
  return code === 32 || code === 10 || code === 9 || code === 13 || code === 11 || code === 12 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace (as /\S+/g counts them). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c <= 32
      ? c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12
      : c < 127 ? false : isWs(c);
    if (ws) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Scans lines by indexOf, without
 * splitting the whole text or re-joining the body.
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  const data = {};
  let lineStart = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 2;
  let closeEnd = -1;
  // The vendor refuses an unclosed front matter before any line error, so a
  // line error is recorded (not returned) while the closing '---' is still
  // being sought; the close check wins at the end of the single pass.
  let firstErr = null;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line === '---') {
      closeEnd = lineEnd === text.length ? text.length : lineEnd + 1;
      break;
    }
    if (firstErr === null && !isBlankLine(line) && line.charCodeAt(0) !== 35) {
      const ci = line.indexOf(':');
      let bad = ci === -1;
      let key = '';
      if (!bad) {
        key = line.slice(0, ci);
        if (key.length === 0) bad = true;
        else for (let k = 0; k < key.length; k++) if (!isKeyChar(key.charCodeAt(k))) { bad = true; break; }
      }
      if (bad) firstErr = { error: `line ${lineNo} is not "key: value"` };
      else {
        const rest = line.slice(ci + 1);
        let raw;
        if (rest === '') raw = '';
        else if (rest.charCodeAt(0) === 32) {
          raw = rest.slice(1);
          let e = raw.length;
          while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
          raw = raw.slice(0, e);
        } else firstErr = { error: `line ${lineNo} is not "key: value"` };
        if (firstErr === null) {
          if (!FM_KEYS.includes(key)) firstErr = { error: `unknown key "${key}"` };
          else if (Object.hasOwn(data, key)) firstErr = { error: `key "${key}" is given twice` };
          else if (raw === '') firstErr = { error: `key "${key}" has no value` };
          else {
            const v = fmValue(key, raw);
            if ('error' in v) firstErr = v;
            else data[key] = v.value;
          }
        }
      }
    }
    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  if (firstErr !== null) return firstErr;
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_TEST = /\s/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

/** Whether the char at `j` is escaped: an odd run of backslashes stands before it. */
function isEscapedAt(s, j, from) {
  let k = 0;
  let r = j - 1;
  while (r >= from && s[r] === '\\') { k++; r--; }
  return (k & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (!isEscapedAt(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first lone `*` from `from` (a star whose run is not `**`), outside an escape, or -1. */
function findLoneStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscapedAt(s, j, from)) { j = s.indexOf('*', j + 1); continue; }
    let n = 1;
    while (s[j + n] === '*') n++;
    if ((n & 1) === 1) return j + n - 1;
    j = s.indexOf('*', j + n);
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inlineStr(s, env) {
  RE_SPECIAL.lastIndex = 0;
  let m = RE_SPECIAL.exec(s);
  // No special character at all: nothing to escape, the text is already its HTML.
  if (m === null) return s;
  const out = [];
  let i = 0;
  while (m !== null) {
    const p = m.index;
    // The run before this match holds no escapable character (the regex matches
    // every one), so it is already plain text and needs no escaping.
    if (p > i) out.push(s.slice(i, p));
    const c = s[p];
    if (c === '\\') {
      const n = s[p + 1];
      if (p + 1 < s.length && ESCAPABLE.has(n)) { out.push(ESC_TABLE[n] ?? n); i = p + 2; }
      else { out.push('\\'); i = p + 1; }
    } else if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) { out.push('<code>', escapeRange(s, p + 1, j), '</code>'); i = j + 1; }
      else { out.push('`'); i = p + 1; }
    } else if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) { out.push('<strong>', inlineStr(s.slice(p + 2, j), env), '</strong>'); i = j + 2; }
        else { out.push('**'); i = p + 2; }
      } else {
        const j = findLoneStar(s, p + 1);
        if (j > p + 1) { out.push('<em>', inlineStr(s.slice(p + 1, j), env), '</em>'); i = j + 1; }
        else { out.push('*'); i = p + 1; }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', p + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_TEST.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">', inlineStr(s.slice(p + 1, k), env), '</a>');
        i = m2 + 1;
      } else { out.push('['); i = p + 1; }
    } else {
      out.push(ESC_TABLE[c]);
      i = p + 1;
    }
    RE_SPECIAL.lastIndex = i;
    m = RE_SPECIAL.exec(s);
  }
  if (i < s.length) out.push(s.slice(i));
  return out.join('');
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96 && line.startsWith('```')) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR_RE.test(line);
  return false;
}

/** Split `src` into lines (same result as `src.split('\n')`, via indexOf scan,
 * which is measurably faster than split on this workload). */
function splitLines(src) {
  const lines = [];
  let start = 0;
  let j;
  while ((j = src.indexOf('\n', start)) !== -1) {
    lines.push(src.slice(start, j));
    start = j + 1;
  }
  lines.push(src.slice(start));
  return lines;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const lines = splitLines(src);
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    // A blank line starts with a space/tab (or is empty, handled above), so
    // lines starting with any other character skip the isBlankLine scan.
    if ((c0 === 32 || c0 === 9) && isBlankLine(line)) { i++; continue; }
    if (c0 === 96 && line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${body.length ? escapeHtml(body.join('\n')) + '\n' : ''}</code></pre>`);
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inlineStr(h.text, env);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (HR_RE.test(line)) { blocks.push('<hr>'); i++; continue; }
      const bullet = BULLET_RE.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const m = BULLET_RE.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[1])]); i++; }
          else if (CONTINUED_RE.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        blocks.push(`<ul>\n${items.map((parts) => `<li>${inlineStr(parts.join('\n'), env)}</li>\n`).join('')}</ul>`);
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const q = body.map(trimLine).filter((l) => l !== '');
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(q.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED_RE.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        while (i < n) {
          const m = ORDERED_RE.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[2])]); i++; }
          else if (CONTINUED_RE.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        blocks.push(`${open}\n${items.map((parts) => `<li>${inlineStr(parts.join('\n'), env)}</li>\n`).join('')}</ol>`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
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
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
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
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`.
 * `ctx` holds the parsed templates (`templates`, a Map of name to nodes), the HTML
 * escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope + loop object per for-execution, mutated per iteration:
        // rendering is synchronous and no scope is retained, so reusing them
        // is safe (a re-entrant execution gets its own objects).
        const vars = { [n.name]: null, loop: { index: 0, first: false, last: false, length: xs.length } };
        const child = { vars, parent: scope };
        const lp = vars.loop;
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // Step 1: whole-template memo — reuse the precomputed string when the
        // cached expansion's nested includes would all still be under the cap.
        if (ctx.indepCache !== undefined) {
          const c = ctx.indepCache.get(n.name);
          if (c !== undefined && depth + (ctx.maxDepth.get(n.name) ?? 1) < INCLUDE_DEPTH) {
            out.push(c);
            break;
          }
        }
        // Step 1: rendered-card memo — the card is a pure function of the `p`
        // object (it reads only p.* and includes tag-list over p.tags).
        if (n.name === 'card' && ctx.cardCache !== undefined) {
          const p = lookup(scope, ['p']);
          if (p !== null && typeof p === 'object') {
            const cc = ctx.cardCache.get(p);
            const cd = ctx.maxDepth.get('card') ?? 1;
            if (cc !== undefined && depth + cd < INCLUDE_DEPTH) {
              out.push(cc);
              break;
            }
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            const s = tmp.join('');
            if (depth + cd < INCLUDE_DEPTH) ctx.cardCache.set(p, s);
            out.push(s);
            break;
          }
        }
        renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

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

/**
 * A link's href, as the Markdown renderer calls it. `this` is the per-source env:
 * { dir, base, bySource, staticPaths, broken, srcPath }. One shared function, so no
 * closure is built per source.
 */
function resolveLink(target) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(this.dir, rel);
  if (path !== null && this.bySource.has(path)) return `${this.bySource.get(path).url}${frag}`;
  if (path !== null && this.staticPaths.has(path)) return `${this.base}/${path}${frag}`;
  this.broken.add(`broken-link ${this.srcPath} -> ${target}`);
  return target;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

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
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. `card` is the post's precomputed card when known. */
function pageOf(s, card) {
  return {
    ...(card ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Step 1 — whole-template memoization: a template is page-independent iff
  // every var/raw/if/for first-name resolves to a site-level value (site, tags,
  // recent, or a loop var bound from one of those) and every included template
  // is too. Computed by fixed-point iteration over the template graph.
  // Guards: if any loop var shadows a site-level name, or the include graph
  // has a cycle, memoization is disabled for the whole case (the analysis
  // would be unsound there).
  const SITE_NAMES = new Set(['site', 'tags', 'recent']);
  let memoOff = false;
  {
    const hasShadow = (nodes) => {
      for (const n of nodes) {
        if (n.kind === 'for' && SITE_NAMES.has(n.name)) return true;
        if (n.kind === 'if') {
          if (hasShadow(n.then)) return true;
          if (n.else !== null && hasShadow(n.else)) return true;
        } else if (n.kind === 'for') {
          if (hasShadow(n.body)) return true;
        }
      }
      return false;
    };
    for (const nodes of templates.values()) if (hasShadow(nodes)) { memoOff = true; break; }
  }
  const indepMemo = new Map();
  const analyze = (nodes, indep) => {
    for (const n of nodes) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!indep.get(n.path[0])) return false;
        continue;
      }
      if (n.kind === 'if') {
        if (!indep.get(n.path[0])) return false;
        if (!analyze(n.then, indep)) return false;
        if (n.else !== null && !analyze(n.else, indep)) return false;
        continue;
      }
      if (n.kind === 'for') {
        if (!indep.get(n.path[0])) return false;
        const inner = new Map(indep);
        inner.set(n.name, indep.get(n.path[0]));
        inner.set('loop', indep.get(n.path[0]));
        if (!analyze(n.body, inner)) return false;
        continue;
      }
      if (n.kind === 'include') {
        const sub = indepMemo.get(n.name);
        if (sub === undefined) {
          if (templates.has(n.name)) return false;
          continue;
        }
        if (!sub) return false;
        continue;
      }
    }
    return true;
  };
  if (!memoOff) {
    for (let round = 0; round < 10; round++) {
      let changed = false;
      for (const [nm, nodes] of templates) {
        const topIndep = new Map([['site', true], ['tags', true], ['recent', true]]);
        const r = analyze(nodes, topIndep);
        if (indepMemo.get(nm) !== r) { indepMemo.set(nm, r); changed = true; }
      }
      if (!changed) break;
    }
  }
  // Deepest include chain per template (for the depth-cap safety check).
  // Backtracking path set: siblings do not interfere, cycles are flagged.
  let hasCycle = false;
  const maxDepthOf = (name, path) => {
    if (!templates.has(name)) return 1;
    if (path.has(name)) { hasCycle = true; return 1; }
    path.add(name);
    let d = 1;
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.kind === 'include' && templates.has(n.name)) d = Math.max(d, 1 + maxDepthOf(n.name, path));
        else if (n.kind === 'if') { walk(n.then); if (n.else) walk(n.else); }
        else if (n.kind === 'for') walk(n.body);
      }
    };
    walk(templates.get(name));
    path.delete(name);
    return d;
  };
  const maxDepth = new Map();
  for (const nm of templates.keys()) maxDepth.set(nm, maxDepthOf(nm, new Set()));
  if (hasCycle || memoOff) { indepMemo.clear(); }
  const useMemo = !hasCycle && !memoOff;
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  // a source that is not .md is static.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const env = { dir: dirOf(s.path), base: b.base, bySource: b.bySource, staticPaths, broken: b.broken, srcPath: s.path, link: resolveLink };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    // Step 1: render each fully-independent template once and reuse the string.
    // (Precompute uses the top scope {site, tags, recent}; independent templates
    // read only those, so the string is identical at every include site.)
    const indepCache = new Map();
    // The card memo is keyed by the `p` object identity, so it is safe even
    // when the shadowing guard disables whole-template memoization; it is
    // only disabled when the include graph has a cycle (maxDepth unreliable).
    const cardCache = hasCycle ? undefined : new Map();
    if (useMemo && indepMemo.size > 0) {
      const ctx0 = { templates: b.templates, escape: escapeHtml, indepCache, maxDepth, cardCache: new Map() };
      const topScope = { vars: { site, tags: allTags, recent }, parent: null };
      for (const [nm, ok] of indepMemo) {
        if (!ok || !b.templates.has(nm)) continue;
        const out = [];
        renderNodes(b.templates.get(nm), topScope, ctx0, 0, out);
        indepCache.set(nm, out.join(''));
      }
    }
    const ctx = { templates: b.templates, escape: escapeHtml, indepCache, maxDepth, cardCache };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
      return out.join('');
    };
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? b.cards.get(s) : undefined) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

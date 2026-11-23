// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns exactly makefun-site 1.0.0's answer for the case's site: the output
// tree as a JSON object of every path it writes and that file's text, byte for byte.
// Written fresh for this entry. makefun-site's behavior (front matter, template dialect,
// Markdown subset, slug rule, report) is its own; this module re-implements that behavior
// with faster algorithms: a single-pass Markdown renderer with bulk plain-text runs, a
// line-scanning front-matter parser, and templates compiled once to flat instructions
// with an inlined scope walk. Nothing is copied from the reference implementation.
//
// Method family: (2) hand-rolled single-pass Markdown parser for makefun-site's exact
// subset + compiled templates + fused rendering with minimal allocations. It won over
// (1) optimized paths through the reference algorithms because the reference's
// per-character inline loop and per-node template recursion dominate its time.

'use strict';

// ---------------------------------------------------------------- text

const ESC1 = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc1 = (c) => ESC1[c] ?? c;
const ESC_RE = /[&<>"']/g;

/** s[a..b] HTML-escaped, without an intermediate slice when nothing needs escaping. */
function escapeSlice(s, a, b) {
  ESC_RE.lastIndex = a;
  let m = ESC_RE.exec(s);
  if (m === null || m.index >= b) return s.slice(a, b);
  const out = [s.slice(a, m.index), ESC1[m[0]]];
  let start = m.index + 1;
  while ((m = ESC_RE.exec(s)) !== null && m.index < b) {
    out.push(s.slice(start, m.index), ESC1[m[0]]);
    start = m.index + 1;
  }
  out.push(s.slice(start, b));
  return out.join('');
}

/** Whole-string escape (same table). */
const escapeHtml = (s) => escapeSlice(s, 0, s.length);

const ASCII_RE = /^[\x00-\x7F]*$/;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64 characters
 * (a "-" left at the cut dropped), and "untitled" when nothing is left. */
export function slugify(text) {
  const plain = ASCII_RE.test(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
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

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `code` is JavaScript whitespace (the \s set: tab, LF, VT, FF, CR, space and the Unicode spaces; NEL U+0085 is NOT one). */
function isWsCode(code) {
  return code === 32 || code === 10 || code === 9 || code === 13 || code === 11 || code === 12 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace (as /\S+/g counts them). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // A printable ASCII character is never whitespace; a control character below 32
    // is whitespace only when it is tab, LF, VT, FF or CR; above 126 only the Unicode spaces.
    const ws = c <= 32
      ? c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12
      : c < 127 ? false : isWsCode(c);
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

function stringOf(raw) {
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

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
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

function isBlank(line) {
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
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. Scans lines by indexOf, without splitting
 * the whole text or re-joining the body.
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  const data = {};
  let lineStart = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 2;
  let closeEnd = -1;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line === '---') { closeEnd = lineEnd === text.length ? text.length : lineEnd + 1; break; }
    if (!isBlank(line) && !line.startsWith('#')) {
      const ci = line.indexOf(':');
      let bad = ci === -1;
      let key = '';
      if (!bad) {
        key = line.slice(0, ci);
        if (key.length === 0) bad = true;
        else for (let k = 0; k < key.length; k++) if (!isKeyChar(key.charCodeAt(k))) { bad = true; break; }
      }
      if (bad) return { error: `line ${lineNo} is not "key: value"` };
      const rest = line.slice(ci + 1);
      let raw;
      if (rest === '') raw = '';
      else if (rest.charCodeAt(0) === 32) {
        raw = rest.slice(1);
        let e = raw.length;
        while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
        raw = raw.slice(0, e);
      } else return { error: `line ${lineNo} is not "key: value"` };
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** Whether the char at `j` is escaped by the backslashes before it (scanning from `from`). */
function isEscaped(s, j, from) {
  let r = j - 1, k = 0;
  while (r >= from && s[r] === '\\') { k++; r--; }
  return (k & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (!isEscaped(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j, from)) { j = s.indexOf('*', j + 1); continue; }
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
  // No special character at all: the text holds nothing to escape, so it is already its HTML.
  if (m === null) return s;
  const out = [];
  let i = 0;
  while (m !== null) {
    const p = m.index;
    // The run before this match holds no escapable character: the regex matches every
    // one of & < > " ', so the run is already plain text and needs no escaping.
    if (p > i) out.push(s.slice(i, p));
    const c = s[p];
    if (c === '\\') {
      const n = s[p + 1];
      if (p + 1 < s.length && ESCAPABLE.has(n)) { out.push(esc1(n)); i = p + 2; }
      else { out.push('\\'); i = p + 1; }
    } else if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) { out.push('<code>', escapeSlice(s, p + 1, j), '</code>'); i = j + 1; }
      else { out.push('`'); i = p + 1; }
    } else if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) { out.push('<strong>', inlineStr(s.slice(p + 2, j), env), '</strong>'); i = j + 2; }
        else { out.push('**'); i = p + 2; }
      } else {
        const j = findSingleStar(s, p + 1);
        if (j > p + 1) { out.push('<em>', inlineStr(s.slice(p + 1, j), env), '</em>'); i = j + 1; }
        else { out.push('*'); i = p + 1; }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', p + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">', inlineStr(s.slice(p + 1, k), env), '</a>');
        i = m2 + 1;
      } else { out.push('['); i = p + 1; }
    } else {
      out.push(ESC1[c]);
      i = p + 1;
    }
    RE_SPECIAL.lastIndex = i;
    m = RE_SPECIAL.exec(s);
  }
  if (i < s.length) out.push(s.slice(i));
  return out.join('');
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96 && line.startsWith('```')) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its
 * table of contents (every level 2 and 3 heading: level, id and its inline HTML) and
 * its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '' || isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
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
      if (HR.test(line)) { blocks.push('<hr>'); i++; continue; }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const m = BULLET.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[1])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
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
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        while (i < n) {
          const m = ORDERED.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[2])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
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

// Instruction ops (flat arrays, interpreted by renderInstr):
//   [0, text]                 literal text
//   [1, path, raw]            value at path, escaped unless raw
//   [2, path, not, elseIp, endIp]  if (jump to elseIp when the test fails the `not`)
//   [3, endIp]                else: skip to endIp
//   [4, path, varName, endIp] for (endIp is the loop-end instruction's index)
//   [5]                       loop end: advance the innermost frame or pop it
//   [6, name]                 include template `name` in the same scope
function compileNodes(nodes, out) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push([0, n.text]);
    else if (n.kind === 'var') out.push([1, n.path, 0]);
    else if (n.kind === 'raw') out.push([1, n.path, 1]);
    else if (n.kind === 'if') {
      const idx = out.length;
      out.push([2, n.path, n.not, 0, 0]);
      compileNodes(n.then, out);
      if (n.else !== null) {
        const elseJump = out.length;
        out.push([3, 0]);
        const elseStart = out.length;
        compileNodes(n.else, out);
        const endIp = out.length;
        out[idx][3] = elseStart;
        out[idx][4] = endIp;
        out[elseJump][1] = endIp;
      } else {
        const endIp = out.length;
        out[idx][3] = endIp;
        out[idx][4] = endIp;
      }
    } else if (n.kind === 'for') {
      const idx = out.length;
      out.push([4, n.path, n.name, 0]);
      compileNodes(n.body, out);
      const endIp = out.length;
      out.push([5]);
      out[idx][3] = endIp;
    } else if (n.kind === 'include') out.push([6, n.name]);
  }
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/**
 * `instrs` rendered in `scope` ({ vars, parent }), appending to `out`.
 * `templates` maps names to compiled instructions; `depth` is the include depth.
 * A loop frame reuses one scope object across its iterations (rendering is synchronous
 * and no scope outlives its render), so a `for` costs one scope object, not one per item.
 */
function renderInstr(instrs, scope, depth, out, templates) {
  let ip = 0;
  const n = instrs.length;
  const loopStack = [];
  while (ip < n) {
    const ins = instrs[ip];
    switch (ins[0]) {
      case 0:
        out.push(ins[1]);
        ip++;
        break;
      case 1: {
        // The value at the path, as text (inlined from resolve/textOf: the cold run
        // spends most of its time under the baseline compiler, so a call saved is time saved).
        const path = ins[1];
        let s = scope;
        while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
        let v;
        if (s === null) v = undefined;
        else {
          v = s.vars[path[0]];
          for (let k = 1; k < path.length; k++) {
            if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) { v = undefined; break; }
            v = v[path[k]];
          }
        }
        let t;
        if (typeof v === 'string') t = v;
        else if (typeof v === 'number') t = String(v);
        else if (typeof v === 'boolean') t = v ? 'true' : 'false';
        else if (Array.isArray(v)) t = v.map(textOf).join(', ');
        else t = '';
        out.push(ins[2] ? t : escapeHtml(t));
        ip++;
        break;
      }
      case 2: {
        const path = ins[1];
        let s = scope;
        while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
        let v;
        if (s === null) v = undefined;
        else {
          v = s.vars[path[0]];
          for (let k = 1; k < path.length; k++) {
            if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) { v = undefined; break; }
            v = v[path[k]];
          }
        }
        const truth = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
        ip = truth !== ins[2] ? ip + 1 : ins[3];
        break;
      }
      case 3:
        ip = ins[1];
        break;
      case 4: {
        const path = ins[1];
        let s = scope;
        while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
        let xs;
        if (s === null) xs = undefined;
        else {
          xs = s.vars[path[0]];
          for (let k = 1; k < path.length; k++) {
            if (xs === null || typeof xs !== 'object' || !Object.hasOwn(xs, path[k])) { xs = undefined; break; }
            xs = xs[path[k]];
          }
        }
        if (!Array.isArray(xs) || xs.length === 0) { ip = ins[3] + 1; break; }
        const child = { vars: {}, parent: scope };
        // One loop record per frame, mutated per iteration: rendering is synchronous
        // and no loop record outlives its render, so it is never read stale.
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        child.vars[ins[2]] = xs[0];
        child.vars.loop = loop;
        loopStack.push({ xs, i: 0, name: ins[2], scope: child, parent: scope, bodyIp: ip + 1, endIp: ins[3], loop });
        scope = child;
        ip = ip + 1;
        break;
      }
      case 5: {
        const fr = loopStack[loopStack.length - 1];
        fr.i++;
        if (fr.i < fr.xs.length) {
          fr.scope.vars[fr.name] = fr.xs[fr.i];
          fr.loop.index = fr.i + 1;
          fr.loop.first = false;
          fr.loop.last = fr.i === fr.xs.length - 1;
          ip = fr.bodyIp;
        } else {
          loopStack.pop();
          scope = fr.parent;
          ip = fr.endIp + 1;
        }
        break;
      }
      case 6: {
        const t = templates.get(ins[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInstr(t, scope, depth + 1, out, templates);
        ip++;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

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
function linkResolve(target) {
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

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed and compiled once, in code-unit order of name. One that does
  // not parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const instrs = [];
      compileNodes(parseTemplate(name, input.templates[name]), instrs);
      templates.set(name, instrs);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const env = { dir: dirOf(s.path), base, bySource, staticPaths, broken, srcPath: s.path, link: linkResolve };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push({ name, slug }); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages (a card is built once per source and reused).
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const tocOf = (s) => {
    if (s.tocMapped !== undefined) return s.tocMapped;
    const t = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    s.tocMapped = t;
    return t;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: tocOf(s),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const output = {};
  const render = (name, vars) => {
    const instrs = templates.get(name);
    if (instrs === undefined) return null;
    const out = [];
    renderInstr(instrs, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, out, templates);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse,
  // sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

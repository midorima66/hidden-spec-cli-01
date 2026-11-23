// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads edits in four formats — unified diffs,
// SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — matches the lines an edit
// names at three tiers (exact, trailing-whitespace, full strip with re-indentation), and changes
// every file or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Set from --strict in run(): only tier 0 is tried. */
let STRICT = false;
const tiers = (): number[] => (STRICT ? [0] : [0, 1, 2]);

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves (old, new) recorded by move edits that succeeded, in patch order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------- files as lines (SPEC.md section 3) ---------- */

interface FModel {
  brk: '\n' | '\r\n';
  lines: string[];
  fin: boolean;
}

function parseFile(text: string): FModel {
  if (text === '') return { brk: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const fin = text.endsWith(brk);
  if (fin) parts.pop();
  return { brk, lines: parts, fin };
}

function serFile(m: FModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.fin ? m.brk : '');
}

/* ---------- matching lines (SPEC.md section 5) ---------- */

const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

/** Every start position >= `from` where O's lines match the file's lines at `tier`; may overlap. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  outer: for (let i = from; i + O.length <= lines.length; i += 1) {
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) continue outer;
    }
    res.push(i);
  }
  return res;
}

/** One body line of a hunk or chunk: context, old or new text. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** The patch line was empty (a blank context line), as opposed to a marker plus empty text. */
  fromEmpty: boolean;
  /** A `\` line follows this body line. */
  backslash: boolean;
}

/** A line of N: its text, and for context lines the index of the line within O. */
interface NEnt {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function deriveON(items: BodyItem[]): { O: string[]; N: NEnt[] } {
  const O: string[] = [];
  const N: NEnt[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      N.push({ text: it.text, ctx: true, oIdx: O.length - 1 });
    } else if (it.kind === 'del') {
      O.push(it.text);
    } else {
      N.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

/** The lines N writes over a match of O at `pos` in the file's lines, at the given tier. */
function buildN(fileLines: string[], pos: number, O: string[], N: NEnt[], tier: number): string[] {
  return N.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier === 2) {
      const F = leadWs(fileLines[pos]!);
      const P = leadWs(O[0]!);
      if (e.text.trim() !== '' && e.text.startsWith(P)) return F + e.text.slice(P.length);
    }
    return e.text;
  });
}

/* ---------- format detection (SPEC.md section 4) ---------- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface UHunk {
  A: number;
  items: BodyItem[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  minus?: string | null;
  plus?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
  headerDone: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const n = lines.length;
  const sections: USection[] = [];
  let cur: USection | null = null;
  const startsPair = (k: number): boolean => lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');

  const parseBody = (start: number): { items: BodyItem[]; next: number } => {
    const items: BodyItem[] = [];
    let j = start;
    while (j < n) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (startsPair(j)) break;
      if (l === '') {
        items.push({ kind: 'ctx', text: '', fromEmpty: true, backslash: false });
        j += 1;
        continue;
      }
      const c = l[0]!;
      if (c === ' ') items.push({ kind: 'ctx', text: l.slice(1), fromEmpty: false, backslash: false });
      else if (c === '-') items.push({ kind: 'del', text: l.slice(1), fromEmpty: false, backslash: false });
      else if (c === '+') items.push({ kind: 'add', text: l.slice(1), fromEmpty: false, backslash: false });
      else if (c === '\\') {
        if (items.length > 0) items[items.length - 1]!.backslash = true;
        j += 1;
        continue;
      } else break;
      j += 1;
    }
    while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.fromEmpty) items.pop();
    return { items, next: j };
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const idx = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      const X = idx >= 0 ? rest.slice(2, idx) : '';
      const Y = idx >= 0 ? rest.slice(idx + 3) : '';
      if (idx < 0 || X === '' || Y === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: X, diffNew: Y, newFile: false, delFile: false, hunks: [], headerDone: false };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (startsPair(i)) {
      const minus = headerPath(line.slice(4));
      const plus = headerPath(lines[i + 1]!.slice(4));
      if (cur !== null && !cur.headerDone && cur.minus === undefined) {
        cur.minus = minus;
        cur.plus = plus;
      } else {
        cur = { minus, plus, newFile: false, delFile: false, hunks: [], headerDone: false };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.headerDone = true;
      const body = parseBody(i + 1);
      cur.hunks.push({ A: parseInt(m[1]!, 10), items: body.items });
      i = body.next;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map(unifiedEdit);
}

function applyUnifiedHunks(model: FModel, hunks: UHunk[], path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = deriveON(h.items);
    if (O.length > 0) {
      const target = h.A - 1 + d;
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiers()) {
        const occ = occurrences(model.lines, O, tier);
        if (occ.length > 0) {
          let best = occ[0]!;
          for (const p of occ) {
            if (Math.abs(p - target) < Math.abs(best - target)) best = p;
          }
          placed = { tier, pos: best };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', path);
      const atEof = placed.pos + O.length === model.lines.length;
      const repl = buildN(model.lines, placed.pos, O, N, placed.tier);
      model.lines.splice(placed.pos, O.length, ...repl);
      if (atEof && h.items.length > 0) {
        const lastCA = [...h.items].reverse().find((it) => it.kind !== 'del');
        model.fin = !(lastCA !== undefined && lastCA.backslash);
      }
      d += N.length - O.length;
    } else if (N.length > 0) {
      const pos = Math.max(0, Math.min(h.A + d, model.lines.length));
      const atEof = pos === model.lines.length;
      model.lines.splice(pos, 0, ...N.map((e) => e.text));
      if (atEof) {
        const lastCA = [...h.items].reverse().find((it) => it.kind !== 'del');
        model.fin = !(lastCA !== undefined && lastCA.backslash);
      }
      d += N.length;
    }
  }
}

function unifiedEdit(sec: USection): Edit {
  return (tree) => {
    const oldP: string | null | undefined = sec.minus !== undefined ? sec.minus : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP: string | null | undefined = sec.plus !== undefined ? sec.plus : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    if (oldP != null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP != null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.delFile);
    if (isCreate) {
      if (newP == null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plusLines: string[] = [];
      let lastPlusBackslash = false;
      let seenPlus = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            plusLines.push(it.text);
            lastPlusBackslash = it.backslash;
            seenPlus = true;
          }
        }
      }
      tree.now.set(newP, serFile({ brk: '\n', lines: plusLines, fin: seenPlus && !lastPlusBackslash }));
      return;
    }
    if (isDelete) {
      if (oldP == null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const target = oldP!;
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const isMove = newP != null && newP !== target;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = parseFile(before);
    applyUnifiedHunks(model, sec.hunks, target);
    if (isMove) {
      tree.now.set(newP, serFile(model));
      tree.now.set(target, null);
      tree.moves.push([target, newP]);
    } else {
      tree.now.set(target, serFile(model));
    }
  };
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let sep = -1;
    for (let k = searchLine + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serFile({ brk: '\n', lines: [...newLines], fin: newLines.length > 0 }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    for (const tier of tiers()) {
      const occ = occurrences(model.lines, oldLines, tier);
      if (occ.length > 1) throw new Fail('ambiguous', path);
      if (occ.length === 1) {
        const N: NEnt[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
        const repl = buildN(model.lines, occ[0]!, oldLines, N, tier);
        model.lines.splice(occ[0]!, oldLines.length, ...repl);
        tree.now.set(path, serFile(model));
        return;
      }
    }
    throw new Fail('no-match', path);
  };
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
  fromAt: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo?: string;
  addLines: string[];
  chunks: VChunk[];
}

function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOV = '*** Move to: ';
  const isStart = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    // The section's lines run to the next section or *** End Patch; blank lines at its end are not part of it.
    let end = i + 1;
    while (end < last && !isStart(lines[end]!)) end += 1;
    let contentEnd = end;
    while (contentEnd > i + 1 && blank(lines[contentEnd - 1]!)) contentEnd -= 1;
    const headerLine = i + 1;
    if (line.startsWith(ADD)) {
      const sec: VSection = { kind: 'add', path: line.slice(ADD.length).trim(), line: headerLine, addLines: [], chunks: [] };
      for (let k = i + 1; k < contentEnd; k += 1) {
        const l = lines[k]!;
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      sections.push(sec);
    } else if (line.startsWith(DEL)) {
      sections.push({ kind: 'delete', path: line.slice(DEL.length).trim(), line: headerLine, addLines: [], chunks: [] });
      for (let k = i + 1; k < contentEnd; k += 1) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
    } else {
      const sec: VSection = { kind: 'update', path: line.slice(UPD.length).trim(), line: headerLine, addLines: [], chunks: [] };
      let cur: VChunk | null = null;
      const pushChunk = (): void => {
        if (cur === null) return;
        sec.chunks.push(cur);
        cur = null;
      };
      for (let k = i + 1; k < contentEnd; k += 1) {
        const l = lines[k]!;
        if (k === i + 1 && l.startsWith(MOV)) {
          sec.moveTo = l.slice(MOV.length).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          pushChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [], fromAt: true };
          continue;
        }
        if (l.trimEnd() === '*** End of File' && !l.startsWith(' ')) {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          pushChunk();
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) {
              // A body line after a closed (end-of-file) chunk starts no chunk; blank lines are ignored.
              if (l === '') continue;
              throw new Exit2(`error: parse ${k + 1}`);
            }
            cur = { anchor: null, eof: false, items: [], fromAt: false };
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '', fromEmpty: true, backslash: false });
          else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1), fromEmpty: false, backslash: false });
          else if (l[0] === '-') cur.items.push({ kind: 'del', text: l.slice(1), fromEmpty: false, backslash: false });
          else cur.items.push({ kind: 'add', text: l.slice(1), fromEmpty: false, backslash: false });
          continue;
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      pushChunk();
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
      sections.push(sec);
    }
    i = end;
  }
  return sections.map(v4aEdit);
}

function v4aEdit(sec: VSection): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, serFile({ brk: '\n', lines: [...sec.addLines], fin: true }));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of tiers()) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (lineEq(model.lines[k]!, ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const { O, N } = deriveON(ch.items);
      if (O.length > 0) {
        let placed: { tier: number; pos: number } | null = null;
        for (const tier of tiers()) {
          const occ = occurrences(model.lines, O, tier, cursor).filter((p) => !ch.eof || p + O.length === model.lines.length);
          if (occ.length > 0) {
            placed = { tier, pos: occ[0]! };
            break;
          }
        }
        if (placed === null) throw new Fail('no-match', sec.path);
        const repl = buildN(model.lines, placed.pos, O, N, placed.tier);
        model.lines.splice(placed.pos, O.length, ...repl);
        cursor = placed.pos + repl.length;
      } else {
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...N.map((e) => e.text));
        cursor = pos + N.length;
      }
    }
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, serFile(model));
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, serFile(model));
    }
  };
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- the command line, order and atomicity (SPEC.md sections 1, 2 and 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rByNew = new Map<string, string>();
  for (const [o, nn] of tree.moves) {
    if (usedOld.has(o) || usedNew.has(nn)) continue;
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(nn) === null && finalOf(nn) !== null) {
      rByNew.set(nn, o);
      usedOld.add(o);
      usedNew.add(nn);
    }
  }
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of changed) {
    if (usedNew.has(p)) entries.push({ key: p, line: `R ${rByNew.get(p)!} -> ${p}` });
    else if (usedOld.has(p)) continue;
    else {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

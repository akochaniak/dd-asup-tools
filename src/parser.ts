// Pure parser for Data Domain autosupport files (no vscode dependency).

export interface SubSection {
  name: string;
  line: number;      // title line
  endLine: number;   // last line (inclusive)
}

export interface Section {
  name: string;
  line: number;      // header line
  endLine: number;   // last line (inclusive)
  children: SubSection[];
}

export interface ParsedAsup {
  sections: Section[];
}

export const SECTION_RE = /^={5,}\s+(.+?)\s+={5,}\s*$/;
const DASH_ONLY_RE = /^-{3,}\s*$/;
const GENERATED_RE = /^GENERATED:/;

/** True if the file looks like a Data Domain autosupport. */
export function looksLikeAsup(firstLines: string[]): boolean {
  return firstLines.some(l => /^={5,}\s+GENERAL INFO\s+={5,}/.test(l));
}

function isSubsectionTitle(lines: string[], i: number): boolean {
  const title = lines[i];
  const next = lines[i + 1];
  if (next === undefined || !DASH_ONLY_RE.test(next)) return false;
  const t = title.trim();
  if (t.length < 3 || t.length > 100) return false;
  if (/^[-=*#]/.test(t)) return false;
  // "key = value" / "counter: 0" lines followed by a dash rule are data, not titles.
  if (/=/.test(t) || /:\s+\S/.test(t)) return false;
  if (SECTION_RE.test(title) || GENERATED_RE.test(t)) return false;
  // Table header rows have wide column gaps; titles do not.
  if (/\S {3,}\S/.test(t)) return false;
  // A row sandwiched between two dash lines is a table header.
  const prev = lines[i - 1];
  if (prev !== undefined && DASH_ONLY_RE.test(prev)) return false;
  return true;
}

export function parseAsup(lines: string[]): ParsedAsup {
  const sections: Section[] = [];
  let current: Section | undefined;

  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i]);
    if (m) {
      if (current) current.endLine = i - 1;
      current = { name: m[1].trim(), line: i, endLine: lines.length - 1, children: [] };
      sections.push(current);
      continue;
    }
    if (isSubsectionTitle(lines, i)) {
      if (!current) {
        current = { name: '(preamble)', line: 0, endLine: lines.length - 1, children: [] };
        sections.push(current);
      }
      current.children.push({ name: lines[i].trim().replace(/:$/, ''), line: i, endLine: current.endLine });
    }
  }
  if (current) current.endLine = lines.length - 1;

  for (const s of sections) {
    for (let k = 0; k < s.children.length; k++) {
      const next = s.children[k + 1];
      s.children[k].endLine = next ? next.line - 1 : s.endLine;
    }
    s.children.forEach(c => { c.endLine = trimTrailingBlank(lines, c.line, c.endLine); });
    s.endLine = trimTrailingBlank(lines, s.line, s.endLine);
  }
  return { sections };
}

function trimTrailingBlank(lines: string[], start: number, end: number): number {
  while (end > start && lines[end].trim() === '') end--;
  return end;
}

export function findSection(p: ParsedAsup, name: string): Section | undefined {
  const n = name.toUpperCase();
  return p.sections.find(s => s.name.toUpperCase() === n);
}

export function findSub(p: ParsedAsup, name: string): SubSection | undefined {
  const n = name.toLowerCase();
  for (const s of p.sections) {
    const c = s.children.find(c => c.name.toLowerCase() === n);
    if (c) return c;
  }
  return undefined;
}

export function sectionAt(p: ParsedAsup, line: number): Section | undefined {
  return p.sections.find(s => line >= s.line && line <= s.endLine);
}

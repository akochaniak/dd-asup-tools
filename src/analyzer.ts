// Health checks for Data Domain autosupport files (no vscode dependency).
import { ParsedAsup, findSub, findSection } from './parser';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  line: number;
  start: number;
  end: number;
  severity: Severity;
  code: string;
  message: string;
}

export interface Alert {
  line: number;
  id: string;
  postTime: string;
  severity: string;
  cls: string;
  object: string;
  code: string;
  message: string;
}

export interface UsageRow {
  line: number;
  resource: string;
  percent: number;
  pctStart: number;
  pctEnd: number;
  raw: string;
}

export interface SyslogGroup {
  level: string;
  process: string;
  pattern: string;
  count: number;
  firstLine: number;
  sample: string;
}

export interface CustomRule {
  pattern: string;
  flags?: string;
  severity?: Severity;
  message?: string;
  code?: string;
}

export interface AnalyzerOptions {
  usageWarn: number;
  usageError: number;
  licenseExpiryDays: number;
  syslogMinLevel: 'off' | 'error' | 'warning';
  customRules: CustomRule[];
  now?: Date;
}

export const DEFAULT_OPTIONS: AnalyzerOptions = {
  usageWarn: 80,
  usageError: 90,
  licenseExpiryDays: 30,
  syslogMinLevel: 'error',
  customRules: [],
};

export interface Analysis {
  alerts: Alert[];
  usage: UsageRow[];
  findings: Finding[];
  syslog: SyslogGroup[];
  syslogCounts: Record<string, number>;
  info: Record<string, string>;
}

const ALERT_RE = /^(\S+)\s{2,}(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s{2,}([A-Z]+)\s{2,}(\S+)\s{2,}(.*?)\s{2,}(EVT-[A-Z0-9]+-\d+):\s*(.*?)\s*$/;
export const SYSLOG_RE = /^(\w{3}\s+\d+ \d\d:\d\d:\d\d) (\S+) ([^\s:[]+)(?:\[\d+\])?: (EMERG|ALERT|CRIT|CRITICAL|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG):\s*(.*)$/;
const USAGE_RE = /^(\/[^\s:]+(?:: [\w-]+)?)\s.*?\s(\d{1,3})%(?=\s|$)/;
const LICENSE_RE = /^\d+\s+(\S+)\s+.*?\s(permanent|evaluation|temporary|subscription|\S+)\s+(active|expired|inactive|\S+)\s+(n\/a|\d{4}-\d\d-\d\d)\b/;

function sevOfAlert(s: string): Severity {
  if (/^(EMERGENCY|ALERT|CRITICAL|ERROR)$/.test(s)) return 'error';
  if (s === 'WARNING') return 'warning';
  return 'info';
}

function sevOfSyslog(level: string): number {
  if (/^(EMERG|ALERT|CRIT|CRITICAL)$/.test(level)) return 3;
  if (/^(ERROR|ERR)$/.test(level)) return 2;
  if (/^(WARNING|WARN)$/.test(level)) return 1;
  return 0;
}

export function normalizeMessage(msg: string): string {
  return msg
    .replace(/(?:::ffff:)?\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d+)?\b/g, '<ip>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\/[\w.@+-]+(?:\/[\w.@+-]*)+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .slice(0, 200);
}

export function analyze(lines: string[], parsed: ParsedAsup, opts: AnalyzerOptions = DEFAULT_OPTIONS): Analysis {
  const findings: Finding[] = [];
  const add = (line: number, severity: Severity, code: string, message: string, start = 0, end?: number) =>
    findings.push({ line, start, end: end ?? lines[line].length, severity, code, message });

  // --- General info key=value
  const info: Record<string, string> = {};
  const gi = findSection(parsed, 'GENERAL INFO');
  if (gi) {
    for (let i = gi.line + 1; i <= gi.endLine; i++) {
      const m = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(lines[i]);
      if (m) info[m[1]] = m[2].trim();
    }
  }

  // --- Current alerts
  const alerts: Alert[] = [];
  const cur = findSub(parsed, 'Current Alerts');
  if (cur) {
    for (let i = cur.line + 1; i <= cur.endLine; i++) {
      const m = ALERT_RE.exec(lines[i]);
      if (!m) continue;
      const a: Alert = { line: i, id: m[1], postTime: m[2], severity: m[3], cls: m[4], object: m[5], code: m[6], message: m[7] };
      alerts.push(a);
      add(i, sevOfAlert(a.severity), a.code, `[${a.severity}] ${a.code}: ${a.message} (alert ${a.id}, since ${a.postTime})`);
    }
  }

  // --- Space usage (any "/path ... NN%" row: Active Tier, Cloud Tier, ...)
  const usage: UsageRow[] = [];
  const su = findSection(parsed, 'SERVER USAGE');
  const scan = su ? [[su.line, su.endLine]] : [[0, lines.length - 1]];
  const ct = findSection(parsed, 'CLOUD TIER INFORMATION');
  if (ct) scan.push([ct.line, ct.endLine]);
  for (const [a, b] of scan) {
    for (let i = a; i <= b; i++) {
      const m = USAGE_RE.exec(lines[i]);
      if (!m) continue;
      const pct = parseInt(m[2], 10);
      const pctEnd = m.index + m[0].length;
      const pctStart = pctEnd - m[2].length - 1;
      const row: UsageRow = { line: i, resource: m[1], percent: pct, pctStart, pctEnd, raw: lines[i] };
      usage.push(row);
      if (pct >= opts.usageError) add(i, 'error', 'DD-USAGE', `${m[1]} usage ${pct}% ≥ ${opts.usageError}%`, pctStart, pctEnd);
      else if (pct >= opts.usageWarn) add(i, 'warning', 'DD-USAGE', `${m[1]} usage ${pct}% ≥ ${opts.usageWarn}%`, pctStart, pctEnd);
    }
  }

  // --- Simple status subsections: first non-empty line must match an OK pattern
  const statusChecks: [string, RegExp, Severity, string][] = [
    ['Disk Status', /^Normal\b/, 'error', 'Disk status is not Normal'],
    ['Proactive Disk Check', /^No drives have exceeded/, 'warning', 'Drives exceeded reliability thresholds'],
    ['Filesys Verify Status', /running normally|completed/i, 'warning', 'Filesystem verification not running normally'],
    ['Registry Check', /OK/, 'error', 'Registry check reported problems'],
  ];
  for (const [name, ok, sev, msg] of statusChecks) {
    const s = findSub(parsed, name);
    if (!s) continue;
    for (let i = s.line + 2; i <= s.endLine; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      if (!ok.test(t)) add(i, sev, 'DD-STATUS', `${msg}: "${t}"`);
      break;
    }
  }

  // --- Alerts history / ntp
  const ntp = findSub(parsed, 'Ntp Status');
  if (ntp) {
    for (let i = ntp.line + 2; i <= ntp.endLine; i++) {
      const m = /^Status\s{2,}(\S+)/.exec(lines[i]);
      if (m && !/^Enabled$/i.test(m[1])) add(i, 'warning', 'DD-NTP', `NTP status: ${m[1]}`);
    }
  }

  // --- Licenses
  const now = opts.now ?? new Date();
  for (let i = 0; i < lines.length; i++) {
    const m = LICENSE_RE.exec(lines[i]);
    if (!m) continue;
    const [, feature, , state, exp] = m;
    if (/^(expired|inactive)$/i.test(state)) add(i, 'error', 'DD-LICENSE', `License ${feature} is ${state}`);
    if (exp !== 'n/a') {
      const days = Math.floor((new Date(exp + 'T00:00:00Z').getTime() - now.getTime()) / 86400000);
      if (days < 0) add(i, 'error', 'DD-LICENSE', `License ${feature} expired ${-days} day(s) ago (${exp})`);
      else if (days <= opts.licenseExpiryDays) add(i, 'warning', 'DD-LICENSE', `License ${feature} expires in ${days} day(s) (${exp})`);
    }
  }

  // --- Missing CA certificates, crashes
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^\*+ There is no imported ca certificate for application\(s\): (.+?)\.?\s*$/.exec(l);
    if (m) add(i, 'info', 'DD-CERT', `No imported CA certificate for: ${m[1]}`);
    m = /Number of DDFS crashes since last boot:\s*(\d+)/.exec(l);
    if (m && +m[1] > 0) add(i, 'error', 'DD-CRASH', `${m[1]} DDFS crash(es) since last boot`);
    m = /Number of DDFS crashes over lifetime:\s*(\d+)/.exec(l);
    if (m && +m[1] > 0) add(i, 'info', 'DD-CRASH', `${m[1]} DDFS crash(es) over lifetime`);
  }

  // --- Syslog lines: counts, groups, optional diagnostics
  const groups = new Map<string, SyslogGroup>();
  const syslogCounts: Record<string, number> = {};
  const minSev = opts.syslogMinLevel === 'off' ? 99 : opts.syslogMinLevel === 'error' ? 2 : 1;
  for (let i = 0; i < lines.length; i++) {
    const m = SYSLOG_RE.exec(lines[i]);
    if (!m) continue;
    const [, , , proc, level, msg] = m;
    syslogCounts[level] = (syslogCounts[level] ?? 0) + 1;
    const sv = sevOfSyslog(level);
    if (sv === 0) continue;
    const pattern = normalizeMessage(msg);
    const key = `${level}|${proc}|${pattern}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { level, process: proc, pattern, count: 1, firstLine: i, sample: msg.slice(0, 300) });
    if (sv >= minSev) add(i, sv >= 2 ? 'warning' : 'info', 'DD-SYSLOG', `${level} from ${proc}: ${msg.slice(0, 160)}`);
  }
  const syslog = [...groups.values()].sort((a, b) => sevOfSyslog(b.level) - sevOfSyslog(a.level) || b.count - a.count);

  // --- User rules
  for (const r of opts.customRules) {
    let re: RegExp;
    try { re = new RegExp(r.pattern, (r.flags ?? '').replace('g', '')); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const msg = (r.message ?? 'Matched custom rule: $0').replace(/\$(\d)/g, (_, d) => m[+d] ?? '');
      add(i, r.severity ?? 'warning', r.code ?? 'DD-CUSTOM', msg, m.index, m.index + m[0].length);
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return { alerts, usage, findings, syslog, syslogCounts, info };
}

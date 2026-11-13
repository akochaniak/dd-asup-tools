// Markdown health card for an autosupport (no vscode dependency).
import { ParsedAsup, findSub } from './parser';
import { Analysis } from './analyzer';

const esc = (s: string) => s.replace(/\|/g, '\\|');

function subLines(lines: string[], p: ParsedAsup, name: string): string[] {
  const s = findSub(p, name);
  return s ? lines.slice(s.line + 2, s.endLine + 1) : [];
}

export function buildSummary(lines: string[], parsed: ParsedAsup, a: Analysis, fileName: string): string {
  const out: string[] = [];
  const i = a.info;
  out.push(`# Data Domain autosupport — ${i.HOSTNAME ?? fileName}`, '');
  out.push('| Field | Value |', '|---|---|');
  const fields: [string, string][] = [
    ['Generated', 'GENERATED_ON'], ['Model', 'MODEL_NO'], ['DD OS', 'VERSION'], ['System serial', 'SYSTEM_SERIALNO'],
    ['Service tag', 'DELL_SERVICETAG'], ['HA enabled', 'HA_ENABLED'], ['Encryption supported', 'DATA_ENCRYPTION_SUPPORTED'], ['Uptime', 'UPTIME'],
  ];
  for (const [label, key] of fields) if (i[key]) out.push(`| ${label} | ${esc(i[key])} |`);
  out.push('');

  const errs = a.findings.filter(f => f.severity === 'error').length;
  const warns = a.findings.filter(f => f.severity === 'warning').length;
  const infos = a.findings.filter(f => f.severity === 'info').length;
  out.push(`**Findings:** ${errs} error(s), ${warns} warning(s), ${infos} info · **Active alerts:** ${a.alerts.length}`, '');

  out.push('## Capacity', '');
  for (const tier of ['Active Tier:', 'Cloud Tier:']) {
    const start = lines.findIndex(l => l.trim() === tier);
    if (start < 0) continue;
    const block: string[] = [];
    for (let k = start + 1; k < lines.length && lines[k].trim() !== ''; k++) block.push(lines[k]);
    out.push(`**${tier.replace(':', '')}**`, '```', ...block, '```', '');
  }
  const comp = subLines(lines, parsed, 'Filesys Compression').filter(l => /Last 7 days|Last 24 hrs|Currently Used/.test(l));
  if (comp.length) out.push('Compression:', '```', ...comp, '```', '');

  out.push('## Current alerts', '');
  if (a.alerts.length) {
    out.push('| Id | Since | Severity | Class | Object | Code | Message |', '|---|---|---|---|---|---|---|');
    for (const al of a.alerts) out.push(`| ${al.id} | ${al.postTime} | ${al.severity} | ${al.cls} | ${esc(al.object)} | ${al.code} | ${esc(al.message)} |`);
  } else out.push('_No active alerts._');
  out.push('');

  out.push('## Findings', '');
  const f = a.findings.filter(x => x.code !== 'DD-SYSLOG');
  if (f.length) {
    out.push('| Line | Severity | Code | Message |', '|---|---|---|---|');
    for (const x of f) out.push(`| ${x.line + 1} | ${x.severity} | ${x.code} | ${esc(x.message)} |`);
  } else out.push('_No findings._');
  out.push('');

  out.push('## Syslog', '');
  const counts = Object.entries(a.syslogCounts).map(([k, v]) => `${k}: ${v}`).join(' · ');
  out.push(counts || '_No syslog lines found._', '');
  if (a.syslog.length) {
    out.push('Top grouped ERROR/WARNING messages:', '', '| Count | Level | Process | First line | Pattern |', '|---|---|---|---|---|');
    for (const g of a.syslog.slice(0, 25)) out.push(`| ${g.count} | ${g.level} | ${g.process} | ${g.firstLine + 1} | \`${esc(g.pattern).replace(/`/g, "'")}\` |`);
    out.push('');
  }

  out.push('## Sections', '');
  for (const s of parsed.sections) out.push(`- ${s.name} — line ${s.line + 1} (${s.endLine - s.line + 1} lines)`);
  return out.join('\n') + '\n';
}

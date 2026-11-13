// Usage: node test/run.js <autosupport-file>
const fs = require('fs');
const { parseAsup, looksLikeAsup } = require('../out/parser');
const { analyze, DEFAULT_OPTIONS } = require('../out/analyzer');
const { buildSummary } = require('../out/summary');
const { anonymize } = require('../out/anonymize');
const file = process.argv[2];
if (!file) { console.log('usage: node test/run.js <asup file>'); process.exit(0); }
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const t0 = Date.now();
const p = parseAsup(lines);
const a = analyze(lines, p, { ...DEFAULT_OPTIONS, now: new Date() });
console.log('detected:', looksLikeAsup(lines.slice(0, 10)), 'parse+analyze ms:', Date.now() - t0);
console.log('sections:', p.sections.length, 'subsections:', p.sections.reduce((n, s) => n + s.children.length, 0));
console.log('alerts:', a.alerts.length, 'usage rows:', a.usage.length, 'findings:', a.findings.length);
for (const f of a.findings.filter(f => f.code !== 'DD-SYSLOG')) console.log(`  L${f.line + 1} ${f.severity} ${f.code} ${f.message}`);
console.log('syslog:', a.syslogCounts, 'groups:', a.syslog.length);
fs.writeFileSync('/tmp/summary.md', buildSummary(lines, p, a, file));
const an = anonymize(text, { ips: true, macs: true, emails: true, extraTerms: [] });
fs.writeFileSync('/tmp/anon.txt', an.text);
console.log('anonymized values:', Object.keys(an.mapping).length);

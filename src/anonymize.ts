// Consistent anonymization of autosupport content (no vscode dependency).

export interface AnonymizeOptions {
  ips: boolean;
  macs: boolean;
  emails: boolean;
  extraTerms: string[];
}

export interface AnonymizeResult {
  text: string;
  mapping: Record<string, string>;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keyValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=\\s*(\\S+)`, 'm').exec(text);
  return m && m[1] !== 'Unspecified' ? m[1] : undefined;
}

export function anonymize(text: string, opts: AnonymizeOptions): AnonymizeResult {
  const mapping: Record<string, string> = {};
  const terms: [string, string][] = [];

  const fqdn = keyValue(text, 'HOSTNAME');
  if (fqdn) {
    const [host, ...rest] = fqdn.split('.');
    if (rest.length) {
      terms.push([rest.join('.'), 'example.local']);
      // Organisation's registrable domain (e.g. corp.co.uk / company.com) catches sibling subdomains too.
      const labels = rest;
      const n = labels.length >= 3 && /^(gov|com|co|org|net|edu|ac|mil)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
      if (labels.length > n) terms.push([labels.slice(-n).join('.'), 'example.local']);
    }
    if (host.length >= 3) terms.push([host, 'ddhost01']);
  }
  const serials: [string, string][] = [
    ['SYSTEM_SERIALNO', 'SERIAL-SYS-0001'], ['CHASSIS_SERIALNO', 'SERIAL-CHS-0001'], ['DELL_SERVICETAG', 'SVCTAG01'],
  ];
  for (const [k, v] of serials) {
    const val = keyValue(text, k);
    if (val && val.length >= 5) terms.push([val, v]);
  }
  const email = keyValue(text, 'ADMIN_EMAIL');
  if (email) terms.push([email, 'admin@example.local']);
  opts.extraTerms.filter(t => t.trim()).forEach((t, n) => terms.push([t, `REDACTED-${n + 1}`]));

  // Longest first so the domain wins over the short hostname inside it.
  terms.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of terms) {
    const re = new RegExp(escRe(from), 'gi');
    if (re.test(out)) { mapping[from] = to; out = out.replace(re, to); }
  }

  if (opts.ips) {
    const ipMap = new Map<string, string>();
    out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (ip, a, b, c, d) => {
      if ([a, b, c, d].some(x => +x > 255)) return ip;
      if (/^(0\.0\.0\.0|127\.|255\.)/.test(ip)) return ip;
      let r = ipMap.get(ip);
      if (!r) {
        const n = ipMap.size + 1;
        r = `10.255.${(n >> 8) & 255}.${n & 255}`;
        ipMap.set(ip, r);
        mapping[ip] = r;
      }
      return r;
    });
  }
  if (opts.macs) {
    const macMap = new Map<string, string>();
    out = out.replace(/\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}(?:(?::[0-9a-fA-F]{2}){2})?\b/g, mac => {
      let r = macMap.get(mac.toLowerCase());
      if (!r) {
        const n = macMap.size + 1;
        const groups = mac.split(':').length;
        const hex = n.toString(16).padStart(groups * 2, '0').slice(-(groups * 2));
        r = (groups === 8 ? 'aa:bb:' : '02:00:') + hex.match(/../g)!.slice(2).join(':');
        macMap.set(mac.toLowerCase(), r);
        mapping[mac] = r;
      }
      return r;
    });
  }
  if (opts.emails) {
    out = out.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, e => {
      if (e.endsWith('example.local')) return e;
      const r = 'user@example.local';
      mapping[e] = r;
      return r;
    });
  }
  return { text: out, mapping };
}

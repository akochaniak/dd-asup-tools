import * as vscode from 'vscode';
import { parseAsup, looksLikeAsup, ParsedAsup, sectionAt } from './parser';
import { analyze, Analysis, AnalyzerOptions, CustomRule, Severity, SYSLOG_RE } from './analyzer';
import { buildSummary } from './summary';
import { anonymize } from './anonymize';

const LANG = 'ddasup';

interface Cached { version: number; lines: string[]; parsed: ParsedAsup; analysis: Analysis; }
const cache = new Map<string, Cached>();

function cfg() { return vscode.workspace.getConfiguration('ddasup'); }

function analyzerOptions(): AnalyzerOptions {
  const c = cfg();
  return {
    usageWarn: c.get<number>('usage.warningThreshold', 80),
    usageError: c.get<number>('usage.errorThreshold', 90),
    licenseExpiryDays: c.get<number>('license.expiryWarningDays', 30),
    syslogMinLevel: c.get<'off' | 'error' | 'warning'>('diagnostics.syslogLevel', 'error'),
    customRules: c.get<CustomRule[]>('customRules', []),
  };
}

function getModel(doc: vscode.TextDocument): Cached {
  const key = doc.uri.toString();
  const c = cache.get(key);
  if (c && c.version === doc.version) return c;
  const lines = doc.getText().split(/\r?\n/);
  const parsed = parseAsup(lines);
  const analysis = analyze(lines, parsed, analyzerOptions());
  const fresh = { version: doc.version, lines, parsed, analysis };
  cache.set(key, fresh);
  return fresh;
}

const sevMap: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function activeAsup(): vscode.TextEditor | undefined {
  const e = vscode.window.activeTextEditor;
  if (!e || e.document.languageId !== LANG) {
    vscode.window.showWarningMessage('Open a Data Domain autosupport file first.');
    return undefined;
  }
  return e;
}

export function activate(ctx: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANG);
  const usageWarnDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editorWarning.background'),
    border: '1px solid', borderColor: new vscode.ThemeColor('editorWarning.foreground'), fontWeight: 'bold',
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const usageErrDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
    border: '1px solid', borderColor: new vscode.ThemeColor('editorError.foreground'), fontWeight: 'bold',
    overviewRulerColor: new vscode.ThemeColor('editorError.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const sectionDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  ctx.subscriptions.push(diagnostics, usageWarnDeco, usageErrDeco, sectionDeco);

  // ---- auto-detect plain-text autosupports
  const detect = (doc: vscode.TextDocument) => {
    if (!cfg().get<boolean>('autoDetect', true)) return;
    if (doc.languageId === LANG || !['plaintext', 'log'].includes(doc.languageId)) return;
    const n = Math.min(doc.lineCount, 10);
    const first: string[] = [];
    for (let i = 0; i < n; i++) first.push(doc.lineAt(i).text);
    if (looksLikeAsup(first)) vscode.languages.setTextDocumentLanguage(doc, LANG);
  };

  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== LANG) return;
    const { analysis } = getModel(doc);
    if (!cfg().get<boolean>('diagnostics.enabled', true)) { diagnostics.delete(doc.uri); return; }
    diagnostics.set(doc.uri, analysis.findings.map(f => {
      const d = new vscode.Diagnostic(new vscode.Range(f.line, f.start, f.line, f.end), f.message, sevMap[f.severity]);
      d.source = 'DD ASUP';
      d.code = f.code;
      return d;
    }));
  };

  const decorate = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.languageId !== LANG) return;
    const { analysis, parsed } = getModel(editor.document);
    const o = analyzerOptions();
    const warn: vscode.Range[] = [], err: vscode.Range[] = [];
    for (const u of analysis.usage) {
      const r = new vscode.Range(u.line, u.pctStart, u.line, u.pctEnd);
      if (u.percent >= o.usageError) err.push(r); else if (u.percent >= o.usageWarn) warn.push(r);
    }
    editor.setDecorations(usageWarnDeco, warn);
    editor.setDecorations(usageErrDeco, err);
    editor.setDecorations(sectionDeco, cfg().get<boolean>('highlightSectionHeaders', true)
      ? parsed.sections.filter(s => s.name !== '(preamble)').map(s => new vscode.Range(s.line, 0, s.line, 0)) : []);
  };

  vscode.workspace.textDocuments.forEach(d => { detect(d); refresh(d); });
  decorate(vscode.window.activeTextEditor);

  let timer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(d => { detect(d); refresh(d); }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId !== LANG) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { refresh(e.document); decorate(vscode.window.activeTextEditor); }, 500);
    }),
    vscode.workspace.onDidCloseTextDocument(d => { cache.delete(d.uri.toString()); diagnostics.delete(d.uri); }),
    vscode.window.onDidChangeActiveTextEditor(e => { if (e) { refresh(e.document); decorate(e); } }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('ddasup')) return;
      cache.clear();
      vscode.workspace.textDocuments.forEach(refresh);
      vscode.window.visibleTextEditors.forEach(decorate);
    }),
  );

  const sel: vscode.DocumentSelector = { language: LANG };

  // ---- outline
  ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(sel, {
    provideDocumentSymbols(doc) {
      const { parsed, lines } = getModel(doc);
      return parsed.sections.map(s => {
        const range = new vscode.Range(s.line, 0, s.endLine, lines[s.endLine]?.length ?? 0);
        const sym = new vscode.DocumentSymbol(s.name, `${s.endLine - s.line + 1} lines`, vscode.SymbolKind.Namespace, range, new vscode.Range(s.line, 0, s.line, lines[s.line].length));
        sym.children = s.children.map(c => new vscode.DocumentSymbol(c.name, '', vscode.SymbolKind.Struct,
          new vscode.Range(c.line, 0, c.endLine, lines[c.endLine]?.length ?? 0), new vscode.Range(c.line, 0, c.line, lines[c.line].length)));
        return sym;
      });
    },
  }, { label: 'DD Autosupport' }));

  // ---- folding
  ctx.subscriptions.push(vscode.languages.registerFoldingRangeProvider(sel, {
    provideFoldingRanges(doc) {
      const { parsed } = getModel(doc);
      const out: vscode.FoldingRange[] = [];
      for (const s of parsed.sections) {
        if (s.endLine > s.line) out.push(new vscode.FoldingRange(s.line, s.endLine, vscode.FoldingRangeKind.Region));
        for (const c of s.children) if (c.endLine > c.line + 1) out.push(new vscode.FoldingRange(c.line, c.endLine));
      }
      return out;
    },
  }));

  // ---- semantic tokens: subsection titles (TextMate cannot look at the next line)
  const legend = new vscode.SemanticTokensLegend(['ddSubsection', 'ddSection']);
  ctx.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(sel, {
    provideDocumentSemanticTokens(doc) {
      const { parsed, lines } = getModel(doc);
      const b = new vscode.SemanticTokensBuilder(legend);
      for (const s of parsed.sections) {
        for (const c of s.children) {
          const text = lines[c.line];
          const start = text.length - text.trimStart().length;
          b.push(c.line, start, text.trim().length, 0, 0);
        }
      }
      return b.build();
    },
  }, legend));

  // ---- hover: epochs, big byte counts, EVT codes
  ctx.subscriptions.push(vscode.languages.registerHoverProvider(sel, {
    provideHover(doc, pos) {
      const evtRange = doc.getWordRangeAtPosition(pos, /EVT-[A-Z0-9]+-\d+/);
      if (evtRange) {
        const code = doc.getText(evtRange);
        const { analysis, lines } = getModel(doc);
        const md = new vscode.MarkdownString(`**${code}**\n\n`);
        const alerts = analysis.alerts.filter(a => a.code === code);
        alerts.forEach(a => md.appendMarkdown(`- \`${a.id}\` ${a.severity} · ${a.object} · since ${a.postTime}\n  ${a.message}\n`));
        const occ = lines.reduce((n, l) => n + (l.includes(code) ? 1 : 0), 0);
        md.appendMarkdown(`\nOccurrences in file: ${occ}`);
        if (alerts.length) md.appendMarkdown(`\n\nOn the system: \`alert show current-detailed alert-id ${alerts[0].id}\``);
        return new vscode.Hover(md, evtRange);
      }
      const numRange = doc.getWordRangeAtPosition(pos, /\d{7,}(?:\.\d+)?/);
      if (!numRange) return;
      const txt = doc.getText(numRange);
      const n = Number(txt.split('.')[0]);
      const md = new vscode.MarkdownString();
      if (txt.split('.')[0].length === 10 && n > 1.0e9 && n < 2.2e9) {
        const d = new Date(n * 1000);
        md.appendMarkdown(`**Epoch** → ${d.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}\n\nLocal: ${d.toLocaleString()}`);
      } else if (txt.split('.')[0].length >= 13 && n > 1.0e12 && n < 2.2e12) {
        md.appendMarkdown(`**Epoch (ms)** → ${new Date(n).toISOString()}\n\n`);
        md.appendMarkdown(`If bytes: ${humanBytes(n)}`);
      } else {
        md.appendMarkdown(`If bytes: **${humanBytes(n)}**  ·  if KiB: ${humanBytes(n * 1024)}`);
      }
      return new vscode.Hover(md, numRange);
    },
  }));

  // ---- CodeLens: per-section syslog/finding counts
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(sel, {
    provideCodeLenses(doc) {
      if (!cfg().get<boolean>('codeLens.enabled', true)) return [];
      const { parsed, analysis, lines } = getModel(doc);
      const lenses: vscode.CodeLens[] = [];
      for (const s of parsed.sections) {
        if (s.name === '(preamble)') continue;
        const f = analysis.findings.filter(x => x.line >= s.line && x.line <= s.endLine);
        const e = f.filter(x => x.severity === 'error').length, w = f.filter(x => x.severity === 'warning').length;
        let sysE = 0, sysW = 0;
        for (let i = s.line; i <= s.endLine; i++) {
          const m = SYSLOG_RE.exec(lines[i]);
          if (!m) continue;
          if (/^(EMERG|ALERT|CRIT|CRITICAL|ERROR|ERR)$/.test(m[4])) sysE++; else if (/^WARN/.test(m[4])) sysW++;
        }
        const parts = [`${s.endLine - s.line + 1} lines`];
        if (e || w) parts.push(`${e} error(s), ${w} warning(s)`);
        if (sysE || sysW) parts.push(`syslog: ${sysE} ERROR, ${sysW} WARNING`);
        const range = new vscode.Range(s.line, 0, s.line, 0);
        lenses.push(new vscode.CodeLens(range, { title: parts.join(' · '), command: 'ddasup.extractSection', arguments: [s.line], tooltip: 'Open this section in a new editor' }));
      }
      return lenses;
    },
  }));

  // ---- commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('ddasup.showSummary', async () => {
      const e = activeAsup(); if (!e) return;
      const { lines, parsed, analysis } = getModel(e.document);
      const md = buildSummary(lines, parsed, analysis, e.document.fileName.split(/[\\/]/).pop() ?? '');
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }),

    vscode.commands.registerCommand('ddasup.gotoSection', async () => {
      const e = activeAsup(); if (!e) return;
      const { parsed } = getModel(e.document);
      type Item = vscode.QuickPickItem & { line: number };
      const items: Item[] = [];
      for (const s of parsed.sections) {
        items.push({ label: `$(symbol-namespace) ${s.name}`, description: `line ${s.line + 1}`, line: s.line });
        for (const c of s.children) items.push({ label: `    $(symbol-structure) ${c.name}`, description: `${s.name} · line ${c.line + 1}`, line: c.line });
      }
      const pick = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: 'Go to autosupport section' });
      if (!pick) return;
      const p = new vscode.Position(pick.line, 0);
      e.selection = new vscode.Selection(p, p);
      e.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.AtTop);
    }),

    vscode.commands.registerCommand('ddasup.extractSection', async (line?: number) => {
      const e = activeAsup(); if (!e) return;
      const { parsed, lines } = getModel(e.document);
      const s = sectionAt(parsed, typeof line === 'number' ? line : e.selection.active.line);
      if (!s) return;
      const doc = await vscode.workspace.openTextDocument({ language: LANG, content: lines.slice(s.line, s.endLine + 1).join('\n') + '\n' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('ddasup.anonymize', async () => {
      const e = activeAsup(); if (!e) return;
      const c = cfg();
      const res = anonymize(e.document.getText(), {
        ips: c.get<boolean>('anonymize.ips', true),
        macs: c.get<boolean>('anonymize.macs', true),
        emails: c.get<boolean>('anonymize.emails', true),
        extraTerms: c.get<string[]>('anonymize.extraTerms', []),
      });
      const doc = await vscode.workspace.openTextDocument({ language: LANG, content: res.text });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      const n = Object.keys(res.mapping).length;
      const choice = await vscode.window.showInformationMessage(`Anonymized ${n} distinct value(s). Review before sharing — free-text fields may still contain identifiers.`, 'Show mapping');
      if (choice === 'Show mapping') {
        const map = Object.entries(res.mapping).map(([k, v]) => `${v}\t${k}`).join('\n');
        const md = await vscode.workspace.openTextDocument({ language: 'plaintext', content: `# anonymized\toriginal (do NOT share this file)\n${map}\n` });
        await vscode.window.showTextDocument(md, vscode.ViewColumn.Active);
      }
    }),
  );
}

function humanBytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 2)} ${u[i]}`;
}

export function deactivate() { cache.clear(); }

# Data Domain Autosupport Tools

VS Code extension for reading Dell Data Domain / PowerProtect DD autosupport files (`autosupport`, `*autosupport*.txt`, `*.asup`).

## Features

- **Syntax highlighting.** Covers section headers (`==========  X  ==========`), subsection titles, `KEY=value` and registry `a.b.c = value` pairs, syslog prefixes (timestamp / host / process[pid]), severities (CRITICAL / ERROR / WARNING / NOTICE), `EVT-*` codes and alert IDs, dates, IPs, MACs and WWNs, paths, sizes, percentages and compression factors. Good states (`online`, `Normal`) and bad states (`offline`, `down`, `degraded`, `expired`) are coloured differently. Table rules are dimmed.
- **Auto-detection.** A plain-text or log file is switched to autosupport mode when `==========  GENERAL INFO  ==========` appears in its first lines (setting: `ddasup.autoDetect`).
- **Outline and breadcrumbs.** About 45 main sections and their subsections. `Ctrl+Shift+O` works, and so does **DD ASUP: Go to Section…** (`Ctrl+Alt+G`).
- **Folding.** You can fold whole sections and subsections.
- **Problems panel.** The following are reported:
  - Current Alerts entries (CRITICAL/ERROR → error, WARNING → warning)
  - capacity `Use%` over the thresholds, also highlighted inline
  - Disk Status not Normal, Proactive Disk Check, Filesys Verify, Registry Check
  - NTP not enabled
  - expired or soon-to-expire licenses
  - DDFS crashes
  - missing imported CA certificates
  - syslog ERROR/CRITICAL lines (configurable)
  - your own regex rules
- **Hover.**
  - `EVT-*` code: matching alerts and the `alert show current-detailed` command.
  - Epoch value: UTC and local time.
  - Large number: its size as bytes or KiB.
- **CodeLens.** Each section header shows its line count, findings and syslog ERROR/WARNING counts. Click it to open the section in a new editor.
- **DD ASUP: Show Health Summary.** Opens a Markdown health card with system info, capacity, compression, alerts, findings, grouped syslog errors and a section index.
- **DD ASUP: Anonymize.** Replaces hostname and domain, serial numbers, service tag, IPs (mapped consistently to `10.255.x.y`), MACs/WWNs, e-mails and any extra terms you list. Also offers the mapping table. Always review the output before sharing it.

## Settings

| Setting | Default | |
|---|---|---|
| `ddasup.autoDetect` | `true` | Detect autosupports opened as plain text |
| `ddasup.diagnostics.enabled` | `true` | Problems panel findings |
| `ddasup.diagnostics.syslogLevel` | `error` | `off` / `error` / `warning` |
| `ddasup.usage.warningThreshold` / `errorThreshold` | `80` / `90` | Use% thresholds |
| `ddasup.license.expiryWarningDays` | `30` | |
| `ddasup.codeLens.enabled` | `true` | |
| `ddasup.highlightSectionHeaders` | `true` | Full-line highlight of main headers |
| `ddasup.anonymize.*` | | `ips`, `macs`, `emails`, `extraTerms` |
| `ddasup.customRules` | `[]` | Extra regex diagnostics |

Custom rules example (`settings.json`):

```json
"ddasup.customRules": [
  { "pattern": "^(\\S+)\\s+SAS\\s+offline", "severity": "info", "message": "SAS port $1 offline (check if cabled)" },
  { "pattern": "link is down", "flags": "i", "severity": "warning", "code": "NIC-DOWN" }
]
```

Colours come from `configurationDefaults → editor.tokenColorCustomizations`. They are tuned for dark themes. To override them, add your own `textMateRules` for the `*.ddasup` scopes, for example `keyword.severity.error.ddasup` or `markup.heading.section.ddasup`.

## Install

Download the `.vsix` from [Releases](https://github.com/akochaniak/dd-asup-tools/releases) and run `code --install-extension dd-asup-tools-<version>.vsix`.

## Release

Bump `version` in `package.json`, then `git tag v0.1.1 && git push --tags`; GitHub Actions builds the `.vsix` and attaches it to the release.

## Build

```bash
npm install
npm run compile
node test/run.js path/to/autosupport   # parser/analyzer smoke test, no VS Code needed
npx vsce package --no-dependencies     # -> dd-asup-tools-0.1.0.vsix
code --install-extension dd-asup-tools-0.1.0.vsix
```

Press F5 in VS Code with a `launch.json` of type `extensionHost` to debug.

## Layout

- `src/parser.ts`: section and subsection parser (pure TS)
- `src/analyzer.ts`: health checks, alerts, usage, syslog grouping (pure TS)
- `src/summary.ts`: Markdown health card
- `src/anonymize.ts`: consistent redaction
- `src/extension.ts`: VS Code wiring (diagnostics, outline, folding, semantic tokens, hover, CodeLens, commands)
- `syntaxes/ddasup.tmLanguage.json`: TextMate grammar

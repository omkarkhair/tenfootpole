#!/usr/bin/env node
// Flags files/fields that execute automatically when a developer installs,
// builds or opens a repo. Usage: autoexec.mjs <repoDir>  -> JSON on stdout.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const root = process.argv[2] || '.';
const ev = [];
const add = (severity, rule, file, line, detail) =>
  ev.push({ severity, rule, file: relative(root, file), line, detail });

const SKIP = new Set(['.git', 'node_modules', 'vendor', '.tfp']);
const files = [];
(function walk(d, depth) {
  if (depth > 6 || files.length > 5000) return;
  for (const n of readdirSync(d)) {
    if (SKIP.has(n)) continue;
    const p = join(d, n);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, depth + 1);
    else if (s.size < 1_000_000) files.push(p);
  }
})(root, 0);

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const lineOf = (txt, re) => { const m = re.exec(txt); return m ? txt.slice(0, m.index).split('\n').length : 1; };

const DANGEROUS = /(curl|wget)[^\n|]*\|\s*(ba|z)?sh|\beval\b|base64\s+(-d|--decode)|\bchmod\s+\+x\b|\/dev\/tcp\/|nc\s+-e|powershell[^\n]*-enc/i;

for (const f of files) {
  const b = basename(f), rel = relative(root, f), txt = read(f);

  if (b === 'package.json') {
    try {
      const pkg = JSON.parse(txt);
      for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
        const v = pkg.scripts?.[k];
        if (v) add(DANGEROUS.test(v) ? 'high' : 'medium', 'npm-lifecycle-script', f, lineOf(txt, new RegExp(`"${k}"`)), `${k}: ${v}`);
      }
    } catch {}
  }
  if (b === 'setup.py' && /cmdclass|install\.run|subprocess|os\.system|urlopen|requests\./.test(txt))
    add('medium', 'python-setup-hook', f, lineOf(txt, /cmdclass|subprocess|os\.system|urlopen|requests\./), 'setup.py runs custom code at install');
  if (b === 'build.rs') add('medium', 'rust-build-script', f, 1, 'build.rs runs at compile time');
  if (/^\.vscode\/tasks\.json$/.test(rel) && /"runOn"\s*:\s*"folderOpen"/.test(txt))
    add('high', 'vscode-autorun-task', f, lineOf(txt, /folderOpen/), 'task runs when the folder is opened in VS Code');
  if (/^\.(devcontainer\/devcontainer\.json|devcontainer\.json)$/.test(rel)) {
    const m = /"(postCreateCommand|postStartCommand|postAttachCommand|onCreateCommand|initializeCommand|updateContentCommand)"/.exec(txt);
    if (m) add(m[1] === 'initializeCommand' ? 'high' : 'medium', 'devcontainer-lifecycle', f, lineOf(txt, new RegExp(m[1])), `${m[1]} runs automatically` + (m[1] === 'initializeCommand' ? ' ON THE HOST' : ''));
  }
  if (/^\.(husky|githooks)\//.test(rel) || /^\.git\/hooks\//.test(rel)) add('medium', 'git-hook', f, 1, 'git hook script');
  if (/^(Makefile|makefile|GNUmakefile)$/.test(b) && DANGEROUS.test(txt))
    add('medium', 'makefile-dangerous-command', f, lineOf(txt, DANGEROUS), 'Makefile contains pipe-to-shell/eval/chmod+x');
  if (/\.(sh|bash|js|mjs|cjs|py|ps1|bat|cmd)$/.test(b) && DANGEROUS.test(txt))
    add('medium', 'dangerous-command', f, lineOf(txt, DANGEROUS), 'pipe-to-shell, eval, base64 decode or chmod +x');
  if (/\.(js|mjs|cjs|py)$/.test(b) && /(process\.env|os\.environ)/.test(txt) && /(https?\.request|fetch\(|axios|requests\.(post|get)|urlopen|XMLHttpRequest|net\.connect|socket)/.test(txt))
    add('high', 'env-and-network', f, lineOf(txt, /process\.env|os\.environ/), 'reads environment variables and performs network I/O in the same file');
  if (/\.(js|mjs|cjs|py|sh)$/.test(b) && /(\.ssh\/|\.aws\/credentials|\.npmrc|\.netrc|Login Data|\.bash_profile|\.zshrc|\.bashrc)/.test(txt))
    add('high', 'sensitive-path', f, lineOf(txt, /\.ssh\/|\.aws\/|\.npmrc|\.netrc|Login Data|\.bash_profile|\.zshrc|\.bashrc/), 'references credential or shell-profile paths');
}
const rank = { high: 2, medium: 1 };
ev.sort((a, b) => rank[b.severity] - rank[a.severity]);
console.log(JSON.stringify({ evidence: ev }, null, 1));

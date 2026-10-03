#!/usr/bin/env node
// Usage: scan.mjs <repoDir> [timeoutSec]
// Runs the auto-exec check and OSV-scanner (malicious-package advisories only),
// writes /workspace/.tfp/findings.json and prints a one-line JSON summary.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const repo = process.argv[2] || '/workspace/project';
const timeoutMs = (Number(process.argv[3]) || 90) * 1000;

function run(cmd, args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); resolve({ out, err: String(e), code: -1, timedOut, ms: Date.now() - t0 }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code, timedOut, ms: Date.now() - t0 }); });
  });
}

const scanners = {};
const evidence = [];

// 1. Auto-exec surfaces
{
  const r = await run('node', ['/opt/tfp/autoexec.mjs', repo]);
  try {
    const j = JSON.parse(r.out);
    for (const e of j.evidence) evidence.push({ source: 'autoexec', ...e });
    scanners.autoexec = { status: 'ok', ms: r.ms, items: j.evidence.length };
  } catch {
    scanners.autoexec = { status: r.timedOut ? 'timeout' : 'error', ms: r.ms, error: r.err.slice(0, 300) };
  }
}

// 2. Known-malicious dependencies (OpenSSF MAL-* advisories, offline)
{
  const r = await run('osv-scanner', ['scan', 'source', '-r', '--offline-vulnerabilities', '--format', 'json', repo]);
  try {
    const j = JSON.parse(r.out);
    let n = 0;
    for (const res of j.results ?? []) {
      for (const pk of res.packages ?? []) {
        const mal = (pk.vulnerabilities ?? []).filter((v) => v.id?.startsWith('MAL-'));
        for (const v of mal) {
          n++;
          evidence.push({
            source: 'osv-scanner', severity: 'high', rule: 'known-malicious-package',
            file: (res.source?.path ?? '').replace(repo + '/', ''), line: 1,
            detail: `${pk.package.ecosystem}:${pk.package.name}@${pk.package.version} is listed as malicious (${v.id}) https://osv.dev/${v.id}`,
          });
        }
      }
    }
    scanners.osv = { status: 'ok', ms: r.ms, items: n };
  } catch {
    if (/No package sources found/.test(r.err + r.out)) {
      scanners.osv = { status: 'ok', ms: r.ms, items: 0, note: 'no lockfiles or manifests found' };
    } else
    // osv-scanner exits non-zero when it finds vulns; only an unparsable body is a failure.
    scanners.osv = { status: r.timedOut ? 'timeout' : 'error', ms: r.ms, error: (r.err || r.out).slice(0, 300) };
  }
}

const high = evidence.filter((e) => e.severity === 'high').length;
const malicious = evidence.some((e) => e.rule === 'known-malicious-package');
const verdict = malicious ? 'likely malicious' : high ? 'suspicious' : evidence.length ? 'review' : 'clear';
const failed = Object.values(scanners).some((s) => s.status !== 'ok');

const findings = { verdict, incomplete: failed, scanners, evidence, generatedAt: new Date().toISOString() };
mkdirSync('/workspace/.tfp', { recursive: true });
writeFileSync('/workspace/.tfp/findings.json', JSON.stringify(findings, null, 1));
console.log(JSON.stringify({ verdict, incomplete: failed, scanners, counts: { high, total: evidence.length } }));

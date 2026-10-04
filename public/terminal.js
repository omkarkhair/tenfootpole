import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { SandboxAddon } from '/vendor/sandbox-addon.mjs';

const $ = (id) => document.getElementById(id);

function scannerLine(label, r) {
  if (!r) return `${label}: not run`;
  if (r.status === 'ok') {
    if (r.note) return `${label}: ${r.note}`;
    return `${label}: ${r.items ?? 0} finding${r.items === 1 ? '' : 's'}`;
  }
  return `${label}: ${r.status === 'timeout' ? 'timed out' : 'failed'}`;
}

export function enterWorkspace({ instanceId, repo, data }) {
  document.body.classList.add('workspace-mode');
  const ws = $('workspace');
  ws.hidden = false;

  $('ws-repo').textContent = repo || '(repository)';
  $('ws-ide').href = data.url;

  // Scan summary
  const scan = data.scan;
  const verdictEl = $('ws-verdict');
  const v = scan?.verdict || 'unknown';
  verdictEl.textContent = v;
  verdictEl.className = 'verdict ' + (v.includes('malicious') ? 'malicious' : v);
  const rows = $('ws-scan-rows');
  rows.textContent = '';
  for (const t of [
    scannerLine('OSV-scanner', scan?.scanners?.osv),
    scannerLine('Auto-run hooks', scan?.scanners?.autoexec),
  ]) {
    const d = document.createElement('div');
    d.textContent = t;
    rows.appendChild(d);
  }
  if (scan?.incomplete) {
    const n = $('ws-scan-note');
    n.hidden = false;
    n.textContent = 'Scan incomplete: treat this verdict with caution.';
  }

  // Terminal
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#121212', foreground: '#F0E3DE', cursor: '#F14602' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  fit.fit();

  const dot = $('ws-conn-dot');
  const label = $('ws-conn');
  const addon = new SandboxAddon({
    getWebSocketUrl: ({ origin }) =>
      `${origin}/api/sandbox/${encodeURIComponent(instanceId)}/terminal?cols=${term.cols}&rows=${term.rows}`,
    onStateChange: (state, error) => {
      dot.dataset.state = state;
      label.textContent = error ? `${state} (${error.message})` : state;
    },
  });
  term.loadAddon(addon);
  addon.connect({ sandboxId: instanceId });

  // Keep the terminal sized to its pane; the addon forwards resizes.
  let raf = 0;
  const refit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { try { fit.fit(); } catch {} });
  };
  new ResizeObserver(refit).observe($('term'));
  window.addEventListener('resize', refit);

  // Quick actions type into the shell like the user would.
  ws.querySelectorAll('.actions button').forEach((b) =>
    b.addEventListener('click', () => {
      term.input(b.dataset.cmd + '\r', true);
      term.focus();
    }),
  );

  // Session clock
  const overlay = $('term-overlay');
  const timerEl = $('ws-timer');
  const tick = () => {
    const left = Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000));
    timerEl.textContent = left === 0 ? 'ended' : `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s`;
    if (left === 0) {
      clearInterval(timer);
      addon.disconnect();
      dot.dataset.state = 'disconnected';
      label.textContent = 'session ended';
      overlay.hidden = false;
      overlay.innerHTML = '<div><strong>Session ended</strong><p>This sandbox has been destroyed.</p><a href="/">Provision another</a></div>';
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
}

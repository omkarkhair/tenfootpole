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
    raf = requestAnimationFrame(() => {
      // A hidden tab has no size; fitting then would collapse the terminal.
      if ($('term').clientWidth > 0) { try { fit.fit(); } catch {} }
    });
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

  setupTabs(refit, () => { term.focus(); });
  startNetworkWatch(instanceId, () => data.expiresAt);

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

function setupTabs(onTerminalShown, focusTerminal) {
  const tabs = document.querySelectorAll('.tab');
  const panes = { terminal: $('pane-terminal'), network: $('pane-network') };
  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
      for (const [k, el] of Object.entries(panes)) el.hidden = k !== name;
      if (name === 'terminal') { onTerminalShown(); focusTerminal(); }
      else { netSeen = netTotalBlocked; renderBadge(); }
    }),
  );
}

// ---- Network watch ---------------------------------------------------------
let netSeen = 0;
let netTotalBlocked = 0;

function renderBadge() {
  const badge = $('net-badge');
  const unseen = netTotalBlocked - netSeen;
  badge.hidden = unseen <= 0;
  badge.textContent = String(unseen);
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function addRow(e) {
  const tr = document.createElement('tr');
  tr.className = e.decision;
  const cells = [
    fmtTime(e.at),
    e.decision === 'blocked' ? 'BLOCKED' : 'allowed',
    e.method,
    `${e.scheme}://${e.host}${e.port ? ':' + e.port : ''}${e.path}`,
    e.status ? String(e.status) : e.error ? 'error' : '',
    e.reason,
  ];
  cells.forEach((text, i) => {
    const td = document.createElement('td');
    td.textContent = text; // textContent: hosts and paths are attacker-controlled
    if (i === 3) td.className = 'net-url';
    if (i === 3) td.title = text;
    tr.appendChild(td);
  });
  return tr;
}

function startNetworkWatch(instanceId, getExpiry) {
  let since = 0;
  let timer = 0;
  const rows = $('net-rows');
  const poll = async () => {
    let next = 2500;
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(instanceId)}/egress?since=${since}`, { cache: 'no-store' });
      if (res.ok) {
        const d = await res.json();
        since = d.lastSeq;
        for (const e of d.events) rows.prepend(addRow(e));
        while (rows.children.length > 300) rows.lastChild.remove();
        $('net-empty').hidden = rows.children.length > 0;
        $('net-total').textContent = d.counts.total;
        $('net-allowed').textContent = d.counts.allowed;
        $('net-blocked').textContent = d.counts.blocked;
        $('net-dropped').textContent = d.dropped ? `(${d.dropped} older not shown)` : '';
        netTotalBlocked = d.counts.blocked;
        if (!$('pane-network').hidden) netSeen = netTotalBlocked;
        renderBadge();
        $('net-mode').textContent = d.mode === 'open'
          ? 'Egress is OPEN: requests are forwarded to the internet and logged here.'
          : 'Egress is DENIED: only the repo host (during clone) and the AI proxy are allowed. Everything else is blocked.';
        const hosts = $('net-hosts');
        hosts.textContent = '';
        if (!d.hosts.length) {
          const p = document.createElement('p');
          p.className = 'net-empty';
          p.textContent = 'Nothing yet.';
          hosts.appendChild(p);
        }
        for (const h of d.hosts) {
          const row = document.createElement('div');
          row.className = 'net-host' + (h.blocked ? ' has-blocked' : '');
          const name = document.createElement('span');
          name.textContent = h.host;
          const n = document.createElement('span');
          n.textContent = [h.allowed && `${h.allowed} ok`, h.blocked && `${h.blocked} blocked`].filter(Boolean).join(' · ');
          row.append(name, n);
          hosts.appendChild(row);
        }
        if (d.expired) return; // session over: stop polling
      } else if (res.status === 404 || res.status === 409) {
        next = 5000;
      }
    } catch { next = 5000; }
    if (Date.now() < getExpiry() + 5000) timer = setTimeout(poll, next);
  };
  poll();
  return () => clearTimeout(timer);
}

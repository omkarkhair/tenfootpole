const repoTagline = document.getElementById('repo-tagline');
const phaseMessageEl = document.getElementById('phase-message');
const stepper = document.getElementById('stepper');
const steps = Array.from(stepper.querySelectorAll('.step'));
const detailsEl = document.getElementById('details');
const detailRepo = document.getElementById('detail-repo');
const detailInstance = document.getElementById('detail-instance');
const detailElapsed = document.getElementById('detail-elapsed');
const detailUrlRow = document.getElementById('detail-url-row');
const detailUrl = document.getElementById('detail-url');
const openBtn = document.getElementById('open-btn');
const disclaimerEl = document.getElementById('disclaimer');
const errorEl = document.getElementById('error');
const detailExpiresRow = document.getElementById('detail-expires-row');
const detailExpires = document.getElementById('detail-expires');
const backLink = document.getElementById('back-link');
const scanResultEl = document.getElementById('scan-result');
const scanVerdictEl = document.getElementById('scan-verdict');
const scanRowsEl = document.getElementById('scan-rows');
const scanNoteEl = document.getElementById('scan-note');
const scanSubEl = document.getElementById('scan-sub');

// Path is /sandbox/<instanceId>
const instanceId = decodeURIComponent(
  window.location.pathname.replace(/^\/sandbox\//, ''),
);
const repo = new URLSearchParams(window.location.search).get('repo') || '';

const START_TIME = Date.now();
let elapsedInterval = null;
let pollTimer = null;

function startElapsedClock() {
  elapsedInterval = setInterval(() => {
    const seconds = Math.floor((Date.now() - START_TIME) / 1000);
    detailElapsed.textContent = seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }, 1000);
}

function stopElapsedClock() {
  if (elapsedInterval) clearInterval(elapsedInterval);
}

function startSessionCountdown(expiresAt) {
  detailExpiresRow.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    detailExpires.textContent = left === 0
      ? 'expired'
      : `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s`;
    if (left === 0) clearInterval(timer);
  };
  const timer = setInterval(tick, 1000);
  tick();
}

function setStepState(name, state) {
  const step = steps.find((s) => s.dataset.step === name);
  if (!step) return;
  step.classList.remove('active', 'done');
  if (state) step.classList.add(state);
}

function markStepsDoneUpTo(name) {
  const order = ['checkout', 'server', 'tunnel'];
  const idx = order.indexOf(name);
  order.forEach((step, i) => {
    if (i < idx) setStepState(step, 'done');
    else if (i === idx) setStepState(step, 'active');
    else setStepState(step, null);
  });
}

// Real per-step state from the workflow ({checkout: 'done', scan: 'active', ...}).
function applySteps(stepStates) {
  for (const step of steps) {
    const state = stepStates[step.dataset.step];
    step.classList.remove('active', 'done', 'error');
    if (state) step.classList.add(state);
  }
}

function describeScanner(label, r) {
  if (!r) return `${label}: not run`;
  if (r.status === 'ok') {
    if (r.note) return `${label}: ${r.note}`;
    return `${label}: ${r.items ?? 0} finding${r.items === 1 ? '' : 's'} (${(r.ms / 1000).toFixed(1)}s)`;
  }
  return `${label}: ${r.status === 'timeout' ? 'timed out' : 'failed'}`;
}

function showScan(scan) {
  if (!scan) return;
  const v = scan.verdict || 'unknown';
  scanVerdictEl.textContent = v;
  scanVerdictEl.className = 'verdict ' + (v.includes('malicious') ? 'malicious' : v);
  scanRowsEl.textContent = '';
  const rows = [
    describeScanner('OSV-scanner (malicious packages)', scan.scanners?.osv),
    describeScanner('Auto-run hooks', scan.scanners?.autoexec),
  ];
  for (const text of rows) {
    const row = document.createElement('div');
    row.className = 'scan-row';
    row.textContent = text;
    scanRowsEl.appendChild(row);
  }
  scanNoteEl.hidden = false;
  scanNoteEl.textContent = scan.incomplete
    ? 'Scan incomplete: a scanner failed or timed out, so treat this verdict with caution.'
    : 'Details are in /workspace/.tfp/findings.json. Run `pi` in the IDE terminal to review them.';
  scanResultEl.hidden = false;
}

function showError(message) {
  stopElapsedClock();
  if (pollTimer) clearTimeout(pollTimer);
  stepper.hidden = true;
  errorEl.textContent = message;
  errorEl.hidden = false;
  backLink.hidden = false;
}

async function start() {
  startElapsedClock();
  phaseMessageEl.hidden = false;
  await poll();
}

async function poll() {
  try {
    const res = await fetch(`/api/provision/${encodeURIComponent(instanceId)}`);
    const data = await res.json();

    if (!res.ok && data.status !== 'errored') {
      showError(data.error || 'Failed to fetch sandbox status.');
      return;
    }

    if (data.status === 'errored') {
      showError(data.error || 'Provisioning failed.');
      return;
    }

    if (data.status === 'complete') {
      steps.forEach((s) => {
        s.classList.remove('active');
        s.classList.add('done');
      });
      // The scan step is non-fatal: show it as errored if it was incomplete.
      if (data.scan?.incomplete) {
        const scanStep = steps.find((s) => s.dataset.step === 'scan');
        scanStep.classList.remove('done');
        scanStep.classList.add('error');
        scanSubEl.textContent = 'incomplete: a scanner failed or timed out';
      }
      showScan(data.scan);
      phaseMessageEl.hidden = true;
      detailUrlRow.hidden = false;
      detailUrl.textContent = data.url;
      openBtn.hidden = false;
      openBtn.href = data.url;
      disclaimerEl.hidden = false;
      stopElapsedClock();
      if (data.expiresAt) startSessionCountdown(data.expiresAt);
      return;
    }

    // The status API returns a `phase`/`message` derived server-side
    // (elapsed-time heuristic — Workflows' status API has no per-step
    // detail), so we don't need to duplicate that guesswork here.
    if (data.steps) {
      applySteps(data.steps);
      phaseMessageEl.textContent = data.steps.scan === 'active'
        ? 'Scanning repo with OSV-scanner...'
        : data.message || 'Provisioning...';
    } else {
      markStepsDoneUpTo(data.phase || 'checkout');
      phaseMessageEl.textContent = data.message || 'Provisioning...';
    }
    pollTimer = setTimeout(poll, 2500);
  } catch (err) {
    pollTimer = setTimeout(poll, 3000);
  }
}

if (!instanceId) {
  showError('Missing sandbox instance id.');
} else {
  detailInstance.textContent = instanceId;
  if (repo) {
    detailRepo.textContent = repo;
    repoTagline.textContent = repo;
  }
  detailsEl.hidden = false;
  start();
}

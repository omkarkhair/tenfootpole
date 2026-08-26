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
const backLink = document.getElementById('back-link');

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
      phaseMessageEl.hidden = true;
      detailUrlRow.hidden = false;
      detailUrl.textContent = data.url;
      openBtn.hidden = false;
      openBtn.href = data.url;
      disclaimerEl.hidden = false;
      stopElapsedClock();
      return;
    }

    // The status API returns a `phase`/`message` derived server-side
    // (elapsed-time heuristic — Workflows' status API has no per-step
    // detail), so we don't need to duplicate that guesswork here.
    markStepsDoneUpTo(data.phase || 'checkout');
    phaseMessageEl.textContent = data.message || 'Provisioning...';
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

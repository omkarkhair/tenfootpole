const form = document.getElementById('provision-form');
const repoInput = document.getElementById('repo-input');
const instanceTypeSelect = document.getElementById('instance-type');
const pokeBtn = document.getElementById('poke-btn');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

const GIT_URL_PATTERNS = [
  /^https:\/\/[a-zA-Z0-9.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/,
  /^git@[a-zA-Z0-9.-]+:[\w.-]+\/[\w.-]+(\.git)?$/,
  /^ssh:\/\/git@[a-zA-Z0-9.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/,
];

function isValidGitUrl(url) {
  return GIT_URL_PATTERNS.some((p) => p.test(url.trim()));
}

function setLoading(loading) {
  pokeBtn.disabled = loading;
  pokeBtn.classList.toggle('loading', loading);
  repoInput.disabled = loading;
  instanceTypeSelect.disabled = loading;
  if (loading) {
    statusEl.hidden = false;
    errorEl.hidden = true;
  } else {
    statusEl.hidden = true;
  }
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  statusEl.hidden = true;
}

const STATUS_MESSAGES = [
  'Spinning up sandbox...',
  'Cloning repository...',
  'Starting code-server...',
  'Opening tunnel...',
];

let statusInterval = null;

function startStatusCycle() {
  let i = 0;
  statusEl.textContent = STATUS_MESSAGES[0];
  statusInterval = setInterval(() => {
    i = (i + 1) % STATUS_MESSAGES.length;
    statusEl.textContent = STATUS_MESSAGES[i];
  }, 3000);
}

function stopStatusCycle() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollProvisionStatus(instanceId, { intervalMs = 2000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`/api/provision/${instanceId}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Provisioning failed.');
    }

    if (data.status === 'complete') {
      return data.url;
    }

    if (data.status === 'errored' || data.status === 'terminated') {
      throw new Error(data.error || 'Provisioning failed.');
    }

    await sleep(intervalMs);
  }

  throw new Error('Provisioning timed out.');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;

  const repo = repoInput.value.trim();
  if (!repo) {
    showError('Paste a git endpoint first.');
    return;
  }

  if (!isValidGitUrl(repo)) {
    showError('Invalid URL. Use HTTPS (https://...) or SSH (git@...) format.');
    return;
  }

  const instanceType = instanceTypeSelect.value;

  setLoading(true);
  startStatusCycle();

  try {
    const res = await fetch('/api/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, instanceType }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Provisioning failed.');
      return;
    }

    const url = await pollProvisionStatus(data.instanceId);

    statusEl.textContent = 'Redirecting to your IDE...';
    window.location.href = url;
  } catch (err) {
    showError(err.message || 'Network error. Is the Worker running?');
  } finally {
    stopStatusCycle();
    setLoading(false);
  }
});

repoInput.addEventListener('keydown', () => {
  if (!errorEl.hidden) errorEl.hidden = true;
});

repoInput.addEventListener('paste', () => {
  setTimeout(() => {
    const val = repoInput.value.trim();
    if (val && !isValidGitUrl(val) && !errorEl.hidden) {
      errorEl.hidden = true;
    }
  }, 0);
});

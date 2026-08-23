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

statusEl.textContent = 'Spinning up sandbox...';

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

  try {
    const res = await fetch('/api/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, instanceType }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Provisioning failed.');
      setLoading(false);
      return;
    }

    statusEl.textContent = 'Setting up your sandbox...';
    const params = new URLSearchParams({ repo });
    window.location.href = `/sandbox/${data.instanceId}?${params}`;
  } catch (err) {
    showError('Network error. Is the Worker running?');
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

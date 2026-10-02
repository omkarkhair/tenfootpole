const form = document.getElementById('provision-form');
const repoInput = document.getElementById('repo-input');
const capacityEl = document.getElementById('capacity');
const capacityMsg = document.getElementById('capacity-msg');
const deployBtn = document.getElementById('deploy-btn');
const slotsEl = document.getElementById('slots');
const pokeBtn = document.getElementById('poke-btn');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

// Sandboxes have no SSH egress, so only HTTPS endpoints are supported.
const GIT_URL_PATTERNS = [/^https:\/\/[a-zA-Z0-9.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/];

function isValidGitUrl(url) {
  return GIT_URL_PATTERNS.some((p) => p.test(url.trim()));
}

function setLoading(loading) {
  pokeBtn.disabled = loading;
  pokeBtn.classList.toggle('loading', loading);
  repoInput.disabled = loading;
  if (loading) {
    statusEl.hidden = false;
    errorEl.hidden = true;
    capacityEl.hidden = true;
  } else {
    statusEl.hidden = true;
  }
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  statusEl.hidden = true;
}

function showCapacity(data) {
  capacityMsg.textContent = data.error;
  if (data.deployUrl) deployBtn.href = data.deployUrl;
  capacityEl.hidden = false;
  errorEl.hidden = true;
  statusEl.hidden = true;
}

async function refreshSlots() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const { active, max } = await res.json();
    slotsEl.textContent = max
      ? `${active}/${max} sandboxes in use`
      : `${active} sandbox${active === 1 ? '' : 'es'} running`;
    slotsEl.classList.toggle('full', max > 0 && active >= max);
    slotsEl.hidden = false;
  } catch {}
}

refreshSlots();
setInterval(refreshSlots, 15000);

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
    showError('Invalid URL. Use an HTTPS endpoint (https://host/owner/repo).');
    return;
  }

  setLoading(true);

  try {
    const res = await fetch('/api/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });

    const data = await res.json();

    if (res.status === 503 && data.code === 'at_capacity') {
      showCapacity(data);
      setLoading(false);
      refreshSlots();
      return;
    }

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

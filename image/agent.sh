#!/bin/sh
# Start Pi on the (untrusted) repo. Pi must not load anything from the repo:
# no AGENTS.md / CLAUDE.md context files and no project-local Pi config or
# extensions. Our own instructions are appended explicitly instead.
cd /workspace/project 2>/dev/null || true
exec pi --no-context-files --no-approve \
  --append-system-prompt /root/.pi/agent/AGENTS.md \
  "Assess whether this repository is safe for a developer to clone, install, build and run on their own machine. Start by reading /workspace/.tfp/findings.json, confirm or dismiss each hit by reading the code, then give your verdict with file:line evidence."

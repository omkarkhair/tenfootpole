#!/bin/sh
# Runs once when the sandbox terminal is created: print the scan summary, then
# start Pi with an initial prompt to assess the repo. When Pi exits, the caller
# (`exec bash -l`) leaves the user in a normal shell.
F=/workspace/.tfp/findings.json
echo
echo "  tenfootpole: security review sandbox (no internet; repo is untrusted)"
if [ -f "$F" ]; then
  node -e 'const f=require(process.argv[1]);console.log("  Scan verdict: "+f.verdict+" ("+f.evidence.length+" evidence items) -> "+process.argv[1])' "$F" 2>/dev/null
else
  echo "  Scan results not available."
fi
echo "  Starting the security agent... (exit Pi to get a shell; use the sidebar to restart it)"
echo
sleep 1

# Not `exec`: when Pi exits, control returns to the caller's shell.
/opt/tfp/agent.sh

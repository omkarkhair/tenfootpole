#!/bin/sh
F=/workspace/.tfp/findings.json
echo
echo "  tenfootpole: security review sandbox (no internet; repo is untrusted)"
if [ -f "$F" ]; then
  node -e 'const f=require(process.argv[1]);console.log("  Scan verdict: "+f.verdict+" ("+f.evidence.length+" evidence items) -> "+process.argv[1])' "$F" 2>/dev/null
else
  echo "  Scan results not available yet."
fi
echo "  Type 'pi' to start the security agent."
echo

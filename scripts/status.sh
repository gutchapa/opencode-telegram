#!/usr/bin/env bash
# Plugin status report: npm downloads, GitHub stars/traffic, issues & discussions.
# Usage: npm run status   (or: bash scripts/status.sh)
set -u

PKG="gutchapa-opencode-telegram"
REPO="gutchapa/opencode-telegram"
API="https://api.github.com/repos/$REPO"
NPM="https://api.npmjs.org/downloads/point"

echo "== gutchapa-opencode-telegram — status =="
echo "date: $(date '+%Y-%m-%d %H:%M %Z')"
echo

echo "--- npm downloads ---"
for span in last-day last-week last-month; do
  out=$(curl -s --max-time 10 "$NPM/$span/$PKG")
  if echo "$out" | grep -q '"package"'; then
    echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"  $span: {d.get('downloads', '?')}\")"
  else
    echo "  $span: (not indexed yet — new package; retry in a few days)"
  fi
done

echo
echo "--- GitHub: $REPO ---"
stats=$(curl -s --max-time 10 "$API")
if echo "$stats" | grep -q '"stargazers_count"'; then
  echo "$stats" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"  stars: {d.get('stargazers_count',0)}  forks: {d.get('forks_count',0)}  watchers: {d.get('subscribers_count',0)}\")
print(f\"  open issues: {d.get('open_issues_count',0)}\")"
else
  echo "  (repo API unreachable or rate-limited)"
fi

for t in clones views; do
  out=$(curl -s --max-time 10 "$API/traffic/$t")
  if echo "$out" | grep -q '"count"'; then
    echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"  $t (14d): {d.get('count',0)} views/clones, {d.get('uniques',0)} unique\")"
  else
    echo "  $t (14d): 0 (no traffic yet, or unauthenticated limit)"
  fi
done

echo
echo "--- feedback ---"
issues=$(curl -s --max-time 10 "$API/issues?state=open" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(len(d) if isinstance(d,list) else '?')
except Exception:
    print('?')" 2>/dev/null)
echo "  open issues: ${issues:-0}"
disc=$(curl -s --max-time 10 -H "Accept: application/vnd.github+json" "$API/discussions" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(len(d) if isinstance(d,list) else '?')
except Exception:
    print('?')" 2>/dev/null)
echo "  discussions: ${disc:-0}"
echo
echo "Feedback comes via GitHub Issues / Discussions:"
echo "  https://github.com/$REPO/issues"
echo "  https://github.com/$REPO/discussions"

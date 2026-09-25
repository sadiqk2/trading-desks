#!/usr/bin/env bash
# One-shot publisher: create the GitHub repo, push, enable GitHub Pages, print the live URL.
#
#   GITHUB_TOKEN=ghp_xxx ./publish.sh
#
# Token needs 'repo' scope (classic) — or fine-grained: Administration(read/write),
# Contents(read/write), Pages(read/write).  Env overrides:
#   REPO_NAME=trading-desks   VISIBILITY=public   DESCRIPTION="…"
set -euo pipefail

TOKEN="${GITHUB_TOKEN:?Please set GITHUB_TOKEN (classic PAT with 'repo' scope)}"
API="https://api.github.com"
REPO_NAME="${REPO_NAME:-trading-desks}"
VISIBILITY="${VISIBILITY:-public}"
DESCRIPTION="${DESCRIPTION:-NIFTY Options Desk + NSE Pulse — self-contained market analytics terminals}"
AUTH="Authorization: Bearer ${TOKEN}"
ACCEPT="Accept: application/vnd.github+json"

cd "$(dirname "$0")"

echo "→ who am I?"
ME=$(curl -sf -H "$AUTH" -H "$ACCEPT" "$API/user" | jq -r .login)
NAME=$(curl -sf -H "$AUTH" -H "$ACCEPT" "$API/user" | jq -r '.name // .login')
echo "  authenticated as: ${ME} (${NAME})"

git config user.name "$NAME"
git config user.email "${ME}@users.noreply.github.com"
if ! git rev-parse HEAD >/dev/null 2>&1; then
  git init -b main
  git add -A && git commit -m "Trading Desks: NIFTY Options Desk + NSE Pulse"
fi
# make the single authored commit carry the GitHub identity
git commit --amend --reset-author --no-edit >/dev/null 2>&1 || true

# reuse the repo if it already exists (fine-grained PATs cannot create repos)
EXISTS=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" -H "$ACCEPT" "$API/repos/${ME}/${REPO_NAME}")
if [ "$EXISTS" = "200" ]; then
  echo "→ repo ${ME}/${REPO_NAME} already exists — reusing."
else
  echo "→ create repo ${ME}/${REPO_NAME} (${VISIBILITY})"
  CODE=$(curl -s -o /tmp/gh_repo.json -w "%{http_code}" -H "$AUTH" -H "$ACCEPT" -X POST "$API/user/repos" \
    -d "{\"name\":\"${REPO_NAME}\",\"description\":\"${DESCRIPTION}\",\"has_pages\":true,\"visibility\":\"${VISIBILITY}\"}")
  if [ "$CODE" = "201" ]; then
    echo "  created."
  elif [ "$CODE" = "422" ] && jq -e '.errors[]? | select(.code=="already_exists")' /tmp/gh_repo.json >/dev/null; then
    echo "  already exists — reusing."
  else
    echo "  repo create failed (HTTP ${CODE}):"; cat /tmp/gh_repo.json
    echo "  hint: fine-grained PAT needs 'Administration + Repository creation: write',"
    echo "        or create the empty repo in the web UI and re-run."
    exit 1
  fi
fi

echo "→ push main"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/${ME}/${REPO_NAME}.git"
git push -u origin main --force

echo "→ enable GitHub Pages (deploy from branch: main / root)"
CODE=$(curl -s -o /tmp/gh_pages.json -w "%{http_code}" -H "$AUTH" -H "$ACCEPT" -X POST "$API/repos/${ME}/${REPO_NAME}/pages" \
  -d '{"source":{"branch":"main","path":"/"}}')
if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then
  echo "  pages enabled."
elif [ "$CODE" = "409" ]; then
  curl -sf -H "$AUTH" -H "$ACCEPT" -X PUT "$API/repos/${ME}/${REPO_NAME}/pages" \
    -d '{"source":{"branch":"main","path":"/"}}' >/dev/null && echo "  pages config updated."
else
  echo "  pages enable returned HTTP ${CODE}:"; cat /tmp/gh_pages.json
  echo "  (enable manually: Settings → Pages → Deploy from a branch → main / root)"
fi

SITE="https://${ME}.github.io/${REPO_NAME}/"
echo "→ waiting for the site to go live (up to ~3 min)…"
for i in $(seq 1 30); do
  sleep 6
  ST=$(curl -s -H "$AUTH" -H "$ACCEPT" "$API/repos/${ME}/${REPO_NAME}/pages" | jq -r '.status // empty')
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$SITE" || true)
  echo "  [$i] build: ${ST:-pending} · site: HTTP ${HTTP}"
  if [ "$HTTP" = "200" ]; then
    echo
    echo "✅ LIVE: ${SITE}"
    echo "   hub:     ${SITE}"
    echo "   desk:    ${SITE}nifty-options-desk/"
    echo "   pulse:   ${SITE}nse-pulse/"
    exit 0
  fi
done
echo "⏳ build still running — check ${SITE} in a few minutes (repo: https://github.com/${ME}/${REPO_NAME})"

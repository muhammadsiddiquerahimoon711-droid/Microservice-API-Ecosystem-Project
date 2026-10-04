#!/usr/bin/env sh
# Runs every automated test and saves a summary to tests/TEST-RESULTS.txt
#   sh tests/run-all.sh
# Requires: Node 22+, Docker. (The e2e step starts the whole stack.)
cd "$(dirname "$0")/.." || exit 1
OUT=tests/TEST-RESULTS.txt
: > "$OUT"

section() { printf '\n===== %s =====\n' "$1" | tee -a "$OUT"; }
summary() { grep -E '^# (tests|pass|fail|skipped)' | tee -a "$OUT"; }

section "1/3 Worker unit tests"
(cd worker && npm install --silent && node --test "tests/*.test.js" 2>&1) | summary

section "2/3 Gateway tests (RBAC, validation, API with fakes)"
(cd gateway && npm install --silent && node --test "tests/*.test.js" 2>&1) | summary

section "3/3 End-to-end tests against the Docker stack"
docker compose up --build -d --wait >/dev/null 2>&1 || docker compose up --build -d
node --test tests/e2e.test.js 2>&1 | summary

printf '\nSaved to %s\n' "$OUT"

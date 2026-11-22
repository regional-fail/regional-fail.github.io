#!/usr/bin/env bash
# One logger run inside GitHub Actions:
#   1. restore live state from the `live` branch
#   2. poll SEPTA (and archive any finished day)
#   3. append new map traces to `traces-YYYY` branches
#   4. commit archive/timetable changes to main
#   5. force-push live state back to `live` as a single commit (no history growth)
# The order matters: archiving removes a day from the live state, so live is published LAST.
# If any earlier push fails, the script stops, live is untouched, and the next run re-archives the day.
# Needs: REPO_URL (authenticated https URL), run from the repo root with dependencies installed.
set -euo pipefail

: "${REPO_URL:?REPO_URL must be set}"
BRANCH="${GITHUB_REF_NAME:-main}"
BOT_NAME="${BOT_NAME:-regional-fail-bot}"
BOT_EMAIL="${BOT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/rf"
rm -rf "$WORK" && mkdir -p "$WORK"
commit() { git -c user.name="$BOT_NAME" -c user.email="$BOT_EMAIL" -c commit.gpgsign=false commit -q "$@"; }

# 1. Live state
rm -rf out/live
if git clone -q --depth 1 --branch live "$REPO_URL" "$WORK/live-in" 2>/dev/null; then
  mkdir -p out && cp -r "$WORK/live-in/live" out/
else
  echo "No live branch yet; starting fresh."
fi

# 2. Poll (+ archive). Traces from newly archived days land in $WORK/traces.
OUT_DIR=out DATA_DIR=data TRACES_DIR="$WORK/traces" node logger/poll.mjs

# 3. Traces (only after a day was archived).
if [ -d "$WORK/traces" ]; then
  for yeardir in "$WORK/traces"/*/; do
    year="$(basename "$yeardir")"
    branch="traces-$year"
    dest="$WORK/traces-$year"
    if ! git clone -q --depth 1 --branch "$branch" "$REPO_URL" "$dest" 2>/dev/null; then
      mkdir -p "$dest" && (cd "$dest" && git init -q -b "$branch")
    fi
    mkdir -p "$dest/$year" && cp "$yeardir"*.json.gz "$dest/$year/"
    (
      cd "$dest"
      git add -A
      git diff --cached --quiet || commit -m "traces: $(ls "$yeardir" | sed 's/\.json\.gz$//' | tr '\n' ' ')"
      git push -q "$REPO_URL" "$branch"
    )
  done
fi

# 4. Permanent archive + timetable cache on main.
git add data/archive data/gtfs 2>/dev/null || true
if ! git diff --cached --quiet; then
  days="$(git diff --cached --name-only -- data/archive | sed -n 's#data/archive/\([0-9]*\)/\([0-9]*\)/\([0-9]*\)\.json\.gz#\1-\2-\3#p' | tr '\n' ' ')"
  gtfs="$(git diff --cached --quiet -- data/gtfs || echo 'timetable update')"
  commit -m "data: ${days:+archive $days}${gtfs}"
  pushed=no
  for attempt in 1 2 3; do
    if git pull -q --rebase "$REPO_URL" "$BRANCH" && git push -q "$REPO_URL" "HEAD:$BRANCH"; then pushed=yes; break; fi
    echo "push to $BRANCH failed (attempt $attempt), retrying"; sleep 5
  done
  [ "$pushed" = yes ] || { echo "could not push archive to $BRANCH; leaving live state untouched"; exit 1; }
fi

# 5. Publish live state as a fresh single-commit branch.
mkdir -p "$WORK/live-out" && cp -r out/live "$WORK/live-out/"
(
  cd "$WORK/live-out"
  git init -q -b live
  git add -A
  commit -m "live state $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push -q -f "$REPO_URL" live
)
echo "published live state"

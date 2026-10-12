#!/usr/bin/env bash
#
# Stage the files the browser actually asks for into an output directory.
#
# This is a COPY, never a bundle. Every path stays exactly where it is:
# loadboard.js is served at /loadboard.js both before and after. That matters
# more than it looks -- site-version-watch.js HEADs that literal path to spot
# a deploy under an open tab, and a hashed filename would 404 it and silently
# switch off the protection that ended the 9,443-row rate-churn incident.
#
# It works by DELETION, not by listing what to keep. Getting an allowlist
# wrong takes a page off a live dispatch board; getting this wrong just
# publishes a file nobody reads. Fail in the direction that does not break
# the site.
#
# Usage: deploy/stage-site.sh [output-dir]   (default: _site)
set -euo pipefail

OUT="${1:-_site}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rm -rf "$OUT"
mkdir -p "$OUT"

# Copy the tree, minus the things that are never requested over HTTP.
tar -C "$SRC" -cf - \
  --exclude='./.git' \
  --exclude='./.github' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude="./${OUT#./}" \
  --exclude='./scripts' \
  --exclude='./sandbox' \
  --exclude='./supabase' \
  --exclude='./docs' \
  --exclude='./deploy' \
  --exclude='./Claude outputs' \
  --exclude='./back-ups' \
  --exclude='./imports' \
  --exclude='./public' \
  --exclude='./*.md' \
  --exclude='./*.py' \
  --exclude='./*.vba' \
  --exclude='./*.patch' \
  --exclude='./vite.config.js' \
  --exclude='./package.json' \
  --exclude='./package-lock.json' \
  --exclude='./.env.example' \
  --exclude='./vercel.json' \
  . | tar -C "$OUT" -xf -

# A page the site cannot serve is the failure that matters, so prove the
# entry points survived rather than trusting the exclude list.
for required in index.html loadboard.js loadboard.css login.html driver/index.html driver/sw.js; do
  [ -e "$OUT/$required" ] || { echo "stage-site: MISSING $required" >&2; exit 1; }
done

# And prove the internals did not.
for internal in CLAUDE.md supabase scripts sandbox; do
  [ -e "$OUT/$internal" ] && { echo "stage-site: $internal should not ship" >&2; exit 1; }
done

echo "stage-site: $(find "$OUT" -type f | wc -l) files staged into $OUT"

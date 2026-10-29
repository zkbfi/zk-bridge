#!/usr/bin/env bash
# Gate: every page that may be published holds nothing private.
# Scans tracked and untracked files (the docs site builds from the working tree) in the docs, the web documentation pages, the readmes, progress.txt and script/. The generic patterns match exact case. The private patterns ignore case.
# Prints file and line for each match and exits 1. The generic patterns below cover an email address, a home
# directory path, a RunPod endpoint identifier, key-shaped strings and a literal key in a valve.city address.
# Private names do not belong in this tracked file. Put them, one pattern per line, in the untracked file
# `.git/info/forbidden-patterns` (lines that start with # are comments). The gate fails closed: it exits 2 when that
# file is missing, unless DOCS_GATE_WITHOUT_PRIVATE_PATTERNS=1 says on purpose that this checkout has none (a CI run or
# a fresh clone), and it exits 2 when git grep fails, for example on a pattern that does not compile.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Planning notes in docs/superpowers describe these patterns, so they are not scanned.
scanned_paths=(docs explorer/web/docs/pages README.md 'explorer/*/README.md' progress.txt script ':!docs/superpowers' ':!script/check-docs-public.sh')

patterns=(
  # email address
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(com|net|org|io|xyz|city|dev|app|me)'
  # home directory path
  '/Users/[A-Za-z]'
  '/home/[A-Za-z]'
  # RunPod endpoint identifier before the proxy domain
  '[a-z0-9]{10,}\.api\.runpod\.ai'
  # key-shaped strings: valve.city key, RunPod key, GitHub token, secret key, cloud access key
  'vk_[A-Za-z0-9_-]{8,}'
  'rpa_[A-Za-z0-9]{8,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'AKIA[A-Z0-9]{12,}'
  'BEGIN [A-Z ]*PRIVATE KEY'
  # a literal key in a valve.city address (a placeholder starts with $ or <)
  'valve\.city/(rpc|beacon)/[A-Za-z0-9_-]{12,}'
  # a password manager reference (placeholders such as op://vault/... and op://<vault>/... are allowed)
  'op://[A-Za-z0-9]'
)

private_patterns=()
# --git-path finds the file in a worktree too, where .git is a file.
private_file="$(git rev-parse --git-path info/forbidden-patterns)"
if [ -f "$private_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -n "$line" ] && [ "${line:0:1}" != "#" ] && private_patterns+=("$line")
  done < "$private_file"
elif [ "${DOCS_GATE_WITHOUT_PRIVATE_PATTERNS:-}" != "1" ]; then
  echo "check-docs-public: $private_file is missing, so private names are not checked." >&2
  echo "Copy it from the machine that holds it, or set DOCS_GATE_WITHOUT_PRIVATE_PATTERNS=1 for a checkout without one." >&2
  exit 2
fi

status=0

# Prints the matching lines of one pattern. The first argument holds extra options for git grep. A password manager
# placeholder (op://vault/... or op://item/...) is taken out of a line before the pattern is tried again, so the
# placeholder is allowed while anything else on its line is still reported.
report_matches() {
  local option="$1"
  local pattern="$2"
  local matches code=0
  matches="$(git grep -n -I --untracked ${option} -E -e "$pattern" -- "${scanned_paths[@]}")" || code=$?
  if [ "$code" -gt 1 ]; then
    echo "check-docs-public: git grep failed (exit $code) on the pattern: $pattern" >&2
    exit 2
  fi
  [ -z "$matches" ] && return 0
  local kept="" line
  while IFS= read -r line; do
    # shellcheck disable=SC2086 # option is empty or one flag
    if printf '%s\n' "$line" | sed -E 's#op://(vault|item)/##g' | grep -q ${option} -E -e "$pattern"; then
      kept+="$line"$'\n'
    fi
  done <<< "$matches"
  [ -z "$kept" ] && return 0
  printf '%s' "$kept"
  status=1
}

for pattern in "${patterns[@]}"; do
  report_matches "" "$pattern"
done
for pattern in ${private_patterns[@]+"${private_patterns[@]}"}; do
  report_matches "-i" "$pattern"
done

if [ "$status" -ne 0 ]; then
  echo "check-docs-public: the lines above hold something private." >&2
fi
exit "$status"

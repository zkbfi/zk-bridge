# Checks of script/release/promote.sh, sourced by it and by its tests.
#
# A staging manifest is signed by the staging key only. Promotion signs with the production key, so nothing the staging
# manifest says may decide what production ships on its own:
#   - the commit it names must be a full SHA that is already on origin/main (production ships only what is on main),
#   - the production landing page built from that commit must trust exactly the keys of the operator's own
#     landing.config.json, and no staging key.
# shellcheck shell=bash

# Exits 1 unless $2 is a 40-character hex commit that is an ancestor of origin/main in the repository $1, after a fetch.
promote_check_commit() {
  local repository="$1" commit="$2"
  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "the staging release names the commit \"$commit\", not a full 40-character SHA: it cannot be promoted" >&2
    exit 1
  fi
  if ! git -C "$repository" fetch --quiet origin main; then
    echo "could not fetch origin/main to check the staging commit, so nothing is promoted" >&2
    exit 1
  fi
  if ! git -C "$repository" merge-base --is-ancestor "$commit" origin/main 2>/dev/null; then
    echo "the staging commit $commit is not on origin/main: merge it to main before promoting" >&2
    exit 1
  fi
}

# Exits 1 unless the landing page built in $1 embeds exactly the public keys of $2 (the operator's landing.config.json)
# and none of the keys of $3 (the staging configuration).
promote_check_landing_keys() {
  node -e '
const fs = require("fs");
const [site, productionConfig, stagingConfig] = process.argv.slice(1);
const main = fs.readFileSync(`${site}/main.js`, "utf8");
const match = /startLanding\((\{[\s\S]*\})\);\s*$/.exec(main);
if (!match) { console.error("the built landing page has no settings to check"); process.exit(1); }
const embedded = (JSON.parse(match[1]).publicKeys ?? []).map((key) => key.x).sort();
const expected = JSON.parse(fs.readFileSync(productionConfig, "utf8")).publicKeys.map((key) => key.x).sort();
const staging = new Set(JSON.parse(fs.readFileSync(stagingConfig, "utf8")).publicKeys.map((key) => key.x));
if (embedded.some((x) => staging.has(x))) { console.error("the production landing page would trust a staging key: nothing is promoted"); process.exit(1); }
if (JSON.stringify(embedded) !== JSON.stringify(expected)) {
  console.error("the production landing page built from the staging commit trusts other keys than landing.config.json: nothing is promoted");
  process.exit(1);
}
' "$1" "$2" "$3"
}

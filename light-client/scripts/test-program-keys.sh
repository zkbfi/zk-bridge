#!/usr/bin/env bash
# Tests the skip and force paths of program-keys.sh without Docker. Stub `docker` and `cargo` programs count their calls,
# and a copy of the scripts runs against a small fake light-client directory.
# Usage: scripts/test-program-keys.sh   (exit 0 when every case passes)
set -euo pipefail

real_script="$(cd "$(dirname "$0")" && pwd)/program-keys.sh"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

root="${work}/light-client"
bin="${work}/bin"
calls="${work}/calls.log"
mkdir -p "${root}/scripts" "${root}/guests/light-client/src" "${root}/guests/fork-observation/src" "${root}/crates/lc-core/src" "${root}/crates/lc-testkit/src" "${root}/crates/lc-core/tests" "${bin}"
cp "${real_script}" "${root}/scripts/program-keys.sh"
for guest in light-client fork-observation; do echo 'fn main() {}' > "${root}/guests/${guest}/src/main.rs"; done
echo 'pub fn f() {}' > "${root}/crates/lc-core/src/lib.rs"
echo 'pub fn t() {}' > "${root}/crates/lc-testkit/src/lib.rs"
echo 'fn t() {}' > "${root}/crates/lc-core/tests/t.rs"
for file in Cargo.toml Cargo.lock rust-toolchain.toml; do echo "# ${file}" > "${root}/${file}"; done

# The stubs: docker does nothing, cargo prove build writes a fixed ELF, cargo prove vkey prints a fixed key.
cat > "${bin}/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$*" >> "${calls}"
STUB
cat > "${bin}/cargo" <<STUB
#!/usr/bin/env bash
echo "cargo \$*" >> "${calls}"
if [ "\$2" = "build" ]; then
  while [ \$# -gt 0 ]; do [ "\$1" = "--output-directory" ] && out="\$2"; shift; done
  mkdir -p "\${out}" && echo "elf-bytes" > "\${out}/elf"
else
  echo "0x$(printf 'ab%.0s' $(seq 32))"
fi
STUB
chmod +x "${bin}/docker" "${bin}/cargo"
export PATH="${bin}:${PATH}"

script="${root}/scripts/program-keys.sh"
failures=0
builds() { grep -c '^cargo prove build' "${calls}" 2>/dev/null || true; }
expect() { # expect <name> <condition exit code> 
  if [ "$2" = "0" ]; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}
run() { "${script}" "$@" >"${work}/out.log" 2>&1; }

# 1. Without a recorded hash, the check builds. The keys file does not exist yet, so --write comes first.
: > "${calls}"
run --write; expect "write builds" "$([ "$(builds)" = 2 ] && echo 0 || echo 1)"
expect "write records the hash" "$([ -f "${root}/program-keys.source-hash" ] && echo 0 || echo 1)"
[ "$(cat "${root}/program-keys.source-hash")" = "$("${script}" --print-source-hash)" ] && recorded=0 || recorded=1
expect "recorded hash equals the current hash" "${recorded}"

# 2. Unchanged inputs: the check skips the build.
: > "${calls}"
run; expect "unchanged inputs skip the build" "$([ "$(builds)" = 0 ] && grep -q 'skipping the Docker build' "${work}/out.log" && echo 0 || echo 1)"
expect "skip makes no docker call" "$([ ! -s "${calls}" ] && echo 0 || echo 1)"

# 3. --force builds even when the hash matches.
: > "${calls}"
run --force; expect "--force builds" "$([ "$(builds)" = 2 ] && echo 0 || echo 1)"

# 4. A change in a guest source, in lc-core, or the image digest changes the hash; a test or testkit source does not.
before="$("${script}" --print-source-hash)"
echo '// change' >> "${root}/crates/lc-core/tests/t.rs"; echo '// change' >> "${root}/crates/lc-testkit/src/lib.rs"
expect "test and testkit changes keep the hash" "$([ "$("${script}" --print-source-hash)" = "${before}" ] && echo 0 || echo 1)"
echo '// change' >> "${root}/guests/light-client/src/main.rs"
expect "guest change moves the hash" "$([ "$("${script}" --print-source-hash)" != "${before}" ] && echo 0 || echo 1)"
: > "${calls}"
run; expect "changed guest builds" "$([ "$(builds)" = 2 ] && echo 0 || echo 1)"
expect "matching full check records the hash" "$([ "$(cat "${root}/program-keys.source-hash")" = "$("${script}" --print-source-hash)" ] && echo 0 || echo 1)"

# 5. With ELF_OUTPUT_DIR and no ELFs there, the check builds even when the hash matches; with the ELFs there it skips.
elf_dir="${work}/elf"
: > "${calls}"
ELF_OUTPUT_DIR="${elf_dir}" run; expect "missing ELFs force a build" "$([ "$(builds)" = 2 ] && [ -f "${elf_dir}/light-client.elf" ] && echo 0 || echo 1)"
: > "${calls}"
ELF_OUTPUT_DIR="${elf_dir}" run; expect "present ELFs allow the skip" "$([ "$(builds)" = 0 ] && echo 0 || echo 1)"

[ "${failures}" = 0 ] && echo "all cases passed" || { echo "${failures} case(s) failed"; exit 1; }

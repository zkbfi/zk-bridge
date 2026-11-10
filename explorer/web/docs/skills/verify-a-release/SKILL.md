---
name: verify-a-release
description: Checks that a zkb.fi release is the one the maintainers signed, by verifying the Ed25519 signature on version.json, reading the content address (CID) and SHA-256 hashes from it, and opening the dapp at https://<cid>.ipfs.zkb.fi/. Use before trusting a dapp build or running a downloaded terminal program.
kind: skill
title: Verify a release
summary: Verify the signed version.json, the CID and the SHA-256 values, then open the release by its CID.
audience: [user]
chains: all
verified_release: 0.1.2-next.14
---

# Verify a release

## When to use

- The person wants to know that the dapp they use, or a program they downloaded (the terminal dashboard), is the release the maintainers signed.
- The person asks which version is live on `zkb.fi` (stable channel) or `next.zkb.fi` (staging channel), or wants the content address of it.

## Preconditions

- A browser, for the landing page check. For the manual check: Node 22 or newer (Ed25519 verification through `crypto.subtle`), `curl`, and `shasum -a 256` or `sha256sum`.
- The public key to check against. The two channels are signed with different release keys: the stable channel (`zkb.fi`) uses the key in `explorer/landing/landing.config.json`, the staging channel (`next.zkb.fi`) the key in `explorer/landing/landing.next.config.json`, both in the source repository. Take the key from the repository, not from the host you are checking: a key served by the same host proves nothing.
- Staging (`next.zkb.fi`) shows the notice "next · staging. It reaches zkb.fi only when promoted." Stable is the one that counts for real funds.

## Steps

### 1. Let the landing page check it

1. Open `https://zkb.fi` (stable) or `https://next.zkb.fi` (staging).
2. The page fetches `version.json` and `version.json.sig` itself, with the key built into the page, and shows one of two results:
   - "The signature on this release list is valid." Then it lists the dapp release: version, commit, publish time, **Content address**, **Archive SHA-256**, and gateway links (such as `https://<cid>.ipfs.zkb.fi/`). It also lists **Downloads** with a SHA-256 for each file.
   - "Warning: this release list failed its check. Do not use anything from this page." followed by the reason. Stop and do not use the release.

### 2. Check it yourself

```sh
mkdir release-check && cd release-check
curl -s https://next.zkb.fi/version.json -o version.json
curl -s https://next.zkb.fi/version.json.sig -o version.json.sig
node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1])).publicKeys))' /path/to/zk-bridge/explorer/landing/landing.next.config.json > public-keys.json
```

Save this as `verify.mjs`:

```js
// usage: node verify.mjs version.json version.json.sig public-keys.json
import { readFileSync } from "node:fs";
const [manifestPath, signaturePath, keysPath] = process.argv.slice(2);
const manifestBytes = readFileSync(manifestPath);   // the exact bytes that were signed
const signature = readFileSync(signaturePath);      // 64 bytes
const keys = JSON.parse(readFileSync(keysPath, "utf8"));
let valid = false;
for (const jwk of keys) {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  if (await crypto.subtle.verify({ name: "Ed25519" }, key, signature, manifestBytes)) valid = true;
}
console.log(valid ? "signature valid" : "SIGNATURE INVALID");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
console.log("channels", manifest.channels, "sequence", manifest.sequence);
for (const release of manifest.releases) console.log(release.name, release.version, release.cid, release.archiveSha256);
process.exitCode = valid ? 0 : 1;
```

```sh
node verify.mjs version.json version.json.sig public-keys.json
```

Rules the check follows (they match `explorer/landing/src/manifest.ts`):

- The signature is Ed25519 over the raw bytes of `version.json` exactly as served. `version.json` is written in canonical form (keys sorted, no spaces, UTF-8), so do not reformat it before checking.
- The signature file is 64 bytes.
- `sequence` only goes up. The landing page remembers the highest one it has seen and refuses a lower one ("This list is older (number <n>) than one this browser saw before (number <m>)"), which catches a replay of an old list.
- `schema` is 1. Each release has `name`, `version`, `commit`, `cid`, `archiveSha256` (64 lowercase hex) and `publishedAt`. Each download has `name`, `platform`, `file` and `sha256` (64 lowercase hex).

### 3. Open the release by its content address

1. Take the dapp's `cid` from `version.json` (a `bafy...` string).
2. Open `https://<cid>.ipfs.zkb.fi/`. The dapp loads from that address, and the same bytes always have the same CID. Alternatives from the page settings: `https://gateway.zkb.fi/ipfs/<cid>` and `https://<cid>.ipfs.inbrowser.link/`. The path-style gateway shares its browser origin (and so its stored settings) with other sites on it, which the subdomain-style address does not.
3. The dapp's docs open inside it at `#/docs`.

### 4. Check a download

1. Download the program from the address the landing page shows (`https://github.com/zkbfi/releases/releases/download/v<version>/<file>`, with the dapp release's version).
2. Hash it and compare with the `sha256` of that file in the verified list:

   ```sh
   shasum -a 256 <file>        # or: sha256sum <file>
   ```

   Compare the whole 64 characters. If they differ, delete the file.

## Expected result

- `node verify.mjs ...` prints `signature valid` and exits 0, then the version, `cid` and `archiveSha256` of each release.
- On 2026-11-06 the staging channel read: channel `next` at `0.1.2-next.14`, sequence 14, releases `dapp` and `landing` only (the docs are inside the dapp since that release). The stable channel read `0.1.1`, with `dapp`, `docs` and `landing` (an older list that still names a docs site is still valid).
- `https://<cid>.ipfs.zkb.fi/` answers with HTTP 200 and the dapp.
- The SHA-256 of each download equals its value in the signed list.
- A wrong key gives `SIGNATURE INVALID`: the staging signature does not verify with the stable key, and the other way round.

## If it fails

- **`SIGNATURE INVALID` or the landing page warning.** Check first that you used the key of the right channel and the unmodified files (do not save through a tool that changes line endings). If it still fails, do not use the release and tell the maintainers.
- **"This list is older ... than one this browser saw before".** The host served an old signed list. Do not use it. Clearing the browser's stored sequence defeats the protection, so do not do it to make the warning go away.
- **"This browser cannot remember the last release number, so a replay of an old list would not be caught here."** Private or blocked storage. The check still runs; only the replay protection is off.
- **The gateway does not load the CID.** Try the other gateway addresses. The content is the same under any gateway. A CID that no gateway has is not served.
- **A download's hash differs.** Delete it and download again from the address on the landing page. If it still differs, do not run it.
- **`archiveSha256` cannot be checked from a browser.** It is the hash of the release's archive (`archives/<name>.car`) in the maintainers' release directory, checked by `node explorer/release/src/cli.ts verify <release-directory> --public-keys <file>` (signature, canonical form, each archive's hash and root CID, each download, `SHA256SUMS`). The release directory is not served publicly, so the public check is the signature, the CID and the download hashes.

<!-- TODO: the repository address to take the release keys from is not named here because no public repository URL was found in the files I was allowed to read; add it. The key list is served at https://next.zkb.fi/public-keys.json (stable: https://zkb.fi/public-keys.json), next to version.json; it answered 404 until the release that added it. -->
<!-- TODO: confirm with the owner that the release download address (the downloadBaseUrl of landing.config.json) is public and permanent. -->

## References

- `safety`: what you trust.
- `getting-started`: first transfer.
- `running-a-bot`: the programs a release carries.

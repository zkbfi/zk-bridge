# Vendored Optimism libraries

These files come from the Optimism monorepo, directory `packages/contracts-bedrock/src/libraries/`.

| Item | Value |
|---|---|
| Repository | https://github.com/ethereum-optimism/optimism |
| Release tag | `op-contracts/v8.0.0` (annotated tag object `bb718d1943d669407f4adc1855851c4f62ad9bf5`) |
| Commit | `f45a5ccfebcdf6da3f5b09cbc512667c063730b7` |
| Commit date | 2026-08-13 (more than 28 days before 2026-10-20) |
| Licence | MIT (`LICENSE` in this directory, copied from the repository root) |
| Fetched | 2026-10-20 with a sparse checkout of the tag |

## Files

- `Bytes.sol`
- `rlp/RLPReader.sol`
- `rlp/RLPErrors.sol`
- `trie/MerkleTrie.sol`

## The only change

Import paths changed from `src/libraries/...` to relative paths, so the files compile without a remapping.
Nothing else differs from the tag. Run `diff` against a checkout of the commit to confirm.
The scan test `Bytecode.t.sol` shows that the compiled vault holds no `MCOPY` and no `TSTORE` opcode, with these libraries linked in.

## SHA-256 of the files as vendored

```
235a1dcaf00fb7eeb2033033fdca135790c7415054aeb8303e5e070baca6e879  Bytes.sol
c775036bad8a0e00beeeae9fd20c733dcfdc2ddc57464d70299cb5c148aeec60  rlp/RLPErrors.sol
9844563f51326944ea57e2115da0de83524719f8438ec3b81155d897bc5ca3eb  rlp/RLPReader.sol
5608d2f2397e87d93cee67dab6d9fc80b6354eeee806a94e7da17c21e29b5249  trie/MerkleTrie.sol
```

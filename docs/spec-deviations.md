# Specification deviations

This file lists every change between `spec/Smart contracts/*.sol` and the copies in `src/`.

## Source files

| Specification file | Copy | Change |
|---|---|---|
| `spec/Smart contracts/LightClientSync.sol` | `src/LightClientSync.sol` | Line endings only |
| `spec/Smart contracts/ZKBridgeVault.sol` | `src/ZKBridgeVault.sol` | Line endings only |

### Line endings

- Before: the specification files use CRLF line endings.
- After: the copies use LF line endings (`tr -d '\r'`).
- Why: LF is the repository norm, and Solidity treats both the same. No other byte changed.

### Compilation changes

None. Both files compile as delivered with solc 0.8.28, evm version cancun, optimizer on (200 runs), against OpenZeppelin Contracts v5.7.0. Their `pragma solidity ^0.8.20;` accepts that compiler. The imports `@openzeppelin/contracts/...` resolve through `remappings.txt`.

`forge build` prints two `erc20-unchecked-transfer` lint warnings for `ZKBridgeVault.sol` lines 74 and 106. They match hole H-13 and were left unchanged on purpose.

## Dependencies

- `lib/forge-std`: installed with `forge install` as a git submodule.
- `lib/openzeppelin-contracts`: tag `v5.7.0`, cloned shallow, with its `.git` directory removed. It is vendored as plain files, not a submodule, because `forge install` could not resolve the tag in this environment.

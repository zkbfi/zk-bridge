# Build contract for the red-team implementation

This document fixes the names, paths, and interfaces that every part of the build shares. Read `docs/red-team.md` first. It lists the holes (`H-01` … `H-20`) that the tests try to prove.

## Ground rule

The tests attack the specification. They do not fix it. A red-team test **passes when the attack succeeds**. Name each test after its hole, for example `test_H01_committeeHijackThroughUnsignedNextRoot`. Every test also carries a comment that states what the specification claimed and what the test shows.

Each hole test must also prove that it can fail. Add a control assertion that shows the attack depends on the hole: for example, the honest path still works, or the attack fails when the precondition is absent.

## Repository layout and ownership

| Path | Owner | Contents |
|---|---|---|
| `spec/` | nobody — read only | The original specification. Never edit it. |
| `foundry.toml`, `remappings.txt`, `lib/`, `src/`, `test/` | contracts agent | Foundry project at the repository root |
| `docs/spec-deviations.md` | contracts agent | Every change needed to compile the specification's Solidity |
| `harness/` | harness agent | Two-Anvil end-to-end attacks in TypeScript |
| `checks/` | checks agent | Static evidence for the Rust, frontend, and deploy-script holes |

Do not write outside the paths you own.

## Solidity

- Compiler: `0.8.24` or later, `evm_version = "cancun"`. OpenZeppelin Contracts v5 (`@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`), forge-std.
- `src/LightClientSync.sol` and `src/ZKBridgeVault.sol` are **verbatim copies** of `spec/Smart contracts/*.sol`. Change them only when they fail to compile, and record each change in `docs/spec-deviations.md`.

### Test doubles in `src/mocks/`

| Contract | Interface and behavior |
|---|---|
| `MockSP1Verifier` | `constructor(address proverOracle)`. Implements the specification's interface `verify(bytes32 programVKey, bytes32 publicInputsHash, bytes calldata proof) external view returns (bool)`. Returns `true` only when `proof` is a 65-byte ECDSA signature by `proverOracle` over the raw digest `keccak256(abi.encodePacked(programVKey, publicInputsHash))`, with no Ethereum message prefix. Returns `false` otherwise and never reverts. This models a sound proof system: a proof exists only when the reference prover agrees that the statement is true. |
| `RealShapeSP1Verifier` | Has only the real SP1 gateway shape: `verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view`. It reverts on an invalid proof and returns nothing. Used for H-11. |
| `MockERC20` | OpenZeppelin ERC-20 with `constructor(string name, string symbol)` and a public `mint(address to, uint256 amount)`. |
| `FeeOnTransferToken` | ERC-20 that burns 1% of every transfer and `transferFrom`. Public `mint`. |
| `ReturnsFalseToken` | ERC-20 whose `transfer` returns `false` without moving tokens. `transferFrom` works normally. Public `mint`. |
| `NoReturnToken` | USDT-shaped token: `transfer` and `transferFrom` return nothing. Public `mint`. |
| `FakeDepositEmitter` | `fakeDeposit(address token, address recipient, uint256 amount, bytes32 nonce, uint64 targetChainId)` emits `DepositInitiated(token, msg.sender, recipient, amount, nonce, targetChainId)` with the exact event signature of `ZKBridgeVault`, and moves no tokens. |

Event signature (topic 0):
`DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 nonce, uint64 targetChainId)`

### `BridgeInputs` encoding

`publicInputsBytes = abi.encode(BridgeInputs)`, where the tuple is
`(uint64 sourceChainId, uint64 targetChainId, address tokenAddress, address recipient, uint256 amount, bytes32 depositNonce, bytes32 confirmedBlockRoot)`.

## Committee model (the specification's light client)

- 512 ECDSA keys. Derive key `i` as `keccak256(abi.encodePacked("committee", chainLabel, uint256(i)))`. `chainLabel` is a string such as `"chainA"`.
- Leaf: `keccak256(abi.encodePacked(address))`. Tree: OpenZeppelin `MerkleProof` sorted-pair hashing (`commutativeKeccak256`). Pad to 512 leaves, so proofs are 9 hashes deep.
- Signed digest: `signingRoot = keccak256(abi.encodePacked(bytes32 attestedHeader, uint32 period))`. Sign the raw digest, with no message prefix.
- Submit signatures sorted by ascending signer address. Submit at least 342.

## Two-Anvil topology

| Role | Chain id | Port | Command |
|---|---|---|---|
| Chain A, the Ethereum role | 1 | 18545 | `anvil --port 18545 --chain-id 1 --hardfork prague` |
| Chain B, the PulseChain role | 369 | 18546 | `anvil --port 18546 --chain-id 369 --hardfork prague` |

Both use Anvil's default mnemonic. The deployer (account 0) deploys `MockERC20` as its first transaction on each chain, so the token lives at the **same address** on both chains. This copies PulseChain's fork of Ethereum's state (H-03).

Correct wiring (not the inverted wiring in `deploy.sh`, see H-06):

- The vault on chain B uses a `LightClientSync` on chain B that tracks **chain A's** committee.
- The vault on chain A uses a `LightClientSync` on chain A that tracks **chain B's** committee.

## Reference prover (models the circuit that the specification describes)

The prover splits into two parts, like an SP1 host and guest.

- **Host** (`fetchWitness`): reads chain data over RPC and returns a witness of `{ headerRlp, receipts (consensus-encoded, in order), txIndex, logIndex }`. Prefer `debug_getRawHeader` and `debug_getRawReceipts` if Anvil supports them. Otherwise, rebuild them and check that `keccak256(headerRlp) == block.hash`.
- **Guest** (`proveDeposit(witness, sourceChainId)`): uses no RPC. It
  1. computes `confirmedBlockRoot = keccak256(headerRlp)`;
  2. reads `receiptsRoot` from field 5 of the decoded header;
  3. rebuilds the receipts trie and requires that its root equals `receiptsRoot`;
  4. finds the `DepositInitiated` log at `logIndex` by **topic 0 only**, because the specification gives the circuit no way to pin the emitter (H-02);
  5. builds `BridgeInputs`, encodes `publicInputsBytes`, and signs the proof with the oracle key.

The prover oracle key is Anvil account 9's private key. No attacker code may use it directly. Attacks must go through `proveDeposit`.

# Multicall3

`Multicall3.sol` is the canonical Multicall3 contract of `mds1/multicall`, source file `src/Multicall3.sol`, at commit
`ebd8b64457454fc10037b3a3ea858f9c08dad4d3`. The licence is MIT (`LICENSE`).

One change only: the pragma is `^0.8.12` instead of `0.8.12`, so it compiles with the compiler of this repository.

The contract has the same address on most chains: `0xcA11bde05977b3631167028862bE2a173976CA11`. The tests and the
integration stack of the bots deploy their own copy. The bots batch deliveries through `aggregate3`.

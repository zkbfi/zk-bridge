# Testnet faucet: gas links and an open-mint test token, on a docs page

Date: 2026-11-20. Status: approved for implementation.

## The owner's words

- "on one of the docs or explore pages, for the testnet bridge, we should provide a faucet that allows users to get gas on pulsechain or on sepolia (by linking them to https://sepolia-faucet.pk910.de/) or just allow them to mint an erc20 on either side"
- Asked how testers get test ERC-20s, the owner chose "New open-mint token" (a new test token on each side that anyone can mint, capped per call) over a faucet contract for tUSD/tTKN.
- On placement: "explore or docs makes sense to me. which one do you think? maybe just docs?" — docs (see below).
- "maybe we can also, on the bridge page, help users to mint tokens in the token selector or elsewhere in the ui. wat do you think" — yes, in context only (decision 3).

## Facts checked 2026-11-20

- `https://sepolia-faucet.pk910.de/` answers 200 ("Sepolia PoW Faucet"); `https://faucet.v4.testnet.pulsechain.com/` answers
  200 ("PLS Testnet Faucet").
- tUSD and tTKN (`src/testnet/TestToken.sol`) have one minter fixed at deployment, on purpose: an unbounded public mint
  lets anyone print an amount near 2^256 and send it through the mediator. They stay as they are.
- `TokenMediator.relayTokens` takes any ERC-20 (a native token registers on its first relay), so a new token bridges
  with no registration step. The flow limiter still applies.

## Decision 1: a new open-mint test token on each testnet

- `src/testnet/FaucetToken.sol`: an ERC-20 for the testnets only. Name `zkb Faucet Token`, symbol `tFAU`, 18 decimals.
  `mint(uint256 amount)` mints to the caller and `mint(address to, uint256 amount)` to any address; each call is capped at
  `MAX_MINT = 1_000e18` and reverts above it (custom error naming the cap). No owner, no other privilege.
- The cap per call answers the reason tUSD has one minter: reaching an amount near 2^256 at 1,000 tokens (10^21 base units, about 2^70) a call needs
  about 2^186 transactions. The NatSpec says so, and says the token has no value and exists only on testnets.
- Deployed on Sepolia (11155111) and PulseChain testnet v4 (943) by a Foundry script under `script/testnet/`, recorded in
  `deploy/deployments/sepolia-pls943.json` (with its source commit), verified like the other contracts
  (`deploy/contracts-page/verify.mjs`), and listed on the generated deployed-contracts page.
- Tests: mint to self and to another address, the cap (at, above), many calls add up, events, decimals; bridging is
  covered by the mediator's existing tests for any ERC-20 (add one end-to-end test only if a gap shows).

## Decision 2: a docs page, "Get testnet tokens"

- Docs is where a tester learns to try the bridge, and gas is the first step; Explore shows what happened on chain.
- The page (in `explorer/web/docs/pages/`, near Getting started, linked from it):
  1. Gas: Sepolia ETH from `https://sepolia-faucet.pk910.de/` (a proof-of-work faucet: it mines in the browser tab), and
     testnet PLS from `https://faucet.v4.testnet.pulsechain.com/`. Links open in a new tab.
  2. Test tokens: a Mint button for each chain that mints 1,000 tFAU to the connected wallet (switching the wallet's
     chain first), with the token address and an "add to wallet" action; then how to bridge it.
- The docs markdown gets one custom block for the button (for example a fenced ```` ```faucet ```` block with the chain),
  rendered by the docs site with the app's wallet hooks and the confirm dialog that only sends calls it can decode
  (add the FaucetToken ABI to `confirmableAbis`). Without a wallet the block shows the addresses and a connect button.
- The page and the block appear only in testnet builds (the deployment pair is a testnet pair); a mainnet build has no
  faucet page.
- tFAU is added to the token list of the testnet pair so it shows in the bridge's token picker.

## Decision 3: help in the bridge screen, where a tester gets stuck (testnet builds only)

- Token picker: the tFAU row carries a small "Mint 1,000" action (tUSD and tTKN show none: their minter is fixed).
- Under the amount, when the selected token is tFAU and the balance is 0: "You have 0 tFAU · Mint 1,000".
- When the wallet has no native coin on the source chain: "You need Sepolia ETH (or testnet PLS) to send · Get some",
  linking the matching gas faucet (checked before the mint, which needs gas too).
- Each links the docs page ("How testnet tokens work"). The mint goes through the confirm dialog like every other call.
- Mainnet builds show none of it. UI rules apply: menus not `<select>`, the existing pill and row styles, copy that says
  what happens.

## Checks

- `forge test` for the token; the deploy script runs on a local Anvil fork first; then the testnet deploy (needs the
  deployer key from 1Password and gas on both chains).
- Docs and bridge screen: the page test and the class test pass; the picker action, the zero-balance and no-gas notes appear only on testnet and only in their state; the block renders without a wallet; a mainnet build has no faucet page.
- Live: mint on each chain from the docs page, bridge 10 tFAU each way, see the bridged copy arrive.

---
title: "Safety"
summary: "Know exactly what you trust when you bridge, what the contracts cannot do, and how the app protects you before you sign."
audience: [user, operator]
chains: all
verified_release: 0.1.0
---

# Safety

Know exactly what you trust when you bridge, what the contracts cannot do, and how the app protects you before you sign.

## Audit status

No independent audit of the bridge has been completed as of this writing, including its fork protections. Send only what you can afford to lose.

## What you trust

You trust three things.

### The sync committee of the source chain

A light client checks the signatures of the sync committee of the source chain. You trust that at least two thirds of the committee are honest. A forged finalized header would let an attacker forge a message.

Sync committee signatures carry no slashing penalty. On PulseChain, a small number of staking operators hold most of the 512 committee seats, so the number of independent signers is far smaller than 512.

### The SP1 proof system and its verifier

The SP1 proof system proves programs in zero-knowledge. The bridge uses a verifier contract for it. A soundness bug in the pinned release would let anyone prove a false update.

The deploy script pins the code hash of the verifier. The program key is fixed at deployment.

### The deployment checkpoint

Each light client starts from one checkpoint. This is a trusted header that the deployer chooses. Anyone can compare it with public beacon data. Every later update starts from the stored state.

## What the contracts do not have

The contracts have no administrator. They have no upgrade keys, no pause and no timelock. The code is immutable after deployment.

The mediator charges no fee. Nobody can take a fee from it or move escrowed tokens. The only fee is the one you choose for delivery, paid through the delivery router; the page Fees explained covers it.

The bridge uses no validators. A deliverer holds no trusted role: anyone can deliver a transfer, and the contracts check everything it sends. The delivery router has no list of allowed deliverers. It pays every fee to one reward address that it fixes at deployment, so a copied delivery gains the copier nothing.

## The deposit gate

A gate contract on each chain can close the route for new sends after a fork that the route cannot follow.

The gate protects against forks. A fork changes the rules of the source chain. A proof program that does not know the new rules cannot deliver sends from the fork. Tokens sent into such a route would stay locked.

The gate admits every send until it is sealed. A send carries no proof and pays the same small cost every time: the gate reads one value.

Anyone can seal a gate with proof that the state has a shape outside the allowed set. On Ethereum the proof is the fork version and its position in the beacon state, checked against a beacon block root that the chain itself keeps. On PulseChain, which keeps no beacon block roots, the proof comes from the fork registry: a zero-knowledge proof that the sync committee signed under the new version, with the shape of the new state. A new fork name alone does not seal the gate, because the gate keeps no list of fork names; any version passes when its state has a shape that the proof program can read. The zkb.fi backend checks each gate once per epoch and sends the seal as soon as one would succeed. A sealed gate refuses all later sends. Withdrawals of delivered messages still work.

Between the start of such a fork and the seal, a send still passes the gate and would stay locked. The app pauses sends 12 hours before every scheduled fork, so only a send made outside the app can land there.

The gates of the testnet run (deployed 2026-10-26) work the older way: on Ethereum the first sender in each epoch confirms the shape with evidence before sending; on PulseChain the gate runs in a detection mode and probes for the beacon roots contract and for new opcodes. The app handles both and shows the mode of each gate on Explore.

## Fork handling in plain words

A fork can break a route. The bridge does not hide this.

- The gate stops new sends into a route that cannot follow the fork.
- Sends made shortly before a fork can stay locked, and the bridge has no way to refund them. Avoid sending large amounts around a known fork.
- After a breaking fork, the operators deploy a new route beside the old one. The old route pays what it can still prove.
- The app reads the fork schedule of the source chain from its beacon node. From 12 hours (and at least three epochs) before every scheduled fork, the Bridge button is disabled and says when the pause started and what ends it. Sends resume once the light client on the other chain has a finalized head past the first slot of the fork. Before the pause, the page counts down to it, such as "Sends pause in 1h 59m".
- When the beacon node of the source chain cannot be reached, the app uses the last fork schedule it saved in this browser, or the one that came with this release, whichever is newer, and says which one under the button. When neither is at most 7 days old, the Bridge button is disabled until a beacon node answers; check the beacon endpoint in Settings.
- A direct contract call in the paused window is not refused by any contract and can still strand funds.

## The deposit lock

Each bridge starts locked. A send on a locked bridge reverts with `DepositsNotOpen`. The bridge opens only after its light client holds a head that proves the other side is ready. Do not send before the operators announce that both bridges are open.

## No refunds

A delivery that succeeds is final. A delivery that fails reverts and can be tried again. The bridge has no refund function. A refund without a proof of cancellation would let one send be paid twice.

## What the app does to keep you safe

- It shows every transaction in full before your wallet asks you to sign: the chain, the contract, the function, the arguments, the value and the gas.
- The review before signing shows the full destination address, the relay router, the fee and its parts, and warns when the router is not the default delivery router.
- The Bridge button warns when the fee may be too low to get delivered, when the tip is a high share of the amount, and when a token is bridged for the first time or already came over the Omnibridge. It blocks a fee above your hard fee cap.
- A link can fill in the direction, the token and the amount. Anything else a link fills in, such as the destination, the fee settings or the router, is named in a warning on the screen and again in the review.
- The destination is locked to your connected wallet unless you unlock it, and a typed address is checked before you can send.
- It never holds your keys. Your wallet signs.
- It refuses settings that hold keys. A value that looks like a key, a token or a recovery phrase stops the page, and its messages never repeat a secret.

## Shared origin on IPFS gateways

A path-style gateway has addresses like `https://gateway.example/ipfs/<content address>/`. Every site on that gateway shares one browser origin. Another site there could read or change what this app keeps in its local storage. It could point you at a false indexer or node, and then you would see false chain state.

On such a gateway the app keeps your settings in memory for that visit only. It writes nothing to local storage, and Settings tells you so. Your settings are gone when you close the page.

A subdomain-style gateway, such as `https://<content address>.ipfs.<gateway host>/`, gives each release its own origin. Prefer it. The release page lists those links first.

On any address, the app never writes a URL that looks like it holds a key. It uses that URL until you close the page.

## What you can do

- Start with a small transfer, above all for a token bridged for the first time.
- Read the review, and each transaction, before you sign.
- Follow your transfer on the Activity screen.
- Read the page Fees explained before you change the fee settings.

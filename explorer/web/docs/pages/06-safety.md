# Safety

This page tells you plainly what you trust when you use the bridge. It also lists what the contracts cannot do and how the web interface protects you.

## Audit status

No independent audit of the bridge has been completed as of this writing. The repository marks the hardened code as not audited. It also states that nothing is deployed.

Several fork protections are built but not audited. Do not put funds in the bridge that you cannot afford to lose.

## What you trust

You trust three things.

### The sync committee of the source chain

A light client checks the signatures of the sync committee of the source chain. You trust that at least two thirds of the committee are honest. A forged finalized header would let an attacker forge a message.

Sync committee signatures carry no slashing penalty. On PulseChain, the repository measured on 2026-10-21 that about 18 withdrawal credentials hold 342 of 512 committee seats. One staking service can use many credentials. The number of independent parties is probably smaller.

### The SP1 proof system and its verifier

The SP1 proof system proves programs in zero-knowledge. The bridge uses a verifier contract for it. A soundness bug in the pinned release would let anyone prove a false update.

The deploy script pins the code hash of the verifier. The program key is fixed at deployment.

### The deployment checkpoint

Each light client starts from one checkpoint. This is a trusted header that the deployer chooses. Anyone can compare it with public beacon data. Every later update starts from the stored state.

## What the contracts do not have

The contracts have no administrator. They have no upgrade keys, no pause and no timelock. The code is immutable after deployment.

The fee has no authority. The schedule is fixed, and the fee recipient cannot change. No person can raise the fee or move escrowed tokens.

The bridge uses no validators. A runner or a deliverer holds no trusted role for the transfer: anyone can deliver it, and the contracts check everything that they send. The delivery router names one runner to collect tips. That role decides who gets the tip. It never decides who can deliver.

## The deposit gate

The bridge refuses to take a send that it cannot deliver. A gate contract on each chain does this check.

The gate protects against forks. A fork changes the rules of the source chain. A proof program that does not know the new rules cannot deliver sends from the fork. Tokens sent into such a route would stay locked.

On Ethereum, the gate checks the fork version of the current epoch. The first sender in each epoch confirms the version with evidence. Later senders in the same epoch just send. A send fails when nobody confirmed the epoch.

On PulseChain, the chain has no beacon roots contract today. The gate runs in a detection mode. It admits sends, and it probes for the contract. It also probes for new opcodes and precompiles. When a probe fires, the gate refuses new sends. The gate switches itself to enforcing mode when the beacon roots contract appears. No key does this.

Anyone can seal a gate with proof of an unsupported fork version. A sealed gate refuses all later sends. Withdrawals of delivered messages still work.

## Fork handling in plain words

A fork can break a route. The bridge does not hide this.

- The gate stops new sends into a route that cannot follow the fork.
- Sends made just before a fork can stay locked. The repository states that refunds are out of scope.
- After a breaking fork, the operators deploy a new route beside the old one. The old route pays what it can still prove.
- The interface is meant to stop offering a route before a known fork. This is advice only. A direct contract call in that window can strand funds.

## The deposit lock

Each bridge starts locked. A send on a locked bridge reverts with `DepositsNotOpen`. The bridge opens only after its light client holds a head that proves the other side is ready. Do not send before the operators announce that both bridges are open.

## No refunds

Delivery is final. A failed call is not retried. The bridge has no refund function. A refund without a proof of cancellation would let one send be paid twice.

## What the web interface does to keep you safe

- It shows every transaction in full before your wallet asks you to sign. You see the chain, the contract, the function, the arguments, the value and the gas.
- It never holds your keys. Your wallet signs.
- It refuses configuration that holds keys. The build and the start of the page both scan their settings. They stop on a value that looks like a key, a token or a recovery phrase.
- Its messages name a variable but never repeat a secret value.

The scan is a guard against mistakes. It prefers a false alarm to a leaked key.

## What you can do

- Start with a small transfer.
- Read the transaction before you sign.
- Check the status in the feed.
- Read the page Fees explained before you change the tip for delivery.

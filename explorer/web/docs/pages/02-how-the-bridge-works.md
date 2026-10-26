# How the bridge works

This page explains the parts of the bridge and why a transfer takes time. It also defines the status words that the feed shows.

## The idea in one paragraph

The bridge has no validators and no signers. Instead, each chain checks the other chain with a light client. A zero-knowledge proof shows the light client that the other chain finalized a new block. A message that your transaction sent is then proven against that block. When the proof holds, the destination contract delivers the message.

## Light clients

A light client is a contract that follows another chain. It does not run that chain. It stores only a short list of finalized block headers.

Each chain of the pair holds a light client of the other chain. The light client on PulseChain follows Ethereum. The light client on Ethereum follows PulseChain.

The light client moves forward only. It stores a new header when an update comes with a valid proof. It never stores a header that is older than its current head.

## The sync committee

A proof-of-stake chain on the beacon protocol picks a group of 512 validators for a period. This group is the sync committee. Its members sign each block header they see.

The light client does not check 512 signatures itself. A proof does that work. The proof shows that at least two thirds of the committee signed a finalized header.

You trust that two thirds of the committee are honest. The page Safety explains this trust.

## Proofs

The proofs are zero-knowledge proofs. A zero-knowledge proof shows that a program ran correctly, without making the verifier run the program again.

The bridge uses the SP1 proof system. The SP1 proof system proves programs in zero-knowledge. The program checks the committee signatures and the rules of the light client update.

The light client contract calls a verifier contract. The verifier checks the proof. The cost of one check does not depend on the size of the committee.

One proof can cover many committee handoffs. The repository states a limit of 64 handoffs in one proof. A light client that falls behind catches up in few proofs.

A proof takes time to make. The bot documentation measures about 30 to 75 seconds for one proof on a remote graphics processor.

## Finality

A block is final when the chain can no longer undo it. On these chains, finality comes after two epochs. An epoch is 32 slots.

A slot lasts 12 seconds on Ethereum and 10 seconds on PulseChain. Two epochs are therefore 768 seconds on Ethereum and 640 seconds on PulseChain. This is about 13 minutes and about 11 minutes.

The light client stores only finalized headers. The bridge never delivers a message from a block that can still change.

## From send to delivery

A transfer follows these steps.

1. You send a message or tokens on the source chain.
2. The source chain finalizes the block that holds your send.
3. A proof publisher makes a proof of a newer finalized header.
4. Someone posts the proof to the destination light client. The light client stores the new head.
5. Someone delivers your message with a message proof. The destination bridge checks the proof and runs the call.

The message proof is a path of hashes from the stored head down to your send. The destination bridge checks this path itself. It does not need a second zero-knowledge proof for this step.

## What you wait for and why

You wait for three things. Each one has a reason.

- Finality. The bridge must not deliver a send that the source chain could undo.
- A stored head. The destination light client must hold a header at or after the block of your send. Without it, the destination cannot check your send.
- A deliverer. Someone must pay for the delivery on the destination chain.

## The status words

The feed shows one status word for each transfer or message.

### Sent

Your send is on the source chain. It is younger than the finality window. You need only wait.

### Waiting for finality

Your send is older than the finality window. No stored head covers it yet. Despite the name, the chain has most likely finalized your block. The bridge now waits for a proof and a head update.

### Covered

The destination light client stored a head at or after the block of your send. Anyone can now prove and deliver your message. If you left the tip on, the runner of the fee router is likely to deliver it soon.

### Delivered

The destination bridge ran the message, and the call succeeded. For a token transfer, the tokens reached the recipient.

### Failed call

The destination bridge ran the message, but the call to the target reverted. This outcome is final. The bridge does not retry and does not refund. The page Sending messages explains why.

### Fallback used

A token release failed for the recipient. The fallback address received the tokens instead. The page Bridging tokens explains the fallback address.

### Claimable

No payee could receive the tokens. They wait for a claim. After the claim, the status returns to delivered. The page Bridging tokens explains how to claim.

## In flight

A transfer is in flight when its status is sent, waiting for finality or covered. The other statuses are end states, except claimable, which waits for your action.

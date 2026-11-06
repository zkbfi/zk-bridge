---
title: "How the bridge works"
summary: "The bridge needs no validators and no signers: each chain checks the other with a light client and a zero-knowledge proof. Here is how a transfer gets across, and why it takes about a quarter of an hour."
audience: [user, integrator]
chains: all
verified_release: 0.1.0
---

# How the bridge works

The bridge needs no validators and no signers: each chain checks the other with a light client and a zero-knowledge proof. Here is how a transfer gets across, and why it takes about a quarter of an hour.

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

One proof can cover up to 64 committee handoffs, so a light client that falls behind catches up in a few proofs.

A proof takes time to make: about 30 to 75 seconds on a graphics processor.

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
- A deliverer. Someone must pay the gas of the delivery on the destination chain. The fee pays a bot to do it; the page Fees explained covers it.

## The status words

Explore and the message page show one status word for each transfer or message. The Activity screen says the same in plain words, such as "Final soon · waiting for the proof".

### Sent

Your send is on the source chain. It is younger than the finality window. You need only wait.

### Waiting for finality

Your send is older than the finality window, and no stored head covers it yet. The chain has most likely finalized your block by now: the bridge waits for a proof and a head update.

### Covered

The destination light client stored a head at or after the block of your send. Anyone can now prove and deliver your message. When your transfer pays a fee, a bot is likely to deliver it soon. The Activity screen calls this step "Proven · waiting for a deliverer".

### Delivered

The destination bridge ran the message, and the call succeeded. For a token transfer, the tokens reached the recipient.

### Failed call

The destination bridge ran the message, but the call to the target reverted. This outcome is final. The bridge does not retry and does not refund. The page Sending messages explains why.

### Release failed

The mediator could not release the tokens to the recipient. This outcome is final: the tokens stay in the mediator, and nothing pays them out later. The page Bridging tokens explains failed releases.

## In flight

A transfer is in flight when its status is sent, waiting for finality or covered. The other statuses are end states, and all of them are final.

## Watch it happen

Explore shows the bridge at work: a live map of the transfers in flight in each direction, the light clients and the block each has verified, the latest transfers, and the services the app reads. Search there takes any identifier, such as a transaction hash, a message ID, an address, a token, a slot, a block or a proof number. Every value on an Explore page links onward. The page Settings, search and Explore covers it.

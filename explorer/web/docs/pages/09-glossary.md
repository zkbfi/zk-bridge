# Glossary

Every term the app and these docs use, in alphabetical order.

## Allowance

The amount of a token that you let a contract pull from your account. You set it with an approval. The mediator needs an allowance before it relays your tokens.

## Automatic fee cap

The most the automatic fee may take, as a share of the amount: 1% unless you change it. It can never be above the hard fee cap.

## Base fee

The part of the gas price that a chain burns. It changes from block to block. Your gas level sets how far above today's base fee a deliverer may pay.

## Beacon chain

The part of a proof-of-stake chain that tracks validators and finality. The light client follows the beacon chain of the source chain.

## Bridged copy

A token that the bridge mints on one chain to stand for a native token of the other chain. Its name is the name of the native token, then " from " and the home chain, for example Wrapped Ether from Ethereum. Its symbol has the prefix "zkb", for example zkbWETH. The bridge burns the copy when the tokens go back home.

## Cost

What delivering your transfer costs: the delivery gas at your gas level plus $0.025 for the proof. The default fee is at least twice the cost.

## Covered

A status of a transfer, shown as "Proven" on the Activity screen. The destination light client stored a head at or after the block of your send. Anyone can now deliver it.

## Delivery router

A contract on the destination chain that a transfer with a fee goes through. Anyone can deliver through it. It pays the fee to its reward address and the rest to the recipient. When anyone delivers on the bridge directly, without the router, no fee is paid.

## Deployment checkpoint

The starting trusted header of a light client. The deployer chooses it when the contract is deployed. Anyone can check it against public data.

## Executor

The account that calls the delivery function on the destination chain. Anyone can be an executor. The target of a message is the contract that the bridge calls.

## Fee

The one amount you pay for a transfer: the delivery gas, the proof and a tip for the deliverer. It comes out of the amount you send. The page Fees explained covers it.

## Finality

The point at which a chain can no longer undo a block. On these chains, finality comes after two epochs.

## Gas level

How far above today's gas price you let the deliverer pay: Normal (up to 2 ×), High (3 ×) or Highest (5 ×). Today's price is the anchor, and the real price can land lower or higher over the next 15 minutes.

## Gate

A contract that checks the fork version of the source chain. It refuses a send that the route cannot deliver. The page Safety explains the gate.

## Hard fee cap

The most the fee may ever be, as a share of the amount: 2% unless you change it. A fee above it blocks the Bridge button until you raise the cap.

## Head

The newest finalized header that a light client has stored. The head only moves forward.

## High cap %

A warning on the Bridge button: the tip, the part of the fee above the cost, is a large share of the amount. A lower tip still gets delivered.

## Light client

A contract that follows another chain. It stores finalized headers. It accepts a new header only with a valid proof.

## Mediator

The token mediator. It is the contract that locks native tokens, mints and burns bridged copies, and keeps the tokens of a failed release.

## Message

A request to call a contract on the other chain. It has a target, call data and gas. A token transfer is a message to the mediator.

## Native token

A token on the chain where it was created. The mediator locks a native token when you bridge it.

## Proof

Evidence that a statement is true. The bridge uses two kinds. A zero-knowledge proof shows that a light client update is valid. A message proof is a path of hashes that links a send to a stored header.

## Relay

To send tokens or a message across the bridge. The functions of the mediator that do this have the word relay in their names.

## Release failed

A status of a transfer. The mediator could not release the tokens to the recipient. The failure is final, and the tokens stay in the mediator.

## Runner

A program, also called a delivery bot, that delivers proven transfers for their fee. It holds a wallet on the destination chain. Any runner can deliver through a delivery router, which pays the fee to its reward address, not to the runner.

## Slot

A unit of time on a beacon chain. One block fits in one slot. A slot lasts 12 seconds on Ethereum and 10 seconds on PulseChain. An epoch has 32 slots.

## Sync committee

A group of 512 validators of the source chain. Its members sign the headers they see. The light client trusts that at least two thirds of them are honest.

## Tip

The part of the fee that the deliverer keeps once the delivery gas and the proof are paid.

## Wrapped native token

A token that stands for the native coin one to one. The bridge wraps the coin before it relays it and unwraps it on delivery.

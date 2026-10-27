# Glossary

This page defines the terms that the interface and the documentation use. The entries are in alphabetical order.

## Allowance

The amount of a token that you let a contract pull from your account. You set it with an approval. The mediator needs an allowance before it relays your tokens.

## Base fee

The part of the gas price that a chain burns. The base fee changes from block to block. The delivery cost lines use the base fee of a recent block.

## Beacon chain

The part of a proof-of-stake chain that tracks validators and finality. The light client follows the beacon chain of the source chain.

## Bridged copy

A token that the bridge mints on one chain to stand for a native token of the other chain. Its name is the name of the native token, then " from " and the home chain, for example Wrapped Ether from Ethereum. Its symbol has the prefix "zkb", for example zkbWETH. The bridge burns the copy when the tokens go back home.

## Claimable

A status of a transfer. No payee could receive the tokens, so they wait in the mediator. The fallback address, or anyone for it, can claim them.

## Covered

A status of a transfer. The destination light client stored a head at or after the block of your send. Anyone can now deliver it.

## Deployment checkpoint

The starting trusted header of a light client. The deployer chooses it when the contract is deployed. Anyone can check it against public data.

## Executor

The account that calls the delivery function on the destination chain. Anyone can be an executor. The target of a message is the contract that the bridge calls.

## Fallback recipient

The address that gets the tokens when the receiver cannot take them. The default is the sender, at the same address on the other chain.

## Delivery router

An optional contract on the destination chain. It receives your tokens and pays the tip to its reward address. Anyone can deliver through it. It sends the rest to the recipient. When anyone delivers on the bridge directly, without the router, no tip is paid.

## Finality

The point at which a chain can no longer undo a block. On these chains, finality comes after two epochs.

## Gate

A contract that checks the fork version of the source chain. It refuses a send that the route cannot deliver. The page Safety explains the gate.

## Head

The newest finalized header that a light client has stored. The head only moves forward.

## Light client

A contract that follows another chain. It stores finalized headers. It accepts a new header only with a valid proof.

## Mediator

The token mediator. It is the contract that locks native tokens, mints and burns bridged copies and holds claimable balances.

## Message

A request to call a contract on the other chain. It has a target, call data and gas. A token transfer is a message to the mediator.

## Native token

A token on the chain where it was created. The mediator locks a native token when you bridge it.

## Proof

Evidence that a statement is true. The bridge uses two kinds. A zero-knowledge proof shows that a light client update is valid. A message proof is a path of hashes that links a send to a stored header.

## Relay

To send tokens or a message across the bridge. The functions of the mediator that do this have the word relay in their names.

## Runner

A person or a program that delivers covered transfers for a tip. A runner holds a wallet on the destination chain. Any runner can deliver through a delivery router. The router pays the tip to its reward address, not to the runner.

## Slot

A unit of time on a beacon chain. One block fits in one slot. A slot lasts 12 seconds on Ethereum and 10 seconds on PulseChain. An epoch has 32 slots.

## Sync committee

A group of 512 validators of the source chain. Its members sign the headers they see. The light client trusts that at least two thirds of them are honest.

## Tip for delivery

A voluntary amount that you offer for the delivery of your transfer. The interface sets it by default as a gas based tip with a limit. The limit is the price ceiling. The bridge itself charges no fee, so the tip is the only fee. The delivery router pays it to its reward address. A direct delivery on the bridge, without the router, pays no tip.

## Wrapped native token

A token that stands for the native coin one to one. The bridge wraps the coin before it relays it and unwraps it on delivery.

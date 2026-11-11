---
title: "Sending messages"
summary: "Call a contract on the other chain: the bridge carries your call, proves it, and runs it on the destination chain."
audience: [user, integrator]
chains: all
verified_release: 0.1.0
---

# Sending messages

Call a contract on the other chain: the bridge carries your call, proves it, and runs it on the destination chain.

## What a message is

A message is a request. It names a contract on the other chain and some call data. The bridge proves the request on the destination chain and then makes the call.

Token transfers use the same mechanism. A token relay is a message to the token mediator on the other side.

The bridge follows the interface of the OmniBridge Arbitrary Message Bridge. The function you call is `requireToPassMessage`.

## The values of a message

You supply two values, and no gas number.

### Target

The target is the contract that receives the call on the destination chain. It must be a contract address on that chain.

### Data

The data is the encoded call. It holds the function selector and the arguments. You build it with the interface of the target contract.

The bridge refuses data that starts with the selector of `transfer`, `approve`, `transferFrom`, `approveAndCall` or `transferAndCall`. This rule stops a message from moving tokens of a contract that approved the bridge.

### Gas

A message has no gas number. The target gets all the gas that the deliverer gives the delivery. If the target runs out of gas or reverts, the whole delivery reverts and the message stays waiting. Anyone can deliver it again with more gas, and nothing is lost.

## How to send a message

Open search (⌘K, Ctrl K or the slash key) and choose **Send a message**.

1. Choose the direction.
2. Enter the target address on the destination chain.
3. Enter the call data as hex.
4. Read the full transaction.
5. Sign it in your wallet.

The app shows the chain, the contract, the function, the arguments, the value and the gas before your wallet opens. Check each line before you sign.

## What the target sees

The target checks two facts. The caller must be the message bridge on the destination chain. The bridge also exposes the sender and the source chain during the call.

- `messageSender` returns the address that sent the message.
- `messageSourceChainId` returns the chain of the send.
- `messageId` returns the identifier of the message.

A target must trust only one bridge. It must check that the caller is that bridge.

If you send through a multicall contract, the sender is the multicall contract. It is not your account. A target that checks the sender must expect this.

## The life of a message

A message has the same steps as a token transfer: sent, final, proven, delivered. Your messages show on the Activity screen next to your transfers. The page How the bridge works explains each status.

Anyone can deliver a message. Messages are independent. They can arrive in any order.

## Delivery is final

The bridge marks a message as delivered only when the call succeeds. A call that reverts undoes the delivery, so the message stays waiting and nothing is recorded. The bridge never runs the same message twice once it has succeeded.

Plan for this before you send. A target that always reverts can never be delivered, and the message waits for ever. Your target contract must be able to take the call.

## Gas protection

An executor cannot make the message fail by giving it too little gas. A delivery with too little gas reverts and leaves the message waiting, so the next deliverer can try again with more.

## The gate and your send

On an enforcing chain, the first send in each epoch needs a gate confirmation. The page Safety explains the gate.

A send of the native coin carries the confirmation itself, so it stays one transaction. Before a token transfer or a message, the confirmation is a transaction of its own, sent first when the epoch needs one. When less than a minute of the epoch is left, the page waits for the next epoch (up to about 72 seconds) before a send of the native coin, and before a confirmation, so that the confirmation is for the epoch the send lands in.

If a send fails with a gate error, wait one slot and try again.

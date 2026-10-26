# Sending messages

This page explains how to send a message to a contract on the other chain. A message is a call that the bridge carries and runs on the destination chain.

## What a message is

A message is a request. It names a contract on the other chain, some call data, and an amount of gas. The bridge proves the request on the destination chain and then makes the call.

Token transfers use the same mechanism. A token relay is a message to the token mediator on the other side.

The bridge follows the interface of the OmniBridge Arbitrary Message Bridge. The function you call is `requireToPassMessage`.

## The three values of a message

You supply three values.

### Target

The target is the contract that receives the call on the destination chain. It must be a contract address on that chain.

### Data

The data is the encoded call. It holds the function selector and the arguments. You build it with the interface of the target contract.

The bridge refuses data that starts with the selector of `transfer`, `approve`, `transferFrom`, `approveAndCall` or `transferAndCall`. This rule stops a message from moving tokens of a contract that approved the bridge.

### Gas

The gas is the amount that the bridge forwards to the target. The bridge forwards exactly this amount.

The bridge accepts a gas value between 100 and 10,000,000. A value outside this range makes the send revert.

Choose enough gas for the target to finish. If the target runs out of gas, the call fails, and the failure is final.

## How to send a message

1. Choose the direction.
2. Enter the target address on the destination chain.
3. Enter the call data as hex.
4. Enter the gas.
5. Read the full transaction in the interface.
6. Sign the transaction in your wallet.

The interface shows the chain, the contract, the function, the arguments, the value and the gas. Check each line before you sign.

## What the target sees

The target checks two facts. The caller must be the message bridge on the destination chain. The bridge also exposes the sender and the source chain during the call.

- `messageSender` returns the address that sent the message.
- `messageSourceChainId` returns the chain of the send.
- `messageId` returns the identifier of the message.

A target must trust only one bridge. It must check that the caller is that bridge.

If you send through a multicall contract, the sender is the multicall contract. It is not your account. A target that checks the sender must expect this.

## The life of a message

A message has the same status words as a token transfer. It starts as sent. It then waits for finality and becomes covered. After delivery, it shows delivered or failed call. The page How the bridge works explains each word.

Anyone can deliver a message. Messages are independent. They can arrive in any order.

## Delivery is final

The bridge marks a message as delivered whether the call succeeds or reverts. The bridge never runs the same message twice.

A failed call is a real outcome. The status shows failed call. The bridge records the failure for contracts to read. It does not retry. It does not refund anything.

Plan for this before you send. Your target contract or your application must handle a failed call. For example, the application can send a new message.

## Gas protection

An executor cannot cheat the message by giving it too little gas. The bridge refuses to deliver unless enough gas remains to forward the full amount you chose.

This means a failed call is not the fault of the executor. It happens only when the target itself fails with the gas that you chose.

## The gate and your send

On an enforcing chain, the first send in each epoch needs a gate confirmation. The page Safety explains the gate. The interface is meant to build and send this confirmation for you when it is needed.

If a send fails with a gate error, wait one slot and try again.

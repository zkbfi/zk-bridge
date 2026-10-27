# Bridging tokens

This page explains how to move tokens across the bridge. It covers native tokens, bridged copies, the native coin, the allowance, the fallback address and claims.

## Native tokens and bridged copies

A token is native on the chain where it was created. For example, USDC on Ethereum is native on Ethereum.

When you bridge a native token, the bridge locks it in the token mediator. The mediator is the contract that handles tokens. The other chain then mints a bridged copy for the recipient.

When you bridge a copy back, the bridge burns the copy. The mediator then unlocks the native token on its home chain. The supply of each copy always matches the tokens that the mediator holds in escrow.

## How a copy is created

The bridge has no token list and no registration step. The address of a copy comes from the home chain and the home token. The destination chain computes this address.

The first transfer of a token deploys its copy. This transfer costs more gas to deliver than later ones. The copy takes the name of the native token, then " from " and the name of its home chain. For example, Wrapped Ether from Ethereum. Its symbol is the symbol of the native token with the prefix "zkb". For example, zkbWETH.

## Wrapping the native coin

The native coin is ETH on Ethereum and PLS on PulseChain. A coin is not a token, so the mediator cannot move it directly.

A router contract wraps the coin first. Wrapping turns the coin into a wrapped native token that works like any other token. The router then relays the wrapped token. On the other side, the router unwraps the token and sends the coin to the recipient.

You do this in one transaction. You send the coin to the router with its `wrapAndRelayTokens` function. You do not need an allowance for the coin.

## The three relay functions

The mediator has three ways to relay tokens. They differ in what happens at delivery.

### relayTokens

`relayTokens` is the plain transfer. It takes the token, the receiver and the amount. A second form sends the tokens to your own address on the other chain.

Use it when the receiver is a normal account.

### relayTokensAndCall

`relayTokensAndCall` delivers the tokens and then calls the receiver. It takes the same values plus call data. After the tokens arrive, the receiver contract gets a callback named `onTokenBridged` with your data.

Use it when the receiver is a contract that must act on the tokens. The interface also uses this function to send your tip through the delivery router. The page Fees explained covers that case.

### relayTokensWithFallback

`relayTokensWithFallback` adds one value: a fallback address. The mediator pays this address when the receiver cannot take the tokens. The next sections explain this.

The other two functions use a default fallback. The default is the sender, at the same address on the destination chain.

## The allowance step

A token contract only lets the mediator pull your tokens after you approve it. This approval is the allowance.

1. Read your current allowance for the mediator.
2. If it is lower than your amount, send an approval for at least the amount.
3. Wait for the approval to confirm.
4. Send the relay.

The interface shows both transactions in full before your wallet asks you to sign. Approve only the amount you need. An approval for a larger amount stays open until you lower it.

## Fees overview

The bridge charges no fee. The only fee is the voluntary tip for delivery. The interface adds this tip by default, at 0.1 percent of the transfer. The delivery router pays it to its reward address, as payment for the delivery. You can edit the tip or remove it. The wrap route carries no tip. The page Fees explained covers the tip.

The recipient receives the whole amount that you send, less the tip when you choose one. The feed shows the amount of the transfer.

## The fallback address

A delivery can fail for the receiver. For example, a token can block a receiver that is on a deny list. The bridge then follows a fixed order.

1. It tries to pay the receiver.
2. If that fails, it pays the fallback address.
3. If that also fails, it records a claimable balance for the fallback address.

The message stays delivered in all three cases. The bridge does not undo a delivery.

Check the default fallback before you send from a contract. The same address on the other chain may belong to someone else, or to nobody. In that case, set a fallback with `relayTokensWithFallback`.

## Claimable balances

A claimable balance holds tokens that nobody could receive. The tokens stay safe in the mediator. The feed shows the status claimable.

## How to claim

1. Open the claim screen and enter the token.
2. Check the balance of the fallback address.
3. Send the claim transaction on the destination chain.

The fallback address can claim. Anyone else can also call the claim for that address. The tokens always go to the fallback address.

After the claim, the status of the transfer returns to delivered. A claim charges no fee.

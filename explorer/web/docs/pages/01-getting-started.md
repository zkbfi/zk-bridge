# Getting started

This page shows you how to move your first tokens across the bridge. It also tells you what is ready and what is not. Read the next section before you use real money.

## Status of the bridge

The bridge is new software. Two facts matter before you start.

- No independent audit of the bridge code has been completed as of this writing.
- The repository states that nothing is deployed to a live network yet.

Do not put funds in the bridge that you cannot afford to lose. The page Safety explains what you trust and what the contracts cannot do.

The web interface is also in development. This guide describes how it is designed to work. Where a feature is not built yet, the page says so.

## What the bridge connects

The bridge joins two chains in one pair. The default pair is Ethereum and PulseChain. Its name in the configuration is `eth-pls`.

On each chain the bridge has a light client of the other chain. A light client is a contract that follows another chain. The page How the bridge works explains this in detail.

You can send tokens in both directions. You can also send a message to a contract on the other chain.

## What you need

You need four things before you start.

- A browser wallet that holds the tokens you want to move.
- A small balance of the native coin of the source chain to pay for gas. The native coin is ETH on Ethereum and PLS on PulseChain.
- The address that receives the tokens on the other chain. This can be your own address.
- Some patience. A transfer takes several minutes, because the bridge waits for the source chain to finalize your send.

## Your first transfer

Follow these steps in order.

1. Open the web interface and connect your wallet.
2. Open the pair `eth-pls`.
3. Choose Bridge tokens.
4. Choose the token and enter the amount. The chain that holds the token is the source chain.
5. Read the tip for delivery. The page Fees explained tells you how to read it.
6. Press Review. If the bridge needs an allowance, the interface shows it first. It lets the bridge pull your tokens.
7. Send each transaction to your wallet. The interface shows the whole transaction before your wallet asks you to sign.
8. Watch the status of the transfer in the feed.

The page Bridging tokens explains each step in more detail. It also explains how to bridge the native coin.

## Find your way around

The interface has no menu. It has one search field in the top bar. Press Ctrl K, Command K or the slash key to open it.

Type a word to find a view, a pair, a token, an action or a page of this guide. Paste a message identifier or a transaction hash to open that transfer. Paste an address to see its transfers and balances. The arrow keys move through the results. Enter opens one.

## What happens after you send

Your transfer moves through a fixed list of status words. The feed shows the current word.

1. Sent: your send is on the source chain.
2. Waiting for finality: the bridge waits for a proof and a stored head.
3. Covered: the destination chain knows about your send. Anyone can now deliver it.
4. Delivered: the tokens arrive at the recipient.

Some transfers end in a different state. The page How the bridge works explains every status word.

## Who delivers your transfer

Anyone can deliver a covered transfer. A delivery needs a proof and costs gas on the destination chain.

Anyone can do this work. A person or a program called a runner often does it. The interface adds a tip by default. It is a gas based tip with a limit, and the limit is the most it can take. The delivery router pays the tip to its own reward address. You can edit the tip or remove it. The page Fees explained shows how the tip works. A direct delivery on the bridge, without the router, pays no tip, and the recipient gets the whole amount.

If nobody delivers your transfer, you can deliver it yourself. The terminal dashboard has an action for this. The web interface is meant to offer the same action.

## Try the interface with sample data

The web interface has a fixture mode. In this mode it shows built-in sample data. It simulates every send, and nothing reaches a chain.

Use this mode to learn the screens. The operator of the interface chooses the mode when it builds the page.

## Where to go next

- How the bridge works explains light clients, proofs and finality.
- Bridging tokens explains the token functions, the allowance and claims.
- Sending messages explains how to call a contract on the other chain.
- Fees explained explains the tip for delivery, which is the only fee.
- Safety explains what you trust.
- Glossary defines every term.

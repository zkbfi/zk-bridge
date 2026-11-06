---
title: "Getting started"
summary: "Move your first tokens between Ethereum and PulseChain in a few steps, and learn where to follow them on the way."
audience: [user]
chains: all
verified_release: 0.1.0
---

# Getting started

Move your first tokens between Ethereum and PulseChain in a few steps, and learn where to follow them on the way.

## Status of the bridge

The bridge is new software. Two facts matter before you start.

- No independent audit of the bridge code has been completed as of this writing.
- The bridge is not yet live on the main networks. Until it is, the app runs on the test networks.

Send only what you can afford to lose. The page Safety explains what you trust and what the contracts cannot do.

## What the bridge connects

The bridge joins two chains in one pair. The default pair is Ethereum and PulseChain. Until that pair is live, the app opens on Sepolia and PulseChain testnet v4.

Each chain holds a light client of the other chain: a contract that follows the other chain and checks proofs of it. The page How the bridge works explains this.

You can send tokens in both directions, and send a message to a contract on the other chain.

## What you need

- A browser wallet that holds the tokens you want to move.
- A little of the source chain's coin for gas: ETH on Ethereum, PLS on PulseChain.
- Some patience. A transfer takes about a quarter of an hour, because the bridge waits until the source chain can no longer undo your send.

## Your first transfer

The app opens on the Bridge screen.

1. Tap **Connect wallet** and choose your wallet.
2. Tap the chain beside **From** to choose the direction, for example Ethereum → PulseChain. The round button between the two halves of the screen swaps the direction.
3. Tap the token to choose another. Search finds any token the bridge knows, and a token address you paste.
4. Type the amount. Under it you see its value in dollars, your balance and **MAX**.
5. Read the delivery control under the amount: who delivers, the fee, your gas level and the time to arrival. The page Fees explained covers each part.
6. Check the **To** row. It is locked to your wallet. To send to another address, tap the lock and type the address in its place.
7. Read the Bridge button. Solid means ready. An orange outline is a warning you can read and still accept. Grey means something needs fixing first; the line under the button says what.
8. Tap **Bridge**. The review shows what you send, what arrives, the fee and its parts, the time, the full destination address and the relay router.
9. Tap **Confirm in wallet** and sign each transaction. If the bridge needs an allowance for the token, that comes first. The app shows every transaction in full before your wallet opens.

The page Bridging tokens explains each step in more detail.

## Find your way around

Every screen has the same header: the zkb.fi mark on the left (it takes you home to the Bridge screen), the name of the screen in the middle, and search on the right.

The app has three main screens side by side: **Activity**, **Bridge** and **Explore**. The arrows beside the screen name move between them.

Search reaches everything else. Tap the search button, or press ⌘K on a Mac, Ctrl K elsewhere, or the slash key. Type a word to find a screen, a token, an action, a setting or a page of these docs. Paste a transaction hash, a message ID or an address to open it. The arrow keys move through the results, Enter opens one and Escape closes the search.

## Follow your transfer

Open **Activity** to see your transfers on the current pair, in both directions, sent and received. A transfer shows there the moment you send it.

Each transfer in flight shows a track from the source chain to the destination, the step it is on in plain words, and the time left. The steps are:

1. Sent: your send is on the source chain.
2. Final: the source chain can no longer undo it, and the bridge waits for the proof.
3. Proven: the destination chain can check your send, and it waits for a deliverer.
4. Delivered: the tokens reached the recipient.

The tabs filter the list: All, In flight, Needs you and Delivered. Delivered transfers are grouped by day. Tap one to see every step with its time and a link to each transaction, and **Bridge again** to repeat it.

## Who delivers your transfer

Once your transfer is proven, anyone can deliver it on the destination chain. By default the fee pays a bot to do it. If you choose to deliver it yourself, or no bot takes it, the transfer moves to **Needs you** on the Activity screen with a **Deliver it yourself** button. The page Fees explained covers both.

## Try the app with sample data

The app has a sample mode that shows built-in data and simulates every send. Nothing reaches a chain. The screen says "Sample data. Nothing here reaches a chain." when it is on. Use it to learn the screens.

## Where to go next

- How the bridge works: light clients, proofs and finality.
- Bridging tokens: the token picker, the destination, the allowance and failed releases.
- Sending messages: calling a contract on the other chain.
- Fees explained: the fee, the gas level, the caps and the warnings.
- Settings, search and Explore: themes, your RPC endpoint per chain, every service the app uses, and finding anything.
- Safety: what you trust.
- Glossary: every term.

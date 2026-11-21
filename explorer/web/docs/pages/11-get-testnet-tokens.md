---
title: "Get testnet tokens"
summary: "Get gas on Sepolia and PulseChain testnet v4 from two faucets, mint 1,000 free tFAU test tokens on each chain from this page, and bridge them to try the bridge with nothing at stake."
audience: [user]
chains: [11155111, 943]
verified_release: 0.1.0
---

# Get testnet tokens

This page gets you what you need to try the bridge on the test networks: gas on both chains, and a free test token to send. Nothing here has any value.

## What you need

Two things, in this order:

1. A little of each chain's coin, to pay gas. Every transaction pays it, the mint of the test token included. You get it from a faucet, below.
2. A token to send. You mint it on this page: 1,000 tFAU per mint, on either chain.

## Step 1: get gas

### Sepolia ETH

Open the [Sepolia proof-of-work faucet](https://sepolia-faucet.pk910.de/). It opens in a new tab. It is a proof-of-work faucet: it mines in the browser tab. You give it your address, start mining, leave the tab open while it collects Sepolia ETH, and then claim what it mined. It takes a while, so start it first and come back.

### Testnet PLS

Open the [PulseChain testnet v4 faucet](https://faucet.v4.testnet.pulsechain.com/). It opens in a new tab. You give it your address and it sends testnet PLS to it.

The app writes the two coins as SepETH and v4tPLS.

## Step 2: mint tFAU

tFAU is a test token called "zkb Faucet Token". Anyone can mint it: one mint gives the connected wallet 1,000 tFAU, and a single call can never mint more than that. You can mint as often as you like.

Press Mint. The app shows the call in full for you to review, and then your wallet opens. If your wallet is on another chain, it switches to the chain of the mint first. The mint costs gas, so do step 1 first.

The block for each chain also shows the token address and an **Add to wallet** button, which asks your wallet to list tFAU so that its balance shows there. Without a wallet connected, the block shows the address and a **Connect wallet** button.

### Mint on Sepolia

```faucet
chain: 11155111
```

### Mint on PulseChain testnet v4

```faucet
chain: 943
```

## Step 3: bridge it

1. Open the Bridge screen and tap **Connect wallet**.
2. Tap the chain beside **From** to choose where tFAU is, for example Sepolia → PulseChain testnet v4.
3. Tap the token and choose **tFAU**. On the test networks the picker always lists it, with a small **Mint 1,000** button beside it when you hold none.
4. Type the amount, for example 10, and read the delivery line under it.
5. Tap **Bridge**, check the review, and tap **Confirm in wallet** for each transaction. The first time you send tFAU, the other chain creates its bridged copy.
6. Follow the transfer on the Activity screen. It takes about a quarter of an hour, because the source chain must first finalize your send.

You can then send the bridged copy back, which releases the tFAU you locked. The pages [Bridging tokens](03-bridging-tokens.md) and [Fees explained](05-fees-explained.md) cover each step in more detail.

## How testnet tokens work

- tFAU has no owner and no value, and it exists only on Sepolia and PulseChain testnet v4. The mint is capped per call because an uncapped public mint would let anyone print an amount close to the largest number a token can hold and send it through the bridge.
- The two other test tokens of the testnet, tUSD and tTKN, can be minted only by their deployer, so they show no Mint button. Use tFAU to try the bridge.
- The bridge screen helps in two places while you are on the test networks. When your wallet has none of the source chain's coin, a line under the amount says so and links the faucet. When tFAU is selected and your balance is 0, it offers the mint.
- The testnet gas faucets are run by others, not by zkb.fi. If one is down, try again later.

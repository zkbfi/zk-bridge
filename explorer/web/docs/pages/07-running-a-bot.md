---
title: "Running a delivery bot or prover"
summary: "Run a delivery bot or a prover and earn the fees that transfers pay."
audience: [deliverer, operator]
chains: all
verified_release: 0.1.0
---

# Running a delivery bot or prover

Run a delivery bot or a prover and earn the fees that transfers pay.

## The two bots

There are two bots, and you can run either or both:

- The proof publisher makes light client proofs and shares them.
- The delivery runner delivers proven transfers through a delivery router and earns their fees.

To bridge, you need only a wallet.

## What the proof publisher does

The proof publisher keeps the light clients current. It watches both chains of a pair. It looks at the stored head on the destination and the newest finalized header on the source.

When a newer finalized header exists, the publisher makes a proof. It runs the `zk-bridge-prover` program with a remote backend. The remote backend runs on a graphics processor endpoint.

The publisher then posts the proof on msgboard. Msgboard is a public message board that carries the proofs. Its messages are short-lived. The publisher posts the latest proof again on a timer.

The publisher holds no wallet. It only proves and publishes.

## What the delivery runner does

The delivery runner reads the proofs from msgboard. It checks each proof before it acts.

If the destination light client is behind, the runner posts the update. It then lists the transfers that are covered and not yet delivered.

For each transfer, the runner reads the fee. It compares the fee with its own gas cost, plus a margin that you configure, and delivers only when the fee covers them.

The runner simulates every transaction first. It never sends a transaction that would revert. It holds a wallet on the destination chain.

## How the runner treats fees

Anyone can deliver through a delivery router. The router pays every fee to its reward address, not to the wallet that delivers. The runner earns the fee only when the router's reward address is its own. Check the reward address of a router before you run a runner against it.

The runner skips transfers that carry no fee. The setting `deliverWithoutOffer` changes this; it is off by default.

By default the app sets a fee of at least twice the cost of a transfer (the delivery gas plus $0.025 for the proof), so a runner with a margin up to 100% still delivers it. Only a small transfer, where the user's fee cap holds the fee lower, falls short, and the app warns the user about it. A gas-based fee follows the gas the delivery actually spends. The page Fees explained covers how users set their fee.

## Where the bots run

Both bots run from the terminal. They are part of the bots package. The command is `zk-bridge-bot`. You start the publisher or the runner with a configuration file.

Logs go to standard error as one JSON object per line. The bots can stop and start again without double work.

The bots' README in the source code lists the commands, the configuration fields and the tests; the terminal dashboard's README lists its keys and settings.

## The Prover setup view

The terminal dashboard has a Prover setup view. You use it to enter the remote endpoint, the keys and the chain endpoints. The bots read the file that this view writes.

This view exists only in the terminal. It holds operator secrets. A browser page ships its settings to every visitor, so the web app never holds these secrets.

The terminal opens the view with the key `5`. The view is always the last option in every menu.

## How secrets are kept

The setup view takes secrets in masked fields. It never shows them again, except the last four characters.

The terminal stores secrets in the secret store of the operating system when one exists. Otherwise it uses a file that a password encrypts. You can also point to an environment variable instead of storing anything. Every log and error removes the secrets.

## Before you start

- Build the prover first: the runner uses its `verify` command.
- The remote proof mode works with a load-balancing endpoint.
- Keep proof messages small: 8 KiB is the size tested on msgboard.

Run the bots against a local test chain before you use real funds.

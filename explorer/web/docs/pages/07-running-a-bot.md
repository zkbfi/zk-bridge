# Running a delivery bot or prover

Most users never read this page. It is for operators who want to make proofs or deliver transfers for a fee.

## Who needs this

You need this page in three cases.

- You want to run the proof publisher, which makes and shares light client proofs.
- You want to run a delivery runner, which delivers transfers through a delivery router.
- You run your own remote graphics processor for proofs.

You do not need a bot to use the bridge. You only need a wallet.

## What the proof publisher does

The proof publisher keeps the light clients current. It watches both chains of a pair. It looks at the stored head on the destination and the newest finalized header on the source.

When a newer finalized header exists, the publisher makes a proof. It runs the `zk-bridge-prover` program with a remote backend. The remote backend runs on a graphics processor endpoint.

The publisher then posts the proof on msgboard. Msgboard is a public message board that carries the proofs. Its messages are short-lived. The publisher posts the latest proof again on a timer.

The publisher holds no wallet. It only proves and publishes.

## What the delivery runner does

The delivery runner reads the proofs from msgboard. It checks each proof before it acts.

If the destination light client is behind, the runner posts the update. It then lists the transfers that are covered and not yet delivered.

For each transfer, the runner reads the tip. It compares the tip with its own gas cost, plus a margin that you configure. It delivers only when the tip covers the cost.

The runner simulates every transaction first. It never sends a transaction that would revert. It holds a wallet on the destination chain.

## How the runner treats tips

Anyone can deliver through a delivery router. The router pays every tip to its reward address, not to the wallet that delivers. The runner earns the tip only when the reward address of the router is its own. Check the reward address of a router before you run a runner against it.

The runner skips transfers with no tip. You can change this with the setting `deliverWithoutOffer`. The default is off.

A suggestion with a margin of zero covers the cost and nothing more. A runner with a margin above zero skips it. The page Fees explained describes the suggestions.

## Where the bots run

Both bots run from the terminal. They are part of the bots package. The command is `zk-bridge-bot`. You start the publisher or the runner with a configuration file.

Logs go to standard error as one JSON object per line. The bots can stop and start again without double work.

Read these files for the commands and settings.

- `docs/bots.md` has the design and the decisions.
- `explorer/bots/README.md` has the commands, the configuration fields and the tests.
- `explorer/terminal/README.md` has the terminal dashboard, its keys and its environment variables.

## The Prover setup view

The terminal dashboard has a Prover setup view. You use it to enter the remote endpoint, the keys and the chain endpoints. The bots read the file that this view writes.

This view exists only in the terminal. It holds operator secrets. A browser page ships its settings to every visitor, so the web interface never holds these secrets.

The terminal opens the view with the key `5`. The view is always the last option in every menu.

## How secrets are kept

The setup view takes secrets in masked fields. It never shows them again, except the last four characters.

The terminal stores secrets in the secret store of the operating system when one exists. Otherwise it uses a file that a password encrypts. You can also point to an environment variable instead of storing anything. Every log and error removes the secrets.

## Limits and open items

Some facts are not verified yet.

- The message size limit of the live msgboard network is not verified. The tested limit is 8 KiB, on the node software available on the development machine.
- The proof remote mode supports only a load balancing endpoint today. A queue endpoint needs a second implementation.
- The runner needs the `verify` command of the prover. Build the prover first.

Run the bots against a local test chain before you use real funds.

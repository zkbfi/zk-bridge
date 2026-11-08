---
name: check-transfer-status
description: Finds a bridge transfer or message by its transaction hash or message id and says where it is (sent, waiting for finality, covered, delivered, or failed) and what to do next. Use when a person asks whether their transfer arrived, why it is slow, or what a status means.
kind: skill
title: Check a transfer's status
summary: Look a transfer up in the dapp (Activity, search, Explore) or the indexer API and read its status.
audience: [user]
chains: all
verified_release: 0.1.2-next.14
---

# Check a transfer's status

## When to use

- The person has sent a transfer and asks whether it arrived.
- The person has a transaction hash (of the send or of the delivery) or a message id and wants to know what it is.
- The person asks what "covered", "waiting for finality" or another status means.

## Preconditions

- One of: the dapp open in a browser, or the ability to make an HTTP GET request to the indexer API.
- A transaction hash (0x and 64 hex digits) or a message id (also 0x and 64 hex digits). A message id is not the same as a transaction hash: the indexer looks a message up by its id (`/api/messages/<id>`), and finds a transaction hash through search.

## Steps

### In the dapp

1. Your own transfers: open **Activity** (the screen to the left of Bridge). A transfer shows there the moment it is sent. The tabs are **All**, **In flight**, **Needs you** and **Delivered**. Tap a transfer to see every step with its time and a link to each transaction.
2. Any transfer: open search (tap the search button, or press Cmd K on a Mac, Ctrl K elsewhere, or the slash key; the field reads "Search anything") and paste the transaction hash or the message id. Pick the result of kind message. A message id can also be opened at the address `#/message/<message id>` in the dapp.
3. Or open **Explore** (the screen to the right of Bridge) and paste the hash or id in the search band (it reads "Tx, message, address, token, slot, block, proof…").
4. On the message page, read the **Steps** list and the line that says where the message is. A message that is not delivered also shows a panel titled "Proof and delivery" under "Prove and deliver it yourself" (see `deliver-it-yourself`).
5. If the page says "Not found" with "The indexer does not know the message …", the indexer has not seen it (see "If it fails").

### With the indexer API

The public host of the indexer is the `indexer` entry of `ZKB_SITES` in `@zkb/data` (`https://indexer.zkb.fi`). Every endpoint is a GET and answers JSON.

1. By message id:

   ```sh
   curl -s "https://indexer.zkb.fi/api/messages/<message id>"
   ```

   The answer holds `status`, `direction` (`sourceChainId`, `destinationChainId`, `label` such as `943>11155111`), `sent`, `covered`, `delivered` (each null until it happens), `callbackFailed`, `releaseFailed`, `transfer` (tokens, `value`, `deliveredValue`), `data` and `costs`.
2. By transaction hash (the hash of a send, a delivery or a light client update):

   ```sh
   curl -s "https://indexer.zkb.fi/api/search?q=<transaction hash>"
   ```

   A hash that belongs to a message gives a result of kind `message` ("found by transaction") and one of kind `transaction`. The message result has `id` of the form `message:<message id>` and `target.messageId`; use that id with `/api/messages/<id>`.
3. Recent transfers of a wallet, or by status:

   ```sh
   curl -s "https://indexer.zkb.fi/api/feed?address=<wallet>&limit=20"
   curl -s "https://indexer.zkb.fi/api/feed?status=covered&limit=20"
   ```

   `/api/feed` takes `direction` (`1>369` form, source then destination chain id), `kind` (`token` or `message`), `status` (one value or a comma list), `token`, `address`, `from`, `to` (Unix seconds), `limit` (1 to 200, default 50) and `cursor` (the `nextCursor` of the previous page). It returns `{ items, nextCursor }`, newest send first.

## Expected result

Read the `status`. These are the values of `MESSAGE_STATUSES` in `@zkb/data`, in order of a transfer's life:

| Status | What it means | What the dapp says |
|---|---|---|
| `sent` | The send is on the source chain and younger than the finality window. | "Sent · waiting for finality" |
| `waiting_for_finality` | The send is older than the finality window and no stored head covers it yet. The bridge is waiting for a proof. | "Final soon · waiting for the proof" |
| `covered` | The destination light client stored a head whose execution block is at or after the send. Anyone can now deliver it. | "Proven · waiting for a deliverer" (with the wait, such as "for 12 min") |
| `delivered` | The destination bridge executed it and the call succeeded. A delivery whose call fails reverts as a whole, so the message stays `covered` and anyone can deliver it again with more gas. | "Delivered to <chain>" |
| `release_failed` | Executed, but the recipient could not take the tokens. Final: the tokens stay in the token mediator. | "The release failed" |

- In flight means `sent`, `waiting_for_finality` or `covered`.
- The finality window is two epochs of 32 slots: 768 seconds on Ethereum and Sepolia (12 s slots), 640 seconds on PulseChain and PulseChain testnet v4 (10 s slots).
- A transfer normally takes about 13 to 15 minutes end to end. In the dapp, a `covered` transfer that is still undelivered after 30 minutes moves to the **Needs you** tab, and so does `release_failed`.

## If it fails

- **"Not found" in the dapp, or 404 `unknown message` from the API.** The indexer has not indexed the send yet (it follows both chains and can lag), or the id is wrong. Check that the id is 0x and 64 hex digits (the API answers 400 `invalid message identifier` otherwise), and that you used the message id, not a transaction hash. Try the search with the transaction hash. Wait a few minutes and ask again.
- **The send was made but Activity shows it as `sent` for a long time.** Compare the time since sending with the finality window above. Inside the window, nothing is wrong.
- **`waiting_for_finality` for much longer than the window.** The destination light client has no head that covers the send. A proof is needed. See `deliver-it-yourself` (it covers requesting a proof) and check the light client heads with `read-bridge-data` (`/api/heads`, field `lagSeconds`).
- **`covered` and not delivered.** No bot delivered it. This usually means the fee was below what a bot needs at today's gas price. See `deliver-it-yourself`.
- **`release_failed`.** Final; the bridge never runs a message twice. The tokens stay in the mediator with no claim and no fallback address.
- **A delivery reverted.** Not a status: a delivery that runs out of gas, or whose call fails, reverts and leaves the message `covered`. Deliver it again with more gas (see `deliver-it-yourself`).
- **The search finds only a `transaction` and no message.** The hash may belong to a light client update, or to a transaction the indexer does not store. A result with `confirmed: false` means only the shape fits.

<!-- TODO: confirm that https://indexer.zkb.fi is the public, stable address to document for the indexer API; it is taken from ZKB_SITES in explorer/data/src/search.ts and answered correctly when tested on 2026-11-06. -->
<!-- TODO: confirm the exact on-screen text of the line under the status on the message page; only the STAGES labels (Sent, Waiting for finality, Covered, Delivered) were read in explorer/web/src/views/proof-panel-model.ts. -->

## References

- `getting-started`: "Follow your transfer".
- `settings-and-explore`: search and Explore.
- `fees-explained`: why a low fee leaves a transfer `covered`.
- `how-the-bridge-works`: light clients, proofs and finality.
- `deliver-it-yourself`, `read-bridge-data`.

---
name: deliver-it-yourself
description: Delivers a bridge transfer that no bot delivered, from the dapp's message page, by requesting a proof, posting the light client update and running the delivery on the destination chain. Use when a transfer is stuck in covered (or waiting for finality) or sits under Needs you on the Activity screen.
kind: skill
title: Deliver a transfer yourself
summary: Finish a stuck transfer with the Proof and delivery panel; costs destination-chain gas, pays no fee.
audience: [user]
chains: all
verified_release: 0.1.2-next.14
---

# Deliver a transfer yourself

## When to use

- A transfer is `covered` (proven) and undelivered, and the person does not want to wait for a bot. The dapp moves a covered transfer to **Needs you** on the Activity screen after 30 minutes.
- A transfer is `waiting_for_finality` for much longer than the finality window (768 s from Ethereum or Sepolia, 640 s from PulseChain or PulseChain testnet v4), so it needs a proof first.
- The transfer was sent with the **Yourself** delivery choice (no fee, no bot).

Check the status first with `check-transfer-status`. Do not use this for `delivered` or `release_failed`: those are final.

## Preconditions

- A wallet connected in the dapp, holding enough of the destination chain's native coin (PLS on PulseChain and PulseChain testnet v4, ETH on Ethereum and Sepolia) for the delivery gas.
- The message id or the source transaction hash (see `check-transfer-status`).
- Endpoints set in Settings > Connections: the Archive URL (it serves the evidence of the message; the Backend URL answers when no archive is set), the Msgboard indexer URL or the Msgboard node URL (where proofs are read), and the Backend URL (to request a proof). The dapp ships defaults; the panel names any that is missing.
- Delivering directly on the bridge pays no fee to anyone, and the recipient gets the whole amount. You pay only gas.

## Steps

### Start from Activity

1. Open **Activity** and the **Needs you** tab.
2. On the transfer, read the line above the button. For a covered transfer it says "The tip is below what a delivery bot needs at today's gas price (<gas amount>)." For another unfinished transfer it says "This transfer did not finish; you can finish it yourself."
3. Tap the button **Deliver it yourself · <gas amount> <coin>**. It opens the message page of the transfer. The amount is the dapp's estimate of the gas on the destination chain.
4. If the button is greyed, hover it or focus it. The tooltip says why. Without a wallet: "Connect a wallet to deliver it yourself." With too little coin: "Your wallet holds <held> <coin> on <chain>; delivering needs about <needed> <coin>. Add <missing> <coin> on <chain> to deliver it yourself."

You can also open the message page directly from search (see `check-transfer-status`).

### The Proof and delivery panel

On the message page, under "Prove and deliver it yourself", the panel titled **Proof and delivery** shows:

- The stages, with the current one in bold: **Sent** (the block is not final yet), **Waiting for finality** (the block is final; the destination light client has no head that covers it), **Covered** (the light client holds a head that covers the send; anyone can deliver), **Delivered** (it runs only once).
- **Latest proof for this direction**: where the proof came from (msgboard indexer or msgboard node) and the slots it moves the head between ("from slot <a> to slot <b>").

Then act by stage:

5. **Stage Waiting for finality: tap Request a proof.** It asks the backend to prove. The panel shows the request id and a status: "Waiting in the queue.", "The prover is working on the proof.", "The proof is on the msgboard. Post the light client update.", "The light client holds the proof.", or "The request failed." with a reason. A proof takes about 30 to 75 seconds to make on the remote prover once it starts.
6. **Tap Post the light client update** once a latest proof is shown. The dapp reads the light client's head again from the chain, checks that the proof starts at that head, and opens the review. Sign it (see step 9). The light client on the destination chain, `{{contracts.943.lightClient}}` on PulseChain testnet v4 or `{{contracts.11155111.lightClient}}` on Sepolia, then stores the new head and the message becomes `covered`.
7. **Stage Covered: tap Deliver the message.** When the evidence lists layout calls that must come first, the panel shows them as checkboxes ("Clear a layout row that the chain already holds. The delivery itself always runs."). Leave them ticked unless you know the chain already holds that row. The delivery itself cannot be cleared.
8. The delivery runs the message on the destination bridge, `{{contracts.943.bridge}}` or `{{contracts.11155111.bridge}}`.
9. In the dialog "Review before you sign", check each transaction (Chain, From, Contract, Function, Value sent), tap **Send to wallet**, and sign in the wallet. When the dialog says "Done. Every transaction is confirmed.", tap **Close**.

## Expected result

- After the update is mined, the stage moves to **Covered**; after the delivery is mined, to **Delivered**, and the panel disappears (it only shows while the message is unfinished).
- The recipient receives the whole amount (no fee is taken on a direct delivery). Activity shows the transfer under **Delivered**.
- Your cost is the gas of the update (if you posted it) and of the delivery, both on the destination chain. The button on Activity shows the dapp's estimate of it before you start. The proof check inside a delivery measured 290,655 gas in the bridge's own test.

## If it fails

Each button greys out with its reason printed under it. The texts below are the ones the dapp prints.

- **"Set the Backend URL in Connections to ask for a proof."** Set it in Settings, or wait for a bot.
- **"The message is delivered. No proof is needed." / "The light client already covers this message. No proof is needed."** Nothing to do for the proof.
- **"The block of the send is not final yet. A proof can cover it after finality."** Wait for the finality window.
- **"No proof is available to post. Request a proof first, or set the Msgboard indexer URL or the Msgboard node URL in Connections."** Tap **Request a proof**, or fix the endpoints.
- **"Connect a wallet to post the update." / "Connect a wallet to deliver the message."** Connect the wallet.
- **"The light client does not cover this message yet. Post a proof first."** Do steps 5 and 6.
- **"The evidence is loading."** Wait. The panel re-reads on a timer.
- **"The archive holds no evidence for this message." / "The archive is not running on this backend." / "No archive is set. Set the Archive URL in Connections." / "The archive did not answer."** The dapp cannot build the delivery without the evidence of the message. Try again later or set the Archive URL.
- **"The evidence is for a different message." / "The evidence is for a different source transaction."** The server sent evidence of another message. The dapp refuses to deliver it. Do not work around it.
- **"The page could not read the head of the light client. Check the RPC setting for the chain in Connections."** Fix the RPC endpoint of the destination chain.
- **A proof request notice.** "The backend limits requests. Try again in <n> seconds." / "The backend sees no message waiting for a proof, so it starts no proving run. Its chain indexer may not have seen this message as final yet." / "The backend could not check whether a proof is needed. Try again in <n> seconds." / "The backend did not accept the request. Try again later."
- **The update is refused after you tap Post.** Another party posted first, so the proof no longer starts at the stored head. The panel shows the reason and reloads the latest proof; check whether the message is already `covered`.
- **The delivery reverts.** A bot may have delivered it first (the bridge runs a message once), or the light client has not stored a head that covers the send yet (the contracts name these cases `AlreadyDelivered` and `AnchorNotStored`). Check the status again.
- **The wallet or a transaction fails.** The dialog shows the error with **Close** and **Try again**.

<!-- TODO: the contract names bridge and lightClient in the placeholders follow the keys of GET /api/pair (contracts.bridge, contracts.lightClient). Confirm they match the name keys of contracts.json when the platform lands. -->
<!-- TODO: I did not confirm in the code whether the dapp shows the delivery gas for a covered transfer from a measured value or from the 1e15 wei fallback; the Activity button uses the delivery-cost report and falls back to 0.001 of the native coin when the report has none. -->
<!-- TODO: "about 30 to 75 seconds" for a proof comes from explorer/bots/README.md ("one POST /prove that answers when the proof is ready, 30 to 75 seconds"); the user-facing wait for a queued request was not measured. -->

## References

- `fees-explained`: "Yourself" and "Needs you".
- `how-the-bridge-works`: light clients and proofs.
- `settings-and-explore`: Connections.
- `check-transfer-status`, `bridge-tokens`.

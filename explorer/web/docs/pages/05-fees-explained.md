---
title: "Fees explained"
summary: "You pay one fee for a transfer, and it covers everything needed to deliver it: the delivery gas, the proof and a tip for whoever delivers. The bridge contracts take nothing on top."
audience: [user, deliverer]
chains: all
verified_release: 0.1.0
---

# Fees explained

You pay one fee for a transfer, and it covers everything needed to deliver it: the delivery gas, the proof and a tip for whoever delivers. The bridge contracts take nothing on top.

## One fee

The fee comes out of the amount you send. What arrives is the amount less the fee. The fee has three parts.

| Part | What it pays for |
|---|---|
| Delivery gas | The gas of the delivery transaction on the destination chain, at your gas level. |
| Proof | $0.025, the cost of generating the proof. It is part of the fee, not a separate payment. |
| Tip | What the deliverer keeps once the gas and the proof are paid. |

The delivery gas and the proof together are the **cost** of your transfer. Every rule on this page sets the fee against that cost.

## The delivery control

Under the amount you send sits one control with three parts.

| Part | What it shows | What a tap does |
|---|---|---|
| Take my money | Who delivers and the fee, such as "A bot delivers it · 0.39%" | Opens the delivery menu |
| Gas can and bars | Your gas level | Moves to the next level: Low, Normal, High, then Low again |
| Clock | The time to arrival, such as "~16 min" | Lists every step with its estimate |

Hold the pointer on any part, or focus it with the keyboard, to read the whole sentence. Tap the same part again, tap elsewhere or press Escape to close what it opened.

The delivery menu holds every fee setting in one place:

- **Who delivers**: Automatic, Share, Fixed, Gas-based or Yourself.
- The value of that choice, such as the tip as a share of the amount.
- The gas level.
- The automatic fee cap and the hard fee cap.
- What the fee covers: delivery gas, proof, the extra or saving of your gas level, tip, and the fee in total.
- **Advanced**: the relay router, and a call after delivery with the exact gas the call gets.

## The default fee

Unless you choose otherwise, the fee is automatic. It follows a curve in dollars: 1% of the amount at $10 and below, sliding down to 0.1% at $500 and above. The curve is the same on every chain.

| Amount | Default share | Default fee |
|---|---|---|
| $10 | 1% | $0.10 |
| $25 | 0.58% | about $0.14 |
| $50 | 0.39% | about $0.19 |
| $100 | 0.26% | about $0.25 |
| $250 | 0.15% | about $0.37 |
| $500 | 0.1% | $0.50 |
| $1,000 | 0.1% | $1.00 |

Two rules hold the curve in place:

- **At least twice the cost.** The fee is never below twice the cost of your transfer, so a bot always earns a margin. Where gas is expensive, such as delivery on Ethereum, this floor sets the fee.
- **No more than the automatic fee cap.** The automatic fee stops at your automatic fee cap, 1% of the amount unless you change it.

The cost is read live. When gas rises, the floor rises with it, and the fee follows by itself.

Without a dollar price for the token or for the destination's coin, as on the testnets, the fee cannot be valued, so the automatic fee is your automatic fee cap: 1% of the amount unless you change it. A tip of at least 1% of the amount counts as paying: the zkb.fi runner delivers it straight away, and its proof starts once the send is final. A smaller tip is delivered by the zkb.fi runner once it has waited an hour.

## The gas level

The bars beside the gas can set how much gas price you allow the deliverer. Today's gas price is the anchor. Over the next 15 minutes the real price could land lower or higher, and the gas level decides how high you let it go.

| Level | The deliverer may pay up to | Expected cost |
|---|---|---|
| Low | 2 × today's base fee | 1 × today's cost |
| Normal | 3 × today's base fee | 1.5 × today's cost |
| High | 5 × today's base fee | 2.5 × today's cost |

Normal is where every transfer starts. A link that sets no gas level also means Normal.

High gives a bot more room to deliver when gas jumps. It also raises the fee, in every fee choice, by the extra cost it is expected to bring. Low gives a bot less room and costs less than Normal. The breakdown shows the difference to Normal on its own line, with a plus for the extra and a minus for the saving.

In the menu, the gas level shows as a range on a track, with today's gas marked as the anchor. A line under it reads, for example: "Anchored at today's gas · could land between $0.18 and $0.31 over 15 min".

## The two fee caps

You set two limits on the fee, both as a share of the amount.

| Cap | Default | What it does |
|---|---|---|
| Automatic fee cap | 1% | The most the automatic fee may take. When the cap holds the fee below twice the cost, the low-fee warning stays on. |
| Hard fee cap | 2% | The most the fee may ever be, in every fee choice. A fee above it stops the Bridge button. |

The automatic fee cap can never be above the hard fee cap. Lowering the hard cap below it brings the automatic cap down too.

When the fee is above the hard cap, the Bridge button turns grey and reads "Fee above your 2% cap". A "Raise cap to …" button right under it raises the cap to the smallest step that admits the fee. For a gas-based fee, the hard cap checks the most the fee could reach, not only the fee today.

The menu draws both caps as ranges: the span the fee could land in is shaded on each track, so you see how close it comes to each cap.

A change to a cap in the menu applies to this transfer. The save button beside a cap (a floppy disk) makes it your default. You can also set both caps in Settings. Your caps stay in this browser. A link can set the automatic cap for one transfer, never above your hard cap, and the page names it as a field the link filled in.

## When the Bridge button warns

The Bridge button tells you what will happen before you sign.

| The button | Means |
|---|---|
| Solid | Ready to bridge. |
| Orange outline | A warning. Read the line under it. You can still go ahead. |
| Grey | Blocked until you fix what the line under it says. |

The warnings about the fee are these. The page shows one at a time, the most important first.

| Warning | When it shows | What you can do |
|---|---|---|
| Small transfer · may not be delivered in a timely manner | The cost is more than your automatic fee cap allows for this amount. | Raise the automatic fee cap, send more, or deliver it yourself. |
| Low tip · may take about an hour longer | The fee is under twice the cost, or, without a dollar price, under 1% of the amount. Bots are likely to skip it; the zkb.fi runner delivers it once it has waited an hour. | Raise the tip, or deliver it yourself. |
| High cap % | The tip, the part of the fee above the cost, is a large share of the amount: over 1% up to $100, over $1 between $100 and $1,000, over 0.1% from $1,000. | Lower the tip. A lower tip still gets delivered. |

"High cap %" does not show for a small transfer: there, any fee that covers the cost is a large share.

Without a dollar price, "Low tip" compares the fee with 1% of the amount, and "High cap %" compares the whole fee with 1% of the amount.

## Who delivers: the fee choices

Open the delivery menu and choose under **Who delivers**. The text in the control always says what will happen.

| Choice | You set | The control says | Known when you sign |
|---|---|---|---|
| Automatic | Nothing: the default fee | A bot delivers it · 0.39% | Yes |
| Share | The tip, as a share of the amount | A bot delivers it · 0.44% | Yes |
| Fixed | The fee, in the token | A bot delivers it · 0.50 USDC | Yes |
| Gas-based | A multiple of the gas cost | A bot delivers it · follows gas | No, it can change up to a limit |
| Yourself | Nothing: no fee | You deliver it | There is no fee |

### Share

You set the tip, the part above the cost, as a share of the amount. The fee you sign is the cost at your gas level plus that tip. When you change the gas level, your tip stays the same and the fee moves by the cost.

### Fixed

You set the whole fee as an amount of the token. It stays the same whatever gas costs. A fixed fee below twice the cost brings the low-fee warning.

### Gas-based

The fee is worked out at delivery from the gas actually spent, times the multiple you set ("× gas cost"). It follows gas up and down, but never past the limit you sign. That limit is your automatic fee cap's share of the amount.

The review shows how far the fee can move, for example "$0.42 now, up to $0.60 if gas rises to the Normal ceiling". When the most the fee could reach would be a "High cap %", the review warns and lets you lower the cap right there.

### Yourself

No fee and no router. The page sends a plain transfer, and anyone can deliver it on the bridge for free, including you. It can take longer, because no bot is paid to do it. When your transfer is proven and still waits 30 minutes after you sent it, it moves to "Needs you" on the Activity screen, with a "Deliver it yourself" button. The button shows the gas it needs on the destination chain, and stays disabled while your wallet there holds too little.

## Every value is yours to set

Each value in the menu is one control: a slider with tick marks, an exact field next to its unit, and a mark for the recommended value. This holds for the tip share, the fixed amount, the gas multiple, the gas level and both caps.

- **Reset to recommended** shows while the value differs from the recommendation.
- After a reset, a **Back to your …** button appears in the same place, for example "Back to your 0.44%". It stays until you change something else.
- The ticks are named under the track: "2× cost", "high cap", "auto cap", "Low", "High" and "recommended". When two names would touch, one is left out and named in the control's ? help instead.

The tip slider in the Share choice and the same value elsewhere are one value: move either and every number follows.

## What exact and estimate mean

**Exact** means the fee is known to the smallest unit before you sign. The automatic, Share and Fixed choices are exact.

**Estimate** means the real fee can differ. A gas-based fee is an estimate. It never goes above the limit shown before you sign.

## The data source of each number

| Number | Where it comes from |
|---|---|
| Dollar prices | PulseX pools on PulseChain, read through your RPC endpoint at one block. |
| Delivery gas | The 90th percentile of recent deliveries measured by the indexer, or 600,000 gas when none is measured yet. |
| Base fee and priority fee | The destination chain, through your RPC endpoint. |
| Proof | A set figure of $0.025. |

Prices are for display and for choosing the default fee and its warnings. The zkb.fi backend and runner read the same PulseX pools by the same rules to decide whether a tip pays. What you sign is a share of the amount or an amount of the token, so the fee itself does not depend on a price after you sign. The testnets have no prices: the menu then shows the fee as a share, with ticks for what a bot needs to break even and for a typical fee.

Every rule on this page gives the same answer for the same inputs, in this app or any other that uses the same rules. Money is counted in whole units, and any rounding goes down, in your favour.

## Who receives the fee

When a bot delivers, it goes through the delivery router on the destination chain. The router pays the fee to its reward address and the rest to the recipient. The router fixes this address when it is deployed, and nobody can change it. A copied delivery earns the copier nothing.

If the router cannot pay the recipient, it pays the fee first and hands the rest to its failed delivery address, also fixed at deployment. The review reads both addresses from the router and shows them before you sign.

Anyone can also deliver directly on the bridge, without the router. A direct delivery pays no fee, and the recipient gets the whole amount.

## The relay router

The Advanced part of the menu has a field named "Relay router". It starts with the default delivery router of the destination chain. You can name another router. The review shows the router, and warns when it is not the default: the fee terms are written for the delivery router, and another router can read them in a different way. Use another router only if you trust it.

## When a transfer cannot carry a fee

Two transfers carry no fee, and the page says why on the screen:

- Bridging the native coin (ETH or PLS) wraps and sends it in one call, which has no room for fee terms.
- A destination chain with no delivery router.

Both are delivered like the Yourself choice.

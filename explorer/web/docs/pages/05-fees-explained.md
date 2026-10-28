# Fees explained

The bridge charges no fee. The only extra is the tip for delivery. A tip goes to the reward address of the delivery router. It is voluntary, and it buys no promise. A low tip, or no tip, never makes a delivery fail. This page explains it.

## The tip for delivery

Anyone can deliver a covered transfer. A tip is never a promise, and nothing makes a delivery wait for a tip. The tip is the one thing that you set. The interface turns the tip on by default. The default is the gas based mode at the base fee, and it equals the measured gas cost of a delivery. Its limit is the price ceiling, at twice the base fee now. The deliverer's gas choice decides how much of the limit the tip takes, so expect the tip to reach the limit. You can edit the tip, change its mode to percentage or fixed, or remove it with the choice "No tip".

When you add a call (a Call target and Call data on the bridge form), the tip counts the gas that the call may use. A gas based tip then moves toward its limit. The page Bridging tokens explains the call.

You fix the tip when the transfer leaves. Nothing at delivery sets or changes it. The deliverer supplies no rate.

The interface sends your tokens to a router on the destination chain, with `relayTokensAndCall`. The router is the receiver of that call. Your tip settings travel in the call data. When you choose "No tip", the interface involves no router at all. It sends a plain relay (`relayTokens`) with no fee terms, and the tokens go straight to the receiver. No router can take a fee. Anyone can still deliver the message directly on the bridge, for free, but it may take longer. The confirm dialog says that no router is involved.

## Who can collect the tip

Anyone can deliver through the router. The router has no list of allowed runners.

The router pays the tip to its reward address. The router sets this address when it is deployed, and nobody can change it. The tip comes from your tokens. The recipient gets the rest. A copied delivery gains the copier nothing, because the tip goes to the reward address and not to the account that calls the router.

## When the router cannot deliver

The router can fail to deliver the tokens to the recipient. Then it pays the tip first. It hands the rest of the tokens to its failed delivery address. The router sets both addresses when it is deployed, and nobody can change them.

The confirm dialog reads both addresses from the router on the destination chain. It shows them as "Tip goes to" and "If delivery fails". When the page cannot read an address, the dialog says so and names no address. Check the router before you sign.

## A direct delivery pays no tip

The bridge stays open to everyone. Anyone can call the bridge directly to deliver your message. This is a direct delivery. A direct delivery does not go through the router, so nobody pays a tip. The recipient gets the whole amount. A direct delivery costs you nothing. It only means that nobody is paid.

## When the transfer cannot carry a tip

Two cases cannot carry a tip. In both cases the interface sends a plain relay and tells you why on the form.

- The wrap route. It wraps the native coin and relays it in one call. This call has no call data, so it has no place for the tip.
- A destination chain with no delivery router in the deployment.

## The router field

The form has an advanced field named "Router". It starts with the default delivery router on the destination chain. You can name another router. The confirm dialog shows the router address. It marks a router that is not the default delivery router. The tip settings are written for the delivery router. Another router can read them in a different way. Use it only if you trust it.

## The suggested range

The interface suggests a low range of tips. It is a range, not a price. Each end is a multiple of the measured gas cost of a delivery at the base fee.

- Low: half of the cost.
- Suggested: the cost.
- High: one and a half times the cost.

The range is low on purpose, so that the bridge is cheap next to other bridges. Choose one end with one click, or type your own number. In the gas mode the lowest tip is just above zero. For a tip of zero, choose No tip or a fixed amount of 0. A tip below the cost is allowed. Another interface may suggest another range.

A tip below the cost is allowed and never makes a delivery fail. Anyone can still make the delivery.

## The modes

The router knows three tip modes. Each one sets the tip in a different way.

- Percent of the value: the tip is a share of the tokens that arrive.
- A fixed amount: the tip is one set number of tokens.
- A gas based tip: the tip is the gas that the deliverer's transaction makes available, times the gas price and a multiplier, up to the limit.

The settings flags that carry the mode have these names: `FIXED_FEE` (a fixed amount), `MULTIPLIER_OF_TOTAL` (percent of the value), `EXCLUDE_PRIORITY` (price the gas at the base fee only, with no priority fee) and `UNWRAP` (pay in the native coin). A fixed amount wins over a percentage when both flags are set. With neither mode flag, the tip is gas based.

The form offers these modes. Each one has a label that tells you how sure the amount is.

### Percentage

You pay a share of the transfer value. The default is 0.1 percent. You can type another share. The amount is exact. The label reads "exact". This mode needs no price.

### Fixed

You pay a fixed amount, in whole tokens. If you leave the amount empty, the form suggests one that covers the cost plus a margin. The suggestion needs your coin price. The amount is exact.

### Gas based, up to the limit

This is the default mode. You pay for the gas that the deliverer's transaction makes available, times the gas price and a multiplier. The limit is the price ceiling: the tip never goes above it. This mode works for any token.

The deliverer chooses the gas limit of the transaction. The bridge forwards only the message gas limit, so gas that the deliverer holds back above it counts. For this reason the deliverer's gas choice decides the tip. Expect the tip to reach the limit.

The amount is an estimate. The label reads "estimate, at most X". X is the limit, in the units of your token. The form and the confirm dialog show the limit as the price ceiling.

The default has these terms:

- The gas price is the base fee only. The router flag `EXCLUDE_PRIORITY` sets it.
- The tip equals the measured gas cost. The multiplier is 1. The page turns it into token units with your coin price: the multiplier is your price of one wei, times 1, times 1e18, rounded up.
- The limit is the tip at the ceiling base fee. The ceiling is twice the base fee now. The delivery gas comes from the indexer (the 90th percentile of recent deliveries), or, with no measure, from the larger of 550000 gas and the gas that a delivery must supply for the least gas limit of its kind.

Some chains report no base fee. On such a chain the base fee flag would make the tip zero. The default then reads the whole gas price, with the same multiplier, and the form says why.

If you have typed no coin price and the page knows no value of the token, the page cannot compute the gas based tip. It shows a notice that asks you to enter your price. There is no fixed fallback: a fixed amount needs the same price to turn a cost into tokens. The percentage and fixed modes stay available.

### Your coin price

The gas based mode needs a price: how many tokens one native coin of the destination chain is worth. The field "Your coin price" holds it. The price is your own. The page cannot verify it, and nothing at delivery reads it. The interface folds the price into the multiplier when the transfer leaves. For the wrapped native token, the field starts at 1. For another token, you type it.

## What exact and estimate mean

Exact means the fee is known to the smallest unit before you sign. Estimate means the real fee can differ. An estimate never goes above the stated maximum.

The most that the tip can take is shown before you sign. Check this number. It is the most you can pay in tip.

## The cost breakdown

The form shows two lines when it knows your coin price. Every line is an estimate.

- Gas cost: the delivery gas, times the base fee plus the priority fee.
- Margin: the tip minus the gas cost. A margin below zero means that the tip is below the cost. That is allowed.

The suggestion for the fixed amount uses a margin of 10 percent by default. The gas based default is the cost itself, so its margin is zero. A runner sets its own rule about margins.

The cost counts the gas of the delivery only. A tip is not a payment for any other work.

## The data source line

Each suggestion shows where its gas figure comes from. You see one of two lines.

- "measured from N recent deliveries, p90": the indexer measured N real deliveries. It uses the 90th percentile of their gas.
- "default, no deliveries measured yet": no delivery is measured. The page uses the larger of the configured default of 550000 gas and the gas that a delivery must supply for the least gas limit of its kind.

The default is a computed figure, not a measurement. The figures improve by themselves as the indexer records more deliveries.

## Base fee time

The form also shows the base fee that it used. It names the block and the time of that block. For example: base fee 7 gwei at block 12.

The base fee changes from block to block. Check the time. An old base fee gives a weak estimate.

## Payout

For the wrapped native token, you can ask the router to pay the tip in the native coin. This option unwraps the token first. It exists only for the wrapped native token. For every other token, the router pays the tip in that token, and the interface refuses a request to unwrap it.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { nativeSymbolOf } from "@zk-bridge/shared";
import type { FeedItem, TokenInfo } from "@terminal/model/types";
import { useDeliveryCost, useSnapshots } from "../app/queries";
import { formatRoute } from "../app/route";
import { useServices } from "../app/services";
import { useWallet } from "../wallet/wallet-port";
import { dayOf, groupOf, leftText, positionOf, relativeTime, secondsLeft, stepsOf, stepWords, type ActivityGroup } from "./activity-model";
import { amountText, chainsFor } from "./bridge-model";
import { Chevron, GasCan } from "./icons";
import { iconSubjectOf } from "./image-source";
import { Num } from "./Num";
import { settlePending, usePending } from "./pending";
import { selfDeliveryState } from "./self-delivery";
import { StepList } from "./StepList";
import { TokenIcon } from "./TokenIcon";

type Tab = "all" | ActivityGroup;

/**
 * The pulse at real pixel size (owner, matched): a 4 px track, a 22 × 8 pill, stops of radius 1.8, end dots of radius
 * 5.5; solid colours, lit behind the pill, dark ahead; the destination dot lights when delivered.
 *
 * @param props Where the transfer is, 0 to 1, and what it says to screen readers.
 */
export const ActivityPulse = ({ position, label }: { readonly position: number; readonly label: string }) => {
  const p = Math.min(1, Math.max(0, position));
  const done = p >= 1;
  const at = (share: number): string => `calc(11px + (100% - 22px) * ${share})`;
  return (
    <div className="zb-apulse" role="img" aria-label={label} data-position={p}>
      <span className="zb-apulse-track" />
      <span className="zb-apulse-lit" style={{ width: done ? "calc(100% - 22px)" : `calc((100% - 22px) * ${p})` }} />
      {[1 / 3, 1 / 2, 2 / 3].map((stop) => (
        <span key={stop} className="zb-apulse-stop" data-passed={stop <= p} style={{ left: at(stop) }} />
      ))}
      {done ? null : <span className="zb-apulse-pill" style={{ left: at(p) }} />}
      <span className="zb-apulse-end" data-end="source" style={{ left: 0 }} />
      <span className="zb-apulse-end" data-end="destination" data-lit={done} style={{ right: 0 }} />
    </div>
  );
};

const Route = ({ from, to }: { readonly from: number; readonly to: number }) => (
  <span className="zb-route" aria-hidden="true">
    <TokenIcon subject={{ chainId: from }} symbol="" size={16} decorative />
    <Chevron dir="right" />
    <TokenIcon subject={{ chainId: to }} symbol="" size={16} decorative />
  </span>
);

/**
 * The Activity screen (one of three, left of Bridge): the wallet's transfers in both directions, sent and received,
 * from the indexer's feed filtered by the address, plus transfers just submitted. Flat tabs; cards for transfers in
 * flight and those that need the user; delivered rows by day that open in place to the joined step list.
 */
export const ActivityScreen = () => {
  const { pair, dataSource } = useServices();
  const wallet = useWallet();
  const account = wallet.status === "connected" ? wallet.account : null;
  const feed = useQuery({
    queryKey: ["activity", pair.id, account],
    enabled: account !== null,
    queryFn: () => dataSource.getFeed(pair.id, { address: account as Address }, 100),
    refetchInterval: 15_000,
  });
  const pending = usePending();
  const snapshots = useSnapshots(account, pair.id).data ?? [];
  const [tab, setTab] = useState<Tab>("all");
  const [open, setOpen] = useState<string | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const items = feed.data?.items ?? [];

  useEffect(() => {
    settlePending(new Set(items.map((item) => item.sourceTransactionHash.toLowerCase())));
  }, [items]);

  const rows: readonly FeedItem[] = useMemo(
    () => [
      ...pending.map((entry): FeedItem => ({ id: entry.sourceTransactionHash, kind: "token", direction: entry.direction, status: "sent", sender: account ?? ("0x" as Address), recipient: account ?? ("0x" as Address), token: entry.token, amount: entry.amount, sentAt: entry.sentAt, deliveredAt: null, sourceTransactionHash: entry.sourceTransactionHash, destinationTransactionHash: null }) as FeedItem),
      ...items,
    ],
    [pending, items, account],
  );
  const counts = { "in-flight": 0, "needs-you": 0, delivered: 0 } as Record<ActivityGroup, number>;
  for (const row of rows) counts[groupOf(row, now)] += 1;
  const shown = rows.filter((row) => tab === "all" || groupOf(row, now) === tab);
  const moving = shown.filter((row) => groupOf(row, now) !== "delivered");
  const delivered = shown.filter((row) => groupOf(row, now) === "delivered");

  const tokenIcon = (token: TokenInfo | null, size = 22) =>
    token === null ? null : (() => {
      const subject = iconSubjectOf(token, pair);
      return <TokenIcon subject={subject} badgeChainId={subject.chainId} symbol={token.symbol} isBridgedCopy={token.isBridgedCopy} size={size} />;
    })();
  const amount = (row: FeedItem) =>
    row.token === null || row.amount === null ? (
      "Message"
    ) : (
      <>
        <Num text={amountText(row.amount, row.token.decimals)} /> {nativeSymbolOf(row.token)}
      </>
    );

  if (account === null) {
    return (
      <main className="zb-col zb-activity">
        <p className="zb-verdict" style={{ textAlign: "left" }}>Connect a wallet to see your transfers.</p>
        <button type="button" className="zb-go" data-kind="connect" onClick={() => void wallet.connect()}>
          Connect wallet
        </button>
      </main>
    );
  }

  return (
    <main className="zb-activity">
      <div className="zb-col">
        <div className="zb-tabs zb-tabs-text" role="tablist" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["in-flight", "In flight"],
              ["needs-you", "Needs you"],
              ["delivered", "Delivered"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}
              {key === "needs-you" && counts["needs-you"] > 0 ? <span className="zb-count">{counts["needs-you"]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {moving.map((row) => {
        const { source, destination } = chainsFor(pair, row.direction);
        const group = groupOf(row, now);
        const destinationSnapshot = snapshots.find((result) => result.status === "ok" && result.snapshot.chain.chainId === destination.chainId);
        return (
          <section key={row.id} className="zb-acard" data-group={group} aria-label={`${row.token?.symbol ?? "Message"} from ${source.name} to ${destination.name}`}>
            <div className="zb-col">
              <div className="zb-arow">
                {tokenIcon(row.token)}
                <b>{amount(row)}</b>
                <span className="zb-right">
                  <Route from={source.chainId} to={destination.chainId} />
                </span>
              </div>
              <ActivityPulse position={positionOf(row.status)} label={stepWords(row, destination, now)} />
              <div className="zb-arow zb-small">
                <span>{stepWords(row, destination, now)}</span>
                {group === "in-flight" ? <span className="zb-right zb-left-time">{leftText(secondsLeft(row, pair, now))}</span> : null}
              </div>
              {group === "needs-you" ? (
                <NeedsYou row={row} destinationChainId={destination.chainId} destinationName={destination.name} nativeSymbol={destination.nativeSymbol} nativeBalance={destinationSnapshot?.status === "ok" ? destinationSnapshot.snapshot.nativeBalance : null} />
              ) : null}
            </div>
          </section>
        );
      })}

      {delivered.length === 0 ? null : (
        <div className="zb-col">
          {[...new Set(delivered.map((row) => dayOf(row.deliveredAt ?? row.sentAt, now)))].map((day) => (
            <div key={day}>
              <div className="zb-pop-group" style={{ padding: "14px 0 4px" }}>{day}</div>
              {delivered
                .filter((row) => dayOf(row.deliveredAt ?? row.sentAt, now) === day)
                .map((row) => {
                  const { source, destination } = chainsFor(pair, row.direction);
                  const isOpen = open === row.id;
                  const detail = stepsOf(row, pair);
                  return (
                    <div key={row.id} className="zb-drow" data-open={isOpen}>
                      <button type="button" className="zb-arow" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : row.id)}>
                        {tokenIcon(row.token)}
                        <b>{amount(row)}</b>
                        <Route from={source.chainId} to={destination.chainId} />
                        <span className="zb-right zb-small">{relativeTime(row.deliveredAt ?? row.sentAt, now)}</span>
                        <Chevron dir={isOpen ? "down" : "right"} />
                      </button>
                      {isOpen ? (
                        <div className="zb-dopen">
                          <ActivityPulse position={1} label={`Delivered to ${destination.name}`} />
                          <StepList steps={detail.steps} current={detail.current} />
                          <a className="zb-pill" href={formatRoute({ name: "bridge", pairId: pair.id, dir: row.direction, ...(row.token === null ? {} : { form: { token: `${row.token.side}:${row.token.address}` } }) })}>
                            Bridge again
                          </a>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 && !feed.isLoading ? <p className="zb-col zb-verdict" style={{ textAlign: "left" }}>No transfers yet.</p> : null}
    </main>
  );
};

/** A transfer that needs the user: why, in one line, and "Deliver it yourself" (disabled with the reason when short). */
const NeedsYou = ({ row, destinationChainId, destinationName, nativeSymbol, nativeBalance }: { readonly row: FeedItem; readonly destinationChainId: number; readonly destinationName: string; readonly nativeSymbol: string; readonly nativeBalance: bigint | null }) => {
  const cost = useDeliveryCost(destinationChainId, { enabled: true }).data;
  const gasWei = (cost as { gasCostWei?: bigint } | undefined)?.gasCostWei ?? 10n ** 15n;
  const state = selfDeliveryState({ nativeBalance, estimatedGasWei: gasWei, symbol: nativeSymbol, chainName: destinationName });
  const [tip, setTip] = useState(false);
  return (
    <>
      <p className="zb-small" style={{ margin: "6px 0 0", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {row.status === "covered" ? <>The tip is below what a delivery bot needs at today's gas price (<GasCan /> <TokenIcon subject={{ chainId: destinationChainId }} symbol={nativeSymbol} size={14} /> <Num text={amountText(gasWei, 18)} />).</> : "This transfer did not finish; you can finish it yourself."}
      </p>
      <span style={{ position: "relative", display: "block" }} onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}>
        <a
          className="zb-go"
          data-kind={state.enabled ? "warn" : "blocked"}
          aria-disabled={!state.enabled}
          href={state.enabled ? formatRoute({ name: "message", messageId: row.id }) : undefined}
          onFocus={() => setTip(true)}
          onBlur={() => setTip(false)}
          tabIndex={0}
        >
          Deliver it yourself · <GasCan /> <Num text={amountText(gasWei, 18)} /> {nativeSymbol}
        </a>
        {!state.enabled && tip && state.reason !== null ? (
          <span role="tooltip" className="zb-tooltip">
            {state.reason}
          </span>
        ) : null}
      </span>
    </>
  );
};

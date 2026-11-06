#!/usr/bin/env bash
# Replays the warm-up sessions of the last N hours with other lead settings, from the stored observations, and prints
# what each setting would have cost: the seconds a ready worker sat idle before the due time, and the seconds a proof
# would have waited for a worker still starting. Read-only: it only selects (`PRAGMA query_only`; `-readonly` cannot open a
# WAL database that nothing has open) and prints no host, key or setting of the deployment.
#
#   scripts/warmup-replay.sh /path/to/backend.sqlite [hours=48] ["p:margin p:margin ..."]
#
# A setting is `p:margin`: the lead time is the nearest-rank p quantile of the newest 20 observations that were stored
# before the session started, plus `margin` seconds, clamped to 20..600 s (the defaults of `watch.warmup`). The cold
# start of a session is what it measured: ready_at - started_at. With a lead L and a cold start c, the worker is ready
# at due - L + c: it idles max(0, L - c) seconds, or the proof waits max(0, c - L). "recorded" is what ran.
#
# Needs sqlite3 3.25 or newer (window functions). The estimated GPU price per hour is GPU_USD_PER_HOUR (default 2.25).
set -euo pipefail

database="${1:?usage: warmup-replay.sh /path/to/backend.sqlite [hours] [\"p:margin ...\"]}"
hours="${2:-48}"
settings="${3:-0.9:0 0.75:5 0.75:0 0.5:5 0.5:0}"
price="${GPU_USD_PER_HOUR:-2.25}"
[[ "$hours" =~ ^[0-9]+$ ]] || { echo "hours must be a whole number" >&2; exit 2; }
[[ "$price" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "GPU_USD_PER_HOUR must be a number" >&2; exit 2; }
for setting in $settings; do
  [[ "$setting" =~ ^(0(\.[0-9]+)?|1(\.0+)?):[0-9]+(\.[0-9]+)?$ ]] || { echo "bad setting: $setting (use p:margin, such as 0.75:5)" >&2; exit 2; }
done

sql() { sqlite3 -cmd "PRAGMA query_only = 1;" -header -column "$database" "$@"; }

echo "== Sessions by outcome, last ${hours} h (billed time = length, the idle timeout is added per session in the summary route)"
sql "SELECT COALESCE(outcome, 'open') AS outcome, COUNT(*) AS sessions,
            ROUND(SUM(COALESCE(ended_at, started_at) - started_at) / 1000.0 / 60, 1) AS minutes_held,
            ROUND(SUM(COALESCE(ended_at, started_at) - started_at) / 1000.0 / 3600 * ${price}, 3) AS usd_at_price
       FROM warmup_sessions WHERE started_at >= (strftime('%s','now') - ${hours} * 3600) * 1000
      GROUP BY outcome ORDER BY sessions DESC;"

echo
echo "== Used sessions: recorded lead against each setting (seconds per session, averages; proof_wait_share = sessions whose proof would wait)"
union=""
for setting in $settings; do
  p="${setting%%:*}"
  margin="${setting##*:}"
  union="${union}${union:+ UNION ALL }SELECT '${setting}' AS setting, ${p} AS p, ${margin} AS margin"
done

sql "
WITH used AS (
  SELECT id, started_at, due_at, (ready_at - started_at) / 1000.0 AS cold, MAX(0, (due_at - ready_at) / 1000.0) AS idle_rec, MAX(0, (ready_at - due_at) / 1000.0) AS wait_rec
    FROM warmup_sessions
   WHERE outcome = 'used' AND ready_at IS NOT NULL AND started_at >= (strftime('%s','now') - ${hours} * 3600) * 1000),
settings AS (${union}),
recent AS (
  SELECT u.id AS sid, o.seconds AS seconds,
         ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY o.observed_at DESC, o.id DESC) AS age
    FROM used u JOIN warmup_observations o ON o.observed_at < u.started_at),
newest AS (SELECT sid, seconds FROM recent WHERE age <= 20),
ranked AS (
  SELECT sid, seconds, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY seconds) AS rank, COUNT(*) OVER (PARTITION BY sid) AS n FROM newest),
lead AS (
  SELECT s.setting, r.sid,
         MIN(600, MAX(20, CAST(r.seconds + s.margin + 0.999999 AS INTEGER))) AS lead
    FROM settings s JOIN ranked r ON r.rank = (CAST(s.p * r.n AS INTEGER) + (s.p * r.n > CAST(s.p * r.n AS INTEGER))))
SELECT 'recorded' AS setting, COUNT(*) AS sessions, ROUND(AVG(idle_rec), 1) AS idle_s, ROUND(AVG(wait_rec), 1) AS proof_wait_s,
       ROUND(1.0 * SUM(wait_rec > 0) / COUNT(*), 2) AS proof_wait_share, ROUND(AVG(cold), 1) AS cold_s
  FROM used
UNION ALL
SELECT l.setting, COUNT(*), ROUND(AVG(MAX(0, l.lead - u.cold)), 1), ROUND(AVG(MAX(0, u.cold - l.lead)), 1),
       ROUND(1.0 * SUM(u.cold > l.lead) / COUNT(*), 2), ROUND(AVG(u.cold), 1)
  FROM lead l JOIN used u ON u.id = l.sid GROUP BY l.setting;"
echo
echo "idle_s costs GPU time (about \$$(awk "BEGIN { printf \"%.4f\", ${price} / 3600 }") per second); proof_wait_s is time added to a proof."

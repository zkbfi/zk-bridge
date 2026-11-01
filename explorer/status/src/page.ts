/**
 * The status page: one HTML document with its CSS and a small script, no library and no request to any other host. The
 * script reads `/api/status` and `/api/history` and draws the rows. The colours are the tokens of the bridge screen
 * (explorer/web/src/bridge/bridge.css, Ember light and Ember dark), chosen by the system theme.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>zkb.fi status</title>
<style>
:root {
  --page: #fff7f4; --ink: #1d1817; --muted: #875745; --line: #f7c6b4; --raised: #ffffff; --accent: #eb6834; --accent-text: #c24a14;
  --good: #21763c; --warn: #c24a14; --bad: #b61537; --none: #ffe3d9;
  --step--1: clamp(14px, 0.82rem + 0.15vw, 16px); --step-0: clamp(16px, 0.9rem + 0.4vw, 19px); --step-2: clamp(24px, 1.3rem + 0.8vw, 32px);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #141110; --ink: #f4edea; --muted: #a29591; --line: #3c3532; --raised: #1d1817; --accent: #eb6834; --accent-text: #ff9b77;
    --good: #62c37a; --warn: #ff9b77; --bad: #f75b6b; --none: #2b2523;
  }
}
* { box-sizing: border-box; }
html { background: var(--page); color: var(--ink); font: var(--step--1)/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; padding: 24px 16px 64px; }
main { max-width: 1080px; margin: 0 auto; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
header svg { width: 36px; height: 36px; flex: none; }
h1 { font-size: var(--step-2); margin: 0; line-height: 1.1; }
h2 { font-size: var(--step-0); margin: 32px 0 8px; }
.banner { display: flex; gap: 14px; align-items: center; padding: 16px 18px; border: 1px solid var(--line); background: var(--raised); }
.banner .dot { width: 18px; height: 18px; }
.banner strong { display: block; font-size: var(--step-0); }
.banner span { color: var(--muted); }
.panel { border: 1px solid var(--line); background: var(--raised); }
.row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 2.4fr); gap: 8px 20px; padding: 12px 16px; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.name { display: flex; gap: 10px; align-items: baseline; font-weight: 600; }
.name .dot { transform: translateY(1px); }
.detail { color: var(--muted); margin: 2px 0 0 26px; overflow-wrap: anywhere; }
.row.down .detail { color: var(--bad); }
.row.degraded .detail { color: var(--warn); }
.dot { display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: var(--none); flex: none; }
.dot.ok { background: var(--good); } .dot.degraded { background: var(--warn); } .dot.down { background: var(--bad); }
.meta { color: var(--muted); font-size: 0.9em; margin-left: auto; white-space: nowrap; }
.uptime { display: grid; gap: 4px; align-content: center; }
.bar-line { display: grid; grid-template-columns: 34px minmax(0, 1fr) 62px; gap: 8px; align-items: center; font-size: 0.82em; color: var(--muted); }
.bar-line b { color: var(--ink); text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.bar { display: flex; gap: 1px; height: 14px; }
.bar i { flex: 1; background: var(--none); min-width: 0; }
.bar i.ok { background: var(--good); } .bar i.degraded { background: var(--warn); } .bar i.down { background: var(--bad); }
footer { margin-top: 32px; color: var(--muted); font-size: 0.9em; }
.error { border-color: var(--bad); color: var(--bad); padding: 12px 16px; margin-bottom: 16px; border: 1px solid var(--bad); }
.hidden { display: none; }
@media (max-width: 720px) { .row { grid-template-columns: 1fr; } .detail { margin-left: 24px; } }
</style>
</head>
<body>
<main>
  <header>
    <svg viewBox="0 0 32 32" role="img" aria-label="zkb.fi"><g fill="none" stroke="#eb6834" stroke-width="2"><path d="M12.51 28.18 A12.67 12.67 0 0 1 16 3.33"/><path d="M26.8 9.38 A12.67 12.67 0 0 1 24.96 24.96"/><path d="M1 19 H28.31"/><path d="M16 7 V19"/><path d="M16 17 L18.13 14.43"/><path d="M16 17 L18.67 19"/><path d="M21 7 V19"/><path d="M21 14 H21.67 A2.5 2.5 0 0 1 21.67 19"/></g><polygon fill="#eb6834" points="8,13 14,13 14,15.57 11.99,18 9.39,18 11.87,15 8,15"/><circle cx="24.5" cy="6.5" r="1.5" fill="#eb6834"/><circle cx="16" cy="28.5" r="1.5" fill="#eb6834"/></svg>
    <h1>zkb.fi status</h1>
  </header>
  <div id="error" class="error hidden" role="alert"></div>
  <div class="banner" id="banner"><span class="dot"></span><div><strong>Checking</strong><span>Reading the latest results.</span></div></div>
  <div id="sections"></div>
  <footer>
    <p id="footer">Checks run every minute from the app server. If the server is down, this page is down too: watch <a href="/api/summary" style="color:var(--accent-text)">/api/summary</a> from outside. Bars show the worst state in each slice of the window (24 hours, 7 days, 30 days); the percentage is the share of checks that were not down.</p>
  </footer>
</main>
<script>
(function () {
  var WINDOWS = ["24h", "7d", "30d"];
  var LABELS = { ok: "Working", degraded: "Degraded", down: "Down", pending: "Waiting" };
  var BANNER = { operational: ["ok", "Everything works"], degraded: ["degraded", "Something is degraded"], down: ["down", "Something is down"] };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return s + " s";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 172800) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " d";
  }
  function bar(states) {
    var node = el("div", "bar");
    (states || []).forEach(function (state) { node.appendChild(el("i", state || "")); });
    return node;
  }
  function percent(value) { return value === null || value === undefined ? "no data" : value.toFixed(value === 100 ? 0 : 2) + "%"; }

  function row(check, histories, now) {
    var node = el("div", "row " + check.state);
    var left = el("div");
    var name = el("div", "name");
    name.appendChild(el("span", "dot " + check.state));
    name.appendChild(el("span", "", check.name));
    var meta = [LABELS[check.state] || check.state];
    if (check.latencyMs !== null) meta.push(check.latencyMs + " ms");
    if (check.since !== null && check.state !== "ok") meta.push("since " + ago(now - check.since) + " ago");
    name.appendChild(el("span", "meta", meta.join(" \\u00b7 ")));
    left.appendChild(name);
    left.appendChild(el("div", "detail", check.detail));
    node.appendChild(left);
    var uptime = el("div", "uptime");
    WINDOWS.forEach(function (window) {
      var line = el("div", "bar-line");
      line.appendChild(el("span", "", window));
      line.appendChild(bar(histories[window] && histories[window][check.id]));
      line.appendChild(el("b", "", percent(check.uptime[window] && check.uptime[window].uptime)));
      uptime.appendChild(line);
    });
    node.appendChild(uptime);
    return node;
  }

  function render(status, histories) {
    var banner = document.getElementById("banner");
    var kind = BANNER[status.summary.status];
    banner.replaceChildren(el("span", "dot " + kind[0]), (function () {
      var box = el("div");
      box.appendChild(el("strong", "", kind[1]));
      box.appendChild(el("span", "", status.summary.message));
      return box;
    })());
    var sections = document.getElementById("sections");
    sections.replaceChildren();
    status.sections.forEach(function (section) {
      sections.appendChild(el("h2", "", section.title));
      var panel = el("div", "panel");
      section.checks.forEach(function (check) { panel.appendChild(row(check, histories, status.generatedAt)); });
      sections.appendChild(panel);
    });
    var stamp = status.summary.checkedAt === null ? "no check has run yet" : "last check " + ago(status.generatedAt - status.summary.checkedAt) + " ago";
    document.title = (status.summary.status === "operational" ? "" : status.summary.status + " \\u00b7 ") + "zkb.fi status";
    document.getElementById("error").classList.add("hidden");
    document.getElementById("banner").setAttribute("title", stamp);
  }

  function load() {
    var errorBox = document.getElementById("error");
    Promise.all([fetch("/api/status").then(function (r) { return r.json(); })].concat(WINDOWS.map(function (w) {
      return fetch("/api/history?window=" + w).then(function (r) { return r.json(); });
    }))).then(function (all) {
      var histories = {};
      WINDOWS.forEach(function (w, i) { histories[w] = all[i + 1].checks; });
      render(all[0], histories);
    }).catch(function () {
      errorBox.textContent = "Cannot reach the status service. The server that runs it may be down.";
      errorBox.classList.remove("hidden");
    });
  }
  load();
  setInterval(load, 30000);
})();
</script>
</body>
</html>
`;

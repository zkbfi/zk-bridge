#!/usr/bin/env python3
"""Builds zkb.fi/ui: one page that shows every UI variation from the design rounds, for sharing with colleagues.

Each mockup in screens/ is a fragment written for the brainstorming companion. Here each one renders in its own
sandboxed iframe (so their styles and scripts never collide), with the companion's component CSS. Clicking an option
marks it and puts its id in the address (#<section>/<choice>), so a link points at one variation. Nothing is stored.

  python3 design/ui/build.py      ->  design/ui/dist/ui/index.html
  cd design/ui && npx wrangler@4 deploy   (Worker zkb-fi-ui on the route zkb.fi/ui*; it takes precedence over the
                                          landing Worker's custom domain for that path only, and is outside the signed release)
"""
import html
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SCREENS = HERE / "screens"
OUT = HERE / "dist" / "ui"

SECTIONS = [
    ("decisions", "Decided so far", None, None),
    ("page", "The bridge screen", "page-v2.html",
     "The approved layout. Square panels run to the screen edges; pills are the controls. The pair and direction are "
     "chosen from the “From” pill (a menu, never a native select)."),
    ("themes", "Directions, three variations each", "themes-v2.html",
     "Ember light (D1) and Ember on black (D3) are the current favourites; E3 Monochrome for accessibility."),
    ("button", "Bridge pill on black", "ember-button-v2.html",
     "Decided: the solid off-white pill (1). It should outshout the orange band."),
    ("language", "The design language", "language.html",
     "Five shapes, all from the mark. Decided: square panels, pill controls (A)."),
    ("inflight", "In-flight tracker", "inflight-dots.html",
     "Decided: the pulse (C) for the activity list. The arc (B) is out: it adds a new curve."),
    ("themes-first", "First theme round", "themes.html", "The five starting points."),
    ("page-first", "Earlier page draft", "page-v1.html", "Before the panels became full-width bands."),
    ("layouts", "First layout round", "dapp-layouts.html", "Card plus tracker, two columns, card that turns into the tracker."),
]

DECISIONS = [
    "The first screen is the bridge: amount, token, direction, an optional other destination address, one Bridge pill.",
    "Square panels, pill controls. Panels are full-width bands to the screen edges; controls share one content edge.",
    "The pair and direction live in the “From” pill as a menu. No native selects anywhere.",
    "Design language: square-cut 3-unit strokes, one ring radius, heavy dots, the pill, the 50.4° diagonal. No other curves.",
    "Your activity uses the pulse tracker: source dot solid, destination dot faint until delivered, the pill at the current stage.",
    "Themes: Ember light (D1) and Ember on black (D3); E3 Monochrome as the accessibility theme.",
    "On black, the Bridge pill is solid off-white: the strongest thing on the screen.",
]

FRAME_CSS = (SCREENS / "_frame.css").read_text()
ROOT_VARS = """
:root { --bg-primary:#faf8f5; --bg-secondary:#ffffff; --bg-tertiary:#efebe5; --border:#ddd7cf; --text-primary:#1b1a19;
  --text-secondary:#77736d; --text-tertiary:#a9a49d; --accent:#eb6834; --accent-hover:#d9582a; --success:#2d7a3e;
  --warning:#b5651d; --error:#b00020; --selected-bg:#fdeee6; --selected-border:#eb6834; }
* { box-sizing: border-box; }
body { margin: 0; padding: 4px 2px 12px; font-family: system-ui, -apple-system, sans-serif; background: var(--bg-primary); color: var(--text-primary); }
h2 { display: none; }  /* the outer page carries the section title */
"""

# Inside each frame: mark the clicked option, tell the outer page, report the height, and accept a preselection.
FRAME_SCRIPT = """
<script>
  const section = document.documentElement.dataset.section;
  window.toggleSelect = function (el) {
    const box = el.closest('.options') || el.closest('.cards');
    if (box && box.dataset.multiselect === undefined) box.querySelectorAll('.option, .card').forEach(o => o.classList.remove('selected'));
    if (box && box.dataset.multiselect !== undefined) el.classList.toggle('selected'); else el.classList.add('selected');
    parent.postMessage({ kind: 'pick', section, choice: el.dataset.choice || '' }, '*');
  };
  const size = () => parent.postMessage({ kind: 'size', section, height: document.documentElement.scrollHeight }, '*');
  new ResizeObserver(size).observe(document.body); addEventListener('load', size);
  addEventListener('message', (e) => {
    if (!e.data || e.data.kind !== 'show') return;
    const el = document.querySelector('[data-choice="' + CSS.escape(e.data.choice) + '"]');
    if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'nearest' }); }
  });
</script>
"""


def frame_doc(section: str, fragment: str) -> str:
    return (f'<!doctype html><html data-section="{section}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><style>{ROOT_VARS}{FRAME_CSS}</style>'
            f'</head><body>{fragment}{FRAME_SCRIPT}</body></html>')


def build() -> pathlib.Path:
    parts = []
    nav = []
    for sid, title, screen, note in SECTIONS:
        nav.append(f'<a href="#{sid}">{html.escape(title)}</a>')
        if screen is None:
            items = "".join(f"<li>{html.escape(d)}</li>" for d in DECISIONS)
            parts.append(f'<section id="{sid}"><h2>{html.escape(title)}</h2><ol class="decided">{items}</ol></section>')
            continue
        doc = frame_doc(sid, (SCREENS / screen).read_text())
        parts.append(
            f'<section id="{sid}"><h2>{html.escape(title)}</h2><p class="note">{html.escape(note)}</p>'
            f'<iframe title="{html.escape(title)}" data-section="{sid}" sandbox="allow-scripts" loading="lazy" '
            f'srcdoc="{html.escape(doc, quote=True)}"></iframe></section>')
    page = PAGE.replace("__NAV__", "".join(nav)).replace("__SECTIONS__", "\n".join(parts))
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / "index.html"
    target.write_text(page)
    return target


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>zkb.fi UI</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { --bg:#fff7f2; --ink:#1b1a19; --muted:#7a5e50; --band:#eb6834; --line:#f2d6c7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121110; --ink:#f0ede8; --muted:#a39a90; --line:#2a2724; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  header { background: var(--band); color: #fff; }
  header .in, main, nav { max-width: 1240px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(16px, env(safe-area-inset-right)); }
  header .in { display: flex; align-items: center; gap: 12px; padding-block: 18px; }
  header h1 { font-size: 20px; margin: 0; }
  header p { margin: 0 0 0 auto; font-size: 13px; opacity: .9; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; padding-block: 14px; border-bottom: 1px solid var(--line); }
  nav a { color: var(--ink); text-decoration: none; border: 2px solid var(--ink); border-radius: 999px; padding: 3px 12px; font-size: 13px; font-weight: 600; }
  section { padding-block: 28px; border-bottom: 1px solid var(--line); }
  h2 { font-size: 20px; margin: 0 0 4px; text-wrap: balance; }
  .note { color: var(--muted); margin: 0 0 14px; max-width: 70ch; }
  .decided { margin: 12px 0 0; padding-left: 1.3em; max-width: 80ch; }
  .decided li { margin-bottom: 6px; }
  iframe { width: 100%; border: 0; height: 600px; display: block; background: #faf8f5; }
  .toast { position: fixed; bottom: max(16px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); border-radius: 999px; padding: 8px 16px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.on { opacity: 1; }
</style>
</head>
<body>
<header><div class="in">
  <svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true"><g fill="none" stroke="#fff" stroke-width="3"><path d="M18.76 42.26 A19 19 0 0 1 24 5"/><path d="M40.2 14.07 A19 19 0 0 1 37.44 37.44"/><path d="M1 29 H42.33"/><path d="M24 11 V29"/><path d="M24 25.5 L27.39 21.41"/><path d="M24 25.5 L28 29"/><path d="M31 11 V29"/><path d="M31 21 H32 A4 4 0 0 1 32 29"/></g><polygon fill="#fff" points="12.55,19.5 21.55,19.5 21.55,23.35 18.12,27.5 14.22,27.5 18.36,22.5 12.55,22.5"/><circle cx="36.83" cy="9.99" r="2.1" fill="#fff"/><circle cx="24" cy="43" r="2.1" fill="#fff"/></svg>
  <h1>zkb.fi UI</h1><p>Design variations, for discussion. Click any option to get a link to it.</p>
</div></header>
<nav aria-label="Sections">__NAV__</nav>
<main>
__SECTIONS__
</main>
<div class="toast" role="status" aria-live="polite"></div>
<script>
  const frames = new Map([...document.querySelectorAll('iframe')].map(f => [f.dataset.section, f]));
  const toast = document.querySelector('.toast');
  let timer = 0;
  const say = (text) => { toast.textContent = text; toast.classList.add('on'); clearTimeout(timer); timer = setTimeout(() => toast.classList.remove('on'), 1800); };
  addEventListener('message', (e) => {
    const d = e.data || {};
    const frame = frames.get(d.section);
    if (!frame || e.source !== frame.contentWindow) return;
    if (d.kind === 'size') frame.style.height = Math.min(Math.max(d.height, 200), 20000) + 'px';
    if (d.kind === 'pick' && /^[a-z0-9-]*$/.test(d.choice)) {
      const hash = '#' + d.section + (d.choice ? '/' + d.choice : '');
      history.replaceState(null, '', hash);
      const link = location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => say('Link copied: ' + hash.slice(1)), () => say(hash.slice(1)));
      else say(hash.slice(1));
    }
  });
  const [section, choice] = location.hash.slice(1).split('/');
  const target = frames.get(section);
  if (target) {
    target.loading = 'eager';
    target.scrollIntoView();
    if (choice) target.addEventListener('load', () => target.contentWindow.postMessage({ kind: 'show', choice }, '*'));
  }
</script>
</body>
</html>
"""

if __name__ == "__main__":
    print(build())

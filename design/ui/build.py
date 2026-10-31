#!/usr/bin/env python3
"""Builds zkb.fi/ui: one page that shows every UI variation from the design rounds, for sharing with colleagues.

Each mockup in screens/ is a fragment written for the brainstorming companion. Here each one renders in its own
sandboxed iframe (so their styles and scripts never collide), with the companion's component CSS. Clicking an option
marks it and puts its id in the address (#<section>/<choice>), so a link points at one variation. Nothing is stored.

  python3 design/ui/build.py      ->  design/ui/dist/ui/index.html
  cd design/ui && npx wrangler@4 deploy   (Worker zkb-fi-ui on the routes zkb.fi/ui* and next.zkb.fi/ui*; it takes precedence over the
                                          landing Worker's custom domain for that path only, and is outside the signed release)
"""
import html
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SCREENS = HERE / "screens"
OUT = HERE / "dist" / "ui"

SECTIONS = [
    ("rules", "Rules", None, None),
    ("system", "Colour and type", "@system",
     "Read from explorer/web/src/bridge/bridge.css when this page is built, so it is the code: every colour token in "
     "each theme, the band as each theme draws it, the type scale and the sizes."),
    ("built", "As built", "@built",
     "Screenshots of the running app and docs (sample data), phone in Ember on black and desktop in Ember light. "
     "Regenerate with design/ui/shots.mjs."),
]

DECISIONS = [
    "Square panels, pill controls. Panels are bands to the screen edges; controls share one content edge. The column fills the viewport, less 16 px gutters, up to clamp(640px, 40vw + 128px, 760px).",
    "Five shapes, all from the mark: square-cut 3-unit strokes, one ring radius, heavy dots, the pill, the 50.4° diagonal. No other curves.",
    "Themes: Ember light, Ember on black, Mono; System follows the device. In Ember on black the band is an ember gradient; the mark and accents stay #eb6834. Colours exist only as tokens in bridge.css.",
    "Header: mark, page name between chevrons, search pill. ⌘K, Ctrl K or / opens search; search is the band with a square close, rows, and a footer.",
    "Every value the user sets: a slider with a recommended tick, an exact input against its unit, Reset to recommended. Help is a ? ring.",
    "Gas is three bars by the gas can, explained as an anchor with a 15-minute range. Caps are shown as ranges.",
    "Words say what happens (“A bot delivers it on PulseChain · fee 0.39%”). The Bridge pill shows one verdict at a time, with the numbers and the fix.",
    "Numbers that aren't inputs collapse leading zeros (0.0₃1234); dollars show cents. Tokens always with their icon; the badge is the origin chain.",
    "Tooltips sit on a raised dark surface, never white on black. Icons on the band sit on a neutral plate.",
    "The docs use the same shell, themes and search as the app.",
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


CSS = HERE.parent.parent / "explorer" / "web" / "src" / "bridge" / "bridge.css"
THEMES = [(".theme-ember-light", "Ember light"), (".theme-ember-dark", "Ember on black"), (".theme-mono", "Mono")]


def _block(css: str, selector: str, alone: bool = False) -> dict:
    """The custom properties of the first rule whose selector list contains `selector` (or is only `selector`)."""
    import re
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for match in re.finditer(r"([^{}]+)\{([^}]*)\}", css):
        parts = [part.strip() for part in match.group(1).split(",")]
        if (parts == [selector]) if alone else (selector in parts):
            return dict(re.findall(r"(--zb-[\w-]+)\s*:\s*([^;]+);", match.group(2)))
    raise SystemExit(f"bridge.css has no rule for {selector}")


# What each colour is for, grouped by where it appears. A role is a surface with its text ("Aa" in the ink colour on
# the background, edged where the role has an edge) or a single colour. Every token in bridge.css must appear here once.
ROLES = [
    ("Page", [
        ("Page and text", "page", "ink", None),
        ("Secondary text", None, "muted", None),
        ("Quiet text", None, "soft", None),
        ("Rules and dividers", "line", None, None),
    ]),
    ("The band (what you send)", [
        ("Band and its text", "from-bg|from", "from-ink", None),
        ("Band's secondary text", None, "from-muted", None),
        ("Token pill on the band", "from-pill", "from-pill-ink", None),
        ("Square close on the band", "from-end|from", None, None),
    ]),
    ("The lower panel (what arrives)", [
        ("Panel and its text", "to", "to-ink", None),
    ]),
    ("Controls", [
        ("Pill", "pill", "pill-ink", "pill-edge"),
        ("Bridge pill, ready", "go", "go-ink", None),
        ("Bridge pill, blocked", "blocked", "blocked-ink", None),
        ("Tooltips and menus", "raised", "raised-ink", "raised-edge"),
    ]),
    ("Accent and warnings", [
        ("Accent (rules, marks, the selected edge)", "accent", None, None),
        ("Accent as text", None, "accent-text", None),
        ("Warning text and outline", None, "warn", None),
        ("Good (checks that pass)", None, "good", None),
        ("Bad (errors, failed checks)", None, "bad", None),
        ("The mark", "mark", None, None),
        ("Plate behind icons on the band", "plate", None, None),
    ]),
    ("The pulse tracker", [
        ("Track ahead", "track-ahead", None, None),
        ("Stop passed", "stop-passed", None, None),
        ("Stop ahead", "stop-ahead", None, None),
        ("The pill's core", "core", None, None),
    ]),
    ("In-flight orbits (Explore)", [
        ("Planet, token colour 1", "planet-1", None, None),
        ("Planet, token colour 2", "planet-2", None, None),
        ("Planet, token colour 3", "planet-3", None, None),
        ("Planet, token colour 4", "planet-4", None, None),
        ("Planet's core ($1,000 or more)", "planet-core", None, None),
        ("Planet's ring ($10,000 or more)", None, "planet-ring", None),
    ]),
]


def _resolve(tokens: dict, value: str) -> str:
    """A value with its var(--zb-…) references replaced by what they name in the same theme."""
    import re
    return re.sub(r"var\((--zb-[\w-]+)\)", lambda m: _resolve(tokens, tokens.get(m.group(1), "").strip()), value)


def _pick(tokens: dict, names) -> str:
    if names is None:
        return ""
    for name in names.split("|"):
        value = tokens.get(f"--zb-{name}", "").strip()
        if value:
            return _resolve(tokens, value)
    return ""


def _source(tokens: dict, names) -> str:
    """The palette colour a role points at (e.g. "tint"), or "" when the role is not a single palette colour."""
    import re
    for name in (names or "").split("|"):
        m = re.fullmatch(r"var\(--zb-p-([\w-]+)\)", tokens.get(f"--zb-{name}", "").strip())
        if m:
            return m.group(1)
    return ""


def system_fragment() -> str:
    """The theme colours grouped by role, one row per role and one sample per theme, then the sizes; read from bridge.css."""
    css = CSS.read_text()
    themes = [(name, _block(css, sel)) for sel, name in THEMES]
    used = set()
    for _, rows in ROLES:
        for _, bg, ink, edge in rows:
            for names in (bg, ink, edge):
                used.update(f"--zb-{n}" for n in (names or "").split("|") if n)
    missing = sorted({k for _, t in themes for k in t if not k.startswith("--zb-p-")} - used)
    if missing:
        raise SystemExit("bridge.css tokens with no role on the UI page: " + ", ".join(missing))

    def sample(tokens, bg, ink, edge):
        b, i, e = _pick(tokens, bg), _pick(tokens, ink), _pick(tokens, edge)
        if b and i:
            border = f"1.5px solid {e}" if e else "1px solid #0002"
            label = " / ".join(x for x in (_source(tokens, bg) or ("gradient" if b.startswith("linear") else b), _source(tokens, ink) or i) if x)
            return f'<div class="s pair" style="background:{html.escape(b)};color:{html.escape(i)};border:{border}">Aa</div><code>{html.escape(label)}</code>'
        v = b or i
        shape = "dot" if i and not b else "sq"
        return f'<div class="s {shape}" style="background:{html.escape(v)}"></div><code>{html.escape(_source(tokens, bg or ink) or (v if not v.startswith("linear") else "gradient"))}</code>'

    groups = []
    for title, rows in ROLES:
        trs = []
        for label, bg, ink, edge in rows:
            values = [tuple(_pick(t, n) for n in (bg, ink, edge)) for _, t in themes]
            same = len(set(values)) == 1
            names = " · ".join(n.split("|")[0] for n in (bg, ink, edge) if n)
            cells = (f'<td colspan="{len(themes)}">{sample(themes[0][1], bg, ink, edge)} <span class="same">every theme</span></td>'
                     if same else "".join(f"<td>{sample(t, bg, ink, edge)}</td>" for _, t in themes))
            trs.append(f'<tr><th>{html.escape(label)}<small>{html.escape(names)}</small></th>{cells}</tr>')
        groups.append(f"<h4>{html.escape(title)}</h4><table>{''.join(trs)}</table>")
    import sys as _sys
    _sys.path.insert(0, str(HERE))
    from colour import oklch_of
    palettes = []
    for name, t in themes:
        chips = "".join(
            f'<div class="pc"><span style="background:{html.escape(v)}"></span><b>{html.escape(k[7:])}</b><code>{html.escape(v)}</code>'
            f'<small>L {oklch_of(v)[0]:.2f} · C {oklch_of(v)[1]:.3f} · H {oklch_of(v)[2]:.0f}°</small></div>'
            for k, v in t.items() if k.startswith("--zb-p-"))
        palettes.append(f"<h4>{html.escape(name)}</h4><div class='pal'>{chips}</div>")
    head = "".join(f"<th>{html.escape(name)}</th>" for name, _ in themes)
    bands = "".join(
        f'<div class="band" style="background:{html.escape(_pick(t, "from-bg|from"))};color:{html.escape(_pick(t, "from-ink"))}">'
        f'<b>{html.escape(name)}</b><span style="color:{html.escape(_pick(t, "from-muted"))}">250 USDC</span>'
        f'<i style="background:{html.escape(_pick(t, "mark"))}"></i></div>'
        for name, t in themes)
    sizes = _block(css, ":root", alone=True)
    names = {"step-micro": "Smallest (tick labels)", "step--1": "Small (secondary lines)", "step-0": "Body",
             "step-fee": "Fee line", "step-1": "Page name, headings", "step-2": "Titles on the band", "step-amount": "Amounts",
             "col-width": "Column width", "touch": "Touch target", "joined-h": "Joined pill height", "go-h": "Bridge pill height",
             "header-h": "Header height", "row-h": "List row height"}
    def name(k: str) -> str:
        return f'{html.escape(names.get(k[5:], k[5:]))}<small>{html.escape(k[5:])}</small>'
    type_rows = "".join(f'<tr><th>{name(k)}</th><td class="ty" style="font-size:{html.escape(v)}">0.0₃1234</td><td><code>{html.escape(v.strip())}</code></td></tr>'
                        for k, v in sizes.items() if k.startswith("--zb-step"))
    size_rows = "".join(f'<tr><th>{name(k)}</th><td colspan="2"><code>{html.escape(v.strip())}</code></td></tr>'
                        for k, v in sizes.items() if not k.startswith("--zb-step"))
    return f"""<style>
  .sys {{ font: 13px/1.4 system-ui, sans-serif; color: #1b1a19; }}
  .sys h3 {{ font-size: 16px; margin: 22px 0 8px; }} .sys h4 {{ font-size: 13px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .06em; color: #7a5e50; }}
  .bands {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }}
  .band {{ display: flex; align-items: center; gap: 10px; padding: 18px 14px; }} .band b {{ font-size: 16px; }} .band i {{ margin-left: auto; width: 16px; height: 16px; border-radius: 50%; }}
  .sys table {{ border-collapse: collapse; width: 100%; table-layout: fixed; }}
  .sys th, .sys td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #ece8e2; vertical-align: middle; font-weight: 400; }}
  .sys tbody th, .sys table th:first-child {{ width: 30%; }}
  .sys th small {{ display: block; color: #9a948b; font: 11px ui-monospace, monospace; }}
  .s {{ display: inline-grid; place-items: center; vertical-align: middle; margin-right: 8px; }}
  .pair {{ width: 46px; height: 28px; border-radius: 999px; font-weight: 700; }}
  .sq {{ width: 28px; height: 28px; border: 1px solid #0002; }} .dot {{ width: 16px; height: 16px; border-radius: 50%; border: 1px solid #0002; margin-left: 6px; margin-right: 14px; }}
  .sys code {{ font-size: 11px; color: #55524d; }} .same {{ color: #9a948b; font-size: 11px; margin-left: 6px; }}
  .head th {{ font-weight: 600; }} .lead {{ color: #55524d; max-width: 70ch; }}
  .pal {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }}
  .pc {{ display: grid; grid-template-columns: 34px 1fr; column-gap: 8px; align-items: center; }} .pc span {{ grid-row: span 3; width: 34px; height: 34px; border: 1px solid #0002; }} .pc b {{ font-size: 12px; }} .pc code {{ font-size: 11px; }} .pc small {{ font-size: 10px; color: #9a948b; }} .ty {{ white-space: nowrap; overflow: hidden; }}
</style>
<div class="sys">
  <h3>The band</h3><div class="bands">{bands}</div>
  <h3>The palette</h3><p class="lead">Every colour the app uses. In Ember light and Ember on black each one sits on the ember's hue (about 41°) with even steps of lightness; Mono's are neutral. Good and bad are the only other hues: green at 150° and red at 18°. Roles below use only these.</p>{''.join(palettes)}
  <h3>Colours by role</h3>
  <table class="head"><tr><th></th>{head}</tr></table>
  {''.join(groups)}
  <h3>Type</h3><table>{type_rows}</table>
  <h3>Sizes</h3><table>{size_rows}</table>
</div>"""


BUILT = HERE / "built"
BUILT_ORDER = ["bridge", "fee", "blocked", "search", "settings", "explore", "message", "docs-home", "docs-article"]


def built_fragment() -> str:
    """The screenshots in design/ui/built (copied next to the page), phone and desktop side by side per screen."""
    import shutil
    (OUT / "built").mkdir(parents=True, exist_ok=True)
    cards = []
    for name in BUILT_ORDER:
        shots = []
        for view in ("phone", "desktop"):
            f = BUILT / f"{name}-{view}.png"
            if f.exists():
                shutil.copy(f, OUT / "built" / f.name)
                shots.append(f'<img src="/ui/built/{f.name}" alt="{html.escape(name)}, {view}" loading="lazy" class="{view}">')
        if shots:
            cards.append(f'<figure><figcaption>{html.escape(name.replace("-", " "))}</figcaption><div>{"".join(shots)}</div></figure>')
    return """<style>
  figure { margin: 0 0 24px; } figcaption { font: 600 13px system-ui, sans-serif; margin-bottom: 6px; text-transform: capitalize; }
  figure div { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; }
  img.phone { width: 300px; flex: none; border: 1px solid #e4e1dc; } img.desktop { width: 640px; flex: none; border: 1px solid #e4e1dc; }
</style>""" + "".join(cards)


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
        fragment = system_fragment() if screen == "@system" else built_fragment() if screen == "@built" else (SCREENS / screen).read_text()
        doc = frame_doc(sid, fragment)
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
  <h1>zkb.fi UI</h1><p>The design language as built.</p>
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

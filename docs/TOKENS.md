# Design tokens

Every colour, radius, type size and duration in the interface comes from
`src/styles/tokens.css`. Orbit used to derive colours ad hoc — `text-content/45`
here, `border-content/10` there, a sidebar mixed with black by hand — which made
two screens built a month apart look like two products. The token file replaces
that with three layers.

## 1. Primitives

Raw values. Only the layer below reads them.

| Group | Tokens |
| --- | --- |
| Tint inputs | `--tint-hue`, `--tint-chroma`, `--surface-canvas-l` (fed by the Appearance sliders) |
| Ramp step | `--surface-step-1..3` (0.045 / 0.09 / 0.13 in dark) |
| Radius | `--radius-xs 4` · `--radius-sm 6` · `--radius-md 8` · `--radius-lg 12` · `--radius-xl 16` |
| Type | `--text-2xs 11/16` · `--text-code 12.5/18` (the rest is Tailwind's scale) |
| Motion | `--ease cubic-bezier(.22,1,.36,1)` · `--dur-1 140ms` · `--dur-2 220ms` · `--dur-3 380ms` |

The neutral ramp is OKLCH, so a step is a perceptual step and the same numbers
work in both themes. The Appearance sliders set hue, chroma and the canvas
lightness; every surface is an offset from that canvas, so one slider moves the
whole stack instead of repainting a single card.

## 2. Semantics

What a surface or a piece of text *is*. Components use only these.

| Token | Dark (default tint) | Light |
| --- | --- | --- |
| `--surface-sunken` (rail) | `#0c0f11` | `#f0f2f4` |
| `--surface-canvas` (page) | `#16181c` | `#f9fafb` |
| `--surface-card` | `#212326` | `#ffffff` |
| `--surface-raised` | `#2b2e31` | `#eef0f3` |
| `--surface-overlay` (menus) | `#36383c` | `#e8ebef` |
| `--ink-1` (primary text) | `#eceff2` | `#131921` |
| `--ink-2` (secondary) | `#b4b8bc` | `#3f464e` |
| `--ink-3` (muted, meta) | `#858a8f` | `#5b6169` |
| `--line` / `--line-strong` | ink-1 at 9% / 18% | ink-1 at 12% / 22% |
| `--fill` / `--fill-strong` | ink-1 at 7% / 11% | ink-1 at 5% / 8% |
| `--accent` | `#4993ee` | `#2171cc` |

Light mode is deliberately *bright*: canvas at 0.985 OKLCH with almost no tint, cards at pure white, and ink starting at 0.21 so contrast — not a grey veil — does the separating. An earlier pass sat at 0.975 with a blue tint and the whole app read as grey.
| `--accent-ink` (accent as text) | `#88c1ff` | `#0058b1` |
| `--accent-fg` (text on accent) | `#0e141d` | `#ffffff` |
| `--positive` / `--negative` / `--warning` | `#4dc588` / `#f05653` / `#e7b551` | toned down |

Rules that come with them:

- Separation is a surface step plus `--line`, never a shadow. The two shadow
  tokens exist only for menus and dialogs.
- Three text roles, no more. A fourth weight of grey is a bug.
- One accent, used for the primary action, the selection and one live state.
- Status colours carry meaning only; diff rows also show a `+` or `−` glyph.

## 3. Aliases

The old names still resolve, so the ~9 000 existing rules keep working while
files are migrated:

| Alias | Maps to |
| --- | --- |
| `--color-background-base` | `--surface-canvas` |
| `--color-content` | `--ink-1` |
| `--color-stroke` | `--line` |
| `--color-selection{,-subtle,-strong,-hover,-emphasis}` | `--fill` steps |
| `--color-skill`, `--color-mention` | `--accent-ink` |
| `--color-diff-add` / `-del` | `--positive` / `--negative` |
| `--motion-feedback-duration` etc. | `--dur-1` / `--dur-2`, one easing curve |

Utility classes were migrated in one pass: `text-content/45` → `text-ink-3`,
`text-content/70` → `text-ink-2`, `bg-content/3|5|10` → `bg-fill-weak|fill|fill-strong`,
`bg-content` → `bg-ink-1`, `border-content/10` → `border-line`. Nothing should be
written as `*-content/NN` again.

## Adding a colour

1. Pick a semantic role in `tokens.css` (surface, ink, line, fill, status). If
   none fits, the design is missing a role, not a colour.
2. No new hue outside `--accent` and the three status colours.
3. Check contrast against the surface it sits on: body text 7:1, muted 4.5:1,
   accent-as-text 4.5:1.

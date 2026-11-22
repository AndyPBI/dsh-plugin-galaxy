# Rehearsal: galaxy-market

**Gold:** `linear` — kept the Wide-hero `Stage` and the `Act` script shape (`move` →
`click` → `set` → hold → caused reset), `data-target` on every cursor destination.
Changed: the pane is the kit's `Window chrome="hairline"` with its bar hidden (the
product's panel has no traffic lights), and the body is the product's own **card
grid**, rebuilt from `docs/screenshots/01-market-all.png` — not the row list an
earlier draft invented.

**Beats:** 1 pointer arrives on 已安装 (aimed at the cell's left margin) → 2 press: the
thumb travels 全部 → 已安装, the grid drops from nine cards to the six installed, the
count line goes 321 → 8 → 3 payoff holds with the lifecycle actions → 4 back to 全部 →
5 pointer returns to rest. Loop ≈ 13s.

**Captured:** widths 1280 (wide) and 390 (compact), light look, poster (已安装) and
initial (全部), reduced motion.

**Gate:** `rehearsal passed (necessary, not sufficient …)`, plus
`incomplete: 68 sampling gap(s)` which is capture-side.

**Film:**
- `lopsided: gm2-slider 32/26` → equal cells leave a wider inset beside the 2-char
  first label → labels clamped to `min-width: 3em` → fixed.
- `unclipped: gm2-panel` → `className` lands on `.ss-fit`, while the cropping box is
  `.ss-stage` → moved `overflow: hidden` there → fixed.
- `near aligned: 「8 个插件」 vs card title 12px` → the count line takes the card
  titles' left edge via `margin-left` → fixed.
- `uneven gutters ×3` → cards were framed as satellites because the pane was a bare
  div; the check exempts children of `.ss-window` → the pane is now kit `Window` →
  fixed.
- `touching: 已安装 / ★ vs its glyph 3px` → the star became a text glyph, the check
  mark's gap went to 5px → fixed.
- `half-pixel glyph` on the star svg → replaced with the `★` character → fixed.
- `cut by the crop` at 390 (real words cut, slider running off) → compact is a
  redesign: one-column grid, counts hidden, segments allowed under min-content → fixed.

**Review:** self-review only. Largest fault found and fixed: six cards left the lower
half of the pane empty, so the installed set went from three cards to six.

**Known shortcoming:** switching filters snaps — the removed cards vanish without an
exit and a neighbouring button jumps ~138px in one frame (`film` reports `jump` and
`vanishes with no exit`). The gate still passes because those lines are advisory, but a
cold viewer sees the snap. The fix is a FLIP, or a collapse that does not leave a hole
in the grid.

**Assumptions:** plugin names are plausible stand-ins, not real catalog rows; the
numbers (321 / 8 / 3, scores, downloads) are illustrative.

**Not checked:** dark theme, hover/press/focus states of the slider, the empty and error
states, RTL, and how any of this maps back onto `MarketSection.tsx`.

**Project layout:** the composition lives here, in the repo. The kit is imported
read-only from the skill install through a Vite alias (`@kit`); nothing is written back
into `~/.agents/skills/stageshow`.

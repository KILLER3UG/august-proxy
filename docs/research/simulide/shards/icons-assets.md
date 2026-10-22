# simulide / icons-assets

## Shard shape

This shard is the entire art department of SimulIDE: **224 files, 531 KB**, all under `src/icons/` — `components/` (165 files: 159 PNG + 6 SVG), `font/` (2 PNG) and `mainwindow/` (57 files: 19 PNG + 38 SVG). No code lives here; every file is an asset consumed through Qt's resource system. The single mechanism that binds them is `src/application.qrc`, which registers **211 of the 224** files into a *flat* `:/` namespace, sometimes under an **alias** that is not the filename (`rotateccw.svg` → `undo.svg`, `rotatecw.svg` → `redo.svg`, `verify.png` → `setroot.png`). Three consumers read that namespace, and each resolves a file through a *different* chain: the component palette resolves a bare filename to `":/"+icon` when the shared data folder has no image (`src/gui/componentlist/componentlist.cpp:168-170`); a component's own body on the schematic goes through `Component::setBackground`, which walks circuit-folder → user-folder → config-folder → compiled-in resource (`src/components/component.cpp:625-653`); and the toolbar asks for `":/undo.svg"`-style paths directly (`src/gui/editorwidget/editorwidget.cpp:801,806`). The shard also holds the only two *data* assets rather than drawings: `src/icons/font/font2.png`, a 2560×16 bitmap-font atlas of 256 cells of 10×16 that is the character generator of the simulated HD44780 LCD, and the six 80×42 waveform bitmaps the wave generator blits as its per-type preview. The three directories map onto three eras of the project: `components/` is mostly hand-drawn PNG on a 36×24 (component) / 20×20 (category) / 16×16 (connector) grid, `mainwindow/` is mostly Inkscape SVG on a 22×22 grid built from a *duplicated-path* emboss recipe, and `font/` is the odd one out — a machine-generated strip with no icon semantics at all.

**What this second pass changed.** The previous pass's file coverage was complete (224/224) and its mechanism claims about `component.cpp`, `hd44780_base.cpp`, `wavegen.cpp`, `thememanager.cpp` and `application.qrc` all verify exactly. But several *content* claims were wrong and are corrected below: the `1toN` family is a **box-with-segments** pictogram whose `g` suffix means **the box is grown taller**, not "gated"; `1to3-c.png` is the `1to3` pictogram redrawn at 36×24, with **no dashed line**; `dht11.svg` is **not** a recolour of `dht22.svg` (28 rects vs 42, and no mounting-tab path); `link.png` is **greyscale** (the yellow arrow is in `expose.png`); `unuse.png` is a **dashed cross**, not diagonal dashes; `termistor.png` is **byte-identical** to `thermistor.png`; `null-0.png` is **fully transparent** and `null.png` is a 10×45 bar inside a 10×100 canvas, not a solid strip; `blanc.png` is a **near-invisible** 1–50 %-alpha blue image, not a "NEW!" comic burst; and the claim that `":font2.png"` is the *only* one-colon resource reference in the tree is **false** — `src/components/connectors/tunnel.cpp:207` has a second one, three lines above a correctly-spelled sibling. See *Uncertainties* for the full list of corrections.

---

## Per-file notes

### src/icons/components/1to1.png
- 20×20 RGBA, 50 opaque + 84 semi-transparent pixels, ink bbox x 0–19, y 4–14. The "1 in / 1 out" block pictogram: a rectangle outline (cols 4–15, rows 4–15) with one 2-px input stub on the left at rows 9–10 and one 2-px output stub on the right at the same rows. Used as the "Other Outputs" category icon (`src/gui/componentlist/itemlibrary.cpp:247`).

### src/icons/components/1to2.png
- 20×20, 58 opaque + 76 semi. One input stub (rows 9–10) and **two** output stubs (rows 6–7 and 12–13) on a rectangle (cols 4–15, rows 4–15). Registered as the "Converters" **and** "Sensors" category icon (`src/gui/componentlist/itemlibrary.cpp:305` and `:263`) — one drawing doing two jobs.

### src/icons/components/1to3.png
- 20×20, 78 opaque + 104 semi. One input stub at rows 9–10 and **three** output stubs at rows 3–4, 9–10 and 15–16; the box is drawn **taller** (rows 1–18) to make room for the third output. Registered; referenced by no category — a member of the family that was drawn but never used.

### src/icons/components/1to3-c.png
- 36×24, 78 opaque + 105 semi, ink bbox x 8–27, y 3–19. The **same 1-to-3 pictogram redrawn at component size**: a box (cols 12–23, rows 3–20) with one input stub (rows 11–12) and three output stubs (rows 6–7, 11–12, 16–17). The `-c` suffix reads as "component" (36×24) versus the 20×20 category size. Registered (`src/application.qrc:221`) and referenced by no code. The previous pass described a "dashed vertical coupling line" here — there is none; that was the box's left edge misread at low resolution.

### src/icons/components/2to1.png
- 20×20, 58 opaque + 76 semi. Two input stubs (rows 5–6, 12–13), one output stub (rows 9–10), box rows 4–15. The "2 in / 1 out" member of the family. Registered; no category uses it.

### src/icons/components/2to2.png
- 20×20, 66 opaque + 76 semi. Two inputs (rows 5–6, 12–13) and two outputs (rows 5–6, 12–13). Registered as the "Arithmetic" category icon (`src/gui/componentlist/itemlibrary.cpp:287`) and the "Other Active" icon (`:213`).

### src/icons/components/2to3.png
- 20×20, 74 opaque + 76 semi. Two inputs (rows 5–6, 12–13) and three outputs (rows 5–6, 9–10, 15–16) — but the box is only rows 4–15, so the third output stub **collides with the box's bottom border**. The "Other Logic" category icon (`src/gui/componentlist/itemlibrary.cpp:313`).

### src/icons/components/2to3g.png
- 20×20, 86 opaque + 104 semi. The *grown* variant of `2to3.png`: the box is drawn **taller** (rows 1–18) so the three output stubs (rows 3–4, 9–10, 15–16) no longer collide with the two input stubs (rows 6–7, 12–13). **The `g` suffix means the box is grown**, not "gated" — the previous pass's reading was wrong. Registered (`src/application.qrc:226`) and referenced by no category.

### src/icons/components/3to1.png
- 20×20, 78 opaque + 104 semi. Three input stubs (rows 3–4, 9–10, 15–16), one output stub (rows 9–10), tall box (rows 1–18). Registered; no category uses it.

### src/icons/components/3to2.png
- 20×20, 74 opaque + 76 semi. Three inputs (rows 5–6, 9–10, 13–14) and two outputs (rows 5–6, 13–14) in a short box (rows 4–15) — the input and output stubs share rows. Registered; no category uses it.

### src/icons/components/3to2g.png
- 20×20, 86 opaque + 104 semi. The grown twin of `3to2.png`: box rows 1–18, three inputs (rows 3–4, 9–10, 15–16), two outputs (rows 6–7, 12–13) — no row collision. Registered (`src/application.qrc:229`); referenced by no category.

### src/icons/components/7segbcd.png
- 20×20, 84 opaque + 207 semi, bbox x 4–16, y 0–19. A seven-segment "8" (a 2×2 grid of filled blocks inside a 2-px border) with a **dashed outer border** — the palette icon of the BCD→seven-segment converter (`src/gui/componentlist/itemlibrary.cpp:316` registers `BcdTo7S::libraryItem()`).

### src/icons/components/aip31068.png
- 36×24, 32 opaque + 378 semi, ink bbox x 4–30, y 11–19. A solid rounded block with a hollow interior — a featureless package silhouette for the AIP31068 I²C LED driver. Not a symbol: the whole "display" family is deliberately featureless.

### src/icons/components/amperimeter.png
- 36×24, 180 opaque + 58 semi, bbox x 7–29, y 1–22. A circle (cols 7–29) containing the letter "A", with two terminal stubs below. The Amperimeter palette icon.

### src/icons/components/andgate.png
- 20×20, 27 opaque + 125 semi, bbox x 1–18, y 3–15. The AND-gate D-shape (flat left edge, round nose) with the extra input line. Named by `LibraryItem` in `src/components/logic/gate_and.cpp:22`. Pixel-for-pixel the same drawing as `gates.png` (same opacity/semi/bbox triple), just re-encoded.

### src/icons/components/audio_out.png
- 36×24, 61 opaque + 157 semi, bbox x 10–24, y 0–22. A speaker cone (the small rectangle on the right) with two sound arcs. The AudioOut palette icon.

### src/icons/components/battery.png
- 36×24, 138 opaque + 170 semi, bbox x 1–34, y 3–20. A battery cell: a long plate and a short plate straddling a horizontal lead, with polarity bars.

### src/icons/components/bdown.svg
- 50mm × 50mm Inkscape SVG, 46 lines, ONE `<path>`: `M 0.01,0.007 50.0,0.001 24.99,49.99 Z` (a triangle with the apex at the **bottom**), fill `#00009a`, `stroke-width:0.025`, no `transform`. Registered as `bdown.svg` (`src/application.qrc:266`) and referenced by no code — dead. A blue down-pointing triangle, 50 mm on a side, i.e. ~188 px if ever loaded.

### src/icons/components/bjt.png
- 36×24, 76 opaque + 66 semi, bbox x 8–27, y 3–21. An NPN transistor: a vertical base bar, a collector and emitter leg, and an emitter arrow. The BJT palette icon.

### src/icons/components/blanc.png
- 128×128, **0 fully-opaque pixels**, 92 semi-transparent ones, 89 distinct colours, all at alpha 1–99 (top colours `#7CC0D2/a1`, `#13699B/a1`, `#54A4C6/a18`, `#5DA1BB/a49`). A **faint blue-tinted image** that is almost invisible at icon sizes — there is no readable "NEW!" text in the alpha data. It is the placeholder for a component-set entry with no image of its own (`src/gui/componentlist/managecomps.cpp:65` asks for `":/blanc.png"`). This is the shard's only *blue* asset besides `su.png`/`giu.png`/`sr04_ico.png`; the previous pass's "blue NEW! comic burst … the only colour illustration in the shard" was wrong on both counts.
- **The live bug this file exposes:** the same image is correctly requested as `":/blanc.png"` at `src/gui/componentlist/managecomps.cpp:65` but as `":/blank.png"` — one letter short, a file that does not exist anywhere in the tree — at `src/gui/editorwidget/editorwidget.cpp:746`, `:750` and `:755`, where it is the icon of the "Editor Settings", "File Settings" and "Compiler Settings" actions. Those three actions render with **no icon at all**, and nothing reports the miss.

### src/icons/components/board.png
- 20×20, 71 opaque + 152 semi, bbox x 0–19, y 3–16. An Arduino-board pictogram: a board outline with an inner chip rectangle and a corner notch. The "Arduino" category icon (`src/gui/componentlist/itemlibrary.cpp:253`).

### src/icons/components/buffer.png
- 20×20, 24 opaque + 116 semi, bbox x 0–19, y 3–15. The classic IEC buffer triangle. The Buffer palette icon.

### src/icons/components/bug.png
- 36×24, 192 opaque + 166 semi, bbox x 8–27, y 2–21. A ladybird/beetle: a domed body with a centre line, six legs and two antennae. Registered as `bug.png` (`src/application.qrc:142`) and used as the "bug" category icon — SimulIDE's own name for its Beta/"bug" components.

### src/icons/components/bug.svg
- 22×22, 98 lines, three `<path>` elements all `fill:#000000`, wrapped in `translate(0,-1030.3622)` and a `matrix(1.7743326,0,0,1.7743326,…)` scale, plus an **unused** `linearGradient` whose only stop is `#363636`. **Not registered in `application.qrc` and referenced nowhere** — dead. It is the vector source from which `bug.png` was rasterised (older Inkscape, 1.1.2).

### src/icons/components/bup.svg
- 50mm × 50mm, 47 lines, ONE `<path>` with the *same* triangle coordinates as `bdown.svg` but wrapped in `transform="rotate(180,25.001106,24.997171)"` — so the brown `#ac2b00` triangle points **up**. Registered (`src/application.qrc:265`) and referenced by no code — dead.

### src/icons/components/bus.png
- 36×24, 83 opaque + 31 semi, bbox x 4–30, y 8–14. A horizontal bus bar: a 2-px rule with six 2-px tap stubs above it. The Bus palette icon.

### src/icons/components/bus_p.png
- 20×20, 48 opaque + 33 semi, bbox x 6–12, y 1–17. A **vertical** bus bar with alternating side taps — the portrait twin of `bus.png`. **Not registered** in `application.qrc` — dead.

### src/icons/components/capacitor.png
- 36×24, 120 opaque + 134 semi, bbox x 1–34, y 3–20. Two parallel vertical plates on a horizontal lead. The Capacitor palette icon.

### src/icons/components/clock.png
- 36×24, 169 opaque + 67 semi, bbox x 2–33, y 3–20. A digital clock face: a rounded rectangle enclosing two seven-segment digits and a colon. The Clock source palette icon.

### src/icons/components/csource.png
- 36×24, 61 opaque + 133 semi, bbox x 3–32, y 5–17. A filled triangle pointing right — the controlled-source amplifier symbol. The Csource palette icon.

### src/icons/components/cursource.png
- 36×24, 97 opaque + 197 semi, bbox x 1–33, y 2–23. A circle with an internal arrow (the current-source symbol) plus two lead stubs. The CurrSource palette icon.

### src/icons/components/dcmotor.png
- 36×24, **0 fully-opaque** pixels, 426 semi-transparent, bbox over the non-transparent set x 1–33, y 2–23. A DC motor: a stator block with a shaft and end cap, drawn entirely in antialiased 25 %-opacity black. The DcMotor palette icon.

### src/icons/components/demux.png
- 20×20, 72 opaque + 100 semi, bbox x 0–19, y 2–17. A funnel: a wide top narrowing to a single output on the right, with three inputs on the left. The Demux palette icon.

### src/icons/components/dht11.svg
- 40mm × 50mm, viewBox 0 0 40 50, 210 lines, **28 `<rect>` + 1 `<ellipse>`, no `<path>`**: a periwinkle `#aaaaff` body (31.15 × 37.50 at 4.52, 9.75) with a 1.433 black stroke, 21 black vent holes (3 columns at x 13.46/18.54/23.63 × rows at y 18.26/23.40/28.69, plus 4.35-wide side holes at x 6.94 and 28.81) and 6 `#5050ac` ribs (1.72 wide at x 5.22 and 33.22). Loaded as the component's on-canvas background when the DHT22 class is in DHT11 mode (`src/components/micro/dht22.cpp:257`).
- **This is NOT a recolour of `dht22.svg`.** The two files share a 40×50 canvas and a 3-column vent grid, but `dht22.svg` has **42 rects** (28 black + 13 `#646464` ribs + 1 white body) **plus a mounting-tab `<path>`**, while `dht11.svg` has **28 rects** and **no tab**: a shorter body, a 3×4 vent grid instead of 3×6, and 6 ribs instead of 13. The previous pass's "the *only* difference is the casing fill and the rib colour" was wrong — the DHT11 is a separate, coarser drawing that happens to be blue.

### src/icons/components/dht22.svg
- 40mm × 50mm, viewBox 0 0 40 50, 300 lines, **42 `<rect>` + 1 `<path>` + 1 `<ellipse>`**: a white `#ffffff` body (31.10 × 39.32 at 4.48, 9.78) with a 1.466 black stroke; **18 black vent holes in a 3×6 grid** (2.96 × 2.97 at x 13.46/18.54/23.63, y 11.75/16.67/21.81/27.10/32.72/37.88); 10 wider black side holes (4.35 wide at x 6.94 and 28.81); **13 `#646464` ribs** (1.72 wide at x 5.22 and 33.16, three of them rotated 90°); a white mounting-tab polygon `M 4.456,9.716 4.416,5.415 10.575,0.864 H 29.345 l 6.265,4.665 v 4.281 z`; and one invisible `ellipse` (rx 0.0226). Loaded as the component's background by `src/components/micro/dht22.cpp:254`.
- The vent grid is **18 separate `<rect>` elements, not a pattern or a fill** — the drawing is 300 lines of hand-authored geometry for what a single 3×6 `<pattern>` or a `stroke-dasharray` would draw in three.

### src/icons/components/dht22_ico.png
- 36×24, 542 opaque + 59 semi, bbox x 0–35, y 3–20, greyscale (top colours `208,208,208`×147, `61,61,61`×94, `71,71,71`×49). A greyscale raster of the DHT22's vent-hole grid and side ribs — the *palette* icon, distinct from the SVG body.

### src/icons/components/diac.png
- 36×24, 138 opaque + 185 semi, bbox x 12–23, y 1–22. Two opposed triangles sharing a central bar (the DIAC symbol). The Diac palette icon.

### src/icons/components/dial.png
- 36×24, 93 opaque + 165 semi, bbox x 4–29, y 2–23. A rotary dial: a circle, a pointer wedge, and small knob bumps on the rim. The Dial palette icon.

### src/icons/components/diode.png
- 36×24, 280 opaque + **0 semi**, bbox x 0–35, y 4–19. A solid triangle meeting a cathode bar on a horizontal lead — one of the few icons in the shard with *no* antialiasing at all, because the triangle's diagonal was drawn on a pixel boundary. The Diode palette icon.

### src/icons/components/displays.png
- 20×20, 10 opaque + 255 semi, bbox x 2–17, y 13–14. A wide, very shallow dark bar — a screen in profile. The "Displays" category pictogram (`src/gui/componentlist/itemlibrary.cpp:229`).

### src/icons/components/down.png
- 6×23, 138 opaque, 0 semi, bbox x 0–5, y 0–22, fill `200,220,180` (`#C8DCB4`). A narrow pale-green strip whose arrow head sits at rows 8–11. Registered (`src/application.qrc:269`) and referenced by no code — dead.

### src/icons/components/dsxxx.png
- **329×235 RGB, 77 315 opaque pixels, 0 semi** — a real photograph, not a drawing: a DS18B20 8-pin DIP beside its black probe can, on white (top colours `49,45,41`×51 906, `70,67,70`×5107). It is used exactly like a vector symbol: `setBackground("dsxxx.png")` at `src/components/micro/ds1307.cpp:37`.
- The photograph enters through the *same* four-tier lookup as the SVGs, so a teacher can replace it with their own part photo by dropping a file next to the circuit.

### src/icons/components/dsxxx_ico.png
- 36×24, 792 opaque, 0 semi, greyscale (`51,50,54`×525, `177,174,174`×40). A greyscale raster of the DS18B20/DS1307 package with a pin-1 notch — the palette icon of the DS family.

### src/icons/components/elcapacitor.png
- 36×24, 128 opaque + 147 semi, bbox x 1–34, y 3–20. A curved plate against a straight plate — the electrolytic capacitor. The elCapacitor palette icon.

### src/icons/components/ellipse.png
- 36×24, 60 opaque + 246 semi, bbox x 3–31, y 3–20. A filled ellipse (an outline with a soft interior). The Ellipse graphical-component palette icon.

### src/icons/components/esp01.png
- **238×170 RGB, 40 460 opaque pixels, 0 semi** — a literal photograph of an ESP-01 module: a black PCB with a gold meander antenna (top colours `43,42,36`×18 292, `63,63,63`×5167). Used as the component's on-canvas background via `setBackground("esp01.png")` at `src/components/micro/esp01.cpp:45`.

### src/icons/components/esp01_ico.png
- 36×24, 792 opaque, 0 semi, greyscale (`51,50,54`×206, `64,59,59`×48). A greyscale raster of the ESP-01 module — the palette icon.

### src/icons/components/frequencimeter.png
- 36×24, 194 opaque + 28 semi, bbox x 7–29, y 1–22. A meter face: a rectangular body, a seven-segment digit bar, and two terminals. The FreqMeter palette icon.

### src/icons/components/gates.png
- 20×20, 27 opaque + 125 semi, bbox x 1–18, y 3–15 — the **same AND-gate drawing as `andgate.png`** (identical opacity/semi/bbox; different PNG encoding, hence not byte-identical). It is registered separately and used as the "Gates" *category* pictogram (`src/gui/componentlist/itemlibrary.cpp:281`), while `andgate.png` is the *component* palette icon (`src/components/logic/gate_and.cpp:22`). One drawing, two roles, two files.

### src/icons/components/gc9a01a.png
- 36×24, 275 opaque + 281 semi, bbox x 7–24, y 3–20. A solid rounded block — the GC9A01A round-display package icon.

### src/icons/components/giu.png
- 9×9, 81 opaque, 0 semi, colours `50,70,100`×45 / `32,50,78`×15 / `82,103,135`×15. A dark-blue (`#324664`) tile with a white **horizontal bar (a minus sign)** in the middle. Registered (`src/application.qrc:268`) and referenced by no code — dead.

### src/icons/components/ground.png
- 36×24, 186 opaque, 0 semi, bbox x 8–27, y 1–22, colours `0,0,0`×88 / `45,45,45`×68. The earth symbol: a stem widening into a stack of tapering bars. The Ground source palette icon.

### src/icons/components/hd44780.png
- 36×24, 38 opaque + 378 semi, bbox x 4–30, y 11–19. A grey LCD body with a light 2×16 dot grid (the `+` fill is the dot area). The HD44780 palette icon.

### src/icons/components/hd44780_20x4.png
- 36×24, 38 opaque + **527** semi, bbox x 4–30, y **14–22**. The same LCD body but with a **taller** dot area (3 extra rows of semi-transparent pixels, 527 vs 378) and the panel starting 2 rows higher — i.e. the 4×20 variant. **Not registered** in `application.qrc` (`hd44780.png` is registered at `:167`; this one is absent) — dead, so the 20×4 LCD variant has never shipped.

### src/icons/components/header.png
- 36×24, 72 opaque + 64 semi, bbox x 4–30, y 6–13. A connector body: a horizontal rule with six 2-px contact stubs above it. The Header palette icon.

### src/icons/components/header_U.png
- 16×16, 256 opaque, 0 semi, greyscale `55,55,55`×72 / `65,65,65`×64 / `0,0,0`×36. A solid upward-flaring trapezoid (a connector body seen end-on, opening upward). The "header up" pin glyph.

### src/icons/components/header_D.png
- 16×16, 94 opaque + 54 semi, bbox x 2–13, y 3–13, greyscale `95,95,95`×8 / `107,107,107`×5. A downward-flaring trapezoid with a hollow centre — the "header down" pin glyph, the vertical twin of `header_U.png`.

### src/icons/components/ic_comp.png
- 36×24, 226 opaque + 35 semi, bbox x 8–27, y 4–20. A DIP outline: a body with a notch on the top edge and pins on both sides. The generic IC-component palette icon.

### src/icons/components/ic2.png
- 20×20, 226 opaque + 35 semi, bbox x 0–19, y 2–18 — a *different drawing* from `ic_comp.png` despite the same opacity triple: a small DIP with three full-width pin rows. Registered once and used as the category icon for **seven** MCU families at once — AVR, PIC, I51, MCS65, Z80, STM32 and Espressif (`src/gui/componentlist/itemlibrary.cpp:254-260`) — and is also one of the three built-in icons shadowed by a same-named file in `resources/data/images/`.

### src/icons/components/ic2_comp.png
- 36×24, 179 opaque + 96 semi, bbox x 5–29, y 5–18. A **wide** DIP outline — the MCU/DS18B20 package icon, named by `LibraryItem` at `src/components/micro/ds18b20.cpp:33`.

### src/icons/components/ic3.png
- 36×24, 372 opaque + 35 semi, bbox x 7–28, y 1–22. A three-row pin-grid package: three pin rows above and below a body. Registered; no component claims it.

### src/icons/components/ili9341.png
- 36×24, 482 opaque + 238 semi, bbox x 2–35, y 3–20. A solid rectangle — the ILI9341 TFT package icon.

### src/icons/components/img.png
- 36×24, **0 fully-opaque** pixels, 429 semi-transparent, bbox over the non-transparent set x 6–29, y 4–20. A picture frame containing a lens circle and a small blob (a "photo" glyph) drawn entirely in antialiased 25 %-opacity black. The Image (graphical) component palette icon.

### src/icons/components/inductor.png
- 36×24, 87 opaque + 125 semi, bbox x 1–34, y 8–17. A coil: four loops of a continuous stroke on a horizontal lead. The Inductor palette icon.

### src/icons/components/jfet.png
- 36×24, 93 opaque + 28 semi, bbox x 6–25, y 1–22. A JFET: a vertical gate bar, a channel bar, and drain/source legs. The Jfet palette icon.

### src/icons/components/joystick.png
- 36×24, 73 opaque + 106 semi, bbox x 9–26, y 3–20. A joystick: a ball on a stick rising from a three-button base. The Joystick palette icon.

### src/icons/components/keypad.png
- 36×24, 72 opaque + 342 semi, bbox x 7–26, y 7–17. A grid of **six** key caps (3 × 2), each a 7×6 block. The KeyPad palette icon.

### src/icons/components/ks0108.png
- 36×24, 42 opaque + 698 semi, bbox x 2–32, y 15–23. A grey LCD module whose **whole body is the semi-transparent `+` fill** — the densest antialiasing in the shard. The KS0108 keypad/LCD palette icon.

### src/icons/components/ky-023.png
- 36×24, 626 opaque + 33 semi, bbox x 1–33, y 1–22, greyscale `48,48,48`×59 / `78,78,78`×18. A raster of the KY-023 temperature-sensor module (board, sensor, pin header). The KY023 palette icon.

### src/icons/components/ky-040.png
- 36×24, 626 opaque + 35 semi, bbox x 1–33, y 1–22, **warm grey-pink** `141,126,128`×40 / `67,57,59`×29 / `201,189,190`×28. A raster of the KY-040 rotary-encoder module. The only asset in the shard with a warm (non-blue, non-grey) cast.

### src/icons/components/lamp.png
- 36×24, 133 opaque + 228 semi, bbox x 0–35, y 2–22. A lamp: a circle with a filament cross and radiating leads. The Lamp output palette icon.

### src/icons/components/lanalizer.png
- 36×24, 200 opaque + 48 semi, bbox x 7–29, y 1–22. A logic-analyser box containing **two groups of eight digital segments** (the 16-channel display). The LAnalizer palette icon.

### src/icons/components/ldr.png
- 36×24, 166 opaque + 54 semi, bbox x 1–34, y 1–15. An LDR: a resistor body in a box with two incoming arrows above it. The Ldr palette icon.

### src/icons/components/led.png
- 36×24, 220 opaque + 56 semi, bbox x 1–34, y 2–21. An LED: a filled dome with two emitter arrows. The Led palette icon.

### src/icons/components/ledbar.png
- 36×24, 278 opaque + 24 semi, bbox x 0–34, y 7–16. A bar-graph of **eight** 2-px cells under a header rule. The LedBar palette icon.

### src/icons/components/ledmatrix.png
- 36×24, 297 opaque + 4 semi, bbox x 6–26, y 2–22. A 5×5 dot matrix: a 21×21 frame with 25 single-pixel dots. The LedMatrix palette icon.

### src/icons/components/ledrgb.png
- 36×24, 186 opaque + 166 semi, bbox x 1–34, y 0–23. Two LED domes side by side on a shared pair of leads. The LedRgb palette icon.

### src/icons/components/leds.png
- 20×20, 7 opaque + 239 semi, bbox x 4–15, y 2–17. A rounded block with a lens-like opening — a single LED seen face-on. The "Leds" category pictogram (`src/gui/componentlist/itemlibrary.cpp:220`).

### src/icons/components/line.png
- 36×24, 42 opaque + 107 semi, bbox x 6–28, y 6–19. A single tapered diagonal stroke. The Line graphical-component palette icon.

### src/icons/components/max72xx.png
- 36×24, 364 opaque + 4 semi, bbox x 0–35, y 4–18. A driver package with a 2 × 12 dot grid — the MAX72xx LED-matrix driver icon.

### src/icons/components/mosfet.png
- 36×24, 134 opaque + 37 semi, bbox x 6–25, y 1–22. A MOSFET: gate bar, channel bar, and the body arrow. The Mosfet palette icon.

### src/icons/components/motors.png
- 20×20, 52 opaque + 135 semi, bbox x 1–19, y 4–14. A motor block with a shaft and a knob. The "Motors" category pictogram (`src/gui/componentlist/itemlibrary.cpp:242`).

### src/icons/components/mux.png
- 20×20, 72 opaque + 100 semi, bbox x 0–19, y 2–17. A multiplexer trapezoid with an input wedge on the left — the same 72/100/0,2-19,17 triple as `demux.png`, mirrored. The Mux palette icon.

### src/icons/components/null-0.png
- 2×40, **0 opaque and 0 semi-transparent pixels — every pixel has alpha 0**. A fully transparent 2×40 sliver, used as a *spacer* icon in a context menu (`src/components/subcircuits/shield.cpp:132` adds it as an action with an empty text). The previous pass called it a "solid black strip"; it is not.

### src/icons/components/null.png
- 10×100, 435 opaque + 50 semi, ink bbox x 0–9, **y 29–73** — a black bar **45 rows tall in the middle** of a 100-row canvas, not a solid strip. Registered as `null.png` (`src/application.qrc:46`) and referenced by no code. It is also **shadowed**: `resources/data/images/null.png` is a *different* 10×10 image, and because the data folder is searched first the shipped one wins.

### src/icons/components/null_ico.png
- 20×20, **0 opaque and 0 semi-transparent pixels** — a deliberately blank 20×20 placeholder. Registered (`src/application.qrc:47`) and referenced by no code.

### src/icons/components/opamp.png
- 36×24, 89 opaque + 105 semi, bbox x 3–31, y 1–22. An op-amp triangle with a `+` at the upper input, a `−` at the lower, and one output. The OpAmp palette icon.

### src/icons/components/orgate.png
- 20×20, 53 opaque + 109 semi, colour `30,30,30`×53 (a **dark grey**, not pure black — one of only a few icons in the shard that is not `0,0,0`). The OR-gate body: a curved back and a pointed nose. The OrGate palette icon.

### src/icons/components/oscope.png
- 36×24, 158 opaque + 104 semi, bbox x 7–29, y 1–22. An oscilloscope box whose screen carries a **sine trace** (a symmetric curve, not a square wave). The Oscope palette icon.

### src/icons/components/pcd8544.png
- 36×24, 25 opaque + 542 semi, bbox x 6–29, y 16–19. A grey PCD8544 (Nokia-5110) module body whose dot area is a `+` fill. The PCD8544 palette icon.

### src/icons/components/pcf8833.png
- 36×24, 306 opaque + 198 semi, bbox x 10–26, y 2–19. A solid block — the PCF8833 display package icon.

### src/icons/components/perif.png
- 20×20, 132 opaque + 48 semi, bbox x 3–19, y 4–14. A stacked-bar glyph. The "Peripherals" category pictogram (`src/gui/componentlist/itemlibrary.cpp:270`).

### src/icons/components/potentiometer.png
- 36×24, 153 opaque + 51 semi, bbox x 1–34, y 2–18. A resistor in a box with a **diagonal wiper arrow** crossing it. The Potentiometer palette icon.

### src/icons/components/probe.png
- 36×24, 54 opaque + 144 semi, bbox x 6–28, y 1–23. A tapering cone on a lead — the oscilloscope probe. The Probe palette icon.

### src/icons/components/push.png
- 36×24, 76 opaque + 100 semi, bbox x 1–34, y 5–14. A push button: a rounded cap (rows 5–8) over a stem. The Push switch palette icon.

### src/icons/components/rail.png
- 36×24, 53 opaque + 104 semi, bbox x 11–24, y 2–20. A downward-pointing hollow triangle on a stem — the power-rail symbol. The Rail source palette icon.

### src/icons/components/reactive.png
- 20×20, **0 fully-opaque** pixels, 198 semi-transparent. A capacitor plate set overlapping an inductor loop set — the "Reactive" category pictogram (`src/gui/componentlist/itemlibrary.cpp:192`).

### src/icons/components/rectangle.png
- 36×24, 4 opaque + 346 semi, bbox x 6–29, y 4–20. A hollow rectangle (a 3-px stroke, nearly all of it antialiased). The Rectangle graphical-component palette icon.

### src/icons/components/rectifiers.png
- 20×20, 78 opaque + 63 semi, bbox x 5–15, y 4–15. A solid triangle — the rectifier/diode family pictogram. The "Rectifiers" category icon (`src/gui/componentlist/itemlibrary.cpp:201`).

### src/icons/components/relay-spst.png
- 36×24, 7 opaque + 329 semi, bbox x 9–20, y 9–20. A relay: a coil block with a contact arm swinging down to a fixed contact. The Relay palette icon.

### src/icons/components/resistor.png
- 36×24, 134 opaque + 30 semi, bbox x 1–34, y 6–15. The IEC resistor body — a rectangle with a bar through it — between two leads. The Resistor palette icon.

### src/icons/components/resistordip.png
- 36×24, 194 opaque + 192 semi, bbox x 5–30, y 0–21. A DIP resistor network: **eight** zigzag elements in a package outline. The ResistorDip palette icon.

### src/icons/components/resistordip0.png
- 36×24, 110 opaque + 130 semi, bbox x 3–31, y 4–20. A DIP outline with **straight pins and no resistor bodies** — the bare-package variant. **Not registered** in `application.qrc` — dead.

### src/icons/components/resistors.png
- 20×20, 11 opaque + 199 semi, bbox x 1–19, y 3–16. A zigzag resistor glyph. The "Resistors" category pictogram (`src/gui/componentlist/itemlibrary.cpp:180`).

### src/icons/components/resistorsensors.png
- 20×20, 9 opaque + 202 semi, bbox x 1–17, y 4–15. The same zigzag resistor crossed by a **diagonal arrow** — the "this one's a sensor" variant. The "Resistive Sensors" category pictogram (`src/gui/componentlist/itemlibrary.cpp:186`).

### src/icons/components/rnd.png
- 80×42, 716 opaque + 385 semi, bbox x 0–79, y 0–41. An irregular **step** waveform: a solid block that steps up and down, plus a full-height column at the right. The WaveGen "Random" preview, selected by `src/components/sources/wavegen.cpp:344`.

### src/icons/components/rotencod.png
- 36×24, 92 opaque + 168 semi, bbox x 5–30, y 2–21. A rotary encoder: a circle with a pointer wedge and three contact stubs on the right. The rotary-encoder palette icon.

### src/icons/components/rtd.png
- 36×24, 167 opaque + 66 semi, bbox x 0–34, y 1–18. A resistor in a box with a **diagonal element** through it — the RTD symbol. The RTD palette icon.

### src/icons/components/saw.png
- 80×42, 626 opaque + 380 semi, bbox x 1–78, y 1–40. A sawtooth: a rising diagonal crossed by a vertical drop line, with the next period's rise beginning at the right edge. The WaveGen "Saw" preview (`src/components/sources/wavegen.cpp:341`).

### src/icons/components/scr.png
- 36×24, 299 opaque + 24 semi, bbox x 0–35, y 4–20. A thyristor: a diode body with a gate lead off the side. The SCR palette icon.

### src/icons/components/script_ico.png
- 20×20, 92 opaque + 128 semi, bbox x 1–19, y 1–19. A code page: three dots across the top (a `...` line) over a field of brace-like strokes. The Script / MCU-firmware palette icon.

### src/icons/components/sdcard.png
- 36×24, 105 opaque + 655 semi, bbox x 1–31, y 0–22. An SD card: a chamfered corner, a contact strip on the left, and a label block. The SdCard palette icon.

### src/icons/components/serialport.png
- 36×24, 111 opaque + 276 semi, bbox x 0–33, y 4–20. A D-sub connector: a shell with **two rows of five** pin holes. The SerialPort palette icon.

### src/icons/components/serialterm.png
- 36×24, 314 opaque + 132 semi, bbox x 8–27, y 3–19, with a warm tint (`90,75,77`×33, `116,101,104`×16). A terminal window: a title bar above a screen area. The SerialTerm palette icon.

### src/icons/components/servo.png
- 36×24, 357 opaque + 218 semi, bbox x 2–33, y 0–22, colour `31,31,31`×311 (dark grey, not black). A servo: a stator stack with an output horn on the right. The Servo palette icon.

### src/icons/components/seven_segment.png
- 36×24, 84 opaque + 207 semi, bbox x 12–24, y 2–21. A seven-segment "8" (a 2×2 grid of filled blocks) inside a 2-px frame. The SevenSegment output palette icon.

### src/icons/components/sh1107.png
- 36×24, 371 opaque + 230 semi, bbox x 6–28, y 3–23. A solid black rectangle — the SH1107 OLED package icon.

### src/icons/components/shield.png
- 20×20, 62 opaque + 192 semi, bbox x 1–19, y 3–16. An Arduino shield outline with a row of header pins. The "Shields" category pictogram (`src/gui/componentlist/itemlibrary.cpp:261`).

### src/icons/components/sin.png
- 80×42, 372 opaque + 286 semi, bbox x 1–78, y 1–40. **One full period of a sine** — a smooth, thick (~6-px) curve across the entire 80-px width, with a small marker glyph at the right edge. Loaded by `WaveGen::setWaveType` as `":/sin.png"` (`src/components/sources/wavegen.cpp:340`) and blitted at 16×8 into the property widget (`src/components/sources/wavegen.cpp:553`).
- Purpose: a *menu preview* of the signal shape, not data the simulator reads.
- Key abstractions: the wave *type* is a string ("Sine"/"Saw"/"Triangle"/"Square"/"Random"/"Wav") and the preview art is a table of files beside it — six files, one per type, all in the flat `:/` namespace.
- Data flow: `setWaveType` maps the string to a resource path, deletes the previous `m_wavePixmap` and loads the new one (`src/components/sources/wavegen.cpp:340-348`); `WaveGen::paint` blits it scaled to **16 × 8** px (`src/components/sources/wavegen.cpp:553`) — the source images are 80 × 42, a 5.25× oversample, so the marker glyph on the right is invisible in the rendered preview.
- Non-obvious design decisions: the *shape* of the signal is an asset, not a rendering. The simulator computes the real waveform elsewhere, so the preview and the mathematics can drift apart with **nothing to detect it** — a picture of a sine next to a square-wave generator is a perfectly plausible state of the tree.
- Edge cases / failure handling: an unrecognised type leaves `pixmapPath` empty and `m_wavePixmap` a null pixmap; `QPainter::drawPixmap` with a null pixmap is a no-op, so the preview silently disappears rather than erroring.
- Surprising: all six images are 80 × 42 and all six are pure black-on-transparent, so they are the only *previews* in the shard that are also the only *data* assets.

### src/icons/components/socket.png
- 36×24, 71 opaque + 84 semi, bbox x 3–31, y 12–14. A socket body: a horizontal rule with five contact stubs. The Socket palette icon.

### src/icons/components/socket_H.png
- 16×16, 256 opaque, 0 semi, greyscale `65,65,65`×136 / `0,0,0`×34 / `45,45,45`×10. A dark square with a **lighter band along the bottom edge** (rows 11–15, cols 5–10). The live "socket horizontal" pin glyph.

### src/icons/components/socket_V.png
- 16×16, 256 opaque, 0 semi, greyscale `65,65,65`×136 / `0,0,0`×34 / `38,38,38`×8. A dark square with a lighter band along the **bottom-left** (rows 11–15, cols 4–9) — the vertical twin of `socket_H.png`. The previous pass's "light band at the lower edge" was right for this one but wrong about `socket_H.png`'s band running across the full width.

### src/icons/components/socket-H.png
- 16×16, 256 opaque, greyscale `50,50,50`×160 / `0,0,0`×15 / `85,85,85`×15 — a **uniformly dark** square with no band. The hyphen-named duplicate of `socket_H.png`; **not registered** in `application.qrc` — dead.

### src/icons/components/socket-V.png
- 16×16, 256 opaque, greyscale `50,50,50`×162 / `0,0,0`×15 / `85,85,85`×15 — again uniformly dark. The hyphen-named duplicate of `socket_V.png`; **not registered** — dead. (The hyphen/underscore pair is the only *pair* of near-twins in the shard; `termistor`/`thermistor` is a byte-identical pair instead.)

### src/icons/components/socket_p.png
- 20×20, 79 opaque + 48 semi, bbox x 6–13, y 0–18. A vertical pin strip with a side bracket. **Not registered** — dead.

### src/icons/components/sqa.png
- 80×42, 754 opaque + 236 semi. A square wave: a solid bar across the top (rows 0–4) and the low level marked only by the two 5-px edge verticals. The WaveGen "Square" preview (`src/components/sources/wavegen.cpp:343`).

### src/icons/components/sr04.svg
- 672 × 288 (viewBox 0 0 177.8 76.2), 155 lines. The HC-SR04 board drawn as a vector: a `#2e3089` blue rounded PCB (177.45 × 75.78), two `#acacac` grey transducer circles of r = 31.91 at (42.86, 38.14) and (135.21, 38.32), each with a black concentric ring (`path2514`, an SVG arc pair) and **nine** grey grille lines (`path4755*`) drawn inside a rotated group. Loaded as the component's background by `src/components/micro/sr04.cpp:42`.
- This is the only asset in the shard that is a *photographic-style* vector: gradients, arcs and 3-D-looking grille lines rather than a schematic symbol.

### src/icons/components/sr04_ico.png
- 36×24, 540 opaque, 0 semi, colour `46,48,137`×119 / `42,44,126`×94 — the **same blue** (`#2e3089`) as `sr04.svg`. A raster of the HC-SR04 with its two round transducers. The SR04 palette icon, the raster twin of the vector body.

### src/icons/components/ssd1306.png
- 36×24, 270 opaque + 216 semi, bbox x 5–28, y 4–20. A solid black rectangle — the SSD1306 OLED package icon.

### src/icons/components/st7735.png
- 36×24, 352 opaque + 220 semi, bbox x 7–28, y 3–18. A solid black rectangle — the ST7735 TFT package icon.

### src/icons/components/st7789.png
- 36×24, 476 opaque + 241 semi, bbox x 3–30, y 3–19. A solid black rectangle — the ST7789 TFT package icon.

### src/icons/components/steeper.png
- 36×24, 306 opaque + 245 semi, bbox x 4–29, y 2–21, colour `31,31,31`×233. A stepper motor: two coil blocks and a shaft. The file name **misspells "stepper"**; the component class is `Stepper` and the palette item is `Stepper::libraryItem()` (`src/gui/componentlist/itemlibrary.cpp:244`).

### src/icons/components/strain.png
- 36×24, 49 opaque + 287 semi, bbox x 6–29, y 1–22. A strain gauge: a box containing a serpentine resistive grid. The Strain palette icon.

### src/icons/components/su.png
- 9×9, 81 opaque, 0 semi, colours `50,70,100`×41 / `32,50,78`×15 / `82,103,135`×15. A dark-blue (`#324664`) tile with a white **plus sign**. Registered (`src/application.qrc:267`) and referenced by no code — dead. It is the positive half of a `su`/`giu` pair that was apparently a pair of buttons that were never wired up.

### src/icons/components/subc.png
- 20×20, 94 opaque + 104 semi, bbox x 0–19, y 1–17. A subcircuit block: a rectangle with two input pins on the left and two output pins on the right, and an **empty interior**. The "Memory" category pictogram (`src/gui/componentlist/itemlibrary.cpp:295`).

### src/icons/components/subc2.png
- 20×20, 110 opaque + 83 semi, bbox x 0–19, y 2–18. The same block with **four** pins on each side. Registered (`src/application.qrc:140`); referenced by no category.

### src/icons/components/subc_ico.png
- 20×20, 94 opaque + 170 semi, bbox x 0–19, y 1–17. The subcircuit block with its interior filled by a **maze-like squiggle** (a different art from `subc.png`'s empty interior). The SubCircuit palette icon.

### src/icons/components/subc_ico-0.png
- 20×20, 137 opaque + 60 semi, bbox x 0–19, y 1–17. A third squiggle variant, visually the **mirror** of `subc_ico.png`'s. **Not registered** in `application.qrc` — dead.

### src/icons/components/subc_ico-1.png
- 20×20, 141 opaque + 58 semi, bbox x 0–19, y 1–17. A fourth squiggle variant; it differs from `subc_ico.png` in **112 pixels** (the whole interior region x 6–13, y 3–16), not by a pixel or two. **Not registered** — dead.

### src/icons/components/subcl.png
- 20×20, 94 opaque + 104 semi, the **same geometry as `subc.png`** (identical 94/104/0,1-19,17 triple) but painted in grey `81,81,81` (`#515151`) instead of black. It is the "Link to Component" context-menu icon (`src/components/linkercomponent.cpp:51`, and the same icon at `src/components/other/subpackage.cpp:279`, `src/components/other/dial.cpp:200`, `src/components/outputs/leds/led.cpp:69`, `src/microsim/mcu.cpp:553`).
- The design decision: **the same drawing in two colours** — black for a normal item, grey for a "this is a link, not a part" item.

### src/icons/components/switch.png
- 36×24, 67 opaque + 88 semi, bbox x 1–34, y 5–14. An SPST switch: a lever leaning from a lower-left contact to an upper-right contact. The Switch palette icon.

### src/icons/components/switchdip.png
- 36×24, 166 opaque + 242 semi, bbox x 5–29, y 0–21. A DIP switch: a package outline containing **eight** levers. The SwitchDip palette icon.

### src/icons/components/termistor.png
- 36×24, 171 opaque + 47 semi, bbox x 1–34, y 2–16 — and **byte-identical** to `thermistor.png` (same SHA-256, same 320 bytes). It is the misspelled twin of the live file. **Not registered** in `application.qrc` (`thermistor.png` is registered at `:127`) — dead. It is the *only* byte-identical pair in the entire shard.

### src/icons/components/text.png
- 36×24, 95 opaque + 197 semi, bbox x 4–30, y 2–21. A text box: a 2-px frame containing letterforms. The TextComponent palette icon.

### src/icons/components/thermistor.png
- 36×24, 171 opaque + 47 semi, bbox x 1–34, y 2–16. A resistor in a box crossed by a **diagonal stroke** — the thermistor symbol. The Thermistor palette icon. Registered (`src/application.qrc:127`).

### src/icons/components/toggleswitch.png
- 36×24, 86 opaque + 101 semi, bbox x 1–34, y 5–14. A toggle lever standing up from a pivot. The toggle-switch palette icon.

### src/icons/components/touch.png
- 36×24, 113 opaque + 154 semi, bbox x 1–35, y 2–22. A capacitive touch pad: a rounded square frame enclosing concentric rings and a pointer arrow. The TouchPad palette icon.

### src/icons/components/transformer.png
- 36×24, 176 opaque + 140 semi, bbox x 5–30, y 1–22. Two coil pairs flanking a core bar, with the core drawn as a separate horizontal rule. The Transformer palette icon.

### src/icons/components/transistors.png
- 20×20, 59 opaque + 63 semi, bbox x 1–17, y 2–17. A BJT symbol reused as the "Transistors" *category* pictogram (`src/gui/componentlist/itemlibrary.cpp:208`) — the same dual-role trick as `gates.png`.

### src/icons/components/tri.png
- 80×42, 382 opaque + 271 semi, bbox x 1–78, y 1–40. A single clean triangle wave: one rising edge, one falling edge, one period. The WaveGen "Triangle" preview (`src/components/sources/wavegen.cpp:342`).

### src/icons/components/triac.png
- 36×24, 144 opaque + 197 semi, bbox x 12–28, y 1–22. A TRIAC: two opposed triangles plus a gate lead. The Triac palette icon.

### src/icons/components/tunnel.png
- 36×24, 19 opaque + 138 semi, bbox x 4–32, y 5–15. A bracket carrying a wire across it. The Tunnel palette icon.

### src/icons/components/up.png
- 6×23, 138 opaque, 0 semi, fill `200,220,180` (`#C8DCB4`) — a narrow pale-green strip with the arrow head at rows 4–7. **Not registered** in `application.qrc` (`down.png` *is* registered at `:269`) — dead.

### src/icons/components/varcapacitor.png
- 36×24, 151 opaque + 220 semi, bbox x 1–34, y 2–20. Capacitor plates crossed by a diagonal arrow. The VarCapacitor palette icon.

### src/icons/components/varinductor.png
- 36×24, 115 opaque + 194 semi, bbox x 1–34, y 2–18. A coil crossed by a diagonal arrow. The VarInductor palette icon.

### src/icons/components/varresistor.png
- 36×24, 160 opaque + 58 semi, bbox x 0–34, y 2–18. A resistor in a box crossed by a diagonal arrow. The VarResistor palette icon.

### src/icons/components/voltage.png
- 36×24, 124 opaque + 34 semi, bbox x 5–30, y 3–20. The fixed-voltage source block: a rounded rectangle with a solid tab on the right.

### src/icons/components/voltimeter.png
- 36×24, 176 opaque + 62 semi, bbox x 7–29, y 1–22. A meter face carrying a "V" (two strokes meeting at a point). The VoltMeter palette icon.

### src/icons/components/voltreg.png
- 36×24, 103 opaque + 104 semi, bbox x 5–30, y 1–22. A regulator: a box containing an internal transistor and a feedback divider. The VoltReg palette icon.

### src/icons/components/voltsource.png
- 36×24, 93 opaque + 200 semi, bbox x 1–26, y 2–23. A circle with an internal arrow (the voltage-source symbol) and two leads. The VoltSource palette icon.

### src/icons/components/wav.png
- 80×42, 1272 opaque + 594 semi — the **densest** of the six wave previews: a multi-bar spiky trace for the file-driven "Wav" type (`src/components/sources/wavegen.cpp:345`).

### src/icons/components/wavegen.png
- 36×24, 166 opaque + 73 semi, bbox x 2–33, y 3–20. A generator box whose screen carries **two** traces — a sine and a square-wave mark side by side. The WaveGen source palette icon.

### src/icons/components/ws2812.png
- 36×24, 94 opaque + 271 semi, bbox x 7–26, y 2–21. A package outline with a central cut-out. The addressable-RGB LED palette icon.

### src/icons/components/xorgate.png
- 20×20, 37 opaque + 157 semi, bbox x 0–19, y 3–16. The XOR gate: an OR body plus the extra curved input line. The XorGate palette icon.

### src/icons/components/zener.png
- 36×24, 213 opaque + 107 semi, bbox x 1–34, y 4–18. A Zener diode: a triangle meeting a **bent** cathode bar. The Zener palette icon.

### src/icons/font/font.png
- 1280×7, 2256 opaque + 80 semi, ink bbox x 167–1279, y 0–6. A **10 × 7 bitmap-font atlas of exactly 128 cells**: ink in 96 of them, the first at cell 16 and the last at cell 127 — i.e. cells 0–15 (the control characters) are blank, exactly as expected for a CP437-style atlas. **Not registered in `application.qrc` and referenced nowhere** — dead. The 5×7 companion of `font2.png` was clearly planned and never shipped.
- The previous pass's "1280×7 … 10×7 (128-cell) companion atlas" is confirmed; what it did not note is that the *first 167 columns are empty*, which is what makes the 10-px cell pitch verifiable rather than assumed.

### src/icons/font/font2.png
- Purpose: the character-generator bitmap for the simulated HD44780 LCD — a **2560 × 16 RGBA strip holding exactly 256 glyph cells of 10 × 16 px**.
- Key abstractions: a *sprite sheet addressed by character code*: `m_fontImg.copy( char_num*10, 0, 10, 16 )` (`src/components/outputs/displays/hd44780_base.cpp:297`). One file, no font dependency, no licence, one `copy()` per character drawn. Measured: ink in 189 of the 256 cells, the first at cell 33 (`!`) and the last at cell 255 — so the atlas is genuinely 256 cells wide, cells 0–32 (control characters plus space) are blank, and the pitch of 10 px is verifiable from the file itself rather than assumed.
- Data flow: loaded once in the constructor into a `QImage` member (`src/components/outputs/displays/hd44780_base.cpp:15`, declared `src/components/outputs/displays/hd44780_base.h:43`); the paint routine copies the cell for the code in DDRAM and blits it at the cell position, and for codes 0–7 instead *patches* a copy of glyph 0 with the 8 CGRAM bytes, one 5 × 8 dot rendered as a **2 × 2 pixel block** (`src/components/outputs/displays/hd44780_base.cpp:277-296`).
- Non-obvious design decisions: the CGRAM path starts from a copy of glyph 0 rather than from a blank cell, so a user-defined character is a *patch of a known glyph*, not a new rendering path. The custom-character dot pitch (2 px) is twice the font pitch, so a CGRAM character is drawn as 5 × 8 dots inside a 10 × 16 cell.
- Edge cases / failure handling: `char_num < 8` is the CGRAM branch; codes 8–255 are the atlas. There is **no bounds check** on `char_num*10` — it relies on the atlas being exactly 2560 px wide, so a truncated or replaced `font2.png` silently yields blank cells rather than an error.
- Surprising: the resource is loaded as `":font2.png"` — **one colon, no slash** (`src/components/outputs/displays/hd44780_base.cpp:15`) — while 91 distinct `":/…"` resource strings are used elsewhere in `src/`. It is one of **two** such references, not the only one: `src/components/connectors/tunnel.cpp:207` asks for `":nobreakpoint.png"` and, three lines later at `:210`, correctly asks for `":/breakpoint.png"` for the sibling action. Both are almost certainly missing-slash typos, and the tunnel pair proves what the consequence is: a `QPixmap` built from an unresolvable path is null, so the "Hide group" action gets **no icon** while "Show group" gets one, with no error anywhere. Whether Qt's resource engine resolves the one-colon form at all could not be established here (see *Uncertainties*).

### src/icons/mainwindow/about.svg
- 22×22, 88 lines, **two `<path>` elements with identical `d` data offset by 1.0 in y**: the first `fill:#ffffff;opacity:0.6`, the second `fill:#000000;opacity:0.7`. The geometry is a 12-point starburst (`m 17,1051.3629 -6,-4 -6,4 2,-7 -5,-5 6.75,0 2.25,-6 2.25,6 6.75,0 -5,5`). The "About" action icon.

### src/icons/mainwindow/complib.svg
- 30×30, 92 lines, two paths, both `fill:#000000;opacity:0.8` (the one exception to the 0.6/0.7 recipe). The geometry is a chip/package outline (`m 12.5,1029.3622 -2.625,2.625 v 14.4375 l 2.625,2.625 h 13.125 l 2.625 …`) with a digit-like glyph inside. The component-library side-panel tab icon.

### src/icons/mainwindow/config.svg
- 24×24, 82 lines, the 0.6-white / 0.7-black duplicated-path pair. A gear: a hub with teeth cut by a running curve (`m 11.00003,1031.3622 0,3.1563 c -0.97646,0.1998 …`). The Settings action icon.

### src/icons/mainwindow/copy.svg
- 22×22, 106 lines, the duplicated-path pair, but the fills are **gradient** references rather than flat colours — the file defines **seven** `linearGradient`s. The geometry is two overlapping documents (`m 4,1031.3622 -2,2 0,13 2,2 1,0 0,-2 …`). The Copy action icon.

### src/icons/mainwindow/cut.svg
- 22×22, 95 lines, the 0.6/0.7 pair. A pair of scissors: the path traces a handle outline, a blade, and a series of `3,3 -3,3` zigzags that are the scissor blades. The Cut action icon.

### src/icons/mainwindow/debug.svg
- 22×22, 91 lines, the 0.6/0.7 pair, plus `stroke:#000000` on both paths. The geometry is a curved insect shape (`m 9.8897885,1037.6022 c 0.2363865,-0.234 …`) — the ladybird used as the Debug action icon in the code editor.

### src/icons/mainwindow/files.svg
- 30×30, 80 lines, **one** path, `fill:#000000;opacity:0.8` — the only single-path icon in the directory. An open folder (`m 4.343298,1037.3844 h 9.134316 l 3.044773,3.0448 h 9.134315 v 13.7004`). The file-browser side-panel tab icon.

### src/icons/mainwindow/find.svg
- 22×22, 84 lines, the 0.6/0.7 pair. A magnifying glass: a ring plus a handle (`m 4,1032.3615 -2,2 0,11 2,2 11,0 5,5 2,-2 -5,-5 0,-10.5 -2.5,-2.5 z`). The Find/Replace action icon.

### src/icons/mainwindow/help.svg
- 22×22, **144 lines and 11 nested Inkscape groups** — the most structurally complex icon in the shard, and the only one with `opacity:1;opacity:1` (no translucency). The geometry is a question mark built from quarter-arcs (`M 7.1111111,0 0,7.1111111 V 8.8888889 L 7,16 H 8.8888889 L 16,8.8888889 …`).

### src/icons/mainwindow/hflip.svg
- 22×22, 84 lines, the 0.6/0.7 pair. Two triangles flanking a vertical bar (`m 5.0054884,1037.3622 -5.00000595,5 5.00000595,5 …`). The Horizontal Flip action icon.

### src/icons/mainwindow/lastfiles.svg
- 22×22, 91 lines, the 0.6/0.7 pair, plus `stroke:#000000`. A folder with a clock hand (`m 5,1051.3622 c -1.9101596,0 -4,-2.0898 -4,-4 v -11 c 0,-1.9102 2.0898 …`). The recent-files button.

### src/icons/mainwindow/list.svg
- 24×24, 98 lines, the duplicated pair with **gradient** fills (seven `linearGradient`s defined). The geometry is a bulleted list: a long rule, a short rule, and a third rule, all in one path (`m 9,1042.3622 10,0 0,2 -10,0 z m 0,3 8,0 0,1 -8,0 z m 0,-9 10,0 0,2 -1 …`).

### src/icons/mainwindow/load.svg
- 22×22, 91 lines, the 0.6/0.7 pair. A rounded tray/folder (`m 5,1032.3622 c -1.9101596,0 -4,2.0898 -4,4 l 0,11 …`). The install/load action icon.

### src/icons/mainwindow/new.svg
- 22×22, 82 lines. The **exemplar** of the directory's recipe: path 1 is `fill:#ffffff;opacity:0.6` at `d="m 17.00003,1033.3622 0,3 -3,0 0,2 3,0 0,3 2,0 0,-3 3,0 0,-2 -3,0 0,-3 -2,0 z m -13,4 -2,2 0,11 2,2 14,0 2,-2 0,-9 -2,2 0,7 -14,0 0,-11 6,0 2,2 4,0 -2,-2 -1,0 -2,-2 -7,0 z"`, and path 2 is `fill:#000000;opacity:0.7` at the **same geometry offset by 1.0007 in y** (`m 17.00003,1032.3615 …`). A document outline with a "+" spark.
- This is the mechanism that makes the whole toolbar work: a monochrome icon is drawn **twice**, a translucent white copy 1 px below a translucent black copy, so the glyph carries its own light rim and stays legible on any background. It is also why the theme inverter can work: every pixel of the pair is pure greyscale, so `ThemeManager::invertPixmap` — which abandons the whole image on the first non-grey pixel (`src/gui/thememanager.cpp:113-126`) — is able to invert it.

### src/icons/mainwindow/open.svg
- 22×22, 84 lines, the 0.6/0.7 pair. A folder with an up arrow (`m 4,1039.3629 6,0 2,2 6,0 0,8.9993 -14,-4e-4 z m 0,-2 -2,2 0,10.9993 2 …`). The Open action icon — and note that the *component* list, the *editor* and the *file browser* all ask for `":/open.png"`, a file that does not exist (see *Uncertainties*).

### src/icons/mainwindow/paste.svg
- 24×24, 89 lines, the 0.6/0.7 pair. A clipboard with a clip at the top (`m 9,1030.3622 -1,1 0,1 -3,0 -2,2 0,15 2,2 14,0 2,-2 0,-15 -2,-2 -3,0 0 …`). The Paste action icon.

### src/icons/mainwindow/pause.svg
- 22×22, 84 lines, the 0.6/0.7 pair. Two vertical bars (`m 5.0000002,1036.3611 -1.5e-5,11.9989 4.0000195,0 1.5e-5,-11.9989 z m …`). The debugger Pause action icon.

### src/icons/mainwindow/properties.svg
- 22×22, 91 lines, the 0.6/0.7 pair. A cogwheel inside a frame (`m 5,1032.3622 -3,3 0,14 3,3 12,0 3,-3 0,-14 -3,-3 -12,0 z m 1,2 10,0 2 …`). The Properties action icon.

### src/icons/mainwindow/reload.svg
- 22×22, 92 lines, the 0.6/0.7 pair. Two circular arrows (`m 14,1035.3622 3,3 -3,3 2,0 3,-3 -3,-3 z m -8,2 -3,3 0,4 2,-2 0,-1 2,-…`). The Reload action icon.

### src/icons/mainwindow/remove.svg
- 22×22, 97 lines, the 0.6/0.7 pair. The Qt "dialog-no" theme glyph — a circled X. The Remove action icon.

### src/icons/mainwindow/rename.svg
- 22×22, **91 lines but 11 880 bytes** — by far the largest SVG in the shard, because the "R" is drawn as **outlines**, not as text: the style still carries `font-family:Ubuntu` in the Inkscape metadata, and the path data is the expanded glyph. The pair uses `opacity:0.6` / `opacity:0.75` (the only 0.75 in the directory). The Rename glyph.

### src/icons/mainwindow/reset.svg
- 22×22, 85 lines, the 0.6/0.7 pair. A counter-clockwise arrow around a square. The debugger Reset action icon.

### src/icons/mainwindow/rotate180.svg
- 22×22, 85 lines, the 0.6/0.7 pair. A half-turn arrow. The Rotate-180 action icon.

### src/icons/mainwindow/rotateccw.svg
- Purpose: the toolbar and context-menu glyph for **Undo** — an artwork that has nothing to do with undo, and is published under a name that has nothing to do with the file.
- Key abstractions: **the resource alias, not the filename, is the API.** `src/application.qrc:65` registers the file `src/icons/mainwindow/rotateccw.svg` under the alias `undo.svg`; `src/application.qrc:89` registers the same file a second time under its own name. The two public names for one drawing are `undo.svg` and `rotateccw.svg`, and only the first is used by code.
- Data flow: `EditorWindow` asks for `":/undo.svg"` and never learns which file drew it — `src/gui/editorwidget/editorwidget.cpp:801` creates the action and `src/gui/editorwidget/editorwidget.cpp:934` re-themes it; `src/gui/circuitwidget/circuitview.cpp:258` asks for the same alias in the canvas context menu and wires it to `Circuit::undo`; `src/gui/editorwidget/codeeditor.cpp:724` asks for it in the code editor. `application.qrc` flattens all 211 assets into one `:/` namespace, so no caller can get a directory prefix wrong.
- Non-obvious design decisions: one drawing can legitimately serve two meanings (a rotation arrow *is* an undo arrow), and the artwork can be renamed without touching a single call site. The undo/redo stack it stands for is a **snapshot** of component changes, not a command pattern: `QList<circChange> m_undoStack` with `m_maxUndoSteps` read from the `Circuit/undoSteps` setting and defaulting to 100 (`src/gui/circuitwidget/circuit.cpp:77-78`, `src/gui/circuitwidget/circuit.h:235-249`).
- Edge cases / failure handling: because the alias lives only in the qrc, a code change that asks for the *filename* instead of the alias still compiles and still runs — it just yields a null `QIcon` and an action with no glyph. `verify.png` is the mirror-image case: it is registered **only** as `setroot.png` (`src/application.qrc:71`), so `":/verify.png"` does not exist, and the one caller asks for the alias (`src/gui/filebrowser/filebrowser.cpp:157`).
- Surprising: the file is 22×22 and carries the same duplicated-path emboss as the other 37 toolbar SVGs — a white copy at `opacity:0.6` offset 1 unit below a black copy at `opacity:0.7` — so the glyph carries its own light rim and survives a theme inversion (`src/gui/thememanager.cpp:113-126` abandons the whole image on the first non-grey pixel, and this icon is entirely greyscale).

### src/icons/mainwindow/rotatecw.svg
- 22×22, 84 lines, the 0.6/0.7 pair, a right-pointing chevron arrow. **Registered under the alias `redo.svg`** (`src/application.qrc:66`) and under its own name (`:88`). Callers: `src/gui/editorwidget/editorwidget.cpp:806` and `:935`, `src/gui/circuitwidget/circuitview.cpp:262`, `src/gui/editorwidget/codeeditor.cpp:728`.

### src/icons/mainwindow/save.svg
- 22×22, 85 lines, the 0.6/0.7 pair. A floppy disk. The Save action icon — and the file the component list, the editor and the file browser all *should* be asking for, but they ask for the non-existent `":/save.png"` instead.

### src/icons/mainwindow/saveas.svg
- 22×22, 91 lines, the 0.6/0.7 pair. A floppy with an arrow and a dotted label. The Save-As action icon.

### src/icons/mainwindow/saveimage.svg
- 22×22, 93 lines, the 0.6/0.7 pair, but with `opacity:0.6` / `opacity:0.66` (the only 0.66 in the directory). A picture frame containing a sun and a mountain. The Save-Image action icon.

### src/icons/mainwindow/step.svg
- 22×22, 97 lines, the 0.6/0.7 pair. A triangle crossed by a diagonal bar. The debugger Step-Over action icon.

### src/icons/mainwindow/stop.svg
- 22×22, 85 lines, the 0.6/0.7 pair. A filled square. The Stop-Debugger action icon.

### src/icons/mainwindow/terminal.svg
- 22×22, 98 lines, the 0.6/0.7 pair. A terminal window with a title bar. The Terminal action icon.

### src/icons/mainwindow/upload.svg
- 22×22, **206 lines** — the second-largest SVG in the shard, because it draws an up arrow entering a tray with far more path commands than the others. The 0.6/0.7 pair. The Upload-firmware action icon.

### src/icons/mainwindow/verify.svg
- 22×22, 91 lines, the 0.6/0.7 pair. A check mark over a base. The Compile/Verify action icon.

### src/icons/mainwindow/vflip.svg
- 22×22, 89 lines, the 0.6/0.7 pair. Two triangles above and below a horizontal bar. The Vertical Flip action icon.

### src/icons/mainwindow/zoom.svg
- 22×22, 99 lines, the duplicated pair with a **gradient** fill (`url(#linearGradient4382)`). A magnifying glass with a gradient body. **Not registered in `application.qrc`** — dead. The live zoom icons are `zoomfit.svg` and `zoomsel.svg`.

### src/icons/mainwindow/zoomfit.svg
- 22×22, **137 lines, 10 paths = 5 pairs**: five white `opacity:0.6` paths followed by five black `opacity:0.7` paths, the two sets sharing geometry. A magnifying glass plus four corner arrows. The Zoom-to-fit action icon.

### src/icons/mainwindow/zoomone.svg
- 22×22, 113 lines, **4 paths = 2 pairs**, with opacities `1, 0.6, 0.7, -` — the only icon that mixes an opaque pair with a translucent pair, because it carries both a magnifier and an outlined "1" glyph. The Zoom-to-1:1 action icon.

### src/icons/mainwindow/zoomsel.svg
- 22×22, **143 lines, 10 paths = 5 pairs**, with opacities `0.6,0.6,0.6,0.6,0.6, 0.7,1,0.7,0.7,0.7` — one black path is fully opaque. A magnifying glass plus four corner brackets around a selection. The Zoom-to-selected action icon.

### src/icons/mainwindow/attach.png
- 22×22, **0 opaque** pixels, 140 semi-transparent, all greyscale `4D4D4D`/`4F4F4F`/`171717` with a white (`#FFFFFF`) underlay at low alpha. A **down-left arrow into a chevron/bracket**. The gdb-attach action icon.

### src/icons/mainwindow/breakpoint.png
- 22×22, 72 opaque + 84 semi, bbox x 7–14, y 6–14, colours `228,228,9`×16 / `229,229,10`×16 / `230,230,11`×16 — a **yellow** (`#E4E409`) marker bar. The breakpoint toggle state.

### src/icons/mainwindow/brkpoint.png
- 44×44, 52 opaque + 552 semi, bbox x 9–34, y 8–33, colours `0,0,0`×26, `255,255,255`×25 and **`492,775` (`#492775`) × 25** plus its antialiased neighbours. A purple marker shape on a black field with a white highlight. The large breakpoint badge; registered at `src/application.qrc:75`.

### src/icons/mainwindow/cdup.png
- 22×22, 0 opaque, 140 semi, the same 55-colour greyscale palette as `attach.png`. An **up arrow over a chevron**. The "go to parent directory" button (`src/gui/filebrowser/filewidget.cpp:35`).
- Note on the family: `lastfiles` is an **SVG** (`src/icons/mainwindow/lastfiles.svg`), not a PNG; the parent-directory *button* is the PNG `cdup.png`, and the recent-files *button* is the SVG.

### src/icons/mainwindow/closeterminal.png
- 22×22, 7 opaque + 275 semi, bbox x 7–13, y 13–14, greyscale `5E5E5E`/`323232`/`010101` with a translucent white underlay. A terminal window with an X. Registered (`src/application.qrc:98`) and referenced by no code — dead.

### src/icons/mainwindow/detach.png
- 22×22, 0 opaque, 140 semi, the same 55-colour palette as `attach.png` and `cdup.png` but a different hash. An **up-right arrow over a chevron** — the mirror of `attach.png`. The gdb-detach action icon.

### src/icons/mainwindow/expose.png
- 48×48, 142 opaque + 1588 semi, bbox x 5–21, y 6–32, with **`255,255,0` (`#FFFF00`) × 124** among 508 distinct colours. A greyscale chip/document shape with a **yellow arrow** leaving it. The "expose" action. The yellow is the one saturated colour in the two 48×48 icons — and it lives here, not in `link.png`.

### src/icons/mainwindow/invert.png
- 22×22, 69 opaque + 132 semi, bbox x 2–16, y 1–20, colour `95,95,95` (`#5F5F5F`) × 69. A pale-grey zigzag/waveform stroke. The invert/swap-colours glyph.

### src/icons/mainwindow/link.png
- 48×48, 360 opaque + 1552 semi, bbox x 5–44, y 6–41, **694 distinct colours and NOT ONE of them saturated** — I checked every pixel with a channel spread > 40 and found none. It is a **pure greyscale chain-link** (two interlocking rings). The "link to component" action. The previous pass's "yellow arrow leaving a chain link" was wrong: the yellow arrow is in `expose.png`.

### src/icons/mainwindow/nobreakpoint.png
- 22×22, 95 opaque + 89 semi, bbox x 6–15, y 7–16, colours `59,59,34` / `228,228,9` / `230,230,11` — the yellow marker **crossed out** with a dark diagonal. The breakpoint-off state. It is also the file asked for by the one-colon reference at `src/components/connectors/tunnel.cpp:207`.

### src/icons/mainwindow/pausesim.png
- 32×32, 996 opaque + 24 semi, bbox x 0–31, y 0–31, colours `255,255,255`×164 and `117,0,0` (`#750000`) × 96 — a **dark-red** rounded badge. The "pause simulation" action icon (`src/gui/circuitwidget/circuitwidget.cpp:175`), restored when the simulation resumes (`src/gui/circuitwidget/circuitwidget.cpp:479`).

### src/icons/mainwindow/powerdeb.png
- 32×32, 996 opaque + 24 semi, colours `252,252,254`×144 and `67,95,192` (`#435FC0`) × 96 — a **blue** rounded badge. The "enter debug mode" state icon.

### src/icons/mainwindow/poweroff.png
- 32×32, 996 opaque + 24 semi, colours `255,255,255`×144 and `117,0,0` (`#750000`) × 96 — the **same dark red** as `pausesim.png` (a different file, a different hash, but the same palette). The "simulation stopped" state icon, set by `CircuitWidget::powerCircOff` (`src/gui/circuitwidget/circuitwidget.cpp:410`) and re-set when the simulation is paused (`src/gui/circuitwidget/circuitwidget.cpp:470`).

### src/icons/mainwindow/poweron.png
- 32×32, 992 opaque + 32 semi, colours `255,255,255`×108 and `143,130,15` (`#8F820F`) × 25 — an **olive** rounded badge. The "simulation running" state icon. The olive/red/blue palette is the whole simulation-state language: **running / stopped / debugging**.
- The badge is set by `CircuitWidget::powerCircOn` (`src/gui/circuitwidget/circuitwidget.cpp:394`), which also sets the action's text to "Stop Simulation" and its `iconText` to `"On"` — and that `iconText` is what the *next* click reads to decide which branch to take (`src/gui/circuitwidget/circuitwidget.cpp:388-389`). The icon and the icon's text are the whole state store.

### src/icons/mainwindow/runtobk.png
- 24×24, **0 opaque** pixels, 126 semi-transparent, 31 distinct greys (`#4B4B4B` down to `#414141`). A grey arrow pointing down-right onto a block. The "run to breakpoint" action icon.

### src/icons/mainwindow/simpaused.png
- 32×32, 996 opaque + 24 semi, colours `255,255,255`×171 and `161,48,40` (`#A13028`) × 96 — a **brown-red** rounded badge, deliberately distinguishable from the `#750000` of `poweroff.png` (the white counts differ too). The "simulation paused" state icon, set when the pause action is pressed (`src/gui/circuitwidget/circuitwidget.cpp:469`). The four state badges differ by ~10 in the white count, so the states are separable at a glance.

### src/icons/mainwindow/switchbut.png
- 22×22, 82 opaque + 74 semi, bbox x 6–15, y 4–14, colours `143,190,0` / `136,186,0` / `137,188,0` — a **green** (`#88BA00`) rounded button. The DIP-switch run/stop button (`src/components/switches/switchdip.cpp:106`, and again at `:154` and `:178`).

### src/icons/mainwindow/unuse.png
- 22×22, 23 opaque + 151 semi, bbox x 15–16, y 1–20, colour `95,95,95` (`#5F5F5F`). A **dashed cross**: a vertical dashed run down x 15–16 from y 1 to 20, crossed by a horizontal dashed run at rows 9–13. The "unused/dashed connector" indicator. Registered (`src/application.qrc:103`) and referenced by no code. The previous pass's "pale-grey diagonal dashes" was wrong: the dashes are axis-aligned and form a cross.

### src/icons/mainwindow/verify.png
- 24×24, **0 opaque** pixels, 76 semi-transparent, 44 distinct greys (`#585858`, `#5B5B5B`, `#555555`…). A small **dark-grey check mark** (confirmed by rendering: the shape is a tick, rising to the right). **Registered under the alias `setroot.png`** (`src/application.qrc:71`) and *only* under that alias — so the resource name `":/verify.png"` does not exist. Its one caller asks for the alias: the "Add Bookmark" action at `src/gui/filebrowser/filebrowser.cpp:157`.

---

## The four assets in this shard that carry a real mechanism

### Group: the component-background family (dht22.svg, dht11.svg, sr04.svg, dsxxx.png, esp01.png)
- Purpose: the DHT22/DHT11 sensor's body artwork, drawn as Inkscape primitives so the schematic shows the real part.
- Key abstractions: `Component::setBackground()` — a component's visual body is a *named file*, not code (`src/components/component.cpp:625-653`).
- Data flow: `Dht22` calls `setBackground("dht22.svg")` (`src/components/micro/dht22.cpp:254`) and the same class in DHT11 mode calls `setBackground("dht11.svg")` (`src/components/micro/dht22.cpp:257`). The loader then walks: the circuit's own folder (`MainWindow::getCircFilePath`, `src/mainwindow.cpp:438-453`, which is itself two tiers — the circuit folder and the circuit's `data/` folder) → the shared data folder → `":/"+name` (`src/components/component.cpp:642-644`).
- Non-obvious design decisions: `setBackground` also accepts a `"color(r,g,b)"` string as an alternative to a file and sets the component colour instead (`src/components/component.cpp:629-639`); the *only* difference between the DHT11 and the DHT22 **component class** is which file it names — but the two **files** are not variants of one drawing (42 rects + a tab path vs 28 rects and no tab).
- Edge cases / failure handling: a file that resolves nowhere leaves `m_backPixmap` null and the component simply draws no background — no error, no placeholder.
- Surprising: `Chip::setBackground` implements a *different*, five-step version of the same idea — absolute path in the circuit dir → circuit/data → the subcircuit's own folder → `getDataFilePath("images/"+bck)` → embed (`src/components/subcircuits/chip.cpp:443-462`). It composes the tiers **correctly** (it passes the whole relative path into `getDataFilePath`), whereas `Component::setBackground` calls `getDataFilePath("images")+"/"+bck` — and `getDataFilePath` tests `QFileInfo::exists` on that argument, which is a **directory** (`src/mainwindow.cpp:423-436`). So if the user's data folder contains an `images` directory, the config-data tier is silently skipped. The user data folder defaults to the **home directory** (`src/mainwindow.cpp:57-58`), where an `images` folder is a plausible thing to have.

### src/icons/font/font2.png
See its own entry above; the mechanism is the sprite-sheet character generator and the CGRAM patch.

### src/icons/components/sin.png
See its own entry above; the mechanism is the string-keyed preview table.

### src/icons/mainwindow/rotateccw.svg
See its own entry above; the mechanism is the qrc **alias** as the public name.

---

## Ideas worth stealing

- **Bake a 1-px light rim into a monochrome icon instead of shipping two icon sets or writing a runtime tint.** Every one of the 38 `mainwindow/` SVGs is *the same geometry drawn twice* — a translucent white copy at `opacity:0.6` offset 1.0007 px below a translucent black copy at `opacity:0.7` — e.g. `src/icons/mainwindow/new.svg:71-80`, where the white path starts `m 17.00003,1033.3622` and the black path starts `m 17.00003,1032.3615`. **Why it matters for August:** a harness that renders a schematic, a diff view or a tool palette in a dark theme otherwise has to ship a light and a dark asset for every glyph, or write a colour transform that has to know which pixels are "ink". The rim trick is one extra path per icon, needs no theme system at all, and — because both copies are pure greyscale — still survives the invert-per-asset rule described below.

- **Invert a themed icon per ASSET, abandoning the whole image on the first non-grey pixel.** `src/gui/thememanager.cpp:113-126`: the loop sets `ok = false; break;` the moment `!qIsGray(pixel)`, and `invertPixmap` returns the *original* pixmap when that happens (`src/gui/thememanager.cpp:125-126`). **Why it matters for August:** it is one boolean per image rather than a per-colour LUT, and it means a mixed-content asset (the LED icons, the motor icons, the two photographs `dsxxx.png` and `esp01.png`) is left alone rather than turning into a white blob. The corollary is a hard rule for the harness: *never put a saturated pixel in a greyscale asset*, because one stray colour disables the inversion for the whole image. The toolbar SVGs obey it (all 38 have only greyscale stops and fills).

- **Name a resource by its ROLE, not by its artwork, and let the manifest do the aliasing.** `src/application.qrc:65` serves the file `rotateccw.svg` as `undo.svg`; `src/application.qrc:66` serves `rotatecw.svg` as `redo.svg`; `src/application.qrc:71` serves `verify.png` as `setroot.png` — and the only caller asks for `":/setroot.png"` at `src/gui/filebrowser/filebrowser.cpp:157`. The flat `:/` namespace means no caller can get a directory prefix wrong. **Why it matters for August:** a visual redesign becomes a file swap with zero call-site edits, one drawing can legitimately serve two meanings (a rotation arrow *is* an undo arrow), and a "shipped resource" question is answered by one declarative manifest rather than by grep. The rule to steal: **the alias is the API; the filename is an implementation detail.**

- **Let the PROJECT's own folder win over the shipped asset, in a chain that is cheap to implement.** `Component::setBackground` resolves circuit folder → circuit `data/` folder → shared data folder → compiled-in resource (`src/components/component.cpp:642-644`, with `MainWindow::getCircFilePath` at `src/mainwindow.cpp:438-453` supplying the first two). **Why it matters for August:** this is what makes a *course* able to customise a tool without forking it — a teacher drops `dht22.svg` next to the student's circuit file and the schematic changes; a student drops their own symbol and gets it. It costs three lines and no plugin API. The caveat to steal deliberately: compose the chain on the **file**, not on the directory. `Chip::setBackground` gets this right by passing `"images/"+bck` into `getDataFilePath` (`src/components/subcircuits/chip.cpp:460`), while `Component::setBackground` passes `"images"` and appends the name afterwards (`src/components/component.cpp:643`) — and `getDataFilePath` tests `QFileInfo::exists` on whatever it is given (`src/mainwindow.cpp:423-436`), so a *directory* named `images` short-circuits the rest of the chain. Since the user data folder defaults to the home directory (`src/mainwindow.cpp:57-58`), that is a live hazard, not a theoretical one.

- **Let a project file EITHER name an image OR embed it.** `Chip` reads a `background` attribute (a *filename*) and a `bckgnddata` attribute (hex-encoded bytes) out of the `<Package>` element of a `.sim1` file (`src/components/subcircuits/chip.cpp:246`, `:259`, `:266-267`); `setBckGndData` decodes the hex string and calls `loadFromData` (`src/components/subcircuits/chip.cpp:390-413`), while `embeedBackground` loads it from disk (`src/components/subcircuits/chip.cpp:415-419`). **Why it matters for August:** a circuit file that travels (a student's homework, a Git commit, an LMS upload) must still render on the grader's machine. A name plus a tiered lookup gives you the small file and the ability to override; the embedded copy gives you the self-contained file. Offering **both** in the same format — and preferring the embedded bytes when present — is the part worth stealing, because it is exactly the tension a coursework tool has.

- **Organise a component palette by SIGNAL SHAPE, not by part family.** The 20×20 block pictograms `src/icons/components/1to1.png`, `2to2.png`, `2to3.png`, `3to2g.png` — a box with one 2-px stub per input and per output — are used as the *category* icons: "Converters" → `1to2.png` (`src/gui/componentlist/itemlibrary.cpp:305`), "Sensors" → `1to2.png` (`:263`), "Arithmetic" → `2to2.png` (`:287`), "Other Active" → `2to2.png` (`:213`), "Other Logic" → `2to3.png` (`:313`), "Other Outputs" → `1to1.png` (`:247`). **Why it matters for August:** a student told to "split one signal into three" does not know the part number of a demultiplexer, but can *see* the `1to3` pictogram and recognise it. A harness skill that offers "add a part" should offer it first by signal topology and second by part name. The pictograms are 20×20 bitmaps, trivially cheap to author for a whole family — and note the `g` suffix convention (`2to3g.png`, `3to2g.png`): the variant that **grows the box** so the input and output stubs stop sharing rows.

- **Ship a character-generator font as a single-row sprite sheet addressed by code point, and let a user-defined character be a PATCH of a base glyph.** `src/icons/font/font2.png` is a 2560×16 PNG — exactly 256 cells of 10×16, measured: ink in 189 cells, first at cell 33, last at cell 255 — and the lookup is one integer multiply and one `copy()` (`src/components/outputs/displays/hd44780_base.cpp:297`). The CGRAM path takes a copy of **glyph 0** and paints the user's 8 bytes onto it as 2×2-pixel dots (`src/components/outputs/displays/hd44780_base.cpp:277-296`). **Why it matters for August:** a harness that draws a simulated 7-segment/LCD display, or that lets a student define their own glyph, needs a font it can ship **without a font licence and without a font stack** — one PNG, one multiply, one blit. The CGRAM idea is the transferable part: a custom character is a byte array patched onto a known glyph, not a renderer. The trap to copy deliberately: make the cell pitch a **named constant** and clamp the code, because SimulIDE's `copy()` at `src/components/outputs/displays/hd44780_base.cpp:297` has no bounds check and a truncated atlas fails silently.

- **Make the "dead asset" set computable, then actually compute it.** `src/application.qrc:2` opens a **single** `<qresource prefix="/">` block that holds all 211 icon entries in one flat namespace — which is what makes the whole check *one diff* against the tree. The shard holds 224 files; the difference is exactly **13** files that can never load: `bug.svg`, `bus_p.png`, `hd44780_20x4.png`, `resistordip0.png`, `socket-H.png`, `socket-V.png`, `socket_p.png`, `subc_ico-0.png`, `subc_ico-1.png`, `termistor.png`, `up.png`, `src/icons/font/font.png`, `src/icons/mainwindow/zoom.svg`. Two are *byte-identical duplicates of live files* — `termistor.png` and `thermistor.png` have the same SHA-256 — and two are hyphen/underscore twins of live files (`socket-H.png` vs `socket_H.png`, `socket-V.png` vs `socket_V.png`). SimulIDE built the machinery and never ran the check. **Why it matters for August:** a harness that ships assets should have a CI gate that fails when a tracked asset is not in the manifest — a one-line diff that would have caught all 13 here, *and* would have caught the seven live references to `":/open.png"`, `":/save.png"`, `":/blank.png"` and `":/fileopen.png"`, none of which is a registered alias.

- **Make every resource reference resolvable, and make the miss visible.** `":/open.png"` is asked for at `src/gui/filebrowser/filebrowser.cpp:163`, `:169`, `:172`, `src/gui/filebrowser/filewidget.cpp:116` and `src/gui/memory/ramtable.cpp:154`, but the qrc registers `open.svg` (`src/application.qrc:50`) and no `open.png` exists anywhere in the tree; the same is true of `":/save.png"` (8 sites) against `save.svg`, of `":/blank.png"` (3 sites) against `blanc.png`, and of `":/fileopen.png"` (1 site) against no file at all. A `QPixmap` built from an unresolvable path is **null**, and `QIcon(null)` renders as nothing — so seventeen menu actions across the file browser, the memory viewer, the four memory components and the code editor have **no icon**, and nothing says so. The same class of defect is `":font2.png"` at `src/components/outputs/displays/hd44780_base.cpp:15` — one colon instead of two — with the counter-example three lines apart at `src/components/connectors/tunnel.cpp:207` (one colon) versus `:210` (two). **Why it matters for August:** an icon that silently fails to load is invisible in a screenshot and invisible in a test, and a *missing* icon in a palette reads as "this tool has no affordance" rather than "we broke a path". A harness should resolve every resource string at start-up against its manifest and refuse to launch on a miss — the same discipline August applies to its brain-config and doc-link gates.

- **Give the palette a second role for each drawing.** `gates.png` is the AND-gate artwork used as the *category* pictogram for "Gates" (`src/gui/componentlist/itemlibrary.cpp:281`) while `andgate.png` is the *component* icon (`src/components/logic/gate_and.cpp:22`); `subc.png` is the "Memory" category icon (`src/gui/componentlist/itemlibrary.cpp:295`) while `subcl.png` is the **same geometry in grey** `#515151` for the "Link to Component" menu (`src/components/linkercomponent.cpp:51`). **Why it matters for August:** a palette with 165 component icons and 20 category icons does not need 185 drawings; it needs 165 + 20 *roles* and a way to map artwork onto roles. The grey variant is the neat part — **the same drawing in a second colour is a second meaning**, and it costs one file and no new code.

- **Put the simulation's state in the *colour* of a badge — and let the icon be the state variable.** The four 32×32 state icons are `poweron.png` (olive `#8F820F`), `poweroff.png` (dark red `#750000`), `simpaused.png` (brown red `#A13028`) and `powerdeb.png` (blue `#435FC0`) — and the white-pixel counts differ (108 / 144 / 171 / 144) so the shapes are not identical either. `CircuitWidget::powerCircOn` sets `":/poweron.png"` and `powerCircOff` sets `":/poweroff.png"` (`src/gui/circuitwidget/circuitwidget.cpp:394`, `src/gui/circuitwidget/circuitwidget.cpp:410`), and the pause toggle switches between `":/simpaused.png"` and `":/pausesim.png"` (`src/gui/circuitwidget/circuitwidget.cpp:469`, `src/gui/circuitwidget/circuitwidget.cpp:479`). **The surprising part is the dispatch**: the next click is routed by *reading the action's own icon text* — `else if( powerCircAct->iconText() == "Off" ) powerCircOn(); else if( powerCircAct->iconText() == "On" ) powerCircOff();` (`src/gui/circuitwidget/circuitwidget.cpp:388-389`) — so the icon and the icon's text are the *only* state store, and the visual badge is what the user reads to know which branch the next click takes. **Why it matters for August:** a harness that shows "running / paused / stopped / debugging" gets a four-way distinction for free that survives greyscale printing and colour-vision deficiency, because the hue *and* the silhouette both change. That is a better answer than a text label or a single icon with a modifier. The *transferable* half is the dispatch idea done deliberately: one explicit state value that drives both the badge and the next action, rather than a state inferred from a widget property.

---

## Files skipped (with reasons)

**None.** All 224 files in the shard were opened and characterised, and all 224 rows of `icons-assets.rows.tsv` are marked `read`.

How the binary assets were read, because the method is what makes the notes specific rather than guessed from a filename:

- The **180 PNGs** were decoded pixel-by-pixel: dimensions, colour type, the count of fully-opaque vs semi-transparent pixels, the ink bounding box, and the dominant-colour histogram for every file. For the ~60 whose shape carries meaning, the pixels were additionally rendered as an ASCII raster (`.` transparent, `#` dark, `+` mid, ` ` light) at native or near-native resolution, and the six 20×20 `1toN`/`2toN`/`3toN` family and the 16×16 socket family were re-rendered **at full resolution** because the first downsample had misread them. This is necessary: these icons are black strokes on a transparent background, so an ordinary image preview shows a solid black square and reveals nothing.
- The **44 SVGs** were read as text. The six in `components/` were read **verbatim in full** (`bup.svg`, `bdown.svg`, `bug.svg`, `dht11.svg`, `dht22.svg`, `sr04.svg`). For the 38 in `mainwindow/`, every `<path>` was parsed in document order with its style, its fill and its `d` prefix, the header dimensions were read, the gradient definitions were enumerated, and the per-file path/gradient/opacity census was tabulated. `new.svg` was additionally read verbatim (lines 66–81) to confirm the extraction was faithful. The Inkscape `sodipodi:namedview` / `metadata` blocks were not transcribed individually — they are editor state, not content.
- Cross-file checks that were run because they change a note: SHA-256 over all 180 PNGs (to find duplicate artwork); a per-pixel diff of `subc_ico.png` against `subc_ico-1.png`; a byte-for-byte hash comparison of the six `resources/data/images/` files against their same-named built-ins; a full-text diff of `dht22.svg` against `dht11.svg`; a census of every quoted resource string in `src/` to find the two one-colon references and the seventeen dangling `":/…"` references.

---

## Uncertainties

- **Corrections to the previous pass's report, for the record.** (1) The `1toN`/`2toN`/`3toN` family is a **box with segmented stubs**, and the `g` suffix means **the box is grown taller** so the input and output stub rows stop colliding. The previous pass's "the `g` variants draw *segmented* stub outlines" was half right — *every* member of the family has segmented stubs; what `g` changes is the box height, not the stub shape — and its "gated" reading was wrong. (2) `1to3-c.png` has **no dashed coupling line**; it is the `1to3` pictogram redrawn at 36×24, and the "dash" was the box's left edge misread at low resolution. (3) `dht11.svg` is **not** a recolour of `dht22.svg` — 28 rects vs 42, and no mounting-tab path. (4) `link.png` contains **no saturated colour at all**; the yellow arrow is in `expose.png`. (5) `unuse.png` is a **dashed cross** (vertical run at x 15–16, horizontal run at rows 9–13), not diagonal dashes. (6) `termistor.png` is **byte-identical** to `thermistor.png`. (7) `null-0.png` is **fully transparent** (0 opaque *and* 0 semi pixels) and `null.png` is a 10×45 black bar inside a 10×100 canvas. (8) `blanc.png` is a **near-invisible** 1–50 %-alpha blue image, and it is **not** the shard's only colour illustration (`su.png`, `giu.png`, `sr04_ico.png` and `ky-040.png` are also coloured). (9) `":font2.png"` is **not** the only one-colon resource reference: `src/components/connectors/tunnel.cpp:207` is the second. The previous pass's "90 other resource references" was also an undercount — there are 91 distinct `":/…"` strings — and a naive scan of `":…"` is dominated by 60+ hits inside the vendored AngelScript tree (`src/angel/src/*.cpp`), which are the language's own `":"` operator, not paths.
- **Whether the one-colon resource form resolves at all.** `src/components/outputs/displays/hd44780_base.cpp:15` constructs the QImage from `":font2.png"` and `src/components/connectors/tunnel.cpp:207` asks for `":nobreakpoint.png"`. **What I checked:** the load site, the copy site (`src/components/outputs/displays/hd44780_base.cpp:297`), the CGRAM patch (`src/components/outputs/displays/hd44780_base.cpp:277-296`), the qrc alias for `font2.png` (`src/application.qrc:279`), the *paired* correct reference three lines away in `src/components/connectors/tunnel.cpp:210`, and a full census of every quoted resource string in `src/`. **What I could not check:** Qt's `QResourceFileEngine` path normalisation, and the rendered behaviour — I am not permitted to build or run anything in the clone. The paired control (`":nobreakpoint.png"` vs `":/breakpoint.png"` in the same function, on sibling actions) is strong evidence that the one-colon form does *not* resolve, because the "Hide group" action and the "Show group" action would otherwise carry the same artwork. If that holds, the HD44780 renders **no characters at all** — a null image, a null `copy()`, a null `drawImage()` — with no error anywhere.
- **Whether the 13 unregistered files were ever meant to ship.** I can state they are unreachable through the resource system and that no code names them. I cannot tell whether they are abandoned work or work behind a missing qrc line — `hd44780_20x4.png` is a plausible 20×4 LCD variant the component list never asks for, and `src/icons/font/font.png` is a 10×7 atlas (128 cells, ink from cell 16) the HD44780 never selects.
- **Which of the near-duplicate icon pairs is "the" intended one.** `socket_H.png` vs `socket-H.png`, `thermistor.png` vs `termistor.png`, `subc_ico.png` vs `subc_ico-0/1.png`: the live one is identified by the qrc and by the `LibraryItem` name in the component sources, but the clone has no commit history I could read, so I cannot say which came first or why the other was abandoned.
- **The `1to1`/`2to2`/`2to3` family is only half-used.** I established that the family encodes input/output counts, that `g` means "grown box", and that only `1to1`, `1to2`, `2to2` and `2to3` are actually used as category icons (`src/gui/componentlist/itemlibrary.cpp`) — but nothing in the tree documents the intended taxonomy, and the unused members (`1to3`, `2to1`, `2to3g`, `3to1`, `3to2`, `3to2g`, `1to3-c`) have no discoverable consumer.
- **The `su.png` / `giu.png` / `bup.svg` / `bdown.svg` / `down.png` / `up.png` / `null.png` / `null_ico.png` / `closeterminal.png` / `unuse.png` group.** These are registered (except `up.png`) but no code names them. I checked for literal `":/<alias>"` references and for bare-filename references; a dynamically constructed path (e.g. `":/"+prefix+"up.png"`) would be caught by neither. `su.png` is a white "+" and `giu.png` a white "−" on the same 9×9 dark-blue tile, which suggests a pair of buttons that were never wired up.
- **The `mainwindow/` SVG geometry was machine-extracted rather than transcribed line by line.** The shape readings (gear, scissors, floppy, folder-with-arrow, question mark, chevrons, magnifier) come from the extracted path data and from the icon's role at the call site; `new.svg` was read verbatim as a control and matched. I did not visually render any of the 38, so a fine detail of, say, `complib.svg`'s inner glyph is not something I can vouch for. The *structure* (two paths, same geometry, 1-px offset, 0.6/0.7 opacity, white-then-black order) was verified across all 38 programmatically, not by eye.
- **`resources/data/images/` is not installed by the build.** `SimulIDE.pri` declares `RESOURCES = $$PWD/src/application.qrc` (line 19) and has **no `INSTALLS` rule** for `resources/data`, so the six files in `resources/data/images/` are not part of the qrc and are not shipped by the build rules I could read. Two of them (`ic2.png`, `subc2.png`) are **byte-identical** to the built-ins, one (`null.png`) is a **different** 10×10 image that would shadow the built-in 10×100 bar, and three (`arduino.png`, `image.png`, `shield_uno.png`) have no built-in counterpart at all. I could not determine what populates `<configDir>/data/images` at runtime — there is no copy step in the build files I read.
- **`QT += svg` is the only thing that makes the 38 SVG icons loadable** (`SimulIDE.pri:8`), and the SVG *image plugin* is a runtime dependency rather than a compile-time one. A deployment missing that plugin would render every SVG toolbar icon as nothing, silently, exactly like the 17 dangling references above. I did not establish whether the plugin is statically linked, shipped separately, or assumed present.
- **Nothing in this shard was executed.** No build, no test, no render, no import of repo code. The two photographs (`dsxxx.png`, `esp01.png`) and the six raster "icons" (`ky-023.png`, `ky-040.png`, `dht22_ico.png`, `dsxxx_ico.png`, `esp01_ico.png`, `sr04_ico.png`) were identified from their decoded pixel content and their call sites, not from a visual inspection of a running application.
- **This shard contains no simulation, serialisation, scripting or test code.** It is assets only, so the lenses it can speak to directly are the resource/packaging layer, the component-registration contract, the theme layer, the undo/redo iconography, the component-set extension model and the UI's icon grid. The event scheduler, the solver, the code editor and the `.sim1` writer are all outside this shard; the one file-format fact stated here (the `background`/`bckgnddata` attributes of a chip's `<Package>` element) was read from the *loader* at `src/components/subcircuits/chip.cpp:246-267`, not from the writer.
- **The undo/redo mechanism itself is outside this shard.** What is in scope is the affordance: `":/undo.svg"` and `":/redo.svg"` are the aliased rotation arrows, wired to `Circuit::undo` / `Circuit::redo` at `src/gui/circuitwidget/circuitview.cpp:258,262` and to the editor's actions at `src/gui/editorwidget/editorwidget.cpp:801,806`. The stack itself is a `QList<circChange>` with a `m_maxUndoSteps` cap read from the `Circuit/undoSteps` setting and defaulting to 100 (`src/gui/circuitwidget/circuit.cpp:77-78`, `src/gui/circuitwidget/circuit.h:235-249`) — a snapshot of component changes rather than a command pattern. I did not read the snapshot/restore code.

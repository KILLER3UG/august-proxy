# simulide / resources#1

## Shard shape

This shard is SimulIDE's **entire user-facing content layer** — everything that is *data* rather than *code*: 154 per-component help pages, 13 syntax-highlighting definitions plus their 239-line format cookbook, 5 external-toolchain descriptors, one SPICE-style device model library, 6 component icons, 6 bundled TrueType faces, 3 application icons, 2 Linux desktop-integration files, and 8 Qt-Linguist translation sources. There is no engine, no widget and no solver in this shard at all; it is the *vocabulary* the rest of the app reads at runtime. The three things it feeds are: (a) the property dialog — every component's help page is a plain-text property sheet that the component's own `Q_PROPERTY` list is matched against; (b) the code editor — the `.syntax` files and the compiler XMLs are discovered by directory scan and are *user-overridable*; (c) the simulation kernel's *documented* knobs — the physics parameters of the solver (reactive step, iteration cap, propagation delay, thresholds, impedance) are all named and defaulted in these text files rather than hard-coded in the C++. The unifying architectural idea is that the app ships a **three-tier resource resolution cascade** (user dir → install dir → compiled-in `:/` resource), and this shard is almost entirely the middle and bottom tiers of it, laid out under `resources/data/` so that a user can copy one file into their own data folder and override it without touching the install.

## Per-file notes

### resources/data/codeeditor/compilers/compilers/avrgcc.xml
- Purpose: Descriptor for the AVR-GCC external toolchain — the only shipped compiler with a real, multi-step command line.
- Key abstractions: `<compiler name= type= buildPath=>` containing `<step command= arguments= argsDebug=>` children; placeholders `$device`, `$buildPath`, `$fileName`, `$filePath` are substituted before launch.
- Data flow: `EditorWindow::loadCompilers` (`src/gui/editorwidget/editorwindow.cpp:280`) scans this directory, parses the XML, and registers `{name → {file, type}}`; `Compiler::loadCompiler` (`src/gui/editorwidget/compiler.cpp:93`) then reads the steps; `Compiler::replaceData` (`compiler.cpp:72`) substitutes the placeholders.
- Non-obvious design decisions: `argsDebug` is **appended to** `arguments`, not substituted for it (`compiler.cpp:128-129`: `else args = arguments + argsDebug;`). Line 7 therefore repeats the whole command line with `-Og` substituted for `-Os`, and the duplicate `-mmcu`/`-Wall`/`-g` flags are harmless only because GCC takes the last optimisation flag.
- Edge cases / failure handling: None here — the failure path is in `Compiler::loadCompiler`, which appends "Compiler file not valid" to the output pane and returns when the DOM is null.
- Surprising: The `-Os` in the *release* half of the command still reaches the debugger build; the debug build is effectively `... -Os ... -Og ...`.

### resources/data/codeeditor/compilers/compilers/angelscript.xml
- Purpose: Registers the built-in AngelScript engine as a named compiler.
- Key abstractions: Same `<compiler>` schema, but with **no** `<step>` children.
- Data flow: Registered at `editorwindow.cpp:269` as a hard-coded `":/angelscript.xml"` entry; `createDebugger` (`editorwindow.cpp:255`) maps `type == "ascript"` to `asDebugger`.
- Non-obvious design decisions: The script is compiled **in-process** by the bundled AngelScript JIT, so there is no external command to describe — the XML carries only the name and the type tag.
- Edge cases / failure handling: n/a.
- Surprising: A file with no steps is still a first-class registry entry; the "command" is implicit in the type tag.

### resources/data/codeeditor/compilers/compilers/arduino.xml
- Purpose: Registers the Arduino toolchain.
- Key abstractions: `<compiler name="Arduino" type="arduino">`, no `<step>`.
- Data flow: Hard-coded at `editorwindow.cpp:268`; `createDebugger` maps `type == "arduino"` to `InoDebugger`.
- Non-obvious design decisions: The Arduino build is *not* a shell template — `InoDebugger` drives `arduino-builder` or `arduino-cli` itself (`src/gui/editorwidget/debuggers/inodebugger.cpp:139,166`), so the XML is a pure registry entry.
- Edge cases / failure handling: n/a in this file.
- Surprising: Two of the five compiler XMLs exist only to carry a name and a type; the mechanism they feed is a *switch statement* in C++, not a plugin.

### resources/data/codeeditor/compilers/compilers/dummy_c.xml
- Purpose: A placeholder SDCC compiler that compiles nothing (`arguments=""`).
- Key abstractions: `type="c10"` — the worked example of the type encoding documented in `types.txt`.
- Data flow: Discovered by the same directory scan as `avrgcc.xml`; `type="c10"` falls through the named-debugger chain (`editorwindow.cpp:256-260`), so `code = type.right(2) = "10"` → `langLevel = 1` (high level) and `lstType = 0` (labels do not use `:`).
- Non-obvious design decisions: The two trailing digits of `type` are a *bitfield*, not an identifier — see `types.txt:3-16`.
- Edge cases / failure handling: With empty arguments the command is `sdcc` alone; the failure is visible in the output pane, not here.
- Surprising: `dummy_c.xml` is the only file in the shard that both ships a *broken* toolchain and documents, by example, the encoding of a working one.

### resources/data/codeeditor/compilers/default.xml
- Purpose: The "None" compiler — the sentinel meaning *no toolchain*.
- Key abstractions: `<compiler name="None" type="none">`, no steps.
- Data flow: The debugger factory guards on `name != "None"` at `editorwindow.cpp:258,262` and skips loading a file entirely.
- Non-obvious design decisions: "No compiler" is modelled as a *compiler* rather than as a null/absent entry, so the compiler combo box always has a valid selection.
- Edge cases / failure handling: n/a.
- Surprising: The file sits at `compilers/default.xml`, one level *above* the other four, even though the manifest and the loader treat `compilers/compilers/` as the scanned directory — `default.xml` is therefore **never discovered by the scan** and is reachable only through the `:/` alias path.

### resources/data/codeeditor/compilers/template.txt
- Purpose: The documented template and substitution reference for authoring a compiler XML.
- Key abstractions: A comment block listing every substitution, then a worked `<compiler name="Avra" type="avrasm01" syntax="avrasm">` example.
- Data flow: Read by a human; the substitutions it names are performed by `Compiler::replaceData` (`compiler.cpp:66-79`).
- Non-obvious design decisions: The `syntax="avrasm"` attribute on the compiler is what couples a *toolchain* to a *highlighting* definition — `compiler.cpp:103` turns it into `setSyntaxFile("avrasm.syntax")`.
- Edge cases / failure handling: n/a.
- Surprising: The list at lines 7-14 is **stale**: the implementation also substitutes `$extraArgs` (`compiler.cpp:78`) and auto-creates a property for it (`compiler.cpp:137-143`), and that placeholder is absent from the template. It also does not document that `$device`/`$family` are *not* substituted by `replaceData` at all — they are substituted elsewhere, and their presence in the argument string is what causes the property dialog to grow a Device/Family field.

### resources/data/codeeditor/compilers/types.txt
- Purpose: The only written specification of how a compiler `type` string encodes language level and listing-file conventions.
- Key abstractions: "the key is in the last 2 numeric digits" — first digit 0=asm / 1=high level; second digit is a bitfield (bit0 = labels use `:`; bit1 = position of the flash address).
- Data flow: Decoded at `editorwindow.cpp:258-260` (`code.right(1)` → lst type, `code.left(1)` → language level).
- Non-obvious design decisions: The type string is *both* an identifier and a bitfield — "avrgcc" simply has no meaningful last two digits, and the named-debugger branch intercepts it before the bitfield is read.
- Edge cases / failure handling: A non-numeric suffix silently decodes to 0/0 via `toInt()`.
- Surprising: The file is 16 lines long and is the entire contract for a value that appears in five XML files and one dispatch chain.

### resources/data/codeeditor/syntax/readme_syntax
- Purpose: A 239-line cookbook for the `.syntax` highlighting file format — the single best-written document in the repository.
- Key abstractions: Three line kinds: the `rules:` header, a `<rule>-style:` appearance line, and a `<rule>:` pattern line. Patterns are either plain words (auto-wrapped in `\b…\b` and fed to autocomplete) or quoted raw regexps.
- Data flow: `Highlighter::readSyntaxFile` (`src/gui/editorwidget/highlighter.cpp:20`) parses it; the returned `keyWords` list is the editor's completion list.
- Non-obvious design decisions: (1) Only the rule named exactly `multiLineComment` may span lines, and it takes exactly two quoted regexps — start and end delimiter — with the end-marker absence carried across blocks via `setCurrentBlockState(-10)` (`highlighter.cpp:206`). (2) Rules are applied in list order and later ones paint over earlier ones, so the *order* in the `rules:` header is semantically load-bearing. (3) A dark theme looks for `<name>_dark.syntax` first and otherwise inverts the lightness of every colour (`highlighter.cpp:29-37,77-81`).
- Edge cases / failure handling: An invalid regexp is logged and skipped, not fatal (`highlighter.cpp:120`).
- Surprising: **Line 141 is wrong.** It says a literal backslash in the final regex must be written `"\\\\"` in the file, because "the parser stores a single `\`". It does not — `remQuotes` (`src/utils.cpp:97`) only strips the first and last character, and the `\\\\`→`\\` collapse is applied **only** to the `multiLineComment` patterns (`highlighter.cpp:106,109`), never to ordinary quoted patterns. The advice is followed by exactly one file, `js.syntax`, and produces a broken rule (see below). Line 133's "escape them with a backslash (\\ inside the quoted string)" is the correct guidance and is what the working files do.

### resources/data/codeeditor/syntax/cpp.syntax
- Purpose: C/C++ syntax highlighting — the reference implementation of the format and the one every other file is a variation of.
- Key abstractions: 10 rules in the order `data keyword1 keyword2 number preprocessor lineComment triLineComment multiLineComment htmlTag quotation function`.
- Data flow: `CodeEditor::setSyntaxFile("cpp.syntax")` (`codeeditor.cpp:419`) → `Highlighter::readSyntaxFile`.
- Non-obvious design decisions: The `function` rule uses a **lookahead** `"\b[A-Za-z0-9_]+(?=\\()"` so the name is highlighted but the `(` is not; `triLineComment` is a *separate* rule from `lineComment` so `///` doc comments can be a different colour.
- Edge cases / failure handling: n/a.
- Surprising: The `rules:` header order is not cosmetic — `lineComment` precedes `triLineComment` and `multiLineComment` precedes `htmlTag`, and the later rules win by painting over.

### resources/data/codeeditor/syntax/js.syntax
- Purpose: JavaScript highlighting; a near-copy of `cpp.syntax` with a JavaScript keyword set.
- Key abstractions: Same 10-rule shape.
- Data flow: `codeeditor.cpp:481` → `setSyntaxFile("js.syntax")`.
- Non-obvious design decisions: It copies the `function` rule verbatim from `cpp.syntax` — including the escape mistake.
- Edge cases / failure handling: The pattern is *valid* as a regex (`QRegularExpression::isValid()` returns true at `highlighter.cpp:119`), so it is applied silently and never reported.
- Surprising: **Line 29 is broken.** The file contains `function: "\\b[A-Za-z0-9_]+(?=\\()"` — a double backslash before `b` — where `cpp.syntax:41` has a single one. Because `remQuotes` does not unescape, the regex sees `\\b` (a literal backslash followed by `b`) and `(?=\\()` (a literal backslash followed by an empty capture group), so the function-name rule can never match real JavaScript. The keyword highlighting still works, so the file looks fine at a glance.

### resources/data/codeeditor/syntax/gcbasic.syntax
- Purpose: GCBASIC highlighting, with a dated WIP changelog header (2021-08-02) recording its own edits.
- Key abstractions: 10 rules including `Modifiers`, `Keyword1`, `Keyword2` and `Symbol`.
- Data flow: `codeeditor.cpp:410` → `setSyntaxFile("gcbasic.syntax")`.
- Non-obvious design decisions: The changelog at lines 2-16 is a *maintained* design log inside a data file — it records renames ("Operator" → "Symbol"), moved rules and added regexps, which is why the file reads as a living artefact rather than a config dump.
- Edge cases / failure handling: n/a.
- Surprising: **Line 29's `Keyword2` list is entirely dead.** Every entry is capitalised (`HSerPrint`, `LCDCMD`, `PWMOn`, `Asc`, `Hex` …), and the highlighter lower-cases the line before applying file-sourced rules (`highlighter.cpp:182,187` — the runtime-injected object/member/type rules are applied to the original case instead). A plain word becomes the regex `\bHSerPrint\b`, which cannot match the lower-cased text. `Modifiers` and `Keyword1` are lower-case and work; `Keyword2` is the only rule in the whole file that never fires. This is also the only `.syntax` file in the shard whose capitalised keywords are affected, which is why it went unnoticed.

### resources/data/codeeditor/syntax/md.syntax
- Purpose: Markdown highlighting, 11 rules.
- Key abstractions: `header hrule blockquote list link image boldItalic bold italic strike inlineCode html multiLineComment`.
- Data flow: `codeeditor.cpp:486` → `setSyntaxFile("md.syntax")`.
- Non-obvious design decisions: Fenced code blocks are expressed by abusing the multi-line rule as `multiLineComment: "```" "```"` (lines 39-40) — the start and end markers are the same token, so the rule highlights from the first fence to the next.
- Edge cases / failure handling: n/a.
- Surprising: `boldItalic` is listed **before** `bold` (line 1). That order is load-bearing, not cosmetic: the parser matches a rule line by testing `first.startsWith(ruleName)`, so `"boldItalic-style:"` would also satisfy the prefix test for `bold`; listing `boldItalic` first makes the more specific name win the `break`.

### resources/data/codeeditor/syntax/hex.syntax
- Purpose: Intel HEX file highlighting.
- Key abstractions: Four column-anchored rules: `ByteCount Address Type Checksum`.
- Data flow: `codeeditor.cpp:477` → `setSyntaxFile("hex.syntax")`.
- Non-obvious design decisions: Unlike every other file in the folder, this one uses **background** colours and leaves the foreground as `default` — because the columns are positional, not lexical, so tinting the field is the only readable option.
- Edge cases / failure handling: n/a.
- Surprising: The rules are anchored with `^:` and fixed column offsets (`^:.{6}([0-9a-fA-F]{2})`) — a column model expressed as regexps, the same trick `makef.syntax` uses for targets.

### resources/data/codeeditor/syntax/i51asm.syntax
- Purpose: 8051/i51 assembler highlighting.
- Key abstractions: 8 rules; the directives are one alternation regexp, the mnemonics a plain-word list.
- Data flow: `codeeditor.cpp:434`/`454` → `setSyntaxFile("i51asm.syntax")`.
- Non-obvious design decisions: The directive rule uses a character-class alternation `"\.[byte|cseg|db|def|device|dseg|dw|...]"` rather than a `|` alternation, so it matches a *run* of directive characters.
- Edge cases / failure handling: n/a.
- Surprising: The trailing `[^\\b]` (line 8) was meant to be a word boundary `\b` but is written double-escaped, so it compiles to "not a backslash and not the letter b" — a negated character class. It is the same class of mistake as `js.syntax`, and it is the second file in the shard to follow the wrong advice in `readme_syntax:141`.

### resources/data/codeeditor/syntax/6502asm.syntax
- Purpose: 6502 assembler highlighting.
- Key abstractions: 8 rules; `directives` (equ/include/org), the 56 official mnemonics, `#` preprocessor, `;` comments, and a `Label` rule matching `^[\x20\x09]*\w+:`.
- Data flow: `codeeditor.cpp` selects it by MCU family.
- Non-obvious design decisions: The label rule allows leading spaces/tabs and requires a trailing colon — the same idiom reused verbatim in `avrasm`, `z80asm` and `gcbasic`.
- Edge cases / failure handling: n/a.
- Surprising: The `\x20\x09` in the label pattern is a *character class of two whitespace codes* written so that the file itself never contains a literal tab, which keeps the pattern visible in a single-line rule.

### resources/data/codeeditor/syntax/avrasm.syntax
- Purpose: AVR assembler highlighting.
- Key abstractions: Same 8-rule shape; the `instructions` rule carries roughly 180 mnemonics including `MUL`, `SBI`, `SBIW`, `EICALL`, `WDR`.
- Data flow: `codeeditor.cpp:428`/`449` → `setSyntaxFile("avrasm.syntax")`; it is also the syntax named by the `template.txt` compiler example.
- Non-obvious design decisions: The mnemonic list is a plain-word rule, so every mnemonic is also injected into the editor's autocomplete list (`readme_syntax:107`).
- Edge cases / failure handling: n/a.
- Surprising: The list contains both `mul` and `muls`/`mulsu`/`fmul`/`fmuls`/`fmulsu` — the M-extension set — which is why the rule is long rather than factored.

### resources/data/codeeditor/syntax/z80asm.syntax
- Purpose: Z80 assembler highlighting.
- Key abstractions: Same 8-rule shape; the mnemonic list includes the ED-prefixed block operations (`LDI`, `LDIR`, `CPDR`, `OTIR`, …).
- Data flow: Selected by MCU family in `codeeditor.cpp`.
- Non-obvious design decisions: Identical structure to the 6502 file, so the format is effectively a template with one variable list.
- Edge cases / failure handling: n/a.
- Surprising: All three of the 6502/avr/z80 files are byte-for-byte structurally identical except the mnemonic list — the format's regularity is what makes a new assembler a 15-line file.

### resources/data/codeeditor/syntax/pic14asm.syntax
- Purpose: PIC14 assembler highlighting.
- Key abstractions: 7 rules — it is the only assembler file with **no** `Label` rule, and it calls its mnemonic list `keyword1` rather than `instructions`.
- Data flow: `codeeditor.cpp:444` → `setSyntaxFile("pic14asm.syntax")`.
- Non-obvious design decisions: PIC assembly labels have no colon, so the label rule was dropped rather than adapted.
- Edge cases / failure handling: n/a.
- Surprising: The rule *names* differ from the other assembler files while the *format* does not — the names are matched by prefix, so the rename is free.

### resources/data/codeeditor/syntax/makef.syntax
- Purpose: GNU makefile highlighting.
- Key abstractions: 5 rules: `directives number target quotation lineComment`.
- Data flow: `codeeditor.cpp:470` → `setSyntaxFile("makef.syntax")`.
- Non-obvious design decisions: The `target` rule is `"(?!.*:=).*:"` — a negative lookahead excluding lines that contain an assignment — so a `VAR := value` line is not painted as a target.
- Edge cases / failure handling: n/a.
- Surprising: It is the only file in the folder that uses a negative lookahead to express "this is not that", a trick worth stealing for any rule system.

### resources/data/codeeditor/syntax/xml.syntax
- Purpose: XML highlighting.
- Key abstractions: 5 rules: `elEnd elName element comment quotation`.
- Data flow: `codeeditor.cpp:466` → `setSyntaxFile("xml.syntax")`.
- Non-obvious design decisions: `elName` uses a lookahead `"\b[A-Za-z0-9_]+(?=\=)"` to colour attribute names only, leaving the `=` uncoloured.
- Edge cases / failure handling: n/a.
- Surprising: The `element` rule `</[!/A-Za-z0-9_]+\b` colours tags and closing tags alike with one pattern.

### resources/data/diodes.model
- Purpose: A SPICE-style **device model library** — the shipped diode, zener and LED parameter sets, in a user-overridable file.
- Key abstractions: `<itemlib>` → `<itemset type="diode|zener|led">` → `<item name= satCurr_nA= resist= emCoef= brkDown= />`. The four attributes are exactly the SPICE diode model parameters.
- Data flow: `eDiode::getModels()` (`src/simulator/elements/active/e-diode.cpp:160`) hard-codes a "Diode Default"/"Zener Default"/"RGY Default" set, then loads this file through `MainWindow::getDataFilePath("diodes.model")` and inserts each `<item>` into the matching map by `itemset@type`; `setModel` then pushes the four numbers into the element's SPICE parameters.
- Non-obvious design decisions: The file is looked up through the three-tier cascade, so a user can add their own 1N4148 by dropping a file into their data dir — no code change, no recompile. The `emCoef` (ideality factor) and `satCurr_nA` are the two parameters that actually change the exponential I-V curve.
- Edge cases / failure handling: If the file is missing, the function returns and the hard-coded defaults stand (`e-diode.cpp:170`); an unparseable DOM is simply skipped.
- Surprising: Only **three** real models ship (1N5711 Schottky, 1N34 germanium, Zener 3.3 V, Blue LED) — the model library is a hook, not a catalogue.

### resources/data/help/*.txt (154 files)
These are the per-component property sheets. They share a rigid grammar — `Property: (default value)`, then a `Main:` / `Electric:` / `Timing:` / `Parameters:` / `Advanced:` section, then one `- Property Name: (default)` bullet with a one-line explanation — and they are **composed**, not duplicated, through an `#include` directive. The files that are pure fragments (`logicinputs`, `logicoutputs`, `logicedges`, `gatedelay`, `gateinputs`, `gateoutputs`, `dialed`, `shape`) carry the shared physics; the per-component files pull them in.

- `7-segbcd.txt` — 7-segment with integrated BCD; documents the bit order (bit 0 = right pin) and that PWM/multiplexing is unsupported.
- `adc.txt` — ADC; Size (output pin count) and Reference Voltage, then includes `logicoutputs` + `logicedges`.
- `aip31068i2c.txt` — AiP31068 I2C LCD; Rows/Columns, I2C Address 62, and the note that the I2C frequency should match the master but is not critical.
- `amperimeter.txt` — Amperimeter; red/black polarity pins and a third pin carrying the reading as a voltage, refreshed at the circuit FPS.
- `andgate.txt` — The pure-include case: five `#include` lines and no text of its own.
- `app.txt` — Application settings; Language and Font Scale, both requiring a restart.
- `at90usb162.txt` — AT90USB162; 32-pin QFN pin table with alternate functions, then the datasheet feature summary.
- `audioout.txt` — Audio output; Buzzer mode, 8-ohm impedance, and the "X in the symbol" when no default device exists.
- `battery.txt` — Battery; Voltage and internal Resistance.
- `bcdtodec.txt` — Binary-to-decimal converter; the 16-Bits property, output inversion, and the shared logic fragments.
- `bjt.txt` — BJT; PNP (default yes), Gain, and the base-emitter diode threshold 0.670736 V.
- `buffer.txt` — Buffer; input inversion, output inversion, the Tristate option that adds an active-low enable pin, and `gatedelay`.
- `bus.txt` — Bus connector; Size and the Start bit (bit number assigned to the first pin).
- `capacitor.txt` — Capacitor; Capacitance, Resistance, Initial Voltage, and the per-component **Reactive Step** override that beats the global Simulation Settings.
- `circuit.txt` — Circuit canvas; Draw Grid, Show Scrollbar, Animate, **Canvas Refresh 20** redraws/sec, and the 15-second auto-backup interval.
- `clock.txt` — Clock source; Voltage, Frequency, and "Always On" which removes the on/off button.
- `counter.txt` — Binary counter; Use Set Pin, clock/set-reset inversion, "Count to" — and `#include propdelay` (line 22), a fragment that **does not exist anywhere in the repository**.
- `csource.txt` — Controlled source; the boolean property set (Use Control Pins / Current Source / Current Controlled / Gain) that lets one component cover VCVS, CCVS, VCCS and CCCS.
- `currentsource.txt` — Variable current source; Current value and Maximum Current (must be positive).
- `dac.txt` — DAC; Size and Reference Voltage.
- `dcmotor.txt` — DC motor; the green/red speed indication and the deliberate modelling of the coil as a plain resistor "for simplicity and speed".
- `decto7s.txt` — Decimal-to-7-segment; output inversion.
- `dectobcd.txt` — Decimal-to-binary; the 16-Bits property and input inversion.
- `demux.txt` — Demultiplexer; Address Size (3 bits ⇒ 2³ channels) and output inversion.
- `dht22.txt` / `hdt22.txt` — DHT22/HDT22 temperature+humidity; Model choice and the 0.5° increment buttons. The two files are **identical in content** apart from the component id.
- `diac.txt` — DIAC; On/Off Resistance, Breakdown Voltage, Holding Current.
- `dial.txt` — Standalone dial; Minimum/Maximum Value and Steps, and the explicit statement that the dial is meant to be *linked* to a Dialed component.
- `dialed.txt` — Dialed fragment; Slider-vs-Knob and the Scale factor.
- `diode.txt` — Diode; Model (read from `data/diodes.model`), forward voltage, max current, series resistance, and the advanced saturation current / emission coefficient. States the diode blinks when the max current is exceeded.
- `ds1307.txt` — DS1307 I2C RTC; "Set current time at start" so the sim can start from the PC clock.
- `ds1621.txt` — DS1621 I2C temperature sensor; the A0/A1/A2 address-strapping pins.
- `ds18b20.txt` — DS18B20 One-Wire sensor; the random ROM address.
- `dynamicmemory.txt` — Dynamic RAM; row/column address sizes, data size, refresh period, the memory-table/load/save context menu, and the open-drain output option.
- `elcapacitor.txt` — Electrolytic capacitor; the same four properties as the plain capacitor, plus "Blinks if polarity is wrong".
- `ellipse.txt` / `line.txt` / `rectangle.txt` / `image.txt` — Pure `#include shape` — no text of their own.
- `esp01.txt` — ESP-01 WiFi module; states the TCP/IP AT-command support is only partial.
- `fixedvoltage.txt` — Fixed voltage source; the 5 V value and the left-button on/off.
- `flipflop.txt` — Shared flip-flop fragment; Set/Reset inversion, Clock inversion, and the Trigger Type options (Clock / enable / None hides the clock pin).
- `flipflopfull.txt` — Full flip-flop fragment; the "Use Set/Reset Pin" visibility toggle; includes `flipflop`.
- `flipflopd.txt` / `flipflopjk.txt` / `flipflopt.txt` — One-line aliases that include `flipflopfull`.
- `flipfloprs.txt` — RS flip-flop; the Set/Reset toggle and `flipflop` (no trigger-type options).
- `freqmeter.txt` — Frequency meter; the 0.1 V filter that ignores smaller voltage changes.
- `frequencimeter.txt` — Standalone frequencimeter; connect the left pin to a wire; minimum frequency 2 Hz.
- `fulladder.txt` — A bare include set with no component-specific text.
- `function.txt` — The combinational-logic component; the per-output function list syntax (`i0 | i1`, line 7), input/output sizes, inversion, open drain, and a link to the simulide.com tutorial.
- `gatedelay.txt` — Shared gate timing; **Gate Delay 10 ns, Rise 3 ns, Fall 4 ns** — the numbers every digital component inherits.
- `gateinputs.txt` — Shared gate inputs; Input Size and inversion.
- `gateoutputs.txt` — Shared gate outputs; Initial High State, inversion, and the open-drain option (sink but not source).
- `ground.txt` — Two lines: it is a 0 V voltage source, with no properties.
- `hd44780.txt` — HD44780 LCD; Rows and Columns.
- `header.txt` — Header connector; Size and the Downwards option.
- `i2cram.txt` — I2C RAM/ROM; size, control code, I2C frequency, and the **Persistent** flag that turns it into a ROM, plus the memory-table/load/save menu.
- `i2ctoparallel.txt` — I2C-to-parallel converter; base control code and I2C frequency.
- `ili9341.txt` — Two lines; 240x320 colour TFT with an SPI interface, no properties.
- `inductor.txt` — Inductor; Inductance, Resistance, Initial Current, Reactive Step.
- `keypad.txt` — Keypad; Rows, Columns, and the Key Labels string `123456789*0#` read left-to-right, top-to-bottom.
- `ks0108.txt` — KS0108 LCD driver; the CS Active Low option.
- `ky023.txt` — KY-023 resistive joystick; two lines.
- `ky40.txt` — KY-040 rotary encoder; Steps per Rotation (20).
- `lamp.txt` — Incandescent lamp; filament Resistance and the Max Current that is maximum brightness.
- `latchd.txt` — Latch; channel count, Trigger Type (Enable / Clock / None), the Tristate enable pin, open drain.
- `ldr.txt` — LDR; the dial-driven Lux range, the Gamma exponent, R1, and the `dialed` include.
- `led.txt` — LED; Color, the **Grounded** option (cathode wired internally and any existing cathode wire deleted), forward voltage, max current, series resistance.
- `ledbar.txt` — LED bar; Color, Size (8 leds), Grounded, and the same electrical trio.
- `ledmatrix.txt` — LED matrix; Rows, Columns, and the Vertical Pins option that moves all pins to the top and bottom.
- `ledrgb.txt` — RGB LED; Common Cathode and a **separate** forward voltage, max current and resistance per channel (2.4 V red, 3.5 V green and blue).
- `logicanalizer.txt` — Logic analyser; 8 channels, screen size, **Buffer Size 100000** samples, ground impedance, and the VCD export options (base time step, export at pause).
- `logicedges.txt` — Shared logic timing; Propagation delay expressed *in gates* (Total delay = Gate delay × number of gates), Gate Delay 10 ns, Rise 3 ns, Fall 4 ns.
- `logicinputs.txt` — Shared logic inputs; the 2.5 V low-to-high and high-to-low thresholds and the 100 M-ohm input impedance.
- `logicoutputs.txt` — Shared logic outputs; Output High 5 V, Output Low 0 V, 40-ohm output impedance.
- `max72xxmatrix.txt` — MAX72xx matrix; colour and size as a number of 8×8 sections.
- `mega1280.txt`, `mega2560.txt` — ATmega1280/2560; the 100-pin TQFP pin table with every alternate function, then the long Atmel feature summary (86 I/O lines, 16 PWM channels).
- `mega1284.txt`, `mega324.txt`, `mega324a.txt`, `mega644.txt`, `mega64.txt`, `mega16.txt`, `mega32.txt`, `mega164.txt`, `mega168.txt`, `mega328.txt`, `mega48.txt`, `mega88.txt`, `mega8.txt` — ATmega family; the 40-pin/28-pin PDIP pin tables with PCINT assignments and a compact feature summary.
- `mega128rfa1.txt`, `mega128rfr2.txt` — The 2.4 GHz radio MCUs; 64-pin QFN pin table plus the ZigBee/802.15.4 feature list (AES, TRX, PLL spacing, multi-PAN filtering).
- `mega169.txt` — ATmega169; the 64-pin QFN table that includes the 4×25 segment LCD driver pins.
- `mega16m1.txt` — ATmega16M1; the pin table with CAN, LIN and four analog comparators.
- `mega32u4.txt` — ATmega32u4; the 44-pin QFN table with the USB D+/D− pins and 12 ADC channels.
- `memory.txt` — Static RAM/ROM; Address Size, Data size, **Persistent** (acts as a ROM) and Asynchronous, plus the memory-table/load/save menu.
- `mosfet.txt` — MOSFET; P Channel, Depletion mode, RDSon and the gate-source threshold.
- `mux.txt` — Multiplexer; Address Size, input inversion.
- `muxanalog.txt` — Analog multiplexer; Address Size and the 1 m-ohm channel impedance.
- `opamp.txt` — Op-amp; Gain, Output Impedance, the V+/V− supplies and the "Use Supply Pins" switch.
- `orgate.txt` / `xorgate.txt` — Pure include sets like `andgate.txt`; `xorgate.txt` carries a stray "Configurable Buffer Gate" line.
- `oscope.txt` — Oscilloscope; 4 channels, **Buffer Size 600000** samples, screen size, ground impedance, the expandable floating window, and the tutorial link.
- `package.txt` — Package component; Type, Width/Height in grid cells, the Name field whose magic value `Package` means "use the file name", the Package File path, the Background image, and the Logic-Symbol vs Chip switch.
- `pcd8544.txt` — Two lines; 48×84 pixel LCD with a serial bus.
- `potentiometer.txt` — Potentiometer; 1 k-ohm resistance, dial-driven Current Value, `dialed`.
- `probe.txt` — Logic/voltage probe; hover-or-connect behaviour, orange=High/blue=Low, the voltage-label toggle and the 2.5 V threshold.
- `push.txt` — Push button; Normally Closed, pole count, and the Key character that lets the button be pressed from the PC keyboard.
- `rail.txt` — Voltage rail; a simple voltage source at 5 V.
- `rectangle.txt` / `ellipse.txt` / `line.txt` / `image.txt` — Pure `#include shape`.
- `relayspst.txt` — Electromagnetic relay; Normally Closed, Double Throw, poles, the IOn/IOff activation currents, and the coil inductance/resistance/Reactive Step.
- `resistor.txt` — A single property: Resistance 100 Ω.
- `resistordip.txt` — Resistor DIP; Resistance, Size, and the **Pullup** option that turns the whole DIP into pull-ups tied to a Pullup Voltage and hides the top pins.
- `rtd.txt` — RTD; dial-driven temperature range, Current Value, Dial Step, R0, `dialed`.
- `scr.txt` / `triac.txt` — Gate Resistance and two holding currents (10 mA to start conducting, 8.2 mA to keep); the duplicate "Holding Current" label in both files is a copy/paste slip.
- `serialport.txt` — Serial port; Auto Open, Port Name, baud/data/stop bits, and the warning that the port must exist in the PC with read/write permission.
- `serialterm.txt` — Serial terminal; baud/data/stop bits, Rx/Tx wiring, tutorial link.
- `servo.txt` — Servo; Speed (time for 60°) and the min/max pulse widths mapping to 0° and 180°.
- `sevensegment.txt` — Seven-segment; Color, Size, Vertical Pins, Common Cathode, forward voltage, max current, series resistance.
- `shape.txt` — Shared graphical fragment; Size X/Y in pixels, Border width, the **Z-Value** stacking order (negative stacks behind), colour and opacity.
- `shiftreg.txt` — Shift register; Clock/Reset inversion, output inversion, open drain.
- `simulation.txt` — The solver's own knobs, documented: Simulation Speed % and Steps per Second as two views of one setting, **Max Iterations 1e5** for the non-linear solver, the **Reactive Step 1 µs** for reactive components ("increase: better speed but less accuracy"), and Slope Steps for output-pin edges.
- `socket.txt` — Socket connector; Size, and a link to the SimulIDE 1.0.0 socket video.
- `sr04.txt` — HC-SR04; the trick that feeding a voltage on the In pin simulates a distance, with **volts equal to metres** (1.5 V = 1.5 m).
- `ssd1306.txt` — SSD1306 OLED; 128×64 size, the Rotate option for libraries that do not rotate, I2C address and frequency.
- `stepper.txt` — Stepper motor; Bipolar, Steps per Rotation, per-winding resistance, coils modelled as resistors.
- `strain.txt` — Force sensor; dial-driven Newton range, Current Value, Dial Step, reference/current temperature.
- `subcircuit.txt` — Subcircuit; a component made of parts, described by **two files** (circuit + package), showable as a chip or a logic symbol.
- `switch.txt` — Two-position switch; Normally Closed, Double Throw, poles, Key character.
- `switchdip.txt` — Switch DIP; Size, the Exclusive option and the Common Pin option.
- `text.txt` — Text box; margin, border, background colour and opacity, font family/colour/size, Fixed Width, and the editable text.
- `thermistor.txt` — NTC thermistor; dial-driven temperature range, Current Value, Dial Step, the B beta parameter and R25.
- `tiny13.txt`, `tiny24.txt`, `tiny25.txt`, `tiny44.txt`, `tiny45.txt`, `tiny84.txt`, `tiny85.txt` — ATtiny family; 8-pin and 14-pin PDIP pin tables and compact feature summaries.
- `tiny2313.txt`, `tiny2313a.txt`, `tiny4313.txt` — ATtiny 20-pin PDIP pin tables and feature summaries; `tiny2313.txt` and `tiny2313a.txt` are content-identical.
- `touchpadr.txt` — Resistive touchpad; 240×320 pixel size, Transparent flag, and the four edge resistances RxMin/RxMax/RyMin/RyMax.
- `transformer.txt` — Transformer; Coupling Coefficient, Base Inductance, and the per-side Primary/Secondary coil lists — and the note that any coil may act as the primary.
- `tunnel.txt` — Tunnel; the Id that links tunnels and the Bus flag.
- `varresistor.txt` — Variable resistor; dial-driven Minimum/Maximum Resistance, Current Value, Dial Step.
- `voltagesource.txt` — Variable voltage source; Current value and the Maximum/Minimum Voltage bounds, which may be negative but must straddle zero.
- `voltimeter.txt` — Voltmeter; red/black polarity pins and the third pin carrying the reading as a voltage at the circuit FPS.
- `voltreg.txt` — Voltage regulator; a single Output Voltage (1.2 V) referenced to the R pin.
- `wavegen.txt` — Wave generator; the six wave types, Frequency, Phase shift, Quality (steps per cycle), Duty, Always On, and the Bipolar/Floating/Middle Voltage/Semi amplitude options.
- `ws2812.txt` — WS2812 LED string; Rows and Columns only.
- `zener.txt` — Zener; Model from `data/diodes.model`, forward voltage, max current, resistance, breakdown voltage, saturation current, emission coefficient.

### resources/data/images/arduino.png
20×20 RGBA PNG of an Arduino board (dark blue board, black pin strip, white ATMEGA chip block) — a user-overridable component-list icon reached through `getDataFilePath("images/"+icon)` (`src/gui/componentlist/componentlist.cpp:169`).

### resources/data/images/ic2.png
20×20 RGBA PNG of a small square IC package with a single dot marker — the generic chip icon used for the MCU library categories (`itemlibrary.cpp:254-261`).

### resources/data/images/image.png
22×22 RGBA PNG of a generic framed picture with a small sun/moon shape — the icon for the "Embedded Image" graphical component.

### resources/data/images/null.png
10×10 RGBA PNG that is a fully transparent placeholder pixel. Note this is a *different file* from `src/icons/components/null.png`, which the qrc aliases as `:/null.png` (`src/application.qrc:46`).

### resources/data/images/shield_uno.png
136×208 RGBA PNG of an Arduino Uno shield outline (blue board with four corner mounting holes) — the kind of image a chip uses as its background (`src/components/subcircuits/chip.cpp:460`).

### resources/data/images/subc2.png
20×20 RGBA PNG of a square IC package with a dot marker; a near-duplicate of `ic2.png` — the subcircuit category icon.

### resources/fonts/Ubuntu-B.ttf
- Purpose: Ubuntu Bold, the proportional UI face.
- Key abstractions: A compiled TrueType sfnt (`00 01 00 00` version, table directory with `DSIG`/`GPOS`/`GSUB`).
- Data flow: `QFontDatabase::addApplicationFont(":/Ubuntu-B.ttf")` (`src/mainwindow.cpp:62`), then `fontName = "Ubuntu"` is set as the application font (`mainwindow.cpp:79`).
- Non-obvious design decisions: The six faces are shipped **inside the binary** as qrc aliases, so the app has a deterministic look on a machine with no fonts installed.
- Edge cases / failure handling: `addApplicationFont` returns an id that is discarded — a failure would be silent.
- Surprising: `UbuntuMono-*` is used as the monospace face for every numeric display in the app (logic analyser, memory tables, pin labels, the code editor, the serial console) — about a dozen call sites all set `font.setFamily("Ubuntu Mono")`.
- Not read line by line: it is a compiled binary font; the sfnt header and table directory were inspected and nothing else is readable in it.

### resources/fonts/Ubuntu-R.ttf
Regular proportional face; same registration path as `Ubuntu-B.ttf`. Binary sfnt, header inspected, not read line by line.

### resources/fonts/UbuntuMono-B.ttf
Ubuntu Mono Bold; the monospaced face for numeric readouts and the code editor. Binary sfnt, header inspected, not read line by line.

### resources/fonts/UbuntuMono-BI.ttf
Ubuntu Mono Bold-Italic; header confirms the `GSUB`/`DSIG` tables. Binary sfnt, not read line by line.

### resources/fonts/UbuntuMono-R.ttf
Ubuntu Mono Regular; the default monospace face. Binary sfnt, not read line by line.

### resources/fonts/UbuntuMono-RI.ttf
Ubuntu Mono Regular-Italic; binary sfnt, not read line by line.

### resources/icons/simulide.icns
- Purpose: The macOS application icon.
- Key abstractions: Apple's `icns` container — an `icns` magic header, a length field, then a `bplist00` payload of per-size icon chunks.
- Data flow: `ICON = $$PWD/resources/icons/simulide.icns` in `SimulIDE.pri:110` (the `macx` branch only).
- Non-obvious design decisions: The `.icns`/`.ico` are referenced from the `.pri` build script, while the `.png` is aliased into the qrc — the three icons travel by different mechanisms because they are consumed by three different layers.
- Edge cases / failure handling: n/a.
- Surprising: The macOS `.pri` branch also pins a hard-coded Homebrew GCC path (`SimulIDE.pri:117-119`) for the author only.
- Not read line by line: it is a packed binary icon archive; the container header and layout were inspected.

### resources/icons/simulide.ico
- Purpose: The Windows application icon.
- Key abstractions: An `ICONDIR` header declaring one 64×64 32-bit BMP entry.
- Data flow: `RC_ICONS += $$PWD/resources/icons/simulide.ico` (`SimulIDE.pri:103`) — consumed by the Windows resource compiler, not by Qt.
- Non-obvious design decisions: A single 64×64 entry rather than the usual 16/32/48/256 ladder; Windows will downscale.
- Edge cases / failure handling: n/a.
- Surprising: The `.ico` is a *build-system* input while the `.png` is a *runtime* input — the same artwork exists twice because the two consumers cannot share one file.
- Not read line by line: packed binary icon container; the header was inspected.

### resources/icons/simulide.png
- Purpose: The 256×256 cross-platform application icon: a yellow rounded chip with a purple outline and drawn circuit traces.
- Key abstractions: A PNG RGBA raster.
- Data flow: Aliased into the qrc as `:/simulide.png` (`src/application.qrc:44`) and used by the side-panel and About box; the `.desktop` file points at it by name (`resources/simulide.desktop:6`).
- Non-obvious design decisions: Because the `.desktop` file refers to `simulide.png` by *file name*, the icon must also be installed as a loose file for Linux desktop integration to find it.
- Edge cases / failure handling: n/a.
- Surprising: The `:/` alias and the loose-file name are the same string, which is what makes the single file serve both worlds.
- Not read line by line: a binary raster; rendered and identified visually.

### resources/qm/readme
- Purpose: One line — "All qm files for translations will be copied here."
- Key abstractions: The staging directory for the compiled `.qm` binaries.
- Data flow: `SimulIDE.pri:157-161` runs `lrelease` over `resources/translations/*.ts` and `resources/translations/qt/*.ts` and *moves* the resulting `.qm` into `resources/qm/`; the qrc then aliases them as `:/simulide_cz.qm` etc. (`application.qrc:11-25`).
- Non-obvious design decisions: The `.qm` files are build artifacts and are gitignored by the single line `resources/qm/*.*` (`.gitignore:1`).
- Edge cases / failure handling: n/a.
- Surprising: `resources/qm/readme` is *tracked* despite that ignore rule purely because the pattern `*.*` requires a dot and the filename has none — the one file in the folder survives by accident of the glob.

### resources/readme
- Purpose: Linux desktop-integration instructions for a user who installed the app outside a package manager.
- Key abstractions: Three steps — edit `SimulIDE.desktop` to point at the real install path, copy it to the desktop, and install `simulide-mime.xml` into `~/.local/share/mime/packages/` then run `update-mime-database`.
- Data flow: None — it is a human-facing note inside the resource tree.
- Non-obvious design decisions: The MIME registration is the mechanism by which a double-clicked `.simu` file in a file manager launches SimulIDE with that circuit.
- Edge cases / failure handling: The readme does not mention that `update-mime-database` must be run *after* copying the file, though it does order it that way.
- Surprising: The instruction file says "SimulIDE.desktop" with a capital S while the actual file is `simulide.desktop` — a case-sensitivity trap for anyone following it literally on Linux.

### resources/simulide-mime.xml
- Purpose: The freedesktop shared-mime-info declaration for SimulIDE's circuit file format.
- Key abstractions: `<mime-type type="application/x-simulide-circuit">` sub-classed from `application/xml`, with two glob patterns.
- Data flow: Installed into `~/.local/share/mime/packages/` and registered with `update-mime-database` (per `resources/readme`); the `.desktop` entry then claims `MimeType=application/x-simulide-circuit`.
- Non-obvious design decisions: The circuit file is declared a **subclass of application/xml**, so any XML tool can also open it — the format is XML underneath.
- Edge cases / failure handling: n/a.
- Surprising: The two globs `*.simu` and `*.sim1` are two *versions* of the same extension scheme, not two different formats — the `.sim1` suffix marks a newer save format, and both are registered so old files still open.

### resources/simulide.desktop
- Purpose: The freedesktop desktop entry that makes SimulIDE launchable from a menu and able to open circuit files.
- Key abstractions: A ten-line `[Desktop Entry]`.
- Data flow: `Exec=simulide %F` — the `%F` is what passes a double-clicked `.simu` file to the app; `MimeType=application/x-simulide-circuit` binds the entry to the MIME type above.
- Non-obvious design decisions: `Terminal=false` and `Categories=Education;Electronics;` position the app as a teaching tool, not an engineering one.
- Edge cases / failure handling: n/a.
- Surprising: `Icon=simulide.png` names a *file* rather than a themed icon name, so the desktop entry only resolves if the PNG is installed loose — the coupling to `resources/icons/simulide.png` and `resources/qm/readme`-style loose-file installs.

### resources/translations/qt/qt_en.ts
- Purpose: The English identity translation for Qt's own strings.
- Key abstractions: A Qt Linguist `<TS version="2.1" language="en">` document with **no** `<context>` elements.
- Data flow: `lrelease` compiles it to `qt_en.qm` (`SimulIDE.pri:159`), which is aliased into the qrc and loaded by `QTranslator`.
- Non-obvious design decisions: An empty catalogue is still shipped, so the loader has a file to load for the source language and the locale-lookup code path is uniform.
- Edge cases / failure handling: n/a.
- Surprising: Five lines and zero messages — the smallest useful translation artefact in the repo.

### resources/translations/qt/qt_de.ts
- Purpose: German translation of the small set of Qt's own strings that SimulIDE actually triggers.
- Key abstractions: 360 lines, **3 contexts** — `QPlatformTheme`, `QFileDialog`, `QFileSystemModel` — each holding only the strings that appear in SimulIDE's dialogs.
- Data flow: Same `lrelease` → `resources/qm/qt_de.qm` → qrc alias → `QTranslator` path.
- Non-obvious design decisions: These are *hand-curated subsets*, not the upstream Qt translations: a full `qt_de.ts` from Qt is several megabytes, and this one is 11 KB. The `<comment>`/`<extracomment>` entries ("Match Windows Explorer" vs "All other platforms", "OS X Finder") show the curator reasoning about which platform's wording to use.
- Edge cases / failure handling: n/a.
- Surprising: A hand-written subset of a framework's strings is a legitimate and cheap way to localise only what you use.

### resources/translations/qt/qt_cz.ts
- Purpose: The Czech counterpart of `qt_de.ts`.
- Key abstractions: 389 lines, the same 3 contexts, with an extra `Alias` message and the byte-size strings (`%1 TB`, `%1 GB`, `%1 MB`, `%1 KB`, `%1 bytes`).
- Data flow: Same pipeline; `lrelease` → `qt_cz.qm`.
- Non-obvious design decisions: The Czech file translates "File Folder" as "Souborová složka" — a *literal* rendering of the Windows-Explorer-specific string rather than a natural translation, which is what a hand-curated subset often looks like.
- Edge cases / failure handling: n/a.
- Surprising: The Czech and German catalogues are not the same size (389 vs 360) because each curator picked a slightly different subset of Qt's strings.

### resources/translations/qt/qt_es.ts
- Purpose: The Spanish counterpart.
- Key abstractions: 385 lines, same 3 contexts; translates the byte suffixes to the IEC spellings `TiB`/`GiB`/`MiB`/`KiB`.
- Data flow: Same pipeline; `lrelease` → `qt_es.qm`.
- Non-obvious design decisions: Spanish is the one catalogue in this set that bothers to distinguish TiB from TB, which is what a locale-aware curator does and an automatic one does not.
- Edge cases / failure handling: n/a.
- Surprising: It also translates the "Alt+Left"/"Alt+Right"/"Alt+Up" navigation accelerators into Spanish, and places them in a different position in the file than the German catalogue does — the message *order* is not canonical across catalogues.

### resources/translations/qt/qt_pt_BR.ts
- Purpose: The Brazilian Portuguese counterpart.
- Key abstractions: 360 lines, the same 3 contexts, but the most truncated of the small set — its `QFileSystemModel` context has no byte-size entries at all.
- Data flow: Same pipeline; `lrelease` → `qt_pt_BR.qm`.
- Non-obvious design decisions: Same hand-curation approach; the `<comment>` "OS X Finder" is translated as "Nome de exibição", which changes the meaning from "Alias" to "display name".
- Edge cases / failure handling: n/a.
- Surprising: Because the set is hand-curated per language, a string can be present in one catalogue and absent in another, so a missing translation is invisible unless you diff the contexts.

### resources/translations/qt/qt_zh_CN.ts
- Purpose: A *full* Qt translation catalogue for Simplified Chinese.
- Key abstractions: A 29,208-line `<TS>` document with **628 contexts and 6649 messages** — the complete upstream Qt translation, not a subset.
- Data flow: `lrelease` → `qt_zh_CN.qm` → qrc alias → `QTranslator`.
- Non-obvious design decisions: This file and the five small ones live in the same directory and are compiled by the same `lrelease` line, but they are of completely different provenance: `SimulIDE.pri:159` globs `resources/translations/qt/*.ts`, so a hand-curated subset and a full upstream catalogue are indistinguishable to the build.
- Edge cases / failure handling: n/a.
- Surprising: It is **byte-identical to `qt_zh_TW.ts` except for the `language=` attribute** — I proved this by a full line-by-line diff (2 differing lines out of 29,208). The "Traditional Chinese" catalogue is a copy of the Simplified one, so a Traditional-Chinese user gets Simplified glyphs.
- Not read line by line: 1 MB of machine-generated translation bulk. I read the header, enumerated all 628 context names and the 6649 message count, and diffed every line against the zh_TW file.

### resources/translations/qt/qt_zh_TW.ts
- Purpose: The supposed Traditional Chinese Qt catalogue.
- Key abstractions: 29,208 lines, 628 contexts, 6649 messages — structurally identical to `qt_zh_CN.ts`.
- Data flow: Same pipeline; `lrelease` → `qt_zh_TW.qm`.
- Non-obvious design decisions: None of its own — it is a duplicate.
- Edge cases / failure handling: n/a.
- Surprising: Verified by `Compare-Object -SyncWindow 0` over the whole file: the only difference is `language="zh_TW"` vs `language="zh_CN"`. Shipping a Traditional Chinese locale that is really Simplified is a silent localisation failure — the app reports the right language and shows the wrong script.
- Not read line by line: same reason as `qt_zh_CN.ts` — 1 MB of generated text, fully diffed against its twin rather than transcribed.

### resources/translations/simulide_cz.ts
- Purpose: SimulIDE's own Czech translation — the application's UI strings, not Qt's.
- Key abstractions: 7265 lines, **181 contexts** (one per class: `ADC`, `AboutDialog`, `CircuitView`, `CodeEditor`, `Compiler`, …) and 1326 messages.
- Data flow: `lrelease` → `resources/qm/simulide_cz.qm` → qrc alias `:/simulide_cz.qm` → `QTranslator`. The `context` name is the C++ `tr()` context, which is how a string is routed to the right class.
- Non-obvious design decisions: Every message carries `<location filename="../../src/components/logic/adc.cpp" line="25"/>` back-references into the C++ sources — so the file is regenerated by `lupdate` and the line numbers are what let a translator find the string in the code. Messages that no longer exist in the source are kept with `type="vanished"` (e.g. the "Electric" context header), so old translations are not silently lost.
- Edge cases / failure handling: n/a.
- Surprising: The `vanished` mechanism means the file accumulates dead entries forever; that is deliberate (a string can come back) but it makes the catalogue grow monotonically.
- Not read every message body: 286 KB of translation bulk; I read the header, every context name, the message structure and the location-tag format, and sampled the message bodies.

## Ideas worth stealing

- **Three-tier resource resolution — user data folder, then install folder, then compiled-in resource, with the *existence* of the file as the whole selection rule** — `resources/data/codeeditor/compilers/compilers/avrgcc.xml:3` (the file that a user can override) with the resolution order at `src/mainwindow.cpp:423-436` — *Why it matters for August:* August's data directory, skills directory and provider store already have a user-overrides-install relationship, but the resolver is scattered. A single `resolveDataFile(name)` with the order *user → install → packaged* and no configuration is a two-function change that makes every shipped data file overridable without a recompile and without a migration. It is also exactly the shape that lets the harness ship a default `diodes.model`-like policy file the user can edit.

- **The property sheet is a TEXT FILE, not a UI** — `resources/data/help/logicinputs.txt:1-9` (a 9-line fragment that every digital component reuses) and `resources/data/help/andgate.txt:7-11` (a component whose entire page is five `#include` lines) — *Why it matters for August:* a skill or a tool can render a component's full option set, defaults and units without linking against the component model. The same text drives the GUI, and an agent can read it to understand what a knob does. This is the cheapest possible "self-describing tool": the description, the default and the unit live in one place that both the UI and the model read.

- **Composition by textual `#include`, resolved recursively** — `resources/data/help/flipflopfull.txt:7` (one include) and `resources/data/help/counter.txt:22` (an include whose target does not exist) — *Why it matters for August:* August's skills are markdown with an obvious include story; a help page that is *assembled* from fragments means N components can share one physics description and one UI description without either duplicating it. The counter.txt dangling include is also the cautionary half: the include graph has **no validation step**, so a typo becomes a silent "No help available" string in the middle of a user's dialog. If August copies this pattern it must add the check the repo lacks — a grep for `#include` targets that do not exist.

- **A declarative, user-editable device model library in the SPICE parameter vocabulary** — `resources/data/diodes.model:5` (one line: `satCurr_nA`, `resist`, `emCoef`, `brkDown`) — *Why it matters for August:* this is a *policy file*, not a config file: four numbers per row, named after the physics, loadable without a recompile, and merged with hard-coded defaults so a missing file is harmless. August has no equivalent for anything as physical, but the same shape works for per-model pricing tables, token-cost weights or per-tool rate limits — named parameters in a flat TSV, merged over defaults, never a config that can leave a key unset.

- **Derive the UI from the template, not from a form** — `resources/data/codeeditor/compilers/template.txt:7-14` (the substitution list) and `src/gui/editorwidget/compiler.cpp:144-154` (the property dialog *grows a "Device" field because the argument string contains `$device`*) — *Why it matters for August:* a tool that is declared as a template should grow its own options from the template. A "run this tool" declaration that mentions `${device}` should surface a device picker, and one that mentions `${extraArgs}` should surface a free-text field — with no per-tool UI code at all. This is a concrete, small mechanism that removes an entire class of hand-written forms.

- **The type suffix is a BITFIELD, not an identifier** — `resources/data/codeeditor/compilers/types.txt:10-16` and the worked example at `resources/data/codeeditor/compilers/compilers/dummy_c.xml:3` (`type="c10"`) — *Why it matters for August:* when one registry has to carry several orthogonal facts, encode them in one short string and *write down the encoding in a 16-line file next to it*. The single page that defines the convention is what makes five different toolchain descriptors interoperable. August's own registries (tool definitions, permissions, model profiles) are exactly the place where a one-line type string with a documented bit layout would compress a config.

- **A cookbook that is the FORMAT SPECIFICATION, written next to the files it describes** — `resources/data/codeeditor/syntax/readme_syntax:1-16` (the header states the loader function and the directory) and `readme_syntax:197` (the `_dark.syntax` theme convention) — *Why it matters for August:* when a harness exposes a user-extensible format, the format's documentation should live *in the directory the user will look in*, name the exact function that parses it, and include a minimal working example. The 239 lines here are the reason a new assembler is a 15-line file.

- **The "one file per component, named by the component's registry id, lower-cased" convention** — `resources/data/help/touchpadr.txt:1` (the file whose name is the mangled id `TouchPadR`) and `resources/data/help/7-segbcd.txt:1` — *Why it matters for August:* a naming convention that is a pure function of the object's id means the help, the icon (`resources/data/images/ic2.png`) and the component itself cannot drift apart, and a new component needs no registration. August's tool surface would benefit from the same: the doc file's name IS the tool's id, lower-cased, with spaces removed.

- **A "volts equal to metres" input convention instead of a dedicated sensor dialog** — `resources/data/help/sr04.txt:4` — *Why it matters for August:* for a course tool, the cheapest interaction is to reuse a general-purpose input and give it a *unit convention* rather than building a control per device. A potentiometer is a dial, a temperature is a dial, a distance is a voltage with a stated scale. Every one of those avoids a bespoke widget and is teachable in one line of documentation.

- **The solver's knobs are documented as *user-facing settings*, with the accuracy/speed trade-off stated in words** — `resources/data/help/simulation.txt:15-17` ("Update step for reactive components. Icrease: better simulation speed but less accuracy") and `resources/data/help/simulation.txt:10-12` (Max Iterations, `0` for no limit) — *Why it matters for August:* August has exactly this shape of knob (model rounds, context window, budget). SimulIDE's formulation — *one named step, a plain-English statement of what you lose, and `0` meaning unbounded* — is the phrasing to copy, and it doubles as the documentation.

- **The "unbounded by default, armed by absence" convention for a safety limit** — `resources/data/help/simulation.txt:10-12` (`0 for no limit`) versus `resources/data/help/circuit.txt:16-19` (`0 disables Auto Backup`) — *Why it matters for August:* it is the *opposite* of the AGENTS.md rule that an absent key means ARMED at shipped constants. SimulIDE is explicit that `0` disables and that the value is shown in the UI with its default in parentheses, so a user can always see whether a limit is on. The transferable part is the *visibility* (the default is printed next to every property in every help file) and the *unambiguous sentinel* (0 = off, never "absent means off").

- **A per-component property sheet that states the failure mode in the same file as the feature** — `resources/data/help/led.txt:3` ("Blinks if maximum current is exceeded", with the Grounded option at `led.txt:11-13`) and `resources/data/help/elcapacitor.txt:2` ("Blinks if polarity is wrong") — *Why it matters for August:* when a tool has a physical failure mode, making it a *visible in-band signal* (the LED blinks) rather than a log line means the user learns the model by watching it. The same trick — a self-reporting widget instead of an error toast — is how an August tool should teach a failure the model can produce.

- **A synthetic-component trick that lets a taught example be *executed*, not just described** — `resources/data/help/csource.txt:3` ("Feasible to make: VCVS, CCVS, VCCS, CCCS" — one component, four topologies, selected by two booleans at `csource.txt:7` and `csource.txt:11`) and `resources/data/help/function.txt:7` (the `i0 | i1` function list) — *Why it matters for August:* for logic-coursework viability, a "Function" component whose output is a Boolean expression over named inputs, and a single "controlled source" that spans all four controlled-source topologies, are the two abstractions that let a student build *any* analogue or combinational block from a small, learnable set of parts. Both are documented in a few lines each.

- **A 2-digit bitfield plus a hand-trimmed translation subset as examples of "the smallest thing that carries the fact"** — `resources/data/codeeditor/compilers/types.txt:4` ("The key is in the last 2 numeric digits") and `resources/translations/qt/qt_de.ts:4-6` (three contexts only) — *Why it matters for August:* both are examples of *restraint*: a two-character convention instead of a schema, and eleven kilobytes of translation instead of a megabyte. A harness that ships a *curated* set of translated strings for exactly the surfaces it shows beats a full framework catalogue on every axis except completeness — and completeness is the one thing a coursework user does not need.

## Lens coverage for this repo (what this shard does and does not speak to)

| Lens | Coverage in this shard | Where |
|---|---|---|
| Overall architecture | **High.** The shard *is* the data tier of a three-tier (user → install → `:/`) resource architecture, and 202 of the repo's 1359 tracked files are the pure-content half of that (the other 7 files of `resources/` are the remaining `simulide_*.ts` translations, in resources#2). | `resources/data/codeeditor/compilers/compilers/avrgcc.xml:3`, `src/mainwindow.cpp:423-436` |
| Simulation engine core | **Indirect but real.** This shard holds the *named, defaulted, user-facing* surface of the solver: the non-linear iteration cap, the reactive step and its accuracy trade-off, the logic thresholds, the propagation delay expressed in gates, the gate delay / rise / fall times, and the component-level Reactive Step override. | `resources/data/help/simulation.txt:10-17`, `resources/data/help/logicedges.txt:1-13`, `resources/data/help/gatedelay.txt:1-9` |
| Component / plugin model and registration | **High.** Three independent registration-by-convention mechanisms live here: the component's *id* names its help file and its icon; the compiler XML directory is *scanned* to build the toolchain registry; the diode model file *is* the model registry. | `resources/data/help/touchpadr.txt:1`, `resources/data/images/ic2.png`, `resources/data/diodes.model:4-13`, `resources/data/codeeditor/compilers/compilers/avrgcc.xml:3` |
| Circuit / project file format and serialization | **Partial.** The format is declared, not defined: `application/x-simulide-circuit`, a subclass of `application/xml`, with two globs `*.simu` / `*.sim1` (two versions of one extension). The in-circuit persistence mechanism (memory contents saved into the circuit file) is documented but the serializer is in another shard. | `resources/simulide-mime.xml:3-9`, `resources/data/help/memory.txt:23-25`, `resources/data/help/i2cram.txt:23-25` |
| Scripting and embedded-code support | **Medium.** The whole embedded-code surface is declared as *data*: five compiler descriptors, the substitution template, the type-encoding spec, and thirteen highlighting definitions. The runtime is the bundled AngelScript JIT plus the Arduino/AVR-GCC external toolchains. | `resources/data/codeeditor/compilers/template.txt:7-20`, `resources/data/codeeditor/compilers/types.txt:1-16`, `resources/data/codeeditor/compilers/compilers/angelscript.xml:3` |
| UI / editor / canvas architecture | **High for the editor, medium for the canvas.** The editor's entire visual language is these files; the canvas's user-visible settings (grid, animation, redraw rate, auto-backup) are documented here even though the widget is elsewhere. | `resources/data/codeeditor/syntax/readme_syntax:1-239`, `resources/data/help/circuit.txt:1-20` |
| Undo / redo | **None.** There is no undo/redo artefact in this shard and no reference to one. | — |
| Performance techniques | **Documentary, not mechanistic.** The shard names the three performance levers the user can turn — simulation speed/steps-per-second, the reactive step, and the canvas redraw rate — and states the accuracy cost of each. The mechanisms themselves (the solver loop, the redraw timer) are in other shards. | `resources/data/help/simulation.txt:3-17`, `resources/data/help/circuit.txt:12-13` |
| Build system and packaging | **Medium.** The `.ts` → `.qm` pipeline, the gitignore of the staging folder, the qrc aliasing, the loose-file icon and MIME registration, and the desktop entry. The `INSTALLS` stanzas that would actually install `resources/data/` are **absent from this clone**. | `resources/qm/readme:1`, `.gitignore:1`, `SimulIDE.pri:157-161`, `resources/simulide.desktop:1-10` |
| Testing | **None, and that is itself a finding.** `git ls-files` over the whole repo (1359 files) shows no test directory, no CI workflow (`.github/` contains only `FUNDING.yml`), and no test runner. The two files whose names contain "test" are product features — a truth-table Test Unit *component* and a GUI batch-test runner — not automated tests. Which means every defect this shard contains (the dangling `#include propdelay`, the dead `gcbasic` keyword list, the double-escaped `js.syntax` regex, the duplicated `qt_zh_TW.ts`) is uncaught by construction. | `src/components/other/testunit.cpp`, `src/gui/testing/batchtest.cpp` |
| Viability as an August tool for logic-circuit coursework | **Strongest signal in the shard.** Three things make a circuit simulator teachable: the property sheet is plain text an agent can read, the shared physics fragments mean one description serves dozens of components, and the "volts = metres" convention (plus the `Function` component's `i0 \| i1` expression list) means a student can build any block from a small, learnable part set. The blockers are that there is no headless mode declared anywhere in this shard and no test suite to protect a rewritten engine. | `resources/data/help/sr04.txt:4`, `resources/data/help/function.txt:7`, `resources/data/help/csource.txt:3`, `resources/data/help/logicinputs.txt:1-9` |

## Files skipped (with reasons)

- `resources/fonts/Ubuntu-B.ttf` — compiled binary TrueType (sfnt `00 01 00 00`, 333 KB). I inspected the sfnt header and the table directory (`DSIG`, `GPOS`, `GSUB` present) to establish that it is a genuine Ubuntu Bold face registered via `QFontDatabase::addApplicationFont`; it has no textual content and was not read line by line.
- `resources/fonts/Ubuntu-R.ttf` — the same, Regular weight, 354 KB; header and table directory inspected.
- `resources/fonts/UbuntuMono-B.ttf` — the same, Ubuntu Mono Bold, 191 KB; header inspected.
- `resources/fonts/UbuntuMono-BI.ttf` — the same, Ubuntu Mono Bold-Italic, 216 KB; header inspected.
- `resources/fonts/UbuntuMono-R.ttf` — the same, Ubuntu Mono Regular, 206 KB; header inspected.
- `resources/fonts/UbuntuMono-RI.ttf` — the same, Ubuntu Mono Regular-Italic, 210 KB; header inspected.
- `resources/icons/simulide.icns` — a packed binary macOS icon container (140 KB) with an `icns` magic header and a `bplist00` payload of per-size icon chunks; the container layout was inspected but the payload is binary and was not read line by line.
- `resources/icons/simulide.ico` — a packed binary Windows icon container (12.8 KB) whose `ICONDIR` header declares one 64×64 32-bit BMP entry; the header was inspected, the pixel data not.
- `resources/translations/qt/qt_zh_CN.ts` — a *generated* 1 MB / 29,208-line Qt Linguist catalogue (628 contexts, 6649 messages). I read the header, enumerated every context name and counted the messages, and line-diffed the whole file against `qt_zh_TW.ts`; I did not transcribe all 29,208 lines because it is machine-generated translation bulk, and the diff established that its entire content is identical to its twin.
- `resources/translations/qt/qt_zh_TW.ts` — the same, and the same reason; the whole-file diff against `qt_zh_CN.ts` is the analysis.

## Uncertainties

- **The packaging/install step for `resources/data/` is not in this clone.** `resources/data/help/*.txt`, `resources/data/images/*` and `resources/data/diodes.model` are reached at runtime through `MainWindow::getDataFilePath` → `getConfigPath("data/"+file)` (`src/mainwindow.cpp:428`), i.e. from an *install* directory, but no `.pro` file in this snapshot contains an `INSTALLS` stanza, and `build_XX/SimulIDE_Build.pro` is a 6-line stub that only includes `SimulIDE.pri`. I therefore could not establish **which** mechanism copies `resources/data/` into the install tree. The qrc (`src/application.qrc:4-44`) covers the fonts, the compiled `.qm` files, **two** of the five compiler XMLs, the thirteen `.syntax` files and the icons — and *not* the help pages: I grepped the whole qrc for "help" and got exactly one hit, `<file alias="help.svg">` at line 52, which is a toolbar icon. So the `":/help"` third tier of `MainWindow::getHelp` (`mainwindow.cpp:361,364`) can never resolve, and the 154 help pages must arrive as loose files. I checked the whole `SimulIDE.pri` and the whole `src/application.qrc` for `INSTALLS`/`data/` and found none.
- **`resources/data/logic_families.model` does not exist.** `src/components/logicfamily.cpp:133` reads it through `getDataFilePath("logic_families.model")`, but `git ls-files resources` (209 files, reconciled exactly against the manifest) shows no such file, and the only `*.model` in the tree is `diodes.model`. I checked the manifest, the clone and `git ls-files` — it is absent from all three. Either upstream ships the logic-family models elsewhere (e.g. inside a chip package) or this is a genuine dangling reference. I could not determine which, because the consumer is in another shard.
- **`resources/data/codeeditor/compilers/default.xml` is not in the scanned directory.** The loader scans `data/codeeditor/compilers/compilers` and `.../assemblers` (`editorwindow.cpp:280-283`); `default.xml` sits one level up, at `data/codeeditor/compilers/`. It is also *not* aliased in the qrc (the qrc aliases only `angelscript.xml` and `arduino.xml` from that folder, at `application.qrc:27-28`). I could not establish how "None" is reached at runtime — it may be dead, or reached through a path I did not find.
- **I did not read the 1326 message bodies of `simulide_cz.ts`** (286 KB). I read the header, every context name, the `<location>` tag format and a representative sample. If the lead needs the exact Czech wording of a specific string, that string should be read directly; I make no claim about its accuracy.
- **I did not verify the ICU/encoding of the non-UTF-8 bytes** in the help files. Several contain mojibake-looking sequences (`8-bitÁ 16-bit` in `tiny2313.txt:33` and `mega16m1.txt`, `6 PWM �hannels` in `mega324.txt` and `mega1284.txt`, `-40?C to 85?C` in `mega1280.txt`) — these are almost certainly Windows-1252/Latin-1 bytes that would render as `–` and `°` in a Latin-1 reader. I did not establish the declared encoding, so I am reporting the bytes as they appear rather than guessing the intended characters.
- **I did not execute anything in the clone and did not build it**, so every claim about runtime behaviour (the three-tier lookup, the include expansion, the syntax highlighting) is derived from reading the consuming C++ in the `gui` and `build-root` shards, not from observation. I did read those consumer files (mainwindow.cpp, editorwindow.cpp, compiler.cpp, highlighter.cpp, utils.cpp, e-diode.cpp) precisely so that the shard's data files could be interpreted rather than guessed at.
- **The `readme_syntax:141` escaping claim and the `js.syntax` / `i51asm.syntax` defects are established by reading**, but I could not run the highlighter to observe the failure. The reasoning is: `remQuotes` (`src/utils.cpp:97-102`) removes exactly the first and last character and performs no unescaping, and the `\\\\`→`\\` collapse exists only in the `multiLineComment` branch (`highlighter.cpp:106,109`), never in the general quoted-pattern branch (`highlighter.cpp:114`). A run of the highlighter would settle it immediately.
- **The gcbasic "dead keyword" claim is likewise derived**: `highlightBlock` lower-cases the text and applies the *file-sourced* rules to the lower-cased copy (`highlighter.cpp:182,187`), while runtime-injected object/member/type rules are applied to the original case (`highlighter.cpp:184-186`). A plain word becomes `\bHSerPrint\b` (`highlighter.cpp:117`), which cannot match `hserprint`. I confirmed the highlighter is the only consumer of `.syntax` files, but I did not run it.
- **Two `.ts` files I read only structurally**: `qt_cz.ts`, `qt_es.ts` and `qt_pt_BR.ts` I read in full; `qt_de.ts` I read in full. The two 1 MB Chinese catalogues are the only text files in the shard I did not read end to end, for the reason given above.
- **`resources/data/images/*` provenance is uncertain.** These six PNGs sit in the *user-overridable* `data/images/` folder and are looked up by bare name (`getDataFilePath("images/"+icon)`, `componentlist.cpp:169`). `resources/data/images/ic2.png` and `resources/data/images/subc2.png` are near-duplicates, and `resources/data/images/null.png` is a *different file* from the `src/icons/components/null.png` that the qrc aliases as `:/null.png`. I could not establish which of the two `null.png` files (or which `ic2.png`) a given user-visible icon actually resolves to at runtime, because the two are reached through different mechanisms (a loose file in the data dir vs. a compiled-in `:/` alias) and the data-dir copy wins whenever it exists.

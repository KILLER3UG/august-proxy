# simulide / components-digital

## Shard shape

This shard is the **digital half of SimulIDE's component library**: 144 files across six directories under `src/components/` — `connectors/` (6), `logic/` (64), `meters/` (18), `micro/` (28), `subcircuits/` (12) and `switches/` (16). It contains no engine core and no GUI shell; it is the *library* that the engine drives. Every file is a `Component` subclass, and each one follows the same three-part contract that defines SimulIDE's plugin model: a static `construct(type,id)` factory, a static `libraryItem()` that returns the library entry (name, category, icon, type string, factory pointer — see `src/gui/componentlist/itemlibrary.h:34-51`), and a constructor that wires the part's pins and its `ComProperty` groups. Registration is by hand in one file (`src/gui/componentlist/itemlibrary.cpp:154-…`, one `addItem( X::libraryItem() );` per part), so adding a component is two edits: the class, and one line in the library.

The shard splits into four functional groups that fit together through a shared **four-verb simulation protocol** inherited from `Component`/`IoComponent`: `stamp()` (called at simulation start — register callbacks, set initial state), `voltChanged()` (a pin changed — recompute and `scheduleOutPuts()`), `runEvent()` (a scheduled event fired — commit outputs), and `updateStep()` (per-frame — repaint, poll). `logic/` holds the combinational and sequential digital parts (gates, flip-flops, counters, registers, memories, converters, an AngelScript-backed `Function` block); `meters/` holds the instrumentation (ammeter, voltmeter, frequency meter, oscilloscope, logic analyzer, probe); `micro/` holds parts that speak real serial protocols to a simulated controller (I2C, 1-Wire, SPI, UART, SD card) plus the input devices a student drives by hand (joystick, rotary encoder, touchpad, sliders); `switches/` holds the sources of stimulus (push buttons, toggles, DIP banks, keypads, relays); `subcircuits/` is the *hierarchy* layer — `Chip` reads a package description out of the circuit file, `SubCircuit` re-inflates a whole embedded circuit as a component, and `Board`/`Shield`/`Module` layer Arduino-style boards on top; `connectors/` holds the wiring primitives — `Tunnel` (named net), `Socket` (a re-connectable connector) and `Header`.

The two things that make this shard interesting to an August harness are (a) the **property system**: every knob on every part is a `ComProperty` in a named group with flags (`propNoCopy`, `groupNoCopy`, `groupHidden`), and the whole part serialises to one line of `key="value"` attributes — so a circuit file *is* a property dump, and a part's API *is* its property list; and (b) the **`propNotFound` back-compat hook** (`src/gui/circuitwidget/compbase.cpp:100-109`): when a saved file names a property a component no longer has, the component gets a chance to claim it and translate it, which is how this repo has migrated file formats for a decade without a version table.

---

## Per-file notes

### src/components/connectors/header.h
- Purpose: Declares `Header : public ConnBase` — a 1..N pin row that is either a "header" pin type (stacks behind parent, connectable only from above) or a normal pin when flipped downward.
- Key abstractions: Only adds `pointDown()/setPointDown()` and an `updatePins()` override on top of `ConnBase`.
- Data flow: `updatePins()` is called by the base when the pin count changes and re-applies the current orientation.
- Non-obvious design decisions: The header stores one boolean for the whole strip, so flipping is an all-or-nothing operation.
- Edge cases / failure handling: `setPointDown` also toggles `ItemStacksBehindParent` per pin so the graphical stack matches the electrical meaning.
- Surprising: A header is a *different pin type* from a normal pin (`Pin::pinHeader` vs `Pin::pinNormal`), not just a different drawing.

### src/components/connectors/header.cpp
- Purpose: Implements the header strip: orientation, pin-type swap, and the two pixmaps (`:/header_U.png`, `:/header_D.png`) rotated to match the component's rotation.
- Key abstractions: `updatePixmap()` rotates the loaded pixmap by the component angle, special-casing ±90° because the D-variant needs the opposite rotation.
- Data flow: `setPointDown()` → per-pin `setPinType()` → `updatePixmap()` → repaint.
- Non-obvious design decisions: The "down" variant is a *different pin type* (`pinNormal`) rather than just a flipped graphic, which changes what the connection rules allow.
- Edge cases / failure handling: The switch on rotation only handles 0/180/-180 and 90/-90; other angles fall through with no rotation applied.
- Surprising: The header is a `ConnBase`, the same base as `Socket` — the two connector families share a base class.

### src/components/connectors/socket.h
- Purpose: Declares `Socket : public ConnBase` — a connector whose pins are re-checked every simulation step so a socket can be plugged and unplugged while the circuit runs.
- Key abstractions: `updateStep()` and `connectPins(bool)`; `updatePins()` is overridden to call `connectPins(false)` immediately.
- Data flow: `Simulator::addToUpdateList()` → per-frame `updateStep()` → `connectPins()`.
- Non-obvious design decisions: `connectPins(false)` is called on *every* frame — the socket re-evaluates rather than relying on a connect event.
- Edge cases / failure handling: Losing a connection calls `CircuitWidget::powerCircOff()`, so a mid-run unplug restarts the simulation rather than leaving it in a half-wired state.
- Surprising: A socket that is unplugged powers the whole circuit off — the editor treats that as a structural change.

### src/components/connectors/socket.cpp
- Purpose: Socket implementation: registers itself with `Simulator::addToSocketList()`, and each frame walks its socket pins calling `connectPin(false)` to discover a mate.
- Key abstractions: Uses `Pin::connectPin()`/`setConPin()` for the pairing and `m_connPins[]` to remember the previous mate.
- Data flow: `updateStep()` → `connectPins(false)` → for each unconnected socket pin, ask the pin for a candidate → on a new mate, link both ways and remember it; on a lost mate, unlink and `powerCircOff()`.
- Non-obvious design decisions: The "connect" path (`connectPins(true)`) exists but is never called from here — the socket is *always* discovering, never asserting.
- Edge cases / failure handling: `m_sockPins[i]->connector()` short-circuits pins already carrying a connector, so a manually wired pin is never stolen.
- Surprising: The socket is a live, hot-pluggable connector: a wire can be dragged into it while the simulation runs.

### src/components/connectors/tunnel.h
- Purpose: Declares `Tunnel : public Component` — the named-net primitive. A tunnel is a one-pin component whose *name* is its identity; all tunnels with the same name are one electrical node.
- Key abstractions: A **static** `QMap<QString, QList<Tunnel*>*> m_tunnels` registry (`tunnel.h:62`), a static `getEnode(name)` lookup, a static `clearTunnels()`, plus per-instance `m_blocked` (re-entrancy guard), `m_packed` (hidden inside a chip), `m_tunUid` (stable per-instance id used to rename tunnels when a subcircuit is instantiated).
- Data flow: `setName()` → `setGroupName()` → remove from old group, add to new group → the group re-links each tunnel's pin to the shared eNode.
- Non-obvious design decisions: The name is HTML-entity-decoded on the way in (`&#x3C;` → `<`), because names arrive from XML-ish property strings; a tunnel name is *user data*, not an identifier.
- Edge cases / failure handling: `m_blocked` prevents infinite recursion when a group of tunnels re-links each other; `removeTunnel()` deletes the group's list when the last member leaves.
- Surprising: `Tunnel::mousePressEvent` deliberately swallows the press when `Linker::m_selecComp` is set — a tunnel may not be linked or made a main component.

### src/components/connectors/tunnel.cpp
- Purpose: Implements the named-net registry and the group re-link protocol.
- Key abstractions: `m_tunnels` static map of name → list of tunnels; `m_blocked` is a per-instance re-entrancy flag guarding `setEnode()`/`registerEnode()`.
- Data flow: `registerEnode(enode)` is called by the pin when the tunnel's pin joins a node; it looks up the name's list and calls `setEnode()` on every *other* tunnel in the group, which registers the same node on their pins.
- Non-obvious design decisions: `m_blocked` is set **on the instance doing the propagating** and cleared after — the guard is per-tunnel, not per-group, which is why the recursion terminates: A→B→A stops when B's `setEnode` sees A already blocked.
- Edge cases / failure handling: Renaming a group while the circuit runs powers it off (`setGroupName` → `powerCircOff()`); `renameGroup()` renames all members as one operation.
- Surprising: `paint()` colours the tunnel green when it is a *bus* and off-white otherwise, and blue-tints the whole group when "show group" is active — the group highlight is a first-class visual feature.

### src/components/logic/adc.h
- Purpose: Declares `ADC : public LogicComponent` — an analogue-to-digital converter whose output is a parallel bit vector.
- Key abstractions: `maxVolt()/setMaxVolt()` (reference voltage), `setNumOutputs()` (bit count), and the protected `m_ratio`/`m_maxValue` scaling pair.
- Data flow: `voltChanged()` reads the input pin's voltage and converts.
- Non-obvious design decisions: The class inherits `LogicComponent` even though one input is analogue — the *output* is digital, and the framework only has one digital-family base.
- Edge cases / failure handling: The conversion clamps to `m_maxValue` rather than wrapping.
- Surprising: `runEvent()` is overridden to the bare `IoComponent::runOutputs()`, i.e. the ADC has no special event behaviour.

### src/components/logic/adc.cpp
- Purpose: Implements the ADC: voltage → integer → parallel digital outputs.
- Key abstractions: `m_ratio = m_maxValue/m_maxVolt` computed once when either the bit count or the reference changes.
- Data flow: `voltChanged()` → `m_nextOutVal = volt*m_ratio+0.1` (the +0.1 is a rounding guard) → clamp to `m_maxValue` → `scheduleOutPuts(this)`.
- Non-obvious design decisions: The ratio is cached in a member rather than recomputed per sample — a deliberate hoist of the divide out of the hot path.
- Edge cases / failure handling: `setNumOutputs()` rejects `outs < 1`.
- Surprising: `setMaxVolt()` recomputes `m_ratio` but does **not** re-derive `m_maxValue` — the two are only consistent because `setNumOutputs` sets both.

### src/components/logic/bcdbase.h
- Purpose: Declares `BcdBase : public LogicComponent` — the shared base of the BCD-to-seven-segment parts: it owns the segment lookup table and the decoded digit.
- Key abstractions: `uint8_t m_segments[17]` (the segment bitmap for digits 0–16), `m_digit` (the currently displayed value), `m_customChars` (a user-supplied CSV override).
- Data flow: `voltChanged()` decodes 4 input bits into an index and looks up `m_segments[index]`.
- Non-obvious design decisions: The digit is stored as a *segment bitmask*, not a number, so the seven-segment renderer needs no lookup of its own.
- Edge cases / failure handling: `m_segments` has 17 entries but the custom-character path only fills 16 — index 16 stays at whatever the default set.
- Surprising: The default segment table is a hard-coded 17-line literal of binary masks, with bit 7 reserved for the decimal point.

### src/components/logic/bcdbase.cpp
- Purpose: Implements the BCD decode and the segment-table setup.
- Key abstractions: `setCustomChars(QString)` parses a comma-separated list of decimal integers as segment masks.
- Data flow: `voltChanged()` reads four input pins, computes `index = a*1+b*2+c*4+d*8`, and sets `m_digit = m_segments[index]`.
- Non-obvious design decisions: The custom-character list is padded with zeros when shorter than 16, so a partially-specified table blanks the remaining digits rather than reading past the end.
- Edge cases / failure handling: `charList.at(i).toInt()` on a non-numeric entry yields 0 (a blank digit) rather than throwing.
- Surprising: `m_changed = true` is set at the end of `setCustomChars`, which forces a repaint of the display even though the segment table is not a live input.

### src/components/logic/bcdto7s.h
- Purpose: Declares `BcdTo7S : public BcdBase` — a BCD decoder driving seven segment outputs directly (a "logic-level" 7-segment, not a display).
- Key abstractions: `m_useReset` (optional reset pin), `m_resetPin`; inherits the segment table from `BcdBase`.
- Data flow: `voltChanged()` → `updateOutEnabled()` → `BcdBase::voltChanged()` → optional reset override → `scheduleOutPuts()`.
- Non-obvious design decisions: The reset pin is created hidden and only made visible when the `UseRS` property is turned on, so it costs no space by default.
- Edge cases / failure handling: The reset pin is *inverted*, so asserting it means pulling it low.
- Surprising: `propNotFound` exists purely to keep **old** circuit files working — it maps a retired `Reset_Inverted` property onto the pin's inverted flag.

### src/components/logic/bcdto7s.cpp
- Purpose: Implements the BCD→7-segment decoder with optional reset and output-enable.
- Key abstractions: Pins are declared with the compact `init({...})` string DSL — `"IL03S0"` means Input, Left side, position 3, label "S0" (`src/components/iocomponent.cpp:361-443`).
- Data flow: `voltChanged()` computes the segment mask then, if the reset pin is asserted, overrides `m_nextOutVal = 0`.
- Non-obvious design decisions: The reset pin is created *manually* (not through `init()`) because it must be invertible, hidden by default and optionally disconnected.
- Edge cases / failure handling: `setPinReset(false)` calls `m_resetPin->removeConnector()`, so disabling the feature genuinely removes the wire rather than orphaning it.
- Surprising: `updateStep()` zeroes the digit when the circuit is not running, so a stopped circuit shows a blank display rather than a stale value.

### src/components/logic/bcdtodec.h
- Purpose: Declares `BcdToDec : public LogicComponent` — a 4-to-10/16 decoder (one-hot outputs).
- Key abstractions: `m_16Bits` switches the output count between 10 and 16.
- Data flow: `voltChanged()` sums the four input states into `dec`, then publishes `1<<dec` as the output word.
- Non-obvious design decisions: The one-hot encoding is packed into a *single integer output word* rather than N separate pins.
- Edge cases / failure handling: The output-enable pin is created via `createOePin()` and the OE pin is repositioned when the width changes.
- Surprising: With 10 outputs the one-hot mask can exceed the pin count, so the top codes are truncated by the pin array rather than rejected.

### src/components/logic/bcdtodec.cpp
- Purpose: Implements the 4-to-10/16 decoder.
- Key abstractions: Uses `pow(2,i)` to accumulate the input value and `1<<dec` for the one-hot output.
- Data flow: `stamp()` sets output 0 high and `m_outValue = 1` (code 0 selected at rest); `voltChanged()` recomputes and schedules.
- Non-obvious design decisions: Uses `pow(2,i)` (floating point) where `1<<i` would do — an artefact of copy-paste from the 10-bit variants.
- Edge cases / failure handling: `set_16bits()` repositions the OE pin (`m_oePin->setY(m_area.y()-8)`) because the body grew.
- Surprising: The initial state is code 0 *selected*, i.e. output 0 is high before any input is applied.

### src/components/logic/bincounter.h
- Purpose: Declares `BinCounter : public LogicComponent` — a configurable binary counter with parallel load, up/down direction, RCO and RBO outputs.
- Key abstractions: `m_bits`, `m_counter`, `m_topValue` (derived from bits), plus six optional control pins held separately from the data pins: `m_dirPin`, `m_ldPin`, `m_rstPin`, `m_rcoPin`, `m_rboPin`.
- Data flow: `voltChanged()` → `updateClock()` → reset / parallel-load / clock-edge branches.
- Non-obvious design decisions: The control pins are created by hand *before* `setNumInps()` so their indices do not shift when the data width changes — data inputs are deliberately numbered from id 10 upward.
- Edge cases / failure handling: `setBits()` clamps to a minimum of 1 and recomputes `m_topValue = 2^bits-1`.
- Surprising: The RCO/RBO outputs are asserted for exactly one cycle at the terminal count, then deasserted when the counter wraps.

### src/components/logic/bincounter.cpp
- Purpose: Implements the binary counter.
- Key abstractions: `updatePins()` recomputes the whole body layout (`m_area.setHeight`) whenever bits, parallel-load, bidirectionality or RCO usage changes.
- Data flow: `voltChanged()` → reset sets counter to 0; parallel load ORs the data pins into the counter; a rising clock increments (or decrements) and asserts/deasserts RCO/RBO at the terminal value.
- Non-obvious design decisions: The RCO pulse is scheduled with `m_rcoPin->scheduleState(true, m_delayBase*m_delayMult)` — i.e. it goes through the *event* queue with the component's own delay, so it is visible to the rest of the circuit at the right simulated time.
- Edge cases / failure handling: `setParallelIn(false)` re-registers every data pin's callback with `false` (disabled), so stale data cannot trigger a spurious load.
- Surprising: `propNotFound` again exists only for back-compat (`Clock_Inverted`, `Reset_Inverted`).

### src/components/logic/buffer.h
- Purpose: Declares `Buffer : public Gate` — a 1-input gate.
- Key abstractions: `m_small` (a compact 10×10 symbol variant) and `setTristate()` override.
- Data flow: `Gate::voltChanged()` counts high inputs and calls `calcOutput()`; the buffer's default (`all inputs high`) is already buffer behaviour.
- Non-obvious design decisions: `remProperty("Inverted")` removes the inherited invert-output property because inversion is done by right-clicking the pin.
- Edge cases / failure handling: `setSmall()` repositions the output pin, the OE pin and the body rect together, so the symbol stays coherent.
- Surprising: The buffer does not override `calcOutput()` at all — it inherits `Gate`'s default, which is *and*-like and therefore correct for a 1-input buffer.

### src/components/logic/buffer.cpp
- Purpose: Implements the buffer, including its small-symbol variant.
- Key abstractions: `updatePath()` draws either the large triangle or the small one, from the same code path.
- Data flow: `setSmall()` → pin geometry → `updatePath()` → `Circuit::update()`.
- Non-obvious design decisions: `setTristate()` calls the base and then blanks the OE pin label, because the buffer's OE pin is always present but only meaningful in tristate mode.
- Edge cases / failure handling: `setSmall()` sets exact X positions and lengths for both the output and OE pins so the small symbol does not overlap its own pins.
- Surprising: The buffer's default value is "initial high" configurable, inherited from `Gate::outputProps()`.

### src/components/logic/bus.h
- Purpose: Declares `Bus : public Component, public eElement` — a bus splitter that exposes individual bit lines of a bus as separate pins.
- Key abstractions: `m_busPin0`/`m_busPin1` (the bus itself), `m_numLines`, `m_startBit` (the bit index the bus starts at), `m_signalPin[]` for the individual bit pins.
- Data flow: `registerEnode()` maps the bus eNode onto whichever bit pin falls inside the line range.
- Non-obvious design decisions: The bus pin has `setIsBus(true)` and length 1 — it is a *type* marker as much as a connection point.
- Edge cases / failure handling: `setNumLines()` and `setStartBit()` power the circuit off first if it is running.
- Surprising: The splitter is an `eElement` (an engine node) *and* a `Component` — the bus participates in the electrical solve, it is not just a drawing.

### src/components/logic/bus.cpp
- Purpose: Implements the bus splitter.
- Key abstractions: `setNumLines(int)` deletes and recreates all bit pins, renumbering them from `m_startBit`.
- Data flow: `registerEnode(enode, n)` → if `n+1-m_startBit` is inside `[0, m_numLines]`, register the node on that bit pin.
- Non-obvious design decisions: Each bit pin's `index` is `m_startBit+i-1`, so the bit numbering is global to the bus rather than local to the splitter.
- Edge cases / failure handling: `setNumLines()` refuses `lines < 1` and short-circuits when the count is unchanged.
- Surprising: The splitter's own body is a 5-pixel-wide vertical bar (`m_area = QRect(-3,-m_height*8-2, 5, m_height*8+4)`) — it is drawn as a *line*, not a box, because it is a bus tap, not a component.

### src/components/logic/counter.h
- Purpose: Declares `Counter : public LogicComponent` — a simple up-counter with an optional Set pin.
- Key abstractions: `m_Counter` (current value), `m_TopValue` (terminal count), `m_pinSet`/`m_setPin`.
- Data flow: `voltChanged()` → reset / set / clock-edge branches.
- Non-obvious design decisions: The output is a *single bit* that is high exactly at the terminal value, not the binary count — this is a "counter reaches N" detector, not a counter.
- Edge cases / failure handling: `useSetPin(false)` calls `m_setPin->removeConnector()`.
- Surprising: `m_TopValue` is 1 by default, so a default counter is a divide-by-two toggle.

### src/components/logic/counter.cpp
- Purpose: Implements the simple counter.
- Key abstractions: Pins come from the `init({...})` DSL with the clock as `m_inpPin[0]`, reset as `[1]`, set as `[2]`.
- Data flow: `voltChanged()` → `updateClock()` → reset clears and outputs 0; set loads `m_TopValue` and outputs 1; a rising clock increments and outputs 1 exactly at `m_TopValue`.
- Non-obvious design decisions: The counter **wraps to zero** when it exceeds the top value, so it is a modulo-N counter whose *output* is a one-shot at N.
- Edge cases / failure handling: The Set pin is inverted (asserted low), matching the Reset pin.
- Surprising: `m_nextOutVal = 1` on Set — setting the counter to the top value makes the output high immediately, before any clock edge.

### src/components/logic/dac.h
- Purpose: Declares `DAC : public LogicComponent` — digital-to-analogue converter, the mirror of the ADC.
- Key abstractions: `m_maxVolt` (full-scale voltage), `m_maxValue` (full-scale integer, derived from the bit count), `m_val` (the accumulated input word).
- Data flow: `voltChanged()` accumulates the input bits into `m_val` and schedules an event; `runEvent()` computes and applies the output voltage.
- Non-obvious design decisions: The analogue output is produced in `runEvent()`, not in `voltChanged()`, so it honours the component's propagation delay.
- Edge cases / failure handling: `m_val` is initialised to -1 so the first `runEvent()` before any input is distinguishable.
- Surprising: The DAC's output is an `IoPin` in *output* mode whose `setOutHighV()` carries the analogue value — the analogue level rides on the same pin mechanism as a digital one.

### src/components/logic/dac.cpp
- Purpose: Implements the DAC.
- Key abstractions: `setNumInputs(int)` sets `m_maxValue = 2^inputs-1` and the pin count together.
- Data flow: `voltChanged()` → `m_val` = sum of `2^i` for asserted inputs → `Simulator::addEvent(delay, this)` → `runEvent()` → `m_outPin[0]->setOutHighV(maxVolt*val/maxValue)` and `setOutState(true)`.
- Non-obvious design decisions: The output is forced *high* (`setOutState(true)`) as well as given a high voltage, because a DAC output is an analogue node that must not be treated as a logic low.
- Edge cases / failure handling: `setNumInputs` rejects `inputs < 1`.
- Surprising: The DAC's `runEvent()` does *not* call `IoComponent::runOutputs()` — it drives the analogue pin directly, so the digital output machinery is bypassed entirely.

### src/components/logic/dectobcd.h
- Purpose: Declares `DecToBcd : public LogicComponent` — a 10/16-to-4 priority encoder.
- Key abstractions: `m_16Bits` and `m_bits` (the active input count), four outputs packed into one output word.
- Data flow: `voltChanged()` scans the inputs from the top down and publishes the index+1.
- Non-obvious design decisions: The four encoder outputs are *one* output word (bits A/B/C/D), not four pins.
- Edge cases / failure handling: The scan loop starts at `m_bits-2`, so the highest-numbered input is deliberately excluded.
- Surprising: With nothing asserted the loop ends with `i = -1` and the output is 0 — but with bit 0 asserted the result is 1, so the encoding is off by one from the raw index.

### src/components/logic/dectobcd.cpp
- Purpose: Implements the priority encoder.
- Key abstractions: `set16bits(bool)` grows the input count from 10 to 16 and repositions the OE pin.
- Data flow: `voltChanged()` → if tristate, `updateOutEnabled()` → scan down from the second-highest input → `m_nextOutVal = i+1` → `scheduleOutPuts()`.
- Non-obvious design decisions: The scan is a *priority* encoder (highest index wins), implemented as a descending loop with an early break.
- Edge cases / failure handling: `m_inpPin[i]->getInpState()` is read only for `i < m_bits`, so the extra inputs of the 16-bit variant are read but the 10-bit variant never reads past its own width.
- Surprising: The encoder's output is *not* the standard binary code of the asserted input — it is `index+1`, because index 0 is reserved for "nothing asserted".

### src/components/logic/demux.h
- Purpose: Declares `Demux : public LogicComponent` — one data input, N address bits, 2^N one-hot outputs.
- Key abstractions: `m_addrBits` (1–3, hard-clamped), a custom `QPainterPath shape()` for the trapezoid symbol.
- Data flow: `voltChanged()` computes the address and publishes `1<<address` when the enable pin is high.
- Non-obvious design decisions: The address size is capped at 3 bits (8 channels) by `setAddrBits`, even though the code uses `pow(2,bits)` generally.
- Edge cases / failure handling: When the address size shrinks, surplus output pins are hidden *and* `removeConnector()` is called, so a wire left on a deleted channel cannot silently persist.
- Surprising: The enable pin is checked first; if it is low the output word is 0, which is the same as "no channel selected" — the enable and address are conflated in the output word.

### src/components/logic/demux.cpp
- Purpose: Implements the demultiplexer and its resizable symbol.
- Key abstractions: `setAddrBits(int)` repositions the address pins, output pins, OE pin and body rect together.
- Data flow: `voltChanged()` → `updateOutEnabled()` → address from the three select pins → `m_nextOutVal = 1<<address` (or 0 if the enable input is low).
- Non-obvious design decisions: The output pins are positioned with the formula `i*8-(bits+bits/3)*8` — the symbol's height and the pin spacing are derived from the *address size*, not fixed.
- Edge cases / failure handling: `setAddrBits` powers the circuit off before restructuring.
- Surprising: The 4th input (`m_inpPin[3]`) is the data/enable input and is checked first in `voltChanged()` — but the *value* of the data input is never read, only its boolean state. The demux routes a *bit*, not a word.

### src/components/logic/dynamic_memory.h
- Purpose: Declares `DynamicMemory : public LogicComponent, public MemData` — a DRAM with RAS/CAS/WE/OE and a per-row refresh requirement.
- Key abstractions: `m_ram` (the cell array), `m_rowLastRefresh[]` (a timestamp per row), `m_refreshPeriod`, `m_intRefresh` (the internal refresh counter), `m_refreshError` (a per-row staleness flag).
- Data flow: `voltChanged()` watches RAS/CAS/WE/OE; a RAS-without-CAS latches a row address, a CAS-after-RAS performs the access.
- Non-obvious design decisions: The refresh logic distinguishes "RAS before CAS" (an external refresh of the addressed row) from "RAS after CAS" (an internal refresh cycling through rows).
- Edge cases / failure handling: A row not refreshed within `m_refreshPeriod` sets `m_refreshError`.
- Surprising: This is the only part in the shard with a *failure* condition the user can detect — the error flag exists but is not surfaced in the UI (the `qDebug` at line 177 is commented out).

### src/components/logic/dynamic_memory.cpp
- Purpose: Implements the DRAM.
- Key abstractions: `setRowAddrBits`/`setColAddrBits` keep the total address width ≤ 24 bits and resize both the RAM and the refresh table.
- Data flow: `voltChanged()` → compute OE (needs OE & !WE & CAS) → toggle the output pins between input and output mode → on a RAS edge, latch the row address or advance the internal refresh counter and check the refresh deadline → on a CAS edge with RAS high, form the address and read or write.
- Non-obvious design decisions: The address is computed as `m_rowAddress * pow(2,m_rowAddrBits)` plus the column bits — the row and column share one address bus, as a real DRAM does, which is why the RAS/CAS protocol exists at all.
- Edge cases / failure handling: `m_ram` is filled with random data at `stamp()` (simulating an uninitialised DRAM) unless the part is persistent.
- Surprising: `setAddrBits` resizes `m_ram` to `2^bits` *twice* — once inside `setAddrBits` and again in `setRowAddrBits`/`setColAddrBits` — and the code comments acknowledge the double resize.

### src/components/logic/flipflopbase.h
- Purpose: Declares `FlipFlopBase : public LogicComponent` — the shared base of the D/JK/RS/T flip-flops.
- Key abstractions: `m_useRS` (whether the Set/Reset pins are wired), `m_Q0` (the internal state), `m_dataPins` (how many data inputs the variant has), the virtual `calcOutput()`.
- Data flow: `voltChanged()` → `updateClock()` → set/reset override → otherwise `calcOutput()` when the clock allows.
- Non-obvious design decisions: The output word packs **both** Q and !Q into one integer: `m_nextOutVal = (set?1:0)+(reset?2:0)` — bit 0 is Q, bit 1 is !Q.
- Edge cases / failure handling: `stamp()` randomises `m_Q0` (`rand()%2`) so an un-driven flip-flop does not start deterministically — a deliberate choice that hides bugs but also makes them irreproducible.
- Surprising: `updateStep()` re-runs `voltChanged()` when `m_changed` is set, which is how a property change (e.g. trigger type) takes effect while stopped.

### src/components/logic/flipflopbase.cpp
- Purpose: Implements the flip-flop base: set/reset arbitration, clock gating, and the trigger-type property.
- Key abstractions: `m_triggerList` (the shared enum list of trigger types) and `triggerStr()/setTriggerStr()`.
- Data flow: `voltChanged()` → `updateClock()` → `sPinState()`/`rPinState()` → if set or reset, override the output word; else if `m_clkState == Clock_Allow`, call `calcOutput()`.
- Non-obvious design decisions: `updateClock()` is called on *every* `voltChanged()` with the comment "Update Clk to don't miss any clock changes" — the clock edge is re-derived from the pin state rather than relying on the callback ordering, which is what makes an edge-triggered part correct even when several pins change in the same instant.
- Edge cases / failure handling: The Set/Reset pins are only read when `m_useRS` is true.
- Surprising: `propNotFound` is the file-format migration hook: old circuits that stored `Reset_Inverted` or `Clock_Inverted` are translated onto the pins' inverted flags at load time.

### src/components/logic/flipflopd.h
- Purpose: Declares `FlipFlopD : public FlipFlopBase`.
- Key abstractions: None beyond the base — the whole variant is `calcOutput()`.
- Data flow: `calcOutput()` publishes the D input as bit 0 and its inverse as bit 1.
- Non-obvious design decisions: A D flip-flop *is* a mux: the base already gates on the clock, so the D variant only needs `m_nextOutVal = D ? 1 : 2`.
- Edge cases / failure handling: `m_dataPins = 1` tells the base which input pins to register callbacks on.
- Surprising: The D and T variants are the *same* code with one line changed — the base class abstraction is genuinely earning its keep.

### src/components/logic/flipflopd.cpp
- Purpose: Implements the D flip-flop.
- Key abstractions: `init({...})` declares D, Set, Reset, Clock and the two outputs in one block.
- Data flow: `calcOutput()` → `m_nextOutVal = m_inpPin[0]->getInpState() ? 1 : 2`.
- Non-obvious design decisions: The `init()` DSL encodes side and position in the pin string, so the *symbol layout* is declared in the same breath as the *pin list*.
- Edge cases / failure handling: The Set and Reset pins are inverted individually (`setInverted(true)`), not via a shared flag.
- Surprising: `setTriggerStr("Clock")` is called explicitly in the constructor even though `eClockedDevice` defaults to `Clock` — because the base's `m_trigger` is set there but the *property* list needs the string set too.

### src/components/logic/flipflopjk.h
- Purpose: Declares `FlipFlopJK : public FlipFlopBase`.
- Key abstractions: None beyond the base.
- Data flow: `calcOutput()` reads J, K and the *current* Q output pin state.
- Non-obvious design decisions: The JK variant reads the current output from the pin (`m_outPin[0]->getOutState()`) rather than from a member, so it always uses the last *published* state.
- Edge cases / failure handling: J=K=1 toggles, J=1/K=0 sets, J=0/K=1 resets, J=K=0 holds — the classic characteristic equation `(J && !Q) || (!K && Q)`.
- Surprising: The equation is written in terms of the *inverted* logic (`!K && Q` for set) because `m_setPin`/`m_rstPin` are active-low elsewhere in the codebase; the polarity convention is not uniform across the class family.

### src/components/logic/flipflopjk.cpp
- Purpose: Implements the JK flip-flop.
- Key abstractions: `m_dataPins = 2` (J and K).
- Data flow: `calcOutput()` → `m_Q0 = (J && !Q) || (!K && Q)` → `m_nextOutVal = m_Q0 ? 1 : 2`.
- Non-obvious design decisions: `m_Q0` is updated *inside* `calcOutput()`, i.e. the base's state variable is written by the variant, not by the base.
- Edge cases / failure handling: The base calls `calcOutput()` only when the clock allows and no set/reset is asserted, so the toggle happens exactly once per clock edge.
- Surprising: The characteristic equation as written treats the pins as active-*high* J/K, but the Set/Reset pins in the same component are active-*low* — the two conventions coexist in one part.

### src/components/logic/flipfloprs.h
- Purpose: Declares `FlipFlopRS : public FlipFlopBase`.
- Key abstractions: It overrides `voltChanged()` rather than `calcOutput()` — the only variant that does.
- Data flow: `voltChanged()` → `updateClock()` → only when the clock allows, apply set/reset.
- Non-obvious design decisions: The RS flip-flop's S and R are the *clocked* inputs (a clocked RS latch), so the base's arbitration logic does not apply — hence the override.
- Edge cases / failure handling: `remProperty("UseRS")` removes the inherited property, because S/R are mandatory for this part.
- Surprising: This is the only flip-flop in the family where the *data* pins are the set/reset inputs, and the only one that overrides `voltChanged` instead of `calcOutput`.

### src/components/logic/flipfloprs.cpp
- Purpose: Implements the clocked RS flip-flop.
- Key abstractions: `init({...})` declares S, R, Clock and the two outputs.
- Data flow: `voltChanged()` → `updateClock()` → if the clock allows and S or R is asserted, publish `1` (S) or `2` (R).
- Non-obvious design decisions: The base's `m_useRS` machinery is bypassed entirely — this part's S/R are the data inputs, not the base's optional override pins.
- Edge cases / failure handling: Both S and R asserted simultaneously publishes `3` (both bits set), which is the illegal state — the part does not detect or flag it.
- Surprising: An illegal S=R=1 condition produces a physically impossible output (Q and !Q both high) with no warning.

### src/components/logic/flipflopt.h
- Purpose: Declares `FlipFlopT : public FlipFlopBase`.
- Key abstractions: None beyond the base.
- Data flow: `calcOutput()` reads T and the current !Q pin state.
- Non-obvious design decisions: The toggle is implemented by reading the *inverse* output pin (`m_outPin[1]->getOutState()`), not by keeping a counter.
- Edge cases / failure handling: When T is low, `calcOutput()` leaves `m_nextOutVal` unchanged, so the part holds its state.
- Surprising: Because the base only calls `calcOutput()` on an allowed clock edge, and the T variant *writes nothing* when T is low, the hold behaviour falls out of "do not touch the output" rather than from an explicit hold branch.

### src/components/logic/flipflopt.cpp
- Purpose: Implements the T flip-flop.
- Key abstractions: `m_dataPins = 1`.
- Data flow: `calcOutput()` → if T is high, publish the inverse of the current !Q.
- Non-obvious design decisions: There is no explicit "hold" branch — the base's `scheduleOutPuts` mechanism carries the previous value forward when `m_nextOutVal` is not touched.
- Edge cases / failure handling: The Set/Reset pins are still present and still inverted, and still take priority over the clock.
- Surprising: This is the shortest of the four variants — 3 lines of behaviour — and the most elegant.

### src/components/logic/fulladder.h
- Purpose: Declares `FullAdder : public IoComponent, public eElement` — an N-bit ripple adder with carry in and carry out.
- Key abstractions: `m_bits`, `m_ciPin` (carry in), `m_coPin` (carry out), both pulled out of the general input/output arrays so they can be addressed by name.
- Data flow: `voltChanged()` assembles A and B from the pin arrays, adds the carry-in, and publishes the sum with the carry moved to bit 0.
- Non-obvious design decisions: The carry-out is **moved into bit 0 of the same output word** by shifting the sum left — the adder has `1+2*bits` outputs in one word rather than two words.
- Edge cases / failure handling: `setBits()` clamps to a minimum of 1 and relabels the pins as A0..An / B0..Bn / S0..Sn.
- Surprising: `getPin(pinName)` maps the *legacy* names "in0/in1/in2/out0/out1" onto the new pin array — the same file-format-migration idea as `propNotFound`, applied to pin names.

### src/components/logic/fulladder.cpp
- Purpose: Implements the ripple adder.
- Key abstractions: The carry is folded into the output word: `m_nextOutVal = A+B+Ci`, then `Co = val & (1<<bits)`, `val <<= 1`, `val |= Co`.
- Data flow: `voltChanged()` → sum → extract and relocate the carry → `scheduleOutPuts()`.
- Non-obvious design decisions: The bit-relocation trick means the adder's *external* pin order is {S0..Sn, Co} while the internal arithmetic is {Co, S0..Sn} — a deliberate reordering at the boundary.
- Edge cases / failure handling: `stamp()` calls `IoComponent::initState()` and registers callbacks on all inputs.
- Surprising: A 2-bit adder is created with `setBits(2)` but the code always uses `m_inpPin[1+i]` for A and `m_inpPin[1+i+m_bits]` for B — the pin *array* is the source of truth, not the labels.

### src/components/logic/function.h
- Purpose: Declares `Function : public IoComponent, public ScriptBase` — a user-programmable combinational block whose behaviour is an AngelScript program compiled at simulation start.
- Key abstractions: `m_funcList` (one expression per output), `m_voltChanged` (the compiled script function pointer), `m_compiled`, plus a `CustomButton` per output that opens an expression editor.
- Data flow: `stamp()` → `createScript()` generates the source → `compileScript()` → the compiled `voltChanged()` is invoked on every pin change.
- Non-obvious design decisions: The script is *generated* from the component's own pin configuration, so the generated source declares `vi0/i0/vo0/o0` locals matching the current pin count — changing the pin count regenerates the script.
- Edge cases / failure handling: `getInputState`/`setOutputState` bounds-check the pin index and return false/0 out of range.
- Surprising: `setOutputVoltage` reaches into the pin's internals (`m_outPin[pin]->m_nextState = false`) to force a repaint — the component is not fully encapsulated from its pins.

### src/components/logic/function.cpp
- Purpose: Implements the scriptable function block.
- Key abstractions: The AngelScript engine is given a registered object type `Function` with five methods (`getInputState`, `getInputVoltage`, `setOutputState`, `setOutputVoltage`, `getOutputVoltage`) and a global `Function fu` binding.
- Data flow: `createScript()` emits the variable declarations and the body from `m_funcList`; each output's expression is translated (`&`→`&&`, `|`→`||`, `^`→`^^`, spaces removed, lowercased) and emitted either as a voltage assignment (`vo0 = ...`) or a boolean assignment (`o0 = ...`).
- Non-obvious design decisions: The C++-style operators are *rewritten* into AngelScript's (`&&`/`||`/`^^`) rather than requiring the user to type them — the user-facing expression language is deliberately more C-like than the embedded language.
- Edge cases / failure handling: An expression starting with "vo" is treated as a voltage expression; everything else is a boolean. Empty expressions are skipped.
- Surprising: `setFunctions()` powers the circuit off if it is running, because changing the script invalidates the compiled code.

### src/components/logic/gate.h
- Purpose: Declares `Gate : public LogicComponent` — the shared base of AND/OR/XOR/NAND/NOR/XNOR/buffer/inverter.
- Key abstractions: the virtual `calcOutput(int inputs)` — the *count* of high inputs, not the bit pattern — and `m_initState` (the power-on output level).
- Data flow: `voltChanged()` counts the high inputs and calls `calcOutput()`.
- Non-obvious design decisions: Reducing a whole truth table to a function of the *high-input count* is possible because every supported gate is symmetric in its inputs. That single decision collapses six truth tables into six one-liners.
- Edge cases / failure handling: `m_minInputs` prevents the input count dropping below the part's minimum (1 for buffer/inverter, 2 for the real gates).
- Surprising: `calcOutput`'s default (`inputs == m_inpPin.size()`) is already the AND/buffer behaviour, so `Gate` alone is a usable 1-input buffer.

### src/components/logic/gate.cpp
- Purpose: Implements the gate base: counting, the initial-state property, the body geometry and the painting.
- Key abstractions: `m_path` (a `QPainterPath` the subclass rebuilds in `updatePath()`), `outputProps()` which prepends the "Initial High State" property to the shared output property list.
- Data flow: `voltChanged()` → count highs → `calcOutput()` → `m_nextOutVal = out?1:0` → `scheduleOutPuts()`.
- Non-obvious design decisions: The *number* of high inputs is all the gate family needs; the per-family truth table is one comparison.
- Edge cases / failure handling: `propNotFound` maps the retired `Inverted` property onto the output pin's inverted flag.
- Surprising: `Gate::stamp()` sets the output state from `m_initState` — a gate can be defined to power up HIGH, which is what makes flip-flops (which need a known initial state) usable in a simulation that starts from zero.

### src/components/logic/gate_and.h
- Purpose: Declares `AndGate : public Gate`.
- Key abstractions: None beyond the base — no `calcOutput` override at all.
- Data flow: Inherits `Gate::voltChanged()` entirely.
- Non-obvious design decisions: AND is the *default* `calcOutput`, so the class only needs to draw itself. The absence of an override is the implementation.
- Edge cases / failure handling: The `Num_Inputs` property is `propNoCopy`, so duplicating an AND gate does not duplicate its width.
- Surprising: `AndGate` adds `remProperty("Inverted")` — the same call every gate family makes, to drop the inherited invert-output property in favour of right-click pin inversion.

### src/components/logic/gate_and.cpp
- Purpose: Implements the AND gate: symbol geometry, property groups.
- Key abstractions: `updatePath()` builds the flat-backed D shape with two quadratic curves.
- Data flow: Geometry only — the electrical behaviour is the inherited count-based `calcOutput`.
- Non-obvious design decisions: The path is rebuilt from `m_area.height()/2` and `m_area.width()/2`, so the symbol scales with the input count automatically.
- Edge cases / failure handling: `setNumInputs` (inherited) refuses fewer than `m_minInputs = 2`.
- Surprising: The `Invert_Inputs` property is offered on the AND gate but the *output* inversion property is not — inversion is per-pin, not per-part.

### src/components/logic/gate_or.h
- Purpose: Declares `OrGate : public Gate`.
- Key abstractions: Overrides `calcOutput(int)` and `updatePath()`.
- Data flow: `calcOutput(inputs)` returns `inputs > 0`.
- Non-obvious design decisions: A single comparison implements the whole OR truth table because the count is all the information available.
- Edge cases / failure handling: The input-count property is capped by `m_minInputs = 2`.
- Surprising: The property name is `"Num_Inputs"` with unit `"_Inputs"` — a unit suffix that the property system strips and renders as a dropdown.

### src/components/logic/gate_or.cpp
- Purpose: Implements the OR gate.
- Key abstractions: `updatePath()` draws the concave-back OR shape using four quadratic segments.
- Data flow: `calcOutput` → `inputs > 0` → the output word.
- Non-obvious design decisions: The `Num_Inputs` property uses the unit suffix `"_Inputs"`, which the property editor turns into an enumerated spinner rather than a free numeric field.
- Edge cases / failure handling: `remProperty("Inverted")` as everywhere in the family.
- Surprising: The OR gate's shape is drawn with a *concave* left edge via two `quadTo` calls; the AND gate uses a flat one — the visual distinction is entirely in `updatePath`.

### src/components/logic/gate_xor.h
- Purpose: Declares `XorGate : public Gate`.
- Key abstractions: Overrides `calcOutput`, `updatePath` *and* `paint`.
- Data flow: `calcOutput(inputs)` returns `inputs == 1` (parity).
- Non-obvious design decisions: The extra XOR arc is drawn in `paint()` rather than baked into `m_path`, because the arc must not be part of the hit-test shape.
- Edge cases / failure handling: The path is the OR shape; only the painted arc differs.
- Surprising: XOR's `calcOutput` is `inputs == 1`, which is correct for any number of inputs — the count-based abstraction pays off here.

### src/components/logic/gate_xor.cpp
- Purpose: Implements the XOR gate.
- Key abstractions: `paint()` draws `m_path` then a separate quadratic arc for the XOR's extra stroke.
- Data flow: `calcOutput` → `inputs == 1`.
- Non-obvious design decisions: The XOR arc is drawn with `p->setBrush(Qt::NoBrush)` after the main path so it does not fill.
- Edge cases / failure handling: The `Invert_Inputs` property is offered but there is *no* `Num_Inputs` property — XOR's input count is fixed by the base's default of 2.
- Surprising: Unlike AND and OR, XOR does not expose a "Size" property, so an XOR gate in the UI cannot be widened — an inconsistency in the family.

### src/components/logic/i2cram.h
- Purpose: Declares `I2CRam : public IoComponent, public TwiModule, public MemData` — an I2C-attached RAM.
- Key abstractions: `m_ram`, `m_size`, `m_addrPtr`, `m_phase` (a small state machine distinguishing address bytes from data bytes), `m_persistent`.
- Data flow: `voltChanged()` builds the 7-bit device address from the three A0–A2 pins and the base control code, then hands off to the I2C engine.
- Non-obvious design decisions: The device address is *derivable from pins* — the same part with a different strap gives a different I2C address, exactly like real EEPROMs.
- Edge cases / failure handling: `m_addrPtr` wraps modulo `m_size`, so an address past the end of the part wraps rather than faulting.
- Surprising: `m_phase` is 3 at reset and the read/write byte handlers use it to decide whether the next byte is a high address byte, a low address byte, or data — a three-state protocol decoder.

### src/components/logic/i2cram.cpp
- Purpose: Implements the I2C RAM.
- Key abstractions: `startWrite()`/`readByte()`/`writeByte()` override the `TwiModule` hooks.
- Data flow: `startWrite()` sets `m_phase` to 0 (16-bit address) or 1 (8-bit address) depending on the size; `readByte()` walks the phases; `writeByte()` serves `m_ram[m_addrPtr]` and increments.
- Non-obvious design decisions: The address width adapts to the RAM size — a 256-byte part uses a one-byte address, a larger one uses two — and `startWrite()` decides which.
- Edge cases / failure handling: `while (m_addrPtr >= m_size) m_addrPtr -= m_size;` wraps a too-large address into range.
- Surprising: `getMem()` returns an *empty string* when the part is not persistent, so a non-persistent RAM's contents are deliberately not written into the circuit file.

### src/components/logic/i2ctoparallel.h
- Purpose: Declares `I2CToParallel : public IoComponent, public TwiModule` — an I2C-to-8-bit-parallel expander (a PCF8574-style part).
- Key abstractions: `m_portState` (the last known parallel value, used to detect a change), `m_int` (an open-collector interrupt pin).
- Data flow: `voltChanged()` reads the eight output pins, compares against `m_portState`, and pulses the interrupt line on a change.
- Non-obvious design decisions: The output pins are in `openCo` mode with a 100 kΩ pull-up, matching a real I2C expander's port pins.
- Edge cases / failure handling: During a master write the port pins' callbacks are disabled (`startWrite`) so the port does not fight the master.
- Surprising: The interrupt is *level*-triggered with an internal reference (`m_portState`), not edge-triggered — the part re-arms the interrupt when the port returns to its previous value.

### src/components/logic/i2ctoparallel.cpp
- Purpose: Implements the I2C-to-parallel expander.
- Key abstractions: `readByte()` distributes the received byte across the eight output pins and resets the interrupt; `writeByte()` gathers the pin states into the transmit register.
- Data flow: `voltChanged()` → compute `value` from the pins → if changed, pull the interrupt low; if the interrupt is already low and the value matches again, release it → run the I2C engine.
- Non-obvious design decisions: The interrupt line is `openCo` with a pull-up, so "asserted" is a pull-*down* — an active-low open-drain interrupt, as on the real chip.
- Edge cases / failure handling: `changeCallBack(this, false)` is applied to the port pins during a master write and restored afterwards.
- Surprising: The port pins are declared `output` in the component but are *read* back with `getInpState()` — they are bidirectional, and the component uses the input-reading API on its own output pins.

### src/components/logic/latchd.h
- Purpose: Declares `LatchD : public LogicComponent` — an N-bit D latch (level- or edge-triggered).
- Key abstractions: `m_channels`, `m_useReset`/`m_resetPin`, and overrides of `setTristate()` and `setTrigger()` (both of which must resize the symbol).
- Data flow: `voltChanged()` → `updateClock()` → if reset asserted, output 0; else if the clock allows, copy the D inputs into the output word.
- Non-obvious design decisions: The trigger type is a *property* (`m_triggerList`), so a latch can be an Enable-transparent latch or a rising-edge latch.
- Edge cases / failure handling: `setChannels` recomputes the body height and pin positions.
- Surprising: The latch overrides `setTrigger()` — normally a virtual from `eClockedDevice` — purely so it can call `updateSize()` and keep the symbol geometry correct.

### src/components/logic/latchd.cpp
- Purpose: Implements the D latch.
- Key abstractions: `updateSize()` computes the body height from the *number of enabled control pins* (reset, trigger, output-enable), so the symbol grows a row for each visible control.
- Data flow: `voltChanged()` → `updateOutEnabled()` → `updateClock()` → reset overrides → else if `Clock_Allow`, `m_nextOutVal` = OR of the D pins.
- Non-obvious design decisions: The latch's "transparent" behaviour is expressed entirely through the trigger type; with the default `"Enable"` trigger the clock state is `Clock_Allow` whenever the enable is high, which makes it transparent.
- Edge cases / failure handling: `setPinReset(false)` removes the reset connector.
- Surprising: `updateSize()` is called from `setTristate()` too — a *logic* property change reshapes the graphic, which is unusual but keeps the symbol honest.

### src/components/logic/lm555.h
- Purpose: Declares `Lm555 : public Component, public eElement` — the 555 timer, modelled as a real analogue circuit (three resistors, a discharge switch) plus digital threshold/trigger logic.
- Key abstractions: Three `eResistor` members (`m_resA`, `m_resB`, `m_resD`) and four `ePin` members forming the internal RC network; `m_thrEnode` (the control-voltage node); `m_propDelay` (10 ns propagation delay).
- Data flow: `voltChanged()` compares the trigger and threshold voltages against the reference derived from the control node and drives the output state; `runEvent()` commits the output and switches the discharge transistor's resistance.
- Non-obvious design decisions: The 555 is *not* a scripted black box — the timing network is three genuine resistors in the analogue engine, so an external capacitor really does set the frequency.
- Edge cases / failure handling: If the control-voltage pin is unconnected, `initialize()` creates an internal eNode so the divider still works (the classic "floating control pin" problem).
- Surprising: `m_resD.setResistance(m_outState ? high_imp : 1)` — the discharge pin is modelled as a 1 Ω resistor to ground when the output is low and a high impedance when high. The timer is partly a *switch*, not a function.

### src/components/logic/lm555.cpp
- Purpose: Implements the 555 timer.
- Key abstractions: `stamp()` wires the internal ePins to the real pins' eNodes and sets the three resistances (5 kΩ, 10 kΩ, 1 Ω).
- Data flow: `voltChanged()` → read Vcc/Gnd → update the output high/low voltages → compare reset (< 0.7 V resets), trigger (below half the control voltage sets the output) and threshold (above the control voltage clears it) → schedule an event if the state changed → `runEvent()` sets the output and the discharge resistance.
- Non-obvious design decisions: The output high voltage is `Vcc - 1.3` and the low is `Gnd` — the 555's saturation drop is modelled, and the whole thing follows the supply rails rather than fixed 5 V.
- Edge cases / failure handling: The `m_voltPos`/`m_voltNeg` deltas are compared with a 1e-3 hysteresis so supply noise does not cause spurious events.
- Surprising: `initialize()` only creates the fallback threshold eNode `if (Simulator::self()->isRunning())` — constructing a part outside a simulation leaves `m_thrEnode` null and `stamp()` would then dereference it.

### src/components/logic/magnitudecomp.h
- Purpose: Declares `MagnitudeComp : public IoComponent, public eElement` — an N-bit magnitude comparator (A>B, A=B, A<B).
- Key abstractions: `m_bits`; the three comparison inputs are separate pins, the three outputs are separate pins.
- Data flow: `voltChanged()` assembles A and B from the pin arrays and compares them as integers.
- Non-obvious design decisions: The three "cascade" inputs (`iA>B`, `iA=B`, `iA<B`) reproduce the 7485's unusual equal-output behaviour rather than the textbook.
- Edge cases / failure handling: The 7485 quirk is implemented as an explicit remap of `iA` in the equality branch.
- Surprising: The comparator's *equality* output logic is deliberately non-standard: `iA == 0b101` maps to `0b000` and `iA == 0b000` maps to `0b101` — the 7485's cascade inputs are active-low in a way that a naive implementation gets wrong.

### src/components/logic/magnitudecomp.cpp
- Purpose: Implements the magnitude comparator.
- Key abstractions: `setBits(int)` grows the pin arrays and relabels A/B pins.
- Data flow: `voltChanged()` → build `iA` from the three comparison inputs, build A and B from the data pins → compare → publish `0b001` (A>B), `0b100` (A<B) or the remapped `iA` for equality.
- Non-obvious design decisions: The output word packs the three comparison results into one integer with a fixed bit layout (bit 0 = A>B, bit 1 = A=B, bit 2 = A<B).
- Edge cases / failure handling: `stamp()` sets outputs 0 and 2 high ("not greater" and "not less") to match the 7485's idle state.
- Surprising: The equality case is the *only* branch that consults the cascade inputs — for A>B and A<B the cascade inputs are ignored entirely.

### src/components/logic/memory.h
- Purpose: Declares `Memory : public IoComponent, public eElement, public MemData` — a general-purpose RAM/ROM with CS/WE/OE and a configurable address and data width.
- Key abstractions: `m_ram`, `m_addrBits`, `m_dataBits`, `m_dataBytes`, `m_oe`/`m_we`/`m_cs` (the previous control state), `m_asynchro`, `m_persistent`.
- Data flow: `voltChanged()` decides whether the operation is a read or a write and performs it.
- Non-obvious design decisions: The data pins are *bidirectional* — they are set to `input` mode unless an output-enable is active, and the same pins carry the written value during a write. One pin array serves both directions.
- Edge cases / failure handling: `m_asynchro` (synchronous mode) suppresses the operation unless CS or WE actually changed.
- Surprising: `setMem`/`getMem` are the hidden serialisation path for the memory contents, and `getMem()` returns empty unless the part is persistent.

### src/components/logic/memory.cpp
- Purpose: Implements the RAM/ROM.
- Key abstractions: `setAddrBits`/`setDataBits` grow or shrink the pin arrays (`createAddrBits`/`deleteAddrBits`), and `updatePins()` re-lays-out the body.
- Data flow: `voltChanged()` → compute OE (needs CS, !WE and OE) → switch the data pins between input and output mode → if the operation is permitted, decode the address, then read or write.
- Non-obvious design decisions: The **"operate" gate**: `bool operate = m_asynchro || m_cs != cs || m_we != we;` — in synchronous mode the memory only acts when a *control* line changed, not when the address bus changed. That is what makes a synchronous RAM behave like one.
- Edge cases / failure handling: The output pins' `changeCallBack` is re-registered whenever CS or WE changes, so the write data is sampled at the right moment.
- Surprising: `m_ram` is resized to `pow(2, bits)` — a 24-bit address means a 16-million-entry vector of ints. The address width is clamped to 24 bits precisely to bound that.

### src/components/logic/mux.h
- Purpose: Declares `Mux : public LogicComponent` — an 8-to-1 multiplexer with an inverted output.
- Key abstractions: `m_addrBits` (1–3), a custom trapezoidal `shape()`.
- Data flow: `voltChanged()` decodes the address and selects the corresponding data pin.
- Non-obvious design decisions: The mux publishes **two** outputs — Y and !Y — as bits 0 and 1 of one output word, so both are available without a second pin.
- Edge cases / failure handling: `setAddrBits` hides and disconnects the unused data inputs when narrowing the mux.
- Surprising: The data inputs are numbered 0–7 and the address inputs 8–10, so the *data* pins are the low indices — the opposite of the demux.

### src/components/logic/mux.cpp
- Purpose: Implements the multiplexer.
- Key abstractions: `setAddrBits(int)` recomputes the pin visibility, positions and the body.
- Data flow: `voltChanged()` → `updateOutEnabled()` → address from pins 8–10 → `m_nextOutVal = selected ? 1 : 2` (Y or !Y).
- Non-obvious design decisions: The output word encodes Y as bit 0 and !Y as bit 1, so the two outputs are always consistent by construction.
- Edge cases / failure handling: The address bits are clamped to 1..3 and the unused data pins are disconnected rather than merely hidden.
- Surprising: The 8 data inputs are created *before* the `init({...})` block (which adds the three address pins), which is why the address pins have the high indices 8, 9, 10.

### src/components/logic/sevensegment_bcd.h
- Purpose: Declares `SevenSegmentBCD : public BcdBase` — the graphical seven-segment display.
- Key abstractions: `m_showEnablePin`, `m_showDotPin`, `m_dotPin`, `m_enablePin`; overrides `setLinkedTo()`/`setLinkedValue()` so the display can be driven by a *linker* (an interactive value) instead of by pins.
- Data flow: `updateStep()` reads the inputs (or the linked value) into `m_digit`, and `paint()` draws the seven segments from the bit mask.
- Non-obvious design decisions: `m_digit` bit 7 is the decimal point — the segment table and the drawn display share one byte.
- Edge cases / failure handling: When linked, all the input connectors are removed and the display hides itself.
- Surprising: `setLinkedValue(v, 0)` interprets the value as a *digit index into the segment table*, while `setLinkedValue(v, 1)` interprets it as a raw segment bitmask — the same setter has two meanings depending on the index argument.

### src/components/logic/sevensegment_bcd.cpp
- Purpose: Implements the graphical seven-segment display.
- Key abstractions: `paint()` draws each of the seven segments as a line (and bit 7 as a pie for the dot) using `LedBase::getColor()`.
- Data flow: `updateStep()` → if not running, blank the digit; else if the enable pin is high, decode the BCD and optionally OR in the dot bit.
- Non-obvious design decisions: The segment geometry is computed from `m_area` and a margin, so the display scales with the component's size.
- Edge cases / failure handling: `setShowEnablePin(false)` / `setShowDotPin(false)` call `removeConnector()`, so the hidden pins' wires are removed too.
- Surprising: The enable pin is *inverted* (asserted low), yet `updateStep()` tests `m_enablePin->getInpState()` directly — the inversion is applied by the pin's own state machinery, not here.

### src/components/logic/shiftreg.h
- Purpose: Declares `ShiftReg : public LogicComponent` — an N-bit shift register with optional parallel load and bidirectional shifting.
- Key abstractions: `m_bits`, `m_bitMask`, `m_parallelIn`, `m_bidir`, and six separate pins (`m_dinPin`, `m_dilPin`, `m_dirPin`, `m_rstPin`, `m_serPin`) held outside the general input array so they keep stable indices.
- Data flow: `voltChanged()` → reset / parallel load / shift, publishing the new word.
- Non-obvious design decisions: The serial/parallel select pin is *inverted* so that "high = load parallel" is expressed as `!m_serPin->getInpState()`.
- Edge cases / failure handling: `m_nextOutVal &= m_bitMask` after every shift keeps the word within the register width.
- Surprising: The register re-registers the callbacks on *every* data pin whenever the select line changes, so the data bus is only *listened to* while the parallel load is selected.

### src/components/logic/shiftreg.cpp
- Purpose: Implements the shift register.
- Key abstractions: `updatePins()` recomputes the whole layout when bits, parallel-in or bidirectionality change; `m_ldInps` tracks whether the parallel path is currently armed.
- Data flow: `voltChanged()` → reset clears; parallel load ORs the data pins into the word; a rising clock shifts left (inserting `m_dinPin`) or right (inserting `m_dilPin`), with the direction from `m_dirPin` when bidirectional.
- Non-obvious design decisions: The shift direction is chosen by `m_bidir ? m_dirPin->getInpState() : false` — the direction pin is only read when the part is bidirectional, so it cannot affect a unidirectional register.
- Edge cases / failure handling: `setParallelIn(false)` disconnects the select pin and disables every data pin's callback.
- Surprising: `m_area.setHeight(m_area.height() + deltaH*8)` *adds* to the existing height each time `updatePins()` runs — the height grows monotonically with each reconfiguration rather than being recomputed, which looks like a latent bug.

### src/components/meters/ampmeter.h
- Purpose: Declares `Amperimeter : public Meter` — a current meter.
- Key abstractions: None beyond the base.
- Data flow: `updateStep()` reads the meter's current and republishes it.
- Non-obvious design decisions: The ammeter's series resistance is 1 µΩ (`setResistance(1e-6)`), so it is very nearly ideal.
- Edge cases / failure handling: `updateStep()` only repaints when the value actually changed.
- Surprising: The meter also drives its *output* pin with the measured value, so a meter can feed its reading back into the circuit as a signal.

### src/components/meters/ampmeter.cpp
- Purpose: Implements the ammeter.
- Key abstractions: `m_unit = "A"`, `m_dispValue`.
- Data flow: `updateStep()` → `current()` → if changed, `Meter::updateStep()`.
- Non-obvious design decisions: The display text is pre-seeded as `" 0.000\n A"` so the meter shows a sensible value before the first update.
- Edge cases / failure handling: The change test is exact equality on a double, so a meter sitting on a noisy node repaints often — a minor performance smell.
- Surprising: `m_dispValue` is initialised twice (in the constructor and by the base's zeroing) — harmless but redundant.

### src/components/meters/freqmeter.h
- Purpose: Declares `FreqMeter : public Component, public eElement` — a frequency meter measuring a single input node.
- Key abstractions: `m_filter` (a hysteresis threshold in volts), `m_rising`/`m_falling` (edge state), `m_numMax`/`m_lastMax`/`m_totalP`/`m_period` (the period measurement), and an on-canvas `QGraphicsSimpleTextItem` display.
- Data flow: `voltChanged()` tracks the signal's edges; `updateStep()` converts the accumulated period into Hz and renders it.
- Non-obvious design decisions: The frequency is measured from the times of successive *maxima* (with a hysteresis filter to reject noise), not from zero crossings.
- Edge cases / failure handling: If no maximum arrives within `max(2*period, 2*psPerFrame)`, the wave is declared "lost" and the reading drops to 0.
- Surprising: The wave-lost timeout is expressed in *simulation* time via `Simulator::circTime()` and `psPerFrame()` — the meter knows the simulator's frame duration.

### src/components/meters/freqmeter.cpp
- Purpose: Implements the frequency meter.
- Key abstractions: `initialize()` resets all the counters; `updateStep()` does the arithmetic and the unit formatting.
- Data flow: `voltChanged()` → a rise above `+m_filter` or a fall below `-m_filter` marks an edge → at each new maximum the period since the last maximum is accumulated → `updateStep()` computes `1e12/totalP/(numMax-1)` Hz.
- Non-obvious design decisions: The unit selection is a nested cascade (Hz → kHz → MHz → GHz) and the decimal count is chosen from the magnitude — the same display discipline the sibling shard found in `valToUnit`.
- Edge cases / failure handling: The wave-lost check resets the accumulated period, so a duty-cycled signal does not produce a bogus average.
- Surprising: `m_lastData` is updated only when an edge is detected, so a slow drift within the hysteresis band never triggers a measurement — deliberate noise rejection.

### src/components/meters/lachannel.h
- Purpose: Declares `LaChannel : public DataChannel` — one channel of the logic analyzer.
- Key abstractions: `m_busValue`, `m_bitLength`, `m_busNodes` (a map of bit index → eNode for bus channels), `m_analizer`.
- Data flow: `voltChanged()` thresholds the input and appends a reading to the circular buffer; for bus channels it ORs the individual bit nodes into a bus value.
- Non-obvious design decisions: A bus channel reconstructs its value by reading each bit's eNode directly and thresholding it, rather than treating the bus as one analogue node.
- Edge cases / failure handling: `stamp()` re-registers the callbacks on every bus node each time the simulation starts.
- Surprising: The analyzer is a *friend* of `LaChannel` (`friend class LAnalizer`), so the channel reaches into the analyzer's threshold settings directly.

### src/components/meters/lachannel.cpp
- Purpose: Implements a logic-analyzer channel.
- Key abstractions: `addReading(double)` writes into a circular buffer indexed by `m_bufferCounter` with a parallel timestamp buffer.
- Data flow: `voltChanged()` → for a bus, compute the bus value from the bit nodes and store it if it changed; for a scalar, threshold against `thresholdR()`/`thresholdF()` and store 1 or 0, raising the pause conditions on the edges.
- Non-obvious design decisions: Two separate thresholds (rising and falling) give the analyzer a *hysteresis band*, so a noisy edge does not produce two transitions.
- Edge cases / failure handling: The bus path only records a reading when the *value* changes, so a steady bus does not fill the buffer.
- Surprising: The channel supports four "pause conditions" (rising, falling, high, low) and notifies the analyzer of each — the analyzer can be scripted to stop the simulation on a pattern.

### src/components/meters/logicanalizer.h
- Purpose: Declares `LAnalizer : public PlotBase` — the 8-channel logic analyzer.
- Key abstractions: `m_thresholdR`/`m_thresholdF` (the hysteresis band), `m_timePos`, `m_voltDiv`, `m_updtCount` (a trigger-stability counter), `m_laWidget` (the floating window) and `m_dataWidget` (the in-canvas widget).
- Data flow: `updateStep()` polls the channels, resolves the trigger, and updates the display.
- Non-obvious design decisions: The analyzer can attach to a *tunnel* rather than to a pin — `setTunnels()` gives each channel a tunnel name and `updateStep()` resolves it to an eNode when the pin is unconnected. That is how a probe can sit on a named net.
- Edge cases / failure handling: A trigger that has not fired for 20 update cycles falls back to free-running.
- Surprising: The analyzer **exports a VCD-style file** (`dumpData`) with `$var wire N <id> <name> $end` headers — it is a waveform viewer that writes a standard interchange format.

### src/components/meters/logicanalizer.cpp
- Purpose: Implements the logic analyzer.
- Key abstractions: `dumpData(QString fn)` writes the capture; `expand(bool)` moves the display between the canvas and a floating window.
- Data flow: `updateStep()` → resolve the trigger edge → for each channel, resolve the connection (pin or tunnel) → update the display; `dumpData()` walks each channel's circular buffer, merges the samples into a time-ordered multimap and writes `$dumpvars` / `$var` / `$timescale` sections.
- Non-obvious design decisions: The export writes a *scaled* timescale (`gcd*m_timeStep`) and normalises the sample times to that base, so the file is readable by PulseView and similar tools.
- Edge cases / failure handling: The circular buffer is walked from `m_bufferCounter` forward with an explicit wrap, and samples with time 0 are skipped ("Simulation times start at 1 ps").
- Surprising: The exported file uses `$var wire` for *every* channel including scalar ones, and the channel identifiers are the punctuation characters `* " # $ % & ( )` — chosen because they are legal VCD identifier characters.

### src/components/meters/meter.h
- Purpose: Declares `Meter : public Component, public eResistor` — the base of the analog meters.
- Key abstractions: `m_unit`, `m_dispValue`, `m_outPin` (an extra *source* pin that republishes the reading), and a `QGraphicsSimpleTextItem m_display`.
- Data flow: The subclass fills `m_dispValue` in `updateStep()`; the base renders it and drives the output pin.
- Non-obvious design decisions: The meter is an `eResistor` — the ammeter is a near-zero resistance and the voltmeter a near-zero *admittance* (infinite resistance) — so the meter is part of the circuit, not just an observer.
- Edge cases / failure handling: `propNotFound` handles the retired `SwitchPins` property by flipping the meter.
- Surprising: `m_outPin` is a **source** pin: the meter both measures the circuit and injects the measurement back into it.

### src/components/meters/meter.cpp
- Purpose: Implements the meter base: the display, the unit formatting and the output pin.
- Key abstractions: `updateStep()` formats `m_dispValue` into the display text and drives `m_outPin`.
- Data flow: `updateStep()` → scale by 1e12 → `valToUnit()` picks the multiplier and the display shows `" ----"` when the value exceeds 999.
- Non-obvious design decisions: The meter **crashes** (in the engine's sense) when the reading is out of range: `m_crashed = true` makes the component pulse in the canvas's "crashed" colour.
- Edge cases / failure handling: The value is scaled to pico-units before formatting, so a 1 nF reading shows as "1.000 nF"-style text.
- Surprising: `setflip()` mirrors the display text with the component, so a flipped meter reads right way up.

### src/components/meters/oscope.h
- Purpose: Declares `Oscope : public PlotBase` — the 4-channel oscilloscope.
- Key abstractions: per-channel `m_timePos[4]`, `m_voltDiv[4]`, `m_voltPos[4]`, `m_hideCh[4]`; `m_auto` (auto-scale channel); `m_filter`.
- Data flow: `updateStep()` resolves the trigger, computes the display time window and pushes the samples to the display.
- Non-obvious design decisions: The scope has a fifth *ground* pin (`m_pin[4]`) shared by all four channels, so the displayed voltage is measured differentially against it.
- Edge cases / failure handling: When a channel is not connected, the scope resolves a tunnel by name — the same "probe a named net" mechanism as the logic analyzer.
- Surprising: The trigger alignment computation counts whole cycles so that an *even* number of cycles fills the screen and the trigger sits at the centre.

### src/components/meters/oscope.cpp
- Purpose: Implements the oscilloscope.
- Key abstractions: `expand(bool)` moves the display between the canvas and a floating `OscWidget`; `updateStep()` does the trigger maths.
- Data flow: `updateStep()` → get the trigger channel's period → compute `nCycles` (rounded up to an even number) → centre the window on the trigger edge → for each channel resolve the connection → push to the display.
- Non-obvious design decisions: `moveTimePos()` refuses to pan when a trigger is active ("We have a Trigger: Don't Zoom at mouse pos"), so the user cannot desynchronise the view from the trigger.
- Edge cases / failure handling: The channel's ground reference is `m_pin[4]`, and the displayed voltage is `channel - ground`.
- Surprising: `setAutoSC()` selects a channel to be auto-scaled; the auto-scale runs from `OscopeChannel::updateStep()`, which computes the period and sets the time and voltage divisions.

### src/components/meters/oscopechannel.h
- Purpose: Declares `OscopeChannel : public DataChannel` — one oscilloscope channel.
- Key abstractions: `m_maxVal`/`m_minVal`/`m_midVal`/`m_ampli` (the waveform envelope), `m_totalP`/`m_lastMax`/`m_numMax` (the period measurement), `m_freq`, `m_filter`.
- Data flow: `voltChanged()` samples the differential voltage and detects rising/falling edges; `updateStep()` computes the frequency and drives the auto-scale.
- Non-obvious design decisions: The channel detects edges by a *delta* threshold (`m_filter`), not by a voltage level, so the trigger works on any amplitude.
- Edge cases / failure handling: If more than two cycles pass without a proper wave, the max/min envelope is reset ("Trigger lost?").
- Surprising: The frequency is measured from the intervals between successive rising edges *of the filtered signal*, and the "wave lost" check uses `psPerFrame` — the channel is coupled to the simulator's frame rate.

### src/components/meters/oscopechannel.cpp
- Purpose: Implements an oscilloscope channel.
- Key abstractions: `updateValues()` publishes the measured frequency into the data widget.
- Data flow: `voltChanged()` → differential voltage → track min/max → append to the circular buffer → edge detection → period and amplitude → `m_period`, `m_risEdge`.
- Non-obvious design decisions: The channel stores a sample only when the simulation time has changed (`if (m_simTime != simTime)`), so several pin changes within one simulation step collapse into one sample.
- Edge cases / failure handling: The `m_nCycles > 2` branch resets the envelope, and the wave-lost check clears every measurement.
- Surprising: `if (m_freq < 20) voltChanged();` — a low-frequency signal forces an extra sample so that a very slow waveform still appears on screen.

### src/components/meters/probe.h
- Purpose: Declares `Probe : public Component, public eElement` — a voltage probe that can be dropped onto a wire.
- Key abstractions: `m_voltIn`, `m_voltTrig` (the threshold for the red/blue colouring), `m_pauseState` (breakpoint mode), `m_small`.
- Data flow: `updateStep()` reads the voltage; `voltChanged()` implements the breakpoint.
- Non-obvious design decisions: The probe reads the voltage of whatever is *geometrically underneath it* when it is not electrically connected — it inspects `collidingItems()` and looks for a Pin or a ConnectorLine.
- Edge cases / failure handling: In breakpoint mode a state change pauses the whole simulation (`CircuitWidget::pauseCirc()`).
- Surprising: The probe is a *non-invasive* measurement: it does not need to be wired, it just has to overlap the wire.

### src/components/meters/probe.cpp
- Purpose: Implements the probe.
- Key abstractions: `updtPinSize()` recomputes the probe's pin length and position from the rotation.
- Data flow: `updateStep()` → if connected, read the pin voltage; else scan `m_inputPin->collidingItems()` for a Pin (type `UserType+3`) or a ConnectorLine (type `UserType+2`) and read that.
- Non-obvious design decisions: The probe uses the *scene's* collision detection as a measurement bus — a mechanism that would be very hard to reproduce outside a graphics framework, and very easy to copy into any canvas-based tool.
- Edge cases / failure handling: The probe's pin has an impedance of 1e9 so it barely loads the circuit.
- Surprising: The probe rotates in 45° steps and its labels are counter-rotated so they stay upright.

### src/components/meters/voltmeter.h
- Purpose: Declares `Voltmeter : public Meter` — a voltage meter.
- Key abstractions: None beyond the base.
- Data flow: `updateStep()` reads the differential voltage across the two ePins.
- Non-obvious design decisions: The voltmeter is modelled as `setAdmit(cero_doub)` — zero admittance, i.e. an open circuit, which is what a real voltmeter is.
- Edge cases / failure handling: The change test prevents needless repaints.
- Surprising: The ammeter and the voltmeter differ only in how they set their `eResistor` parameters — the base class carries the whole difference.

### src/components/meters/voltmeter.cpp
- Purpose: Implements the voltmeter.
- Key abstractions: `m_unit = "V"`.
- Data flow: `updateStep()` → `m_ePin[0]->getVoltage() - m_ePin[1]->getVoltage()` → republish.
- Non-obvious design decisions: The measurement is differential between the meter's own two ePins rather than relative to ground.
- Edge cases / failure handling: None beyond the base's change test.
- Surprising: The display text is set in the *constructor* (`" 0.000\n V"`) rather than in `updateStep()`, so the base's formatter has to produce a matching shape.

### src/components/micro/dht22.h
- Purpose: Declares `Dht22 : public Component, public eElement` — the DHT11/DHT22 temperature and humidity sensor, speaking a one-wire-ish protocol.
- Key abstractions: `m_temp`, `m_humi`, `m_tempInc`, `m_humiInc` (the on-canvas steppers), `m_data` (the 40-bit payload), `m_bit`/`m_bitStep`/`m_outStep` (the protocol state machine), `m_start` (the minimum host pulse width, which differs between DHT11 and DHT22).
- Data flow: `voltChanged()` watches the host's start pulse; `runEvent()` emits the acknowledgement and then the 40 data bits.
- Non-obvious design decisions: The bit timings are real: a '0' bit is a 27 µs high pulse and a '1' bit is 70 µs, matching the real protocol.
- Edge cases / failure handling: The model differs between DHT11 and DHT22 in the minimum start pulse (18 ms vs 1 ms) and in the temperature range clamp (60 °C vs 80 °C).
- Surprising: The payload is assembled in `calcData()` as a 64-bit word with a checksum byte, and the model property switches the whole encoding.

### src/components/micro/dht22.cpp
- Purpose: Implements the DHT22.
- Key abstractions: `calcData()` packs temperature, humidity and the checksum into `m_data`.
- Data flow: `voltChanged()` → detect the host's low-to-high transition → respond with an 80 µs low + 80 µs high ACK → then send 40 bits, each a 50 µs low followed by a 27 or 70 µs high, timed with `Simulator::addEvent()`.
- Non-obvious design decisions: The bit is transmitted by *scheduling the pin low then high* and letting the event queue measure the widths — the protocol is implemented in simulation time, not wall-clock time.
- Edge cases / failure handling: Negative temperatures set bit 15 of the temperature word (the DHT22's sign convention).
- Surprising: The DHT11's encoding is materially different (integer temperature, one decimal for humidity only) and the class switches between them at runtime.

### src/components/micro/ds1307.h
- Purpose: Declares `DS1307 : public Component, public TwiModule` — the I2C real-time clock with a battery-backed square-wave output.
- Key abstractions: `m_data[64]` (the register array), `m_addrPtr`, `m_phase`, and an `RtClock m_clock` member that owns the actual time.
- Data flow: `readByte()`/`writeByte()` implement the I2C register protocol; `updtTime()`/`updtDate()`/`updtCtrl()` write back into the `RtClock`.
- Non-obvious design decisions: The part delegates the *time keeping* to the reusable `RtClock` element and only does the register protocol itself.
- Edge cases / failure handling: `m_data[7]` holds the control register; the square-wave frequency (1, 4096, 8192 or 32768 Hz) is derived from its low two bits.
- Surprising: `decToBcd`/`bcdToDec` are hand-written arithmetic (`val/10*16 + val%10`) rather than library calls, and the 12-hour mode is handled with an explicit PM bit.

### src/components/micro/ds1307.cpp
- Purpose: Implements the DS1307.
- Key abstractions: `initialize()` sets up the clock and clears the register array.
- Data flow: `writeByte()` serves seconds/minutes/hours/weekday/day/month/year in BCD from the `RtClock`; `readByte()` writes the master's byte into the register array and updates the clock, the date or the control register depending on the address.
- Non-obvious design decisions: The register map is the classic DS1307 layout, and the "square wave" output is delegated to `RtClock::setFreq()` with a frequency derived from the control register.
- Edge cases / failure handling: When "set current time at start" is off, the clock is set to a fixed 2000-01-01 00:00 and the oscillator is marked disabled (`m_data[0] = 1<<7`).
- Surprising: `m_address = m_cCode` with `m_cCode = 0b01101000` — the 7-bit I2C address 0x68, written in binary to match the family's style.

### src/components/micro/ds1621.h
- Purpose: Declares `DS1621 : public IoComponent, public TwiModule` — the I2C digital thermometer with TH/TL alarm registers.
- Key abstractions: `m_convert`, `m_oneShot`, `m_outPol`, `m_command`/`m_writeByte` (the I2C command decoder), `m_tempReg[2]`/`m_ThReg[2]`/`m_TlReg[2]` (the ±0.5 °C two-byte registers), `m_config`.
- Data flow: `readByte()` decodes the master's command; `runEvent()` completes a conversion after 750 ms; `doConvert()` computes the temperature and trips the alarm.
- Non-obvious design decisions: The conversion takes 750 ms of *simulated* time, scheduled with `Simulator::addEvent(750*1e9, this)` — a real 750 ms conversion latency, not an instant result.
- Edge cases / failure handling: The temperature is clamped to [-55, +125] °C, the DS1621's real range.
- Surprising: The temperature register encodes the fractional part in bit 7 of the low byte (0.5 °C steps), and `m_tempSlope`/`m_tempCount` reproduce the part's internal "slope" and "count" registers.

### src/components/micro/ds1621.cpp
- Purpose: Implements the DS1621.
- Key abstractions: `doConvert()` performs the conversion and sets the THF/TLF flags.
- Data flow: `readByte()` → if the command is 0xEE start a conversion, 0x22 stop it, otherwise treat it as a register access; `runEvent()` (750 ms later) sets the DONE bit and recomputes; `writeByte()` serves the selected register.
- Non-obvious design decisions: Starting a conversion *cancels* the pending event (`Simulator::cancelEvents(this)`) and starts a new 750 ms timer — a real timer model.
- Edge cases / failure handling: In continuous mode a new 750 ms event is scheduled from `runEvent()`, so the part converts forever.
- Surprising: `m_thH` sign handling: the 0.5 °C bit is applied as ±0.5 depending on the sign of the threshold, which is how the real part encodes it.

### src/components/micro/ds18b20.h
- Purpose: Declares `Ds18b20 : public Component, public OneWire` — the 1-Wire digital thermometer.
- Key abstractions: an `enum dsCommand_t` of the six 1-Wire function commands, `m_scratchpad[9]`, `m_TH`/`m_TL`/`m_CFG`, `m_resolution` (9–12 bits).
- Data flow: `funCommand(uint8_t)` dispatches the function command; `readByte()` handles the scratchpad write; `updateStep()` pushes a UI-set temperature into the part.
- Non-obvious design decisions: The busy time after a conversion depends on the configured resolution (93.75 ms at 9 bits up to 750 ms at 12 bits), exactly as in the real part.
- Edge cases / failure handling: The scratchpad's 9th byte is a CRC8 over the first eight, recomputed after every write.
- Surprising: `generateROM(0x28)` gives the part a 1-Wire ROM code whose family byte is 0x28 — the part identifies itself on the bus like the real device.

### src/components/micro/ds18b20.cpp
- Purpose: Implements the DS18B20.
- Key abstractions: `convertTemp()` writes the temperature into the scratchpad in two's complement and sets the busy time.
- Data flow: `funCommand(cmd)` → `convertTemp()` / `writeScratchpad()` / `readScratchpad()` / `copyScratchpad()` / `recallE2()` / `readPowerSupply()`; `readByte()` stores an incoming scratchpad byte and recomputes the CRC when the eighth byte lands.
- Non-obvious design decisions: `convertTemp()` sets `m_busyTime = circTime() + busyTime` and moves the 1-Wire state to `W1_BUSY` — the conversion is modelled on the *bus*, not as a side effect.
- Edge cases / failure handling: An unimplemented function command logs a warning and returns the bus to `W1_IDLE` rather than hanging.
- Surprising: `readPowerSupply()` is a no-op with a "not implemented" comment — parasite power is not modelled, and the file says so.

### src/components/micro/esp01.h
- Purpose: Declares `Esp01 : public Component, public UsartModule, public eElement` — an ESP-01 WiFi module with a TCP bridge.
- Key abstractions: `espAction_t` (a deferred-action enum: connect, send, close, uart-reply), `m_tcpSockets` (a map of link id → socket), `m_host`/`m_port`, `m_buffer` (the AT-command accumulator), `m_dataLenght` (a misspelling of "length" that is preserved throughout the class).
- Data flow: `byteReceived()` accumulates the command; `command()` parses it and sets the reply and/or the deferred action; `updateStep()` performs the deferred TCP action.
- Non-obvious design decisions: Real network I/O is performed from the *simulation* (a `QTcpSocket` is created and connected), so the simulated circuit can talk to a real TCP server.
- Edge cases / failure handling: `AT+CIPSTART=` returns early if WiFi was never connected, and the reply defaults to `\r\nERROR\r\n`.
- Surprising: `frameSent()` and `runEvent()` are both used to drip the reply out one byte at a time, so the AT response respects the simulated UART's bit timing rather than appearing instantly.

### src/components/micro/esp01.cpp
- Purpose: Implements the ESP-01 AT-command interpreter and its TCP bridge.
- Key abstractions: `command()` is a long if/else chain over the AT command set.
- Data flow: `byteReceived()` → accumulate into `m_buffer` until `\r\n` → `command()` → set `m_uartReply` and/or `m_action` → `updateStep()` performs the action → `runEvent()`/`frameSent()` emit the reply byte by byte.
- Non-obvious design decisions: `m_action` defers the *side effect* to `updateStep()` so that the simulation's step loop, not the network callback, owns the timing.
- Edge cases / failure handling: Every parameterised AT command checks `param.isEmpty()` before taking each field and returns silently if a field is missing — the parser is defensive about malformed commands.
- Surprising: The command set is a hand-written if/else ladder rather than a table — the AT command grammar is irregular enough that a table did not pay off.

### src/components/micro/ky023.h
- Purpose: Declares `KY023 : public Component, public eElement` — a dual-axis joystick module.
- Key abstractions: `m_joystickW` (a `JoystickWidget`), `m_button` (the push switch), the three output pins `m_vrx`/`m_vry`/`m_sw`.
- Data flow: `updateStep()` reads the joystick position and writes the two analogue voltages.
- Non-obvious design decisions: The joystick position is converted to a voltage by `VIN*pos.x()/1000` — the widget reports a 0–1000 integer.
- Edge cases / failure handling: The push switch is modelled by changing the *output impedance* (`2000` open, `1e-3` closed) rather than by toggling the pin's state.
- Surprising: The switch's "closed" state is represented as a very low output impedance, so the analogue engine sees a real short.

### src/components/micro/ky023.cpp
- Purpose: Implements the joystick module.
- Key abstractions: `onbuttonpressed()`/`onbuttonreleased()` set `m_closed` and `m_changed`.
- Data flow: `updateStep()` → if the switch changed, set the output impedance and state; if the joystick moved, set the two output voltages.
- Non-obvious design decisions: The update is *event-driven* on `m_changed` and on `m_joystickW.changed()`, so a static joystick costs nothing per frame.
- Edge cases / failure handling: `initialize()` is called from the constructor so the widget starts in a known state.
- Surprising: `m_joystickW` is a *member by value* (not a pointer) and is handed to the scene via `Circuit::addWidget(&m_joystickW)` — the widget lives inside the component.

### src/components/micro/ky040.h
- Purpose: Declares `KY040 : public Component, public eElement` — a rotary encoder with a push switch.
- Key abstractions: `m_steps` (detents per rotation), `m_prevDialVal`, `m_delta`, `m_stepDelta` (the time between detents), `m_posA`/`m_posB` (the two quadrature counters), `m_stateA`/`m_stateB`.
- Data flow: `updateStep()` compares the dial value with the previous one and schedules an event; `runEvent()` advances the quadrature counters and updates the CLK and DT outputs.
- Non-obvious design decisions: The encoder is decoded as **quadrature**: two counters 10 positions apart are advanced together, and their threshold crossings generate the two phase outputs.
- Edge cases / failure handling: The dial wraps, so `updateStep()` detects the wrap (`m_prevDialVal > top && val < bot`) and adjusts the previous value before differencing — otherwise every wrap would look like a huge jump.
- Surprising: `m_stepDelta = spf/fabs(dialDelta)` — the time between detents is derived from the simulator's frame time and the number of detents crossed in one frame, so the encoder's rotation rate is expressed in simulation time.

### src/components/micro/ky040.cpp
- Purpose: Implements the rotary encoder.
- Key abstractions: `runEvent()` is the quadrature generator.
- Data flow: `updateStep()` → detect the dial change and its direction → schedule an event at `m_stepDelta` → `runEvent()` → advance `m_posA`/`m_posB` → their threshold crossings set the CLK and DT pins → schedule the next event.
- Non-obvious design decisions: The two quadrature phases are produced by two counters 10 apart out of 20, so their crossings are 90° apart — a genuine quadrature decoder written in eight lines.
- Edge cases / failure handling: Both counters wrap at 19, so the encoder keeps producing valid quadrature indefinitely.
- Surprising: `setLinkedValue(v)` maps a 0–1000 linked value onto the dial's range (`v*m_steps*2*RESOLUTION/1000`), so the encoder can be driven by an external value as well as by the mouse.

### src/components/micro/rtclock.h
- Purpose: Declares `RtClock : public eElement` — a real-time clock and square-wave generator with no pins of its own (the owner supplies the output pin).
- Key abstractions: `m_time`/`m_date` (the current time), `m_freqBase` (32768 Hz), `m_toggle` (the output's divider), `m_halfPeriod`, `m_disabled`/`m_outEnable`/`m_disOut`.
- Data flow: `runEvent()` re-arms itself every half period and counts down to toggle the output or advance the seconds.
- Non-obvious design decisions: The clock is a *self-rearming event source* — `runEvent()` immediately schedules the next tick — so it keeps running for the whole simulation without the simulator polling it.
- Edge cases / failure handling: When disabled, the clock still counts (so the time advances) but the output does not toggle.
- Surprising: `setFreq()` computes `m_toggle = 32768/freq` — the only square-wave frequencies available are divisors of 32768 (1, 4096, 8192, 32768 Hz), which is exactly the DS1307's real menu.

### src/components/micro/rtclock.cpp
- Purpose: Implements the real-time clock.
- Key abstractions: `initialize()` sets the base frequency and schedules the first tick.
- Data flow: `runEvent()` → re-arm → if the toggle counter expired and the output is enabled, schedule the pin's state inversion → if the second counter expired, advance the time and roll the date at midnight.
- Non-obvious design decisions: The output pin is toggled with `scheduleState(!getOutState(), 0)` — the pin's own state is the source of the next state, so there is no separate toggle variable.
- Edge cases / failure handling: The midnight rollover is detected by comparing the time to `QTime(0,0,0)` after `addSecs(1)`.
- Surprising: `initialize()` is called from `DS1307::initialize()` *and* from `RtClock`'s own constructor path; the constructor only sets `m_disabled = true`.

### src/components/micro/sdcard.h
- Purpose: Declares `SdCard : public Component, public SpiModule` — an SD card in SPI mode, backed by a real disk image file.
- Key abstractions: The canned response blobs `d_CSD`, `d_CID`, `d_SCR`, `d_OCR`, `d_COND`, `d_STATUS`, `d_Packet`, `d_CRC`; the CRC helpers `CRC7()` and `CRC16()`; the 512-byte `m_buffer`.
- Data flow: `endTransaction()` decodes the SPI command byte by byte; `command()` dispatches on the command number.
- Non-obvious design decisions: The card's *identity* (CSD, CID, SCR, OCR) is a set of byte arrays baked into the header, and the CSD's capacity field is patched at load time from the real image size.
- Edge cases / failure handling: The idle-state check rejects illegal commands with the R1 "illegal command" bit.
- Surprising: The CSD's size field is computed as `m_diskKb/512 - 1` — a quirk that only works because the image is a whole number of 512-byte blocks.

### src/components/micro/sdcard.cpp
- Purpose: Implements the SD card in SPI mode.
- Key abstractions: `endTransaction()` is a six-state command decoder keyed on `m_rxBytes` (the byte index within the current command).
- Data flow: `endTransaction()` → byte 1 is the command (or a continuation of a data transfer) → bytes 2–5 accumulate the 32-bit argument → byte 6 is the CRC7, verified against `CRC7(m_cmdBuff, 5)` → then `command()` or `appCommand()` runs and the R1 response is queued.
- Non-obvious design decisions: The command decoder uses `m_rxBytes` as the state variable and mixes "command bytes" and "data bytes" in the same switch — the SPI mode's byte-oriented protocol has no framing, so the card counts bytes itself.
- Edge cases / failure handling: The CRC7 mismatch sets R1 bit 3, and the write path verifies a CRC16 over the 512-byte block, returning `0x05` (data accepted) or `0x0B` (CRC error, data rejected).
- Surprising: The card boots with a ten-transaction delay (`m_boot = 10`) before it will use chip-select — a crude model of the card's power-up sequence.

### src/components/micro/serialport.h
- Purpose: Declares `SerialPort : public Component, public UsartModule, public eElement` — a serial port bridged to a real OS serial port.
- Key abstractions: `QSerialPort* m_serial`, `m_portName`, `m_serData` (bytes to send out), `m_uartData` (bytes to send into the circuit), `m_flowControl`.
- Data flow: `byteReceived()` queues an incoming byte; `updateStep()` flushes `m_serData` to the OS; `frameSent()` emits the next queued byte into the simulated UART.
- Non-obvious design decisions: The OS port is *non-blocking*: data is accumulated and drained in the simulation's update step rather than in the Qt signal handler.
- Edge cases / failure handling: The "Open" button on the canvas is checkable and its state reflects whether the port is open; a failed open shows a message box and unchecks the button.
- Surprising: `setFlowControl()` exists but `open()` hard-codes `NoFlowControl` — the property is stored and never applied.

### src/components/micro/serialport.cpp
- Purpose: Implements the serial-port bridge.
- Key abstractions: `open()`/`close()` configure and open the `QSerialPort`.
- Data flow: `readData()` (the Qt readyRead handler) appends to `m_uartData`; `updateStep()` writes `m_serData` to the port and schedules a 1 ps event to start transmitting `m_uartData`; `runEvent()` sends the first byte and `frameSent()` sends the rest.
- Non-obvious design decisions: The byte-by-byte drip (`runEvent` → `frameSent`) respects the simulated UART's timing; the whole payload is not dumped at once.
- Edge cases / failure handling: `m_uartData` and `m_serData` are cleared in `stamp()`, so a restart of the simulation drops any half-transmitted data.
- Surprising: The property dialog offers Baudrate/DataBits/StopBits, but `m_parity` is used in `open()` and is never exposed as a property — it comes from the `UsartModule` base.

### src/components/micro/serialterm.h
- Purpose: Declares `SerialTerm : public Component, public UsartModule, public eElement` — a serial terminal bridged to an on-screen terminal window.
- Key abstractions: `Terminal* m_terminal`, the open/close `CustomButton`, `m_uartData` (bytes queued to the circuit).
- Data flow: `byteReceived()` → `m_terminal->received(byte)`; `sendByteArray()` (the terminal's send signal) → `m_uartData`.
- Non-obvious design decisions: The terminal window is *owned* by the component (`new Terminal(MainWindow::self())`) and closed in the destructor.
- Edge cases / failure handling: `monitorClosed()` and `TerminalClosed()` keep the button's state in sync with the window's.
- Surprising: Unlike `SerialPort`, the terminal's own send path (`sendByte`) appends to the same queue the window's send uses, so both sources feed one FIFO.

### src/components/micro/serialterm.cpp
- Purpose: Implements the serial terminal bridge.
- Key abstractions: `updateStep()` schedules the transmission; `runEvent()` starts it.
- Data flow: `byteReceived()` → print to the serial monitor and to the terminal → `frameSent()` sends the next queued byte.
- Non-obvious design decisions: `slotOpenTerm()` opens the *monitor* (a separate, read-only window) while the *terminal* is the interactive one — two different windows with different roles.
- Edge cases / failure handling: `updateStep()` clears `m_sending` when the queue empties, so the Tx/Rx LEDs in `paint()` show the true state.
- Surprising: `paint()` resets `m_receiving = false` as a side effect of drawing — a state mutation inside a paint function, which is unusual but keeps the LED one-shot.

### src/components/micro/sr04.h
- Purpose: Declares `SR04 : public Component, public eElement` — the HC-SR04 ultrasonic distance sensor.
- Key abstractions: `m_useDial` (slider versus analogue input), `m_distance`, `m_echouS` (the echo pulse width), `m_slider`.
- Data flow: `voltChanged()` watches the trigger pin; `runEvent()` emits the echo pulse.
- Non-obvious design decisions: The distance can be supplied either by an analogue input pin (in volts, standing in for metres) or by a slider, and the trigger/echo timing is computed from the speed of sound.
- Edge cases / failure handling: The echo width is clamped to 116 µs (2 cm) and 38 000 µs (the timeout).
- Surprising: `m_echouS = m_distance*2000/0.344 + 0.5` — the factor 2000/0.344 converts metres to microseconds at 0.344 m/µs, the speed of sound.

### src/components/micro/sr04.cpp
- Purpose: Implements the ultrasonic sensor.
- Key abstractions: `dialChanged(int)` maps the slider value to a distance (`value/250`).
- Data flow: `voltChanged()` → a rising trigger starts the timer, a falling trigger (after at least 10 µs) computes the echo width → `Simulator::addEvent(200 µs)` → `runEvent()` → assert the echo for `m_echouS` → deassert.
- Non-obvious design decisions: The 10 µs minimum trigger width is the real part's minimum trigger pulse, enforced in simulation time.
- Edge cases / failure handling: `setSlider()` powers the circuit off and disconnects the analogue input when the slider takes over.
- Surprising: The distance input pin is labelled `" In v=m"` — volts are used as metres, a unit convention that a beginner will misread unless told.

### src/components/micro/touchpad.h
- Purpose: Declares `TouchPad : public Component, public eElement` — a resistive touchpad modelled as a four-resistor bridge.
- Key abstractions: `m_RxMin`/`m_RxMax`/`m_RyMin`/`m_RyMax` (the resistance ranges), `m_width`/`m_height`, five `eResistor` members and six `ePin` members forming two internal eNodes.
- Data flow: `updateStep()` converts the touch position into four leg resistances and an admittance for the touch resistor.
- Non-obvious design decisions: The touch position is modelled by *changing the resistance values* of the X and Y dividers — the analogue engine then computes the tapped voltage, so the part behaves like a real resistive pad.
- Edge cases / failure handling: The "not touching" case sets both legs to half the range and the touch resistor's admittance to 0.
- Surprising: The `updateStep()` Y-branch tests `if( xPos < 0 )` rather than `yPos < 0` — a copy-paste bug that makes the Y divider behave as if the pad were touched whenever X is touched.

### src/components/micro/touchpad.cpp
- Purpose: Implements the resistive touchpad.
- Key abstractions: `updateSize()` sizes the widget, the proxy and the body rect.
- Data flow: `updateStep()` → read the widget's X and Y → compute `xResA/xResB` and `yResA/yResB` from the min/max ranges → `setResistance()` on the four legs → `setAdmit(tAdmit)` on the touch resistor.
- Non-obvious design decisions: The resistance is distributed linearly across the pad's width: `xResA = RxMin + (RxMax-RxMin)*xPos/m_width`.
- Edge cases / failure handling: The setters refuse values that would invert the range (`min > max` is rejected).
- Surprising: The touchpad draws a *connector-like* shape (`shape()` returns a polygon with a small tab) so the pin area is drawn at the bottom of the pad — the component's hit-test shape includes the connector stub.

### src/components/micro/touchpadwidget.h
- Purpose: Declares `TouchPadWidget : public QWidget` — the raw mouse-capture widget behind the touchpad.
- Key abstractions: `m_xMousePos`/`m_yMousePos` (the pointer position, -1 meaning "not touching").
- Data flow: `mousePressEvent`/`mouseMoveEvent` update the position; `mouseReleaseEvent` resets it.
- Non-obvious design decisions: -1 is the sentinel for "no touch", and `checkValues()` resets when the pointer leaves the widget.
- Edge cases / failure handling: `checkValues()` clamps a drag that leaves the widget back to "not touching".
- Surprising: `mouseMoveEvent` updates the position *without* checking whether a button is down, so simply hovering over the pad reads as a touch.

### src/components/micro/touchpadwidget.cpp
- Purpose: Implements the touch widget's mouse handling.
- Key abstractions: `checkValues()` is the bounds check; `resetValues()` is the clear.
- Data flow: press/move → set the position → `checkValues()` → release → `resetValues()`.
- Non-obvious design decisions: Non-left-button presses are passed to the base implementation rather than ignored.
- Edge cases / failure handling: The cursor is set to a pointing hand to signal interactivity.
- Surprising: `resetValues()` sets both coordinates to -1, and the *X* and *Y* positions are otherwise independent — but the parent reads them as a pair.

### src/components/subcircuits/board.h
- Purpose: Declares `BoardSubc : public SubCircuit` — a board (an Arduino-style host) that other subcircuits can attach to.
- Key abstractions: `m_shields` (the attached shields), `m_parentBoard` (null for a top-level board).
- Data flow: `attachShield()`/`detachShield()` maintain the list; `toString()` serialises the shields *before* the board.
- Non-obvious design decisions: `setLogicSymbol()` is a no-op when shields are attached — a board with shields must stay a board.
- Edge cases / failure handling: The method carries a `/// FIXME` marker, acknowledging the special case is not cleanly implemented.
- Surprising: The board's own serialisation is *nested* inside the shields' — the file order is children-then-parent.

### src/components/subcircuits/board.cpp
- Purpose: Implements the board subcircuit.
- Key abstractions: `m_shields`, `m_parentBoard`.
- Data flow: `toString()` concatenates each shield's `toString()` and then its own.
- Non-obvious design decisions: The board is `m_graphical = true` and `m_isBoard = true` — the board is drawn as a picture, not as a generic body.
- Edge cases / failure handling: `attachShield()` checks for duplicates before appending.
- Surprising: `setLogicSymbol()` returns early if any shield is attached — the presence of a child changes the parent's rendering mode.

### src/components/subcircuits/chip.h
- Purpose: Declares `Chip : public Component, public eElement` — the generic packaged IC, and the base of `SubCircuit`.
- Key abstractions: `m_packageList` (a map of package name → package description), `m_pinMap`, `m_ncPins`, `m_tempPins`, `m_isLS` (logic-symbol mode), `m_backData`/`m_backPixmap` (the body artwork).
- Data flow: `initPackage()` parses a package description and creates/updates the pins.
- Non-obvious design decisions: The package description is *data*, embedded in the circuit file, so adding a new package variant requires no code.
- Edge cases / failure handling: Pins present in the previous package but absent from the new one are hidden, not destroyed.
- Surprising: `getDevice()` parses the device name out of the component's uid (`"atmega328-1"` → `atmega328`), which means the *file* carries the device identity in the item's id.

### src/components/subcircuits/chip.cpp
- Purpose: Implements the generic chip: package parsing, pin creation, background resolution and colour management.
- Key abstractions: `getPackages()` (static) scans a file for `<item itemtype="Package">` blocks; `convertPackage()` migrates the old `.package` XML format to the new `key=value;` format.
- Data flow: `initPackage()` walks the package description line by line: a `Package;` line sets the geometry and colours, a `Pin;` line calls `addNewPin()`.
- Non-obvious design decisions: `addNewPin()` reconciles by pin *id*: if the id is already known it updates the existing pin; a pin typed `nc` is created as an unused pin. The `m_tempPins` list holds the pins of the previous package so they can be hidden if the new package lacks them.
- Edge cases / failure handling: `setBackground()` searches four locations for the image (the circuit folder, the circuit data folder, the subcircuit folder, the user's data folder) and silently does nothing if none has it.
- Surprising: `propNotFound` handles the retired `Logic_Symbol` boolean property by translating it into a *package choice* — the DIP package vs the logic-symbol package. A boolean file format field became a package enumeration.

### src/components/subcircuits/logicsubc.h
- Purpose: Declares `LogicSubc : public SubCircuit` — a subcircuit that behaves as a logic device.
- Key abstractions: the input/output thresholds, the input/output impedances and the three timing parameters (propagation delay, rise time, fall time).
- Data flow: Setting any of these pushes the value down into every child component by rewriting their property strings.
- Non-obvious design decisions: The timing properties are stored in picoseconds internally and exposed in nanoseconds.
- Edge cases / failure handling: The setters are the only place the values are propagated; there is no re-propagation when a child is added later.
- Surprising: The property *captions* are swapped relative to their meaning — `Input_High_V` is captioned "Low to High Threshold" and `Input_Low_V` is captioned "High to Low Threshold".

### src/components/subcircuits/logicsubc.cpp
- Purpose: Implements the logic-subcircuit electrical properties.
- Key abstractions: Each setter loops over `m_compList` and calls `setPropStr()` with the new value.
- Data flow: `setInputHighV(v)` → for every child component → `c->setPropStr("Input_High_V", v + " V")`.
- Non-obvious design decisions: The propagation is by *property-string rewrite*, not by an API call — the children are ordinary components with their own properties, and the block overrides them from outside.
- Edge cases / failure handling: The units are appended to the value string, because the property's own unit field is not used in this path.
- Surprising: The rise/fall time properties are named `Tr_ps`/`Tf_ps` but are exposed in **nanoseconds** — the caption says "ns" while the name says "ps", a unit inconsistency that survives in the file format.

### src/components/subcircuits/module.h
- Purpose: Declares `ModuleSubc : public ShieldSubc` — a plug-in module that attaches to a board.
- Key abstractions: `zVal()`/`setZVal()` (the z-order, which selects the attach target).
- Data flow: `slotAttach()` finds a colliding board and reparents to it.
- Non-obvious design decisions: The module's z-value is *the* selection criterion for which board it lands on.
- Edge cases / failure handling: `setZVal()` clamps to [2, 9].
- Surprising: A module is a *shield* is a *board* is a *subcircuit* — a four-level inheritance chain for what is conceptually one "thing that plugs into a board".

### src/components/subcircuits/module.cpp
- Purpose: Implements the plug-in module.
- Key abstractions: `renameTunnels()` renames the module's tunnels to `m_id + "-" + uid` so they do not collide with other instances.
- Data flow: `slotAttach()` → `collidingItems()` → filter to subcircuits that are boards and are not already this module's children → pick the first board with a lower z-value → `setBoard()` → compute the relative position up the parent chain.
- Non-obvious design decisions: The attach position is accumulated through the whole parent chain (`while (board->parentBoard())`), so a module attached to a shield of a board ends up in the right place.
- Edge cases / failure handling: The circuit is powered off before the reparent.
- Surprising: The attach logic carries a `/// FIXME UNDOREDO: Circuit::self()->saveState();` — the author knew this operation should be undoable and left a marker instead of implementing it.

### src/components/subcircuits/shield.h
- Purpose: Declares `ShieldSubc : public BoardSubc` — an add-on board.
- Key abstractions: `m_boardId` (the host board's uid, persisted so the attachment survives a reload), `m_boardPos`.
- Data flow: `setBoard()` reparents the shield under the board; `connectBoard()` re-establishes the link after a reload.
- Non-obvious design decisions: The attachment is stored as an *id* and re-resolved on load, rather than being re-derived geometrically.
- Edge cases / failure handling: `slotDetach()` reverses everything and returns the shield to the top-level component list.
- Surprising: `setBoard()` calls `Circuit::self()->compList()->removeOne(this)` — attaching a shield *removes it from the circuit's component list*, because it is now a child of the board.

### src/components/subcircuits/shield.cpp
- Purpose: Implements the shield's attach/detach lifecycle.
- Key abstractions: `attachToBoard()` centres the shield on the board and renames its tunnels to `m_boardId + "-" + uid`; `renameTunnels()` restores the `m_id + "-" + uid` naming on detach.
- Data flow: `slotAttach()` → collide → find a board → `setBoard()`; `slotDetach()` → move → unparent → re-add to the component list → rename the tunnels.
- Non-obvious design decisions: The tunnel rename is the mechanism that keeps a shield's internal nets private when it is attached and unique when it is not.
- Edge cases / failure handling: The circuit is powered off before both operations, and the detach carries the same `/// FIXME UNDOREDO` marker as the module.
- Surprising: `connectBoard()` translates the stored board id through `Circuit::origId()` first — the uid changes between the file and the session, so the persisted id has to be remapped.

### src/components/subcircuits/subcircuit.h
- Purpose: Declares `SubCircuit : public Chip` — a circuit that is a component.
- Key abstractions: `m_compList` (the inflated child components), `m_subcTunnels`, `m_pinTunnels` (the child's tunnels and the pins they expose), `m_mainComponents` (the child components whose properties the user may edit), and the static `s_globalDevices`/`s_localDevices` caches.
- Data flow: `construct()` finds the device's file, loads it and inflates it; `loadSubCircuit()` re-creates every child.
- Non-obvious design decisions: The whole child circuit is stored as *text* in the parent's file (`m_data[0] = circuit` in `subcData_t`), and the cache maps a device name to that text — so a subcircuit is a nested document, not a binary blob.
- Edge cases / failure handling: `clearLocalData()` clears the cache of subcircuits that lived in the circuit's own folder.
- Surprising: The static cache is split into *global* (from the library) and *local* (from the circuit folder) devices — the same device name in the two places resolves to the local one.

### src/components/subcircuits/subcircuit.cpp
- Purpose: Implements the subcircuit: device discovery, child inflation, pin exposure and serialisation.
- Key abstractions: `construct()` is a *static factory* that does the file search (four candidate paths: `.sim2` in the circuit folder, `.sim2` in a per-device folder, then the `.sim1` equivalents) and caches the result.
- Data flow: `loadSubCircuit(doc)` parses the embedded document line by line: `Connector` lines re-link pins, every other line creates a child component with a *mangled uid* (`numId + "@" + uid`) and applies its properties.
- Non-obvious design decisions: The uid mangling (`instanceId@originalUid`) is what makes a subcircuit instantiable more than once without its children colliding — and it is visible in the saved file.
- Edge cases / failure handling: A `Connector` whose pins cannot be found logs an explicit "null startPin/endPin" error and continues; the connector is simply not created.
- Surprising: The `toString()` override writes an *extra* element `<mainCompProps MainCompId="..." .../>` carrying the *properties of the main child component* — so a subcircuit's instance data includes the editable properties of one of its children. This is how a single instantiated subcircuit can have a different resistor value from the template.

### src/components/switches/keypad.h
- Purpose: Declares `KeyPad : public Component, public eElement` — a matrix keypad.
- Key abstractions: `m_rows`/`m_cols`, `m_keyLabels` (a string of key legends), `m_buttons` (the `PushBase` children), `m_diodes`, `m_enodes`, and the row/column pin vectors.
- Data flow: `stamp()` wires each button's two terminals to the row and column nodes, optionally through a diode.
- Non-obvious design decisions: The keypad is *composed* of `PushBase` child components rather than being a monolithic part.
- Edge cases / failure handling: `setRows`/`setCols`/`setHasDiodes`/`setDirection` all call `setupButtons()`, which rebuilds the whole matrix.
- Surprising: The diode option exists to prevent **ghosting** — the classic matrix-keypad problem where pressing two keys in the same row reads a third. The part models the fix.

### src/components/switches/keypad.cpp
- Purpose: Implements the keypad.
- Key abstractions: `setupButtons(int newRows, int newCols)` rebuilds the buttons, the diodes and the pins.
- Data flow: `stamp()` → for each cell, get the button's two ePins and (if dioded) the cell's eNode and the diode's two ePins → assign the enodes so the current path is row → button → (diode) → column, with the diode's direction set by `m_direction`.
- Non-obvious design decisions: The diodes are *real* `eDiode` engine elements, so the ghosting prevention is a physical diode in the simulated circuit, not a logic rule.
- Edge cases / failure handling: `initialize()` creates the per-cell eNodes only when diodes are enabled; without diodes the button terminals go straight to the row and column nodes.
- Surprising: The column pins are created inside the *row-0* iteration only (`if (row > 0) continue;` guards the column-pin block) — a compact way of avoiding creating the columns N times.

### src/components/switches/mech_contact.h
- Purpose: Declares `MechContact : public Component, public eElement` — the base for anything with mechanical contacts.
- Key abstractions: `m_switches` (one `eResistor` per contact), `m_numPoles`, `m_numthrows`, `m_nClose` (normally-closed), `m_closed`.
- Data flow: `setSwitch(bool)` sets each contact's admittance.
- Non-obvious design decisions: A closed contact is an `eResistor` with an **admittance of 1e3** (a 1 mΩ conductor), and an open contact has admittance 0 — the contact resistance is in the analogue engine, not a boolean.
- Edge cases / failure handling: `SetupButton()` is the variant used when the part is embedded in another component (the keypad) and hides the part's own graphics.
- Surprising: A double-throw switch models *two* contacts whose admittances are complementary — one closes as the other opens — so the changeover is physically consistent.

### src/components/switches/mech_contact.cpp
- Purpose: Implements the mechanical contact.
- Key abstractions: `SetupSwitches(int poles, int throws)` creates the pins, the ePins and the contact resistors.
- Data flow: `stamp()` → for each pole, connect the pole's ePin to the pin's eNode → `setSwitch(m_nClose)` applies the resting state.
- Non-obvious design decisions: The pin layout is index-arithmetic-heavy: `m_pin[m_pin0/2+i*(1+m_numthrows)]` for the node, `m_pin0+i*m_numthrows*2` for the ePin — because the same base class serves switches (no coil) and relays (four coil pins), which shift every index.
- Edge cases / failure handling: `m_ButHidden` short-circuits `stamp()` for embedded contacts.
- Surprising: `SetupSwitches` deletes and recreates the pins *and* the ePins when the pole/throw count changes — the pin indices are rebuilt from scratch, which is why the arithmetic is so dense.

### src/components/switches/push_base.h
- Purpose: Declares `PushBase : public SwitchBase` — the base of the momentary push button.
- Key abstractions: `onbuttonPressed()`/`onbuttonReleased()` slots and a `keyEvent(QString, bool)` hook.
- Data flow: The button's `pressed`/`released` signals set `m_closed`.
- Non-obvious design decisions: The normally-closed inversion is applied in the *handler* (`if (m_nClose) m_closed = !m_closed;`) rather than in the base's `setSwitch`.
- Edge cases / failure handling: None — the base's `updateStep()` applies the state to the contacts.
- Surprising: `keyEvent` matches on the key *character*, so a push button can be triggered from the keyboard by the same key that a toggle switch uses.

### src/components/switches/push_base.cpp
- Purpose: Implements the push button's input handling.
- Key abstractions: Two lambda connections to the `CustomButton`'s `pressed`/`released` signals.
- Data flow: press → `m_closed = true` (inverted if normally-closed) → `m_button->setChecked(true)` → `m_changed = true` → `update()`.
- Non-obvious design decisions: The button's *visual* checked state is set from the handler as well, so the widget and the contact never disagree.
- Edge cases / failure handling: The key handler routes to the same two methods, so mouse and keyboard are exactly equivalent.
- Surprising: A momentary button uses `setChecked(true)` on press and `setChecked(false)` on release, so the widget's checkable state is used as a transient indicator rather than a latch.

### src/components/switches/push.h
- Purpose: Declares `Push : public PushBase` — the momentary push button component.
- Key abstractions: It overrides `SetupSwitches()` because a push button has no coil pins and therefore a different pin layout.
- Data flow: `stamp()` sets the switch to the normally-closed state.
- Non-obvious design decisions: The push button overrides the *layout* method rather than adding a flag, so the difference between a switch and a relay is entirely in how the pins are indexed.
- Edge cases / failure handling: `stamp()` returns early if `m_ButHidden`.
- Surprising: `Push::SetupSwitches` duplicates most of `MechContact::SetupSwitches` with a different index scheme — the duplication is the cost of the index-arithmetic design.

### src/components/switches/push.cpp
- Purpose: Implements the push button.
- Key abstractions: `SetupSwitches(poles, throws)` builds `poles*throws` contact resistors and twice as many pins.
- Data flow: `stamp()` → `setSwitch(m_nClose)`.
- Non-obvious design decisions: The pins are created in interleaved pole/throw order so the left-side pins are all poles and the right-side pins are all throws.
- Edge cases / failure handling: The circuit is powered off before the layout changes.
- Surprising: The drawing shows a closed switch as a *horizontal* line and an open one as a *slanted* line — the visual convention is inverted from a real knife switch.

### src/components/switches/relay.h
- Purpose: Declares `Relay : public MechContact` — a relay with a coil and contacts.
- Key abstractions: `Inductor* m_inductor` (the coil, owned as a child component), `m_trigCurrent`/`m_relCurrent` (the pick-up and drop-out thresholds), `m_relayOn`.
- Data flow: `voltChanged()` reads the coil current and switches the contacts.
- Non-obvious design decisions: The coil is a *child component* (`new Inductor(...)` with `setParentItem(this)`), and the relay's own pins are the inductor's pins.
- Edge cases / failure handling: `m_trigCurrent` is only accepted when positive.
- Surprising: The relay's hysteresis is real: it picks up above `IOn` and drops out below `IOff` (a *different*, lower threshold) — which is why `voltChanged()` branches on the current state.

### src/components/switches/relay.cpp
- Purpose: Implements the relay.
- Key abstractions: `m_pin0 = 4` — the base class's pin-index offset for the coil, which shifts every contact index.
- Data flow: `voltChanged()` → `indCurrent()` → compare against the trigger or release threshold depending on the current state → `setSwitch(relayOn)`.
- Non-obvious design decisions: The normally-closed inversion is applied *after* the hysteresis decision (`if (m_nClose) relayOn = !relayOn;`), so the physical contact state and the electrical state are kept separate.
- Edge cases / failure handling: `initialize()` creates the internal eNode only while the simulation is running.
- Surprising: The relay's contact resistance and coil are real analogue elements, so a relay in SimulIDE has a genuine pull-in current and a genuine 100 mH coil — the threshold behaviour emerges from the physics rather than being scripted.

### src/components/switches/switch_base.h
- Purpose: Declares `SwitchBase : public MechContact` — the base of the toggling switch.
- Key abstractions: `m_key` (the keyboard shortcut), `m_button` (the `CustomButton`), `m_proxy`, and `m_keyEventConn` (the connection handle for the global key signal).
- Data flow: The base connects to `Circuit::keyEvent` and dispatches to the virtual `keyEvent()`.
- Non-obvious design decisions: The connection handle is *stored* so the destructor can disconnect it — the switch's lifetime is tied to its keyboard subscription.
- Edge cases / failure handling: `setHidden()` also adjusts the body rect and the proxy's stacking flag.
- Surprising: `m_graphical = true` even though a switch is drawn by `MechContact::paint` — the flag controls the label/area behaviour.

### src/components/switches/switch_base.cpp
- Purpose: Implements the toggling switch's shared behaviour.
- Key abstractions: `updateStep()` applies the pending state to the contacts.
- Data flow: `onbuttonclicked()` → `m_closed = m_button->isChecked()` (inverted if normally-closed) → `m_changed = true` → `updateStep()` → `setSwitch(m_closed)`.
- Non-obvious design decisions: The state change is *deferred* to the next `updateStep()` rather than applied immediately, which keeps the electrical change on the simulation's schedule.
- Edge cases / failure handling: `setKey()` unescapes the HTML entities in the key name and truncates it to one character.
- Surprising: `rotateAngle()` also rotates the *proxy widget* by the opposite amount, so the button stays upright relative to the contact drawing.

### src/components/switches/switch.h
- Purpose: Declares `Switch : public SwitchBase` — the toggling SPST/DT switch.
- Key abstractions: `checked()`/`setChecked()` (backed by the button's checked state), and `setLinkedValue()` for external driving.
- Data flow: `stamp()` → `MechContact::stamp()` → `onbuttonclicked()` to apply the resting state.
- Non-obvious design decisions: The "Checked" property is `propHidden`, so it round-trips through the file but is not shown in the property dialog.
- Edge cases / failure handling: `setLinkedValue()` returns early if the state already matches.
- Surprising: `setLinkedValue()` calls `MechContact::setSwitch()` *directly* "instead of waiting for updateStep()" — the external-drive path bypasses the deferral the mouse path uses.

### src/components/switches/switch.cpp
- Purpose: Implements the toggling switch.
- Key abstractions: `keyEvent()` acts on key *release*.
- Data flow: `keyEvent(key, pressed)` → if the key matches and it is a release, toggle the button and call `onbuttonclicked()`.
- Non-obvious design decisions: The switch acts on release rather than press — a deliberate choice so that holding a key does not toggle repeatedly.
- Edge cases / failure handling: `setLinkedValue(v)` inverts the state for a normally-closed switch *before* calling `MechContact::setSwitch()`.
- Surprising: The `Checked` hidden property is what makes a switch's state survive a save/load round trip — the file records the toggle position, not just the wiring.

### src/components/switches/switchdip.h
- Purpose: Declares `SwitchDip : public Component, public eElement` — a bank of DIP switches.
- Key abstractions: `m_size`, `m_state` (a bitmask), `m_exclusive` (only one switch may be on), `m_commonPin` (a shared common terminal), and the button/proxy lists.
- Data flow: `updateStep()` pushes the bitmask onto the pins as an admittance.
- Non-obvious design decisions: The DIP bank is a *single* component with N switch positions, not N switch components — the state is one integer.
- Edge cases / failure handling: `setSize()` grows or shrinks the bank, deleting or creating buttons and pins.
- Surprising: The default state is *all on* (`m_state |= 1<<i` at creation) — a DIP switch bank powers up with every switch closed.

### src/components/switches/switchdip.cpp
- Purpose: Implements the DIP switch bank.
- Key abstractions: `createSwitches(int)`/`deleteSwitches(int)` grow and shrink the bank.
- Data flow: `stamp()` → for each switch, get the two pins' eNodes (sharing the common node if enabled) → cross-assign them with `setEnodeComp()` so the two pins of a switch are each other's partners → `updateStep()` applies the bitmask as an admittance of 1e3 on the closed side.
- Non-obvious design decisions: The switch is modelled by *cross-assigning the enodes* of the two pins (so they are the same node when closed) and by stamping an admittance on the pins — a different mechanism from `MechContact`'s resistor.
- Edge cases / failure handling: `setCommonPin(true)` removes the connectors of the even-indexed pins, because those pins become internal.
- Surprising: `setLinkedValue(v, 0)` sets a *single* switch (by position) while `setLinkedValue(v, 1)` sets the whole bitmask — the same setter with two meanings again, as in the seven-segment display.

---

## Ideas worth stealing

- **A whole gate family collapses into one integer — the COUNT of high inputs — plus a one-line predicate** — `src/components/logic/gate.cpp:59-74` with `src/components/logic/gate.cpp:77-79` and the per-family overrides at `src/components/logic/gate_or.cpp:59` (`inputs > 0`) and `src/components/logic/gate_xor.cpp:57` (`inputs == 1`) — *Why it matters for August:* this is the single most transferable idea in the shard. Every symmetric boolean function collapses to "how many inputs are high, compared to what" — AND is `n == N`, OR is `n > 0`, XOR is `n == 1`, and NAND/NOR/XNOR are the same with one negation. A simulator for logic coursework (or a grader that checks a student's truth table) can therefore implement the entire gate family with one counter and a predicate, instead of a truth table per part. The abstraction also *explains* why the family can have a uniform "initial high state" and a uniform propagation delay: the parts differ only in the predicate.

- **A component's pin list is declared as a compact string DSL, and the symbol layout comes out of the same declaration** — `src/components/logic/flipflopd.cpp:32-44` with the parser at `src/components/iocomponent.cpp:361-443` — the string `"IL01D"` means *Input, Left side, position 1, label "D"*; `"OR02!Q"` means *Output, Right, position 2, label "!Q"*. *Why it matters for August:* this is a declarative component schema in eight characters per pin. A course tool could let a student (or an agent) write a new part's interface as five short strings and get the symbol's geometry for free — no separate layout code, no coordinate arithmetic, and the pin's electrical type, side, position and label all travel together in one token.

- **The saved circuit file IS the property dump, and the property list IS the component's API** — `src/gui/circuitwidget/compbase.cpp:117-135` (`toString()` emits `<item Name="value" .../>` for every property) with the property registry at `src/gui/properties/comproperty.h:10-13` and the groups at `src/gui/circuitwidget/compbase.h:20-21` — *Why it matters for August:* there is no separate "schema" for a component and no separate "documentation": the `ComProperty` list *is* the schema, the serializer and the property dialog. A skill that generates a component from a declarative description should generate the property list first and derive the file format, the UI and the docs from it. The two flags (`propNoCopy`, `groupNoCopy`, `groupHidden`) already answer the questions a schema needs: which fields are identity, which are configuration, which are internal.

- **A retired property name is handled by the component that used to own it, not by a migration table** — `src/components/logic/flipflopbase.cpp:45-60` (`propNotFound`), `src/components/logic/counter.cpp:74-90`, `src/components/logic/gate.cpp:29-35`, `src/components/subcircuits/chip.cpp:81-99`, with the dispatch at `src/gui/circuitwidget/compbase.cpp:100-109` — *Why it matters for August:* when a saved file names a property the component no longer has, the component is *asked* what to do about it and may claim it. `chip.cpp` shows the pattern at its most interesting: the old boolean `Logic_Symbol` is translated into a *package choice* ("pick the DIP package or the logic-symbol package"), so a boolean field of the file format became an enumeration in the live model. For an August skill with a persisted file format, this is the alternative to a version table: let the thing that changed decide how to read the old form.

- **A named net is a global registry, and the recursion that spreads it carries an explicit re-entrancy guard** — `src/components/connectors/tunnel.cpp:24` (the static `QMap<QString, QList<Tunnel*>*> m_tunnels`) and `src/components/connectors/tunnel.cpp:86-108` (`setEnode`/`registerEnode` with the `m_blocked` flag) — *Why it matters for August:* the guard is set on the instance doing the propagating and cleared after, which is what makes a cyclic tunnel group terminate rather than loop forever. A tool that lets a student name a wire and then connects every wire of that name has exactly this failure mode, and the two-line flag is the whole fix. The same file also shows the naming hygiene that such a registry needs: the name arrives HTML-entity-escaped from the file and is decoded before it is used as a key (`tunnel.cpp:117-120`).

- **A probe can read a wire it is not connected to, by asking the scene what is underneath it** — `src/components/meters/probe.cpp:92-113` — the probe checks whether its own pin is connected; if not, it walks `m_inputPin->collidingItems()` looking for a `Pin` (type `UserType+3`) or a `ConnectorLine` (type `UserType+2`) and reads that voltage. *Why it matters for August:* non-invasive measurement is what makes a probe usable in a teaching tool — a student can drop a probe on a wire without rewiring the circuit, and the tool can show a live voltage. Any canvas-based editor that wants this needs a geometric fallback to the electrical one, and this is the minimal version of that idea.

- **A meter is both a sensor and a source: it measures the circuit and injects the reading back into it** — `src/components/meters/meter.cpp:33` (the meter's third pin is a `source` pin) and `src/components/meters/meter.cpp:81-82` (the base publishes `m_dispValue` on it) — *Why it matters for August:* the meter is an ordinary circuit participant, not a special UI overlay. That is what allows a meter to be wired to a comparator or fed into a subcircuit. For a course tool this is the difference between "a number in a panel" and "a measurement you can build on".

- **The 555 timer is not a scripted behaviour — it is three real resistors in the analogue engine, plus comparators** — `src/components/logic/lm555.cpp:89-96` (the internal eResistor wiring) and `src/components/logic/lm555.cpp:124-126` (the 5 kΩ / 10 kΩ / 1 Ω values), with the discharge pin modelled as a switchable resistor at `src/components/logic/lm555.cpp:185` (`m_resD.setResistance(m_outState ? high_imp : 1)`) — *Why it matters for August:* the *behavioural* part (the threshold/trigger comparison) is a dozen lines, but the *timing* part is delegated to the solver. A tool that wants to teach "why is this oscillator 1 kHz" should let the user change R and C and let the physics answer, rather than hard-coding the frequency. The same file shows the honest fallback: an unconnected control-voltage pin gets a synthesised internal node so the divider still works (`lm555.cpp:110-111`).

- **A part that changes its own interface while the circuit runs powers the circuit off first — and the check is repeated at every one of the 25 sites in this shard alone** — `src/components/logic/memory.cpp:238` and `src/components/logic/memory.cpp:273` (`setAddrBits`/`setDataBits` change the pin count), `src/components/logic/mux.cpp:121` (the address size), `src/components/connectors/tunnel.cpp:123` (renaming a net) — the idiom is `if (Simulator::self()->isRunning()) CircuitWidget::self()->powerCircOff();`. *Why it matters for August:* a parameter that changes the *shape* of a part (its pin count, its net names, its topology) is not a value change — it is a document change. Any August tool that lets an agent tune a running artefact needs this same dichotomy: values may change live, shape may not. The repetition is the cost, but the repetition is also what makes the rule impossible to miss.

- **The protocol components are state machines written in simulation time, not wall-clock time** — `src/components/micro/dht22.cpp:138-176` (the DHT22's 40-bit frame: a 50 µs low, then 27 µs or 70 µs high per bit, each scheduled with `Simulator::addEvent`) and `src/components/micro/sdcard.cpp:111-187` (the SD card's six-state byte counter) — *Why it matters for August:* a teacher can *see* the protocol. If the tool's clock is the simulator's clock, a student can single-step a DHT22 read and watch the bit timings. The DHT22's payload is even assembled with a checksum byte in the real layout (`dht22.cpp:178-204`), so a class exercise can be "find the bug in this sensor's checksum".

- **A decoder's output word packs mutually exclusive results into fixed bits, so the outputs cannot disagree** — `src/components/logic/bcdtodec.cpp:87` (`m_nextOutVal = 1<<dec`, one-hot) and `src/components/logic/mux.cpp:102` (`m_nextOutVal = out? 1:2`, Y and !Y in one word) and `src/components/logic/flipflopbase.cpp:97` (`(set?1:0)+(reset?2:0)`, Q and !Q in one word) — *Why it matters for August:* representing complementary or exclusive outputs in *one* integer removes a class of bug (the two outputs drifting apart) and removes a class of pin (one bus instead of N). A tool that models a chip should prefer a packed word for mutually-constrained outputs, and should document the bit layout next to the code that produces it.

- **A subcircuit instance is stored as a nested *document*, and its per-instance overrides are saved as a separate element** — `src/components/subcircuits/subcircuit.cpp:175-303` (`loadSubCircuit()` re-inflates the child circuit, mangling each child's uid to `instanceId@originalUid`) and `src/components/subcircuits/subcircuit.cpp:485-514` (`toString()` writes `<mainCompProps MainCompId="..." .../>` with the main child's properties) — *Why it matters for August:* this is how a hierarchical circuit gets *parameters*: the template holds the structure, the instance holds the deltas. A course tool that wants a reusable "half-adder" block with a student-chosen resistor value needs exactly this split — and the uid mangling is the mechanism that lets one template be instantiated twice without its children colliding.

- **A whole logic family gets its electrical contract pushed down into its children by rewriting their property strings** — `src/components/subcircuits/logicsubc.cpp:65-126` (each setter loops over the children calling `setPropStr("Input_High_V", ...)`; the first is at `:69`) — *Why it matters for August:* one knob on a block sets the threshold for every gate inside it. This is the standard "envelope" pattern for hierarchical models, and the implementation detail worth stealing is the *mechanism* — the parent's property is authoritative and it writes the children's properties rather than each child consulting a parent.

- **A display or a switch can be driven from outside the circuit through one setter whose meaning depends on an index argument** — `src/components/logic/sevensegment_bcd.cpp:132-140` (index 0 = a digit index into the segment table, index 1 = a raw segment bitmask) and `src/components/switches/switchdip.cpp:257-262` (index 0 = set one switch by position, index 1 = set the whole bitmask) — *Why it matters for August:* this is the "linker" mechanism (`src/components/linker.cpp:114-117` fans a value out to every linked component), and it is the seam between a live circuit and an external driver — a knob, a script, a test harness, or an agent. An August course tool needs exactly this seam, and the two-tier meaning (a *value* plus a *channel index*) is the shape to copy.

- **A whole register family is written as one base plus a one-line variant, and the base's arbitration order is fixed** — `src/components/logic/flipflopbase.cpp:90-101` (set/reset beat the clock, and the clock beats the data) with the four variants at `src/components/logic/flipflopd.cpp:54-57` (one line), `src/components/logic/flipflopt.cpp:54-57` (one line), `src/components/logic/flipflopjk.cpp:56-64` (three lines) — *Why it matters for August:* the D and T flip-flops differ by a single expression, and the JK by three. A simulator for a digital-logic course could implement the whole family with one template and a characteristic equation each — and the base's arbitration order (async override > clock enable > data) is the part students must understand, so it is worth having it in exactly one place.

- **The clock edge is re-derived from the pin state on every callback, not delivered as an event** — `src/components/logic/flipflopbase.cpp:92` (the comment says it plainly: *"Update Clk to don't miss any clock changes"*) with the state machine at `src/simulator/elements/e-clocked_device.cpp:47-67` — *Why it matters for August:* the clocked part does not trust the *ordering* of callbacks. When several pins change in the same instant, an edge delivered as an event can be lost or double-counted; re-deriving the edge from (current pin state, previous pin state) on every callback cannot be. Any event-driven simulator an August harness builds should adopt this: the trigger is a *state comparison*, not a *notification*.

- **A frequency meter's "wave lost" timeout is expressed in simulation time and knows the simulator's frame duration** — `src/components/meters/freqmeter.cpp:88-104` (`lost = max(m_period*2, psPerFrame*2)`) and the same pattern at `src/components/meters/oscopechannel.cpp:102-118` — *Why it matters for August:* a measurement that has no signal is not "zero", it is "no measurement". Both the frequency meter and the oscilloscope channel distinguish the two, and they do it by comparing against the frame time so that the timeout is meaningful at any zoom level. A tool that reports a frequency, a duty cycle or a latency should say "no signal" rather than print 0.

- **The logic analyzer exports a standard waveform interchange format, including the timescale normalisation** — `src/components/meters/logicanalizer.cpp:322-415` (`dumpData()` writes `$timescale`, `$var wire N id name $end` and `$dumpvars`) and the gcd helper at `src/components/meters/logicanalizer.cpp:417-427` — *Why it matters for August:* the export is not a proprietary file — it is a format another tool opens. A course skill should emit something a student can open in an external waveform viewer and *also* open in the tool itself. The gcd normalisation is the detail worth copying: without it the exported timestamps are enormous and the receiving tool has to guess.

- **A rotary encoder is decoded as true quadrature by keeping two counters a quarter period apart** — `src/components/micro/ky040.cpp:153-175` — *Why it matters for August:* the encoder's two phase outputs come from two counters that are 10 apart out of 20, so their threshold crossings are 90° apart by construction. The same file shows the input-side detail that matters just as much: the dial's wrap-around is detected and compensated before differencing (`ky040.cpp:130-133`), because a wrap would otherwise look like a huge jump.

- **A component that owns child components (a keypad of push buttons, a relay's inductor) is a *composition*, and the children are real parts** — `src/components/switches/keypad.cpp:131-208` (the keypad builds `PushBase` children and `eDiode` children) and `src/components/switches/relay.cpp:42-52` (the relay owns an `Inductor` child and its pins *are* the inductor's pins) — *Why it matters for August:* composition over configuration is what makes a part library extensible. A keypad that is a matrix of buttons and diodes is a different part from a bag of buttons; a relay whose coil is a real inductor can have a real pull-in current. The cost is the index arithmetic in `MechContact::SetupSwitches`, and the payoff is a library where the interesting parts are built from the simple ones.

---

## Files skipped (with reasons)

None. All 144 files in the shard were opened and read in full. The largest file in the shard is `src/components/micro/sdcard.cpp` (436 lines, read in full) and the largest header is `src/components/subcircuits/chip.h` (137 lines); nothing was too large to read line by line, and nothing is generated, vendored or binary.

---

## Uncertainties

- **The `LogicComponent::m_triggerList` content and the meaning of `Clock_Allow == Clock_Rising`.** `src/simulator/elements/e-clocked_device.h:11-17` gives `Clock_Low = 0, Clock_Rising=1, Clock_Allow=1, Clock_High, Clock_Falling` — `Clock_Allow` and `Clock_Rising` share the value 1. I could not establish whether that is a deliberate alias (so that `m_clkState == Clock_Rising` and `m_clkState == Clock_Allow` are *different* tests on the same value) or a bug. Reading the uses, `flipflopbase.cpp:98` tests `m_clkState == Clock_Allow` to decide "the clock is not blocking" while `counter.cpp:104` tests `m_clkState == Clock_Rising` to detect the edge, and the two are used in different roles, so I read it as an intentional overlap that works only because the tests are for different purposes. I did not trace every use of `m_clkState` in the tree. The list of trigger names behind `LogicComponent::m_triggerList` (declared at `src/components/logiccomponent.h:41`) is in a file this shard does not own, so I could not enumerate the exact strings the property editor offers.
- **The exact semantics of `Meter::m_crashed`.** `src/components/meters/meter.cpp:74-77` sets `m_crashed = true` when the reading exceeds 999 and `paintSelected` (`src/components/component.cpp`) uses `m_crashed` to pulse the component's colour. Whether `m_crashed` has any effect *outside* painting (does it stop the simulation? does it appear in a report?) I could not establish from this shard; `Component::m_crashed` is set here but its consumers are outside the shard.
- **Whether `DynamicMemory::m_refreshError` is ever surfaced.** `src/components/logic/dynamic_memory.cpp:176-178` sets the flag when a row is not refreshed in time, but the reporting line is commented out and `updateStep()` (`:140-145`) only refreshes the memory table. I searched the shard and found no reader of `m_refreshError`; whether anything outside the shard reads it I did not check.
- **The `TouchPad::updateStep()` Y-branch bug.** `src/components/micro/touchpad.cpp:179` tests `if( xPos < 0 )` inside the block that computes the *Y* resistances (`:174-190`), where `yPos` is the relevant value. This looks like a copy-paste error from the X branch (`:155-173`). I have not run the code, so I report it as a strong suspicion rather than an observed defect; note that the two branches also write to the same `m_resTouch` admittance, so the X branch's value would win when X is touched.
- **The `ShiftReg::updatePins()` height accumulation.** `src/components/logic/shiftreg.cpp:238` does `m_area.setHeight( m_area.height()+deltaH*8 )` — adding to the current height rather than computing it — so repeated calls would grow the body. I could not determine whether `updatePins()` is always called after a full re-layout (which would reset `m_area` elsewhere) or whether this accumulates in practice; `setBits`/`setParallelIn`/`setBidirectional` all call it.
- **`Esp01`'s `m_dataLenght` spelling and the `frameSent`/`runEvent` split.** The misspelling is consistent across the class so I could not tell whether it mirrors an upstream convention. More substantively, I could not establish whether the byte-by-byte reply path respects the simulated baud rate or merely the 1 ps event spacing — the `Simulator::addEvent(1, this)` calls are in picoseconds, and I did not read `UsartModule::sendByte` (outside the shard) to see how it converts that into a bit time.
- **The `SD1621`/`DS1621` `m_config` bit semantics.** `src/components/micro/ds1621.cpp:145` sets `m_config |= 1<<7` for DONE and `:257`/`:261` set bits 6 and 5 for THF and TLF; the file does not document the full control-register layout, and I did not cross-check it against the DS1621 datasheet.
- **The `SubCircuit` cache's invalidation policy.** `src/components/subcircuits/subcircuit.cpp:33-34` splits the device cache into a global map and a local map, and `clearLocalData()` exists to clear the local one; I could not establish *when* `clearLocalData()` is called (it is not called from anywhere in this shard) or what invalidates the global map when the user edits a subcircuit's file on disk. The practical consequence — that editing a `.sim2` on disk may not be picked up until restart — is an inference from the code I read, not an observed behaviour.
- **Whether the `Function` component's generated script is sandboxed.** `src/components/logic/function.cpp:51-75` registers the component's methods with the AngelScript engine and `src/components/logic/function.cpp:179-233` generates the script text from user-entered expressions. The generated code only ever calls the registered `fu.*` methods, but I did not read the AngelScript configuration in `ScriptBase` (outside this shard) to confirm that no other API is reachable from a user expression.
- **Cross-shard context I read but did not own.** To describe the component/plugin model, the property system and the file format accurately I read `src/gui/componentlist/itemlibrary.h` and `itemlibrary.cpp` (the `LibraryItem` shape and the hand-written `addItem` list), `src/gui/circuitwidget/compbase.{h,cpp}` (the property groups, `setPropStr`, `propNotFound` dispatch and `toString()`), `src/gui/properties/comproperty.h` and `src/gui/properties/proputils.cpp` (the property flags and the two parsers), `src/components/iocomponent.cpp:361-443` (the `init()` pin DSL), `src/simulator/elements/e-clocked_device.{h,cpp}` (the trigger state machine), `src/microsim/modules/script/scriptbase.h` (the AngelScript base), and `src/gui/circuitwidget/circuit.cpp:200-280,660-750` (the circuit-file reader and the undo stack). Those files belong to other shards and are not reported here; I cite them only where the cross-shard mechanism is the substance of an idea, and the claims about them are limited to the lines named.

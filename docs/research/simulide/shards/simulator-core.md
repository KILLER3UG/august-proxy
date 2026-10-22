# simulide / simulator-core

## Shard shape

This shard is the electrical-engineering engine of SimulIDE: the 30 files under `src/simulator/` that implement the analogue simulation core, with no GUI, no microcontroller core and no compiler. The centre of gravity is `Simulator` (`src/simulator/simulator.cpp`), a QObject singleton that owns exactly three things — a time-ordered queue of scheduled component events, a Modified-Nodal-Analysis matrix (`CircMatrix`), and the registries of elements, nodes, updatables and sockets that make up a running circuit. Around it sit three small base classes that *are* the extension model: `eElement` (the four-hook contract — `initialize` / `stamp` / `runEvent` / `voltChanged`), `eNode` (a net: the pins attached to it, the admittances stamped into it, the elements to notify when its voltage moves) and `ePin` (the bridge between a GUI pin and a net). The element family is layered by *physics* rather than by device: `eResistor` is the conductive base, `eReactive` (capacitors/inductors) and `eDiode`/`eLed`/`eJfet`/`eMosfet` refine it, and `eBJT` and `eClockedDevice` sit directly on `eElement` because a transistor needs three junctions in both directions (six internal pins) and a clocked device needs an edge detector — neither fits the two-pin resistor shape. `AnalogClock` is the only engine-owned element and is the periodic event source that drives the reactive elements, so it effectively *is* the simulation's time step. The engine holds **no persistent netlist**: at every start, `Simulator::createNodes()` rebuilds the whole set of simulation nodes from the editor's pin map (`src/simulator/simulator.cpp:354-390`), which means the `.circuit` file is the only source of truth and the engine is a pure function of editor state — a headless driver that can produce a pin map can therefore simulate. The two non-obvious load-bearing facts of the whole shard are (a) the *ordering* of the start sequence — node numbers are assigned, then `eNode::initialize()` wipes the connection lists, then `stamp()` re-creates them, because `Connection` captures its peer's node number at construction (`src/simulator/e-node.h:71-73`) and a number of `-1` would silently produce a matrix with no off-diagonals; and (b) the fact that the element *is* the event record: `eElement` carries `nextEvent`/`eventTime` and the event queue is a sorted singly-linked list threaded through the elements themselves, so scheduling a component is allocation-free.

## Per-file notes

### src/simulator/simulator.h
- Purpose: the engine's public surface — state enum, event queue head, matrix handle, the four registries, and all timing/throughput knobs.
- Key abstractions: `simState_t` (STOPPED/ERROR/STARTING/PAUSED/WAITING/RUNNING/DEBUG — note ERROR sits *below* STARTING, so an errored sim reports "not running"); three intrusive work lists (`m_changedNode`, `m_voltChanged`, `m_nonLinear`); `QFuture<void> m_CircuitFuture` for the worker thread; `AnalogClock m_analogClock` as a by-value member.
- Data flow: GUI timer → `timerEvent` → spawn `runCircuit` on a thread → event queue drains → `solveCircuit` → node voltages → GUI repaint.
- Non-obvious design decisions: the "Accelerate calls from eNode" inline pushers (`simulator.h:109-111`) reuse `eElement::nextChanged` as a *second* intrusive link so enqueueing a node or element costs zero allocations and no `QList` churn; `m_state` is declared `volatile` (`simulator.h:150`) precisely because the solver thread reads it.
- Edge cases / failure handling: `notCorverged()` (`simulator.h:89`) is the single one-line door every non-linear element uses to say "not yet"; `isRunning()` is `m_state >= SIM_STARTING`, so SIM_ERROR and SIM_STOPPED both read as stopped.
- Surprising: the class has `Q_OBJECT` and a `timerEvent` override but **no slots at all** — the simulation is driven entirely by a `QTimer` firing `timerEvent`, which then hands the work to a `QFuture`.

### src/simulator/simulator.cpp
- Purpose: the engine implementation — event loop, MNA solve orchestration, node construction, start/stop/pause, and the event queue itself.
- Key abstractions: `addEventAt` (absolute) vs `addEvent` (relative to `m_circTime`, `simulator.h:47`); `solveCircuit()` as the convergence loop; `createNodes()` as the editor→engine bridge.
- Data flow: `startSim` → `resetSim` → `createNodes` (build eNodes from `Circuit::self()->m_pinMap`) → element `initialize()` → node `initialize()` (assigns node numbers) → element `stamp()` → `m_matrix->createMatrix` → `timerEvent` → `QtConcurrent::run(runCircuit)` → events fire `runEvent()` → `solveCircuit()` → `m_matrix->solveMatrix()` sets node voltages → `eNode::setVolt` fans out to the changed and non-linear lists.
- Non-obvious design decisions: the event queue is a **sorted singly-linked list of the elements themselves** (`simulator.cpp:536-565`) — the element's own `eventTime` doubles as the "already scheduled" flag, so a double-schedule is *refused* with warning 200 rather than corrupting the list (`simulator.cpp:530-534`); the old `runCircuit` is preserved verbatim as a comment block immediately above the live one (`simulator.cpp:201-239`), which is the clearest statement in the repo of what changed and why.
- Edge cases / failure handling: `m_maxNlstp` (default 100 000) caps the non-linear iteration count; exceeding it raises "NonLinear Not Converging" and abandons the solve (`simulator.cpp:306`); the state dropping below SIM_RUNNING mid-solve breaks the loop without converging (`simulator.cpp:307`, `319`); `luSolve`'s "matrix diagonal = 0" warning is **commented out** (`simulator.cpp:71-72`), so a singular matrix is silently tolerated.
- Surprising: the GUI thread never blocks on the solver — it stops the future, waits for it, and only then launches the next frame (`simulator.cpp:126-133`, `147-148`); the engine's "real speed" and "simulation load" readouts are *measured* every second from the same clock (`simulator.cpp:139-143`, `183-196`), not assumed.

### src/simulator/circmatrix.h
- Purpose: the MNA matrix — dense coefficient matrix plus right-hand-side vector, partitioned into connected groups.
- Key abstractions: `dp_matrix_t` (vector of `double*` pointing *into* the dense matrix) vs `d_matrix_t` (the factored local copy) — the pointer matrix lets stamping write directly into the global storage while factorization works on a private copy; per-group `m_admitChanged` / `m_currChanged` dirty bits.
- Data flow: `createMatrix(eNodeList)` → `analyze()` → `stampDiagonal` / `stampMatrix` / `stampCoef` write into `m_circMatrix` / `m_coefVect` → `solveMatrix()` factors + solves per dirty group → `eNode::setVolt`.
- Non-obvious design decisions: the matrix is allocated **dense** (`numEnodes × numEnodes` doubles, `circmatrix.cpp:30`) even though only the connected groups are ever solved — the memory is spent to buy a flat, cache-friendly, index-addressable store that the pointer view can carve up.
- Edge cases / failure handling: `stampDiagonal` and `stampCoef` take a `group` argument that is used *only* to set the dirty bit; the real index is the node number.
- Surprising: `m_eNodeList` is a **pointer to the caller's `QList`** (`circmatrix.h:51`, assigned at `circmatrix.cpp:24`) — the matrix holds a non-owning view of a container owned by the Simulator; and the comments on `stampDiagonal`/`stampMatrix` ("eNode numbers start at 1", `circmatrix.h:31`, `circmatrix.h:34`) are **stale** — node numbers start at 0 (`simulator.cpp:418`).

### src/simulator/circmatrix.cpp
- Purpose: the MNA solver — connected-component analysis, Crout LU factorization, forward/back substitution.
- Key abstractions: `analyze()` + recursive `addConnections()` perform a DFS over the eNode connection graph to split the circuit into independent groups; `factorMatrix` is Crout's method, `luSolve` does the substitution.
- Data flow: `createMatrix` → `analyze` assigns each eNode a `nodeGroup` and a `nodeNum` → `solveMatrix` loops the groups, skipping clean ones, factoring only when the admittance changed, then solving and writing node voltages via `eNode::setVolt`.
- Non-obvious design decisions: a group of **one** node is flagged `setSingle(true)` and solved entirely outside the matrix as V = I/A (`circmatrix.cpp:72-76` + `e-node.cpp:243-250`) — a floating pin never enters the LU path; the factorization is column-oriented (Crout) and normalizes each column in place (`circmatrix.cpp:167-172`).
- Edge cases / failure handling: a zero diagonal on the last column is silently skipped (`if (div == 0) continue;`, `circmatrix.cpp:170`) leaving the column un-normalized rather than reporting a singular matrix; `luSolve` sets `isOk = false` on a zero pivot but still writes a zero voltage (`circmatrix.cpp:220-226`), and the caller **ignores** the return value (`simulator.cpp:73`).
- Surprising: the group is built by *removal* from a shrinking `allNodes` list, not by a visited set (`circmatrix.cpp:39-40`); and forward substitution starts at the first non-zero entry of the RHS vector (`circmatrix.cpp:199-206`) — an optimization that silently assumes the leading entries are zero.

### src/simulator/e-element.h
- Purpose: the base class of everything the solver knows about — the entire extension contract in 55 lines.
- Key abstractions: four virtual hooks (`initialize`, `stamp`, `runEvent`, `voltChanged`); the intrusive links `nextChanged` / `nextEvent` and the `added` in-list flag; the global numerical constants `cero_doub` (1e-9), `low_imp` (1e-7), `high_imp` (1e7).
- Data flow: the Simulator owns the element list; every element self-registers in its own constructor; the solver walks the lists and calls the hooks.
- Non-obvious design decisions: the solver's work lists are **intrusive** — the list link lives inside the element (`e-element.h:40-41`), so "notify these 40 elements" is a pointer chase with no allocation, no `QList` and no iterator invalidation.
- Edge cases / failure handling: `m_pendingTime` (e-element.h:47) holds a paused element's remaining delay, so a paused-and-resumed event keeps its delay rather than its absolute deadline.
- Surprising: one `eElement` is simultaneously a circuit participant, a scheduled event and a list node — three responsibilities on one struct, which is why the same `nextEvent` pointer is later re-used by `AnalogClock` as a completely different list.

### src/simulator/e-element.cpp
- Purpose: element base implementation — self-registration, pin allocation, event pause/resume.
- Key abstractions: `setNumEpins(n)` lazily creates plain `ePin` objects named `<id>-ePin<N>`; `pauseEvents` / `resumeEvents` implement a per-element "hold the clock".
- Data flow: constructor → `Simulator::self()->addToElementList(this)`; destructor → `remFromElementList` + `cancelEvents(this)` (so a deleted element cannot leave a dangling event in the queue).
- Non-obvious design decisions: `pauseEvents` stores `eventTime - circTime()` (the **remaining** delay) and `resumeEvents` re-schedules it relative to now (`e-element.cpp:45-59`) — pausing a component preserves its delay, not its deadline; the constructor null-guards `Simulator::self()` so an element can be created before the engine exists.
- Edge cases / failure handling: the destructor cancels the element's pending event, which is the only thing keeping the sorted event list from ever holding a freed pointer.
- Surprising: `setNumEpins` **leaks** the `ePin` objects it news — the destructor only does `m_ePin.clear()` (`e-element.cpp:24`), which destroys the vector but not the pointed-to pins; for a component whose pins are the GUI pins this is fine, but for a purely internal element (the BJT's six, the coil's helpers) the pins outlive the element.

### src/simulator/e-node.h
- Purpose: the simulation-side node (a net) — the pins attached to it, the stamping lists, the voltage callbacks, and the node's own state.
- Key abstractions: two nested helper classes — `Connection` (epin + peer node + a value) reused for **four** distinct lists, and `CallBackElement` (an element to notify on voltage change).
- Data flow: `ePin::setEnode` attaches; `setEnodeComp` records the far side and creates the connection; `stampAdmitance` / `stampSingAdm` / `stampCurrent` set values and mark the node dirty; `stampMatrix` folds the values into the MNA matrix; `setVolt` fans out to the callback lists.
- Non-obvious design decisions: `Connection` is deliberately re-used as the node-admitance list too ("reusing Connection class", `e-node.cpp:86` and `e-node.cpp:117`) — one small struct, four lists, and that reuse is exactly why the node-admit list has to be cleared and refilled on every stamp.
- Edge cases / failure handling: `m_single` lets a node compute its own voltage as I/A (`e-node.h:54`, `e-node.cpp:243-250`) — a node with no neighbours is solved analytically and never enters the matrix.
- Surprising: the `Connection` constructor captures the peer's node number **at construction time** (`e-node.h:71-73`) — which is why the whole stamp phase must run *after* the Simulator has assigned node numbers (`simulator.cpp:418-422`), and why `eNode::initialize()` has to wipe the connection lists (`e-node.cpp:58-70`): the ordering is load-bearing and completely undocumented.

### src/simulator/e-node.cpp
- Purpose: node implementation — MNA stamping, the non-linear convergence callback fan-out, and per-pin current accounting for the animated wires.
- Key abstractions: the four connection lists (`m_firstAdmit` full admitance per epin, `m_firstSingAdm` single admitance to a named node, `m_firstCurrent` current sources, `m_nodeAdmit` the per-node aggregate) plus the two callback lists (`m_voltChEl`, `m_nonLinEl`).
- Data flow: `stampMatrix()` → if admittances changed, sum the full admits into the diagonal, aggregate into `m_nodeAdmit`, stamp the diagonal, add the single admits, stamp the off-diagonals as **negative** admits; if currents changed, sum them and stamp the RHS; then `setVolt()` notifies the changed-list and the non-linear list.
- Non-obvious design decisions: the MNA stamp is textbook (diagonal = ΣY, off-diagonal = −Y) at `e-node.cpp:205` and `e-node.cpp:225`; the dirty flags (`m_admitChanged`, `m_currChanged`) plus the simulator's changed-node list mean the matrix is re-stamped **only for nodes that actually moved** (`e-node.cpp:167-172`) — the incremental solve is exact, not heuristic.
- Edge cases / failure handling: `stampAdmitance` and `stampCurrent` walk the list looking for their epin and **silently drop the value** if it is not there (the `while` loop falls through) — a stamp to an unregistered epin is a lost stamp, not an error; `addConnection` refuses self-connections and duplicate epins.
- Surprising: `m_voltChanged` is set on *every* `setVolt` and is only cleared by `updateConnectors` (the GUI path) — so the flag means "the wire colour may be stale", while the real change detector is the `if (m_volt == v) return;` early-out at `e-node.cpp:254`.

### src/simulator/e-pin.h
- Purpose: the simulation-side pin — the bridge between a GUI pin and a net, and the stamping surface every element uses.
- Key abstractions: `m_enode` (my net), `m_enodeComp` (the net on the far side of my component), `m_circuitPin` (the GUI pin to colour), and the null-safe stamping shortcuts.
- Data flow: `setEnode` attaches to a net; `setEnodeComp` records the far side and creates the connection; `getVoltage()` reads the net, falling back to the far side.
- Non-obvious design decisions: every stamping helper is null-guarded (`if (m_enode)`, `e-pin.h:36` and `e-pin.h:42`) so an unconnected pin is a silent no-op rather than a crash — a deliberate "the graph may be incomplete" policy.
- Edge cases / failure handling: `getVoltage()` returns the far-side voltage when the pin has no net (`e-pin.cpp:65-70`), so a dangling pin still reports something sensible.
- Surprising: `ePin` is the shared base of the **GUI** `Pin` (`src/gui/circuitwidget/pin.h:26`) *and* of the engine's purely internal pins — a component's simulation pins are usually the GUI pins themselves (e.g. `src/components/passive/resistors/resistor.cpp:33-34`), so the graphical and electrical pin are literally the same object.

### src/simulator/e-pin.cpp
- Purpose: ePin implementation — attach/detach, connection creation, and the id rename hook.
- Key abstractions: as in the header; `changeCallBack(el, cb)` is the element→net subscription door.
- Data flow: `setEnode` detaches from the old node and attaches to the new; `setEnodeComp` registers the connection in the node's admit list; `changeCallBack` adds/removes the element from the node's voltage-change callback list.
- Non-obvious design decisions: `setEnodeComp` only registers a connection if **both** sides have a node (`if (m_enode && m_enodeComp)`, `e-pin.cpp:39-40`) — a half-connected component contributes nothing to the matrix, rather than contributing a wrong half.
- Edge cases / failure handling: the ePin constructor deliberately does *not* register with the Simulator (only `eElement` does), so a pin can outlive its owning element safely; the destructor detaches from its node.
- Surprising: `setId` calls back into the GUI — `Circuit::self()->updatePin(this, m_id, id)` (`e-pin.cpp:72-76`) — the simulation layer invoking the editor from a setter.

### src/simulator/elements/e-clocked_device.h
- Purpose: the base for everything with a clock or an enable input — the edge detector shared by flip-flops, counters, shift registers, SPI/TWI modules and the WS2812 LED.
- Key abstractions: `clkState_t { Clock_Low, Clock_Rising, Clock_Allow, Clock_High, Clock_Falling }` and `trigger_t { None, Clock, InEnable }`.
- Data flow: `stamp()` subscribes to the clock pin; the pin's voltage change reaches the device through the node's callback list; `updateClock()` classifies the pin's state; the subclass acts on the classification.
- Non-obvious design decisions: `Clock_Allow` and `Clock_Rising` are deliberately **the same enumerator value (1)** (`e-clocked_device.h:12-13`) — an "allow" condition and a "rising edge" condition are aliases, so a `switch` over the state cannot distinguish them; the alternative would be a fifth state that every subclass then has to handle.
- Edge cases / failure handling: a device with no clock pin reports `Clock_Allow` (i.e. always enabled) rather than an error (`e-clocked_device.cpp:49`).
- Surprising: this simulation-side base `#include`s `component.h` and holds an `IoPin*` — a GUI type — as its clock pointer (`e-clocked_device.h:8`, `e-clocked_device.h:54`); the engine's edge detector is welded to the editor's pin widget.

### src/simulator/elements/e-clocked_device.cpp
- Purpose: clocked-device implementation — edge detection and trigger reconfiguration.
- Key abstractions: `updateClock()` is the edge detector: it compares the remembered level `m_clock` against the pin's current level to produce Low/Rising/High/Falling.
- Data flow: `stamp()` → `m_clock = m_clkPin->inverted()` and `m_clkPin->changeCallBack(this)`; later, a voltage change on the clock's node → the device's `voltChanged()` → `updateClock()` → subclass reaction.
- Non-obvious design decisions: `stamp()` initialises the *previous level* from the pin's **inverted flag** rather than from its actual level (`e-clocked_device.cpp:24`), while `updateClock()` later reads the pin's real `getInpState()` (`e-clocked_device.cpp:53`) — the edge history at start-up is therefore not the pin's actual level, which can manufacture or swallow a spurious first edge.
- Edge cases / failure handling: `setTrigger(None)` removes the clock pin's connector, clears its label and hides it; `setTrigger` powers the circuit off first if the sim is running (`e-clocked_device.cpp:71`), so a live edge can never be produced by a configuration change.
- Surprising: `setTrigger` drives the GUI directly — it sets the pin's label text to `">"` or `"IE"` and toggles visibility (`e-clocked_device.cpp:78-91`); the simulation base class owns UI affordances.

### src/simulator/elements/analogclock.h
- Purpose: the master analogue clock — a periodic event source with a period and a divider, and the engine's time-step generator.
- Key abstractions: `eElement` **and** `Updatable` (so the clock is both scheduled by the solver and ticked by the GUI); `m_period` (ps), `m_divider`, and the derived `m_step`.
- Data flow: `stamp()` schedules a self-event; `runEvent()` runs every registered clocked element and re-arms itself; the divider scales the step.
- Non-obvious design decisions: the clock is the **only** engine-owned element — the Simulator registers it in its own constructor (`simulator.cpp:33-34`) — and it is registered in *both* the element list and the updatable list, so it participates in the solve order and in the GUI repaint order.
- Edge cases / failure handling: `setDivider` has no lower bound other than the implicit one; a divider larger than the period makes `m_period/m_divider` zero, which would make the clock re-arm at time zero forever.
- Surprising: the field is named `m_step` and its header comment says only "uint64_t m_step;" (`analogclock.h:36`) but its value is a **time interval in picoseconds** (period ÷ divider, `analogclock.cpp:77`) — the name reads as a counter and the value is a duration; `getStep()` returns it and `eReactive` consumes it as the timestep (`e-reactive.cpp:94`).

### src/simulator/elements/analogclock.cpp
- Purpose: the master clock's implementation — the fan-out to clocked elements and the self re-arming.
- Key abstractions: the clocked-element list `m_clkElement`, threaded through the subscribers' own `nextEvent` pointers.
- Data flow: `stamp()` → `setDivider(1)` + `addEvent(m_step, this)`; `runEvent()` → for each subscriber call its `runEvent()`, then `addEvent(m_step, this)` to re-arm.
- Non-obvious design decisions: `addClkElement` links subscribers through `e->nextEvent` (`analogclock.cpp:49`) — the **same field** the Simulator's time-ordered event queue uses. A subscriber is therefore simultaneously a node in two unrelated lists, and a subscriber that also self-schedules would corrupt one of them. No such element exists in this shard, so the hazard is latent rather than live.
- Edge cases / failure handling: `stamp()` calls `setDivider(1)` (`analogclock.cpp:25`), which **silently discards a user-set divider** every time the simulation starts; the clock's re-arm uses the relative `addEvent`, so the period tracks the simulation clock rather than wall time.
- Surprising: the clock re-arms *itself* as an event rather than being driven by the timer — the whole time-domain behaviour of the simulation hangs off one self-perpetuating event.

### src/simulator/elements/passive/e-resistor.h
- Purpose: the base for every element reducible to an admittance between two pins — resistor, capacitor model, diode, LED, JFET, MOSFET, battery, meter, motor.
- Key abstractions: `m_admit` (conductance) and `m_current`; `setResistance` / `setAdmit` / `stampAdmit`.
- Data flow: `stamp()` wires each pin's "other side" enode and stamps the admitance into both nodes.
- Non-obvious design decisions: the stored quantity is **conductance, not resistance** (`resistance()` is `1/m_admit`, `e-resistor.h:18`) because the solver works in admitances; the class is the reason the whole element family can be layered by physics.
- Edge cases / failure handling: `setResSafe` wraps the change in `pauseSim()` / `resumeSim()` (`e-resistor.cpp:47-52`) so a property edit never lands in the middle of a solve.
- Surprising: the constructor's `m_ePin.resize(2)` (`e-resistor.cpp:15`) leaves both pins **null** — the actual `ePin`s are supplied later by the owning component (the GUI pins) or by `setNumEpins`, so a freshly constructed `eResistor` is a two-null-pointer shell.

### src/simulator/elements/passive/e-resistor.cpp
- Purpose: the resistor implementation — stamping, safe property mutation, and on-demand current computation.
- Key abstractions: `stamp()` (wire + stamp), `stampAdmit()` (stamp only the conductance), `updateVI()` (compute current from the node voltages).
- Data flow: `stamp()` → `setEnodeComp` both ways → `stampAdmit()` → each pin stamps the same admitance into its own node, which is what puts the −Y off-diagonal in the matrix.
- Non-obvious design decisions: `stampAdmit()` returns early if either pin is unconnected (`e-resistor.cpp:29`) — an unconnected element is simply **absent** from the matrix rather than an error; `current()` calls `updateVI()` first, so asking for a current recomputes it from the latest node voltages instead of returning a stale stored value.
- Edge cases / failure handling: `setResistance` clamps anything below 1e-12 Ω, which becomes a 1e12 S conductance — a numerically horrible but non-singular element; `setAdmit` explicitly permits zero.
- Surprising: `stampAdmit()` is a public-ish door that subclasses call to re-stamp a *changed* conductance without re-running the whole stamp — the diode's `voltChanged()` uses exactly that (`e-diode.cpp:92`).

### src/simulator/elements/passive/e-reactive.h
- Purpose: the base for capacitors and inductors — the only elements with genuine time dependence.
- Key abstractions: `m_value` (C or L), `m_InitVolt` / `m_InitCurr` (initial conditions), `m_tStep` (timestep in seconds) and `m_timeStep` (in ps); the virtuals `updtRes()` and `updtCurr()` that the subclass implements.
- Data flow: the AnalogClock drives `runEvent()` → the element re-samples its pin voltages and re-stamps a current source.
- Non-obvious design decisions: the reactive elements are **not** integrated continuously — they are sampled once per AnalogClock tick and their companion resistance is derived from that step (`e-reactive.cpp:92-97`); the class registers itself with the AnalogClock in its constructor and unregisters in its destructor (`e-reactive.cpp:19`, `e-reactive.cpp:23`), so the time domain is driven by a list, not by a callback tree.
- Edge cases / failure handling: `initCurr()` returns **−m_InitCurr** (`e-reactive.h:23-24`) — the sign convention is inverted at the API boundary, which is a trap for any caller that sets a positive current.
- Surprising: the whole `voltChanged()` implementation is **commented out** (`e-reactive.cpp:54-70`) — the reactive elements moved entirely to the event-driven model and the old callback path was left in place as dead code rather than deleted.

### src/simulator/elements/passive/e-reactive.cpp
- Purpose: the reactive base's implementation — the companion-model stamping and the per-tick resampling.
- Key abstractions: `updtReactStep()` pulls the clock's step, converts ps → s and sets the element's resistance via `updtRes()`.
- Data flow: `stamp()` → `eResistor::stamp()`, create the current slots, `updtReactStep()`, `m_volt = m_InitVolt`, `m_curSource = updtCurr()`, stamp the initial current; then `runEvent()` (from the clock) re-reads the pin voltage and re-stamps the current whenever it moved.
- Non-obvious design decisions: the current source is stamped on both pins with opposite signs and the element is otherwise a resistor whose value is refreshed once per step (`e-reactive.cpp:43-44`, `e-reactive.cpp:87-88`) — a crude but stable companion model; `updtReactStep()` calls `setResistance(updtRes())`, which immediately stamps the new conductance.
- Edge cases / failure handling: the current work in `stamp()` only happens if **both** pins are connected, but the trailing `updtReactStep()` runs unconditionally (`e-reactive.cpp:51`) — an unconnected capacitor still gets a resistance.
- Surprising: `runEvent()` compares the newly sampled voltage with the stored `m_volt` and does nothing if they are equal — the reactive element is a *stateful* device whose state is refreshed only on change, so a constant-voltage capacitor is never re-stamped.

### src/simulator/elements/passive/e-coil.h
- Purpose: one winding of a transformer / inductor, modelled as a current source with mutual coupling to sibling coils.
- Key abstractions: the transformer's geometry (`index`, `sign`, `size`), the turns ratio `relation`, the inductance, and two helper `eResistor`s (`m_resistor0`, `m_resistor1`).
- Data flow: a coil owns two internal `eNode`s; the outer pins reach the internal nodes through the helper resistors; mutual coupling is expressed as single admittances via `addIductor()`.
- Non-obvious design decisions: the helper resistors are set to **1000 S** (`e-coil.cpp:28-29`) — a numerical damper that keeps the coil's internal nodes from floating in the matrix; the coil's own `stamp()` is **empty** (`e-coil.cpp:39`) and the real work is in `stampCoil()`, which the owning component calls (`src/components/passive/reactive/transformer.cpp:141`).
- Edge cases / failure handling: a coil that is never `stampCoil()`-ed is invisible to the solver.
- Surprising: the header exposes `setBaseInd`, `setAdmit`, `stampCurrent` and `setEnode` as public, and holds `m_resistor0`/`m_resistor1` as **by-value `eResistor` members** — which means those helpers are themselves `eElement`s and therefore self-register with the Simulator's element list and get initialized and stamped as independent circuit participants.

### src/simulator/elements/passive/e-coil.cpp
- Purpose: the coil implementation — internal node construction, the pin→node binding, current stamping and mutual coupling.
- Key abstractions: `stampCoil()` (bind), `stampCurrent(delta)` (accumulate and stamp), `addIductor(coil, g)` (mutual inductance).
- Data flow: the constructor allocates 2 pins and 2 helper resistors at 1000 S; `initialize()` creates two fresh internal `eNode`s; `stampCoil()` binds the outer pins to the internal nodes through the helpers, creates the current slots and resets `m_currSource`; `stampCurrent()` accumulates into `m_currSource` and stamps −/+ onto the outer pins.
- Non-obvious design decisions: mutual coupling is expressed as **four** single admittances, a −g/+g pair on each of the two coils (`e-coil.cpp:80-83`) — the standard two-coil mutual-inductance stamp; the coil's current is a *state variable* fed in from the owning component (the transformer computes L·di/dt and pushes it in), not computed by the coil itself.
- Edge cases / failure handling: `initialize()` news two `eNode`s every time it runs (`e-coil.cpp:35-36`); the Simulator's `createNodes()` deletes the previous generation of eNodes *before* element `initialize()` runs, so there is a window in which the coil's `m_enode0`/`m_enode1` dangle — narrow, but it exists and is unguarded.
- Surprising: the file ends with the only schematic in the engine — an ASCII diagram of the coil topology (pin → eNode → 1000 Ω → internal pin) at `e-coil.cpp:85-89`.

### src/simulator/elements/active/e-bjt.h
- Purpose: the BJT model's header — the physics constants, the gain split, and the six internal pins.
- Key abstractions: `m_gain` with `m_rgain` (reverse) / `m_fgain` (forward), `m_vt` (thermal voltage), `m_satCur`, `m_vCrit` (critical voltage); six pins `m_BC`, `m_CB`, `m_BE`, `m_EB`, `m_CE`, `m_EC` — one per terminal **pair**.
- Data flow: see the .cpp; the six pins exist so a single junction can be stamped in both directions.
- Non-obvious design decisions: the transistor keeps **six** internal pins instead of three because the MNA stamp needs a separate connection per direction per junction (`e-bjt.cpp:68-81`); `setup()` is called by the owning component *after* it has replaced pins 0-2 with the GUI pins (`src/components/active/bjt.cpp:47`), so the model learns its own topology at construction time.
- Edge cases / failure handling: `m_vCrit` is derived from `m_satCur` and `m_vt` in the constructor (`e-bjt.cpp:30`) and re-derived whenever the user changes the threshold (`e-bjt.cpp:161-166`).
- Surprising: the user-facing knobs are `gain()` and `threshold()` while `m_vt` and `m_satCur` are hard-coded constants — the model is parameterised in datasheet terms, not in SPICE terms.

### src/simulator/elements/active/e-bjt.cpp
- Purpose: the BJT (Ebers-Moll-flavoured) model — the non-linear solve and the re-stamping of the six junction admittances.
- Key abstractions: `setup()` (pin assignment), `voltChanged()` (the model), `limitStep()` (the damping).
- Data flow: `stamp()` → register on the non-linear list of all three nodes, bind the six internal pins to the node pairs, create the current slots; `voltChanged()` → read Vbc/Vbe → limit the step → compute ie/ic and the four conductances (Gee, Gcc, Gce, Gec) → stamp the six admitances and three currents.
- Non-obvious design decisions: `limitStep` (`e-bjt.cpp:141-152`) forbids a junction voltage from jumping by more than ~2·Vt in one iteration and pulls it back **logarithmically** — the classic Newton-limiting trick that is what makes an exponential model converge in a handful of passes; `gmin` (`e-bjt.cpp:104-105`) is a minimum conductance that grows with the iteration count and is capped at 0.1 S, guaranteeing the matrix is never singular.
- Edge cases / failure handling: the convergence test is a **voltage** test — "neither junction moved 10 mV" (`e-bjt.cpp:98-100`) — and the iteration counter `m_step` grows by 0.1 per pass and is only reset by that test; `m_changed` forces one unconditional recalculation after any parameter edit.
- Surprising: the model is a port — the file says "Based on Falstad Circuit Simulator BJT model: https://falstad.com" (`e-bjt.cpp:5`). SimulIDE's analogue physics is Falstad's, not SPICE's, which is why the convergence tolerances are loose (10 mV) and the models are cheap.

### src/simulator/elements/active/e-diode.h
- Purpose: the diode / zener / LED model header, with a **data-driven** model library.
- Key abstractions: `diodeData_t { satCur, emCoef, brkDow, resist }`; three **static** model maps (`m_diodes`, `m_zeners`, `m_leds`) shared by every instance.
- Data flow: `getModels()` (static, once) parses `resources/data/diodes.model`; `setModel(name)` looks the name up in the three maps and calls `setModelData` → `SetParameters` → `updateValues`, which derives `m_vScale`, `m_vdCoef`, `m_vCriti`, `m_zOfset`, `m_vzCrit` and `m_bAdmit`.
- Non-obvious design decisions: the model library is a static `QMap` on the class, loaded **lazily on first construction** (`e-diode.cpp:30`) — the XML file is read once per process; three separate maps let the same name exist in the diode, zener and LED namespaces.
- Edge cases / failure handling: `setModel("Custom")` is a no-op (the user must then set the parameters by hand); `setThreshold`, `setSatCur` and `setEmCoef` **silently reject** out-of-range values (`< 0.01`, `≤ 0`) rather than reporting an error.
- Surprising: the "LED" entries in the model file are not a separate LED model — they are ordinary diode entries with an emission coefficient of 3.73 and a tiny saturation current (`e-diode.cpp:167`); the element actually used for LEDs (`eLed`) is a **different, much simpler** model.

### src/simulator/elements/active/e-diode.cpp
- Purpose: the diode implementation — exponential I-V, reverse breakdown, and the damping that makes it converge.
- Key abstractions: `limitStep(vnew, vold, scale, vc)` — the damped update; `gmin` — the guaranteed conductance.
- Data flow: `stamp()` → `eResistor::stamp()` + register on the non-linear list of both nodes + create the current slots; `voltChanged()` → read the pin voltage → if it moved more than 2·vScale above the threshold, limit the step → handle the reverse/zener branch → compute admit and current → `eResistor::stampAdmit()` → stamp the currents.
- Non-obvious design decisions: the zener is handled by **sign-flipping the voltage** (`e-diode.cpp:70-78`) so one exponential + one limiter serves both directions; `gmin = m_bAdmit·exp(step)` capped at 0.1 S is added to the diode's own conductance (`e-diode.cpp:63-64`, `e-diode.cpp:85`) so the matrix can never be singular while the diode is off.
- Edge cases / failure handling: the convergence test is `|voltPN − m_voltPN| < 0.01` — **10 mV** (`e-diode.cpp:58`) — which is coarse for a diode; the class's own `m_converged` flag is written but never read by the engine (the solver uses its own `notCorverged()`), so it is effectively decorative.
- Surprising: `m_maxCur` (maximum current) is stored, exposed as a property and settable (`e-diode.h:43-44`) but **never used** in the I-V law — a leftover from an earlier model.

### src/simulator/elements/active/e-jfet.h
- Purpose: the JFET model header — the three datasheet parameters and the derived β.
- Key abstractions: `Idss`, `Vp` (pinch-off / Vgs(off)), `LambdaInv` (channel-length modulation); `m_beta = Idss/Vp²` derived in `initialize()`.
- Data flow: see the .cpp; the model is a square-law device with a triode region and a channel-length correction.
- Non-obvious design decisions: P-channel support exists in the data model but is **explicitly disabled** ("Currently not allowed to change", `e-jfet.cpp:18`) and its setter is commented out in the header (`e-jfet.h:21-22`).
- Edge cases / failure handling: `setIdss` clamps at 1000 A and `setLambdaInv` clamps at 1 V (`e-jfet.cpp:139-178`).
- Surprising: the header comments carry the real datasheet meaning of each parameter — e.g. "Idss = Ids when gate 'shorted' to source" (`e-jfet.h:45`) — which is unusually good documentation for this codebase and makes the model re-implementable from the header alone.

### src/simulator/elements/active/e-jfet.cpp
- Purpose: the JFET model implementation — Shockley square law, triode vs saturation, channel-length correction, and the virtual source/drain swap.
- Key abstractions: the source/drain swap when Vd < Vs, which flips the sign of the stamped current (`direction`).
- Data flow: `stamp()` → `updateValues()` → if drain and source are connected, `eResistor::stamp()` + register non-linear + create the current slots; `voltChanged()` → read Vd/Vs/Vg → swap if needed → compute the piecewise current → convergence check → **relax** the admitance by 0.1 % toward the new value → stamp the currents.
- Non-obvious design decisions: the conductance is **relaxed geometrically** — `m_admit + 0.001·(tempAdmit − m_admit)` (`e-jfet.cpp:127`) — instead of being set outright; that 0.1 % is the damping constant and it makes the model unconditionally stable at the cost of iterations. The source/drain swap follows LTSpice and the comment cites the discussion that motivated it (`e-jfet.cpp:74`).
- Edge cases / failure handling: an unconnected gate is treated as tied to the source (`e-jfet.cpp:81`); the convergence test is `|current − m_lastCurrent| < m_accuracy` where `m_accuracy` is **1 (a whole ampere)** (`e-jfet.cpp:33`, `e-jfet.cpp:116`) — an extremely loose absolute tolerance, orders of magnitude looser than the MOSFET's 5 µA.
- Surprising: `m_lastCurrent = current;` is executed **before** the current is stamped, and the stamp computes `current - m_lastCurrent` (`e-jfet.cpp:132-135`) — so the difference is always exactly zero and **the JFET never stamps a non-zero current into the matrix**; the device therefore behaves as a pure voltage-controlled conductance, and the current-source half of the model is inert.

### src/simulator/elements/active/e-mosfet.h
- Purpose: the MOSFET model header — the switch-like parameters and the effective threshold.
- Key abstractions: `RDSon`, `threshold`, `P-channel` and `depletion` flags, plus the derived `m_Gth` (effective gate threshold) and `m_kRDSon` (the current-scaling factor).
- Data flow: see the .cpp; the model is an RDS-on switch with a triode-region correction, not a square-law MOSFET.
- Non-obvious design decisions: the user-facing threshold and the effective threshold differ: `m_Gth = m_threshold − m_threshold/4` for enhancement and `−m_threshold − m_threshold/4` for depletion (`e-mosfet.cpp:121`) — a fudge factor with no stated derivation.
- Edge cases / failure handling: `setRDSon` clamps to [1e-9, 1000] Ω and `setThreshold` rejects anything below 0.01 V (`e-mosfet.cpp:101-116`).
- Surprising: the class exposes `depletion()` and `pChannel()` as properties but the depletion mode only shifts the threshold — it does not change the current law at all.

### src/simulator/elements/active/e-mosfet.cpp
- Purpose: the MOSFET model implementation — the triode/saturation approximation and the re-stamping of the channel conductance.
- Key abstractions: `maxCurrDS = Vds·admit` as the channel-resistance-limited current, minus a triode-region term.
- Data flow: `stamp()` → `m_admit = 1/m_RDSon`, `updateValues()`, register non-linear on the connected nodes; `voltChanged()` → read Vgs/Vds → if above threshold compute the current with the triode correction and clamp it to `maxCurrDS` → update the admitance if it changed → convergence check → stamp the currents.
- Non-obvious design decisions: `if (Vds > gateV) Vds = gateV;` (`e-mosfet.cpp:79`) clamps the drain-source voltage to the overdrive so the triode term can never exceed the saturation current — the model is prevented from entering true saturation; unlike the JFET, the conductance is **not** relaxed, it jumps straight to the new value.
- Edge cases / failure handling: an unconnected gate is tied to the source (`e-mosfet.cpp:60`); the convergence tolerance is 5 µA (`e-mosfet.cpp:40`, `e-mosfet.cpp:93`) — 200× tighter than the JFET's, and 2000× tighter in current terms than the diode's 10 mV voltage test.
- Surprising: the three models disagree wildly in how they decide they have converged (10 mV of junction voltage for the diode and BJT, 1 A for the JFET, 5 µA for the MOSFET) — there is no shared convergence policy, only per-model folklore.

### src/simulator/elements/outputs/e-led.h
- Purpose: the LED element's header — a distinct, deliberately simplified model (not `eDiode`).
- Key abstractions: `m_threshold`, `m_impedance`, `m_maxCurrent`; the brightness accumulators `m_totalCurrent`, `m_lastPeriod`, `m_brightness` and the 8-bit `m_intensity`.
- Data flow: see the .cpp; the LED both conducts and reports its perceived brightness.
- Non-obvious design decisions: brightness is the **square root** of (average current ÷ max current) (`e-led.cpp:114`) — a perceptual curve, not a linear one; `m_intensity` is a `uint32_t` in [0, 255] purely to feed the GUI.
- Edge cases / failure handling: `overCurrent()` returns `avgCurrent/maxCurrent` with no clamp, so it can exceed 1.
- Surprising: this LED is a threshold-plus-linear-resistor model while the model library in `e-diode.cpp` also carries "LED" entries — **two different LED models in one codebase**, and only this one is actually used by the LED component.

### src/simulator/elements/outputs/e-led.cpp
- Purpose: the LED implementation — the conduction model, the time-averaging of current, and the brightness output.
- Key abstractions: `updateVI()` integrates current over time (current × period); `updateBright()` turns that integral into a 0-255 intensity.
- Data flow: `voltChanged()` → read the pin voltage → compute the threshold current and the excess current → if the admitance changed, set it → if the threshold current is unchanged the LED has converged and `updateVI()` runs → otherwise stamp the current and mark not-converged; `updateBright()` (called from the GUI's update step) integrates and recomputes the brightness at most **twice per rendered frame** (`e-led.cpp:111`).
- Non-obvious design decisions: the conduction law is a hard threshold — below `m_threshold` there is **no current at all**, above it a fixed resistance with a fixed threshold current (`e-led.cpp:61-67`); the brightness is recomputed only when `m_lastPeriod > psPF/2` (`e-led.cpp:111`), a deliberate throttle so the GUI never re-colours an LED on every solver pass — the LED is the one element that explicitly budgets its own update rate against the frame time.
- Edge cases / failure handling: when the simulation is not running, `updateBright()` zeroes the accumulators (`e-led.cpp:93-99`); in a debug pause the instantaneous current is used instead of the average (`e-led.cpp:102-106`).
- Surprising: `setResistance` **pauses the whole simulation**, calls `voltChanged()` directly and resumes (`e-led.cpp:123-132`) — a GUI property edit re-enters the solver from the GUI thread, which is the only place in the shard where the GUI drives the solver synchronously.

## Ideas worth stealing

- **The element is the event record — a scheduled component is a node in a sorted intrusive list, and a double-schedule is refused, not merged** - `src/simulator/simulator.cpp:526-566` (refusal at `:530-534`), with the element-side fields at `src/simulator/e-element.h:40-44` - the queue is a singly-linked list threaded through the elements' own `nextEvent` pointers, so scheduling costs zero allocations and the element's `eventTime` doubles as the "already pending" flag. A second `addEvent` on the same element is *rejected* with a warning instead of being merged or silently corrupting the order. An August harness that schedules tool work (or a simulator tick) gets this for free: one pending job per handle, refuse the duplicate, and make the handle itself the queue node.

- **The four-hook component contract: `initialize` / `stamp` / `runEvent` / `voltChanged`** - `src/simulator/e-element.h:19-23`, dispatched at `src/simulator/simulator.cpp:266-273` (event) and `src/simulator/simulator.cpp:301-317` (voltage change) - a new simulated device implements four methods and the engine takes care of scheduling it, stamping it into the model, and waking it when its net's voltage moves. This is the minimal surface area a plugin has to implement, and it is why SimulIDE supports ~120 devices without a registry file: the class self-registers in its constructor (`src/simulator/e-element.cpp:20`). A skill that wants to add a new circuit primitive to an August tool should copy this shape, not invent a plugin manifest.

- **Dirty-bit stamping on two levels: per node AND per connected group** - `src/simulator/e-node.cpp:105-107` and `src/simulator/e-node.cpp:167-172` (node level), `src/simulator/circmatrix.cpp:120-137` (group level) - each node carries `m_admitChanged`/`m_currChanged` and each connected group carries its own pair, so a solve pass costs only what actually changed. The incremental update is **exact** (a dirty node is fully re-stamped, not approximately patched) and the group-level bit means an untouched island of the circuit is not even re-solved. This is the pattern to lift for any harness that re-solves a model after a small edit: dirty at the object, dirty at the partition, skip whole partitions.

- **Nodal decomposition into independent connected components, with a closed-form escape hatch for singletons** - `src/simulator/circmatrix.cpp:66-110` (the DFS) and `src/simulator/circmatrix.cpp:72-76` (the singleton case), closed analytically at `src/simulator/e-node.cpp:243-250` - the circuit is split into independent groups by a recursive walk of the connection graph, each group is factored and solved on its own, and a group of one node never enters the matrix at all (V = I/A). For August: split a problem into independent sub-problems by dependency, and give the trivial case an exact closed form instead of a general algorithm.

- **`gmin` — a guaranteed conductance floor that makes exponential models converge and the matrix non-singular** - `src/simulator/elements/active/e-diode.cpp:63-64` (and its use at `:85`), `src/simulator/elements/active/e-bjt.cpp:104-105` (and `:125-126`) - every non-linear element adds a small conductance that grows with the iteration count and is capped at 0.1 S, so an "off" transistor still conducts a little and the linear system is never singular. This is the single highest-value trick in the shard: a leak-to-ground that buys both numerical conditioning and convergence, at the cost of a physically negligible current.

- **Logarithmic step limiting on exponentials (damped Newton)** - `src/simulator/elements/active/e-bjt.cpp:141-152` and `src/simulator/elements/active/e-diode.cpp:99-109` - the junction voltage may not jump by more than about 2·Vt in one iteration; if it tries, it is pulled back to `vold + Vt·ln(1 + Δ/Vt)`, i.e. the *logarithm* of the requested step. Any August component that evaluates an exponential (a transistor, a rate curve, a sigmoid) needs this or it will oscillate or overflow on the first iteration.

- **Geometric relaxation of the conductance instead of a full Newton step** - `src/simulator/elements/active/e-jfet.cpp:126-129` - the new conductance is approached by only 0.1 % per iteration (`m_admit + 0.001·(tempAdmit − m_admit)`). Cheap, unconditionally stable, and a good default whenever a model's derivative cannot be trusted — the same idea as a learning-rate or an EMA, applied to a solver.

- **The solver owns the iteration budget; the element only says "not converged"** - `src/simulator/simulator.h:89` (`notCorverged()`) with the loop at `src/simulator/simulator.cpp:291-321` and the cap at `src/simulator/simulator.cpp:306` - a component never decides when to give up; it raises a one-line flag, and the engine owns the iteration limit (`m_maxNlstp`, default 100 000) and the "NonLinear Not Converging" warning. An August skill should have the same shape: the component reports a status, the engine owns the budget and the failure.

- **"Pause the simulation, mutate, resume" as the universal mutation protocol** - `src/simulator/e-element.cpp:45-59` (per-element), `src/simulator/elements/passive/e-resistor.cpp:47-52` (per-property), `src/simulator/elements/outputs/e-led.cpp:123-132` (from the GUI thread), `src/simulator/elements/e-clocked_device.cpp:71` (before a reconfiguration) - every change that can affect the model is wrapped in `pauseSim()`/`resumeSim()`, so a mutation can never land in the middle of a solve. This is the cleanest rule I have seen for "one thread is reading state while another wants to change it".

- **Voltage-change subscription instead of polling** - `src/simulator/e-node.cpp:259-277` (the fan-out) with the subscribe door at `src/simulator/e-pin.cpp:58-63` - a device registers on a net; when the net's voltage changes, the device is placed on the simulator's changed list and its `voltChanged()` runs. The `added` flag makes the fan-out idempotent. An August harness that must react to a changed world should offer this shape — *register on the thing, be woken when it moves* — instead of a poll loop.

- **"Give the time base a name and a divisor" — a single clock element that every time-domain element subscribes to** - `src/simulator/elements/analogclock.cpp:36-45` (the fan-out) and `src/simulator/elements/analogclock.cpp:47-51` (the subscriber list), consumed at `src/simulator/elements/passive/e-reactive.cpp:92-97` - instead of integrating continuously, the engine has one periodic clock; capacitors and inductors are re-sampled once per clock tick and their companion model is rebuilt from the step. A logic-circuit tool wants exactly this: one knob (period ÷ divider) that sets the resolution of time for the whole simulation.

- **An edge detector as a reusable base class, with "allow" aliased to "rising edge"** - `src/simulator/elements/e-clocked_device.cpp:47-67` and `src/simulator/elements/e-clocked_device.h:11-17` - a device that needs a clock edge, or an enable, derives from one base that keeps the previous level and classifies the new one into Low/Rising/High/Falling/Allow. Every flip-flop, counter, shift register, SPI and TWI module in the codebase reuses it. For logic-coursework tooling, an edge detector with rising/falling/enable semantics is the single most reusable primitive — and the deliberate aliasing of `Clock_Allow` with `Clock_Rising` is a good reminder to model "level-sensitive" and "edge-sensitive" as one enum with an explicit alias rather than as two parallel mechanisms.

- **The engine holds no netlist — the netlist is rebuilt from the editor's pin map at every start** - `src/simulator/simulator.cpp:354-390` (`createNodes`) with the ordering that makes it correct at `src/simulator/simulator.cpp:415-422` and the reason it is fragile at `src/simulator/e-node.h:71-73` - the simulation nodes are constructed from `Circuit::self()->m_pinMap` at start-up; node numbers are assigned, then `eNode::initialize()` wipes the connection lists, then `stamp()` re-creates them (because `Connection` captures its peer's node number at construction). The consequence for August: **the engine is a pure function of the editor state**, so anything that can produce a pin map — including a headless, file-driven or agent-driven model — can drive a simulation without touching the GUI.

- **Measure the engine's throughput instead of assuming it** - `src/simulator/simulator.cpp:183-196` (real speed: simulated ps per real second) and `src/simulator/simulator.cpp:139-143` (simulation load: the fraction of the timer tick spent in the solve) - the engine reports two distinct numbers: "am I keeping up with the requested speed?" and "how loaded is the solver?". A harness that drives a simulator in a loop wants exactly these two, and it wants them computed from one monotonic clock rather than from a stopwatch around the call.

- **Keep the GUI thread out of the solver: the work runs on a future and is joined at the tick boundary** - `src/simulator/simulator.cpp:147-148` (spawn) and `src/simulator/simulator.cpp:126-133` (join), with `volatile simState_t m_state` at `src/simulator/simulator.h:150` existing solely because of that split - the timer callback stops the future, waits for it, and only then launches the next frame; the shared state variable is `volatile` because the solver thread reads it. The same shape — a worker future, a tick-boundary join, and one volatile state word — is what August would need to keep a long-running simulation responsive without freezing the UI.

- **A device library as data, not code** - `src/simulator/elements/active/e-diode.cpp:160-201` (the parser) with `resources/data/diodes.model` - a small XML file holds every diode, zener and LED part; `setModel(name)` looks it up in a static map. Adding a part is a data edit, and the map is loaded lazily once per process (`src/simulator/elements/active/e-diode.cpp:30`).

## Files skipped (with reasons)

None. All 30 files in this shard were opened and read in full; the shard contains no generated, vendored, binary or large-data files (the largest is `simulator.cpp` at 19 KB).

## Uncertainties

- **I did not execute anything.** All behaviour claims — convergence, damping, brightness throttling, event ordering — are read from the source, not measured. The shard was read under a read-only rule, so no timing, convergence-rate or accuracy figure in this report is empirical.
- **The JFET's zero current stamp** (`src/simulator/elements/active/e-jfet.cpp:132-135`) looks like a genuine bug: `m_lastCurrent` is assigned `current` before the subtraction, so the stamped current is always zero. I checked the whole shard for a compensating path and found none, but the owning component (`src/components/active/jfet.cpp`, the `components-analog` shard) was **not** read by me, so I cannot say whether it re-stamps the current itself.
- **`eDiode::m_converged` and `eLed::m_converged` are written but never read** by the engine — the solver uses its own `notCorverged()` flag. I grepped the shard for readers and found none; a reader in another shard cannot be excluded.
- **`eDiode::m_maxCur`** is stored, exposed as a property and settable, but never appears in the I-V law (`src/simulator/elements/active/e-diode.cpp:53-97`).
- **The `nextEvent` aliasing** between the Simulator's event queue (`src/simulator/simulator.cpp:536-565`) and `AnalogClock`'s subscriber list (`src/simulator/elements/analogclock.cpp:47-51`) is a latent hazard, not a live bug: no element in this shard is in both lists. I only checked this shard, so an element in another shard could be.
- **The `eCoil` dangling-pointer window**: `initialize()` news two `eNode`s (`src/simulator/elements/passive/e-coil.cpp:35-36`) after the Simulator's `createNodes()` has already deleted the previous generation (`src/simulator/simulator.cpp:357-361`); between those two points the coil's `m_enode0`/`m_enode1` point at freed memory. I did not find a read in that window, but the ordering is unguarded.
- **The AnalogClock's period/divider are set from the GUI**, which is in the `gui` shard — I did not read `AppDialog`/`CurrentWidget`, so I could not confirm what the user-facing units are or what happens when the divider exceeds the period (`m_period/m_divider` would truncate to 0).
- **The MNA matrix is dense and allocated as `numEnodes × numEnodes` doubles** (`src/simulator/circmatrix.cpp:30`); I did not measure its memory behaviour on a large circuit, so I cannot say at what circuit size this becomes the bottleneck.
- **Scripting and embedded-code support, the circuit file format, undo/redo, and the component/plugin registration of the *editor* side are all outside this shard** (they live in `microsim`, `angel-jit`, `gui` and `components-*`). The nearest thing here is the event queue (which the MCU cores and the AngelScript engine drive) and the fact that the engine's netlist is reconstructed from the editor's pin map at start-up — but I did not read those shards and make no claims about them.
- **There is no test suite anywhere under `src/simulator/`** (I globbed for `*test*` and found nothing) and no test harness in this shard at all, so none of the tolerances, clamps or convergence rules in this report are pinned by a test.

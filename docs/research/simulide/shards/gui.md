# simulide / gui

## Shard shape

This shard is the entire Qt Widgets front end of SimulIDE: 213 files under `src/gui/`, in ten sub-trees plus a handful of root-level custom widgets. It is the layer that sits between the simulator and the user, and it is where almost every interesting "architecture" decision of the project actually lives — because SimulIDE's simulation engine (`src/simulator`, `src/microsim`) is not reachable from this shard, but the *entire* file format, *all* of the undo/redo, *all* of the property system and *all* of the component registry are implemented here in the GUI layer. The modules are:

- **`circuitwidget/`** — the canvas. `Circuit` (a `QGraphicsScene`) owns components, connectors and nodes; it parses and writes the `.sim2` circuit file format, implements undo/redo as diffs over the serialized form, and hosts `CircuitView` (the `QGraphicsView`) and `CircuitWidget` (toolbar, panels, power/pause/debug). `CompBase` is the property-bearing base of every item; `Pin`/`IoPin`/`IoPort` are the electrical terminals; `Connector`/`ConnectorLine` are the wires; `Label`/`Dialed`/`ConnBase` are the graphics helpers.
- **`properties/`** — the property system. `ComProperty` plus template subclasses (`BoolProp`, `IntProp`, `DoubProp`, `StrProp`, `PointProp`, `ScriptProp`) bind a component's getter/setter pair to a named, typed, unit-carrying property. `PropDialog` builds the whole settings window at runtime from a component's property groups; `PropVal` and its subclasses (`NumVal`, `EnumVal`, `BoolVal`, `StrVal`, `TextVal`, `PathVal`, `ColorVal`, `LabelVal`) are the editor widgets. This one directory is simultaneously the property editor, the file-format codec and the scripting surface.
- **`componentlist/`** — the palette and the component registry. `ItemLibrary` holds ~130 `LibraryItem` entries (each a category, icon, type list and a factory function pointer) and is the actual extension point for new components. `ComponentList` builds the categorized tree from XML component sets, so components can also be added as data. `Installer` downloads and installs component-set zips. `TreeItem` serialises the palette layout back to XML.
- **`editorwidget/`** — the embedded code editor and the debuggers. `CodeEditor` is a `QPlainTextEdit` with a gutter, completion, and a data-driven syntax highlighter (`Highlighter`); `Compiler` drives an external toolchain described by an XML file; `BaseDebugger` and its subclasses (`cDebugger`, `AvrGccDebugger`, `Xc8Debugger`, `SdccDebugger`, `GcbDebugger`, `InoDebugger`, `asDebugger`, `GputilsDebug`) map flash addresses to source lines.
- **`dataplotwidget/`** — the oscilloscope and logic analyser: `PlotBase` owns up to eight `DataChannel` trace buffers, `PlotDisplay` renders them (with sub-sampling), and the analyser/scope control dialogs expose time base, thresholds, triggers and bus flags. `PlotBase` also compiles a user-written *condition* into an AngelScript function that pauses the simulation when met.
- **`memory/`** — the MCU debug surface: `Watcher` (registers/variables), `RamTable` (symbol watch with type decoding), `MemTable` (hex+ASCII memory editor), `MCUMonitor` (the window that assembles them), `MemData` (Intel HEX / binary / `.data` load-save), `Console` (scripted-CPU console).
- **`editorwidget/debuggers/`** are covered above. **`filebrowser/`** is the file sidebar. **`serial/`** is the UART monitor and terminal. **`testing/batchtest.cpp`** is the repo's regression harness. **`appdialogs/`** holds the About and Settings dialogs; **`thememanager.cpp`** holds the light/dark theme; **`outpaneltext.cpp`** is the shared output log. The remaining root files (`custombutton`, `customslider`, `customdial`, `dialwidget`, `joystickwidget`, `sourcewidget`, `updobutton`) are hand-painted widgets used by the canvas.

The overall picture: SimulIDE is a Qt5 desktop application where the *document model* (the circuit file, the component properties, the palette registry) lives in the GUI layer, and the GUI talks to the engine through a very small surface — `Simulator::self()->addEvent()`, `addToUpdateList()`, `startSim()`, and the `eElement`/`ePin` electrical interfaces.

## Engine-facing surface: events, time stepping, and the per-step update list

The GUI layer is not a passive view of the engine. It owns three of the engine's control surfaces, and it is where a "digital signal" becomes an "electrical edge".

**Two callback channels, and nothing else.** The engine offers the GUI exactly two ways to be called back:

1. `Simulator::addToUpdateList(this)` — the object is invoked once per *simulation step* through `Updatable::updateStep()`. Nine different GUI subsystems use it: the canvas current animation (`src/gui/circuitwidget/connector.cpp:436`), the pin state repaint (`src/gui/circuitwidget/pin.cpp:366`), the on-canvas dial (`src/gui/circuitwidget/dialed.cpp:47`), the shared output log (`src/gui/circuitwidget/circuitwidget.cpp:289`), the script console (`src/gui/serial/console.cpp:36`), the UART monitor (`src/gui/serial/serialmon.cpp:49`), the byte terminal (`src/gui/serial/terminal.cpp:21`), the plot channels (`src/gui/dataplotwidget/plotbase.cpp:67`) and the debugger screen (`src/gui/editorwidget/editorwindow.cpp:186`). Registration is *reversible and conditional*: a `Pin` joins the list if **either** an animation is running (`src/gui/circuitwidget/pin.cpp:376`) **or** a warning is active (`src/gui/circuitwidget/pin.cpp:366`), and leaves it only when both are off (`src/gui/circuitwidget/pin.cpp:377`), so a static circuit does not pay for hundreds of per-step callbacks.
2. `Simulator::addEvent(time, this)` — a *scheduled* callback at a future simulation time, with `Simulator::cancelEvents(this)` as its cancel. The engine's event time unit is the **picosecond**, established from two independent call sites: `IoPin` schedules its edge slices with `m_timeRis`, whose default is `3750` ps (`src/gui/circuitwidget/iopin.cpp:42`), and `PlotBase` converts its nanosecond "Test Time" property into picoseconds with `m_testTime*1e12` (`src/gui/dataplotwidget/plotbase.cpp:140`).

**The edge is modelled in the GUI.** `IoPin::runEvent()` (`src/gui/circuitwidget/iopin.cpp:96`) is the half of the digital/analogue bridge that lives in the graphics layer. An output change is not a jump: the pin interpolates its output voltage over `m_steps` slices (`m_steps = Simulator::self()->slopeSteps()`, `src/gui/circuitwidget/iopin.cpp:54`), scheduling the next slice on every call (`src/gui/circuitwidget/iopin.cpp:118`). The open-collector mode interpolates the *admittance* quadratically instead (`delta = qPow(1e4*step/m_steps, 2)`, `src/gui/circuitwidget/iopin.cpp:108`), which produces the soft pull-up of an open-drain driver rather than a hard edge.

**A state change mid-edge reverses the edge.** `IoPin::scheduleState()` (`src/gui/circuitwidget/iopin.cpp:123`) cancels the pending event and flips the ramp's phase (`m_step = m_steps-m_step`) so the transition continues from where it had got to instead of restarting. The ramp is a physical process with state, not a queued command — and that is why the cancellation is per-object (`cancelEvents(this)`) rather than a global flush.

**Time stepping is a three-quantity negotiation.** The Settings dialog holds the simulation speed in three representations simultaneously (`src/gui/appdialogs/appdialog.cpp:53`): picoseconds of simulated time per real second, simulation steps per real second, and the step *size* in picoseconds. Five engine knobs are read and written from that one dialog — `psPerSec()`, `stepsPerSec()`, `stepSize()`, `maxNlSteps()` (the Newton-Lorentz iteration cap) and `slopeSteps()` (the number of slices an edge is cut into); see `src/gui/appdialogs/appdialog.cpp:85`. The *reactive* step is `AnalogClock::getPeriod()` and the *real* step is `AnalogClock::getStep()`, i.e. the period divided by the clock's divider (`src/gui/appdialogs/appdialog.cpp:59`, `src/gui/appdialogs/appdialog.cpp:72`, `src/gui/appdialogs/appdialog.cpp:307`): the engine samples the netlist at the reactive rate and integrates the solution at the real one. The reactive step is persisted in the circuit file as the `reaStep` header attribute (`src/gui/circuitwidget/circuit.cpp:384` on load, `src/gui/circuitwidget/circuit.cpp:452` on save), so a saved circuit keeps the timing it was authored at.

## The scripting surface

Four distinct scripting entry points live in this layer, and they are worth separating because they have very different audiences.

1. **The property editor evaluates arithmetic** — `DSpinBox::valueFromText()` (`src/gui/properties/dspinbox.cpp:30`) runs whatever the user typed through the embedded AngelScript engine, so a resistor value field accepts `4.7k*2`. The engine is a static member shared by every spin box (`src/gui/properties/dspinbox.h`), and a failed evaluation yields `NAN`, which the validator turns into "Invalid" (`src/gui/properties/dspinbox.cpp:25`).
2. **A measurement instrument compiles a user condition** — `PlotBase::updateConds()` (`src/gui/dataplotwidget/plotbase.cpp:250`) expands the four-character shorthand `ch1l` into `(pb.ch1==1)` using the map built at construction (`src/gui/dataplotwidget/plotbase.cpp:59` — the source comment reads "Condition simple to script: ch1l to (ch1==1)"), wraps the result as `void pause() { pb.m_pause = <expr>; }`, compiles it, and caches the function. `PlotBase::conditonMet()` (`src/gui/dataplotwidget/plotbase.cpp:276`) calls it on every channel edge, and the simulation *pauses* when it evaluates true. The channel variables are ordinary AngelScript object properties (`src/gui/dataplotwidget/plotbase.cpp:49`).
3. **The GUI's own electrical twins are scriptable** — `IoPin::registerScript()` (`src/gui/circuitwidget/iopin.cpp:369`) exposes `setPinMode`, `getInpState`, `setOutState`, `setStateZ`, `setOutStatFast`, `scheduleState`, `getVoltage`, `setVoltage`, `setOutHighV`, `setImpedance`, `changeCallBack` and even `setX`/`setY`; `IoPort::registerScript()` (`src/gui/circuitwidget/ioport.cpp:200`) adds `addSequence(array<array<uint64>>@)`, `trigger(uint)` and a mask-valued `scheduleState`. This is the notable one: the classes the *canvas* draws are the classes a *script* drives, and they are the same objects.
4. **A script is the firmware** — `asDebugger::compile()` (`src/gui/editorwidget/debuggers/asdebugger.cpp:50`) compiles the script *inside the simulated CPU* rather than with an external toolchain, and then feeds the script's own types and member names back into the editor's completion and highlighting (`src/gui/editorwidget/debuggers/asdebugger.cpp:73`).

## Performance techniques in the GUI layer

The GUI is called once per simulation step, so every refresh path is a potential stall. Six distinct techniques keep it out of the way:

- **Flush text once per step, not once per write** — `OutPanelText::appendLine()` buffers and only writes when the simulation is idle, otherwise deferring to the next `updateStep()` (`src/gui/outpaneltext.cpp:39`); the console does the same (`src/gui/serial/console.cpp:41`).
- **Cap the log** — the output document is truncated at 1000 blocks (`src/gui/outpaneltext.cpp:32`) and again at 100000 characters (`src/gui/outpaneltext.cpp:54`), so a long session cannot grow without bound.
- **Refresh only what is visible** — `MCUMonitor::updateStep()` guards every table with an `isVisible()` check (`src/gui/memory/mcumonitor.cpp:136`, `src/gui/memory/mcumonitor.cpp:140`, `src/gui/memory/mcumonitor.cpp:145`), so an invisible tab costs nothing.
- **Throttle the memory dump** — `MemTable::updateTable()` refreshes only every tenth call (`src/gui/memory/memtable.cpp:44`).
- **Draw the envelope, not the samples** — `PlotDisplay` collapses points closer than 0.5 px into a min/max envelope (`src/gui/dataplotwidget/plotdisplay.cpp:310`) and walks the ring buffer backwards from the trigger, stopping as soon as it passes the visible start (`src/gui/dataplotwidget/plotdisplay.cpp:241`).
- **Cap the trace buffer** — `PlotBase::setBufferSize()` clamps the per-channel buffer to 10 000 000 samples (`src/gui/dataplotwidget/plotbase.cpp:199`), defaulting to 600 000 (`src/gui/dataplotwidget/plotbase.cpp:28`).

## Build system and packaging notes for this shard

The build files themselves (`SimulIDE.pri`, `build_XX/SimulIDE_Build.pro`) belong to the `build-root` shard, so this shard's contribution to the build is:

- **31 Qt Designer forms** (`*.ui`) that `uic` must turn into `ui_<name>.h` before compilation. Every one of the 31 has a matching `#include "ui_<name>.h"` in its header — the mapping is exact and complete, with no orphan form and no include without a form.
- **Every form is mixed in privately, and each form has exactly one host class** — all 31 declare `private Ui::X`. The base is `QDialog` for 10 of them (About, Settings, the installer info popup, the analyser and scope dialogs, the MCU monitor, the serial monitor and terminal, the shortcut manager, the property dialog), `QWidget` for 14, and `PropVal` for 7 of the property-value widgets (`BoolVal`, `ColorVal`, `EnumVal`, `NumVal`, `PathVal`, `StrVal`, `TextVal` — the eighth property widget, `LabelVal`, is a plain `QWidget` caption row). Because the mixin is *private*, a form's widgets are never part of a class's public API: to learn what a widget can do you must read the `.cpp`, not the header.
- **Forms carry explicitly untranslated placeholder strings.** 28 of the 31 `.ui` files contain `notr="true"` attributes — the Designer placeholder text (`TextLabel`, `Label`, `By:`) is marked *not to be translated*, so it is not routed through `tr()` and is not in the translation catalogue. The three forms with no `notr` attribute at all are `installer.ui`, `managecomps.ui` and `findreplace.ui`, whose visible strings are set in code instead.

## What would make circuit simulation viable as an August tool

Setting out the shard's own answer, which is not "an LLM writes GUI code" but "the document format, the component registry and the test oracle are all plain text and all live in the GUI layer":

1. **The circuit file is the interface.** `Circuit::toString()` writes one `<item name="value" .../>` line per component; `Circuit::loadStrDoc()` (`src/gui/circuitwidget/circuit.cpp:196`) reads it back; `Circuit::copy()` (`src/gui/circuitwidget/circuit.cpp:857`) puts the *same text* on the clipboard. An agent needs no editor, no live object graph and no binary format — it needs to emit text. This is the single most transferable fact in the shard.
2. **Undo/redo survives a text round-trip.** The undo stack stores "property name + previous string value" (`src/gui/properties/propval.cpp:49`) and, for structural changes, the whole serialised item under the pseudo-property `COMP_STATE_NEW` (`src/gui/circuitwidget/circuit.cpp:754`). An agent that emits text can therefore be diffed, previewed and rolled back with the same machinery.
3. **Components are declarative.** A component's editable surface is a list of properties, and each property is a template over the component type holding a getter/setter member-pointer pair (`src/gui/properties/boolprop.h:10`). The editor, the file format and the script surface all fall out of that one list.
4. **The palette is data, so a new part is a file.** `ComponentList::loadXml()` (`src/gui/componentlist/componentlist.cpp:200`) reads component sets from XML in the user's data folder; a compiled component is one line in `ItemLibrary::loadItems()` (`src/gui/componentlist/itemlibrary.cpp:149`).
5. **The test oracle travels with the circuit.** A measurement component carries `DoTest` and a `TestData` property holding the expected waveform (`src/gui/dataplotwidget/datachannel.cpp:85`), and `BatchTest` runs a folder of circuits and reports the failures (`src/gui/testing/batchtest.cpp:19`). An agent can author a circuit, run it headlessly, and check the captured waveform against a stored expectation — with no human in the loop.
6. **The missing piece is a headless entry point.** Everything above needs a process that can load a circuit, run it for N picoseconds, dump the captured traces and exit — and SimulIDE has no such mode in this shard. `BatchTest` is the closest thing, and it is a GUI-driven polling loop (`src/gui/testing/batchtest.cpp:81` — `QTimer::singleShot(100, ...)` rather than a signal) whose caller is outside this shard. For August, that driver is the piece worth building; the file format, the property system and the golden-trace comparator are already there to be driven by it.

## Per-file notes

### src/gui/appdialogs/about.cpp
- Purpose: The About dialog body.
- Key abstractions: plain `QDialog` + `Ui::AboutDialog` mixin; no model.
- Data flow: reads `APP_VERSION`, `REVNO`, `BUILDDATE` macros and `:/simulide.png` at construction.
- Non-obvious design decisions: forced `Qt::Tool` window flags so it behaves like a floating panel rather than a task-bar window.
- Edge cases / failure handling: none.
- Surprising: the whole dialog is 12 lines of code; the rest of the content is in the `.ui`.

### src/gui/appdialogs/about.h
- Purpose: Header for `AboutDialog`.
- Key abstractions: `private Ui::AboutDialog` (Qt's generated form mixin).
- Data flow: none.
- Non-obvious design decisions: the `.ui` is included as `ui_about.h`, the uic-generated include.
- Edge cases / failure handling: n/a.
- Surprising: no `Q_OBJECT` issues — it does have `Q_OBJECT`.

### src/gui/appdialogs/about.ui
- Purpose: Designer form for the About dialog.
- Key abstractions: Qt Designer XML; `QTabWidget` with Contributors and Translations tabs.
- Data flow: purely visual; the version strings are overwritten in `about.cpp`.
- Non-obvious design decisions: contributor names are baked into the form as static labels rather than a data file.
- Edge cases / failure handling: n/a.
- Surprising: I read the widget inventory and label strings rather than all 707 lines of XML; see *Uncertainties*.

### src/gui/appdialogs/appdialog.cpp
- Purpose: The Settings dialog: language, theme, font, user data path, auto-update, canvas options, simulation speed and engine parameters.
- Key abstractions: talks to `MainWindow::self()`, `Circuit::self()`, `CircuitView::self()`, `Simulator::self()`, `ThemeManager::self()`, `ComponentList::self()`, `AnalogClock::self()`.
- Data flow: reads current values into widgets at construction, then each `on_*` slot writes straight through to the singleton.
- Non-obvious design decisions: the speed is stored in three representations at once (steps/sec, step size, ps/sec) and `updtSpeed()`/`updtSpeedPer()` convert between them; an `m_blocked` flag prevents the two spin boxes from fighting each other during the conversion.
- Edge cases / failure handling: `m_stepUnit = log10(m_stepSize)/3` assumes a power-of-1000 step size; `on_simSpeedPerSlider_valueChanged` clamps 0 to 1.
- Surprising: `on_shortcutButton_released` (a `released` signal, not `clicked`) opens the component shortcut manager.

### src/gui/appdialogs/appdialog.h
- Purpose: Header for the Settings dialog.
- Key abstractions: declares every `on_<widget>_<signal>` auto-connect slot by name, which is what lets the `.ui` wire them without any `connect()` calls.
- Data flow: holds the speed-conversion state (`m_stepsPS`, `m_stepSize`, `m_psPerSec`, `m_stepUnit`).
- Non-obvious design decisions: the "reactive step" and "real step" boxes are read-only in effect — the dialog derives the real step from the target step and the AnalogClock divider rather than letting the user set both.
- Edge cases / failure handling: n/a.
- Surprising: three separate `helpButton<N>_clicked` slots all toggle the same `m_showHelp` flag and differ only in which tab's help text they load.

### src/gui/appdialogs/appdialog.ui
- Purpose: Designer form for the three-tab Settings dialog.
- Key abstractions: `QTabWidget` (`appTab`/`circTab`/`simTab`), `QComboBox` for language and theme, `QSlider` for speed, spin boxes with unit combo boxes for step sizes.
- Data flow: visual only.
- Non-obvious design decisions: each tab carries its own "Help" button that reveals a shared `helpText` pane below the tabs.
- Edge cases / failure handling: n/a.
- Surprising: the file also declares `helpText` as a `QTextEdit` that the dialog removes from the layout until help is requested.

### src/gui/appdialogs/currentwidget.cpp
- Purpose: The "Current Speed" slider shown while the current animation is on.
- Key abstractions: singleton (`m_pSelf`), a single `QSlider`.
- Data flow: slider value -> `pow(speed/150, 4.5)` -> `m_currentSpeed`, which `Connector::updateStep` and `ConnectorLine::paint` read.
- Non-obvious design decisions: the 4.5 power curve makes fine control possible at low current; the value is read by the animation code rather than pushed.
- Edge cases / failure handling: none.
- Surprising: the widget is `setVisible(false)` at construction and only shown by `Circuit::setAnimateCurr`.

### src/gui/appdialogs/currentwidget.h
- Purpose: Header for `CurrentWidget`.
- Key abstractions: static `self()`; `speed()` accessor.
- Data flow: none.
- Non-obvious design decisions: `getPos()`-style one-shot reset semantics are absent here — `m_changed = false` after `m_xValue` is written is dead code in the header.
- Edge cases / failure handling: n/a.
- Surprising: `showCurrentWidget()` is commented out in the header as well.

### src/gui/appdialogs/currentwidget.ui
- Purpose: Designer form: a "Current Speed:" label and a horizontal slider (1..1000, default 500).
- Key abstractions: `QSlider` with ticks both sides, interval 100.
- Data flow: visual only.
- Non-obvious design decisions: the slider's 0 is unusable (minimum is 1) because 0 speed would freeze the animation.
- Edge cases / failure handling: n/a.
- Surprising: the label carries a hand-written four-role palette block (~90 lines) that the theme manager does not touch.

### src/gui/appdialogs/infowidget.cpp
- Purpose: The telemetry strip: simulated time, target and real speed, engine load, GUI load, real FPS, overload, and the main MCU.
- Key abstractions: `Mcu::self()`/`eMcu::self()` for the device name and frequency.
- Data flow: `setRate(rate, simLoad, guiLoad, fps)` is called from the simulation loop; `setCircTime(tStep)` formats picoseconds down to ps.
- Non-obvious design decisions: `rate < 0` is a sentinel overload — `-1` renders "Speed: Debugger", any other negative renders "Circuit ERROR!!!"; and `simLoad > 101` means "over 100%", with the excess shown separately.
- Edge cases / failure handling: `updtMcu` falls back to "---" when no MCU is present.
- Surprising: `setCircTime` converts ps to h/m/s/ms/us/ns/ps by repeated subtraction of doubles, and adds a `1e-7` fudge before the ps conversion.

### src/gui/appdialogs/infowidget.h
- Purpose: Header for `InfoWidget`.
- Key abstractions: `private Ui::infoWidget`.
- Data flow: the setters are the only API.
- Non-obvious design decisions: `updtMcu()` is public because the MCU can change without the rate changing.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/appdialogs/infowidget.ui
- Purpose: Designer form for the telemetry strip.
- Key abstractions: plain `QLabel`s in a `layoutWidget`.
- Data flow: visual only.
- Non-obvious design decisions: every value is a label, not a widget with a model.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (816 lines); see *Uncertainties*.

### src/gui/circuitwidget/circuit.cpp
- Purpose: The document model and the canvas. `Circuit` is a `QGraphicsScene` that owns every component, connector and node, parses and writes the `.sim2` file format, implements undo/redo, draws the grid and handles canvas keyboard shortcuts.
- Key abstractions: `CompBase` property groups (what is saved), `compChange`/`circChange` (the undo records), `m_compList`/`m_connList`/`m_nodeList` (the model) and `m_compMap`/`m_pinMap`/`m_idMap` (the indices).
- Data flow: `loadStrDoc()` parses the file line by line into components; `circuitToString()` walks the model and calls `comp->toString()` on each item; `createItem()` delegates to `ItemLibrary::self()->createItem(type, id)`.
- Non-obvious design decisions: (1) **Undo is implemented by serialisation, not by diffing a model.** `beginUndoStep()` (line 733) snapshots every item's `toString()` into `m_compStrMap`; `calcCircuitChanges()` (line 754) then diffs the *lists* of items and records a create/remove as a property named `COMP_STATE_NEW` whose "value" is the whole serialised item. `restoreState()` (line 789) re-instantiates a removed item by feeding its serialised form back through `loadStrDoc()`. (2) The same `loadStrDoc()` serves three jobs: loading a file, pasting from the clipboard, and undo/redo — because all three speak the same text format. (3) `Circuit::copy()` puts the *same* text format on the clipboard (line 857), so paste is literally "load a document".
- Edge cases / failure handling: `loadStrDoc` falls back to finding a pin by *position* when its id is not found (lines 252-263) — robust to files whose ids no longer match; the connector id counter is adjusted when a loaded id is higher than the current counter; `loadCircuit` clears the whole circuit if `m_error != 0`.
- Surprising: `m_compStrMap.clear()` carries the comment `/// FIXME: optimize this, we are saving the whole circuit every time` — undo snapshots the entire circuit's text on every step.

### src/gui/circuitwidget/circuit.h
- Purpose: Header for the `Circuit` scene.
- Key abstractions: the `compChange` struct (component, property, undoValue, redoValue) and `circChange` (a list of them) are the undo stack's unit; `propGroup` flags `groupHidden`/`groupNoCopy` live in `compbase.h`.
- Data flow: the public API is what the rest of the app drives (`loadCircuit`, `saveCircuit`, `newconnector`, `closeconnector`, `createComponent`, `addCompChange`).
- Non-obvious design decisions: `m_maxUndoSteps` defaults to 100 when the setting is 0; `isBusy()` ORs `m_busy`, `m_pasting` and `m_deleting` together.
- Edge cases / failure handling: most mutators early-return when `m_conStarted` (a wire drag is in progress).
- Surprising: `m_LdPinMap` is a *second* pin map kept only while loading/pasting, so that undo/redo can resolve pins against the current state instead of the load-time state.

### src/gui/circuitwidget/circuitview.cpp
- Purpose: The `QGraphicsView` on top of the scene: zooming, panning, palette drag-and-drop, copy-by-drag, the context menu, and image export.
- Key abstractions: `Circuit` (scene), `ComponentList` (palette), `ThemeManager` (icons).
- Data flow: a drag from the palette carries the MIME text `name,type`; `dragEnterEvent` (line 96) creates the component immediately on the scene, `dragMoveEvent` moves it, and `dragLeaveEvent` removes it and pops the undo entry.
- Non-obvious design decisions: the component is created on *drag enter*, not on drop — that is what makes the ghost preview work. The "copy by drag" (Ctrl+Shift, lines 194-202) does `beginCircuitBatch()` -> `copy()` -> `paste()` so the paste itself does not save an undo step, and the subsequent move does.
- Edge cases / failure handling: the wheel zoom uses `pow(2, delta/700)` so the zoom is continuous rather than stepped; `saveImage` renders the *scene* (not the view) into an `QSvgGenerator` for SVG.
- Surprising: `zoomToFit()` uses `fitInView(rect, KeepAspectRatio)` with no explicit scale clamp, so an empty circuit zooms to an arbitrary scale.

### src/gui/circuitwidget/circuitview.h
- Purpose: Header for `CircuitView`.
- Key abstractions: `m_scale` tracks the zoom so `getScale()` can be queried.
- Data flow: n/a.
- Non-obvious design decisions: the class is not `Q_OBJECT` — it uses the old-style `connect(action, SIGNAL(...), ...)` for the context-menu actions.
- Edge cases / failure handling: n/a.
- Surprising: `Q_UNUSED`-style members `m_help` and `m_eventpoint` are vestigial.

### src/gui/circuitwidget/circuitwidget.cpp
- Purpose: The panel that hosts the canvas: toolbar, the output pane, the info and current widgets, and the power/pause/debug controls.
- Key abstractions: `QSettings` for the recent-circuit list; `Simulator::self()` for start/stop/pause.
- Data flow: `powerCircOn()` calls `Simulator::self()->startSim()`; `powerCircDebug()` calls `startSim(true)`; `newCircuit()` prompts to save if the window title ends with `*`.
- Non-obvious design decisions: the "running/stopped/paused/debug" state is encoded in three different places at once — the power action's `iconText()` ("On"/"Off"/"Debug"), the main window's state string ("▶"/"■"/"❚❚") and the message label's colour. `setMsg(msg, type)` maps a type integer to a stylesheet colour.
- Edge cases / failure handling: `loadCirc` refuses any path that does not end in `.sim2`/`.sim1`; `openRecentFile` offers to purge a missing file from the recent list.
- Surprising: `updateIcons()` re-themes every icon from `ThemeManager` but the power/pause icons are deliberately *not* re-themed (that code is commented out) because their state is meaningful.

### src/gui/circuitwidget/circuitwidget.h
- Purpose: Header for `CircuitWidget`.
- Key abstractions: `enum { MaxRecentFiles = 20 }`; the `recentFileActs[]` array is pre-created so the menu order is stable.
- Data flow: `dataAvailable(int uart, const QByteArray&)` is the signal other panels (serial monitor) connect to.
- Non-obvious design decisions: the widget owns `CircuitView` and `OutPanelText` *by value* (not as pointers), which is why they are declared as members with initialisers in the constructor.
- Edge cases / failure handling: n/a.
- Surprising: `simDebugMessage()` strips `"` from the message before appending.

### src/gui/circuitwidget/compbase.cpp
- Purpose: The base of every item that can appear in a circuit or a property dialog: it owns the property groups, applies properties, and serialises them.
- Key abstractions: `propGroup` (name, `QList<ComProperty*>`, flags) and `m_propMap` (name -> property).
- Data flow: `setPropStr(prop, val)` finds the `ComProperty` and calls `setValStr`; `toString()` walks the groups and emits one `<item name="value" .../>` line.
- Non-obvious design decisions: `toString()` skips the `"Board"` group unless the item is inside a subcircuit board, so board-level properties never leak into a saved circuit.
- Edge cases / failure handling: an unknown property falls through to the virtual `propNotFound()`, which is how old file formats are still readable (see `PlotBase::propNotFound`).
- Surprising: the property map is a `QMap<QString, ComProperty*>` *and* the group list holds raw pointers to the same objects — two views of one ownership, with the destructor deleting the map's values.

### src/gui/circuitwidget/compbase.h
- Purpose: Header for `CompBase`.
- Key abstractions: `groupFlags { groupHidden = 1, groupNoCopy = 1<<1 }`; `simulideTr(comp_name, str)` is the per-component translation macro.
- Data flow: `properties()` returns a *pointer* to the group list because "properties can change (ex: loadHex changes Config)".
- Non-obvious design decisions: `CompBase` deliberately does not inherit from `QObject` — it is the non-Qt half of a component, which is exactly why the property dialog, the code editor and the compiler can all reuse it.
- Edge cases / failure handling: n/a.
- Surprising: `CompBase` lives in the GUI tree while `Component` (its Qt subclass) lives in `src/components/` — the GUI owns the *base class* of the model.

### src/gui/circuitwidget/connbase.cpp
- Purpose: Base for graphical multi-pin connectors (bus taps, headers): it creates and destroys the paired "connector" and "socket" pins and wires them into the electrical net.
- Key abstractions: `m_pin`/`m_sockPins` vectors; `eElement::registerEnode`.
- Data flow: `createPins(c)` allocates `c` new pairs, each a `Pin` (180 deg) and a `Pin` (90 deg, length 1, `ItemStacksBehindParent` off); `setSize()` grows or shrinks the set and stops the simulation first.
- Non-obvious design decisions: `setSize()` powers the circuit off before touching the pin count, because adding pins changes the netlist mid-run.
- Edge cases / failure handling: `deletePins` clamps the delete count to the current size.
- Surprising: `registerEnode` uses `n < m_size` to decide whether the pin is a socket or a connector — the two halves are index-disjoint halves of one index space.

### src/gui/circuitwidget/connbase.h
- Purpose: Header for `ConnBase`.
- Key abstractions: `m_connPins`/`m_sockPins` as `std::vector<Pin*>`; `Pin::pinType_t m_pinType`.
- Data flow: n/a.
- Non-obvious design decisions: `updatePins()` is a no-op hook for subclasses.
- Edge cases / failure handling: n/a.
- Surprising: `ConnBase` inherits from both `Component` (graphics) and `eElement` (electrical) — the multiple-inheritance pattern used throughout SimulIDE.

### src/gui/circuitwidget/connector.cpp
- Purpose: A wire: an ordered list of `ConnectorLine`s plus the electrical connection between two pins.
- Key abstractions: `m_pointList` (the serialised geometry, a flat "x,y,x,y" string), `m_conLineList`, `m_startPin`/`m_endPin`.
- Data flow: `updateStep()` (line 51) is the per-simulation-step hook: it reads the current from the start pin, scales it by the user's current-speed slider, accumulates `m_step` and asks each line to update its length. `getCurrent()` (line 445) prefers the start pin's current and falls back to the negated end pin's.
- Non-obvious design decisions: the router is a hand-written Manhattan router. `updateConRoute` decides whether to add a new corner, update the first corner or update the last corner based on which end is being dragged (`pin == m_startPin`), and `remNullLines()` then merges any two consecutive segments that share a dx or a dy.
- Edge cases / failure handling: `remNullLines` refuses to touch diagonal lines (a diagonal is an intentional user-drawn segment, e.g. Shift-drag free line); `move()` only moves during a paste, otherwise a wire move would desynchronise the electrical net.
- Surprising: `splitCon(index, pin0, pin2)` splits one wire into two at a `Node`, and the comment `// Close con1 first please` marks a real ordering dependency.

### src/gui/circuitwidget/connector.h
- Purpose: Header for `Connector`.
- Key abstractions: `m_actLine` (the segment currently being dragged), `m_freeLine` (the user asked for a diagonal), `m_isBus`.
- Data flow: n/a.
- Non-obvious design decisions: `dummySetter(QString)` exists so the class can declare read-only properties in the property system.
- Edge cases / failure handling: n/a.
- Surprising: `getVoltage()` is just `m_startPin->getVoltage()` — the whole wire is one net.

### src/gui/circuitwidget/connectorline.cpp
- Purpose: One straight segment of a wire: painting, corner dragging, and the "click a wire to branch it" interaction.
- Key abstractions: `QGraphicsItem` with `Type = UserType + 2` (the type tag the scene uses to tell wires from components).
- Data flow: `paint()` (line 395) picks the colour — dark grey when selected, dark green for a bus, red/blue for high/low when logic animation is on, otherwise the theme's foreground colour — and, when current animation is on, draws a chain of ellipses along the line whose spacing is `m_step`.
- Non-obvious design decisions: `shape()` returns a 4-pixel-wide polygon rather than a line, so the wire is easy to hit; `connectToWire()` (line 183) either joins the endpoint to the new wire or splits the segment in two and inserts a `Node`.
- Edge cases / failure handling: `connectToWire` refuses to connect a bus to a non-bus (`m_isBus != line->connector()->isBus()`); the first and last segments of a wire cannot be dragged (`move()` returns early).
- Surprising: `updtLength()` divides by 8 because the grid is 8 pixels — the wire length in "grid cells" is what the current animation uses.

### src/gui/circuitwidget/connectorline.h
- Purpose: Header for `ConnectorLine`.
- Key abstractions: `Q_INTERFACES(QGraphicsItem)`; `setP1`/`sSetP1` distinction — `setP1` also updates the *previous* line's endpoint, `sSetP1` does not (a "silent" setter used during the re-route).
- Data flow: n/a.
- Non-obvious design decisions: the prev/next link pair makes the wire a doubly-linked list of segments, which is what allows one segment to be moved without breaking the chain.
- Edge cases / failure handling: n/a.
- Surprising: `m_foreColor` is a `uint32_t*` into the theme manager's colour vector, so a theme change recolours every wire with no per-wire update.

### src/gui/circuitwidget/dialed.cpp
- Purpose: A component that shows a knob (or slider) on the canvas and exposes a numeric value.
- Key abstractions: `DialWidget` embedded as a `QGraphicsProxyWidget`.
- Data flow: the dial's `valueChanged` signal -> `dialChanged(int)` -> map 0..1000 onto [min, max] -> `updtValue()` writes back to the dial (guarded by `m_blocked`).
- Non-obvious design decisions: the knob is 0..1000 and the *component* owns the min/max mapping, so the same widget serves every value range; `m_step > 0` rounds the value to a multiple of the step.
- Edge cases / failure handling: `setMinVal`/`setMaxVal` clamp against each other and against zero (`1e-12`).
- Surprising: `setSlider()` reconnects the `valueChanged` lambda without disconnecting the old one — the `QObject::disconnect` call is commented out, so switching knob/slider mode leaves two live connections.

### src/gui/circuitwidget/dialed.h
- Purpose: Header for `Dialed`.
- Key abstractions: `virtual void setLinkedValue(double v, int i=0)` — index 0 sets the knob, non-zero sets the value.
- Data flow: n/a.
- Non-obvious design decisions: `m_areaDial` vs `m_areaComp` — hiding the component shrinks its clickable area to just the knob.
- Edge cases / failure handling: n/a.
- Surprising: `updateProxy()` is declared but empty in the base class.

### src/gui/circuitwidget/iopin.cpp
- Purpose: The electrically live pin: implements input / open-collector / output / source drive modes with real admitances, and the output voltage ramp.
- Key abstractions: `ePin` (engine side) + `Pin` (graphics side); the electrical state is in the admitances `m_vddAdmit`/`m_gndAdmit` plus the extra `m_vddAdmEx`/`m_gndAdmEx` for pull-ups and references.
- Data flow: `stamp()` (line 61) registers the pin with the engine and stamps its current; `runEvent()` (line 96) is the *event-scheduled* ramp — it is called by `Simulator::self()->addEvent(time/m_steps, this)` and interpolates the output voltage over `m_steps` steps, so a logic edge is modelled as a finite rise/fall time (`m_timeRis`/`m_timeFal`, default 3750 ps).
- Non-obvious design decisions: the open-collector mode's ramp is quadratic (`delta = qPow(1e4*step/m_steps, 2)`) rather than linear, giving a soft pull-up characteristic. `scheduleState()` cancels pending events when the state changes mid-ramp (`m_step = m_steps - m_step`) so the ramp reverses smoothly from where it was.
- Edge cases / failure handling: `setUserInverted` pauses and resumes the simulation around the inversion, because inverting an output changes the netlist's logic level.
- Surprising: the file ends with `IoPin::registerScript(asIScriptEngine*)` (line 369) — the *GUI* class registers itself into the embedded AngelScript engine, exposing `setPinMode`, `getInpState`, `setOutState`, `scheduleState`, `getVoltage`, `setVoltage`, `changeCallBack` and even `setX`/`setY` to circuit scripts.

### src/gui/circuitwidget/iopin.h
- Purpose: Header for `IoPin`.
- Key abstractions: `pinMode_t { undef_mode, input, openCo, output, source }`; the static `eNode m_gndEnode` shared by every pin.
- Data flow: n/a.
- Non-obvious design decisions: `getOutState()` returns `m_nextState` while a ramp is in progress (`if (m_step) return m_nextState;`), i.e. the *target* state is published while the pin is still moving.
- Edge cases / failure handling: `hasCurrent()` returns false for a `source` pin (an ideal source supplies current without drawing it).
- Surprising: `setOutStatFast()` sets the output voltage *and* stamps the current in one go, bypassing the ramp entirely — used for initialisation.

### src/gui/circuitwidget/ioport.cpp
- Purpose: A port grouping several `IoPin`s behind a bit mask (an MCU port), with a scripted output waveform.
- Key abstractions: `m_pinState`/`m_nextState` bit masks, `m_pinDirection` mask, and `std::vector<std::vector<outState_t>> m_outVectors` (a list of timed output sequences).
- Data flow: `setOutState(val)` XORs against the current state and only touches the pins whose bit changed (lines 72-82); `addSequence(CScriptArray*)` (line 185) converts a script-supplied array of (time, state) pairs into the internal sequence form, and `trigger(n)` starts one.
- Non-obvious design decisions: the "changed" mask is the core optimisation — writing a port does not touch the pins that did not change.
- Edge cases / failure handling: `trigger` refuses to start a new sequence while one is running (`m_index != 0`) and refuses an out-of-range index.
- Surprising: `IoPort::registerScript` (line 200) exposes `addSequence(array<array<uint64>>@)`, `trigger(uint)` and `scheduleState(uint32,uint64)` to the script engine — this is how a circuit script drives a whole port.

### src/gui/circuitwidget/ioport.h
- Purpose: Header for `IoPort`.
- Key abstractions: `struct outState_t { uint64_t time; uint64_t state; }`; the port owns `std::vector<IoPin*> m_pins`.
- Data flow: n/a.
- Non-obvious design decisions: `friend class McuCreator` — the MCU factory creates ports directly.
- Edge cases / failure handling: n/a.
- Surprising: the header includes `iopin.h` twice.

### src/gui/circuitwidget/label.cpp
- Purpose: A free-standing text annotation attached to a component.
- Key abstractions: `QGraphicsTextItem` with a `Component` parent.
- Data flow: `updtLabelPos()` recomputes the position from the stored offset, the rotation and the parent's flips.
- Non-obvious design decisions: `adjustPos()` (line 122) corrects the anchor for each of the four rotations and for both flips, so a rotated label stays visually attached rather than pivoting around its bounding box origin.
- Edge cases / failure handling: `contextMenuEvent` ignores the event if the label is disabled.
- Surprising: the label's own `document()->contentsChange` signal is connected to `updateGeometry(int,int,int)` which just resets the text width to -1 — an odd way to force a relayout.

### src/gui/circuitwidget/label.h
- Purpose: Header for `Label`.
- Key abstractions: `m_labelx`/`m_labely` (the saved offset) and `m_labelrot` (0/±90/180).
- Data flow: n/a.
- Non-obvious design decisions: `itemType()` returns the string `"Label"`, matching the file format's item type.
- Edge cases / failure handling: n/a.
- Surprising: `updateGeometry(int, int, int)` is a slot with unnamed parameters.

### src/gui/circuitwidget/pin.cpp
- Purpose: The graphical and electrical terminal on a component.
- Key abstractions: `pinState_t` (eight states), `Pin::pinType_t`, the `ePin` engine interface, and `m_label` (a `QGraphicsSimpleTextItem` child).
- Data flow: `registerPinsW`/`registerEnode` (lines 105-130) propagate the net connection from one side of a connector to the other and then into the component; `updateStep()` is the per-step repaint hook.
- Non-obvious design decisions: **`Pin::isMoved()` (line 191) implements auto-connect**: when a component is moved and Shift is held, `connectPin(true)` looks for a colliding pin within 3 pixels, of the same bus-ness, and wires them automatically. `connectPin(false)` is the "find a candidate to snap to" query. Also, `setLabelText` treats a leading `!` as an inversion marker and draws an overscore, and works around the `ItemStacksBehindParent` flag so the overscore is actually painted.
- Edge cases / failure handling: `m_blocked` guards the recursive `registerPinsW` <-> `registerEnode` pair; a pin whose `connector()` is already set is skipped.
- Surprising: `pinState_t` values are ordered so that a comparison against `input_low` / `out_low` / `driven_low` in `paint()` decides which arrow to draw — the enum's numeric order *is* the drawing logic.

### src/gui/circuitwidget/pin.h
- Purpose: Header for `Pin`.
- Key abstractions: the eight-value `pinState_t`; `pinType_t { pinNormal, pinSocket, pinHeader, pinNull, pinRst }`; `Type = UserType + 3`.
- Data flow: n/a.
- Non-obvious design decisions: `m_overScore` is a tri-state (-1 none, 0/1 inverted) that also drives the `ItemStacksBehindParent` flag.
- Edge cases / failure handling: n/a.
- Surprising: the label is a *separate* `QGraphicsSimpleTextItem` rather than text on the pin itself, so it can be positioned and flipped independently.

### src/gui/circuitwidget/updatable.cpp
- Purpose: The `Updatable` mixin's destructor.
- Key abstractions: `Simulator::self()->remFromUpdateList(this)`.
- Data flow: n/a.
- Non-obvious design decisions: **removal from the simulator's update list happens in the destructor**, so a widget that is deleted simply stops being called — no explicit teardown is required by every subclass.
- Edge cases / failure handling: n/a.
- Surprising: this 14-line file is the mechanism that makes the whole "per-simulation-step GUI refresh" pattern safe.

### src/gui/circuitwidget/updatable.h
- Purpose: The header for the `Updatable` mixin — the whole per-simulation-step callback contract.
- Key abstractions: `class Updatable` with a constructor, a destructor and exactly one virtual method, `virtual void updateStep(){;}`.
- Data flow: n/a — the header declares no state at all.
- Non-obvious design decisions: **the mixin has no `QObject` base and no signals.** It is a plain C++ class with a single no-op virtual, so any class can mix it in (SimulIDE uses multiple inheritance pervasively: `ConnBase` is both a `Component` and an `eElement`). The default implementation is an empty body, so a subclass that has nothing to refresh per step still satisfies the contract.
- Edge cases / failure handling: none in the header; the destructor in `updatable.cpp` handles the only lifecycle requirement (unregistering from the simulator).
- Surprising: the header is 15 lines and declares **no members at all** — the entire mechanism is "inherit this and override one method", which is what makes it safe to sprinkle across the canvas, the console, the memory table, the debugger and the serial monitor.

### src/gui/componentlist/componentlist.cpp
- Purpose: The component palette: builds the categorised tree from XML component sets and from installed libraries, supports search, drag-to-canvas, shortcuts, and persists the tree layout.
- Key abstractions: `m_components`/`m_categories` name -> `TreeItem` maps; `ItemLibrary` for the built-in components; `m_shortCuts` for the Alt+key shortcuts.
- Data flow: `createList()` loads the library first, then the user's data folder, then the config data folder, then the installed component sets, and finally reads `compList.xml` to restore the user's tree arrangement. `loadXml()` (line 200) parses an `<itemlib>` document with `<itemset category="..." type="..." folder="...">` and `<item name="...">` children.
- Non-obvious design decisions: the palette is **data-driven** — a new component can be shipped as an XML set with its own icon and metadata without recompiling. A component set can even point at a subcircuit folder, in which case the palette reads the subcircuit's `.sim2` file to extract the icon embedded in an `Image` component (lines 289-318).
- Edge cases / failure handling: `loadXml` skips malformed sets with a debug message; `createList` hides categories that ended up empty; an existing component that appears in a second set is *moved* rather than duplicated (lines 261-269).
- Surprising: `slotItemClicked` starts a `QDrag` with the MIME text `name,type` — the entire drag-and-drop component protocol is one comma-separated string, parsed in `CircuitView::dragEnterEvent`.

### src/gui/componentlist/componentlist.h
- Purpose: Header for the palette.
- Key abstractions: `m_dataFileList`/`m_dirFileList` map a component name to the file it came from and the folder it lives in.
- Data flow: n/a.
- Non-obvious design decisions: `getComponent(shortcut)` is what `Circuit::keyPressEvent` calls for Alt+key component placement.
- Edge cases / failure handling: n/a.
- Surprising: `m_xmlItems` is a flat list of the components added by the *last* XML file loaded — `Installer::loadInstalled` uses it to record which items a set contributed.

### src/gui/componentlist/installer.cpp
- Purpose: Downloads and installs component sets from `simulide.com`.
- Key abstractions: `QNetworkAccessManager`; `qZipReader` for extraction; `m_installed` name -> version map persisted in `QSettings` under `library/installed`.
- Data flow: `checkForUpdates()` GETs `components.txt` (a `;`-separated manifest); `installItem()` GETs the set's zip; `itemDataReady()` writes it to disk, extracts it with `qZipReader::extractAll`, records the version and reloads the whole palette with `ComponentList::self()->createList()`.
- Non-obvious design decisions: installation is expressed as a *dependency chain* — `installItem` follows `m_depends` first and remembers `m_nextItem` to install the original afterwards (lines 189-195, 279). The update check uses `NoLessSafeRedirectPolicy` and a 5-second transfer timeout.
- Edge cases / failure handling: a failed download removes the pending item and leaves the installed map untouched; a failed extraction removes the item from the installed map; the zip is deleted after extraction.
- Surprising: `Installer::Installer` reads the installed version from settings but then **overwrites it with the hard-coded string `"2507102250"`** (line 51) — the version comparison in `shouldUpdate` is therefore not driven by the stored value.

### src/gui/componentlist/installer.h
- Purpose: Header for `Installer`.
- Key abstractions: `QMap<QString, InstallItem*> m_items` (available sets), `QMap<QString, int64_t> m_installed`, `QMap<QString, QStringList> m_groupItemList` (which items each set contributed).
- Data flow: n/a.
- Non-obvious design decisions: the widget is a `QWidget`, not a dialog — it is embedded in the main window.
- Edge cases / failure handling: n/a.
- Surprising: `m_checkUpdates` is hard-coded `true` (the `false` alternative is commented out).

### src/gui/componentlist/installer.ui
- Purpose: Designer form: a "Check for Updates" button above a single-column table.
- Key abstractions: `QTableWidget` with the horizontal header hidden; each row's cell 0 holds an `InstallItem` widget.
- Data flow: visual only.
- Non-obvious design decisions: the table is populated programmatically, one `InstallItem` widget per row (`installTable->setCellWidget(row, 0, item)`).
- Edge cases / failure handling: n/a.
- Surprising: the row height is set to 25 or 60 depending on whether the set has a description.

### src/gui/componentlist/installinfo.cpp
- Purpose: The "about this component set" popup.
- Key abstractions: `QDialog` over `Ui::installInfo`.
- Data flow: takes the title, author and item list from the `InstallItem` that opened it.
- Non-obvious design decisions: the title and author are wrapped in `**` because the labels are markdown-formatted.
- Edge cases / failure handling: none.
- Surprising: the class has no `Q_OBJECT` (it is commented out in the header).

### src/gui/componentlist/installinfo.h
- Purpose: Header for `InstallInfo`.
- Key abstractions: none beyond the `Ui` mixin.
- Data flow: n/a.
- Non-obvious design decisions: the constructor takes the `InstallItem*` and casts it to `QWidget*` to be the dialog's parent.
- Edge cases / failure handling: n/a.
- Surprising: `//Q_OBJECT` is commented out — this dialog has no signals or slots.

### src/gui/componentlist/installinfo.ui
- Purpose: Designer form for the "about this component set" popup.
- Key abstractions: a `QDialog` with a vertical layout holding `tittleLabel` (`QLabel`), `authorLabel` (`QLabel`) and `listEdit` (`QTextEdit`).
- Data flow: visual only — `installinfo.cpp` writes the title, the author and the item list into the three widgets.
- Non-obvious design decisions: both labels declare `textFormat` = `Qt::MarkdownText` and `textInteractionFlags` = `Qt::NoTextInteraction` — the labels *render* markdown (that is why `installinfo.cpp` wraps the title in `**`) but are not selectable or clickable. The item list is a `QTextEdit` whose `textInteractionFlags` are `TextSelectableByKeyboard|TextSelectableByMouse` (no `TextEditable`), so the contents are selectable but cannot be edited — the form does this instead of calling `setReadOnly` in code.
- Edge cases / failure handling: n/a.
- Surprising: the widget is named `tittleLabel` — the misspelling is in the form, in the generated header and in the .cpp, consistently; and the `listEdit` carries a hard-coded HTML stylesheet blob (Ubuntu font, 10pt) as its `html` property.

### src/gui/componentlist/installitem.ui
- Purpose: Designer form for one row of the installer table.
- Key abstractions: a frameless `QTextEdit` for the set name, a second `QTextEdit` for the description, and three 22x22 `QToolButton`s (info, update, install).
- Data flow: visual only; `installitem.cpp` sets the text and tooltips.
- Non-obvious design decisions: the name field is a `QTextEdit` rather than a `QLabel` so it can render markdown headings.
- Edge cases / failure handling: n/a.
- Surprising: the buttons are laid out at columns 1, 2 and 3 of a `QGridLayout` with the name at column 0 and the description spanning all four columns.

### src/gui/componentlist/installitem.cpp
- Purpose: One component set in the installer table: parses its descriptor, renders it, and drives install/uninstall.
- Key abstractions: `buttonState_t { bInstall, bUpdate, bUninstall }`; the descriptor is a `;`-separated string.
- Data flow: `setItem(itemStr)` splits on `"; "` and takes field 0 = name, 1 = description, 2 = file, 3 = version, 4 = dependency, 5 = author. A set with fewer than four fields is a *category* row (no buttons, larger heading).
- Non-obvious design decisions: the button's appearance encodes the state by colour (green install, red uninstall, yellow update) and by icon, so no text is needed.
- Edge cases / failure handling: `shouldUpdate(v)` compares `m_version` against `m_versionNext` and only offers an update when the two differ.
- Surprising: `toString()` (the persisted form) writes only `name;version` — the rest of the descriptor is re-fetched from the remote manifest.

### src/gui/componentlist/installitem.h
- Purpose: Header for `InstallItem`.
- Key abstractions: `friend class Installer` — the installer owns the items and sets `m_version` directly.
- Data flow: n/a.
- Non-obvious design decisions: the `m_itemStr` keeps the raw descriptor for re-parsing.
- Edge cases / failure handling: n/a.
- Surprising: `int64_t version()` accessor is commented out, so version state is read through the button state.

### src/gui/componentlist/itemlibrary.cpp
- Purpose: The built-in component registry.
- Key abstractions: `LibraryItem` with a `createItemPtr` factory function pointer; `ItemLibrary::createItem(type, id)` scans the list for the first entry whose type list contains the requested type.
- Data flow: `loadItems()` (line 149) adds ~130 entries in category order; each entry is either a category marker (`createItem == nullptr`) or a real component's own `libraryItem()`.
- Non-obvious design decisions: **the registry is a flat list with a type string, and the type string is matched against a comma-separated list.** A component that wants several names (e.g. `"Subcircuit,MCU"`) registers once. The file opens with a 125-line include block ("BEGIN Item includes") — adding a component means adding the include and one `addItem` line.
- Edge cases / failure handling: `createItem` returns `nullptr` for an unknown type, and `Circuit::createItem` logs "ERROR Creating Component" and skips the item when loading a file.
- Surprising: the Arduino/AVR/PIC/I51/MCS65/Z80/STM32/Espressif/Shields categories are *empty placeholders* — `LibraryItem` with a null factory, waiting for the MCU packs.

### src/gui/componentlist/itemlibrary.h
- Purpose: Header for the registry.
- Key abstractions: `typedef Component* (*createItemPtr)(QString type, QString id)`.
- Data flow: n/a.
- Non-obvious design decisions: `LibraryItem` stores both a `m_type` (the first of the list) and the full `m_typeList`.
- Edge cases / failure handling: n/a.
- Surprising: `isType()` is the only query; there is no lookup by name, because the palette looks components up by *type*.

### src/gui/componentlist/managecomps.cpp
- Purpose: The "Manage Shortcuts" dialog: assigns a single-character keyboard shortcut to each component.
- Key abstractions: two `QMap<QTableWidgetItem*, TreeItem*>` maps to resolve an edited table cell back to its tree item.
- Data flow: `initialize(treeItem)` flattens the tree into a two-column table; `slotItemChanged` (line 98) truncates the shortcut to one character and writes it to both the tree item and `ComponentList::setShortcut()`.
- Non-obvious design decisions: the tree item is highlighted in yellow when the dialog is opened from a specific component's context menu, so the user can see which row they are editing.
- Edge cases / failure handling: the "column 0 = show/hide" branch is entirely commented out; only the shortcut column is live.
- Surprising: `m_treeToList.key( treeItem )` uses `QMap::key()` — a *reverse* lookup by value, which is O(n) and ambiguous if two items had the same pointer.

### src/gui/componentlist/managecomps.h
- Purpose: Header for the shortcut manager.
- Key abstractions: the two item -> tree maps.
- Data flow: n/a.
- Non-obvious design decisions: `m_initialized` guards the one-time table build.
- Edge cases / failure handling: n/a.
- Surprising: the class is named `manCompDialog` while the file is `managecomps.*`.

### src/gui/componentlist/managecomps.ui
- Purpose: Designer form: a two-column `QTableWidget` in a dialog titled "Component Shortcuts".
- Key abstractions: `QTableWidget` with columnCount 2.
- Data flow: visual only.
- Non-obvious design decisions: the column headers are set in code (`Component`, `ShortCut`), not in the form.
- Edge cases / failure handling: n/a.
- Surprising: the layout has zero margins so the table fills the dialog.

### src/gui/componentlist/qzipreader.cpp
- Purpose: Zip extraction for the component installer.
- Key abstractions: **vendored Qt private API** — the file carries the 2009 Nokia Corporation copyright and the Qt LGPL v2.1 text, and includes `qglobal.h`, `qplatformdefs.h` and `zlib.h`.
- Data flow: `qZipReader::extractAll()` inflates the archive into a destination directory.
- Non-obvious design decisions: SimulIDE vendors Qt's private `qZipReader` rather than depending on `QZipReader` (Qt 5.14+) or a third-party library, so it builds against older Qt versions.
- Edge cases / failure handling: the Windows `S_ISREG`/`S_ISDIR`/`S_ISLNK` macros are hand-defined for MSVC.
- Surprising: the file is 580 lines of upstream Qt with a `ZDEBUG` macro — **not SimulIDE logic**. I read the first 120 lines to confirm provenance and did not read it line by line.

### src/gui/componentlist/qzipreader.h
- Purpose: Header for the vendored zip reader.
- Key abstractions: `qZipReader` with a `Q_AUTOTEST_EXPORT` `FileInfo` struct and a `Status` enum.
- Data flow: n/a.
- Non-obvious design decisions: it is wrapped in `QT_BEGIN_NAMESPACE`/`QT_END_NAMESPACE` and guarded by `#ifndef QT_NO_TEXTODFWRITER`, exactly as upstream.
- Edge cases / failure handling: n/a.
- Surprising: the header text still contains the upstream typo "this package." in the licence block (line 14).

### src/gui/componentlist/treeitem.cpp
- Purpose: A row in the palette tree: styling, theming, and serialisation of the palette layout.
- Key abstractions: `treItemType_t` selects the row's flags, font size and colour pair.
- Data flow: `toString(indent)` (line 116) emits `<category name="..." hidden="..." expanded="...">` or `<component name="..." shortcut="..."/>`, recursively — this is the `compList.xml` format.
- Non-obvious design decisions: custom (user-installed) components get a different colour scheme from built-in ones (`m_isCustom` selects between a blue-grey and a brown palette), so the user can see at a glance what is not stock.
- Edge cases / failure handling: `setTheme(dark)` inverts the icon via `ThemeManager::invertPixmap` and lightens/darkens the row colours.
- Surprising: `setItemType` is where the drag-and-drop flags live: components are `ItemIsDragEnabled` but not drop-enabled; categories are drop-enabled.

### src/gui/componentlist/treeitem.h
- Purpose: Header for `TreeItem`.
- Key abstractions: `treItemType_t { type_NONE, component, categ_MAIN, categ_CHILD }`.
- Data flow: n/a.
- Non-obvious design decisions: `m_parent` is stored explicitly because `QTreeWidgetItem::parent()` is not usable during construction.
- Edge cases / failure handling: n/a.
- Surprising: the hide/show API (`setItemHidden`) is present but commented out in both the header and the .cpp.

### src/gui/custombutton.cpp
- Purpose: A flat, rounded, gradient-filled push button used in the palette and panels.
- Key abstractions: overrides `paintEvent` entirely, ignoring the platform style.
- Data flow: n/a.
- Non-obvious design decisions: the pressed/checked state uses an inverted gradient and an inset rectangle, giving a physical push feel.
- Edge cases / failure handling: n/a.
- Surprising: `setAttribute(Qt::WA_TranslucentBackground)` is required because the button draws its own background.

### src/gui/custombutton.h
- Purpose: Header for `CustomButton`.
- Key abstractions: `QToolButton` subclass.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: the font is hard-coded to 11 px rather than scaled by the app's font scale.

### src/gui/customdial.cpp
- Purpose: A fully hand-painted rotary knob.
- Key abstractions: `QDial` with `installEventFilter(this)`.
- Data flow: the knob's centre is computed in `paintEvent` and cached in `m_arrowX`/`m_arrowY`; the event filter then uses that cached position to decide whether the click landed on the knob (within 5 px) and ignores the click otherwise.
- Non-obvious design decisions: the dial supports both a 300-degree and a 360-degree (wrapping) range; the notch count is reduced so that adjacent notches are at least 4 px apart.
- Edge cases / failure handling: the event filter returns `true` and ignores the event for a click more than 5 px from the knob.
- Surprising: the whole widget is 24x24 px and repainted from scratch on every value change.

### src/gui/customdial.h
- Purpose: Header for `CustomDial`.
- Key abstractions: `m_arrowX`/`m_arrowY` cache the knob position between paint and mouse events.
- Data flow: n/a.
- Non-obvious design decisions: the hit-test tolerance (5 px) is hard-coded in the .cpp rather than being a constant.
- Edge cases / failure handling: n/a.
- Surprising: the class is used through `QAbstractSlider*` (see `DialWidget::dial()`), so the canvas code never knows whether it has a knob or a slider.

### src/gui/customslider.cpp
- Purpose: A hand-painted slider used when a component's knob is switched to slider mode.
- Key abstractions: `QSlider` with a fixed 60x14 geometry and a 0..1000 range.
- Data flow: the knob position is derived from `value()` and the range in `paintEvent`.
- Non-obvious design decisions: the rail is drawn green up to the knob and grey past it, and the notch density adapts: five coarse notches when `singleStep() > 1`, otherwise one notch per step.
- Edge cases / failure handling: none.
- Surprising: `setFixedSize(60,14)` overrides any layout request, so the widget is sized by its paint code.

### src/gui/customslider.h
- Purpose: Header for `CustomSlider`.
- Key abstractions: `QSlider` subclass.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/dataplotwidget/datachannel.cpp
- Purpose: One captured trace of a measurement channel, and the golden-trace comparison used by the test system.
- Key abstractions: `m_buffer` (values) and `m_time` (timestamps) as `QVector`s; a parallel `m_bufferTest`/`m_timeTest` pair holds the expected trace.
- Data flow: `stamp()` (line 29) hooks the channel's `eNode` voltage-change callback at simulation start and connects the second pin's change callback.
- Non-obvious design decisions: **`doTest(bool)` (line 52) is a golden-trace comparison**: on the first call it records the live trace as the reference; on subsequent calls it compares sample by sample with a *relative* tolerance of `qFabs(value-cValue) > qFabs(value/1000)` (0.1 %) and requires the timestamps to be *exactly* equal. `testData()`/`setTestData()` (lines 85-108) serialise the reference as `hex-time value|` pairs so it can live in the circuit file.
- Edge cases / failure handling: values with magnitude below 1e-12 are normalised to zero before comparison; a size mismatch fails immediately.
- Surprising: the tolerance is proportional to the value, so a zero-valued sample is compared exactly.

### src/gui/dataplotwidget/datachannel.h
- Purpose: Header for `DataChannel`.
- Key abstractions: `cond_t { C_NONE, C_LOW, C_RISING, C_HIGH, C_FALLING }` — the conditions a measurement can trigger on.
- Data flow: n/a.
- Non-obvious design decisions: `m_ePin[0]` is the measured pin and `m_ePin[1]` is the optional trigger pin.
- Edge cases / failure handling: n/a.
- Surprising: `friend class PlotBase` and `friend class Oscope`/`LAnalizer` give the plot classes direct access to the buffers.

### src/gui/dataplotwidget/datalawidget.cpp
- Purpose: The logic analyser's header strip: eight channel name fields and an Expand button.
- Key abstractions: `m_chNames` list of the eight `QLineEdit`s.
- Data flow: `on_channelN_editingFinished()` pushes the typed name into `PlotBase::channelChanged(ch, name)`, which stores it as the channel's tunnel name.
- Non-obvious design decisions: an event filter clears the component's selection when a field takes focus, so typing in the field does not drag the component.
- Edge cases / failure handling: none.
- Surprising: eight nearly identical slots (one per channel) rather than one slot that reads the sender.

### src/gui/dataplotwidget/datalawidget.h
- Purpose: Header for `DataLaWidget`.
- Key abstractions: `Ui::DataLaWidget` mixin.
- Data flow: n/a.
- Non-obvious design decisions: `getLayout()` exposes the horizontal layout so the plot display can be inserted next to the channel fields.
- Edge cases / failure handling: n/a.
- Surprising: `setColor(ch, c)` paints the channel field's background with the channel colour.

### src/gui/dataplotwidget/datalawidget.ui
- Purpose: Designer form for the analyser header.
- Key abstractions: eight `QLineEdit` channel fields plus a `CustomButton` labelled "Expand".
- Data flow: visual only.
- Non-obvious design decisions: the form promotes `CustomButton` to a custom widget (its own `<class>` block at the end of the file).
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (439 lines); see *Uncertainties*.

### src/gui/dataplotwidget/datawidget.cpp
- Purpose: The oscilloscope's header strip: four channel name fields plus per-channel frequency readouts.
- Key abstractions: `m_chNames` plus the four `freq0..3` labels.
- Data flow: the same `channelChanged` push as the analyser; the frequency labels are set from outside via `setData(ch, freq)`.
- Non-obvious design decisions: the frequency is *displayed* in the header but not editable — it is computed by the analyser.
- Edge cases / failure handling: an event filter deselects the component on focus-in.
- Surprising: `setData(i, "0 Hz")` is called for all four channels at construction as the placeholder.

### src/gui/dataplotwidget/datawidget.h
- Purpose: Header for `DataWidget`.
- Key abstractions: `Ui::DataWidget` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: the class is named `DataWidget` but the UI class is `DataWidget` while the analyser's is `DataLaWidget`.

### src/gui/dataplotwidget/datawidget.ui
- Purpose: Designer form for the oscilloscope header.
- Key abstractions: four `QLabel` frequency fields, four `QLineEdit` channel fields and a `CustomButton` "Expand".
- Data flow: visual only.
- Non-obvious design decisions: the frequency labels sit next to the channel fields.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (391 lines).

### src/gui/dataplotwidget/lawidget.cpp
- Purpose: The logic analyser's control dialog.
- Key abstractions: `PlotDisplay` (the waveform), `PlotSpinBox` (unit-aware numeric fields), a `QButtonGroup` for the bus flags.
- Data flow: the dials and boxes write through to the analyser (`setTimeDiv`, `setTimePos`, `setIsBus`, `setThresholdR/F`, `setTrigger`, `updateConds`); `updateTimeDivBox`/`updateTimePosBox` write *back* from the analyser into the boxes under an `m_blocked` guard.
- Non-obvious design decisions: the dial is a *relative* control — it compares the new dial position to the previous one and adds or subtracts `timeDiv/100` (lines 47-58). The time-zero marker is set with the *middle* mouse button (`plotDisplay->setTimeZero(m_mousePos)`), and the left button pans.
- Edge cases / failure handling: `m_blocked` prevents the boxes from echoing their own updates back into the model.
- Surprising: the export button writes a VCD file (`m_analizer->dumpData(fileName)`) — the analyser can emit industry-standard waveforms.

### src/gui/dataplotwidget/lawidget.h
- Purpose: Header for `LaWidget`.
- Key abstractions: `enum action_t { actNone, actMove, actTime }` describing what the mouse is doing.
- Data flow: n/a.
- Non-obvious design decisions: `closeEvent` collapses the analyser (`expand(false)`) when the dialog closes.
- Edge cases / failure handling: n/a.
- Surprising: `resizeEvent` is a one-liner that just calls `plotDisplay->updateValues()`.

### src/gui/dataplotwidget/lawidget.ui
- Purpose: Designer form for the analyser control dialog.
- Key abstractions: a native `PlotDisplay` widget, `QDial` + `PlotSpinBox` pairs for time division and time position, eight bus radio buttons in a `QButtonGroup`, two threshold spin boxes, a trigger combo and a condition line edit.
- Data flow: visual only.
- Non-obvious design decisions: the file promotes `PlotDisplay` and `PlotSpinBox` as custom widgets with their own `<class>` blocks.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (917 lines).

### src/gui/dataplotwidget/oscwidget.cpp
- Purpose: The oscilloscope's control dialog.
- Key abstractions: five radio groups (channel, auto, trigger, hide, track) and four dial/spin-box pairs.
- Data flow: the "auto" channel selection means "this channel drives the time base"; when the selection is "all" (index 4), a time-base change is applied to all four channels in a loop.
- Non-obvious design decisions: the dial-as-relative-control pattern again (`DialPos < m_timeDivDialPos` means "coarser"). Voltage values are carried in *volts* in the model but the boxes work in *pivolts* (`voltDiv*1e12`), and the conversion is explicit at each boundary.
- Edge cases / failure handling: `m_blocked` guards every write-back; `on_hideGroup_buttonClicked(4)` unhides all channels.
- Surprising: `mainLayout->setDirection(QBoxLayout::RightToLeft)` — the layout is deliberately mirrored.

### src/gui/dataplotwidget/oscwidget.h
- Purpose: Header for `OscWidget`, the oscilloscope's control dialog.
- Key abstractions: `action_t { actNone, actMove, actTime }`; the four `update*Box` methods; `Oscope* m_oscope` (the component it drives).
- Data flow: n/a.
- Non-obvious design decisions: `setTracks(int tr)` is written inline in the header and does `trackGroup->button(tr)->setChecked(true)` — it selects the *radio button* rather than calling the model, so the model is only written from the button's own `on_trackGroup_buttonClicked` slot.
- Edge cases / failure handling: n/a.
- Surprising: the class declares **fourteen** `on_<widget>_<signal>` auto-connect slots (eight for the four dial/box pairs, one for the filter box and five for the radio groups) and no `connect()` call anywhere; the header is 81 lines and carries the whole of that wiring.

### src/gui/dataplotwidget/oscwidget.ui
- Purpose: Designer form for the oscilloscope control dialog.
- Key abstractions: native `PlotDisplay`, five channel buttons (`chButton1`..`chButton4` plus `allButton`), **four** `QDial` + `PlotSpinBox` pairs (time div, time pos, volt div, volt pos), a filter `QDoubleSpinBox` and the auto/trigger/hide/track radio groups (five, five, five and three buttons respectively).
- Data flow: visual only.
- Non-obvious design decisions: the layout direction is set in code, not in the form.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (1497 lines); it is the second largest form in the shard, after `appdialog.ui` (1735).

### src/gui/dataplotwidget/plotbase.cpp
- Purpose: The shared base of the oscilloscope and the logic analyser: channel ownership, buffer sizing, the condition/script mechanism, the timed self-test and the VCD export.
- Key abstractions: `ScriptBase` (the AngelScript engine), `DataChannel* m_channel[8]`, `m_condCh1..m_condCh8` (the per-channel condition state, registered as script properties).
- Data flow: `initialize()` schedules a `runEvent()` at `m_testTime` picoseconds (line 136); `runEvent()` (line 145) asks each channel `doTest()` and reports the result to `BatchTest`.
- Non-obvious design decisions: **`updateConds(QString)` (line 250) is a tiny expression language compiled into the script engine**: the user writes `ch1l` and it is textually expanded to `(pb.ch1==1)` (the map is built in the constructor, lines 58-66), the whole thing is wrapped as `void pause() { pb.m_pause = <expr>; }`, compiled, and the function is called from `conditonMet()` whenever a channel changes state — and if the expression evaluates true, the *simulation pauses*. A user-supplied condition string is therefore compiled and executed by the embedded engine, with `pb.m_pause` as the only writable global.
- Edge cases / failure handling: a compile failure is reported to the debug output and the pause function is left null (`m_pauseFunc = nullptr`), so `conditonMet()` becomes a no-op.
- Surprising: `setBufferSize` reallocates every channel's two `QVector`s, and the buffer is up to 10 million samples (`bs > 10000000` is clamped).

### src/gui/dataplotwidget/plotbase.h
- Purpose: Header for `PlotBase`.
- Key abstractions: the abstract `timDiv`/`volDiv`/`timPos`/`trigger`/`tunnels` interface the analyser and scope implement separately.
- Data flow: n/a.
- Non-obvious design decisions: `m_color[5]` holds the per-channel palette (the eighth channel reuses index 4).
- Edge cases / failure handling: n/a.
- Surprising: `m_trigger` and `m_risEdge` are declared but the trigger logic actually lives in the subclasses.

### src/gui/dataplotwidget/plotdisplay.cpp
- Purpose: The waveform renderer.
- Key abstractions: it borrows the channel buffers by pointer (`m_buffer[i]`, `m_time[i]`) rather than copying them; the scale/position arrays are per channel.
- Data flow: `paintEvent` (line 191) recomputes the geometry (`updateValues`), draws the graticule, then walks each channel's ring buffer **backwards** from the trigger index.
- Non-obvious design decisions: **sub-sampling**: points that fall within 0.5 px of each other on screen are not drawn individually; instead the min and max y of the collapsed group are drawn, producing a min/max envelope (lines 310-341). Buses are drawn as two rails with a hex value printed between them when the run is wider than 20 px. The cursor readout is computed from the channel's voltage at the cursor's x.
- Edge cases / failure handling: `if (m_timeEnd == 0) return` skips drawing entirely before the first sample; the loop `break`s as soon as it walks past the visible start.
- Surprising: the "voltage" of a bus channel is an integer drawn as `0x` + uppercase hex; the renderer keeps separate code paths for bus and analog channels.

### src/gui/dataplotwidget/plotdisplay.h
- Purpose: Header for `PlotDisplay`.
- Key abstractions: `m_buffer[8]`/`m_time[8]` are pointers to the *channels'* vectors; `m_scaleY[8]`, `m_vTick[8]`, `m_vPos[8]`, `m_hPos[8]` are the per-channel display state.
- Data flow: `setChannel(ch, channel)` hands over the pointer.
- Non-obvious design decisions: `setLimits(ch, max, min)` only stores `min` — the `max` argument is ignored (line 38), which looks like an unfinished API.
- Edge cases / failure handling: n/a.
- Surprising: `m_sizeX`/`m_sizeY` are doubles because they are recomputed on every resize.

### src/gui/dataplotwidget/plotspinbox.cpp
- Purpose: A `QDoubleSpinBox` that understands SI prefixes typed into it.
- Key abstractions: `m_unit` is the dimension ("s", "V"), `m_this` is a back-pointer so `validate()` (a const method) can change the suffix.
- Data flow: `validate()` strips a leading `p/n/u/m/k/M/G` from the typed text, sets the spin box's suffix accordingly, and then delegates to `QDoubleSpinBox::validate()` on the numeric part.
- Non-obvious design decisions: the prefix letters are checked in a fixed order, and a bare unit (case-insensitively) is also accepted.
- Edge cases / failure handling: a value with no prefix but with the unit is still accepted and gets a plain suffix.
- Surprising: `validate()` mutates widget state from a `const` method via `m_this` — a deliberate Qt workaround.

### src/gui/dataplotwidget/plotspinbox.h
- Purpose: Header for `PlotSpinBox`.
- Key abstractions: `QDoubleSpinBox` subclass.
- Data flow: n/a.
- Non-obvious design decisions: `m_this` exists solely because `validate()` is const.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/dialwidget.cpp
- Purpose: A container that shows either a knob or a slider and can swap between them.
- Key abstractions: `m_knob` (`CustomDial`) and `m_slider` (`CustomSlider`), both accessed as `QAbstractSlider* m_dial`.
- Data flow: `setType(1)` removes the knob from the layout and inserts a slider, copying the knob's step, maximum and value; `setValue`/`value` operate on whichever is current.
- Non-obvious design decisions: the knob is created eagerly and the slider lazily.
- Edge cases / failure handling: none.
- Surprising: `paintEvent` is overridden to do nothing — the widget is purely a container.

### src/gui/dialwidget.h
- Purpose: Header for `DialWidget`.
- Key abstractions: `QAbstractSlider* dial()` is the public accessor.
- Data flow: n/a.
- Non-obvious design decisions: the class exposes the raw abstract slider so callers can connect to `valueChanged` without knowing which widget is shown.
- Edge cases / failure handling: n/a.
- Surprising: `m_slider` is a `CustomSlider*` but `m_dial` is the abstract type — the switch is invisible to callers.

### src/gui/editorwidget/basedebugger.cpp
- Purpose: The debugger base: upload the firmware, map flash addresses to source lines, and single-step the simulated CPU.
- Key abstractions: `codeLine_t` (file + line), `m_flashToSource` (address -> code line), `m_functions` (name -> start address).
- Data flow: `postProcess()` (line 68) parses the compiler's `.lst` file and pairs each source line with a flash address; there are two strategies — one for high-level languages (the `.lst` names the source file and line) and one for assembly (the source text is matched literally against the `.lst`).
- Non-obvious design decisions: `stepDebug()` (line 248) implements *step-over* by watching the PC: when it enters a known function it records `RET_ADDR()` as the exit PC and keeps stepping until the PC returns there. `getValidLine()` (line 328) snaps a breakpoint to the nearest *mapped* line, so a breakpoint on a comment still works.
- Edge cases / failure handling: `m_lstType` is a bitfield that tells the parser whether the `.lst` uses `:` separators and where the address column is — a per-toolchain quirk flag.
- Surprising: `postProcess` for high-level code searches *all* project files (`m_fileList`) for the source-file name in each `.lst` line, because a single build can span several files.

### src/gui/editorwidget/basedebugger.h
- Purpose: Header for `BaseDebugger`.
- Key abstractions: `codeLine_t` with `==`/`!=` operators so it can be a map value and compared cheaply.
- Data flow: n/a.
- Non-obvious design decisions: `m_flashToSource` is a `QMap<int, codeLine_t>` (address -> line) rather than the reverse, because the debugger looks up *by PC*.
- Edge cases / failure handling: `friend class eMcu` lets the MCU ask the debugger for the current line.
- Surprising: `m_sourceToFlash` (the reverse map) is commented out everywhere — it was tried and dropped.

### src/gui/editorwidget/codeeditor.cpp
- Purpose: The code editor: a `QPlainTextEdit` with a gutter, completion, syntax highlighting, breakpoints, error markers and per-file configuration.
- Key abstractions: `CompBase` (so the editor is itself a property-bearing, saveable object), `Highlighter`, `LineNumberArea`, `QCompleter`.
- Data flow: `setFile(path)` (line 389) picks the syntax file and the debugger from the file extension; for `.asm` it *guesses* the architecture with `getSyntaxCoincidences()`. `loadConfig()`/`saveConfig()` (lines 761/813) read and write a `<file>.cfg` document holding the editor's and the compiler's properties.
- Non-obvious design decisions: (1) **dialect detection by scoring**: `getSyntaxCoincidences()` (line 496) counts how many PIC, AVR and 8051 instruction mnemonics appear in the file and picks the language whose "match ratio" is best and below 3, stopping after 200 matches or 400 lines. (2) **the gutter is a separate widget** (`LineNumberArea`) whose `paintEvent` delegates to the editor, which then draws the line numbers, the mapped-source markers, the breakpoint squares, the warning triangles and the error circles — all from the editor's data, so the gutter needs no state of its own. (3) `updtNumbers()` (line 896) shifts the breakpoint, error and warning line numbers when lines are inserted or deleted above them.
- Edge cases / failure handling: `compile()` refuses to compile an unsaved document; `loadConfig()` falls back to the legacy `.brk` breakpoint file and to a `compiler:` declaration in the file's first line when no `.cfg` exists.
- Surprising: `QDir::setCurrent(m_file)` in `setFile` changes the *process's* working directory as a side effect of opening a file.

### src/gui/editorwidget/codeeditor.h
- Purpose: Header for `CodeEditor`.
- Key abstractions: the `LineNumberArea` helper class is declared in the same header; the static `m_picInstr`/`m_avrInstr`/`m_i51Instr` mnemonic lists drive dialect detection.
- Data flow: n/a.
- Non-obvious design decisions: `m_brkAction` is an integer tri-state (0 none, 1 add, 2 remove, 3 toggle) that the gutter reads on the next paint — a deferred, paint-driven command channel rather than a direct call.
- Edge cases / failure handling: `startDebug()` sets the editor read-only and re-validates every breakpoint against the debugger's mapped lines.
- Surprising: the `UserData` class (a `QTextBlockUserData` holding breakp/error/warning flags) is fully written but commented out — the markers are drawn from plain `QList<int>`s instead.

### src/gui/editorwidget/compiler.cpp
- Purpose: The generic external-toolchain driver.
- Key abstractions: `m_command`/`m_arguments`/`m_argsDebug` — three parallel lists, one entry per build step, so a debug build can use different arguments.
- Data flow: `loadCompiler(file)` (line 82) parses an XML `<compiler>` element with `name`, `type`, `syntax`, `buildPath`, `inclPath` and any number of `<step command="..." arguments="..." argsDebug="..."/>` children. `replaceData()` (line 66) substitutes `$filePath`, `$fileDir`, `$fileName`, `$fileExt`, `$inclPath`, `$buildPath` and `$extraArgs` into the argument string. `compile()` (line 181) runs each step as a `QProcess` and parses the output.
- Non-obvious design decisions: **the toolchain is described as data.** The GUI does not know what `avr-gcc` is; it knows how to substitute tokens into an argument string. A new toolchain is an XML file, not code. The compiler also *dynamically adds properties* to its own property group when the argument string mentions `$device`, `$family`, `$extraArgs` or `$inclPath` (lines 131-157) — the settings dialog grows exactly the fields the toolchain needs.
- Edge cases / failure handling: `checkCommand()` (line 349) verifies the executable exists or starts, with a 1-second kill fallback; a missing toolchain prints "Check that Tool Path is correct" and aborts the build. `getErrorLine()` (line 268) scans the tool output for lines mentioning the source file and extracts the first number as the line number, then classifies it as error or warning by keyword.
- Surprising: `m_uploadHex` can be turned off by `uploadhex="false"` in the XML, in which case no firmware is produced (used by assemblers).

### src/gui/editorwidget/compiler.h
- Purpose: Header for `Compiler`.
- Key abstractions: `Compiler` is a `QObject` + `CompBase` (so it is a property-bearing object that can be saved into the `.cfg` file).
- Data flow: n/a.
- Non-obvious design decisions: `preProcess()`/`postProcess()` are the two hooks the per-toolchain debuggers override (asm vs high-level mapping, variable extraction).
- Edge cases / failure handling: n/a.
- Surprising: `m_compilerType` is stored but only used by the subclasses.

### src/gui/editorwidget/debuggers/asdebugger.cpp
- Purpose: The AngelScript toolchain debugger: compiles the script *inside the simulated CPU* rather than with an external compiler.
- Key abstractions: `ScriptCpu* m_device`.
- Data flow: `compile()` (line 50) finds the scripted MCU, sets the script file on its CPU, calls `compileScript()` and then feeds the script's types and member words back into the editor (`setExtraTypes`, `setMemberWords`) so completion and highlighting know the script's API.
- Non-obvious design decisions: the debugger removes the `ToolPath` property in its constructor (`remProperty("ToolPath")`) because there is no external tool for this chain.
- Edge cases / failure handling: if no scripted MCU is present, the compile fails with "No Scripted Device Found".
- Surprising: `upload()` does not upload anything — the script source *is* the firmware, so the "upload" merely registers the debugger with the MCU.

### src/gui/editorwidget/debuggers/asdebugger.h
- Purpose: Header for `asDebugger`.
- Key abstractions: `ScriptCpu* m_device`.
- Data flow: n/a.
- Non-obvious design decisions: the commented-out `postProcess()` override shows the flash-mapping was not needed for scripts.
- Edge cases / failure handling: n/a.
- Surprising: the class name is lower-case `asDebugger` while all its siblings are CamelCase.

### src/gui/editorwidget/debuggers/avrgccdebugger.cpp
- Purpose: The avr-gcc toolchain debugger: extracts variables, functions and the flash-to-source map from the ELF file using the binutils that ship with the AVR toolchain.
- Key abstractions: `m_elfPath`; `m_addrBytes` (1 for avr-gcc, 2 for XC8).
- Data flow: `getVariables()` (line 47) runs `avr-objdump -t -j.bss` and adds each symbol to the MCU's RAM table; `getFunctions()` (line 109) runs `avr-readelf -s`; `mapFlashToSource()` (line 168) pipes every flash address through `avr-addr2line -e` in one batch and reads the answers back line by line.
- Non-obvious design decisions: the `avr-addr2line` call is **batched** — all addresses are written to the process's stdin and the answers are read back, which is far faster than one process per address. The tool paths are probed in two places (`toolPath + "avr/bin/avr-objdump"` first, then the bare name) and each failure only warns.
- Edge cases / failure handling: `avr-size` gives the flash size; if it cannot be read, a default of 35000 bytes is assumed. Addresses from objdump have the AVR `0x800000` offset subtracted.
- Surprising: the constructor sets `LANG=C` and `LC_MESSAGES=C` in the process environment so the tool output is parseable regardless of the user's locale.

### src/gui/editorwidget/debuggers/avrgccdebugger.h
- Purpose: Header for `AvrGccDebugger`.
- Key abstractions: `m_addrBytes` and `m_elfPath`.
- Data flow: n/a.
- Non-obvious design decisions: the class inherits from `cDebugger`, so it inherits C variable-type detection for free.
- Edge cases / failure handling: n/a.
- Surprising: `getVariables()`, `getFunctions()` and `mapFlashToSource()` are declared *after* the access specifier block, i.e. in the protected section, but the .cpp defines them publicly — the header's access specifiers are effectively advisory here.

### src/gui/editorwidget/debuggers/cdebugger.cpp
- Purpose: The generic C-family toolchain helper: finds the project's source files and extracts variable types.
- Key abstractions: `m_typesList` (C type name -> engine type name), `m_varTypes` (variable -> type).
- Data flow: `preProcess()` (line 31) walks the file's directory for `*.c`, `*.cpp`, `*.h`, `*.hpp` (recursively) and adds them to `m_fileList`, then parses the main source for declarations: it splits on spaces, strips `;`, maps the first word through the type table, and registers every following comma-separated name.
- Non-obvious design decisions: the type table is a *hand-written* map from C types to the simulator's type names ("char" -> "int8", "uchar" -> "uint8", "ulong" -> "uint32", "float" -> "float32"), with `unsigned` handled by prefixing "u" to the next word.
- Edge cases / failure handling: an unknown type is skipped silently.
- Surprising: the C type table lives in the *debugger*, not in a shared header, so `AvrGccDebugger` inherits it but the analyser does not.

### src/gui/editorwidget/debuggers/cdebugger.h
- Purpose: Header for `cDebugger`.
- Key abstractions: `BaseDebugger` subclass with one override.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: the class is lower-case `cDebugger` like `asDebugger`.

### src/gui/editorwidget/debuggers/gcbdebugger.cpp
- Purpose: The GcBasic toolchain debugger.
- Key abstractions: `m_typesList` for GcBasic types ("byte" -> "uint8", "integer" -> "int16", "string" -> "string").
- Data flow: `postProcess()` calls `getSubs()` (parses the `.report.txt` for subroutine names) and `mapFlashToSource()` (line 81), which parses the `.gcb` source for `DIM` declarations, reads the generated `.asm` for variable `EQU` addresses and the `;SOURCE:F1Lnn` comments that map assembly back to GcBasic source lines, and then pairs them with addresses from the `.lst`.
- Non-obvious design decisions: array variables are expanded into individual elements (`name(1)`, `name(2)`, ...) and each is registered separately in the RAM table. The `hasCeroAddr` flag handles the `BANKSEL` case where two different source lines legitimately map to address 0.
- Edge cases / failure handling: the `.lst` search does `takeFirst()` on the list until it finds a match — it can exhaust the list and then dereference an empty string.
- Surprising: `m_stepOver = true` is set in the constructor, so GcBasic always steps over.

### src/gui/editorwidget/debuggers/gcbdebugger.h
- Purpose: Header for `GcbDebugger`.
- Key abstractions: `getErrorLine` is overridden so that errors are only reported when the *process exit code* is non-zero (the GcBasic compiler prints warnings that look like errors).
- Data flow: n/a.
- Non-obvious design decisions: the override exists because the generic parser misreads GcBasic's output.
- Edge cases / failure handling: n/a.
- Surprising: `m_functions` is populated but the "functions found" line is commented out with `/// FIXME: not working?`.

### src/gui/editorwidget/debuggers/gputilsdebug.cpp
- Purpose: A static helper for the PIC gputils toolchain: reads the `.cod` symbol table for variables and the `.line` directives for the flash map.
- Key abstractions: two static methods taking a `BaseDebugger*` rather than being a subclass.
- Data flow: `getVariables()` runs `gpvc -s <file>.cod` and picks the symbols whose type is `c_short`, using the debugger's own variable-type table to decide the width; `mapFlashToSource()` runs `gpvc -l` and pairs the `.line` directives with the following address line.
- Non-obvious design decisions: the tool is invoked as a *helper* by `SdccDebugger` rather than being its own debugger class, because the SDCC build already knows the family.
- Edge cases / failure handling: a missing `.cod` file returns false with a warning; the `gpvc` path is probed in two places.
- Surprising: the `mapFlashToAsm` variant is present but entirely commented out.

### src/gui/editorwidget/debuggers/gputilsdebug.h
- Purpose: Header for the gputils helper.
- Key abstractions: a plain class with two static methods and no base class.
- Data flow: n/a.
- Non-obvious design decisions: it is not a `BaseDebugger` — it cannot be selected as a toolchain.
- Edge cases / failure handling: n/a.
- Surprising: `compile(bool debug)` is commented out in both the header and the .cpp.

### src/gui/editorwidget/debuggers/inodebugger.cpp
- Purpose: The Arduino toolchain debugger, supporting both Arduino 1 (`arduino-builder`) and Arduino 2 (`arduino-cli`).
- Key abstractions: `m_boardMap` (board name -> FQBN), `m_userBoards`; the editor's completion and highlighting are seeded with the whole Arduino API.
- Data flow: `setToolPath()` (line 137) probes for `arduino-builder` (version 1) or `arduino-cli` (version 2). For version 2 it parses `arduino-cli config dump` for the data directory and `arduino-cli board listall` for the board list. `compile()` (line 278) builds the command (`-compile` for v1, `compile --no-color --fqbn=...` for v2) into a separate build/cache folder under the user's config path.
- Non-obvious design decisions: the constructor hard-codes the entire Arduino API into the editor's completion list (about 60 functions) and the `Serial` object's methods (20) — the editor knows the Arduino API, not just the language. The board can also be declared in the first line of the `.ino` file (`board: Uno`), which is parsed at the end of `setToolPath`.
- Edge cases / failure handling: the build folder is deleted and recreated on each compile; if the folders cannot be created the compile aborts with a clear message. The v2 path has a fallback for an empty config (platform-specific default `Arduino15` location).
- Surprising: `compilerProps()` calls `Compiler::compilerProps()` **twice** (lines 396 and 399) — the first call is used to create the dialog, the second to reach the widget.

### src/gui/editorwidget/debuggers/inodebugger.h
- Purpose: Header for `InoDebugger`.
- Key abstractions: `toolPath()` is overridden to return `m_arduinoPath` (the Arduino IDE root), not the compiler path.
- Data flow: n/a.
- Non-obvious design decisions: `m_version` (1 or 2) selects the command line; `m_builder` is the executable actually used.
- Edge cases / failure handling: n/a.
- Surprising: `m_lastInoLine`/`m_loopInoLine` are declared but unused.

### src/gui/editorwidget/debuggers/sdccdebugger.cpp
- Purpose: The SDCC toolchain debugger, covering both the PIC (gputils) and the 8051 (CSEG) families.
- Key abstractions: `findCSEG()` (line 276) reads the `.map` file to find the code segment base address, which is added to every address in the listing.
- Data flow: `compile()` (line 24) additionally converts the `.ihx` to Intel HEX with `packihx` when the `.hex` is missing or older. `postProcess()` (line 53) has two entirely separate mapping strategies: the PIC path uses the gputils `.cod`/`.lst` `.line` directives, and the non-PIC path uses the SDCC `.lst` format with CSEG adjustment and a bracket check to skip data lines.
- Non-obvious design decisions: in the SDCC listing, a line is treated as code only if it contains a `[...]` bracket (the SDCC convention for code bytes) — everything else is skipped.
- Edge cases / failure handling: `findCSEG` returns false if the `.map` file is missing, aborting the mapping.
- Surprising: `m_langLevel = m_fileExt != ".asm"` — the language level is decided by the source extension, not by the toolchain.

### src/gui/editorwidget/debuggers/sdccdebugger.h
- Purpose: Header for `SdccDebugger`.
- Key abstractions: `compile()` and `postProcess()` overrides, plus the private `findCSEG()`.
- Data flow: n/a.
- Non-obvious design decisions: it derives from `cDebugger` (for the C type table) not from `AvrGccDebugger`.
- Edge cases / failure handling: n/a.
- Surprising: it reuses `GputilsDebug` (a helper for a different vendor's toolchain) for the PIC path.

### src/gui/editorwidget/debuggers/xc8debugger.cpp
- Purpose: The MPLAB XC8 toolchain debugger.
- Key abstractions: inherits everything from `AvrGccDebugger`.
- Data flow: the only difference is the address width.
- Non-obvious design decisions: `m_addrBytes = 2` — XC8 addresses are 16-bit, avr-gcc's are 8-bit, and `mapFlashToSource` multiplies by `m_addrBytes/2` (i.e. *1* for XC8 versus *0.5* for avr-gcc) to convert a byte offset into a word address.
- Edge cases / failure handling: n/a.
- Surprising: the whole file is 13 lines — a one-constant subclass.

### src/gui/editorwidget/debuggers/xc8debugger.h
- Purpose: Header for `Xc8Debugger`.
- Key abstractions: `AvrGccDebugger` subclass, no new members.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/editorwidget/dialogs/findreplace.cpp
- Purpose: The find/replace bar of the code editor.
- Key abstractions: `find(bool next)` (line 103) is the single search routine; it builds `QTextDocument::FindFlags` from the check boxes and uses `QRegularExpression` when the regexp box is ticked.
- Data flow: hits are pushed back into the editor as `QTextEdit::ExtraSelection`s via `setFound()`, which is what makes them appear highlighted in both the document and the scrollbar.
- Non-obvious design decisions: "find all" saves and restores the cursor position around the loop so the user's caret does not move.
- Edge cases / failure handling: `find()` returns false if there is no editor.
- Surprising: the `caseS->isChecked() ? NoPatternOption : CaseInsensitiveOption` mapping is inverted-looking but correct (the regexp branch is the only one that needs the option).

### src/gui/editorwidget/dialogs/findreplace.h
- Purpose: Header for `FindReplace`.
- Key abstractions: `m_textCursor` holds the search position so repeated searches continue from the last hit.
- Data flow: n/a.
- Non-obvious design decisions: `setTextToFind` lets the editor pre-fill the field with the current selection.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/editorwidget/dialogs/findreplace.ui
- Purpose: Designer form for the find/replace bar.
- Key abstractions: `findEdit`, `replaceEdit`, next/prev/all/replace/replace-and-find/replace-all buttons and the `whole`, `caseS`, `regexp` check boxes.
- Data flow: visual only.
- Non-obvious design decisions: the bar is a `QWidget` embedded in the editor's layout (not a dialog), so it can be shown and hidden.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (286 lines).

### src/gui/editorwidget/docpage.cpp
- Purpose: The per-tab container that shows the "file changed on disk" bar.
- Key abstractions: a `QFrame` bar with a label and four buttons.
- Data flow: `EditorWidget::fileChangedOnDisk` calls `showModifiedBar` (file changed) or `showDeletedBar` (file gone).
- Non-obvious design decisions: the bar offers *four* different resolutions — Reload (discard the editor's content), Keep Current (ignore the change), Close Tab, Keep Open (keep the tab but forget the file). The wording of the message changes when the document also has unsaved edits ("Reloading will discard them").
- Edge cases / failure handling: the deleted-file variant hides Reload and Keep Current and shows Close Tab and Keep Open.
- Surprising: the bar's colours are hard-coded in a stylesheet (`#C00000` background, `#FFFF99` text) rather than being theme-aware.

### src/gui/editorwidget/docpage.h
- Purpose: Header for `DocPage`.
- Key abstractions: the four bar buttons.
- Data flow: n/a.
- Non-obvious design decisions: the class owns the `CodeEditor` as a child widget.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/editorwidget/editorwidget.cpp
- Purpose: The multi-tab code editor window.
- Key abstractions: `m_fileList` (path -> `DocPage`), a `QFileSystemWatcher`, four toolbars, and a `FindReplace` bar.
- Data flow: `loadFile` -> `addDocument` -> `ce->setFile(path)` -> `ce->loadConfig()`; `saveFile` writes the text and re-arms the watcher.
- Non-obvious design decisions: **the file-system watcher is re-armed after every event** (`m_fileWatcher->addPath(path)` at the end of `fileChangedOnDisk`, and `syncWatchedFiles()` rebuilds the whole list after a save) because Qt drops a watch when the file is replaced — a classic Qt pitfall handled explicitly. The watcher is suspended during the app's own save (`m_savingFile`).
- Edge cases / failure handling: `maybeSave()` prompts on close; `closeTab` stops the debugger first (`if (m_debuggerToolBar->isVisible()) stop();`).
- Surprising: `documentWasModified()` appends or removes a `*` on the tab text, so the "modified" state lives in the tab label, not in the editor.

### src/gui/editorwidget/editorwidget.h
- Purpose: Header for `EditorWidget`.
- Key abstractions: the settings API (font size, tab size, show spaces, tabs-as-spaces, five auto-close toggles packed into a `uint8_t m_autoClose` bitmask) and the virtual debug hooks that `EditorWindow` overrides.
- Data flow: n/a.
- Non-obvious design decisions: the auto-close pairs are a bitmask (`m_autoClose & 1<<0` for parentheses, `1<<1` braces, `1<<2` brackets, `1<<3` quotes, `1<<4` single quotes) and the mask is pushed into every open editor.
- Edge cases / failure handling: `scaleFont(s)` clamps the font size to [3, 60].
- Surprising: `EditorWidget` is itself a `CompBase`, so the editor's own settings are property-bearing and could be serialised.

### src/gui/editorwidget/editorwindow.cpp
- Purpose: The debugger host: toolchain discovery, the debugger lifecycle, and the run/step/pause/reset/stop controls.
- Key abstractions: `m_compilers` and `m_assemblers` (name -> `{file, type}`), `bebugState_t`.
- Data flow: `loadCompilers()` (line 266) scans the user's `codeeditor/compilers` folders *and* the bundled `data/codeeditor/compilers` folders for XML files with a `name` and a `type` attribute. `createDebugger(name, ce, code)` (line 240) maps the type to a debugger subclass and loads the XML into it.
- Non-obvious design decisions: the debugger is chosen by a *type string* from the XML (`arduino`, `avrgcc`, `xc8`, `sdcc`, `gcbasic`, `ascript`) and anything unrecognised falls back to the generic `BaseDebugger` with a two-character code ("langLevel" + "lstType") parsed from the name. `initDebbuger()` (line 156) compiles *with* debug arguments, uploads, and then swaps the toolbars (editor toolbar and compile toolbar are hidden, the debugger toolbar is shown).
- Edge cases / failure handling: `lineReached` only pauses if the reached line has a breakpoint (or is not in an open file); `stopDebbuger()` powers the circuit off and removes the window from the simulator update list.
- Surprising: `updateStep()` (line 45) is called once per simulation step and does the screen update, printing the cycle count and elapsed time — the debugger is an `Updatable` like everything else.

### src/gui/editorwidget/editorwindow.h
- Purpose: Header for `EditorWindow`.
- Key abstractions: `bebugState_t { DBG_STOPPED, DBG_PAUSED, DBG_STEPING, DBG_RUNNING }`; the `compilData_t` struct.
- Data flow: n/a.
- Non-obvious design decisions: `EditorWindow` is an `Updatable` so it gets a per-step callback for the debugger screen update.
- Edge cases / failure handling: n/a.
- Surprising: the enum is spelled `bebugState_t` (missing the "d").

### src/gui/editorwidget/highlighter.cpp
- Purpose: A data-driven syntax highlighter.
- Key abstractions: four rule vectors — file rules, object rules, member rules and extra-type rules — each a (QRegularExpression, QTextCharFormat) pair.
- Data flow: `readSyntaxFile(fileName)` (line 20) parses the `.syntax` file: a `rules:` line names the rule kinds, then a line whose first word ends in `-style:` defines the foreground/background/bold/italic, then a list of words (bare) or regexes (quoted) for that rule. Bare words are also returned to the editor as completion keywords.
- Non-obvious design decisions: **the highlighter prefers a `_dark.syntax` variant** when the dark theme is active (lines 29-37), so themes can restyle the code without touching the highlighter. Multiline comments are handled with `setCurrentBlockState(-10)` as the "inside a comment" marker.
- Edge cases / failure handling: an invalid regular expression is reported with the file name and the offending expression, and skipped.
- Surprising: the word-vs-regexp distinction is "does it start with a quote" — an unquoted token is a keyword and gets `\b` word boundaries added.

### src/gui/editorwidget/highlighter.h
- Purpose: Header for `Highlighter`.
- Key abstractions: the `HighlightRule` struct and the four rule vectors.
- Data flow: n/a.
- Non-obvious design decisions: `processRule` uses `globalMatch` (an iterator) rather than a repeated `indexIn` loop — the older loop is commented out at the top of the function.
- Edge cases / failure handling: n/a.
- Surprising: `m_multiline` is a single flag, so a file can have at most one multiline-comment construct.

### src/gui/editorwidget/scrollbar.cpp
- Purpose: A scrollbar that also shows where the breakpoints, search hits, errors and warnings are.
- Key abstractions: it holds a `CodeEditor*` and reads its breakpoint/error/warning/found lists.
- Data flow: `paintEvent` (line 20) computes the pixel height of a line from `m_editor->blockCount()` and paints markers at `(line-1)*h`.
- Non-obvious design decisions: the same visual language as the gutter (yellow breakpoint, blue hit, red error, orange warning) is reused on the scrollbar so the two read as one system.
- Edge cases / failure handling: none.
- Surprising: the debugger's current line is drawn on the scrollbar as well as in the gutter.

### src/gui/editorwidget/scrollbar.h
- Purpose: Header for `scrollWidget`.
- Key abstractions: `QScrollBar` subclass with a public `CodeEditor* m_editor`.
- Data flow: n/a.
- Non-obvious design decisions: the class is named `scrollWidget` although it is a scrollbar.
- Edge cases / failure handling: n/a.
- Surprising: the member is public and named with a `m_` prefix.

### src/gui/filebrowser/filebrowser.cpp
- Purpose: The file tree in the sidebar.
- Key abstractions: `QFileSystemModel` with a `QTreeView`.
- Data flow: `setPath(path)` (line 95) also pushes the path to `FileWidget::self()->setPath(path)`; `open()` (line 82) dispatches on the extension — `.sim1`/`.sim2` open as circuits, everything else opens in the editor.
- Non-obvious design decisions: `searchFiles(filter)` switches the model from "all entries" to "files only" and expands the whole tree, which is how the (currently disabled) search field was implemented.
- Edge cases / failure handling: `openExternally` warns if `QDesktopServices::openUrl` fails.
- Surprising: `cdUp()` uses `m_fileSystemModel->index(m_currentPath).parent()` rather than `QDir::cdUp()`.

### src/gui/filebrowser/filebrowser.h
- Purpose: Header for `FileBrowser`.
- Key abstractions: a `QTreeView` with a static `self()`.
- Data flow: n/a.
- Non-obvious design decisions: the header keeps the GPL-3 notice of the original author (Pavel Lamonov) even though the .cpp was rewritten by Santiago González in 2018.
- Edge cases / failure handling: n/a.
- Surprising: `m_showHidden` is a member rather than a query on the model.

### src/gui/filebrowser/filewidget.cpp
- Purpose: The sidebar: bookmark list, path bar and file tree.
- Key abstractions: `m_bookmarkList` (paths) plus the `QListWidget` of entries; each entry stores its path in `Qt::UserRole+4` (`item->setData(4, path)`).
- Data flow: bookmarks are persisted in a `QSettings` array (`beginWriteArray("bookmarks")` / `beginReadArray`).
- Non-obvious design decisions: the fixed entries are "FileSystem", "Home", "User Data", "Settings" and a special "Last Project" entry whose path is resolved at click time from the `lastCircDir` setting.
- Edge cases / failure handling: `addEntry` skips a path that does not exist unless `force` is set (which is how "Last Project" is always added).
- Surprising: the search line edit exists in the .cpp but is commented out, and `searchChanged()` is an empty stub.

### src/gui/filebrowser/filewidget.h
- Purpose: Header for `FileWidget`.
- Key abstractions: a `QSplitter` with vertical orientation holding the bookmark list, the path bar and the browser.
- Data flow: n/a.
- Non-obvious design decisions: `m_blocked` guards the circular update between `setPath` and `pathChanged`.
- Edge cases / failure handling: n/a.
- Surprising: `addEntry(name, path, force)` takes the path as a `QString` that may legitimately be `NULL`.

### src/gui/joystickwidget.cpp
- Purpose: An analogue joystick widget (two axes, 0..1000).
- Key abstractions: `m_knobCenter` (the knob position), `m_maxDistance`.
- Data flow: `updateOutputValues()` (line 48) maps the knob offset to the two axes; the value is polled by the component via `getPos()`.
- Non-obvious design decisions: the widget installs itself as an event filter and only accepts a press within 10 px of the centre (`m_grabCenter`), so clicking elsewhere does not grab the knob; the knob returns to centre on release.
- Edge cases / failure handling: the knob's travel is clamped to `m_maxDistance` with `QLineF::setLength`.
- Surprising: the "knob" is drawn as a *radial gradient disc* with a separate darker centre dot, and the visible knob area is `m_knobArea` (60% of the widget).

### src/gui/joystickwidget.h
- Purpose: Header for `JoystickWidget`.
- Key abstractions: `getPos()` returns the axes; `changed()` says whether they moved since the last poll.
- Data flow: n/a.
- Non-obvious design decisions: the header comment records the original 2020 author and Santiago González's 2020 modification.
- Edge cases / failure handling: n/a.
- Surprising: `getPos()` sets `m_changed = false` after the return statement, which is unreachable — the reset never happens.

### src/gui/memory/headerwidget.cpp
- Purpose: The "Name / Type / Value" header above the watch list.
- Key abstractions: three labels.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: the value column is a `QLabel` (not a `QLineEdit`) — unlike `ValueWidget` — because the header is not editable.

### src/gui/memory/headerwidget.h
- Purpose: Header for `HeaderWidget`.
- Key abstractions: `Ui::HeaderWidget` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: it declares `m_strVal` and `m_type` but only `m_name` is used.

### src/gui/memory/headerwidget.ui
- Purpose: Designer form: three `QLabel`s.
- Key abstractions: `nameLabel`, `typeLabel`, `valueLine`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (200 lines).

### src/gui/memory/mcumonitor.cpp
- Purpose: The MCU monitor window: watch panel, RAM watch table, and RAM/Flash/EEPROM memory tables, plus the STATUS register and PC.
- Key abstractions: three `MemTable`s (RAM, flash, EEPROM), a `RamTable` and the CPU's `Watcher`.
- Data flow: `updateStep()` (line 116) is called per simulation step and refreshes the visible tables from the processor; the STATUS register is read as a raw `uint8_t*` (`m_statusReg`) and painted as eight coloured bits.
- Non-obvious design decisions: only the *visible* tabs are refreshed (`if (m_ramMonitor && m_ramMonitor->isVisible())`), which is the main performance lever for this window. When the flash size is non-zero the PC is followed in the flash table (`setAddrSelected(pc, m_jumpToAddress)`), so the debugger's cursor tracks the program counter.
- Edge cases / failure handling: `createStatusPC()` hides the byte/jump buttons when the CPU has no status register.
- Surprising: the RAM/flash tables are refreshed cell by cell in a loop over the whole memory on *every* step — with the visibility check as the only protection.

### src/gui/memory/mcumonitor.h
- Purpose: Header for `MCUMonitor`.
- Key abstractions: `m_status` and `m_pc` are `QTableWidget`s *by value*.
- Data flow: the three `dataChanged` slots write the edited value back to the processor (`setRamValue`, `setFlashValue`, `setRomValue`).
- Non-obvious design decisions: the memory tables are *editors*: editing a cell in the RAM table writes straight into the simulated memory.
- Edge cases / failure handling: n/a.
- Surprising: `m_statusReg` is a raw pointer into the CPU's status register.

### src/gui/memory/mcumonitor.ui
- Purpose: Designer form: a `QTabWidget` plus byte/jump radio buttons.
- Key abstractions: `QTabWidget`, `QRadioButton byteButton`, `QRadioButton jumpButton`.
- Data flow: visual only.
- Non-obvious design decisions: the tabs are added in code, not in the form.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (103 lines).

### src/gui/memory/memdata.cpp
- Purpose: Loading and saving memory images.
- Key abstractions: static helpers per format: `.data` (comma-separated decimal), Intel HEX, and raw binary.
- Data flow: `loadHex()` (line 119) is a full Intel HEX parser: it validates the start code and the record length, accumulates the checksum, handles record types 0 (data), 2 (extended segment address) and 4 (extended linear address), and verifies the checksum at the end of each record.
- Non-obvious design decisions: `loadFile()` dispatches on the extension, but if an `eMcu*` is supplied it *always* uses the HEX path, because an MCU's configuration words are only meaningful in a HEX file. `saveData()` writes the `.data` format as 16 values per line, padded to four characters.
- Edge cases / failure handling: a wrong start code, a wrong record length or a checksum error aborts the load with a line number; "No End Of File reached" is an error; a record that runs past the end of memory is written to the MCU's configuration word if possible and otherwise reported as "PGM End reached".
- Surprising: `saveDat`, `saveHex` and `saveBin` are **empty stubs** — only the combined `saveData` path is implemented.

### src/gui/memory/memdata.h
- Purpose: Header for `MemData`.
- Key abstractions: `static eMcu* m_eMcu` — a static "current MCU" that the loaders set and clear.
- Data flow: n/a.
- Non-obvious design decisions: `getMem`/`setMem` encode a whole memory blob as a comma-separated string — this is how a memory image is stored *inside a component property* (and therefore in the circuit file).
- Edge cases / failure handling: n/a.
- Surprising: the static `m_eMcu` is a global, set and cleared around the load.

### src/gui/memory/memtable.cpp
- Purpose: The hex+ASCII memory viewer/editor.
- Key abstractions: `m_data` points at the live `QVector<int>`; `m_byteRatio` is `wordBytes/cellBytes` so a 16-bit memory can be shown as bytes.
- Data flow: `on_table_itemChanged()` (line 197) parses the edited cell (hex column or ASCII column), assembles the word from the byte cells when `m_byteRatio > 1`, writes it into `m_data` and emits `dataChanged(address, value)`.
- Non-obvious design decisions: **editing a cell pauses the simulation** (`Simulator::self()->pauseSim()`) and resumes it afterwards, so a half-written word cannot be observed by the engine. The tooltip for the hovered cell shows the value in hex/dec/oct/bin.
- Edge cases / failure handling: an unparseable cell is reverted to the stored value (`else if (m_data) setValue(dataAddr, m_data->at(dataAddr))`).
- Surprising: `updateTable()` (line 42) throttles to every tenth call — a deliberate performance guard for the per-step refresh path.

### src/gui/memory/memtable.h
- Purpose: Header for `MemTable`.
- Key abstractions: the `dataChanged(int address, int val)` signal; `m_canSaveLoad` gates the context menu.
- Data flow: n/a.
- Non-obvious design decisions: `m_addrBytes` is computed from the data size with `ceil(ceil(log2(dataSize))/8)`.
- Edge cases / failure handling: n/a.
- Surprising: `m_hoverItem` is used to decide whether to show the value tooltip.

### src/gui/memory/memtable.ui
- Purpose: Designer form: one `QTableWidget` plus save/load context-menu actions.
- Key abstractions: `QTableWidget table`.
- Data flow: visual only.
- Non-obvious design decisions: the table's column and row headers are built entirely in code (33 columns: 16 hex, a spacer, 16 ASCII).
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (153 lines).

### src/gui/memory/ramtable.cpp
- Purpose: The symbol watch table: resolve names to addresses and decode their values.
- Key abstractions: `watchList` (row -> symbol name), `m_varsTable` (name -> address), `m_typeTable` (name -> type).
- Data flow: `addToWatch()` (line 310) is the row resolver: a name may be a literal address (decimal or `0x` hex), a known variable (from the debugger), or a register (from the MCU). `updateValues()` (line 374) then reads RAM and formats the value according to the type.
- Non-obvious design decisions: the type decoder handles 8/16/32-bit integers (signed and unsigned), floats and doubles by assembling the bytes and `memcpy`-ing them; `string` type reads consecutive RAM bytes until a length byte. Array variables are expanded into their elements by looking at the *next* names in `m_varNames` (lines 359-372).
- Edge cases / failure handling: an unresolvable name leaves the row blank; `getCurrentAddr()` returns -1 for the "---" placeholder.
- Surprising: the value column shows three representations at once for 8-bit values ("dec 0xFF 11111111").

### src/gui/memory/ramtable.h
- Purpose: Header for `RamTable`.
- Key abstractions: `m_debugger` (a `BaseDebugger*`) is the source of variable types; `setDebugger`/`remDebugger` manage its lifetime (`BaseDebugger`'s destructor calls `remDebugger`).
- Data flow: n/a.
- Non-obvious design decisions: `m_cpuMonitor` switches the whole table between "MCU monitor" mode (name -> CPU register) and "debugger" mode (name -> RAM address).
- Edge cases / failure handling: n/a.
- Surprising: `loadVarSet()`/`saveVarSet()` are declared twice — once as a slot taking no arguments and once as a method taking a `QStringList`.

### src/gui/memory/ramtable.ui
- Purpose: Designer form: a splitter with a register list, a variable list and a four-column table.
- Key abstractions: `QListView registers`, `QListView variables`, `QTableWidget table`.
- Data flow: visual only.
- Non-obvious design decisions: the vertical header is movable so the user can reorder watch rows.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (199 lines).

### src/gui/memory/vallabelwidget.cpp
- Purpose: The compact watch row used when the watcher is drawn *on the canvas* as a proxy widget.
- Key abstractions: same name/type/value API as `ValueWidget`, but with `QLabel`s instead of a line edit.
- Data flow: `updateValue()` pulls from the `Watched` core exactly like `ValueWidget`.
- Non-obvious design decisions: the widget is 11 px tall with a fixed 50 px value column so many rows fit inside a small canvas item.
- Edge cases / failure handling: none.
- Surprising: it duplicates `ValueWidget`'s formatting logic but *without* the dec/hex/bin rendering — the integer path just prints the number.

### src/gui/memory/vallabelwidget.h
- Purpose: Header for `ValLabelWidget`.
- Key abstractions: `Ui::ValLabelWidget` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: `m_intVal` is declared but never used.

### src/gui/memory/vallabelwidget.ui
- Purpose: Designer form: three `QLabel`s.
- Key abstractions: `nameLabel`, `valueLabel`, `typeLabel`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (371 lines).

### src/gui/memory/valuewidget.cpp
- Purpose: The full watch row in the MCU monitor.
- Key abstractions: `m_type` (lowercased) drives the formatting.
- Data flow: `updateValue()` reads from the `Watched` core; `setValueInt()` formats 8-bit and 16-bit values as dec/hex/bin.
- Non-obvious design decisions: the unit label falls back to the type name when no unit is supplied.
- Edge cases / failure handling: an unknown type just prints the plain number.
- Surprising: the `double` branch is `if` not `else if`, so a "double" type also falls into the integer branch (`setValueInt(getIntReg(...))`) — the double is computed and discarded.

### src/gui/memory/valuewidget.h
- Purpose: Header for `ValueWidget`.
- Key abstractions: `Ui::ValueWidget` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: `m_intVal` is unused.

### src/gui/memory/valuewidget.ui
- Purpose: Designer form: name and type labels plus a read-only value line edit.
- Key abstractions: `QLineEdit valueLine`.
- Data flow: visual only.
- Non-obvious design decisions: the value is a read-only `QLineEdit` (so it can be selected and copied) rather than a label.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (342 lines).

### src/gui/memory/watched.cpp
- Purpose: The tiny interface a CPU implements so the GUI can watch it.
- Key abstractions: none beyond the base class.
- Data flow: `createWatcher(proxy)` lazily builds the `Watcher` panel.
- Non-obvious design decisions: the destructor deliberately does *not* delete the watcher (`//if( m_watcher ) m_watcher->deleteLater();` is commented out) — the watcher's lifetime is managed elsewhere.
- Edge cases / failure handling: n/a.
- Surprising: `m_display` is declared as a `DisplayArea*` with the comment "Find a place for this".

### src/gui/memory/watched.h
- Purpose: Header for `Watched`.
- Key abstractions: virtual `command(QString)`, `getDblReg`, `getIntReg`, `getStrReg`.
- Data flow: n/a.
- Non-obvious design decisions: all four have empty default implementations, so a CPU only implements what it has.
- Edge cases / failure handling: n/a.
- Surprising: `getIntReg` defaults to **-1** (not 0), so an unknown register reads as "not found".

### src/gui/memory/watcher.cpp
- Purpose: The watch panel: registers, variables, live values and an optional console.
- Key abstractions: two `QStandardItemModel`s (registers, variables), a `QMap<QString, ValueWidget*>` of the live value rows, and `m_typeTable`/`m_unitTable`.
- Data flow: `updateValues()` (line 97) refreshes every value widget; `insertValue(name)` (line 183) creates the row when a symbol is double-clicked; `getVarSet()` returns the watch list *in layout order* (it walks the layout indices, not the map keys) so the saved set matches what the user sees.
- Non-obvious design decisions: in **proxy mode** (the watcher drawn on the canvas) the widget uses `ValLabelWidget`s and is draggable by mouse over the scene (`mouseMoveEvent` maps the cursor through `CircuitView` and moves the `QGraphicsProxyWidget`); in normal mode it uses `ValueWidget`s and a table view. The proxy mode even resizes itself to fit the number of rows.
- Edge cases / failure handling: `insertValue` refuses a duplicate name; `addRegister`/`addVariable` refuse a name already in the type table.
- Surprising: `mouseReleaseEvent` calls `QWidget::mouseMoveEvent` instead of `mouseReleaseEvent` (line 249) — a copy-paste slip.

### src/gui/memory/watcher.h
- Purpose: Header for `Watcher`.
- Key abstractions: `m_valuesLayout` (a `QBoxLayout` holding the value rows), `m_values`/`m_valLabels` maps.
- Data flow: n/a.
- Non-obvious design decisions: `setProxy(QGraphicsProxyWidget*)` makes every child `QSizePolicy::Ignored` so the canvas item sizes the panel itself.
- Edge cases / failure handling: n/a.
- Surprising: the header declares `Console* console()` although `Console` is declared in the serial sub-tree.

### src/gui/memory/watcher.ui
- Purpose: Designer form: a splitter with a register list, a variable list and a values container.
- Key abstractions: `QListView regView`, `QListView varView`, `QWidget valuesWidget`.
- Data flow: visual only.
- Non-obvious design decisions: the values container is promoted to a native widget so a layout can be installed on it at runtime.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (102 lines).

### src/gui/outpaneltext.cpp
- Purpose: The shared output log (compiler output, script output, simulator messages).
- Key abstractions: `OutHighlighter`, a `QSyntaxHighlighter` with a small rule table.
- Data flow: `appendLine()` (line 36) buffers the text and flushes it immediately when the simulation is *not* running, otherwise it waits for the next `updateStep()` — so the log never repaints mid-step.
- Non-obvious design decisions: the highlighter's rules recognise `/path` (green), numbers (blue), hex (blue), quoted strings, and the words SUCCESS (bold), WARNING (orange), ERROR (yellow on orange) and `SENT:`.
- Edge cases / failure handling: the document is capped at 1000 blocks *and* at 100000 characters, at which point the oldest text is dropped (`setPlainText(toPlainText().right(90000))`).
- Surprising: `appendLine` and `appendText` have different semantics — `appendText` (in the header) only buffers, `appendLine` flushes when idle.

### src/gui/outpaneltext.h
- Purpose: Header for `OutPanelText` and `OutHighlighter`.
- Key abstractions: `OutHighlighter` is declared in the same header as the panel.
- Data flow: n/a.
- Non-obvious design decisions: the panel is an `Updatable` so it gets the per-step flush.
- Edge cases / failure handling: n/a.
- Surprising: `OutPanelText` is used in *three* places (the circuit panel, the editor and the serial monitor), each with its own instance.

### src/gui/properties/boolprop.h
- Purpose: A boolean property bound to a component getter/setter.
- Key abstractions: `template <class Comp> class BoolProp : public ComProperty`.
- Data flow: `setValStr("true")` calls the component's setter; `getValStr()` returns "true"/"false".
- Non-obvious design decisions: **the property classes are templates over the component type and take member-function pointers**, so a property is declared in one line at the component's construction site:
  `new BoolProp<X>("Name", tr("Name"), "", this, &X::name, &X::setName)`.
  No registration step, no ID, no virtual table per component.
- Edge cases / failure handling: the setter receives `val == "true"`, so any other string is false.
- Surprising: the `flags` parameter defaults to 0 and `type` defaults to "bool" — the type string is what the property dialog dispatches on.

### src/gui/properties/boolval.cpp
- Purpose: The editor widget for a boolean property.
- Key abstractions: `PropVal` + `Ui::BoolVal`.
- Data flow: `on_trueVal_toggled()` (line 36) calls `prepareChange()` (opens an undo step and remembers the old value), then `m_property->setValStr(...)`, then `saveChanges()` (records the change and closes the undo step).
- Non-obvious design decisions: **every property editor goes through the same two-call undo protocol** (`prepareChange` / `saveChanges`), so undo works uniformly for booleans, numbers, enums, strings and colours.
- Edge cases / failure handling: `m_blocked` stops the widget from reacting to its own updates.
- Surprising: the check box's caption is the property's caption, so there is no separate label.

### src/gui/properties/boolval.h
- Purpose: Header for `BoolVal`.
- Key abstractions: `Ui::BoolVal` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/boolval.ui
- Purpose: Designer form: one `QCheckBox` named `trueVal`.
- Key abstractions: `QCheckBox`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (67 lines).

### src/gui/properties/colorval.cpp
- Purpose: The editor widget for a colour property.
- Key abstractions: `m_color`; an event filter on the read-only field.
- Data flow: `changeColor()` (line 52) opens a `QColorDialog` (forced non-native so it looks the same on every platform), writes the colour *name* to the component and calls `m_propDialog->changed()`.
- Non-obvious design decisions: the colour is written directly with `m_component->setPropStr(m_propName, colorStr)` instead of going through `m_property->setValStr` — so the colour change does **not** go through the undo protocol.
- Edge cases / failure handling: an invalid colour from the dialog is ignored.
- Surprising: `updtValues()` is empty, so the colour swatch is not refreshed if the property changes elsewhere.

### src/gui/properties/colorval.h
- Purpose: Header for `ColorVal`.
- Key abstractions: it declares its own `m_blocked`, shadowing `PropVal::m_blocked` — the two are independent.
- Data flow: n/a.
- Non-obvious design decisions: the event filter is the only interaction; there is no button.
- Edge cases / failure handling: n/a.
- Surprising: the shadowed `m_blocked` member is a real bug source.

### src/gui/properties/colorval.ui
- Purpose: Designer form: a caption label, a swatch line edit and a `showVal` radio button.
- Key abstractions: `QLineEdit colorW`.
- Data flow: visual only.
- Non-obvious design decisions: the swatch is a line edit whose *background* is tinted with the colour.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (71 lines).

### src/gui/properties/comproperty.cpp
- Purpose: The base of every property.
- Key abstractions: name, caption, unit, type, flags.
- Data flow: `getValStr()`/`setValStr()` are the string-level interface the file format uses.
- Non-obvious design decisions: the base class is a *string* property — `getValue()` is `getValStr().toDouble()` and `toString()` is `getValStr()`.
- Edge cases / failure handling: `setValStr` is a no-op in the base class.
- Surprising: the `unit` field is overloaded — for a numeric property it is the SI unit, for an enum property it is the *value list and label list*, for a path property it is a marker, and for a string property it is unused.

### src/gui/properties/comproperty.h
- Purpose: Header for `ComProperty`.
- Key abstractions: `enum propFlags { propHidden = 1, propNoCopy = 1<<1 }`.
- Data flow: n/a.
- Non-obvious design decisions: `propNoCopy` means "do not copy this property into a subcircuit instance" — used for things like the internal pin configuration.
- Edge cases / failure handling: n/a.
- Surprising: `propHidden` is a *property* flag while `groupHidden` is a *group* flag, and they are separate enums with the same name in different headers.

### src/gui/properties/doubleprop.h
- Purpose: A double property bound to a component getter/setter.
- Key abstractions: `template <class Comp> class DoubProp : public NumProp`.
- Data flow: `setValStr` (inherited from `NumProp`) parses the string with the unit and calls `setVal(double)`, which calls the component's setter; `getValue()` calls the getter.
- Non-obvious design decisions: the numeric conversion (string -> double -> unit multiplier) lives in `NumProp`, and the typed subclass only supplies the setter/getter bridge.
- Edge cases / failure handling: n/a.
- Surprising: `setVal` is declared `private virtual` in the base but `protected`-style access is used by the subclass — it compiles because the override is in the derived class.

### src/gui/properties/dspinbox.cpp
- Purpose: A numeric field that evaluates arithmetic expressions.
- Key abstractions: a static AngelScript engine (`asCreateScriptEngine()`), created once for the whole application.
- Data flow: `valueFromText()` (line 30) pads a trailing `e`/`+`/`-`/`*`/`/` with a digit so the expression is syntactically valid, then `evaluate()` runs `"return <expr>"` through `ExecuteString` and returns the double. `validate()` (line 25) returns `Invalid` if the result is NaN.
- Non-obvious design decisions: **the property editor accepts a whole expression**, so a student can type `4.7k*2` into a resistor value field and get `9.4k`. The scripting engine is reused from the circuit-script subsystem.
- Edge cases / failure handling: a syntax error or an undefined symbol yields a non-positive return code from `ExecuteString` and the function returns `NAN`, which the validator turns into `Invalid`.
- Surprising: the "trailing operator" padding is a heuristic that makes `1e` mean `1e0` and `1/` mean `1/1`.

### src/gui/properties/dspinbox.h
- Purpose: Header for `DSpinBox`.
- Key abstractions: `static asIScriptEngine* m_aEngine`.
- Data flow: n/a.
- Non-obvious design decisions: the engine is a static member so a single engine serves every spin box.
- Edge cases / failure handling: n/a.
- Surprising: the header includes `scripthelper.h` from the AngelScript bundle, so the GUI layer depends on the script engine.

### src/gui/properties/enumval.cpp
- Purpose: The editor widget for an enumeration property.
- Key abstractions: `m_enums` (the stored values) and the combo box's items (the displayed labels); the property's `unit` string is `"v1,v2;Label1,Label2"`.
- Data flow: `setEnums(e)` (line 40) splits the unit string into the value list and the label list and repopulates the combo; `on_valueBox_currentIndexChanged` (line 73) writes the *value* (not the label) back to the property.
- Non-obvious design decisions: the option list can be replaced at runtime — `InoDebugger::compilerProps` uses this to add the user's installed Arduino boards to the "Board" enumeration.
- Edge cases / failure handling: if there is no label list, the values are used as the labels.
- Surprising: `valueBox->setCurrentIndex(m_enums.indexOf(valStr))` — an unknown stored value yields index -1, i.e. no selection.

### src/gui/properties/enumval.h
- Purpose: Header for `EnumVal`.
- Key abstractions: `m_enums` (the value list).
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/enumval.ui
- Purpose: Designer form: a caption label, a combo box and a `showVal` radio button.
- Key abstractions: `QComboBox valueBox`.
- Data flow: visual only.
- Non-obvious design decisions: the combo box width is fixed in code (170 px * scale), not in the form.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (96 lines).

### src/gui/properties/intprop.h
- Purpose: An integer property bound to a component getter/setter.
- Key abstractions: `template <class Comp> class IntProp : public NumProp`.
- Data flow: as `DoubProp`, but the setter takes an `int`.
- Non-obvious design decisions: the type string is "int"; the `uint` type used elsewhere is declared by passing `type="uint"` to the same template.
- Edge cases / failure handling: n/a.
- Surprising: the numeric value is transported as a `double` internally (`NumProp`), so a 64-bit integer would lose precision.

### src/gui/properties/labelval.cpp
- Purpose: The plain caption row used to introduce groups of properties.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: the font-size code is entirely commented out.

### src/gui/properties/labelval.h
- Purpose: Header for `LabelVal`.
- Key abstractions: `Ui::LabelVal` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/labelval.ui
- Purpose: Designer form: one `QLabel` named `label`.
- Key abstractions: `QLabel`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (88 lines).

### src/gui/properties/numprop.cpp
- Purpose: The numeric property codec.
- Key abstractions: `getVal(QString)` and `getStr(double)` — the string<->value conversion with unit handling.
- Data flow: `getVal` (line 24) splits the string into "number unit", adopts the unit if it does not start with "_", and multiplies by `getMultiplier(m_unit)`; `getStr` divides by the multiplier and appends the unit.
- Non-obvious design decisions: **the unit is stored on the property and is part of the saved string**, so a value saved as "4.7 kΩ" round-trips through the file. A unit starting with "_" means "no multiplier".
- Edge cases / failure handling: a string with no unit part leaves the property's unit unchanged.
- Surprising: the unit string is *replaced* by whatever the user typed, which is how a unit change is persisted.

### src/gui/properties/numprop.h
- Purpose: Header for `NumProp`.
- Key abstractions: the pure virtual `setVal(double)`.
- Data flow: n/a.
- Non-obvious design decisions: the class is deliberately not templated; the typed subclasses (`IntProp`, `DoubProp`) supply the component binding.
- Edge cases / failure handling: n/a.
- Surprising: `getValue()` is declared in the base (`ComProperty`) and overridden in the typed subclasses.

### src/gui/properties/numval.cpp
- Purpose: The editor widget for a numeric property.
- Key abstractions: `m_useMult` (whether the unit has an SI multiplier), the unit combo box.
- Data flow: `setup()` (line 24) inspects the property's unit: an empty unit hides the combo box; a unit starting with "_" means a fixed unit with no multiplier; otherwise the combo is filled with `k/M/G/T` (and `p/n/µ/m` for doubles). `on_valueBox_valueChanged` (line 91) writes the value *with* its unit so the SI prefix is preserved.
- Non-obvious design decisions: the "show value on the canvas" radio writes the property name into the component's `ShowProp` and the formatted value into `ValLabelText`, so the value appears next to the component on the canvas.
- Edge cases / failure handling: `m_blocked` prevents the value box and the unit box from echoing each other.
- Surprising: `updtValues()` divides the stored value by the current multiplier, so the box always shows the value *in the selected unit*.

### src/gui/properties/numval.h
- Purpose: Header for `NumVal`.
- Key abstractions: `getValWithUnit()`.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/numval.ui
- Purpose: Designer form: a caption label, a `DSpinBox` value box, a unit combo box, a unit spacer and a `showVal` radio button.
- Key abstractions: `DSpinBox valueBox` — the expression-evaluating spin box is the standard numeric editor.
- Data flow: visual only.
- Non-obvious design decisions: `unitSpace` is a label used to keep the layout stable when the combo box is hidden.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (213 lines).

### src/gui/properties/pathval.cpp
- Purpose: The editor widget for a file or directory property.
- Key abstractions: `m_isFile` selects the dialog.
- Data flow: `on_setPathButton_clicked()` (line 42) resolves the current text relative to the circuit's directory before opening the dialog; `on_value_editingFinished()` appends a trailing separator for directories so the path is always usable as a prefix.
- Non-obvious design decisions: paths are stored relative to the circuit file when possible (the browse dialog is seeded with the circuit's folder).
- Edge cases / failure handling: an empty path is left alone.
- Surprising: `PathVal` does **not** use the `prepareChange`/`saveChanges` undo protocol — it calls `m_propDialog->changed()` only, so path edits are not undoable.

### src/gui/properties/pathval.h
- Purpose: Header for `PathVal`.
- Key abstractions: `m_isFile`.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/pathval.ui
- Purpose: Designer form: caption label, value line edit and a "set path" button.
- Key abstractions: `QLineEdit value`, `QPushButton setPathButton`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (87 lines).

### src/gui/properties/pointprop.h
- Purpose: A `QPointF` property bound to a component getter/setter.
- Key abstractions: `template <class Comp> class PointProp : public ComProperty`.
- Data flow: `setValStr` decodes "x,y" with `getPointF`; `getValStr` encodes with `getStrPointF`.
- Non-obvious design decisions: the encoding helpers live in `proputils.h` rather than in the template.
- Edge cases / failure handling: `getPointF` uses `plist.first()` and `plist.last()`, so a malformed string silently yields (first, last).
- Surprising: the type string is "point", which the property dialog does not have a widget for — so point properties are never shown in the dialog, only in the file.

### src/gui/properties/propdialog.cpp
- Purpose: The property editor window, built entirely at runtime.
- Key abstractions: `CompBase::properties()` (a list of `propGroup`s) and the type-to-widget dispatch (lines 105-114).
- Data flow: `setComponent(comp, isComp)` (line 40) walks the groups, creates a tab per group, creates a `PropVal` per property according to its `type` string, and wires the widgets into per-group layouts.
- Non-obvious design decisions: **the type string is the whole extension mechanism**: "double"/"uint"/"int" -> `NumVal`, "color" -> `ColorVal`, "string" -> `StrVal`, "path"/"file" -> `PathVal`, "textEdit" -> `TextVal`, "enum" -> `EnumVal`, "bool" -> `BoolVal`. A component with a new kind of property needs a new widget *and* one line here. A property with an empty name is a pure label (or a separator).
- Edge cases / failure handling: `groupHidden` groups are skipped entirely; `propHidden` properties are skipped; a property on a subcircuit's *main component* that is flagged `propNoCopy` is disabled rather than hidden. If the component has no visible group, the tab widget is hidden.
- Surprising: `updtValues()` (line 220) calls `m_component->setup()` at the end — every refresh of the dialog re-runs the component's own setup hook.

### src/gui/properties/propdialog.h
- Purpose: Header for `PropDialog`.
- Key abstractions: `m_propList` (the `PropVal` widgets), `m_minW`/`m_minH`/`m_scale` for the auto-sizing.
- Data flow: `getPropWidget(name)` lets a component reach into the dialog (the Arduino debugger uses it to modify the "Board" enum).
- Non-obvious design decisions: `showProp(name, show)` hides a property dynamically — `PlotBase::updtProperties` uses it to hide "InputImped" unless the plot is grounded.
- Edge cases / failure handling: `m_component` may be null until `setComponent` is called, and several slots check for that.
- Surprising: `adjustWidgets()` (declared here at line 36, defined in `src/gui/properties/propdialog.cpp:189`) computes the dialog height from the number of *visible* widgets in the current tab (`count*24*scale+90*scale`), a hand-rolled layout heuristic — and the header is what declares the `m_minW`/`m_minH`/`m_scale` triple it reads.

### src/gui/properties/propdialog.ui
- Purpose: Designer form: a type label, a help button, the component label box with a "show id" check box, a `QTabWidget` and a help text pane.
- Key abstractions: `QTabWidget tabList`, `QTextEdit helpText`.
- Data flow: visual only.
- Non-obvious design decisions: the two placeholder tabs in the form are cleared at runtime (`tabList->clear()`).
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (237 lines).

### src/gui/properties/proputils.cpp
- Purpose: The two parsers the whole file format rests on.
- Key abstractions: `propStr_t { QString name; QString value; }`.
- Data flow: `parseXmlProps(line)` (line 24) splits an `<item name="value" name2="value2" .../>` line on `"` and alternates between name and value; `parseProps`/`parseProp` (lines 45-76) do the same for the older `name=value;name=value` form.
- Non-obvious design decisions: the parser is deliberately *not* a real XML parser — it is a token splitter that assumes the file was written by `CompBase::toString()` (quoted values, always in pairs). That makes it fast and tolerant of the legacy format.
- Edge cases / failure handling: `parseProp` only strips *leading* spaces from the name ("Only remove leading spaces"), so a name with internal spaces survives.
- Surprising: `parseXmlProps` computes the name as the text after the last space in the token before the value — it relies on the writer's exact spacing.

### src/gui/properties/proputils.h
- Purpose: Header for the property parsers and the point codec.
- Key abstractions: `propStr_t`; `QVector<propStr_t> parseXmlProps(QString line)`.
- Data flow: n/a.
- Non-obvious design decisions: `parseXmlProps` and `parseProps` are two parallel implementations of the same idea, for the two file dialects.
- Edge cases / failure handling: n/a.
- Surprising: `QStringView` is included for the parsers.

### src/gui/properties/propval.cpp
- Purpose: The base of every property editor widget, and the bridge to the undo system.
- Key abstractions: `m_undo` (whether this property participates in undo), `m_oldValue`.
- Data flow: `prepareChange()` (line 41) records the old value and calls `Circuit::self()->beginUndoStep()`; `saveChanges()` (line 49) calls `calcCircuitChanges()` then `addCompChange(componentUid, propName, oldValue)` then `endCircuitBatch()`.
- Non-obvious design decisions: the comment at line 51 explains the unusual ordering: `// Don'use endUndoStep() because We need addCompChange() before endCircuitBatch()`. The undo record is *the property name and its previous string value*, not a snapshot — so undo is a property-level diff, while component creation is a full-text diff. Two granularities coexist in the same stack.
- Edge cases / failure handling: properties flagged `propNoCopy` are excluded from undo (`m_undo = m_property->flags() & propNoCopy` — note the flag name is about copying, but it is reused as the "do not undo" marker).
- Surprising: `addDividers`/`addMultipliers` are helpers for the unit combo boxes and live in the base class.

### src/gui/properties/propval.h
- Purpose: Header for `PropVal`.
- Key abstractions: the pure virtual `setup(bool isComp)`; `updtValues()`, `getValWithUnit()`.
- Data flow: n/a.
- Non-obvious design decisions: the base class holds `m_component`/`m_property`/`m_propDialog` so every editor widget can reach the model.
- Edge cases / failure handling: n/a.
- Surprising: `PropVal` is a `QWidget` but not a `QObject` subclass with `Q_OBJECT`, so it cannot have its own signals.

### src/gui/properties/scriptprop.h
- Purpose: A property whose value is produced by the component itself.
- Key abstractions: the getter receives the `ComProperty*` and returns a string; the setter receives the property and the new value.
- Data flow: `setValStr` calls `(m_comp->*m_setter)(this, val)` — the *property object* is passed so the component can ask for the property's name or unit.
- Non-obvious design decisions: the comment `// Call setter with property name` shows the intent — the component writes the value back through the property it was handed.
- Edge cases / failure handling: n/a.
- Surprising: the getter and setter both take the property as an argument, unlike every other property type.

### src/gui/properties/stringprop.h
- Purpose: A string property bound to a component getter/setter.
- Key abstractions: `template <class Comp> class StrProp : public ComProperty`.
- Data flow: `setValStr` calls the component's setter with the raw string; `getValStr` calls the getter.
- Non-obvious design decisions: the comment `// Comp setter can change valLabel` records that the setter is allowed to have side effects on the component's own label.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/strval.cpp
- Purpose: The editor widget for a string property.
- Key abstractions: `PropVal` + `Ui::StrVal`.
- Data flow: `on_value_editingFinished()` (line 35) commits the text via `prepareChange`/`saveChanges`.
- Non-obvious design decisions: the commit happens on `editingFinished` (focus loss or Enter), not on every keystroke.
- Edge cases / failure handling: none.
- Surprising: the field's width is fixed in code (192 px * scale).

### src/gui/properties/strval.h
- Purpose: Header for `StrVal`.
- Key abstractions: `Ui::StrVal` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

### src/gui/properties/strval.ui
- Purpose: Designer form: a caption label and a value line edit.
- Key abstractions: `QLabel valLabel`, `QLineEdit value`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (59 lines).

### src/gui/properties/textval.cpp
- Purpose: The editor widget for a multi-line text property.
- Key abstractions: none beyond `PropVal`.
- Data flow: `on_textBox_textChanged()` (line 49) writes the plain text to the property on *every* keystroke (no undo protocol).
- Non-obvious design decisions: `setup()` decodes the XML entities the file format escapes (`&#xa;` -> newline, `&#x22;` -> quote, `&#x3D`/`&#x3C`/`&#x3E` -> `=`/`<`/`>`).
- Edge cases / failure handling: n/a.
- Surprising: the "save and evaluate script" feature is entirely commented out, and `updatValue()`/`updtValues()` are empty — the widget writes but never re-reads.

### src/gui/properties/textval.h
- Purpose: Header for `TextVal`.
- Key abstractions: `Ui::TextVal` mixin.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: the `m_scriptComp` member and the `Scripted` forward declaration are commented out.

### src/gui/properties/textval.ui
- Purpose: Designer form: one `QTextEdit` named `textBox`.
- Key abstractions: `QTextEdit`.
- Data flow: visual only.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (59 lines).

### src/gui/serial/console.cpp
- Purpose: The console for a scripted CPU: shows the script's output and accepts commands.
- Key abstractions: `Updatable` so it flushes once per simulation step.
- Data flow: `appendText()` (line 68) only buffers; `updateStep()` (line 41) inserts the buffer with a green-on-black colour and scrolls to the bottom. A typed line is accumulated in `m_command` and, on Enter, is handed to `Watched::command()` on the next step.
- Non-obvious design decisions: the console refuses to accept input when the simulation is not running (`if (!Simulator::self()->isRunning()) return;`).
- Edge cases / failure handling: the document is capped at 100 blocks.
- Surprising: the arrow keys are swallowed (the case list falls through to `break`) so the user cannot scroll the console with the keyboard; the context menu is empty (the default one is suppressed).

### src/gui/serial/console.h
- Purpose: Header for `Console`.
- Key abstractions: `m_command` (the line being typed), `m_buffer` (pending output), `m_sendCommand`.
- Data flow: n/a.
- Non-obvious design decisions: the class has no `Q_OBJECT` (it uses no signals/slots).
- Edge cases / failure handling: n/a.
- Surprising: `mouseDoubleClickEvent` is overridden to do nothing, disabling double-click word selection.

### src/gui/serial/serialmon.cpp
- Purpose: The UART monitor.
- Key abstractions: two `OutPanelText` panels (in and out), the print mode (ASCII/HEX/DEC/OCT/BIN).
- Data flow: `printIn(value)`/`printOut(value)` (lines 93/99) append a formatted byte to the corresponding panel; the panel is itself an `Updatable`, so the flush happens once per step.
- Non-obvious design decisions: the "send" half of the widget is *removed from the layout* when the monitor is read-only (`sendLayout->removeWidget(text); ... deleteLater();`) — the same widget class serves both the transmit and receive-only cases.
- Edge cases / failure handling: `closeEvent` calls `m_module->monitorClosed()` so the component knows the monitor went away.
- Surprising: the actual transmission code is commented out (`m_module->sendByte(...)` is commented), and the outgoing bytes are only accumulated into `m_outBuffer`, which is never sent — so the send path appears incomplete in this revision.

### src/gui/serial/serialmon.h
- Purpose: Header for `SerialMonitor`.
- Key abstractions: `m_printMode`, `m_addCR`, `m_paused`, `m_outBuffer`.
- Data flow: n/a.
- Non-obvious design decisions: the two panels are `OutPanelText` members (by value), reused from the circuit panel's output log widget.
- Edge cases / failure handling: n/a.
- Surprising: `activateSend()` reveals the send widgets again after construction.

### src/gui/serial/serialmon.ui
- Purpose: Designer form: a pause tool button, a print-mode combo box, the text and value send fields with an add-CR check box, and clear buttons for the two panels.
- Key abstractions: `QComboBox printBox`, `QLineEdit text`, `QLineEdit value`, `QCheckBox addCrButton`.
- Data flow: visual only.
- Non-obvious design decisions: the two `OutPanelText` panels are inserted into `panelLayout` at runtime, because they are C++ widgets rather than form widgets.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (346 lines).

### src/gui/serial/terminal.cpp
- Purpose: The newer bidirectional byte terminal.
- Key abstractions: a text buffer that is flushed once per step; `sendBytes` and `closed` signals.
- Data flow: `received(uint8_t)` (line 75) formats the byte according to the print mode and appends it to the buffer; `sendText()`/`sendValue(base)` emit `sendBytes`. The component on the other end of the signal is outside this shard.
- Non-obvious design decisions: sent data is echoed into the receive pane in yellow so the user can see what went out; the send and receive panes are separated by a splitter.
- Edge cases / failure handling: the "load file to send" and "save log" buttons read and write text files; a file error is reported with `qDebug`.
- Surprising: `sendValue` parses space-separated numbers in the chosen base and *ignores* the parse failure (`bool ok;` is declared and never checked).

### src/gui/serial/terminal.h
- Purpose: Header for `Terminal`.
- Key abstractions: `sendBytes(QByteArray)` and `closed()` signals.
- Data flow: n/a.
- Non-obvious design decisions: `Terminal` is an `Updatable` and registers itself with the simulator.
- Edge cases / failure handling: n/a.
- Surprising: the copyright year is 2026 while the rest of the GUI is 2012-2025.

### src/gui/serial/terminal.ui
- Purpose: Designer form: a splitter with a receive `QTextEdit` and a send panel containing an input `QPlainTextEdit`, send/clear/load buttons and base combo boxes.
- Key abstractions: `QSplitter`, `QComboBox printBox` and `sendBox`.
- Data flow: visual only.
- Non-obvious design decisions: the send and print base selections are independent.
- Edge cases / failure handling: n/a.
- Surprising: read via widget inventory (457 lines).

### src/gui/sourcewidget.cpp
- Purpose: The knob-plus-button widget used by the signal-source components.
- Key abstractions: `DialWidget` plus a `CustomButton`.
- Data flow: the button is checkable and lives under the knob in the same vertical layout.
- Non-obvious design decisions: the dial is reset to 0 (the minimum) for a source component.
- Edge cases / failure handling: n/a.
- Surprising: the button's font is 8 px and its letter spacing is reduced on Windows, matching the code editor's font tweaks.

### src/gui/sourcewidget.h
- Purpose: Header for `SourceWidget`.
- Key abstractions: `CustomButton* pushButton` is a **public** member.
- Data flow: n/a.
- Non-obvious design decisions: the class does not derive from `Q_OBJECT` even though it declares no signals.
- Edge cases / failure handling: n/a.
- Surprising: `SourceWidget` has a default constructor with no parent argument, unlike `DialWidget`.

### src/gui/testing/batchtest.cpp
- Purpose: The repository's regression harness: run a folder of circuits and check their results.
- Key abstractions: static state — `m_circFiles` (the queue), `m_failedTests`, `m_testUnits` (the components currently testing).
- Data flow: `doBatchTest(folder)` (line 19) recursively collects every `.sim1`/`.sim2` file; `runNextCircuit()` (line 54) loads one, powers the simulation on, and waits; `checkFinished()` polls every 100 ms; each in-circuit `PlotBase` with a test time calls `BatchTest::addTestUnit` at start and `BatchTest::testCompleted(component, ok)` at the end.
- Non-obvious design decisions: **the test oracle lives inside the circuit, not in the harness.** The circuit contains a measurement component with `DoTest` set and a `TestData` property holding the expected waveform; the harness only sequences the circuits and collects the failures. A circuit is a test case, and its expected output travels with it.
- Edge cases / failure handling: a failing circuit is recorded once in `m_failedTests` (the list is de-duplicated); when the queue empties the harness prints "All tests passed" or the list of failures.
- Surprising: the polling loop uses `QTimer::singleShot(100, ...)` rather than a signal, so the harness's progress is not event-driven.

### src/gui/testing/batchtest.h
- Purpose: Header for `BatchTest`.
- Key abstractions: an entirely static class.
- Data flow: n/a.
- Non-obvious design decisions: `isRunning()` is a global flag that the components check.
- Edge cases / failure handling: n/a.
- Surprising: `doBatchTest(QString folder)` is the public entry point and is called from elsewhere in the app (not in this shard).

### src/gui/thememanager.cpp
- Purpose: The light/dark theme.
- Key abstractions: two palettes and two colour vectors of four `uint32_t` values (canvas background, canvas foreground, component background, component foreground).
- Data flow: `setTheme()` (line 77) swaps the application palette and *rewrites the colour vector in place*; every component that holds a `uint32_t*` into that vector (the canvas background, the pin colours, the connector colours) therefore recolours itself with no notification.
- Non-obvious design decisions: **colour-by-pointer** is the theme mechanism. `Circuit::m_background`/`m_foreground` and `Pin::m_foreColor`/`ConnectorLine::m_foreColor` are `uint32_t*` into `ThemeManager`'s vector, so a theme switch is one vector rewrite rather than a walk over every item. `setTheme` then explicitly refreshes the three icon sets (component list, circuit, editor, main window).
- Edge cases / failure handling: `getColorPtr(index)` clamps out-of-range indices to 0.
- Surprising: `invertPixmap()` (line 108) inverts *only* fully grayscale icons — if any pixel is not gray, the whole image is left alone, so coloured icons stay coloured in the dark theme.

### src/gui/thememanager.h
- Purpose: Header for `ThemeManager`.
- Key abstractions: `enum class Theme { Light, Dark }`; `static ThemeManager* self()`.
- Data flow: n/a.
- Non-obvious design decisions: `m_currentTheme` and `m_isDark` are stored separately even though one derives from the other.
- Edge cases / failure handling: n/a.
- Surprising: the palette is a single shared `QPalette` object mutated in place.

### src/gui/updobutton.cpp
- Purpose: A 6x6 painted stepper arrow used by the memory-table controls.
- Key abstractions: a precomputed `QPainterPath` triangle and a colour that encodes direction.
- Data flow: n/a.
- Non-obvious design decisions: up is red (255,50,20), down is blue (50,50,240) — matching the pin colour language.
- Edge cases / failure handling: n/a.
- Surprising: `setStyleSheet("border: 0px; background: transparent;")` removes the native frame so the painted one is the only one.

### src/gui/updobutton.h
- Purpose: Header for `UpDoButton`.
- Key abstractions: `m_path` and `m_color`.
- Data flow: n/a.
- Non-obvious design decisions: none.
- Edge cases / failure handling: n/a.
- Surprising: none.

## Ideas worth stealing

- **Undo/redo as a diff over a text serialisation, not over a model** — `src/gui/circuitwidget/circuit.cpp:733` (`beginUndoStep` snapshots every item's `toString()`), `src/gui/circuitwidget/circuit.cpp:754` (`calcCircuitChanges` diffs the *lists* and records creations/removals as a special property `COMP_STATE_NEW` whose value is the whole serialised item), `src/gui/circuitwidget/circuit.cpp:789` (`restoreState` re-creates a removed item by feeding its text back through the loader). *Why it transfers:* a property-level undo record (`component, property, undoValue, redoValue`) plus a whole-item text record covers both "changed a number" and "deleted a wire" with one stack, and it survives re-implementation of the component classes. For August: an agent that edits a project can produce the same diff without owning a live object graph.

- **One text format serves the file, the clipboard, paste, and undo** — `src/gui/circuitwidget/circuit.cpp:196` (`loadStrDoc` is the single parser for files, clipboard paste and undo), `src/gui/circuitwidget/circuit.cpp:857` (`copy` puts the *same* text on the clipboard), `src/gui/circuitwidget/circuit.cpp:445` (`circuitHeader` writes the `<circuit version= rev= stepSize= ...>` header). *Why it transfers:* it means an LLM can emit a valid circuit file by emitting text — no editor, no GUI, no binary format. That is the single most important thing in this shard for "circuit simulation as an August skill": **the circuit is a line-oriented, self-describing text file**.

- **The property system is simultaneously the editor, the file codec and the scripting surface** — `src/gui/properties/boolprop.h:10` (a property is a template over the component type holding a getter/setter member-pointer pair), `src/gui/properties/propdialog.cpp:105` (the dialog instantiates a widget by the property's *type string*), `src/gui/circuitwidget/compbase.cpp:117` (`toString` serialises the property groups), `src/gui/circuitwidget/compbase.cpp:100` (`setPropStr` applies a property by name). *Why it transfers:* adding a knob to a component requires *zero* GUI code — one `new BoolProp<X>(...)` line at the component's constructor. An agent generating component definitions gets the editor for free.

- **Golden-trace regression testing with the expected waveform stored in the circuit** — `src/gui/dataplotwidget/datachannel.cpp:52` (`doTest` compares the live sample buffer against a stored reference with a 0.1% relative tolerance and *exact* timestamps), `src/gui/dataplotwidget/datachannel.cpp:85` (`testData` serialises the reference as hex-time/value pairs), `src/gui/testing/batchtest.cpp:19` (the harness walks a folder of circuits, runs each, and collects failures), `src/gui/dataplotwidget/plotbase.cpp:145` (`runEvent` fires the comparison at a scheduled simulation time). *Why it transfers:* this is a complete, working test strategy for a circuit simulator that has no other tests: *the circuit is the test case, the expected waveform is a property of the circuit, and a folder of circuits is the suite*. For August: an agent could author a circuit, run it headlessly, and check the captured waveform against a stored expectation with no human in the loop.

- **A measurement instrument whose user-facing condition string compiles into the embedded script engine** — `src/gui/dataplotwidget/plotbase.cpp:250` (`updateConds` expands `ch1l` -> `(pb.ch1==1)`, wraps it as `void pause() { pb.m_pause = <expr>; }`, compiles it, and caches the function), `src/gui/dataplotwidget/plotbase.cpp:276` (`conditonMet` calls the function and *pauses the simulation* when it is true), `src/gui/dataplotwidget/plotbase.cpp:49` (the per-channel condition variables are registered as AngelScript object properties `ch1`..`ch8`). *Why it transfers:* a 4-character syntax that maps to a real expression language is a superb teaching surface for logic simulation: "stop the simulator when channel 1 goes high" is exactly the kind of rule a student writes. For August: the same pattern gives an agent a natural place to inject "assert this signal" rules into a simulation.

- **Numeric property fields that evaluate arithmetic expressions** — `src/gui/properties/dspinbox.cpp:30` (`valueFromText` pads trailing operators and runs `"return <expr>"` through the AngelScript engine), `src/gui/properties/dspinbox.cpp:25` (`validate` rejects anything that evaluates to NaN), `src/gui/properties/dspinbox.cpp:42` (`evaluate` uses `ExecuteString` and returns NAN on failure). *Why it transfers:* a student can type `4.7k*2` instead of `9.4k`, and a wrong expression is rejected rather than silently coerced to zero. The engine already exists in the product, so the cost is one class.

- **The component registry is a flat list of entries carrying a factory pointer, and the palette is data-driven** — `src/gui/componentlist/itemlibrary.cpp:149` (`loadItems` adds ~130 `LibraryItem`s in category order), `src/gui/componentlist/itemlibrary.cpp:345` (`createItem` dispatches a type string to the matching factory), `src/gui/componentlist/componentlist.cpp:200` (`loadXml` parses `<itemlib>/<itemset>/<item>` component sets from disk so components can be added without recompiling). *Why it transfers:* this is the whole "plugin model" of SimulIDE and it is remarkably simple — a list of `(name, category, icon, types, factory)`. New components come in two flavours: a compiled one (one `addItem` line) or a data one (an XML file in the user's data folder).

- **A mixin whose destructor unregisters it from the engine's per-step callback list** — `src/gui/circuitwidget/updatable.h:8` (the whole class is a virtual `updateStep()`), `src/gui/circuitwidget/updatable.cpp:12` (`~Updatable` calls `Simulator::self()->remFromUpdateList(this)`). *Why it transfers:* every GUI object that needs a per-simulation-step refresh (connectors, pins, the console, the memory table, the debugger, the serial monitor) derives from it, and cannot outlive its registration. A harness with a similar "tick" contract gets the same safety for free.

- **Colour-by-pointer theme switching** — `src/gui/thememanager.cpp:96` (`getColorPtr` returns a pointer into a `std::vector<uint32_t>` that is rewritten in place on a theme change), `src/gui/circuitwidget/circuit.cpp:50` (the scene stores `m_background`/`m_foreground` as those pointers), `src/gui/circuitwidget/connectorline.cpp:27` (each wire line stores `m_foreColor` as a pointer). *Why it transfers:* a theme switch is one vector rewrite instead of a walk over every drawn object — the trick generalises to any hot-reloadable appearance (a "selected colour", a "net class colour").

- **Sub-sample a dense trace into a min/max envelope instead of drawing every point** — `src/gui/dataplotwidget/plotdisplay.cpp:310` (points within 0.5 px of each other on screen are collapsed and only their extremes are drawn), `src/gui/dataplotwidget/plotdisplay.cpp:241` (the buffer is walked backwards from the trigger index and the walk stops as soon as it passes the visible start). *Why it transfers:* this is the standard technique for waveform rendering and it is worth having in any simulator: draw the envelope, not the samples.

- **Throttle UI refreshes that are called once per simulation step** — `src/gui/memory/memtable.cpp:42` (`updateTable` refreshes only every tenth call), `src/gui/memory/mcumonitor.cpp:136` (only the *visible* tabs are refreshed), `src/gui/outpaneltext.cpp:39` (`appendLine` flushes immediately when the simulation is idle and otherwise waits for the next step). *Why it transfers:* the pattern "buffer the text, flush once per tick, and only paint what is visible" is the difference between a simulator that keeps up with real time and one that does not.

- **A "file changed on disk" bar with four distinct resolutions** — `src/gui/editorwidget/docpage.cpp:62` (`showModifiedBar` warns and offers Reload / Keep Current / Close Tab / Keep Open), `src/gui/editorwidget/docpage.cpp:75` (`showDeletedBar` for a file that no longer exists), `src/gui/editorwidget/editorwidget.cpp:375` (`fileChangedOnDisk` re-arms the `QFileSystemWatcher` after the event, because Qt drops the watch on replace). *Why it transfers:* the four-way choice (discard mine / keep mine / abandon / keep as unsaved) is the right answer to "the file changed under you", and the re-arming detail is a real Qt trap that the code already solves.

- **The external toolchain is described as data with token substitution** — `src/gui/editorwidget/compiler.cpp:82` (`loadCompiler` parses an XML `<compiler>` with `<step command= arguments= argsDebug=>` children), `src/gui/editorwidget/compiler.cpp:66` (`replaceData` substitutes `$filePath`, `$device`, `$family`, `$inclPath`, ...), `src/gui/editorwidget/compiler.cpp:131` (the dialog grows a property field only if the argument string mentions `$device`/`$family`/`$extraArgs`/`$inclPath`). *Why it transfers:* the "code" half of an embedded-code tool is a text template plus a token substitution table; the *settings UI is derived from the template*. For August: an agent can write or adapt a toolchain definition without touching the host.

- **Two text dialects and one tolerant tokeniser** — `src/gui/properties/proputils.cpp:24` (`parseXmlProps` splits a quoted `<item a="1" b="2"/>` line into pairs), `src/gui/properties/proputils.cpp:59` (`parseProp` handles the older `name=value;name=value` form), `src/gui/properties/proputils.cpp:35` (the *rule* is "quoted values always come in pairs, and the name is the text after the last space before the quote"). *Why it transfers:* you can read a legacy format and a current format with two small functions and no XML library, and you can add a third dialect cheaply. The key is that the *writer* is the specification.

- **Auto-connect by dragging with a modifier key** — `src/gui/circuitwidget/pin.cpp:191` (`isMoved` — when a component is moved and Shift is held, it looks for a colliding pin within 3 px and wires it automatically), `src/gui/circuitwidget/pin.cpp:153` (`connectPin` refuses to connect a bus to a non-bus and refuses an already-connected or unused pin). *Why it transfers:* shift-to-snap is a two-line interaction that removes the single most tedious step of building a circuit by hand, and the guard conditions (bus-ness, already connected, unused) are the correctness rules a course exercise would need anyway.

- **The pin's eight-state visual language** — `src/gui/circuitwidget/pin.h:12` (`pinState_t { undef_state, driven_low, open_low, open_high, out_low, out_high, input_low, input_high }`), `src/gui/circuitwidget/pin.cpp:51` (the colour table), `src/gui/circuitwidget/pin.cpp:444` (the arrow drawing uses *numeric comparisons against the enum* to decide whether to draw an input arrow or a half output arrow). *Why it transfers:* a student debugging a logic circuit needs to see the difference between "driven low", "floating", "driving high" and "input high" at a glance. Encoding the semantics in an ordered enum and deriving the drawing from the order is a compact way to keep the visual and the semantics in sync.

- **A drag-and-drop protocol that is one comma-separated string** — `src/gui/componentlist/componentlist.cpp:479` (the palette's MIME payload is `name,type`), `src/gui/circuitwidget/circuitview.cpp:96` (`dragEnterEvent` parses it and creates the component immediately), `src/gui/circuitwidget/circuitview.cpp:137` (`dragLeaveEvent` removes it and pops the undo entry so an abandoned drag leaves no history). *Why it transfers:* the palette-to-canvas contract is inspectable text, and the abort path cleans up its own undo entry — a detail that is easy to get wrong and that this code gets right.

## Files skipped (with reasons)

- `src/gui/componentlist/qzipreader.cpp` — **vendored** copy of Qt's private `qZipReader` (Nokia copyright, LGPL v2.1, 580 lines) used only to extract downloaded component-set zips. I read the first 120 lines (the licence header, the includes, the `S_ISREG`/`S_ISDIR` Windows macro block, and the little-endian read/write helpers) to confirm it is upstream Qt and contains no SimulIDE logic; I did not read it line by line because there is nothing project-specific in it.

No other file in this shard was skipped. In particular, no file was too large to read: the largest are `src/gui/editorwidget/codeeditor.cpp` (1102 lines) and `src/gui/circuitwidget/circuit.cpp` (1305 lines), both read in full.

## Uncertainties

- **How much of each `.ui` file I read.** I read the following `.ui` files *completely, line by line*: `currentwidget.ui`, `installer.ui`, `managecomps.ui`, `installinfo.ui`, `installitem.ui`. For every other `.ui` file in the shard I extracted the widget inventory by grepping `<widget class=`, `<class>` and `<string>` and read the resulting structure, rather than reading every one of the 40-1700 lines of Qt Designer XML. The affected files are `about.ui` (707 lines), `appdialog.ui` (1735), `infowidget.ui` (816), `datalawidget.ui` (439), `datawidget.ui` (391), `lawidget.ui` (917), `oscwidget.ui` (1497), `findreplace.ui` (286), `headerwidget.ui` (200), `mcumonitor.ui` (103), `memtable.ui` (153), `ramtable.ui` (199), `vallabelwidget.ui` (371), `valuewidget.ui` (342), `watcher.ui` (102), `boolval.ui` (67), `colorval.ui` (71), `enumval.ui` (96), `labelval.ui` (88), `numval.ui` (213), `pathval.ui` (87), `propdialog.ui` (237), `strval.ui` (59), `textval.ui` (59), `serialmon.ui` (346), `terminal.ui` (457). I am confident about *which widgets exist and how they are wired* in each of these; I am **not** certain about their exact geometry, size hints, style-sheet strings and font settings, which I did not inspect line by line. For a `Qt Designer` form this is the information a reader normally needs, but if an exact pixel layout matters, those files need a second pass.
- **The `.ui` files also promote custom widgets** (`PlotDisplay`, `PlotSpinBox`, `CustomButton`) with their own `<class>`/`<customwidgets>` blocks. I confirmed the promotion exists via the grep; I did not verify every `<header>` path in those blocks.
- **`Compiler::compile()` and the toolchains.** I read `compiler.cpp`, `basedebugger.cpp` and all eight debugger subclasses, but I did **not** run any of them, and I could not verify the `resources/data/codeeditor/compilers/compilers/*.xml` definitions (they belong to the `resources#1` shard) against the code — so the exact `$token` set each toolchain uses is inferred from `Compiler::replaceData` and the `.cpp` files, not from the XML.
- **The engine contract.** Everything I say about `Simulator::addEvent`, `addToUpdateList`, `cancelEvents`, `startSim`, `eNode`, `ePin`, `eElement`, `AnalogClock` and `Mcu` is read *from the GUI side only* — those classes live in `src/simulator`, `src/microsim` and `src/components`, which are other shards. I did not open them, so I have not verified the engine's actual semantics for those calls (e.g. whether `addEvent` is a priority queue, how `cancelEvents` matches, or how `AnalClock`'s divider relates to the reactive step).
- **`Widget`-level behaviour I could not confirm.** `QFileSystemWatcher`'s re-arming, `QDir::setCurrent` in `CodeEditor::setFile`, the `m_changed = false` after `return` in `JoystickWidget::getPos`, the double `m_blocked` member in `ColorVal`, and the two `loadVarSet` overloads in `RamTable` are all defects I can *see* in the source, but I did not run the application, so I cannot say whether they are reachable in practice.
- **Language of the codebase.** All the code in this shard is English; the only non-English strings are the `tr()` translations, which live in the `resources#2` shard. I did not check the translation files, so I cannot say whether every new string is actually translated.
- **Whether `BatchTest` is reachable from the UI.** `doBatchTest(QString folder)` is public and static, and `ComponentList::loadTest` populates a "test" category in the palette from a user's `test/` folder — but the caller of `doBatchTest` is not in this shard (it is presumably in `mainwindow.cpp`, which is in the `build-root` shard). I therefore could not confirm how a user actually *starts* a batch run.
- **The build is outside the shard, so I cannot prove the shard compiles.** `SimulIDE.pri` and `build_XX/SimulIDE_Build.pro` are in the `build-root` shard. What I could check from here is only that the 31 `.ui` forms and the 31 `#include "ui_<name>.h"` directives correspond exactly — which is evidence that `uic` is wired with the expected names, but not that every `.cpp` in `src/gui/` is listed in the `.pri`, nor that the forms are compiled in the right order. I did not build anything.
- **The engine's time unit is inferred, not read.** I state that `Simulator::addEvent` takes picoseconds, and that `m_testTime*1e12` converts the nanosecond "Test Time" property to picoseconds. Both rest on GUI-side evidence (`m_timeRis = 3750; // picoseconds` and the `"ns"` unit on the `TestTime` property at `src/gui/dataplotwidget/plotbase.cpp:91`); the engine's own definition of its time base lives in `src/simulator`, which I did not open.
- **The `notr="true"` observation is a count, not an audit.** I counted the attribute across all 31 forms (28 forms contain it). I did not check every individual string in those forms to confirm that the *intended* visible strings are all marked, so a form could still carry an unmarked placeholder that the translator catalogue expects to cover.
- **Performance claims are structural, not measured.** Every "this is fast" statement in this report is read off the code — the throttles, the `isVisible()` guards, the envelope rendering — not from a profile. I did not run the application, so I cannot say whether the remaining per-step work (for example `MCUMonitor` writing a whole RAM table cell by cell on every step, `src/gui/memory/mcumonitor.cpp:147`) is fast enough in practice.

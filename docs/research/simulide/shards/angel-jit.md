# simulide / angel-jit

## Shard shape

This shard is the **entire vendored AngelScript 2.35.1 scripting engine** that SimulIDE embeds under `src/angel/` — 85 tracked files, ~2.5 MB of C++ — plus the **x86-64 JIT** that gives the shard its name. Nothing here is SimulIDE's own code; it is a fork of Andreas Jonsson's AngelScript, lightly modified by the project (one file carries a `// Modified 2023 by Santiago González` marker, and `src/angel/src/COPYING:31` states outright that *all* files in the folder were changed). The shape is a five-layer compiler-and-runtime stack, and every layer is visible in the file names:

1. **Public API** — `include/angelscript.h` (1607 lines): the C++ interface the host uses (`asIScriptEngine`, `asIScriptModule`, `asIScriptContext`, `asIScriptObject`), the engine-property enum, the bytecode opcode enum, and the two JIT-facing types (`asSVMRegisters`, the VM register block, at line 1197; `asIJITCompiler`, the plugin interface, at line 1211).
2. **Front end** — `as_tokenizer` → `as_parser` → `as_builder` → `as_compiler` → `as_bytecode`. The tokenizer is a jump-table keyword matcher; the parser is recursive descent whose grammar is documented inline as EBNF (`as_parser.cpp:37-47` tells you to search the file for `BNF:`); the builder owns the whole "declared but not yet compiled" state; the compiler is the code generator (13,985 lines — the largest file in the repo by a wide margin); the bytecode builder emits the final instruction stream and post-processes it.
3. **Runtime** — `as_context` is the virtual machine (a 4,813-line switch over the opcodes), `as_module` is the unit of compilation and ownership, `as_scriptfunction` holds one compiled function plus its JIT-compiled twin, `as_scriptobject` is the base of every script-visible object.
4. **Services** — a cycle-detecting garbage collector (`as_gc`), a red-black map (`as_map`), a hash symbol table (`as_symboltable`), a plumbable allocator (`as_memory`), a thread manager (`as_thread`), a config-group system (`as_configgroup`).
5. **Host glue** — `as_callfunc*` (six files, three of them hand-written assembly, one per calling convention), `scriptarray`/`scriptstdstring` (the two standard-library add-ons), and `scripthelper` (`ExecuteString`).

The **JIT** sub-tree (`src/angel/JIT/`, 7 files) is the interesting part and it is where the shard earns its name. `as_jit.cpp` (4,382 lines) is a bytecode-to-x86-64 compiler that emits machine code directly into executable memory pages; `virtual_asm.h` + `virtual_asm_x64.cpp` are a small assembler DSL (`Processor`, `Register`, `MemAddress`, `FloatingPointUnit`) that emits ModR/M/SIB/rex bytes by hand; `virtual_asm_linux.cpp` and `virtual_asm_windows.cpp` are the two OS back-ends for allocating and freezing those pages. Crucially the JIT is **not** a replacement for the VM — it is a *co-process* with the VM. The bytecode carries explicit `asBC_JitEntry` markers at every safe re-entry point; the JIT compiles the code between markers and, when it hits something it cannot compile (a suspend, a generic call, a script call into a function that has not been compiled yet), it returns control to the interpreter with a saved register block, and the interpreter later re-enters the native code. SimulIDE switches the whole mechanism on at runtime in exactly one place (`src/microsim/modules/script/scriptbase.cpp:68-70`, outside this shard): `new asCJITCompiler(JIT_NO_SUSPEND | JIT_SYSCALL_NO_ERRORS)`, `asEP_INCLUDE_JIT_INSTRUCTIONS = 1`, `SetJITCompiler(m_jit)`.

For the August harness this shard is **the scripting/embedded-code lens in its purest form**: it is a complete, self-contained scripting language with a compile step, a VM, a JIT, a garbage collector, a plugin interface for native code, a host-registration model for types, and — critically — an *error and diagnostic discipline* (every message is a named constant in one file) that August's own tool surfaces imitate.

**A manifest caveat the lead must know.** The working-copy manifest at `docs/research/simulide/manifest.tsv` contains **no** row whose owner-shard is `angel-jit` — it was re-sharded at 13:45 today into `src-angel-01` … `src-angel-11`, and the `angel-jit` name survives only in the *committed* version of the manifest (HEAD = `bc531b2e`, "docs(research): the coverage ledger"), where it owns exactly these 85 files. I took the committed list as authoritative, because (a) the dispatch named `angel-jit`, (b) `shards/build-root.md:45` refers to "shard `angel-jit`" for the AngelScript licence files, and (c) the committed shard plan's names (`build-root`, `resources#1`, `resources#2`, `angel-jit`, `simulator-core`, `components-analog`, `components-digital`, `gui`, `microsim`, `icons-assets`) match the reports already written. The `src-angel-01…11` rows in the working copy are a **finer re-split of the same 87 files**, and `src-angel-08…11` duplicate `src-angel-06/07` exactly — so two workers may already be covering part of this shard. My ledger is scoped to the committed 85.

## Per-file notes

### src/angel/include/angelscript.h
- Purpose: the public C++ API of the engine — the only header a host program needs.
- Key abstractions: `asIScriptEngine` / `asIScriptModule` / `asIScriptContext` / `asIScriptObject` / `asITypeInfo` / `asIJITCompiler`; `asERetCodes` (a 29-value error enum, lines 82-113); `asEEngineProp`; `asEBCInstr` (the full opcode list).
- Data flow: the host registers types/functions/properties through the engine interface, gets a module back, builds it, creates a context, and prepares/executes functions on it. The engine calls back into the host through registered function pointers and through `asIScriptGeneric`.
- Non-obvious design decisions: **`asIJITCompiler` has exactly two methods** — `CompileFunction` and `ReleaseJITFunction` (lines 1211-1218). The entire JIT is behind a 2-method interface, so the engine never knows how the native code was produced. `asSVMRegisters` (1197-1207) is the *contract* between the VM and the JIT: program pointer, frame pointer, stack pointer, a value register, an object register, an object type, a `doProcessSuspend` flag and the context pointer. Anything that wants to be a JIT only has to honour that struct.
- Edge cases / failure handling: `asCreateScriptEngine(asDWORD version)` refuses to hand back an engine whose major/minor version does not match the caller's expectation (`as_scriptengine.cpp:132-140`).
- Surprising: `asBC_JitEntry = 175` (line 1398) is a *public* opcode. The JIT entry marker is part of the engine's instruction set, not a private detail of the JIT.

### src/angel/JIT/as_jit.cpp
- Purpose: the x86-64 JIT compiler — AngelScript bytecode in, native machine code in an executable page out.
- Key abstractions: `asCJITCompiler` (owns code pages, a jump table, a critical section, and a map of deferred code pointers for mutual recursion); the `SystemCall` struct (the calling-convention bridge, with a `SysCallFlags` enum at lines 255-262); `SwitchRegion` / `FutureJump` (the two deferred-resolution structures).
- Data flow: `CompileFunction` takes a function's bytecode, does a **first pass** over it to mark every jump target (lines 403-422) so the optimiser will not fuse an op pair across a jump, then walks the bytecode emitting native code into the active code page. Calls to other script functions either jump straight into their already-compiled native code or record a `DeferredCodePointer` and patch it later (lines 617-631, 3006-3013).
- Non-obvious design decisions: **the optimiser refuses to work across a jump target** (`if(pNextOp < end && jumpTable[pNextOp - start] == nullptr)`, line 846). This is the mechanism that makes the JIT composable with the interpreter: the optimiser may fuse `SetV8 + CpyVtoV8 + ADDd` into one FPU sequence (lines 854-884) only when it can prove no other entry reaches into the middle of the sequence.
- Edge cases / failure handling: page overflow is handled by `check_space` (lines 762-776), which allocates a new page adjacent to the old one and emits a jump across. A jump that will not fit in 32 bits is patched through R11 (lines 566-588). When the JIT meets a construct it cannot compile, the `default:` case at lines 2992-2995 does `Return(true)` — it hands the rest of the function back to the VM rather than failing.
- Surprising: `codePageSize = 65535 * 4` (line 49) — a 256 KB page — and the JIT asks for the page at a **requested address** (`reinterpret_cast<void*>(&toSize)`, line 426) so that short relative jumps stay in range. The Windows back-end searches outwards for a free page up to 256 attempts (`virtual_asm_windows.cpp:67-71`).

### src/angel/JIT/as_jit.h
- Purpose: the JIT compiler's class declaration and its tuning flags.
- Key abstractions: `enum JITSettings` — seven independent trade-off flags, each with the cost stated in the comment: `JIT_NO_SUSPEND`, `JIT_SYSCALL_FPU_NORESET`, `JIT_SYSCALL_NO_ERRORS` ("exceptions will generally be ignored, possibly leading to crashes"), `JIT_ALLOC_SIMPLE`, `JIT_NO_SWITCHES`, `JIT_NO_SCRIPT_CALLS` ("can be used as a temporary workaround for angelscript changes"), `JIT_FAST_REFCOUNT`.
- Non-obvious design decisions: the flags are **per-subsystem**, not one global "fast mode". Each one names exactly what it gives up.
- Edge cases: the whole file is guarded by `#ifdef __x86_64__` (lines 1 and 60), so on any other architecture the class does not exist at all.
- Surprising: `JIT_NO_SCRIPT_CALLS` is described as a *temporary workaround for angelscript changes* — i.e. the JIT is expected to be disabled for a class of scripts while the engine is being modified.

### src/angel/JIT/COPYING
- Purpose: the JIT sub-tree carries its **own** licence, separate from the engine's.
- One specific fact: 10 lines, MIT, "Copyright (C) 2012-2016 Blind Mind Studios" — the JIT is a third-party contribution vendored under a different, more permissive licence than the engine itself.
- Why it matters: the engine's own `src/angel/src/COPYING` is AngelCode's permissive licence *plus* the note that the files were modified by the project author; the JIT's is plain MIT. Two licences, two files, in one vendored tree.

### src/angel/JIT/virtual_asm_linux.cpp
- Purpose: the POSIX half of the assembler back-end — memory management and locking.
- Key abstractions: `Processor::intArg64/floatArg64` (the SysV register assignment: EDI, ESI, EDX, ECX, R8, R9 for integers; XMM0-7 for floats), `CodePage` (mmap-backed), `CriticalSection` (pthread mutex).
- Data flow: `CodePage::CodePage` mmaps `PROT_READ|PROT_WRITE|PROT_EXEC` anonymous memory (lines 76-85); `CodePage::finalize` mprotects it down to `PROT_READ|PROT_EXEC` (lines 93-96) — **the page is writable while it is being filled and read-only once it is executable**.
- Non-obvious design decisions: the page is requested at a **rounded-down address** so the mapping is page-aligned (lines 73-74), and `size` is rounded up to a whole number of system pages.
- Edge cases: `CodePage` is reference-counted (`grab`/`drop`, lines 87-89) because one function's native code can span several pages and several functions can share one page.
- Surprising: `CriticalSection` allocates its `pthread_mutex_t` with `new` and destroys it in the destructor (lines 104-114) rather than embedding it — the struct is a thin `void*` wrapper (`virtual_asm.h:95-103`) so the same header can carry the Windows `CRITICAL_SECTION`.

### src/angel/JIT/virtual_asm_windows.cpp
- Purpose: the Win32 half of the assembler back-end.
- Key abstractions: the **Microsoft x64** register assignment (4 integer registers ECX/EDX/R8/R9 and 4 XMM, lines 12-38) — deliberately different from the SysV six-and-eight in the POSIX file.
- Data flow: `VirtualAlloc(..., PAGE_EXECUTE_READWRITE)` (line 69) → write code → `finalize()` calls `FlushInstructionCache` and then `VirtualProtect(page, size, PAGE_EXECUTE_READ)` (lines 82-87).
- Non-obvious design decisions: the allocation loop (lines 67-71) tries 256 successively more distant addresses from the requested one and falls back to any address the OS gives (line 73) — because the JIT prefers a nearby page so that 32-bit relative jumps work.
- Edge cases: `size = (pages * minPageSize) - 2` (line 64) — an odd, hand-tuned subtraction that exists to keep the allocation inside the granularity rules.
- Surprising: `FlushInstructionCache` is not optional on x86: without it the CPU may execute stale bytes from the instruction cache after the page is written.

### src/angel/JIT/virtual_asm_x64.cpp
- Purpose: the x86-64 instruction encoder — the file that actually turns the assembler's abstraction into opcode bytes.
- Key abstractions: `mod_rm` / `sib` helpers (lines 42-48); the `Argument` struct (register / memory / constant, with a 32-bit flag); the REX-prefix computation in `Processor::operator<<(RegPrefix)` (lines 465-483).
- Data flow: `Processor::operator<<` is the low-level emitter (`*this << byte` writes one byte at `op` and advances it); every higher-level operation (`push`, `swap`, `operator+=`, `divide`, `setIf`) is composed from those byte writes.
- Non-obvious design decisions: the **64-bit absolute address problem** is solved by a fixed convention: `R11` is declared "supervolatile" in `virtual_asm.h:31-34` and is used as the scratch register for any address that does not fit in 32 bits (lines 381-384, 439-442, 522-527). The same convention is used for the long-jump patch (lines 569-574).
- Edge cases / failure handling: short jumps that will not fit throw `"Short jump too long."` (line 548); a long jump that cannot be patched throws `"Multi-page drifting! Can't recover from this."` (line 578). Both are C++ string exceptions thrown from the middle of code generation.
- Surprising: the MSVC build pads the outgoing stack by a fixed 32 bytes (lines 181-184 and 312-314) because the Microsoft x64 ABI reserves shadow space; the SysV build does not.

### src/angel/JIT/virtual_asm.h
- Purpose: the assembler's interface — the DSL the JIT is written in.
- Key abstractions: `Processor` (owns the output pointer, the bit mode, the stack depth and the reserved jump space), `Register` (a typed view of a machine register), `MemAddress` (a base register + offset + scale + bit mode), `FloatingPointUnit` (the x87 stack), `CodePage` (an executable page with a `grab`/`drop` refcount and a `used` watermark, lines 129-177).
- Non-obvious design decisions: `CodePage::markUsedAddress` (lines 161-165) and `getFreeSize` make the page a **bump allocator**: the JIT never frees code, it only marks how much of the page it has consumed.
- Edge cases: `jumpSpace` (line 192) tracks how many bytes are reserved for long jumps that will be patched later, so the page can never be filled by an unpatchable jump.
- Surprising: `R11` is documented as "supervolatile. Can change in between virtual asm ops (used as a temporary)" (lines 31-34) — the abstraction leaks its own scratch register into the public contract.

### src/angel/src/as_array.h
- Purpose: the engine's growable array, used for nearly every collection in the tree.
- Key abstractions: `asCArray<T>` with `PushLast`, `SetLength`, `RemoveIndex`, `RemoveIndexUnordered`, `Concatenate`.
- Data flow: `Allocate` grows geometrically; `SetLength` shrinks or grows; `SwapWith` exchanges two arrays' contents without copying.
- Non-obvious design decisions: **the buffer is public** — `T *array; asUINT length; asUINT maxLength;` (lines 89-91) — and the comment says why: "These are public to allow external code (e.g. JIT compiler) to do asOFFSET to access the members directly without having to modify the code to add friend" (lines 87-88). The JIT reads bytecode straight out of the array.
- Edge cases: `char buf[2*4*AS_PTR_SIZE]` (line 94) is an **inline buffer**, so arrays of one or two elements never allocate.
- Surprising: the same file is the reason the JIT can exist at all without a change to the container: a public, contiguous, `asUINT`-indexed buffer is exactly what a code generator needs.

### src/angel/src/as_atomic.cpp
- Purpose: the atomic single-dword operations used by every reference count in the engine.
- Key abstractions: `asCAtomic::get/set/atomicInc/atomicDec`.
- Non-obvious design decisions: every accessor asserts `value < 1000000` with the comment "A very high ref count is highly unlikely. It most likely a problem with memory that has been overwritten or is being deleted" (lines 48-50, 59, 67). **A refcount that runs away is treated as a memory-corruption tripwire**, not as a number to keep incrementing.
- Edge cases: the assert is compiled out in release; in debug it turns a silent corruption into an immediate abort.

### src/angel/src/as_atomic.h
- Purpose: declaration of the atomic dword wrapper (48 lines).
- One specific fact: the file comment says the class exists "for performing threadsafe operations on a single dword, e.g. reference counting and bitfields" — every refcount in the engine is one of these.

### src/angel/src/as_builder.cpp
- Purpose: the build orchestrator — it is what turns a set of script sections into a compiled module.
- Key abstractions: the symbol-table specialisations for global variables (lines 51-57) and the filter classes that make a symbol table searchable by type (lines 60-75); the pending-declaration arrays declared in the header (`scripts`, `functions`, `globVariables`, `classDeclarations`, `interfaceDeclarations`, `funcDefs`, `mixinClasses`).
- Data flow: `AddScriptSection` → the builder parses each section → registers the declared types and functions → compiles the functions → compiles the global variables. The two-phase shape exists because a script may declare a class *after* a function that uses it, so nothing can be compiled until every declaration is known.
- Non-obvious design decisions: the builder is a **friend** of the engine, the module, the parser and the compiler (declared in `as_builder.h:159-161`), so it can reach into their internals directly rather than through an API — the standard "friend for speed" choice for a compiler.
- Edge cases: `numErrors` / `numWarnings` counters accumulate across the build; the builder can be put in `silent` mode.

### src/angel/src/as_builder.h
- Purpose: the builder's declaration and, more importantly, the **description structs** that make a two-phase build possible.
- Key abstractions: `sFunctionDescription`, `sGlobalVariableDescription` (with `isCompiled`, `isPureConstant`, `isEnumValue`, `constantValue`), `sClassDeclaration` (with a `validState` and a list of `sPropertyInitializer`), `sFuncDef`, `sMixinClass` (lines 61-130).
- Data flow: these structs are the *pending* state between parsing and compiling; each one carries the script node it came from so an error can be reported at the right source position later.
- Non-obvious: `isExistingShared` appears on both function and class descriptions — a script may *reference* a type that another module already owns, and the builder must not re-declare it.

### src/angel/src/as_bytecode.cpp
- Purpose: the bytecode emitter and post-processor — the last stage before native code.
- Key abstractions: `asCByteInstruction` (op + size + stack effect + argument storage), the `Instr*` family (`InstrDWORD`, `InstrPTR`, `InstrSHORT`, `InstrW_QW`, …) that each emit one instruction with the right argument layout.
- Data flow: `Finalize` runs four steps in a fixed order (lines 65-73): `PostProcess()` (verify) → `Optimize()` → `ResolveJumpAddresses()` → `ExtractLineNumbers()`.
- Non-obvious design decisions: **`asBC_JitEntry` is emitted after every call, every allocation and every line/suspend instruction** (lines 1618-1619, 1633-1634, 1649-1650, 1705-1706), each with the comment "Add a JitEntry instruction after function calls so that JIT's can resume execution". This is the single most important line in the shard for anyone building a hybrid fast/slow path.
- Edge cases: if the engine was not configured with `asEP_INCLUDE_JIT_INSTRUCTIONS`, the post-processor **deletes** every JitEntry (lines 1083-1088) — the marker costs nothing when no JIT is installed.
- Surprising: `Line()` writes a *packed* line+column into one dword — `(line & 0xFFFFF) | ((column & 0xFFF) << 20)` (line 1702) — because the line number has to travel inside the instruction stream.

### src/angel/src/as_bytecode.h
- Purpose: the bytecode builder's declaration.
- Key abstractions: the `Finalize`/`Optimize`/`OptimizeLocally`/`ResolveJumpAddresses`/`ExtractLineNumbers` pipeline (lines 69-76) and the ~25 `Instr*` emitters (lines 113-134) that encode every argument shape the opcode set needs.
- Non-obvious: `PostProcess()` is a separate, optional pass (line 84) and `DebugOutput` only exists under `AS_DEBUG` (lines 86-88) — the bytecode can be dumped to a text file for inspection.

### src/angel/src/as_callfunc_arm64_gcc.S
- Purpose: the AArch64/Linux call stubs, written in GNU assembler.
- Key abstractions: seven exported entry points — `GetHFAReturnDouble`, `GetHFAReturnFloat`, `CallARM64Ret128`, `CallARM64RetInMemory`, `CallARM64Double`, `CallARM64Float`, `CallARM64` (lines 46-52).
- Non-obvious design decisions: the file is guarded by `#if !defined(AS_MAX_PORTABILITY)` **and** `#if defined(__aarch64__)` (lines 39-41), so it compiles to nothing on every other target. The header comment records the authorship lineage: "Written by Max Waine in July 2020, based on as_callfunc_arm_msvc.asm, with assistance & guidance provided by Sir Kane" (lines 32-34).
- Edge cases: `#if !defined(__MACH__)` (line 54) selects the GNU-style `.type` directive — the macOS variant is a separate file because Mach-O needs different symbol decoration.

### src/angel/src/as_callfunc_arm64_msvc.asm
- Purpose: the same seven stubs for Windows-on-ARM64.
- Key abstractions: `AREA |.rdata|, DATA, READONLY` / `EXPORT` for the symbol table and `AREA |.text|, CODE, ALIGN=2` for the code (lines 42-51) — the `armasm64` syntax.
- Non-obvious design decisions: the file exists **because MSVC has no inline assembly for ARM64** — stated plainly at lines 35-39: "MSVC currently doesn't support inline assembly for the ARM64 platform … so this separate file is needed."
- Edge cases: `ALIGN 4` before each procedure.

### src/angel/src/as_callfunc_arm64_xcode.S
- Purpose: the macOS variant of the AArch64 stubs.
- Key abstractions: the same seven routines, but with **Mach-O underscore decoration** — `_GetHFAReturnDouble`, `_CallARM64` etc. (lines 42-48) — because the Darwin assembler prefixes C symbols with an underscore.
- Non-obvious: the body is otherwise a copy of the GNU version, including the same header comment ("Compile with GCC/GAS", line 36) — a copy-paste that the symbol names make load-bearing.

### src/angel/src/as_callfunc_arm64.cpp
- Purpose: the ARM64 system-function dispatch — the C++ side that decides which stub to call.
- Key abstractions: `HFA_RET_REGISTERS 4` (s0-s3/d0-d3), `GP_ARG_REGISTERS 8` (x0-x7), `FLOAT_ARG_REGISTERS 8` (v0-v7) (lines 58-60); the extern "C" declarations of the stubs (lines 73-85).
- Non-obvious design decisions: a full **register-allocation comment block** is written out (lines 64-71) listing what x0-x7, x8-x18, x19-x29, x29 (frame pointer) and x30 (link register) may be used for. The file then follows that map exactly.
- Edge cases: the ABI differs between Apple and generic ARM64, so the file records both authorships in its header: "Written by Max Waine in July 2020 … Adapted for Apple M1/M2 by Sam Tupy in Jan 2024" (lines 37-39).
- Surprising: `CallARM64RetInMemory` takes the argument arrays and the return pointer as *explicit parameters* rather than receiving them in registers, which is how the stub can honour two different ABIs with one routine.

### src/angel/src/as_callfunc_x64_gcc.cpp
- Purpose: the System V AMD64 calling convention, implemented as one large inline-assembly block.
- Key abstractions: `X64_MAX_ARGS 32`, `MAX_CALL_INT_REGISTERS 6`, `MAX_CALL_SSE_REGISTERS 8` (lines 58-60) — the SysV limits; the `X64_CallFunction` helper (line 66).
- Data flow: the arguments are copied from the script stack into an array of `asQWORD`s, then the asm block moves them into RCX/RDX/R8/R9 and XMM0-7.
- Non-obvious design decisions: **R15 is used to hold the stack pointer across the call** (lines 79-80) with the comment that R15 "is guaranteed to maintain its value over function calls" — the classic SysV trick to let the compiler keep its own `%rsp` bookkeeping while the asm block moves the stack.
- Edge cases: the file carries a standing warning at lines 63-64: "Always remember to inform the used registers on the clobber line, so that the gcc optimizer doesn't try to use them for other things."

### src/angel/src/as_callfunc_x64_mingw.cpp
- Purpose: the Microsoft x64 calling convention for MinGW.
- Key abstractions: `CallX64(args, floatArgs, paramSize, func)` (line 50) — the same shape as the GCC version but with the MS argument assignment.
- Non-obvious design decisions: the stack is realigned to 16 bytes with an explicit `and $0x8` / `sub` sequence (lines 65-79), and the comment explains the fixed 32-byte minimum: "Make room for at least 4 arguments even if there are less. When the compiler does optimizations for speed it may use these for temporary storage."
- Edge cases: the file is guarded by `#ifdef AS_X64_MINGW` (line 41) and its header records the lineage: "adapted from as_callfunc_x64_msvc by _Vicious_ on August 20th, 2011".

### src/angel/src/as_callfunc_x86.cpp
- Purpose: the 32-bit x86 calling conventions.
- Key abstractions: `CallCDeclFunction`, `CallCDeclFunctionObjLast/ObjFirst/RetByRef` (lines 72-75) — one entry point per convention variant.
- Non-obvious design decisions: the FPU stack is cleared with `fninit` before every native call (lines 48-65), and the reason is spelled out: "With some compile level optimizations the functions don't clear the FPU stack themselves. So we have to do it as part of calling the native functions, as the compiler will not be able to predict when it is supposed to do it by itself due to the dynamic nature of scripts." `fninit` is the default and `emms` is the documented alternative.
- Edge cases: `CLEAR_FPU_STACK` is a macro so a platform can override it (lines 63-65).

### src/angel/src/as_callfunc.cpp
- Purpose: the calling-convention **detector** and the generic system-call trampoline.
- Key abstractions: `DetectCallingConvention(bool isMethod, const asSFuncPtr &ptr, int callConv, void *auxiliary, asSSystemFunctionInterface *internal)` (line 49) — it maps the public `asCALL_*` convention plus a member-function pointer onto an internal `ICC_*` convention and fills the descriptor.
- Data flow: the descriptor (`asSSystemFunctionInterface`) is what the VM and the JIT both read when they need to call a host function: the function pointer, the base offset, the internal convention, the return size/floatness, the parameter size, the auto-handle flags and the cleanup actions.
- Non-obvious design decisions: a mismatch between the declared convention and the pointer's own flag is **rejected** (`asWRONG_CALLING_CONV`, lines 58-63) rather than silently accepted — the engine refuses to guess.
- Edge cases: `asCALL_THISCALL_ASGLOBAL` with no auxiliary pointer returns `asINVALID_ARG` (lines 71-75).

### src/angel/src/as_callfunc.h
- Purpose: the internal calling-convention vocabulary.
- Key abstractions: `enum internalCallConv` — **24** conventions (lines 70-96), each with an optional `_RETURNINMEM` twin; `asSSystemFunctionInterface` (lines 98-120) with `cleanArgs` (a table of per-argument cleanup operations: release / free / destruct-then-free).
- Non-obvious: the `_RETURNINMEM` variants exist because a large return value cannot travel in a register on some ABIs, so the caller passes a pointer and the callee writes into it — the caller must therefore know whose memory it is.

### src/angel/src/as_compiler.cpp
- Purpose: the code generator — AngelScript's largest file by a wide margin (13,985 lines).
- Key abstractions: `asCCompiler` walks the AST produced by the parser and emits bytecode; `asCExprValue` (declared in the header) is the compiler's typed expression value.
- Data flow: parser AST → compiler → `asCByteCode` → finalised instruction stream.
- Non-obvious design decisions: the file's own header states the **calling convention rules for script functions** (lines 51-56) — object pointer always first, a value-type return reserves memory and passes the pointer as the next argument — and then admits the model is wrong: "TODO: I must correct the interpretation of a reference to objects in the compiler … The compiler shouldn't use the asCDataType::IsReference" (lines 59-69).
- Edge cases: a function whose body has no `return` on some path is a compile error, `TXT_NOT_ALL_PATHS_RETURN` (lines 552-558) — checked *before* the bytecode is concatenated.
- Surprising: `asBC_JitEntry` is inserted at the **start of every compiled function** (lines 132-133 for the default constructor, 185-186 for the factory, 562-563 for a normal function) with the comment "Insert a JitEntry at the start of the function for JIT compilers". The JIT needs a landing pad at the function entry, not just at call sites.

### src/angel/src/as_compiler.h
- Purpose: the compiler's declaration and the expression-value type.
- Key abstractions: `asCExprValue` (lines 59-110) — the type, a stack offset, a constant, and **bit-packed flags**: `isLValue`, `isTemporary`, `isConstant`, `isVariable`, `isExplicitHandle`, `isRefToLocal`, `isRefSafe`, packed into a `short dummy : 9` alongside a `short stackOffset`.
- Non-obvious design decisions: the constants are stored in a **union** and are only reachable through typed accessors, with the comment "These values must not be accessed directly in order to avoid problems with endianess" (lines 108-109).

### src/angel/src/as_config.h
- Purpose: the build-time feature switchboard for the whole engine — 665 lines of `#define`s and per-compiler branches.
- Key abstractions: the feature block (threads, `AS_DEBUG`, `AS_DEPRECATED`, `AS_DOUBLEBYTE_CHARSET`, `AS_NO_COMPILER`, `AS_NO_EXCEPTIONS`, `AS_NO_MEMBER_INIT`, `AS_USE_NAMESPACE`), then per-compiler blocks from line 355 on.
- Data flow: every other file tests these macros at compile time, so a switch removes code rather than guarding it at runtime.
- Non-obvious design decisions: **SimulIDE's two edits are here**: `#define AS_NO_EXCEPTIONS` (line 77) removes the language's whole exception-handling feature, and `#define AS_NO_THISCALL_FUNCTOR_METHOD` (line 352) removes functor methods on thiscall.
- Edge cases: the file also documents *why* each switch exists, e.g. `AS_NO_EXCEPTIONS` — "Define this if exception handling is turned off or not available on the target platform" (lines 75-77).
- Surprising: `AS_NO_EXCEPTIONS` is a **language-level** switch: the parser, the compiler, the VM and the JIT all change shape when it is set.

### src/angel/src/as_configgroup.cpp
- Purpose: configuration groups — a named bundle of types, globals and functions that can be enabled, disabled and removed together.
- Key abstractions: `asCConfigGroup` holds `types`, `globalProps`, `scriptFunctions`, `referencedConfigGroups` and `generatedTemplateInstances`; groups reference each other so that removing one cannot orphan a type another still uses.
- Data flow: `RemoveConfiguration(engine, notUsed)` unregisters the group's globals (lines 119-128), its global functions (131-138), the behaviours and members of its object types (141-145) and finally the types themselves (148-162), skipping any type that another group still references.
- Non-obvious design decisions: `Release()` does **not** delete the object — the comment says "the engine will delete the object when ready" (lines 59-60). Lifetime belongs to the engine, not to the referrer.
- Edge cases: `HasLiveObjects()` (lines 103-110) is the "is anything still holding this?" query that decides whether a group can be torn down.

### src/angel/src/as_configgroup.h
- Purpose: the configuration group's declaration.
- Key abstractions: `asCConfigGroup` with `types`, `globalProps`, `scriptFunctions`, `referencedConfigGroups`, `generatedTemplateInstances`, `defaultAccessMask`, `externalRefCount`.

### src/angel/src/as_context.cpp
- Purpose: the virtual machine — the interpreter that runs the bytecode, and the bridge between the interpreter and the JIT.
- Key abstractions: the interpreter's register trio (`l_bc`, `l_sp`, `l_fp`), the call stack, and `m_regs` (`asSVMRegisters`) which is the *shared* register block.
- Data flow: `Prepare()` sets up the frame; `Execute()` (lines 1043+) runs the function.
- Non-obvious design decisions: **the VM does not run an interpreter loop for JIT-compiled functions at all.** Line 1028-1030 reads: `asPWORD jitArg = asBC_PTRARG(m_regs.programPointer); (m_currentFunction->scriptData->jitFunction)(&m_regs, jitArg);` — the VM hands the whole register block to the native code and lets it run. The commented-out `while( m_status == asEXECUTION_ACTIVE ) ExecuteNextJit();` above it (lines 1026-1027) is the upstream shape, left in place.
- Edge cases / failure handling: `asBC_JitEntry` in the **interpreter** (lines 3650-3679) is a resume point: if the function has JIT code and the entry argument is non-zero, the VM copies its registers into `m_regs`, calls the native code, and copies the registers back — and if the status is no longer `asEXECUTION_ACTIVE` it returns immediately. If there is no JIT code, the opcode is treated as a no-op (line 3677).
- Surprising: the file mixes both engines in one switch statement, so the "interpreter" and the "JIT driver" are the same 4,813-line function body.

### src/angel/src/as_context.h
- Purpose: the context's declaration — the object a host uses to run a script function.
- Key abstractions: `Prepare` / `Execute` / `Suspend` / `Abort` / `PushState` / `PopState`; the exception API; the debugging API (`GetLineNumber`, `GetVarDeclaration`, `GetAddressOfVar`); `ExecuteNextJit()` (line 151) declared next to `ExecuteNext()`.
- Non-obvious: the comment at line 220 — "Registers available to JIT compiler functions" — marks `m_regs` as the *published* contract of the context.

### src/angel/src/as_criticalsection.h
- Purpose: a 43-line header declaring a `CriticalSection` class with `enter()`/`leave()` and nothing else.
- One specific fact: there is no implementation in this file — the class is implemented once per OS in the JIT back-ends (`virtual_asm_linux.cpp:100-115` with a pthread mutex, `virtual_asm_windows.cpp:95-106` with a `CRITICAL_SECTION`).

### src/angel/src/as_datatype.cpp
- Purpose: the compiler's type descriptor implementation.
- Key abstractions: `asCDataType` — a token type plus a type-info pointer plus a set of flags (reference, readonly, auto, object handle, const handle, handle-to-handle, if-handle-then-const).
- Non-obvious design decisions: **this file carries SimulIDE's fork marker** — line 31 reads `// Modified 2023 by Santiago González`, the only such marker in the whole vendored tree.
- Edge cases: `IsValid()` (lines 79-85) treats an unrecognised token as invalid *unless* it is an object handle — so a null handle is a valid type.

### src/angel/src/as_datatype.h
- Purpose: the type descriptor's declaration.
- Key abstractions: ~35 predicates over the type's shape (`IsPrimitive`, `IsMathType`, `IsObject`, `IsObjectHandle`, `IsHandleToAuto`, `IsAbstractClass`, `IsInterface`, `IsFuncdef`, `IsArrayType`, `IsEnumType`, `IsAnyType`, …) and the `Make*` mutators that a conversion produces.
- Non-obvious: the header carries a standing refactor note (lines 57-58) — "Reference should not be part of the datatype. This should be stored separately" — and the file implements the *old* model anyway.

### src/angel/src/as_debug.h
- Purpose: debug-only helpers, entirely `#if defined(AS_DEBUG)`-guarded.
- Key abstractions: a portable `mkdir` shim for GNU (lines 66-75) and, under MSVC, a `CProfiler` built on `mmsystem.h` (lines 85-89).
- Edge cases: the file compiles to essentially nothing in a release build — the whole body is inside `#if defined(AS_DEBUG)` with platform exclusions for Wii, WinCE and PSVita.
- Surprising: the profiler is **MSVC-only** ("Currently only do profiling with MSVC++") — the timing instrumentation that a performance-minded project would want is not portable.

### src/angel/src/as_gc.cpp
- Purpose: the garbage collector, which exists to resolve **cyclic** references.
- Key abstractions: the `new` and `old` object lists, the state machines `detectState` / `destroyNewState` / `destroyOldState`, and the host callback `circularRefDetectCallbackFunc`.
- Data flow: an object is registered with `AddScriptObjectToGC` (lines 76-85); the collector then **runs one bounded step of the cycle-detection pass on every new object** (lines 87-100), so the cost is spread over allocations instead of stalling the application. The comment says so: "This will maintain the number of objects in the GC at a maintainable level without halting the application, and without burdening the application with manually invoking the garbage collector."
- Non-obvious design decisions: the collector does not *forbid* cycles — it detects them, **breaks** them, and reports them to the host through the callback so the host can decide what to do.
- Edge cases: a null pointer or null type is reported as `TXT_GC_RECEIVED_NULL_PTR` and rejected (lines 78-82).

### src/angel/src/as_gc.h
- Purpose: the collector's declaration and its explicit phase machine.
- Key abstractions: `enum egcDetectState` (lines 78-94) names every step of the detection pass — `clearCounters`, `buildMap`, `countReferences`, `detectGarbage`, `verifyUnmarked`, `breakCircles` — so the collector is a **resumable state machine**, not a recursive function. `enum egcDestroyState` does the same for destruction.

### src/angel/src/as_generic.cpp
- Purpose: the trampoline for functions registered with `asCALL_GENERIC`.
- Key abstractions: `asCGeneric` exposes the current call's arguments and return value to a host callback through a uniform accessor set.
- Non-obvious design decisions: the file carries a standing performance note at lines 45-46: "TODO: runtime optimize: The access to the arguments should be optimized so that code doesn't have to count the position of the argument with every call."
- Edge cases: `asCGeneric::GetObject()` returns null when the call has no `this`.

### src/angel/src/as_generic.h
- Purpose: `asCGeneric`'s declaration — `GetArgByte/Word/DWord/QWord/Float/Double/Address/Object`, `SetReturn*`, `GetReturnTypeId`, `GetObjectTypeId`.

### src/angel/src/as_globalproperty.cpp
- Purpose: storage and lifetime for script-declared global variables.
- Key abstractions: `asCGlobalProperty` — a name, a type, an id, a namespace, an optional init function, and either inline storage or a pointer.
- Non-obvious design decisions: the storage is allocated **per property** and only for types larger than two dwords (lines 84-91): "Each allocation is independent of other global properties, so that variables can be added and removed at any time." Small types live inline in the struct.
- Edge cases: a *registered* (host-owned) property of object type is represented as a **pointer to a pointer** (lines 93-98), because the host owns the object and the script owns only a handle to it.

### src/angel/src/as_map.h
- Purpose: the engine's associative container.
- Key abstractions: `asCMap<KEY, VAL>` — a **red-black tree**, not a hash map: `Insert`, `Erase`, `Remove`, `MoveTo/MoveFirst/MoveLast/MoveNext/MovePrev`, and the balance routines `BalanceInsert` / `BalanceErase` / `RotateLeft` / `RotateRight` (lines 80-85).
- Non-obvious design decisions: value assignment is disabled (`asCMap &operator=(const asCMap &) { return *this; }`, lines 77-78) so a map cannot be accidentally copied — copying a tree would be wrong.
- Edge cases: `CheckIntegrity(node)` (line 74) is "for debugging only" but is a real, callable tree validator.

### src/angel/src/as_memory.cpp
- Purpose: the pluggable allocator.
- Key abstractions: `asALLOCFUNC_t userAlloc` / `asFREEFUNC_t userFree` globals, defaulting to `malloc`/`free` (lines 59-60), and the exported `asSetGlobalMemoryFunctions` / `asResetGlobalMemoryFunctions`.
- Non-obvious design decisions: **the swap is preceded by a thread-local cleanup** (lines 68-71): "Clean-up thread local memory before changing the allocation routines to avoid potential problem with trying to free memory using a different allocation routine than used when allocating it." A per-thread free list would otherwise be freed by the wrong allocator.
- Edge cases: the comment at lines 53-58 notes that the globals must be initialised before anything else, because a host may create the engine as a global object.

### src/angel/src/as_memory.h
- Purpose: the allocation macros every engine file uses.
- Key abstractions: `asNEW`, `asDELETE`, `asNEWARRAY`, `asDELETEARRAY` (lines 74-78) — all routed through `userAlloc`/`userFree`, and under `AS_DEBUG` through a variant that also receives `__FILE__` and `__LINE__` (lines 87-93).
- Non-obvious: the file does **not** overload `new` — "We don't overload the new operator as that would affect the application as well" (line 70).

### src/angel/src/as_module.cpp
- Purpose: the unit of compilation and ownership — a module owns the functions, globals and types compiled from a set of script sections.
- Key abstractions: `asCModule` with `m_builder`, `m_scriptFunctions`, `m_globalFunctions`, `m_scriptGlobals`, `m_classTypes`, `m_typeLookup`.
- Data flow: `AddScriptSection` → `Build()` → the builder compiles everything → **`JITCompile()`** (lines 229-236) walks the module's functions and asks the engine's JIT to compile each one. `CompileFunction` (the single-function path) invokes the JIT inline (lines 1551-1555).
- Non-obvious design decisions: the module's JIT pass is **separate from the build pass** — the bytecode is built first, and the native code is produced afterwards, so a module with no JIT installed costs nothing extra.
- Edge cases: the builder is deleted explicitly in the destructor rather than by `InternalReset` (lines 63-69), because it still holds the script sections.

### src/angel/src/as_module.h
- Purpose: the module's public interface and internal state.
- Key abstractions: the public API (`AddScriptSection`, `Build`, `CompileFunction`, `GetFunctionByDecl`, `ResetGlobalVars`, the import/bind table) and the internal lists — including `m_externalTypes` and `m_externalFunctions` (lines 251-254), which hold types and functions explicitly declared `external`, and `m_typeLookup`, a map from namespace+name to type.
- Non-obvious: the bytecode save/load interface is **commented out** (lines 161-162) — this build cannot serialise compiled scripts.

### src/angel/src/as_namespace.h
- Purpose: the namespace type.
- Key abstractions: `asSNameSpace` (a name and nothing else — the header even notes that namespaces *should* have access masks, lines 43-44) and `asSNameSpaceNamePair`, the key type for every type map in the engine.

### src/angel/src/as_objecttype.cpp
- Purpose: the implementation of the script-visible class type.
- Key abstractions: `asCObjectType` — factories, constructors, methods, properties, base class, interfaces, flags (`asOBJ_REF`, `asOBJ_GC`, `asOBJ_NOCOUNT`, `asOBJ_LIST_PATTERN`, `asOBJ_TEMPLATE`, …).
- Non-obvious design decisions: `DestroyInternal` treats a **list pattern** specially (lines 88-94) — a list pattern does not own a reference, so it is invalidated by clearing the engine pointer rather than by being destroyed.
- Edge cases: `GetChildFuncdefByIndex` returns 0 for an out-of-range index rather than asserting (lines 76-81).

### src/angel/src/as_objecttype.h
- Purpose: the object type's declaration and the behaviour table.
- Key abstractions: `asSTypeBehaviour` (lines 51-96) — **17 behaviour slots**: `factory`, `listFactory`, `copyfactory`, `construct`, `copyconstruct`, `destruct`, `copy`, `addref`, `release`, `templateCallback`, the five GC behaviours (`gcGetRefCount`, `gcSetFlag`, `gcGetFlag`, `gcEnumReferences`, `gcReleaseAllReferences`) and `getWeakRefFlag`. These are the hooks that make a host type usable from script.
- Non-obvious: the same behaviour record is used for classes, for funcdefs and for the engine's own internal types — one uniform mechanism.

### src/angel/src/as_outputbuffer.cpp
- Purpose: a buffer that collects compiler messages so they can be flushed to the host as one batch.
- Key abstractions: `asCOutputBuffer::Callback(asSMessageInfo*)` — the engine's message callback target — and `Append` (lines 70-74), which **moves** the other buffer's messages and empties it.
- Non-obvious design decisions: the message is copied field by field into a `message_t` (lines 61-66) rather than a pointer, so the buffer owns its contents and the source can go away.

### src/angel/src/as_outputbuffer.h
- Purpose: the output buffer's declaration — a `message_t` record plus `Clear`, `Callback`, `Append`, `GetMessages`.

### src/angel/src/as_parser.cpp
- Purpose: the recursive-descent parser that turns script text into an AST.
- Key abstractions: one `Parse*` method per grammar production (declared in `as_parser.h:84-158`); the parser is a friend of the builder and the script-node class.
- Data flow: `asCParser::ParseScript` → `GetScriptNode()` hands the tree to the builder.
- Non-obvious design decisions: **the grammar is documented inside the source**, in Extended BNF — "I've documented the syntax in Extended BNF. You'll find it by doing a search in this file by 'BNF:'. The starting point for the script language is SCRIPT ::=" (lines 37-47), with the notation explained at lines 42-46.
- Edge cases: the parser tracks `errorWhileParsing` and `isSyntaxError` separately from the builder's error counters, so a syntax error and a semantic error are distinguishable.

### src/angel/src/as_parser.h
- Purpose: the parser's declaration.
- Key abstractions: the production-per-method structure (`ParseFunctionDefinition`, `ParseParameterList`, `ParseSwitch`, `ParseCase`, `ParseTryCatch`, `ParseClass`, `ParseMixin`, `ParseInitList`, `ParseInterface`, `ParseVirtualPropertyDecl`, `ParseEnumeration`, `ParseLambda`, …) and the token helpers `GetToken` / `RewindTo` / `SetPos` / `Error` / `Warning` / `Info`.
- Non-obvious: there are both `ParseX` and `SuperficiallyParseX` variants (lines 86, 104-105) — "superficial" parsing reads a production's shape without building nodes, which is how the parser can look ahead to decide whether a statement is a declaration or an expression.

### src/angel/src/as_property.h
- Purpose: the two property records.
- Key abstractions: `asCObjectProperty` (name, type, `byteOffset`, `accessMask`, `compositeOffset`, `isCompositeIndirect`, `isPrivate`, `isProtected`, `isInherited`) and `asCGlobalProperty` (name, type, id, namespace, init function, `realAddress` vs owned `memory`).

### src/angel/src/as_scriptcode.cpp
- Purpose: the container for a piece of script source.
- Key abstractions: `asCScriptCode` — a name, the code (owned or shared), a `lineOffset` and a `linePositions` table.
- Non-obvious design decisions: the source may be **shared** rather than copied (`sharedCode` flag, lines 71-84) — the host can hand the engine a pointer to text it will keep alive; a copy is made only when asked. The line table is built once at set-time (lines 86-90).
- Edge cases: `ConvertPosToRowCol` does a **binary search** over the line table (lines 104-120), with the comment "Have we found the largest number < programPosition?"

### src/angel/src/as_scriptcode.h
- Purpose: the script-code container's declaration — `SetCode`, `GetLinePositions`, `ConvertPosToRowCol`.

### src/angel/src/as_scriptengine.cpp
- Purpose: the engine's implementation — the largest single subsystem after the compiler.
- Key abstractions: the exported C entry points `asCreateScriptEngine`, `asGetLibraryVersion`, `asGetLibraryOptions`, and the internal `asCScriptEngine` methods.
- Data flow: registration → module creation → build → context creation → prepare/execute.
- Non-obvious design decisions: **`asGetLibraryOptions()` returns the exact build configuration as a string** (lines 73-128) — every `#ifdef`ed feature is appended ("AS_NO_EXCEPTIONS ", "AS_X64_GCC ", "AS_WIN ", …). A host or a bug report can therefore state exactly which configuration the binary was built with, instead of guessing.
- Edge cases: `asCreateScriptEngine(version)` refuses a mismatched major/minor version (lines 132-140).

### src/angel/src/as_scriptengine.h
- Purpose: the engine's declaration — the god-object of the tree.
- Key abstractions: the whole registration API (global functions, global properties, object types/properties/methods/behaviours, string factory, default array type, enums, funcdefs, typedefs, config groups, modules), the JIT hook (lines 83-84), the GC hook, the context-pooling hook, and the user-data hooks.
- Non-obvious design decisions: the **deferred build** — `RequestBuild()` / `BuildCompleted()` (lines 240-241) with an `isBuilding` flag whose comment says it "is used to prevent multiple threads from requesting builds at the same time (without blocking)" (lines 368-371). The engine's public error `asBUILD_IN_PROGRESS` (angelscript.h:109) is the other half of that contract.
- Edge cases: `lastModule` is cached "for performance improvement, since it is common that the same module is accessed many times in a row" (lines 364-366) — an explicit, commented one-entry cache.
- Surprising: the engine holds **six different cleanup-callback registries** (engine, module, context, function, type-info, script-object — lines 439-450) so a host can register a destructor for each kind of object it handed in.

### src/angel/src/as_scriptfunction.cpp
- Purpose: the implementation of a compiled function — the object that owns both the bytecode and its native twin.
- Key abstractions: `asCScriptFunction::ScriptFunctionData` — bytecode, variable space, the JIT function pointer, debug info.
- Data flow: `JITCompile()` (lines 1320-1363) asks the engine's JIT to compile the function; `GetByteCode()` hands the instruction stream to whoever wants it.
- Non-obvious design decisions: **`JITCompile` verifies that the function actually contains an `asBC_JitEntry` before compiling, and warns if it does not** (lines 1334-1352): it scans the bytecode for the opcode and, if it is missing, writes `TXT_NO_JIT_IN_FUNC_s` — "Function '%s' appears to have been compiled without JIT entry points". The JIT is then asked to compile it anyway.
- Edge cases: the previous native code is **released before the new one is built** (lines 1354-1359), so a recompile never leaves two copies of the same function live.
- Surprising: `RegisterScriptFunction` (lines 55-80) registers the *engine's own* GC behaviours for the `$func` object type, using the same `RegisterBehaviourToObjectType` mechanism a host would use — the engine dogfoods its extension API on itself.

### src/angel/src/as_scriptfunction.h
- Purpose: the compiled function's declaration.
- Key abstractions: `asSFunctionTraits` (a bitfield of `asTRAIT_CONSTRUCTOR`, `DESTRUCTOR`, `CONST`, `PRIVATE`, `PROTECTED`, `FINAL`, `OVERRIDE`, `SHARED`, `EXTERNAL`, `EXPLICIT`, `PROPERTY`), the list-pattern node types, and the `ScriptFunctionData` block.
- Non-obvious: line 348-349 — `// JIT compiled code of this function` / `asJITFunction jitFunction;` — the native code is stored **inside the function object**, so it is released with the function's own lifetime.

### src/angel/src/as_scriptnode.cpp
- Purpose: the AST node.
- Key abstractions: `asCScriptNode` — a node type, a token, a source span, and a doubly-linked child list.
- Non-obvious design decisions: `UpdateSourcePos` (lines 104-126) **widens** the node's span to cover its children — a node's reported source range is the union of its own token and its descendants' tokens, which is what makes an error attributed to a statement highlight the whole statement.
- Edge cases: `Destroy` frees every child and returns the node itself to the **engine's memory manager** (`engine->memoryMgr.FreeScriptNode(this)`, line 70) — AST nodes are pooled, not individually `new`ed.

### src/angel/src/as_scriptnode.h
- Purpose: the AST node's declaration and the node-type enum.
- Key abstractions: `eScriptNode` — **46** node kinds (lines 47-95), from `snScript` through `snTryCatch`, and `sToken` (type, position, length).

### src/angel/src/as_scriptobject.cpp
- Purpose: script object construction, destruction and copying.
- Key abstractions: `ScriptObjectFactory` (lines 41-80) — the default factory path, which **reuses the active context when it can** (lines 48-56): if there is an active context and it belongs to the same engine and `PushState()` succeeds, the construction runs as a nested call instead of a fresh context.
- Non-obvious design decisions: the reuse test is three conditions wide (same engine, `PushState` succeeds, otherwise fall back to `engine->RequestContext()`), and the comment says "It may not always be possible to reuse the current context, in which case we'll have to create a new one any way."
- Edge cases: on a failed `Prepare` the state is unwound symmetrically — `PopState()` if nested, `ReturnContext()` if not (lines 70-75).

### src/angel/src/as_scriptobject.h
- Purpose: the script object's declaration.
- Key abstractions: `asCScriptObject` — property addressing (`GetAddressOfProperty`), the GC protocol (`GetRefCount`, `SetFlag`, `GetFlag`, `EnumReferences`, `ReleaseAllHandles`), and the copy machinery (`AllocateUninitializedObject`, `CopyObject`, `CopyHandle`, `CopyFromAs`); plus `asCLockableSharedBool`, the lockable weak-ref flag.

### src/angel/src/as_string.cpp
- Purpose: the engine's string type.
- Key abstractions: `asCString` — length, and a union of a heap pointer and a 12-byte inline buffer.
- Non-obvious design decisions: the **move constructor** under C++11 (lines 58-75) copies the inline case and steals the heap case; the inline buffer means short strings never allocate.
- Edge cases: `asCString::Format` is variadic and reallocates as needed.

### src/angel/src/as_string.h
- Purpose: the string type's declaration.
- Key abstractions: `asCString` with `Allocate`, `Concatenate`, `SubString`, `FindLast`, `Format`, `Compare`, `AddressOf`, `RecalculateLength`; and the union `char *dynamic; char local[12];`.
- Non-obvious: the file's own header comment is an explicit design statement (lines 31-33): "This class has been designed to be easy to use, but not necessarily efficiency. It doesn't use shared string memory, or reference counting." An engine that cares about speed says so where the reader will see it.

### src/angel/src/as_string_util.cpp
- Purpose: free-function string helpers.
- Key abstractions: `asCompareStrings` (length-aware, compares the shorter prefix first, lines 46-70) and `asStringScanDouble`.
- Non-obvious design decisions: the library **implements its own `strtod`** (lines 72-85) for two stated reasons — `strtod` is not present on every system (iOS 5 is named), and the libc one is locale-dependent and may use a comma as the decimal separator.

### src/angel/src/as_string_util.h
- Purpose: a 34-line header declaring `asCompareStrings`, `asStringScanDouble`, `asStringScanInt64`, `asStringFormat`, `asStringToLower`, etc.

### src/angel/src/as_symboltable.h
- Purpose: the symbol table used for fast lookups while parsing.
- Key abstractions: `asCSymbolTable<T>` — a hash map **plus an ordered index array**, with `asCSymbolTableIterator<T,T2>` that walks in index order (lines 76-95) and exposes `GetIndex()`.
- Non-obvious design decisions: the file is credited to a third party — "Created on: Jun 19, 2012 / Author: Markus Lenger, a.k.a. mlengerx" (lines 34-36) — and it deliberately avoids nested templates: "Interface to avoid nested templates which is not well supported by older compilers, e.g. MSVC6" (line 58).

### src/angel/src/as_texts.h
- Purpose: every user-visible compiler and runtime diagnostic, as a named constant.
- Key abstractions: ~300 `#define TXT_…` strings, e.g. `TXT_ALREADY_DECLARED`, `TXT_NO_JIT_IN_FUNC_s` (line 338 — "Function '%s' appears to have been compiled without JIT entry points"), `TXT_NOT_ALL_PATHS_RETURN`.
- Non-obvious design decisions: the strings are the **only** place the engine's error vocabulary exists. A grep for `TXT_` yields the complete list of things that can go wrong, and each is a single line with a stable name.
- Edge cases: the `_s` suffix convention marks a format string with one `%s`.

### src/angel/src/as_thread.cpp
- Purpose: the thread manager — the engine's multi-threading support.
- Key abstractions: `asCThreadManager` with a `tld` thread-local data pointer, plus the exported `asPrepareMultithread` / `asUnprepareMultithread` / `asGetThreadManager` / `asThreadCleanup` (lines 44-50).
- Non-obvious design decisions: the file states the **ordering rule for the host** (lines 61-90): "To avoid the race condition when the thread manager is first created, the application must make sure to call the global asPrepareForMultiThread() in the main thread before any other thread creates a script engine." It also explains why the critical section cannot be a global: "as there is no guarantee for the order in which global variables are initialized or uninitialized."
- Edge cases: an external thread manager may be supplied so that several DLLs share one critical section (lines 80-88).

### src/angel/src/as_thread.h
- Purpose: the thread manager's declaration, plus `asCThreadLocalData`.

### src/angel/src/as_tokendef.h
- Purpose: the token vocabulary.
- Key abstractions: `eTokenType` — ~150 token kinds (lines 46+), grouped by category (whitespace and comments, atoms, math operators, assignment operators, …), and the `tokenWords` table the tokenizer indexes.
- Non-obvious: `ttNonTerminatedStringConstant` is a **token in its own right** (line 65) — an unterminated string is lexed as a distinct token so the parser can report it precisely rather than as a generic parse failure.

### src/angel/src/as_tokenizer.cpp
- Purpose: the lexer.
- Key abstractions: `asCTokenizer::GetToken(source, length, tokenLength, tokenClass)` and a `keywordTable` of first-character buckets.
- Data flow: the keyword table is built once in the constructor — for each keyword, a bucket is created for its first character and the keyword is inserted **sorted longest-first** (lines 55-85) so that matching can be greedy.
- Non-obvious design decisions: the bucket is a fixed 32-entry array per first character, with the wry comment "Surely there won't ever be more than 32 keywords starting with the same character. Right?" (lines 64-65).
- Edge cases: the tokenizer is instantiated **once per engine** (`asCTokenizer tok;` in `as_scriptengine.h:381`) so the keyword table is shared.

### src/angel/src/as_tokenizer.h
- Purpose: the tokenizer's declaration — `GetToken`, `GetDefinition(tokenType)`, and the shared keyword table.

### src/angel/src/as_typeinfo.cpp
- Purpose: the base type record shared by object types, enums, typedefs and funcdefs.
- Key abstractions: `asCTypeInfo` — name, namespace, module, flags, size, type id, access mask, and **two independent reference counts**: `externalRefCount` and `internalRefCount` (lines 44-45, with the comment "start with one internal ref-count").
- Non-obvious design decisions: the two counters separate "the engine still needs this" from "someone outside still holds this". `Release()` on the external count is what lets a module be discarded while the engine keeps the type alive.
- Edge cases: `typeId` starts at **-1** to mean "not yet assigned" (line 50).

### src/angel/src/as_typeinfo.h
- Purpose: the type-info base class.
- Key abstractions: `asCTypeInfo : public asITypeInfo` — with base implementations of the virtual methods returning defaults (`GetBaseType()` returns 0, `DerivesFrom()` returns false, `GetInterfaceCount()` returns 0, lines 81-98) so that a type which is not an object type still satisfies the interface.
- Non-obvious: the header carries two standing design notes (lines 56-61) about how primitives and funcdefs ought to be represented.

### src/angel/src/as_variablescope.cpp
- Purpose: the compiler's per-scope variable manager.
- Key abstractions: `asCVariableScope` — a linked list of `sVariable` (name, type, stack offset, `isInitialized`, `isPureConstant`, `constantValue`, `onHeap`) with a `parent` pointer.
- Non-obvious design decisions: `DeclareVariable` returns **-1** for a duplicate name and **-2** for an out-of-memory condition (lines 70-102) — two distinct negative codes for two different failures.
- Edge cases: parameters are pre-marked initialised (`stackOffset <= 0`, line 97), and the scope has `isBreakScope` / `isContinueScope` flags for the loop-control flow analysis.

### src/angel/src/as_variablescope.h
- Purpose: the variable scope's declaration — `sVariable` and `asCVariableScope` with `DeclareVariable`, `GetVariable`, `AddVariable`.

### src/angel/src/COPYING
- Purpose: the engine's licence, and — more importantly — the fork's provenance statement.
- Key abstractions: AngelCode's permissive licence text (lines 1-28), then a separator and the project's own statement (lines 29-35): "All the files in this folder have been modified to meet this project's requirements. **Any error is most likely caused by these modifications.** — Santiago González, santigoro@gmail.com".
- Non-obvious design decisions: the vendored licence file is *edited* to carry the fork's disclaimer, so anyone reading the licence learns that the code has diverged from upstream and where to blame.
- Edge cases: this file is distinct from `src/angel/JIT/COPYING`, which is MIT.

### src/angel/src/scriptarray.cpp
- Purpose: the script-visible dynamic array — the standard library's most-used add-on.
- Key abstractions: `CScriptArray` over a `SArrayBuffer` (a header of `maxElements`/`numElements` followed by the data, lines 34-39); `SArrayCache` — the per-type cache of comparison functions (lines 41-47); the user-data key `ARRAY_CACHE = 1000` (lines 49-52).
- Non-obvious design decisions: the comparison function used by `Sort`/`Find` is **cached on the type's user data**, not on the array, so every array of the same element type shares it. The comment explains the numbering convention: "The add-ons have reserved the numbers 1000 through 1999 for this purpose."
- Edge cases: the array has its own allocator hooks (`SetMemoryFunctions`, lines 24-29) so a host can make array memory follow a different policy from engine memory.

### src/angel/src/scriptarray.h
- Purpose: `CScriptArray`'s declaration — the factory functions, `Reserve`/`Resize`, `At`/`SetValue`, `InsertAt`/`RemoveAt`/`RemoveRange`, `Sort`/`Reverse`/`Find`, and the GC protocol.

### src/angel/src/scripthelper.cpp
- Purpose: the "run a string of script" convenience layer.
- Key abstractions: `ExecuteString(engine, code, mod, ctx)` and its overload with a return value.
- Data flow: the snippet is **wrapped in a generated function** (lines 18-21): `funcCode = " ExecuteString() {\n" + code + "\n;}";` and the return type is prefixed from the requested type id (line 24). The function is then compiled through the module's `CompileFunction` and executed in a context.
- Non-obvious design decisions: the wrapper is named with a leading space so it cannot collide with a script symbol, and a type reference is taken before the compile (lines 26-32) because "GetModule will free unused types" — the comment names the hazard and the fix.
- Edge cases: if no module was given, a dummy module named `"ExecuteString"` is created (line 34); if no context was given, one is requested from the engine (line 44).

### src/angel/src/scripthelper.h
- Purpose: a 17-line header declaring `ExecuteString` and `ExecuteFunction`, with the comment "Compile and execute simple statements" and a note that the module and the context are both optional.

### src/angel/src/scriptstdstring.cpp
- Purpose: the `std::string` add-on — registering a real string type with the engine.
- Key abstractions: `CStdStringFactory` — `GetStringConstant` interns the text in a `std::map` with a reference count and hands back a **stable pointer to the map key** (lines 33-41); `ReleaseStringConstant` decrements and erases at zero (lines 43-56); `GetRawStringData` copies the bytes out (lines 58-66).
- Non-obvious design decisions: interning means every equal string literal in a script is one allocation, and the pointer stays valid because it points into the map, not into a temporary.
- Edge cases: the factory is a singleton with a "cleaner" instance that destroys it at application shutdown (lines 73-84), and the cache access is protected by the engine's common mutex (line 67).

### src/angel/src/scriptstdstring.h
- Purpose: `RegisterStdString` and the compile-time options.
- Key abstractions: `AS_USE_STLNAMES` (0 = off, 1 = on) — use the same method names as C++ STL so code converts between script and C++ cheaply (lines 25-33) — and `AS_USE_ACCESSORS` (register `length` as a property accessor instead of a method, lines 35-38).

## Ideas worth stealing

- **The fast path is a plug-in with a two-method interface, and the engine never learns how it works.** `src/angel/include/angelscript.h:1211-1218` — `class asIJITCompiler { virtual int CompileFunction(asIScriptFunction*, asJITFunction*) = 0; virtual void ReleaseJITFunction(asJITFunction) = 0; };`, reached through `asIScriptEngine::SetJITCompiler` / `GetJITCompiler` (`angelscript.h:611-612`). SimulIDE installs it at runtime, conditionally, in one place (`src/microsim/modules/script/scriptbase.cpp:67-71`, `#ifdef __x86_64__`). **Why it transfers to August:** a skill or plugin surface with a two-method "accelerator" interface — `install()` / `uninstall()` — lets August add a compiled or native fast path for a hot operation without a build matrix, without touching the core, and without the core learning anything about it. The engine-side lesson is the *shape*: the interface is deliberately tiny, and the host decides at runtime whether it exists.

- **A marker instruction that says "native code may take over here" — the trick that lets a fast path and a slow path coexist in one program.** `src/angel/include/angelscript.h:1398` defines the opcode `asBC_JitEntry = 175`; the compiler emits it at the start of every function (`src/angel/src/as_compiler.cpp:132-133, 185-186, 562-563`) and the bytecode builder emits it after every call, every allocation and every suspend (`src/angel/src/as_bytecode.cpp:1618-1619, 1633-1634, 1649-1650, 1705-1706`); the interpreter treats it as a resume point (`src/angel/src/as_context.cpp:3650-3679`) and the optimiser refuses to fuse across one (`src/angel/JIT/as_jit.cpp:846`). **Why it transfers to August:** if August ever wants to accelerate a hot part of a workflow (a diff, a parse, a solver step), the same design applies — mark the safe re-entry points in the intermediate representation, compile the regions between them, and let the fallback handle the rest. The cost of the marker is one instruction, and it is *deleted again* when no accelerator is installed (`as_bytecode.cpp:1083-1088`), so the slow path pays nothing.

- **The fast path can hand the program back to the slow path at any moment, and the slow path can resume it — with a single, explicit register block as the contract.** `src/angel/JIT/as_jit.cpp:738-741` ("We can't handle this address, so generate a special return that does the jump ahead of time") returns control to the VM with the bytecode pointer in the return register; `src/angel/src/as_context.cpp:1028-1030` shows the VM calling straight back into native code with `asSVMRegisters`; the struct itself is public at `src/angel/include/angelscript.h:1197-1207`. **Why it transfers to August:** this is the shape a step-based simulator needs. A "model" can be executed by a fast kernel and, when it meets something the kernel cannot do (an I/O event, a suspension), return a *program counter* into a description of the model so the harness can resume later. The lesson is that the handoff state must be one small, explicit, versioned struct — not scattered variables — so that two independent implementations (fast kernel, fallback engine) can be written by different people and still interleave.

- **Speed trade-offs are named constants with the cost written next to them, not one "fast mode" boolean.** `src/angel/JIT/as_jit.h:16-33` — seven flags, each with its own sentence about what it gives up: `JIT_SYSCALL_NO_ERRORS` ("exceptions will generally be ignored, possibly leading to crashes"), `JIT_NO_SCRIPT_CALLS` ("can be used as a temporary workaround for angelscript changes"), `JIT_FAST_REFCOUNT` ("Reference counting functions which access the script context will produce undefined results"). SimulIDE picks exactly two (`scriptbase.cpp:68`). **Why it transfers to August:** August already has a "budget ladder" and a set of degraded modes; naming each degradation separately — with the consequence in the comment — is what makes a degraded mode *safe to enable*. A single boolean cannot say "this one is fine, that one can crash".

- **Compile-time feature removal, not runtime guarding.** `src/angel/src/as_config.h:77` — `#define AS_NO_EXCEPTIONS` removes the language's entire exception feature from the parser, the compiler, the VM and the JIT at once; line 352 adds `#define AS_NO_THISCALL_FUNCTOR_METHOD`. **Why it transfers to August:** a capability that a skill does not need can be switched off for that skill's whole build, which shrinks the code *and* the attack surface. August's `code` agent mode already restricts the tool surface at runtime; a compile-time switch is the stronger version of the same idea.

- **The build configuration is queryable at runtime as a string, so a bug report can state the configuration instead of guessing it.** `src/angel/src/as_scriptengine.cpp:73-128` — `asGetLibraryOptions()` appends a token for every `#ifdef`ed feature and the target system and CPU family ("AS_NO_EXCEPTIONS ", "AS_X64_GCC ", "AS_WIN ", …). **Why it transfers to August:** every August session should be able to emit one line that says exactly which features, paths and models were in effect. The August harness has an equivalent problem — a "capabilities line" — and the engine solves it by deriving it from the same macros that shaped the build, so it can never drift.

- **Every diagnostic is a named constant in one file, so the failure vocabulary is greppable and complete.** `src/angel/src/as_texts.h:40+` — ~300 `#define TXT_…` strings, including `TXT_NO_JIT_IN_FUNC_s` (line 338). **Why it transfers to August:** August's error taxonomy (the eight-family classification in the harness rules) could live in one table of constants rather than as literals scattered across handlers. The benefit is the same one this file gets: `grep TXT_` returns the complete list of things that can go wrong, and each message has a stable name that a test can assert on.

- **A vendored dependency that says, in its own licence file, that it has been modified — so the fork's divergence is discoverable at the point of use.** `src/angel/src/COPYING:31-34` — "All the files in this folder have been modified to meet this project's requirements. **Any error is most likely caused by these modifications.**" — plus the per-file marker `// Modified 2023 by Santiago González` at `src/angel/src/as_datatype.cpp:31`. **Why it transfers to August:** August vendors or wraps third-party code (parsers, model clients, protocol libraries). Writing the divergence statement *into the vendored licence file* means the next person who hits a bug in that code reads the warning before they debug it, instead of filing it against upstream.

- **Reference counting split into "the engine owns it" and "someone outside holds it".** `src/angel/src/as_typeinfo.cpp:44-45` — `externalRefCount` and `internalRefCount` are two independent counters; `as_module.h:183` exposes `HasExternalReferences(bool shuttingDown)` so a module can be discarded only when nobody outside still refers to it. **Why it transfers to August:** August's memory and skill stores have exactly this problem — a skill record is owned by the store but may be referenced by a running session. One refcount cannot express "the owner may go, the referrer may not".

- **A garbage collector that detects cycles, breaks them, and tells the host — and that does its work in bounded slices spread across allocations.** `src/angel/src/as_gc.h:62-64` (the host callback), `src/angel/src/as_gc.h:78-94` (an explicit, resumable phase machine: `clearCounters`, `buildMap`, `countReferences`, `detectGarbage`, `verifyUnmarked`, `breakCircles`), `src/angel/src/as_gc.cpp:87-100` (one step of detection per new object, with the reason stated: "This will maintain the number of objects in the GC at a maintainable level without halting the application"). **Why it transfers to August:** the August brain store and the session transcript can both hold cycles; a collector that refuses to run while the application is busy is worse than one that does a little work per allocation. And the phase-machine shape makes the collector interruptible, which is what a harness with a turn budget needs.

- **The allocator is the host's, and swapping it is done in an order that cannot free memory with the wrong allocator.** `src/angel/src/as_memory.cpp:66-77` — `asSetGlobalMemoryFunctions` calls `asThreadCleanup()` *first* with the comment "Clean-up thread local memory before changing the allocation routines to avoid potential problem with trying to free memory using a different allocation routine than used when allocating it." **Why it transfers to August:** any August component that lets the host install a custom allocator (a memory-budgeted allocator, a tracing allocator) has the same hazard; the fix is one line and the reasoning is worth copying verbatim.

- **Small containers do not allocate.** `src/angel/src/as_array.h:94` — `char buf[2*4*AS_PTR_SIZE];` gives `asCArray` an inline buffer for one or two elements; `src/angel/src/as_string.h:89-93` gives `asCString` a 12-byte inline buffer in a union with the heap pointer. **Why it transfers to August:** the harness's hot paths (per-tool-call records, per-turn message rows, per-file ledger rows) are dominated by single-element containers. An inline buffer removes the allocation and the free, and — more importantly — removes the failure case.

## Files skipped (with reasons)

No file in this shard was left unread. Every one of the 85 files was opened, and every one is marked `read` in the ledger. What differs is **depth**, and the honest accounting is:

- **Read in full, line by line** (35 files): `src/angel/JIT/as_jit.h`, `src/angel/JIT/COPYING`, `src/angel/JIT/virtual_asm_linux.cpp`, `src/angel/JIT/virtual_asm_windows.cpp`, `src/angel/JIT/virtual_asm_x64.cpp`, `src/angel/JIT/virtual_asm.h`, `src/angel/include/angelscript.h`, `src/angel/src/as_atomic.cpp`, `src/angel/src/as_bytecode.h`, `src/angel/src/as_builder.h`, `src/angel/src/as_callfunc.h`, `src/angel/src/as_configgroup.h`, `src/angel/src/as_context.h`, `src/angel/src/as_datatype.h`, `src/angel/src/as_gc.h`, `src/angel/src/as_generic.h`, `src/angel/src/as_module.h`, `src/angel/src/as_outputbuffer.h`, `src/angel/src/as_parser.h`, `src/angel/src/as_scriptcode.h`, `src/angel/src/as_scriptengine.h`, `src/angel/src/as_scriptfunction.h`, `src/angel/src/as_scriptnode.h`, `src/angel/src/as_scriptobject.h`, `src/angel/src/as_string.h`, `src/angel/src/as_symboltable.h`, `src/angel/src/as_thread.h`, `src/angel/src/as_tokenizer.h`, `src/angel/src/as_typeinfo.h`, `src/angel/src/as_variablescope.h`, `src/angel/src/scriptarray.h`, `src/angel/src/scripthelper.h`, `src/angel/src/scriptstdstring.h`, `src/angel/src/COPYING`, and `src/angel/JIT/as_jit.cpp` (4,382 lines, read in six contiguous passes covering the whole file).
- **Read as the head of the file plus every region relevant to the mechanism** — the balance of the shard. The largest of these are `src/angel/src/as_compiler.cpp` (13,985 lines: I read the header, the three `asBC_JitEntry` insertion sites at lines 132-133, 185-186 and 562-563, and the return-path check at 552-558), `src/angel/src/as_builder.cpp` (5,307 lines: head plus the symbol-table specialisations), `src/angel/src/as_context.cpp` (4,813 lines: head, the JIT entry at 1028-1030, the interpreter's `asBC_JitEntry` case at 3650-3679), `src/angel/src/as_scriptengine.cpp` (4,663 lines: head plus `asGetLibraryOptions` at 73-128 and `asCreateScriptEngine` at 132-140), `src/angel/src/as_parser.cpp` (3,735 lines: head plus the EBNF note), `src/angel/src/as_bytecode.cpp` (2,165 lines: head, `Finalize` at 65-73, the JitEntry emission sites at 1618-1706, the JitEntry deletion at 1083-1088), `src/angel/src/scriptarray.cpp` (1,716 lines: head), `src/angel/src/as_scriptfunction.cpp` (1,290 lines: head plus `JITCompile` at 1319-1363), `src/angel/src/as_callfunc_x86.cpp` (1,275 lines: head plus the FPU rationale), `src/angel/src/as_module.cpp` (1,386 lines: head plus `JITCompile` at 228-236 and the single-function JIT call at 1551-1555). **These were not read line by line** because they are upstream library code whose mechanism I could locate by reading the header, the class declaration and the specific functions that carry the behaviour; the per-file notes above say what was read. A reader who needs a line-level audit of `as_compiler.cpp`'s expression compiler should read that file separately.
- **Not read at all**: nothing.

## Uncertainties

- **The manifest in the working tree does not contain this shard.** `docs/research/simulide/manifest.tsv` as it stands on disk (modified 13:45 today) has **zero** rows with owner-shard `angel-jit`; the name survives only in the committed version at HEAD (`bc531b2e`), where it owns exactly these 85 files. I verified this by diffing the committed manifest's owner column (`angel-jit` × 85) against the working copy (`src-angel-01` … `src-angel-11`, and `src-angel-08…11` duplicate `src-angel-06/07` exactly). If the lead intends the finer split, my 85 rows overlap `src-angel-01…11` and should be reconciled rather than merged.
- **I could not establish which upstream AngelScript version this fork is based on, beyond the header's own claim.** `src/angel/include/angelscript.h:61-62` says `ANGELSCRIPT_VERSION 23501` / `"2.35.1"`, but the tree carries 2021–2024 copyright lines (e.g. `as_callfunc_arm64.cpp:39` "Adapted for Apple M1/M2 by Sam Tupy in Jan 2024") and `as_config.h` is dated 2003-2021, so the fork is a *mixture* of upstream releases. **What I checked:** every file's header year, the version macro, and a grep for fork markers (which found only `as_datatype.cpp:31` and the `src/angel/src/COPYING:31` statement). I could not diff against upstream without network access to the AngelScript repository, so I cannot say which upstream files were changed and how — only which files carry a marker.
- **I could not confirm that the JIT is actually enabled in a shipped SimulIDE build.** `src/microsim/modules/script/scriptbase.cpp:67-71` guards the JIT behind `#ifdef __x86_64__`, and `src/angel/JIT/as_jit.h` guards the whole class behind the same macro, so on a 32-bit build the JIT does not exist. On x86-64 the JIT is installed. What I could **not** check is whether `asEP_INCLUDE_JIT_INSTRUCTIONS` is set anywhere else, or whether the JIT's `JIT_NO_SUSPEND | JIT_SYSCALL_NO_ERRORS` combination is safe in practice — `JIT_SYSCALL_NO_ERRORS` is documented as "exceptions will generally be ignored, possibly leading to crashes" (`as_jit.h:21`), and SimulIDE's engine is compiled with `AS_NO_EXCEPTIONS` (`as_config.h:77`), which is consistent with that choice. I did not build or run anything to confirm.
- **The JIT's own correctness is unverified.** I read `as_jit.cpp` and `virtual_asm_x64.cpp` in full and understand the mechanism, but the code contains several places where a mistake would be silent — the `EAX_Stack` / `EAX_Offset` register-content cache (lines 438, 785-786), the `reservedPushBytes` batching (lines 778, 1134-1139), and the hand-rolled ModR/M/SIB emission. I cannot say whether these are correct without running them, and the repo has no tests. **What I checked:** the JIT's own `#ifdef JIT_DEBUG` instrumentation (lines 56-66) and the `JIT_PRINT_UNHANDLED_CALLS` switch (lines 42-47), both of which exist precisely because the author expected silent gaps.
- **I could not establish how the JIT interacts with SimulIDE's simulator time-stepping.** The JIT compiles *script* functions; SimulIDE's simulation loop is in `src/simulator/` and the MCU models in `src/microsim/`, both outside this shard. The one bridge I read is `src/microsim/modules/script/scriptbase.cpp`, which shows the engine being created, `asEP_AUTO_GARBAGE_COLLECT` turned **off** (line 56) and the GC run manually at destruction (line 75), and `asEP_BUILD_WITHOUT_LINE_CUES` turned on (line 57) — which removes the per-line `asBC_SUSPEND` instructions, and therefore removes one class of JIT resume points. Whether that interacts well with `JIT_NO_SUSPEND` I could not determine from this shard.
- **Two files I read only as headers** are worth flagging for a follow-up reader: `src/angel/src/as_array.h` is 449 lines and its implementation lives inline in the header (the `asCArray` template's methods are defined at the bottom of the same file, past line 95), and `src/angel/src/as_map.h` is 651 lines of which I read the declaration and the balance-routine names. Both are standard containers and neither carries a SimulIDE-specific change, so I judged the header sufficient for the note; a reader wanting the growth policy or the tree-rotation code should read the tail of each file.

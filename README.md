# ARDL – AUTOSAR Design Language

Lightweight design as code for AUTOSAR Classic application software (ASW) and basic software (BSW). You write `.ardl` text files; VS Code checks them as you type and shows the diagrams next to the editor. Same idea as Mermaid or PlantUML, but with AUTOSAR concepts built in: ports, interface kinds, runnables, compositions, BSW layers.

```
interface sr Speed { Value: uint16 }

swc application LightCtrl {
    rport RpSpeed : Speed
    pport PpLamp  : LampState
    runnable R_Control every 10ms reads RpSpeed writes PpLamp
}

composition Body {
    prototype SpeedCalc
    prototype LightCtrl
    connect SpeedCalc.PpSpeed -> LightCtrl.RpSpeed
}

bsw NvM layer services uses MemIf
```

Three examples in `examples/` describe one ECU in three feature files:

| File | Content |
|---|---|
| `light-control.ardl` | Light control: sensor, speed calculation, `LightCtrl`, lamp driver, calibration, mode manager, the `Body` composition, and the basic software of the ECU |
| `diag-master.ardl` | Diagnostics for the same ECU: `DiagMaster` with Dem events, a Dcm DID and routine, the session mode, and the top-level composition `LightEcu` that combines `Body` and diagnostics |
| `light-control-os.ardl` | The OS of the ECU (ThreadX profile): tasks with the runnables of `light-control.ardl` mapped to them, a mutex, a semaphore, a queue, an event and two ISRs |

The second and third file declare no interface, component or BSW module again; they use those of the first.

## Language

| Element | Syntax |
|---|---|
| Interface | `interface sr\|cs\|mode\|nv\|param Name { ... }` |
| Sender-receiver / NV / parameter member | `Value: uint16`, arrays `Value: uint16[4]` |
| Client-server operation | `GetValue(in id: uint16, out value: uint32): Std_ReturnType` |
| Mode group | `modes STARTUP, RUN, SHUTDOWN` |
| Software component | `swc application\|sensorActuator\|service\|ecuAbstraction\|complexDriver\|parameter Name { ... }` |
| BSW module | `bsw Name layer services\|ecual\|mcal\|cdd [uses A, B] [{ ... }]` |
| Port | `pport Name : Interface`, `rport ...`, `prport ...` |
| Runnable | `runnable Name <triggers> <accesses>` |
| Triggers | `every 10ms`, `on init`, `on data Port`, `on call Port`, `on mode Port` |
| Accesses | `reads A, B`, `writes P`, `calls Client`, `switches ModePort` |
| Composition | `composition Name { ports, prototypes, connectors }` |
| Prototype | `prototype Type` (named like the type) or `prototype name: Type` |
| Connector | `connect proto.PPort -> proto.RPort`; delegation `connect OuterR -> proto.R`, `connect proto.P -> OuterP` |
| OS | `os Name [profile autosar\|osek\|threadx\|freertos\|generic] { tasks, ISRs, objects }` |
| Task | `task Name [prio 10] [every 10ms \| on startup] [core 0] [runs Swc.Runnable, ...] <os accesses>` |
| ISR | `isr Name [cat 1\|2] [prio 5] [core 0] <os accesses>` |
| OS objects | `mutex Name [protocol ceiling\|inherit\|none]`, `semaphore Name [count 2]`, `queue Name [of Type] [depth 8]`, `event Name` |
| OS accesses | `locks M1, M2` (M2 while M1 is held), `takes S`, `gives S`, `sends Q`, `receives Q`, `waits E`, `sets E` |
| Views | `view Name composition C`, `view Name component X`, `view Name layers [{ A, B }]`, `view Name os O`, each with optional `title "..."` |

Without `view` declarations a file shows each composition, a BSW layer view if it declares BSW modules, each `os` and, if it has none of these, one view per SWC.

Task clauses come in any order and may span lines, like the clauses of a runnable. `runs` maps runnables of any file to the task (the AUTOSAR RTE event to task mapping); BSW main functions are mapped the same way, e.g. `runs NvM.NvM_MainFunction`. Names inside an `os` block are local to it. ARDL deliberately has no timing model (WCET, schedule simulation, Gantt charts): it describes the structure, and timing analysis belongs in dedicated tools.

**Names are global** across all `.ardl` files of the workspace (there are no packages or imports). A model can be split into files by feature or by kind, e.g. interfaces in one file, but every name is declared exactly once. Views have a namespace of their own, so `view Body composition Body` is fine.

## Checks

- Assembly connectors go from a P-port to an R-port; delegation connectors from outer R to inner R or inner P to outer P.
- Compositions do not contain themselves, directly or through other compositions.
- Connected ports use the same interface; a client port connects to one server only.
- Unconnected R-ports of prototypes are warnings.
- Runnable accesses fit the port: `reads` a required sr/nv/param port, `writes` a provided sr/nv port, `calls` a required cs port, `switches` a provided mode port; same for the triggers.
- Interface members fit the interface kind.
- BSW layering: an upward `uses` (e.g. MCAL → services) is a warning; services using an MCAL driver directly is a hint. Complex drivers may use any layer.
- OS profile: AUTOSAR/OSEK resources use the priority ceiling protocol and there are no semaphores, an AUTOSAR/OSEK event belongs to one task; ThreadX/FreeRTOS mutexes use priority inheritance.
- OS objects: `locks` needs a mutex, `takes`/`gives` a semaphore, `sends`/`receives` a queue, `waits`/`sets` an event. Unused objects, queues without sender or receiver, events nobody sets or nobody waits for, and semaphores that are taken but never given are warnings.
- Priority inversion: a mutex with `protocol none` shared by tasks of different priority. Lock order: `locks A, B` in one task and `locks B, A` in another is a possible deadlock.
- ISRs never block (`takes`, `receives`, `waits`); category 1 ISRs use no OS objects; RTOS mutexes cannot be locked from an ISR.
- Runnable mapping: each runnable runs in one task; a component with some mapped runnables needs all of them mapped, except pure servers (`on call` only); a periodic runnable's period is a multiple of its task's period. Components without any mapping are not reported, they may belong to another ECU.
- Duplicate names, within a file and across files; unresolved references.

## Views

| View | Shows |
|---|---|
| Composition | Prototypes with their ports, assembly and delegation connectors. R-ports left, P-ports right, so data flows left to right. |
| Component | One SWC or BSW module: ports, runnables, which runnable reads, writes, calls or serves which port. |
| Layers | BSW modules in the AUTOSAR layer bands (services, ECU abstraction, MCAL, complex drivers) with their `uses` dependencies. Upward dependencies are red. |
| OS | Tasks and ISRs with priority, activation, core and their runnables (the first eight, all of them on hover), and the objects they share: hexagon = mutex, pill = semaphore, box with slots = queue, flag = event. Edges follow the flow: sender → queue → receiver, setter → event → waiter, giver → semaphore → taker; `locks` is a dashed line. |

Port symbols: triangle = sender-receiver (points in the data direction), filled circle = server, ring = client, diamond = mode (filled = manager, outline = user). Edge colors follow the interface kind.

## VS Code

- Syntax highlighting, diagnostics, completion, go to definition, find references, rename.
- **ARDL: Open Diagram Preview to the Side** (`Cmd+K V`, or the preview icon in the editor title). The preview follows the active `.ardl` editor, refreshes as you type, has a tab per view, zoom (buttons, pinch or Cmd/Ctrl + wheel), drag to pan, and **Export SVG** for the current view. It uses the editor's light or dark theme.
- **ARDL: Export Diagrams as SVG** writes one `<file>.<view>.svg` per view next to the `.ardl` file.

## Command line

```bash
npm run build
node bin/ardl.cjs check examples
node bin/ardl.cjs render examples -o out/diagrams
```

`check` prints diagnostics and exits with 1 on errors, so it fits a CI job. `render` writes standalone SVGs (light theme, CSS variables `--ardl-*` for restyling) that can go straight into a website or a Markdown document.

## Development

```bash
npm install
npm run build            # Langium generator, type check, esbuild bundles in out/
npm test                 # vitest: parser, validation, rendering
npm run check:examples   # the CLI on examples/
npm run package          # ardl-<version>.vsix
code --install-extension ardl-0.1.0.vsix
```

To debug, open this folder in VS Code and start **Run Extension** (`.vscode/launch.json`). It builds, then opens a second window with the extension loaded and `examples/` open. **Attach to Language Server** connects the debugger to the server process.

The generated parser and AST in `src/language/generated/` are committed, so tests run right after `npm install`. Run `npm run langium:generate` (part of `build`) after changing the grammar.

| Path | Content |
|---|---|
| `src/language/ardl.langium` | Grammar |
| `src/language/ardl-scope.ts` | Scoping: which ports a runnable or connector can see |
| `src/language/ardl-semantics.ts` | AUTOSAR rules shared by validator and diagrams (port directions, layer ranks) |
| `src/language/ardl-validator.ts` | AUTOSAR checks |
| `src/language/main.ts` | Language server, plus the `ardl/diagrams` request |
| `src/diagram/` | Model → ELK graph → layout → SVG, one file per view |
| `src/extension/` | VS Code client and preview webview |
| `src/cli/main.ts` | `ardl check` / `ardl render` |
| `media/` | Webview script and styles |
| `test/preview-harness.html` | The webview outside VS Code, for checking layout and theming in a browser |

Built on [Langium](https://langium.org) (parser, language server) and [ELK](https://eclipse.dev/elk/) via elkjs (layered layout with port constraints).

## License

MIT, see `LICENSE`.

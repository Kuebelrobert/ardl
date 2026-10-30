/**
 * Tests for parser, validation and diagram rendering.
 *
 * Every test parses ARDL source in memory (no file system) with Langium's
 * `parseHelper` and checks the resulting diagnostics or diagrams. Diagnostics
 * are compared as `severity: message` strings, so a failing test shows the
 * exact message the user would see in VS Code.
 */
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumSharedCoreServices } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import { createArdlServices } from '../src/language/ardl-module.js';
import type { Model } from '../src/language/generated/ast.js';
import { renderDiagrams } from '../src/diagram/index.js';

let shared: LangiumSharedCoreServices;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
    const services = createArdlServices(EmptyFileSystem);
    shared = services.shared;
    parse = parseHelper<Model>(services.Ardl);
});

// All parsed documents share one workspace, and names are global across it.
// Remove them after each test, so declarations of one test never clash with another.
afterEach(async () => {
    await clearDocuments(shared);
});

/** Parses and validates `text`, returns its diagnostics as `severity: message`. */
async function diagnostics(text: string): Promise<string[]> {
    const doc = await parse(text, { validation: true });
    return (doc.diagnostics ?? []).map(d => `${['', 'error', 'warning', 'info', 'hint'][d.severity ?? 1]}: ${d.message}`);
}

/** Parses `text` and renders its views. */
async function render(text: string) {
    const doc = await parse(text);
    return renderDiagrams(doc.parseResult.value, [doc.parseResult.value]);
}

/** A small valid model most tests build on: a producer and a consumer of one sr and one cs interface. */
const BASE = `
interface sr Speed { Value: uint16 }
interface sr Temp { Value: sint16 }
interface cs Calib { GetValue(in id: uint16, out value: uint32): Std_ReturnType }
swc application Producer { pport Out : Speed  pport Server : Calib }
swc application Consumer {
    rport In : Speed
    rport Client : Calib
    runnable R every 10ms reads In calls Client
}
`;

describe('parsing', () => {
    test('a valid model has no diagnostics', async () => {
        expect(await diagnostics(BASE + `
composition C {
    prototype Producer
    prototype c: Consumer
    connect Producer.Out -> c.In
    connect Producer.Server -> c.Client
}`)).toEqual([]);
    });

    test('soft keywords can be used as names', async () => {
        expect(await diagnostics(`interface sr Mode { mode: uint8  data: uint8 }`)).toEqual([]);
    });
});

describe('validation', () => {
    test('assembly connector must go from P-port to R-port', async () => {
        const result = await diagnostics(BASE + `
composition C {
    prototype Producer
    prototype Consumer
    connect Consumer.In -> Producer.Out
    connect Producer.Server -> Consumer.Client
}`);
        expect(result).toContain("error: Assembly source must be a provided port; 'Consumer.In' is an R-port. Swap the ends.");
        expect(result).toContain("error: Assembly target must be a required port; 'Producer.Out' is a P-port.");
    });

    test('interfaces of connected ports must match', async () => {
        const result = await diagnostics(BASE + `
swc application T { rport In : Temp }
composition C {
    prototype Producer
    prototype T
    connect Producer.Out -> T.In
}`);
        expect(result).toContain("error: Interface mismatch: 'Producer.Out' is Speed, 'T.In' is Temp.");
    });

    test('unconnected R-ports are reported', async () => {
        const result = await diagnostics(BASE + `
composition C { prototype Consumer }`);
        expect(result).toContain("warning: R-port 'Consumer.In' is not connected.");
        expect(result).toContain("warning: R-port 'Consumer.Client' is not connected.");
    });

    test('compositions must not contain themselves, also indirectly', async () => {
        const result = await diagnostics(`
composition A { prototype B }
composition B { prototype A }
composition Self { prototype Self }`);
        expect(result).toContain("error: Composition 'A' cannot contain itself through 'B'.");
        expect(result).toContain("error: Composition 'B' cannot contain itself through 'A'.");
        expect(result).toContain("error: Composition 'Self' cannot contain itself.");
    });

    test('runnable accesses must fit the port', async () => {
        const result = await diagnostics(BASE + `
swc application X {
    pport Out : Speed
    rport Client : Calib
    runnable R every 10ms reads Out writes Client
}`);
        expect(result).toContain("error: 'reads' needs a required sr/nv/param port; 'Out' is a pport of a 'sr' interface.");
        expect(result).toContain("error: 'writes' needs a provided sr/nv port; 'Client' is a rport of a 'cs' interface.");
    });

    test('runnables only see the ports of their own component', async () => {
        const result = await diagnostics(BASE + `
swc application X { runnable R every 10ms reads In }`);
        expect(result.some(m => m.startsWith('error: Could not resolve reference') && m.includes("'In'"))).toBe(true);
    });

    test('interface members must fit the interface kind', async () => {
        const result = await diagnostics(`interface cs Wrong { Value: uint8 }`);
        expect(result).toContain('error: A \'cs\' interface contains operations (name(in a: T): R) only.');
    });

    test('BSW layering: upward dependencies are warnings, complex drivers are exempt', async () => {
        const result = await diagnostics(`
bsw Fls layer mcal uses NvM
bsw NvM layer services
bsw Drv layer cdd uses NvM`);
        expect(result).toEqual(["warning: Upward dependency: mcal module 'Fls' uses services module 'NvM'."]);
    });

    test('names are global across files, views have their own namespace', async () => {
        await parse(`interface sr Shared { V: uint8 }  composition Box { }`, { documentUri: 'file:///a.ardl' });
        const doc = await parse(`interface sr Shared { V: uint8 }\nview Box composition Box`, { documentUri: 'file:///b.ardl', validation: true });
        const messages = (doc.diagnostics ?? []).map(d => d.message);
        expect(messages).toEqual(["'Shared' is already declared in a.ardl. Names are global across all .ardl files."]);
    });

    test('duplicate names are errors', async () => {
        const result = await diagnostics(`
interface sr A { V: uint8 }
interface sr A { V: uint8 }`);
        expect(result.filter(m => m === "error: Element name 'A' is used more than once.")).toHaveLength(2);
    });
});

describe('diagrams', () => {
    test('a document without views gets default views', async () => {
        const diagrams = await render(BASE + `
composition C { prototype Producer prototype Consumer connect Producer.Out -> Consumer.In connect Producer.Server -> Consumer.Client }
bsw Can layer mcal
bsw CanIf layer ecual uses Can`);
        expect(diagrams.map(d => d.id)).toEqual(['C', 'layers']);
        for (const d of diagrams) {
            expect(d.svg).toMatch(/^<svg /);
            expect(d.svg).not.toContain('layout failed');
        }
    });

    test('explicit views are rendered in order and escape model text', async () => {
        const diagrams = await render(BASE + `
view A component Consumer title "Consumer <detail>"
view B component Producer`);
        expect(diagrams.map(d => d.id)).toEqual(['A', 'B']);
        expect(diagrams[0].svg).toContain('Consumer &lt;detail&gt;');
    });

    test('layers view: only real layering violations are red, repeated uses are drawn once', async () => {
        const [layers] = await render(`
bsw Det layer services
bsw Fls layer mcal uses Det, Det
bsw Drv layer cdd uses Det`);
        expect(layers.svg).not.toContain('layout failed');
        // Fls -> Det is a violation; Drv -> Det is reversed for the layout too, but legal.
        expect(layers.svg.match(/class="edge upward"/g)).toHaveLength(1);
        expect(layers.svg.match(/<title>Fls uses Det/g)).toHaveLength(1);
    });
});

describe('os', () => {
    /** Two SWCs with periodic, init and server runnables to map. */
    const SWCS = BASE + `
swc application Ctrl {
    pport Server : Calib
    runnable R_Init on init
    runnable R_Main every 10ms
    runnable R_Get on call Server
}`;

    test('a complete mapping across tasks is valid', async () => {
        expect(await diagnostics(SWCS + `
os O profile threadx {
    mutex M
    queue Q of uint16 depth 4
    task Init prio 9 on startup runs Ctrl.R_Init
    task T10 prio 5 every 10ms
        runs Ctrl.R_Main, Consumer.R
        locks M
        sends Q
    task Rx prio 6 receives Q locks M
}`)).toEqual([]);
    });

    test('runnables: unknown, mapped twice, missing in a mapped component, period mismatch', async () => {
        const result = await diagnostics(SWCS + `
os O {
    task A every 20ms runs Ctrl.R_Main, Ctrl.R_Nope
    task B every 10ms runs Ctrl.R_Main
}`);
        expect(result).toContain("error: Could not resolve reference to Runnable named 'R_Nope'.");
        expect(result).toContain("warning: 'Ctrl.R_Main' is already mapped to 'A'.");
        expect(result).toContain("warning: 'R_Main' runs every 10ms, which is not a multiple of the 20ms period of 'A'.");
        // R_Get is a pure server and runs in the caller's context.
        expect(result).toContain("warning: Runnables of 'Ctrl' not mapped to a task: R_Init.");
        // Components without any mapping (Consumer) may belong to another ECU and are not reported.
        expect(result.some(m => m.includes("'Consumer'"))).toBe(false);
    });

    test('objects: wrong access, unused, one-sided queue and event, priority inversion', async () => {
        const result = await diagnostics(`
os O {
    mutex M protocol none
    mutex Unused
    queue Q
    event E
    task Hi prio 9 locks M waits E sends Q
    task Lo prio 1 locks M takes Q
}`);
        expect(result).toEqual(expect.arrayContaining([
            "warning: 'M' is shared by tasks of different priority without a protocol: priority inversion. Use 'protocol inherit' or 'protocol ceiling'.",
            "warning: 'Unused' is not used by any task or ISR.",
            "warning: 'Q' is sent to but nobody receives from it.",
            "warning: 'E' is never set: Hi wait forever.",
            "error: 'takes' needs a semaphore; 'Q' is a queue."
        ]));
    });

    test('lock order cycles are possible deadlocks', async () => {
        const result = await diagnostics(`
os O {
    mutex A
    mutex B
    task T1 locks A, B
    task T2 locks B, A
}`);
        expect(result).toEqual([
            'warning: Lock order A → B conflicts with B → … → A elsewhere: possible deadlock.',
            'warning: Lock order B → A conflicts with A → … → B elsewhere: possible deadlock.'
        ]);
    });

    test('profiles: AUTOSAR has ceiling resources and no semaphores, ISRs do not block', async () => {
        const result = await diagnostics(`
os O profile autosar {
    mutex M protocol inherit
    semaphore S
    event E
    task A waits E locks M takes S
    task B waits E
    isr I cat 2 sets E gives S locks M receives E
    isr Fast cat 1 sets E
}
os P profile zephyr { }`);
        expect(result).toEqual(expect.arrayContaining([
            "error: autosar resources use the priority ceiling protocol; 'inherit' is not available.",
            'error: autosar has no semaphores. Use an event for signalling or a mutex (resource) for mutual exclusion.',
            "error: In autosar an event belongs to one task; 'E' is waited for by A, B.",
            "error: An ISR must not block: 'receives' can wait.",
            "error: A category 1 ISR must not use OS objects; make 'Fast' 'cat 2'.",
            "error: Unknown OS profile 'zephyr'. Use one of: autosar, osek, threadx, freertos, generic."
        ]));
        // Category 2 ISRs may take AUTOSAR resources.
        expect(result.some(m => m.includes('cannot be locked from an ISR'))).toBe(false);
    });

    test('os view lists runnables, folds long lists and draws one edge per use', async () => {
        const runs = Array.from({ length: 12 }, (_, i) => `swc application S${i} { runnable R every 10ms }`).join('\n');
        const [view] = await render(`${runs}
os O {
    queue Q
    task T every 10ms runs ${Array.from({ length: 12 }, (_, i) => `S${i}.R`).join(', ')} sends Q sends Q
    isr I sets E
    event E
    task W receives Q waits E
}`);
        expect(view.id).toBe('O');
        expect(view.svg).not.toContain('layout failed');
        expect(view.svg).toContain('+ 5 more');
        expect(view.svg.match(/<title>T sends Q/g)).toHaveLength(1);
    });
});

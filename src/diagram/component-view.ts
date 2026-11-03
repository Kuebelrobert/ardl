/**
 * Component view: one SWC or BSW module with its ports and runnables.
 *
 * The component is a big box with its ports on the border (R-ports left,
 * P-ports right). Its runnables are rounded boxes inside, labeled with their
 * triggers, and connected to the ports they use. The arrows show the direction
 * of data or calls: a runnable that reads a port gets an arrow from the port,
 * a runnable that calls a client port gets an arrow towards the port.
 * Exclusive areas are hexagons inside the box, the lock symbol of the OS view,
 * with a dashed line from every runnable that enters them.
 *
 * Shape ids used in the ELK graph:
 * - `comp`              the component box,
 * - `port:<port>`       a port of the component,
 * - `r:<runnable>`      a runnable,
 * - `u:<runnable>:<port>` the use of a port by a runnable,
 * - `ea:<area>`         an exclusive area,
 * - `x:<runnable>:<area>` a runnable entering an exclusive area.
 */
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { isDataTrigger, isInitTrigger, isModeTrigger, isOperationTrigger, isTimingTrigger, type Bsw, type Port, type Runnable, type Swc } from '../language/generated/ast.js';
import { BASE_OPTIONS, layout } from './layout.js';
import { elkPort, labelWidths, renderPort } from './ports.js';
import { edgeSvg, esc, legend, r, svgDocument, text, textWidth } from './svg.js';

/** Height of the stereotype and name lines at the top of the component box. */
const HEADER = 46;

/**
 * How a runnable uses a port, derived from its triggers and accesses:
 * `reads`/`writes`/`calls`/`switches` from the accesses of the same name,
 * `serves` from `on call`, `mode` from `on mode` (and `on data` counts as `reads`).
 */
type Use = 'reads' | 'writes' | 'calls' | 'serves' | 'mode' | 'switches';

/** One edge of the view: a runnable using a port. */
interface UseEdge {
    id: string;
    runnable: Runnable;
    port: Port;
    use: Use;
}

/** Renders the component view as a standalone SVG document. */
export async function renderComponent(component: Swc | Bsw, title: string): Promise<string> {
    const { west, east } = labelWidths(component.ports);
    const uses = collectUses(component);

    // Runnable boxes are sized for the name line and the trigger line.
    const runnableNodes: ElkNode[] = component.runnables.map(run => ({
        id: `r:${run.name}`,
        width: Math.max(textWidth(run.name, 13), textWidth(triggerText(run), 11)) + 28,
        height: 40
    }));

    // Geometrically, every edge runs left to right (R-port → runnable → P-port), so the
    // layered layout stays clean. The semantic direction is shown by the arrowhead only.
    const edges: ElkExtendedEdge[] = uses.map(u => {
        const port = `port:${u.port.name}`;
        const run = `r:${u.runnable.name}`;
        const fromPort = u.port.direction === 'rport';
        return { id: u.id, sources: [fromPort ? port : run], targets: [fromPort ? run : port] };
    });
    const areaNodes: ElkNode[] = component.exclusiveAreas.map(area => ({
        id: `ea:${area.name}`,
        width: Math.max(textWidth(area.name, 13), textWidth('exclusive area', 11)) + 40,
        height: 40
    }));
    const enters = component.runnables.flatMap(run => [...new Set(run.enters.flatMap(e => e.ref ? [e.ref.name] : []))]
        .map(area => ({ id: `x:${run.name}:${area}`, run: run.name, area })));
    edges.push(...enters.map(e => ({ id: e.id, sources: [`r:${e.run}`], targets: [`ea:${e.area}`] })));

    const rows = Math.max(component.ports.filter(p => p.direction === 'rport').length, component.ports.filter(p => p.direction !== 'rport').length);
    const graph: ElkNode = {
        id: 'root',
        layoutOptions: {
            ...BASE_OPTIONS,
            'elk.direction': 'RIGHT',
            // Edges go from the component's own ports to its children.
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.padding': '[top=44,left=16,bottom=16,right=16]'
        },
        children: [{
            id: 'comp',
            children: [...runnableNodes, ...areaNodes],
            edges,
            ports: component.ports.map(port => elkPort(`port:${port.name}`, port)),
            layoutOptions: {
                'elk.portConstraints': 'FIXED_SIDE',
                // Room for the header on top and the port labels inside the box on both sides.
                'elk.padding': `[top=${HEADER + 8},left=${west + 40},bottom=20,right=${east + 40}]`,
                'elk.spacing.portsSurrounding': `[top=${HEADER},left=0,bottom=10,right=0]`,
                // Port labels sit above their port, so ports need a line of text between them.
                'elk.spacing.portPort': '24',
                // ELK grows the box around the runnables, but never below this size.
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': `(${Math.max(220, textWidth(component.name, 13) + 40)}, ${HEADER + rows * 26 + 20})`
            }
        }]
    };

    const laid = await layout(graph);
    const node = laid.nodes.get('comp')!;
    const cls = component.$type === 'Bsw' ? `layer-${component.layer}` : `kind-${component.kind}`;
    const kind = component.$type === 'Bsw' ? `bsw ${component.layer}` : component.kind;
    const cx = (node.x ?? 0) + (node.width ?? 0) / 2;

    // Paint order: component box, runnables, edges, ports (so ports cover edge ends).
    const parts: string[] = [
        text(16, 26, title, 'title'),
        `<rect x="${r(node.x)}" y="${r(node.y)}" width="${r(node.width)}" height="${r(node.height)}" rx="4" class="box ${cls}"/>`,
        text(cx, (node.y ?? 0) + 18, `«${kind}»`, 'stereo', 'middle'),
        text(cx, (node.y ?? 0) + 35, component.name, 'name', 'middle')
    ];

    for (const run of component.runnables) {
        const n = laid.nodes.get(`r:${run.name}`)!;
        const rx = (n.x ?? 0) + (n.width ?? 0) / 2;
        parts.push(`<g class="node"><title>${esc(`runnable ${run.name}: ${triggerText(run)}`)}</title>`
            + `<rect x="${r(n.x)}" y="${r(n.y)}" width="${r(n.width)}" height="${r(n.height)}" rx="12" class="runnable"/>`
            + text(rx, (n.y ?? 0) + 17, run.name, 'name', 'middle')
            + text(rx, (n.y ?? 0) + 32, triggerText(run), 'muted', 'middle')
            + '</g>');
    }

    for (const e of enters) {
        const edge = laid.edges.get(e.id);
        if (edge) parts.push(edgeSvg(edge, 'os-mutex', 'none', `${e.run} enters ${e.area}`));
    }
    for (const area of component.exclusiveAreas) {
        const n = laid.nodes.get(`ea:${area.name}`)!;
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        const w = n.width ?? 0;
        const h = n.height ?? 0;
        parts.push(`<g class="node"><title>${esc(`exclusive area ${area.name}`)}</title>`
            + `<path d="M${r(x + 10)} ${r(y)} L${r(x + w - 10)} ${r(y)} L${r(x + w)} ${r(y + h / 2)} L${r(x + w - 10)} ${r(y + h)} L${r(x + 10)} ${r(y + h)} L${r(x)} ${r(y + h / 2)} Z" class="os-object os-mutex"/>`
            + text(x + w / 2, y + 17, area.name, 'name', 'middle')
            + text(x + w / 2, y + 32, 'exclusive area', 'muted', 'middle')
            + '</g>');
    }

    for (const u of uses) {
        const edge = laid.edges.get(u.id);
        if (!edge) {
            continue;
        }
        const kind = u.port.interface.ref?.kind ?? 'unknown';
        // The arrow points where the data or the call goes. Reads, mode switches and
        // served calls arrive at the runnable; writes, calls and switches leave it.
        // Combined with the geometric direction of the edge, that decides the end.
        const towardsRunnable = u.use === 'reads' || u.use === 'mode' || u.use === 'serves';
        const fromPort = u.port.direction === 'rport';
        const arrowAtEnd = towardsRunnable === fromPort;
        parts.push(edgeSvg(edge, `k-${kind}`, arrowAtEnd ? 'end' : 'start', `${u.runnable.name} ${u.use} ${u.port.name}`, laid.ports));
    }

    for (const port of component.ports) {
        parts.push(renderPort(laid.ports.get(`port:${port.name}`)!, port, true, true));
    }

    const height = laid.root.height ?? 0;
    const lg = legend(16, height + 4);
    parts.push(lg.svg);
    return svgDocument(Math.max(laid.root.width ?? 0, 760), height + lg.height + 16, parts.join(''), title);
}

/**
 * All (runnable, port) pairs of the component with how the runnable uses the
 * port. A runnable that both triggers on and reads a port (`on data X reads X`)
 * yields one edge; the first use found wins.
 */
function collectUses(component: Swc | Bsw): UseEdge[] {
    const result = new Map<string, UseEdge>();
    const add = (runnable: Runnable, port: Port | undefined, use: Use) => {
        if (port) {
            const id = `u:${runnable.name}:${port.name}`;
            if (!result.has(id)) {
                result.set(id, { id, runnable, port, use });
            }
        }
    };
    for (const run of component.runnables) {
        for (const t of run.triggers) {
            if (isDataTrigger(t)) add(run, t.port.ref, 'reads');
            else if (isOperationTrigger(t)) add(run, t.port.ref, 'serves');
            else if (isModeTrigger(t)) add(run, t.port.ref, 'mode');
        }
        for (const access of run.accesses) {
            for (const ref of access.ports) {
                add(run, ref.ref, access.kind);
            }
        }
    }
    return [...result.values()];
}

/**
 * Second line of a runnable box, e.g. `every 10ms, on mode`. Port names are
 * left out to keep the box narrow; the edges show which port triggers it.
 */
function triggerText(run: Runnable): string {
    const parts = run.triggers.map(t => {
        if (isTimingTrigger(t)) return `every ${t.period}`;
        if (isInitTrigger(t)) return 'on init';
        if (isDataTrigger(t)) return 'on data';
        if (isOperationTrigger(t)) return 'on call';
        if (isModeTrigger(t)) return 'on mode';
        return '';
    });
    return parts.length ? parts.join(', ') : 'no trigger';
}

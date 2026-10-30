/**
 * OS view: tasks and ISRs of one `os` with the objects they share.
 *
 * Tasks and ISRs are boxes with their scheduling attributes and the runnables
 * mapped to them. OS objects get a shape of their own: a hexagon for a mutex,
 * a pill for a semaphore, a box with slots for a queue and a flag for an event.
 * Edges follow the flow of data or signals, so ELK puts producers left of an
 * object and consumers right of it: `sends` and `receives` run through a queue,
 * `sets` and `waits` through an event, `gives` and `takes` through a semaphore.
 * `locks` is a plain line from the task to the mutex.
 *
 * Large ECUs map hundreds of runnables to a handful of tasks, so a task box
 * lists only the first few and the hover tooltip has the full list.
 *
 * Shape ids used in the ELK graph: `t:<task or isr>`, `o:<object>`,
 * `e:<user>:<access>:<object>`.
 */
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Isr, Os, OsAccessKind, OsObject, Task } from '../language/generated/ast.js';
import { mutexProtocol } from '../language/ardl-semantics.js';
import { BASE_OPTIONS, layout } from './layout.js';
import { edgeSvg, esc, r, svgDocument, text, textWidth } from './svg.js';

/** Runnables listed in a task box before the rest is folded into "+ n more". */
const MAX_RUNNABLES = 8;
/** Line height of the runnable list. */
const LINE = 15;
/** Height of the name and attribute lines at the top of a task box. */
const TASK_HEADER = 40;
/** Size of the object shapes, apart from the width that grows with the name. */
const OBJECT_HEIGHT = 40;

/** One edge of the view: a task or ISR using an object. */
interface UseEdge {
    id: string;
    user: Task | Isr;
    object: OsObject;
    kind: OsAccessKind;
}

/** Accesses whose edge goes from the object to the task: the task consumes what the object holds. */
const CONSUMES: readonly OsAccessKind[] = ['receives', 'waits', 'takes'];

/** Renders the OS view as a standalone SVG document. */
export async function renderOs(os: Os, title: string): Promise<string> {
    const users: Array<Task | Isr> = [...os.tasks, ...os.isrs];
    const uses = collectUses(users);
    const objectNames = new Set(os.objects.map(o => o.name));

    const userNodes: ElkNode[] = users.map(u => {
        const lines = runnableLines(u);
        const width = Math.max(textWidth(u.name, 13), textWidth(attributeText(u), 11), ...lines.map(l => textWidth(l, 11))) + 24;
        return { id: `t:${u.name}`, width: Math.max(width, 120), height: TASK_HEADER + lines.length * LINE + (lines.length ? 6 : 0) };
    });
    const objectNodes: ElkNode[] = os.objects.map(o => ({
        id: `o:${o.name}`,
        width: Math.max(textWidth(o.name, 13), textWidth(objectDetail(o), 11)) + 40,
        height: OBJECT_HEIGHT
    }));
    // Consumers sit right of the object, everyone else left of it.
    const edges: ElkExtendedEdge[] = uses
        .filter(u => objectNames.has(u.object.name))
        .map(u => CONSUMES.includes(u.kind)
            ? { id: u.id, sources: [`o:${u.object.name}`], targets: [`t:${u.user.name}`] }
            : { id: u.id, sources: [`t:${u.user.name}`], targets: [`o:${u.object.name}`] });

    const laid = await layout({
        id: 'root',
        layoutOptions: {
            ...BASE_OPTIONS,
            'elk.direction': 'RIGHT',
            'elk.padding': '[top=44,left=16,bottom=16,right=16]'
        },
        children: [...userNodes, ...objectNodes],
        edges
    });

    const parts: string[] = [text(16, 26, title, 'title')];
    for (const u of users) {
        parts.push(renderUser(laid.nodes.get(`t:${u.name}`)!, u));
    }
    for (const u of uses) {
        const edge = laid.edges.get(u.id);
        if (edge) {
            // Locks have no direction; every other edge points along the flow.
            parts.push(edgeSvg(edge, `os-${u.object.$type.toLowerCase()}`, u.kind === 'locks' ? 'none' : 'end', `${u.user.name} ${u.kind} ${u.object.name}`));
        }
    }
    for (const o of os.objects) {
        parts.push(renderObject(laid.nodes.get(`o:${o.name}`)!, o));
    }

    const height = laid.root.height ?? 0;
    const lg = osLegend(16, height + 4);
    parts.push(lg.svg);
    return svgDocument(Math.max(laid.root.width ?? 0, 640), height + lg.height + 16, parts.join(''), title);
}

/** One edge per distinct (user, access, object); `locks A, B` twice in one task is still one edge per mutex. */
function collectUses(users: Array<Task | Isr>): UseEdge[] {
    const result = new Map<string, UseEdge>();
    for (const user of users) {
        for (const access of user.accesses) {
            for (const ref of access.objects) {
                const object = ref.ref;
                const id = `e:${user.name}:${access.kind}:${object?.name}`;
                if (object && !result.has(id)) {
                    result.set(id, { id, user, object, kind: access.kind });
                }
            }
        }
    }
    return [...result.values()];
}

/** Second line of a task or ISR box, e.g. `prio 10 · every 10ms · core 0`. */
function attributeText(u: Task | Isr): string {
    const parts: string[] = [];
    if (u.$type === 'Isr') parts.push(u.cat ? `ISR cat ${u.cat}` : 'ISR');
    if (u.priority !== undefined) parts.push(`prio ${u.priority}`);
    if (u.$type === 'Task' && u.period) parts.push(`every ${u.period}`);
    if (u.$type === 'Task' && u.startup) parts.push('on startup');
    if (u.core !== undefined) parts.push(`core ${u.core}`);
    return parts.join(' · ');
}

/** The mapped runnables as `Swc.Runnable`, cut to {@link MAX_RUNNABLES} lines. */
function runnableLines(u: Task | Isr): string[] {
    if (u.$type !== 'Task') {
        return [];
    }
    const all = u.runs.map(ref => `${ref.component.$refText}.${ref.runnable.$refText}`);
    return all.length > MAX_RUNNABLES ? [...all.slice(0, MAX_RUNNABLES - 1), `+ ${all.length - MAX_RUNNABLES + 1} more`] : all;
}

function renderUser(n: ElkNode, u: Task | Isr): string {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const lines = runnableLines(u);
    const all = u.$type === 'Task' ? u.runs.map(ref => `${ref.component.$refText}.${ref.runnable.$refText}`) : [];
    const tooltip = `${u.$type === 'Isr' ? 'isr' : 'task'} ${u.name}${all.length ? `\n${all.join('\n')}` : ''}`;
    let body = `<rect x="${r(x)}" y="${r(y)}" width="${r(n.width)}" height="${r(n.height)}" rx="4" class="box ${u.$type === 'Isr' ? 'os-isr' : 'os-task'}"/>`
        + text(x + 10, y + 17, u.name, 'name')
        + text(x + 10, y + 32, attributeText(u), 'muted');
    if (lines.length) {
        body += `<line x1="${r(x)}" y1="${r(y + TASK_HEADER)}" x2="${r(x + (n.width ?? 0))}" y2="${r(y + TASK_HEADER)}" class="os-divider"/>`;
        lines.forEach((line, i) => {
            body += text(x + 10, y + TASK_HEADER + 14 + i * LINE, line, i === MAX_RUNNABLES - 1 && all.length > MAX_RUNNABLES ? 'muted' : 'runs');
        });
    }
    return `<g class="node"><title>${esc(tooltip)}</title>${body}</g>`;
}

/** Second line of an object shape: protocol, count or queue type and depth. */
function objectDetail(o: OsObject): string {
    switch (o.$type) {
        case 'Mutex': return `mutex · ${mutexProtocol(o)}`;
        case 'Semaphore': return `semaphore${o.count !== undefined ? ` · ${o.count}` : ''}`;
        case 'Queue': return ['queue', o.type, o.depth !== undefined ? `depth ${o.depth}` : undefined].filter(Boolean).join(' · ');
        case 'Event': return 'event';
    }
}

/** The outline of an object: hexagon, pill, box with slots or flag, depending on the kind. */
function objectShape(o: OsObject, x: number, y: number, w: number, h: number): string {
    const cls = `os-object os-${o.$type.toLowerCase()}`;
    switch (o.$type) {
        case 'Mutex': {
            const c = 10;
            return `<path d="M${r(x + c)} ${r(y)} L${r(x + w - c)} ${r(y)} L${r(x + w)} ${r(y + h / 2)} L${r(x + w - c)} ${r(y + h)} L${r(x + c)} ${r(y + h)} L${r(x)} ${r(y + h / 2)} Z" class="${cls}"/>`;
        }
        case 'Semaphore':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(h / 2)}" class="${cls}"/>`;
        case 'Queue': {
            // Three message slots on the right end.
            const slots = [10, 16, 22].map(d => `<line x1="${r(x + w - d)}" y1="${r(y)}" x2="${r(x + w - d)}" y2="${r(y + h)}" class="os-slot"/>`).join('');
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="2" class="${cls}"/>${slots}`;
        }
        case 'Event':
            return `<path d="M${r(x)} ${r(y)} L${r(x + w - 10)} ${r(y)} L${r(x + w)} ${r(y + h / 2)} L${r(x + w - 10)} ${r(y + h)} L${r(x)} ${r(y + h)} Z" class="${cls}"/>`;
    }
}

function renderObject(n: ElkNode, o: OsObject): string {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = n.width ?? 0;
    const cx = x + (o.$type === 'Queue' ? (w - 22) / 2 : w / 2);
    return `<g class="node"><title>${esc(`${objectDetail(o)} ${o.name}`)}</title>`
        + objectShape(o, x, y, w, n.height ?? 0)
        + text(cx, y + 17, o.name, 'name', 'middle')
        + text(cx, y + 32, objectDetail(o), 'muted', 'middle')
        + '</g>';
}

/** One-line legend of the object shapes. */
function osLegend(x: number, y: number): { svg: string; height: number } {
    const items: Array<[OsObject['$type'], string]> = [['Mutex', 'Mutex'], ['Semaphore', 'Semaphore'], ['Queue', 'Queue'], ['Event', 'Event']];
    let cx = x;
    const parts = items.map(([type, label]) => {
        const shape = objectShape({ $type: type } as OsObject, cx, y, 34, 14);
        const t = text(cx + 40, y + 11, label, 'muted');
        cx += 40 + textWidth(label, 11) + 20;
        return shape + t;
    });
    return { svg: `<g class="legend">${parts.join('')}</g>`, height: 18 };
}

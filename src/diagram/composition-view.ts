/**
 * Composition view: the internal structure of one composition.
 *
 * Shows the composition as a dashed boundary with its own (delegation) ports,
 * one box per prototype with the ports of its component type, and one edge per
 * connector. ELK lays out the prototypes left to right along the data flow.
 *
 * Shape ids used in the ELK graph:
 * - `c`               the composition boundary,
 * - `c:<port>`        a port of the composition itself,
 * - `p:<proto>`       a prototype box,
 * - `p:<proto>:<port>` a port of a prototype,
 * - `e<i>`            the i-th connector of the composition.
 */
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Composition, PortRef, Prototype } from '../language/generated/ast.js';
import { BASE_OPTIONS, layout } from './layout.js';
import { elkPort, labelWidths, renderPort } from './ports.js';
import { edgeSvg, esc, legend, r, svgDocument, text, textWidth } from './svg.js';

/** Height of the stereotype and name lines at the top of a prototype box. */
const HEADER = 40;
/** Vertical room per port row inside a prototype box. */
const PORT_ROW = 22;

/** Name of a prototype; unnamed prototypes are named after their type. */
const protoName = (p: Prototype) => p.name ?? p.type.$refText;
const protoId = (p: Prototype) => `p:${protoName(p)}`;
/** ELK port id of a connector end. Only call it for ends that {@link renderComposition} found resolved. */
const refId = (ref: PortRef) => ref.prototype ? `${protoId(ref.prototype.ref!)}:${ref.port.$refText}` : `c:${ref.port.$refText}`;

/**
 * Renders the composition view as a standalone SVG document.
 * Prototypes, connectors and ports with unresolved references are left out,
 * so the view stays usable while the model is being edited.
 */
export async function renderComposition(composition: Composition, title: string): Promise<string> {
    const prototypes = composition.prototypes.filter(p => p.type.ref);
    const outer = labelWidths(composition.ports);

    // One ELK node per prototype. The box is sized for its name, its stereotype
    // and the port labels on both sides; ELK only places it.
    const children: ElkNode[] = prototypes.map(proto => {
        const type = proto.type.ref!;
        const ports = type.ports;
        const { west, east } = labelWidths(ports);
        const rows = Math.max(ports.filter(p => p.direction === 'rport').length, ports.filter(p => p.direction !== 'rport').length);
        return {
            id: protoId(proto),
            width: Math.max(130, textWidth(protoName(proto), 13) + 32, textWidth(stereotype(proto), 11) + 32, west + east + 48),
            height: HEADER + Math.max(1, rows) * PORT_ROW + 6,
            ports: ports.map(port => elkPort(`${protoId(proto)}:${port.name}`, port)),
            layoutOptions: {
                'elk.portConstraints': 'FIXED_SIDE',
                // Keep ports below the header lines.
                'elk.spacing.portsSurrounding': `[top=${HEADER},left=0,bottom=6,right=0]`
            }
        };
    });

    // One edge per connector whose ends are fully resolved. The index in the
    // connector list is the id, so the renderer can match edges back to connectors.
    const resolved = (ref: PortRef) => ref.port.ref !== undefined && (!ref.prototype || ref.prototype.ref?.type.ref !== undefined);
    const edges: ElkExtendedEdge[] = composition.connectors.flatMap((c, i) => resolved(c.source) && resolved(c.target)
        ? [{ id: `e${i}`, sources: [refId(c.source)], targets: [refId(c.target)] }]
        : []);

    // Root → composition boundary → prototypes. Delegation edges connect a
    // boundary port with a prototype port, so ELK has to lay out across the
    // hierarchy levels (INCLUDE_CHILDREN).
    const graph: ElkNode = {
        id: 'root',
        layoutOptions: {
            ...BASE_OPTIONS,
            'elk.direction': 'RIGHT',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            // Room for the title on top and for the boundary port labels outside the box.
            'elk.padding': `[top=44,left=${outer.west + 24},bottom=16,right=${outer.east + 24}]`
        },
        children: [{
            id: 'c',
            children,
            edges,
            ports: composition.ports.map(port => elkPort(`c:${port.name}`, port)),
            layoutOptions: {
                'elk.portConstraints': 'FIXED_SIDE',
                // Room for «composition» and the name in the top left corner.
                'elk.padding': '[top=48,left=36,bottom=28,right=36]',
                'elk.spacing.portsSurrounding': '[top=48,left=0,bottom=20,right=0]'
            }
        }]
    };

    const laid = await layout(graph);
    const parts: string[] = [text(16, 26, title, 'title')];

    // Paint order: boundary, prototype boxes with their ports, connectors, boundary ports.
    const c = laid.nodes.get('c')!;
    parts.push(`<rect x="${r(c.x)}" y="${r(c.y)}" width="${r(c.width)}" height="${r(c.height)}" rx="6" class="composition"/>`);
    parts.push(text((c.x ?? 0) + 12, (c.y ?? 0) + 18, '«composition»', 'stereo'));
    parts.push(text((c.x ?? 0) + 12, (c.y ?? 0) + 34, composition.name, 'name'));

    for (const proto of prototypes) {
        const node = laid.nodes.get(protoId(proto))!;
        const type = proto.type.ref!;
        // Box color by component kind: SWC kind, BSW layer, or nested composition.
        const cls = type.$type === 'Bsw' ? `layer-${type.layer}` : type.$type === 'Swc' ? `kind-${type.kind}` : 'kind-composition';
        const cx = (node.x ?? 0) + (node.width ?? 0) / 2;
        parts.push(`<g class="node"><title>${esc(`${protoName(proto)} : ${type.name}`)}</title>`
            + `<rect x="${r(node.x)}" y="${r(node.y)}" width="${r(node.width)}" height="${r(node.height)}" rx="4" class="box ${cls}"/>`
            + text(cx, (node.y ?? 0) + 16, stereotype(proto), 'stereo', 'middle')
            + text(cx, (node.y ?? 0) + 32, protoName(proto), 'name', 'middle')
            + '</g>');
        for (const port of type.ports) {
            parts.push(renderPort(laid.ports.get(`${protoId(proto)}:${port.name}`)!, port, true));
        }
    }

    composition.connectors.forEach((connector, i) => {
        const edge = laid.edges.get(`e${i}`);
        if (!edge) {
            return;
        }
        const iface = connector.source.port.ref?.interface.ref;
        const kind = iface?.kind ?? 'unknown';
        const tip = `${label(connector.source)} → ${label(connector.target)} : ${iface?.name ?? '?'}`;
        // Data connectors get an arrow in the data direction. A client-server connector
        // runs from server to client, which is the opposite of the call, so it gets none.
        parts.push(edgeSvg(edge, `k-${kind}`, kind === 'cs' ? 'none' : 'end', tip, laid.ports));
    });

    for (const port of composition.ports) {
        parts.push(renderPort(laid.ports.get(`c:${port.name}`)!, port, false));
    }

    const height = laid.root.height ?? 0;
    const lg = legend(16, height + 4);
    parts.push(lg.svg);
    // At least as wide as the legend.
    const width = Math.max(laid.root.width ?? 0, 760);
    return svgDocument(width, height + lg.height + 16, parts.join(''), title);
}

/**
 * Stereotype line of a prototype box, e.g. `«application»`, or
 * `«bsw services» : NvM` when the prototype name differs from its type.
 */
function stereotype(proto: Prototype): string {
    const type = proto.type.ref;
    if (!type) {
        return '';
    }
    const kind = type.$type === 'Swc' ? type.kind : type.$type === 'Bsw' ? `bsw ${type.layer}` : 'composition';
    return proto.name && proto.name !== type.name ? `«${kind}» : ${type.name}` : `«${kind}»`;
}

/** Connector end as written in the source, for tooltips. */
function label(ref: PortRef): string {
    return ref.prototype ? `${ref.prototype.$refText}.${ref.port.$refText}` : ref.port.$refText;
}

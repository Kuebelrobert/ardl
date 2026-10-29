/**
 * Layers view: BSW modules in the bands of the AUTOSAR layered architecture.
 *
 * From top to bottom: RTE, services, ECU abstraction, microcontroller
 * abstraction (MCAL). Complex drivers get a column on the right that spans the
 * layers. Edges are the `uses` dependencies, pointing to the used module;
 * upward dependencies (a layering violation) are drawn red and dashed.
 *
 * ELK does the layout top to bottom. Two tricks make it respect the bands:
 *
 * 1. Anchor nodes. ELK's own partitioning option does not keep partitions in
 *    separate layers (tested with elkjs 0.12), so the view adds invisible,
 *    zero-sized anchor nodes and hidden edges
 *    `anchor[p] → every module of band p → anchor[p + 1]`.
 *    A module of band p is then always below all modules of band p - 1.
 * 2. Edge ports. With `mergeEdges` ELK routes all hidden edges of an anchor
 *    on one track, which keeps the gaps between bands small. Real edges get
 *    their own ports, which prevents ELK from merging them and making two
 *    unrelated dependencies look like one.
 */
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Bsw, BswLayer } from '../language/generated/ast.js';
import { isUpwardDependency } from '../language/ardl-semantics.js';
import { BASE_OPTIONS, layout } from './layout.js';
import { edgeSvg, esc, r, svgDocument, text, textWidth } from './svg.js';

/** Bands from top to bottom, with their labels. Complex drivers are handled separately. */
const ROWS: Array<{ layer: BswLayer; label: string }> = [
    { layer: 'services', label: 'Services' },
    { layer: 'ecual', label: 'ECU Abstraction' },
    { layer: 'mcal', label: 'Microcontroller Abstraction' }
];

/**
 * Band index per layer, top = 0. Complex drivers share the middle band in the
 * layout and are moved into their own column only when they are drawn.
 */
const PARTITION: Record<BswLayer, number> = { services: 0, ecual: 1, mcal: 2, cdd: 1 };

/** Width reserved on the left for the band labels. */
const LABEL_COLUMN = 200;
/** Space between a band's border and the modules in it. */
const BAND_PAD = 12;
/** Height of the RTE band on top. */
const RTE_HEIGHT = 30;

/** Renders the layers view of `modules` as a standalone SVG document. */
export async function renderLayers(modules: Bsw[], title: string): Promise<string> {
    // Collect one edge per distinct dependency between modules shown in this view.
    const names = new Set(modules.map(m => m.name));
    const edges: ElkExtendedEdge[] = [];
    const ids = new Set<string>();
    // Layering violations (drawn red) and edges reversed for the layout (arrow at the start).
    // Not the same: a complex driver using a service is reversed, but legal.
    const upward = new Set<string>();
    const reversed = new Set<string>();
    for (const m of modules) {
        for (const ref of m.uses) {
            const used = ref.ref;
            const id = `${m.name}->${used?.name}`;
            // Skip unresolved references, modules not in this view, self-uses
            // (reported by the validator) and repeated entries like `uses Can, Can`.
            if (!used || !names.has(used.name) || used === m || ids.has(id)) {
                continue;
            }
            ids.add(id);
            if (isUpwardDependency(m, used)) {
                upward.add(id);
            }
            // The anchors force band order, so every edge must point down in the
            // layout. Edges that point up between bands are reversed for ELK and get
            // their arrowhead at the start when drawn, which keeps the meaning.
            if (PARTITION[used.layer] < PARTITION[m.layer]) {
                reversed.add(id);
                edges.push({ id, sources: [used.name], targets: [m.name] });
            } else {
                edges.push({ id, sources: [m.name], targets: [used.name] });
            }
        }
    }

    // Complex drivers last in the model order, which puts them on the right.
    const ordered = [...modules.filter(m => m.layer !== 'cdd'), ...modules.filter(m => m.layer === 'cdd')];
    const anchors: ElkNode[] = [0, 1, 2, 3].map(p => ({ id: `__anchor${p}`, width: 0, height: 0 }));
    const hidden: ElkExtendedEdge[] = ordered.flatMap(m => [
        { id: `__in:${m.name}`, sources: [`__anchor${PARTITION[m.layer]}`], targets: [m.name] },
        { id: `__out:${m.name}`, sources: [m.name], targets: [`__anchor${PARTITION[m.layer] + 1}`] }
    ]);

    const graph: ElkNode = {
        id: 'root',
        layoutOptions: {
            ...BASE_OPTIONS,
            'elk.direction': 'DOWN',
            'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',
            // One track per anchor instead of one per hidden edge (see file comment).
            'elk.layered.mergeEdges': 'true',
            'elk.layered.spacing.nodeNodeBetweenLayers': '30',
            'elk.spacing.nodeNode': '22',
            // Room for the title and the RTE band on top, and the band labels on the left.
            'elk.padding': `[top=${16 + RTE_HEIGHT},left=${LABEL_COLUMN + BAND_PAD},bottom=${BAND_PAD},right=${BAND_PAD + 12}]`
        },
        children: [
            ...ordered.map(m => ({
                id: m.name,
                width: Math.max(74, textWidth(m.name, 13) + 28),
                height: 36,
                // One zero-sized port per edge end, so real edges are never merged (see file comment).
                ports: edges.flatMap(e => [
                    ...(e.sources[0] === m.name ? [{ id: `${e.id}:s`, width: 0, height: 0 }] : []),
                    ...(e.targets[0] === m.name ? [{ id: `${e.id}:t`, width: 0, height: 0 }] : [])
                ])
            })),
            ...anchors
        ],
        edges: [...edges.map(e => ({ id: e.id, sources: [`${e.id}:s`], targets: [`${e.id}:t`] })), ...hidden]
    };

    const laid = await layout(graph);
    const width = laid.root.width ?? 0;
    const height = laid.root.height ?? 0;
    const parts: string[] = [text(16, 26, title, 'title')];

    const boxes = (layer: BswLayer) => modules.filter(m => m.layer === layer).map(m => laid.nodes.get(m.name)!);
    const cdd = boxes('cdd');
    const others = modules.filter(m => m.layer !== 'cdd').map(m => laid.nodes.get(m.name)!);
    const cddLeft = Math.min(...cdd.map(n => n.x ?? 0)) - BAND_PAD;
    const othersRight = Math.max(0, ...others.map(n => (n.x ?? 0) + (n.width ?? 0)));
    // A full-height column only works if every complex driver ended up right of all
    // other modules. Otherwise each complex driver is framed on its own.
    const cddColumn = cdd.length > 0 && othersRight + 10 < cddLeft;
    const bandRight = cddColumn ? cddLeft - 10 : width - BAND_PAD;

    // Bands are drawn behind the modules, sized to the modules ELK put in them.
    let top = Infinity;
    let bottom = 0;
    for (const row of ROWS) {
        const nodes = boxes(row.layer);
        if (nodes.length === 0) {
            continue;
        }
        const y0 = Math.min(...nodes.map(n => n.y ?? 0)) - BAND_PAD;
        const y1 = Math.max(...nodes.map(n => (n.y ?? 0) + (n.height ?? 0))) + BAND_PAD;
        top = Math.min(top, y0);
        bottom = Math.max(bottom, y1);
        parts.push(`<rect x="16" y="${r(y0)}" width="${r(bandRight - 16)}" height="${r(y1 - y0)}" rx="6" class="band layer-${row.layer}"/>`);
        parts.push(text(28, (y0 + y1) / 2 + 4, row.label, 'band-label'));
    }
    if (!Number.isFinite(top)) {
        // Only complex drivers (or nothing at all): fall back to a nominal band area.
        top = 56 + RTE_HEIGHT + BAND_PAD;
        bottom = top + 40;
    }
    if (cddColumn) {
        parts.push(`<rect x="${r(cddLeft)}" y="${r(top)}" width="${r(width - BAND_PAD - cddLeft)}" height="${r(bottom - top)}" rx="6" class="band layer-cdd"/>`);
        parts.push(text((cddLeft + width - BAND_PAD) / 2, top + 18, 'Complex Drivers', 'band-label', 'middle'));
    } else {
        for (const n of cdd) {
            parts.push(`<rect x="${r((n.x ?? 0) - 8)}" y="${r((n.y ?? 0) - 20)}" width="${r((n.width ?? 0) + 16)}" height="${r((n.height ?? 0) + 28)}" rx="6" class="band layer-cdd"/>`);
            parts.push(text((n.x ?? 0) + (n.width ?? 0) / 2, (n.y ?? 0) - 7, 'CDD', 'band-label', 'middle'));
        }
    }
    // The RTE band is context only: the modules below provide the services the RTE calls.
    parts.push(`<rect x="16" y="${r(top - RTE_HEIGHT - 8)}" width="${r(width - BAND_PAD - 16)}" height="${RTE_HEIGHT}" rx="6" class="band-rte"/>`);
    parts.push(text((16 + width - BAND_PAD) / 2, top - RTE_HEIGHT / 2 - 3, 'Runtime Environment (RTE)', 'band-label', 'middle'));

    for (const edge of edges) {
        const laidEdge = laid.edges.get(edge.id);
        if (!laidEdge) {
            continue;
        }
        const up = upward.has(edge.id);
        const tip = `${edge.id.replace('->', ' uses ')}${up ? ' (upward dependency)' : ''}`;
        // The arrow always points at the used module, whichever way the edge was laid out.
        parts.push(edgeSvg(laidEdge, up ? 'upward' : '', reversed.has(edge.id) ? 'start' : 'end', tip));
    }

    for (const m of modules) {
        const n = laid.nodes.get(m.name)!;
        const tip = `${m.name} (${m.layer})${m.uses.length ? ' uses ' + m.uses.map(u => u.$refText).join(', ') : ''}`;
        parts.push(`<g class="node"><title>${esc(tip)}</title>`
            + `<rect x="${r(n.x)}" y="${r(n.y)}" width="${r(n.width)}" height="${r(n.height)}" rx="4" class="box layer-${m.layer}"/>`
            + text((n.x ?? 0) + (n.width ?? 0) / 2, (n.y ?? 0) + 22, m.name, 'name', 'middle')
            + '</g>');
    }

    return svgDocument(width, Math.max(height, bottom + BAND_PAD), parts.join(''), title);
}

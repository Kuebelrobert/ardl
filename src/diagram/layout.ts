/**
 * Thin wrapper around elkjs, the JavaScript build of the Eclipse Layout Kernel.
 *
 * Every view builds an ELK graph (nodes, ports, edges with sizes but without
 * positions), lets ELK's layered algorithm place everything, and renders the
 * result to SVG. ELK is used because it supports ports natively: a port can be
 * pinned to a side of its node, which is exactly what AUTOSAR diagrams need
 * (R-ports left, P-ports right).
 */
import ElkBundled from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkInstance, ELKConstructorArguments, ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api.js';

// elkjs is CommonJS, but its typings declare an ES default export. Depending on
// the bundler/loader the constructor arrives as the module itself or as its
// `default` property; accept both.
const ELK = ((ElkBundled as { default?: unknown }).default ?? ElkBundled) as new (args?: ELKConstructorArguments) => ElkInstance;

// The bundled build runs the layout in-process (no web worker), which works in
// Node and needs no extra file next to the bundle. One instance is enough.
const elk = new ELK();

/**
 * Options shared by every view. Each view adds its own (direction, padding, ...).
 * See https://eclipse.dev/elk/reference.html for the full list.
 */
export const BASE_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.edgeRouting': 'ORTHOGONAL',
    // Return all coordinates relative to the root instead of the parent node,
    // so renderers can draw nested nodes, ports and edges without adding offsets.
    'elk.json.shapeCoords': 'ROOT',
    'elk.json.edgeCoords': 'ROOT',
    // Straighter edges than the default node placement.
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    // Keep the order of the source text where possible, so small edits do not
    // reshuffle the whole diagram.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.spacing.nodeNode': '28',
    'elk.layered.spacing.nodeNodeBetweenLayers': '60',
    'elk.spacing.edgeEdge': '10',
    'elk.layered.spacing.edgeNodeBetweenLayers': '20'
};

/** A laid-out graph with lookup tables, so renderers can find shapes by the ids they assigned. */
export interface LaidOut {
    root: ElkNode;
    nodes: Map<string, ElkNode>;
    ports: Map<string, ElkPort>;
    edges: Map<string, ElkExtendedEdge>;
}

/**
 * Runs the layout and indexes the result. Throws if ELK rejects the graph
 * (e.g. duplicate ids from a model with duplicate names); callers catch that
 * and show an error diagram instead.
 */
export async function layout(graph: ElkNode): Promise<LaidOut> {
    const root = await elk.layout(graph);
    const nodes = new Map<string, ElkNode>();
    const ports = new Map<string, ElkPort>();
    const edges = new Map<string, ElkExtendedEdge>();
    const visit = (node: ElkNode) => {
        nodes.set(node.id, node);
        node.ports?.forEach(p => ports.set(p.id, p));
        node.edges?.forEach(e => edges.set(e.id, e));
        node.children?.forEach(visit);
    };
    visit(root);
    return { root, nodes, ports, edges };
}

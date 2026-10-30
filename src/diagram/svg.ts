/**
 * SVG building blocks shared by all views: text, port symbols, edges with
 * arrowheads, the legend and the document wrapper with its stylesheet.
 *
 * Everything is plain string concatenation. The output has to work in three
 * places: inline in the VS Code webview, as a standalone `.svg` file, and in
 * other tools (browsers, Quick Look, Inkscape). That rules out features with
 * patchy support such as `context-stroke` markers, so arrowheads are drawn as
 * polygons and every color is a CSS class.
 */
import type { ElkExtendedEdge, ElkPort } from 'elkjs/lib/elk-api.js';
import type { InterfaceKind, PortDirection } from '../language/generated/ast.js';

/** Edge length of the square port symbol, in px. */
export const PORT_SIZE = 12;

/** Default font size of diagram text, in px. Must match `.ardl` in {@link STYLE}. */
export const FONT = 12;

/**
 * Estimates the width of `text` in a sans-serif font. There is no canvas to
 * measure text when rendering in Node, and 0.6 × font size per character is
 * a slightly generous average, so boxes are never too narrow.
 */
export function textWidth(text: string, size = FONT): number {
    return Math.ceil(text.length * size * 0.6);
}

/** Escapes text for use in SVG content and attribute values. Every model string goes through here. */
export function esc(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A `<text>` element; `y` is the baseline. */
export function text(x: number, y: number, content: string, cls = '', anchor: 'start' | 'middle' | 'end' = 'start'): string {
    return `<text x="${r(x)}" y="${r(y)}" class="${cls}" text-anchor="${anchor}">${esc(content)}</text>`;
}

/** Rounds a coordinate to 0.1 px to keep the SVG small; missing ELK coordinates count as 0. */
export function r(n: number | undefined): number {
    return Math.round((n ?? 0) * 10) / 10;
}

/**
 * Port symbol: a small square centered on the box border with a glyph that
 * shows the interface kind and the direction (AUTOSAR-like notation):
 *
 * - sender-receiver, NV, parameter: triangle pointing in the data direction
 *   (out of a P-port, into an R-port; a PR-port gets two triangles),
 * - client-server: filled circle for the server, ring for the client,
 * - mode: filled diamond for the mode manager, outlined for the mode user.
 */
export function portGlyph(port: ElkPort, direction: PortDirection, kind: InterfaceKind | undefined, tooltip: string): string {
    const x = port.x ?? 0;
    const y = port.y ?? 0;
    const s = PORT_SIZE;
    const cx = x + s / 2;
    const cy = y + s / 2;
    let glyph: string;
    switch (kind) {
        case 'cs':
            glyph = `<circle cx="${r(cx)}" cy="${r(cy)}" r="3.2" class="${direction === 'rport' ? 'glyph-hollow' : 'glyph'}"/>`;
            break;
        case 'mode':
            glyph = `<path d="M${r(cx)} ${r(y + 2.5)} L${r(x + s - 2.5)} ${r(cy)} L${r(cx)} ${r(y + s - 2.5)} L${r(x + 2.5)} ${r(cy)} Z" class="${direction === 'rport' ? 'glyph-hollow' : 'glyph'}"/>`;
            break;
        default:
            // R-ports sit on the left and P-ports on the right of a box, and data
            // flows left to right, so a right-pointing triangle reads correctly for both.
            glyph = direction === 'prport'
                ? `<path d="M${r(x + 2)} ${r(cy)} L${r(cx - 0.5)} ${r(y + 3)} L${r(cx - 0.5)} ${r(y + s - 3)} Z M${r(x + s - 2)} ${r(cy)} L${r(cx + 0.5)} ${r(y + 3)} L${r(cx + 0.5)} ${r(y + s - 3)} Z" class="glyph"/>`
                : `<path d="M${r(x + 3)} ${r(y + 2.5)} L${r(x + s - 2.5)} ${r(cy)} L${r(x + 3)} ${r(y + s - 2.5)} Z" class="glyph"/>`;
    }
    // The `k-<kind>` class colors the glyph; the <title> becomes the hover tooltip.
    return `<g class="port k-${kind ?? 'unknown'}"><title>${esc(tooltip)}</title>`
        + `<rect x="${r(x)}" y="${r(y)}" width="${s}" height="${s}" class="port-box"/>${glyph}</g>`;
}

type Point = { x: number; y: number };

/**
 * An ELK edge as SVG path plus an optional arrowhead.
 *
 * Arrowheads are drawn as plain polygons. SVG markers would be shorter, but
 * the variants that follow the edge color (`context-stroke`) or flip at the
 * start (`auto-start-reverse`) are not supported by every SVG viewer.
 *
 * @param cls CSS classes for path and arrowhead, e.g. `k-sr` for the interface-kind color.
 * @param arrow where the arrowhead goes; `start` points back towards the edge source.
 * @param tooltip hover text.
 * @param ports laid-out ports by id; edge ends that sit inside one of these port
 *   squares are moved to the square's border (see {@link clipToBox}).
 */
export function edgeSvg(
    edge: ElkExtendedEdge,
    cls: string,
    arrow: 'start' | 'end' | 'none',
    tooltip: string,
    ports: Map<string, ElkPort> = new Map()
): string {
    // Copy the points: clipping below must not modify ELK's result.
    const lines = (edge.sections ?? []).map(s => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(p => ({ x: p.x, y: p.y })));
    if (lines.length === 0) {
        return '';
    }
    // ELK ends an edge on the outer side of a port, where the arrowhead would be
    // hidden under the port symbol. Pull both ends to the inner side.
    const first = lines[0];
    const last = lines[lines.length - 1];
    clipToBox(first[0], first[1], ports.get(edge.sources[0]));
    clipToBox(last[last.length - 1], last[last.length - 2], ports.get(edge.targets[0]));

    const d = lines.map(points => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r(p.x)} ${r(p.y)}`).join(' ')).join(' ');
    let head = '';
    if (arrow === 'end') {
        head = arrowHead(last[last.length - 2], last[last.length - 1], cls);
    } else if (arrow === 'start') {
        head = arrowHead(first[1], first[0], cls);
    }
    // The group makes the whole edge (path and arrowhead) one hover target.
    return `<g class="edge-group"><title>${esc(tooltip)}</title><path d="${d}" class="edge ${cls}"/>${head}</g>`;
}

/**
 * If `p` lies inside `box`, moves it to the side of the box that faces `next`.
 * ELK routes orthogonally, so the segment p → next is either horizontal or
 * vertical and only one coordinate has to change.
 */
function clipToBox(p: Point, next: Point, box: ElkPort | undefined): void {
    if (!box) {
        return;
    }
    const x0 = box.x ?? 0;
    const y0 = box.y ?? 0;
    const x1 = x0 + (box.width ?? 0);
    const y1 = y0 + (box.height ?? 0);
    // Half a pixel of tolerance for rounding in ELK's output.
    if (p.x < x0 - 0.5 || p.x > x1 + 0.5 || p.y < y0 - 0.5 || p.y > y1 + 0.5) {
        return;
    }
    if (Math.abs(p.y - next.y) < 0.5) {
        p.x = next.x > p.x ? x1 : x0;
    } else {
        p.y = next.y > p.y ? y1 : y0;
    }
}

/** Filled triangle (8 px long, 8 px wide) with its tip at `to`, pointing along from → to. */
function arrowHead(from: Point, to: Point, cls: string): string {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    // Unit vector along the edge, and the base center of the triangle 8 px behind the tip.
    const ux = (to.x - from.x) / len;
    const uy = (to.y - from.y) / len;
    const bx = to.x - ux * 8;
    const by = to.y - uy * 8;
    // Base corners: 4 px to either side, perpendicular to the edge (-uy, ux).
    const pts = [[to.x, to.y], [bx - uy * 4, by + ux * 4], [bx + uy * 4, by - ux * 4]];
    return `<path d="M${pts.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L')} Z" class="arrow ${cls}"/>`;
}

/**
 * Wraps the diagram body into a standalone SVG document with the stylesheet
 * and a background rectangle (so exported files are not transparent).
 */
export function svgDocument(width: number, height: number, body: string, title: string): string {
    const w = Math.ceil(width);
    const h = Math.ceil(height);
    return `<svg xmlns="http://www.w3.org/2000/svg" class="ardl" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
        + `<title>${esc(title)}</title><style>${STYLE}</style>`
        + `<rect class="bg" x="0" y="0" width="${w}" height="${h}"/>${body}</svg>`;
}

/**
 * One-line legend of the port symbols, for views that show ports.
 * Returns the markup and its height, so the caller can size the document.
 */
export function legend(x: number, y: number): { svg: string; height: number } {
    const items: Array<[PortDirection, InterfaceKind, string]> = [
        ['pport', 'sr', 'Sender'], ['rport', 'sr', 'Receiver'],
        ['pport', 'cs', 'Server'], ['rport', 'cs', 'Client'],
        ['pport', 'mode', 'Mode manager'], ['rport', 'mode', 'Mode user'],
        ['pport', 'nv', 'NV data'], ['rport', 'param', 'Parameter']
    ];
    let cx = x;
    const parts = items.map(([dir, kind, label]) => {
        const glyph = portGlyph({ id: '', x: cx, y }, dir, kind, `${label} (${kind} ${dir})`);
        const t = text(cx + PORT_SIZE + 5, y + 10, label, 'muted');
        cx += PORT_SIZE + 5 + textWidth(label, 11) + 18;
        return glyph + t;
    });
    return { svg: `<g class="legend">${parts.join('')}</g>`, height: PORT_SIZE + 4 };
}

/**
 * Stylesheet embedded in every SVG.
 *
 * All colors are CSS custom properties (`--ardl-*`) with light-theme defaults.
 * A standalone file uses the defaults; the VS Code preview sets the variables
 * from the editor theme (see media/preview.css), and a website can do the same.
 *
 * Class scheme:
 * - `kind-<swc kind>` / `layer-<bsw layer>`: box colors,
 * - `k-<interface kind>`: port glyph, edge and arrowhead colors,
 * - `upward`: layering violation in the layers view,
 * - `os-<object kind>`: shapes, edges and arrowheads of the OS view.
 */
const STYLE = `
.ardl{font-family:var(--ardl-font,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif);font-size:12px}
.ardl .bg{fill:var(--ardl-bg,#ffffff)}
.ardl text{fill:var(--ardl-fg,#1f2328)}
.ardl text.name{font-weight:600;font-size:13px}
.ardl text.title{font-weight:600;font-size:15px}
.ardl text.stereo,.ardl text.muted{fill:var(--ardl-muted,#59636e);font-size:11px}
.ardl text.band-label{fill:var(--ardl-muted,#59636e);font-size:12px;font-weight:600}
.ardl .box{stroke-width:1.2}
.ardl .composition{fill:var(--ardl-composition,#f6f8fa);stroke:var(--ardl-composition-stroke,#8c959f);stroke-dasharray:6 3;stroke-width:1.2}
.ardl .kind-application{fill:var(--ardl-app,#e7f0fd);stroke:var(--ardl-app-stroke,#3b6fb6)}
.ardl .kind-sensorActuator{fill:var(--ardl-sa,#e3f5f3);stroke:var(--ardl-sa-stroke,#1f7a70)}
.ardl .kind-service{fill:var(--ardl-svc,#f1e9fb);stroke:var(--ardl-svc-stroke,#7b4bb7)}
.ardl .kind-ecuAbstraction,.ardl .kind-complexDriver{fill:var(--ardl-cdd,#fff4d6);stroke:var(--ardl-cdd-stroke,#b7791f)}
.ardl .kind-parameter{fill:var(--ardl-prm,#f0f1f3);stroke:var(--ardl-prm-stroke,#6e7781)}
.ardl .kind-composition{fill:var(--ardl-composition,#f6f8fa);stroke:var(--ardl-composition-stroke,#8c959f)}
.ardl .layer-services{fill:var(--ardl-svc,#f1e9fb);stroke:var(--ardl-svc-stroke,#7b4bb7)}
.ardl .layer-ecual{fill:var(--ardl-ecual,#e5f5e9);stroke:var(--ardl-ecual-stroke,#2f8a4a)}
.ardl .layer-mcal{fill:var(--ardl-mcal,#fde9e7);stroke:var(--ardl-mcal-stroke,#c0392b)}
.ardl .layer-cdd{fill:var(--ardl-cdd,#fff4d6);stroke:var(--ardl-cdd-stroke,#b7791f)}
.ardl .band{stroke:none;opacity:.45}
.ardl .band-rte{fill:var(--ardl-rte,#ffe3c7);stroke:none}
.ardl .runnable{fill:var(--ardl-runnable,#ffffff);stroke:var(--ardl-runnable-stroke,#57606a);stroke-width:1}
.ardl .port-box{fill:var(--ardl-bg,#ffffff);stroke:var(--ardl-port-stroke,#1f2328);stroke-width:1}
.ardl .glyph{stroke:none}
.ardl .glyph-hollow{fill:none;stroke-width:1.4}
.ardl .k-sr .glyph{fill:var(--ardl-sr,#2f6fd0)} .ardl .k-sr .glyph-hollow{stroke:var(--ardl-sr,#2f6fd0)}
.ardl .k-cs .glyph{fill:var(--ardl-cs,#c26a00)} .ardl .k-cs .glyph-hollow{stroke:var(--ardl-cs,#c26a00)}
.ardl .k-mode .glyph{fill:var(--ardl-mode,#8a3fc7)} .ardl .k-mode .glyph-hollow{stroke:var(--ardl-mode,#8a3fc7)}
.ardl .k-nv .glyph{fill:var(--ardl-nv,#1f8a4c)}
.ardl .k-param .glyph{fill:var(--ardl-param,#6e7781)}
.ardl .edge{fill:none;stroke-width:1.4;stroke:var(--ardl-edge,#57606a)}
.ardl .edge.k-sr{stroke:var(--ardl-sr,#2f6fd0)}
.ardl .edge.k-cs{stroke:var(--ardl-cs,#c26a00);stroke-dasharray:6 3}
.ardl .edge.k-mode{stroke:var(--ardl-mode,#8a3fc7);stroke-dasharray:2 3}
.ardl .edge.k-nv{stroke:var(--ardl-nv,#1f8a4c)}
.ardl .edge.k-param{stroke:var(--ardl-param,#6e7781)}
.ardl .edge.upward{stroke:var(--ardl-error,#cf222e);stroke-dasharray:5 3}
.ardl .edge-group:hover .edge{stroke-width:2.6}
.ardl .arrow{stroke:none;fill:var(--ardl-edge,#57606a)}
.ardl .arrow.k-sr{fill:var(--ardl-sr,#2f6fd0)}
.ardl .arrow.k-cs{fill:var(--ardl-cs,#c26a00)}
.ardl .arrow.k-mode{fill:var(--ardl-mode,#8a3fc7)}
.ardl .arrow.k-nv{fill:var(--ardl-nv,#1f8a4c)}
.ardl .arrow.k-param{fill:var(--ardl-param,#6e7781)}
.ardl .arrow.upward{fill:var(--ardl-error,#cf222e)}
.ardl .os-task{fill:var(--ardl-app,#e7f0fd);stroke:var(--ardl-app-stroke,#3b6fb6)}
.ardl .os-isr{fill:var(--ardl-mcal,#fde9e7);stroke:var(--ardl-mcal-stroke,#c0392b)}
.ardl .os-divider{stroke:var(--ardl-app-stroke,#3b6fb6);stroke-width:.8;opacity:.5}
.ardl text.runs{font-size:11px;font-family:var(--ardl-mono,ui-monospace,Menlo,Consolas,monospace)}
.ardl .os-object{fill:var(--ardl-bg,#ffffff);stroke-width:1.4}
.ardl .os-slot{stroke:var(--ardl-sr,#2f6fd0);stroke-width:1}
.ardl .os-object.os-mutex,.ardl .edge.os-mutex{stroke:var(--ardl-cs,#c26a00)}
.ardl .os-object.os-semaphore,.ardl .edge.os-semaphore{stroke:var(--ardl-mode,#8a3fc7)}
.ardl .os-object.os-queue,.ardl .edge.os-queue{stroke:var(--ardl-sr,#2f6fd0)}
.ardl .os-object.os-event,.ardl .edge.os-event{stroke:var(--ardl-nv,#1f8a4c)}
.ardl .edge.os-mutex{stroke-dasharray:6 3}
.ardl .arrow.os-semaphore{fill:var(--ardl-mode,#8a3fc7)}
.ardl .arrow.os-queue{fill:var(--ardl-sr,#2f6fd0)}
.ardl .arrow.os-event{fill:var(--ardl-nv,#1f8a4c)}
`;

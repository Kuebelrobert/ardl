/**
 * Port helpers shared by the composition and the component view: where a port
 * sits on its box, how it is passed to ELK, and how it is drawn with its label.
 */
import type { ElkPort } from 'elkjs/lib/elk-api.js';
import type { Port } from '../language/generated/ast.js';
import { PORT_SIZE, portGlyph, text, textWidth } from './svg.js';

/**
 * R-ports sit on the left, P- and PR-ports on the right of a box. With the
 * layered algorithm running left to right, data then flows across the diagram
 * from left to right, like in most AUTOSAR tools.
 */
export const portSide = (port: Port): 'WEST' | 'EAST' => port.direction === 'rport' ? 'WEST' : 'EAST';

/**
 * ELK port for an ARDL port. The side is fixed (the node needs
 * `elk.portConstraints: FIXED_SIDE`); ELK chooses the order and position on
 * that side. The negative border offset centers the square on the box border
 * instead of placing it outside.
 */
export function elkPort(id: string, port: Port): ElkPort {
    return {
        id,
        width: PORT_SIZE,
        height: PORT_SIZE,
        layoutOptions: {
            'elk.port.side': portSide(port),
            'elk.port.borderOffset': String(-PORT_SIZE / 2)
        }
    };
}

/** Widest port label per side, used to reserve room for the labels inside or outside a box. */
export function labelWidths(ports: Port[]): { west: number; east: number } {
    const width = (side: string) => Math.max(0, ...ports.filter(p => portSide(p) === side).map(p => textWidth(p.name, 11)));
    return { west: width('WEST'), east: width('EAST') };
}

/**
 * Port symbol plus its name.
 *
 * @param laid the port as placed by ELK.
 * @param inside `true` puts the label into the box (ports of prototypes and
 *   components), `false` outside it (boundary ports of a composition).
 * @param above `true` puts the label above the port instead of next to it. The
 *   component view needs this, because edges leave its ports horizontally
 *   into the box and would strike through a label on the same line.
 */
export function renderPort(laid: ElkPort, port: Port, inside: boolean, above = false): string {
    const iface = port.interface.ref;
    const tooltip = `${port.direction} ${port.name} : ${iface?.name ?? '?'} (${iface?.kind ?? '?'})`;
    const west = portSide(port) === 'WEST';
    const y = above ? (laid.y ?? 0) - 3 : (laid.y ?? 0) + PORT_SIZE - 2;
    // The label runs to the right of a west port inside the box, or of an east port outside it.
    const toRight = west === inside;
    const x = toRight ? (laid.x ?? 0) + PORT_SIZE + 5 : (laid.x ?? 0) - 5;
    return portGlyph(laid, port.direction, iface?.kind, tooltip) + text(x, y, port.name, 'muted', toRight ? 'start' : 'end');
}

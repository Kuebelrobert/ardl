/**
 * AUTOSAR-specific validation for ARDL models.
 *
 * Langium already reports syntax errors and unresolved references. The checks
 * in this file add the semantic rules of AUTOSAR Classic that a reviewer would
 * otherwise have to catch by hand:
 *
 * - names are unique, within a file and across all files of the workspace,
 * - interface members match the interface kind,
 * - runnables only trigger on and access ports that fit the access,
 * - connectors respect port directions and interface types,
 * - every required port of a prototype is connected,
 * - compositions do not contain themselves, directly or indirectly,
 * - BSW modules follow the layered architecture.
 *
 * Severity convention: `error` for models that cannot be correct, `warning`
 * for models that are probably incomplete, `info` for things that are legal
 * but worth a second look.
 */
import { AstUtils, type AstNode, type IndexManager, type ValidationAcceptor, type ValidationChecks } from 'langium';
import {
    isComposition,
    isDataElement,
    isDataTrigger,
    isModeGroup,
    isModeTrigger,
    isOperation,
    isOperationTrigger,
    isPrototype,
    isTimingTrigger,
    isView,
    type ArdlAstType,
    type Bsw,
    type Component,
    type Composition,
    type Interface,
    type Model,
    type Port,
    type PortRef,
    type Runnable
} from './generated/ast.js';
import type { ArdlServices } from './ardl-module.js';
import { DATA_KINDS, isProvided, isRequired, isUpwardDependency, skipsEcuAbstraction } from './ardl-semantics.js';

/**
 * Registers the checks of {@link ArdlValidator} with Langium's validation registry.
 * Each AST type maps to the checks that run for every node of that type.
 */
export function registerValidationChecks(services: ArdlServices): void {
    const validator = services.validation.ArdlValidator;
    const checks: ValidationChecks<ArdlAstType> = {
        Model: validator.checkUniqueElementNames,
        Interface: validator.checkInterfaceMembers,
        Swc: validator.checkComponentMembers,
        Bsw: [validator.checkComponentMembers, validator.checkBswDependencies],
        Composition: [validator.checkComponentMembers, validator.checkComposition],
        Runnable: validator.checkRunnable
    };
    // Passing the validator as `thisObj` lets the checks use `this.indexManager`.
    services.validation.ValidationRegistry.register(checks, validator);
}

export class ArdlValidator {

    /** Index of all exported (top-level) symbols of the workspace, used for cross-file duplicate checks. */
    private readonly indexManager: IndexManager;

    constructor(services: ArdlServices) {
        this.indexManager = services.shared.workspace.IndexManager;
    }

    /**
     * Top-level names must be unique. ARDL has one global namespace for all
     * `.ardl` files of a workspace (there are no packages or imports), so a
     * name declared in another file is a conflict as well.
     *
     * Views live in a namespace of their own: `view Body composition Body`
     * is fine because a view is never the target of a model reference.
     */
    checkUniqueElementNames(model: Model, accept: ValidationAcceptor): void {
        reportDuplicates(model.elements.filter(e => !isView(e)), 'Element', accept);
        reportDuplicates(model.elements.filter(isView), 'View', accept);

        // Collect the names declared in every other document, keyed by namespace.
        const uri = AstUtils.getDocument(model).uri.toString();
        const namespace = (type: string) => type.endsWith('View') ? 'view' : 'element';
        const elsewhere = new Map<string, string>();
        for (const d of this.indexManager.allElements()) {
            if (d.documentUri.toString() !== uri) {
                elsewhere.set(`${namespace(d.type)}:${d.name}`, d.documentUri.path.split('/').pop() ?? '');
            }
        }
        for (const element of model.elements) {
            const other = elsewhere.get(`${namespace(element.$type)}:${element.name}`);
            if (other) {
                accept('error', `'${element.name}' is already declared in ${other}. Names are global across all .ardl files.`,
                    { node: element, property: 'name' });
            }
        }
    }

    /**
     * The grammar accepts any member in any interface so that the user gets a
     * precise message instead of a parse error. Here the members are matched
     * against the kind: data elements for sr/nv/param, operations for cs and
     * a mode group for mode interfaces.
     */
    checkInterfaceMembers(iface: Interface, accept: ValidationAcceptor): void {
        if (iface.members.length === 0) {
            accept('warning', `Interface '${iface.name}' has no members.`, { node: iface, property: 'name' });
        }
        for (const member of iface.members) {
            const ok = DATA_KINDS.includes(iface.kind) ? isDataElement(member)
                : iface.kind === 'cs' ? isOperation(member)
                : isModeGroup(member);
            if (!ok) {
                const expected = DATA_KINDS.includes(iface.kind) ? 'data elements (name: type)'
                    : iface.kind === 'cs' ? 'operations (name(in a: T): R)'
                    : "a mode group ('modes A, B')";
                accept('error', `A '${iface.kind}' interface contains ${expected} only.`, { node: member });
            }
        }
        // Mode declarations share the member namespace, so `modes A, A` is a duplicate too.
        reportDuplicates(iface.members.flatMap<AstNode & { name?: string }>(m => isModeGroup(m) ? m.modes : [m]), 'Member', accept);
    }

    /** Port and runnable names must be unique within their component. */
    checkComponentMembers(component: Component, accept: ValidationAcceptor): void {
        reportDuplicates(component.ports, 'Port', accept);
        // Compositions have no runnables.
        if ('runnables' in component) {
            reportDuplicates(component.runnables, 'Runnable', accept);
        }
    }

    /**
     * Checks every `uses` dependency of a BSW module against the layered
     * architecture: no self-dependency, no upward dependency, and a hint when
     * a services module bypasses the ECU abstraction.
     */
    checkBswDependencies(bsw: Bsw, accept: ValidationAcceptor): void {
        bsw.uses.forEach((ref, index) => {
            const used = ref.ref;
            if (!used) {
                // Unresolved reference: Langium reports it already.
                return;
            }
            if (used === bsw) {
                accept('error', `'${bsw.name}' cannot use itself.`, { node: bsw, property: 'uses', index });
            } else if (isUpwardDependency(bsw, used)) {
                accept('warning', `Upward dependency: ${bsw.layer} module '${bsw.name}' uses ${used.layer} module '${used.name}'.`,
                    { node: bsw, property: 'uses', index });
            } else if (skipsEcuAbstraction(bsw, used)) {
                accept('info', `'${bsw.name}' skips the ECU abstraction layer and uses the MCAL driver '${used.name}' directly.`,
                    { node: bsw, property: 'uses', index });
            }
        });
    }

    /**
     * A runnable needs at least one trigger, and every trigger and access must
     * fit the direction and interface kind of its port. The rules mirror the
     * RTE API that the generated code would offer:
     *
     * | Syntax          | Port must be         | RTE API                     |
     * |-----------------|----------------------|-----------------------------|
     * | `on data P`     | required sr/nv/param | DataReceivedEvent           |
     * | `on call P`     | provided cs          | OperationInvokedEvent       |
     * | `on mode P`     | required mode        | SwcModeSwitchEvent          |
     * | `reads P`       | required sr/nv/param | Rte_Read / Rte_IRead / Rte_Prm |
     * | `writes P`      | provided sr/nv       | Rte_Write / Rte_IWrite      |
     * | `calls P`       | required cs          | Rte_Call                    |
     * | `switches P`    | provided mode        | Rte_Switch                  |
     */
    checkRunnable(runnable: Runnable, accept: ValidationAcceptor): void {
        if (runnable.triggers.length === 0) {
            accept('warning', `Runnable '${runnable.name}' has no trigger (every, on init, on data, on call, on mode).`,
                { node: runnable, property: 'name' });
        }
        for (const trigger of runnable.triggers) {
            if (isTimingTrigger(trigger)) {
                continue;
            }
            // Init triggers have no port; the other triggers name exactly one.
            const port = 'port' in trigger ? trigger.port.ref : undefined;
            if (!port) {
                continue;
            }
            const kind = port.interface.ref?.kind;
            if (isDataTrigger(trigger) && !(isRequired(port) && kind && DATA_KINDS.includes(kind))) {
                accept('error', `'on data' needs a required sender-receiver port; '${port.name}' is a ${describe(port)}.`, { node: trigger, property: 'port' });
            } else if (isOperationTrigger(trigger) && !(isProvided(port) && kind === 'cs')) {
                accept('error', `'on call' needs a provided client-server port; '${port.name}' is a ${describe(port)}.`, { node: trigger, property: 'port' });
            } else if (isModeTrigger(trigger) && !(isRequired(port) && kind === 'mode')) {
                accept('error', `'on mode' needs a required mode-switch port; '${port.name}' is a ${describe(port)}.`, { node: trigger, property: 'port' });
            }
        }
        for (const access of runnable.accesses) {
            access.ports.forEach((ref, index) => {
                const port = ref.ref;
                const kind = port?.interface.ref?.kind;
                if (!port || !kind) {
                    return;
                }
                const ok = access.kind === 'reads' ? isRequired(port) && DATA_KINDS.includes(kind)
                    : access.kind === 'writes' ? isProvided(port) && (kind === 'sr' || kind === 'nv')
                    : access.kind === 'calls' ? isRequired(port) && kind === 'cs'
                    : isProvided(port) && kind === 'mode';
                if (!ok) {
                    const expected = {
                        reads: 'a required sr/nv/param port',
                        writes: 'a provided sr/nv port',
                        calls: 'a required cs port',
                        switches: 'a provided mode port'
                    }[access.kind];
                    accept('error', `'${access.kind}' needs ${expected}; '${port.name}' is a ${describe(port)}.`, { node: access, property: 'ports', index });
                }
            });
        }
    }

    /**
     * Structural checks of a composition: unique prototypes, no containment
     * cycles, correct connector directions and types, complete wiring of
     * required ports, and at most one server per client port.
     */
    checkComposition(composition: Composition, accept: ValidationAcceptor): void {
        reportDuplicates(composition.prototypes, 'Prototype', accept);

        // A composition that contains itself, directly or through other compositions,
        // has no finite instance tree.
        composition.prototypes.forEach(proto => {
            const type = proto.type.ref;
            if (isComposition(type) && containsComposition(type, composition, new Set())) {
                const how = type === composition ? 'itself' : `itself through '${type.name}'`;
                accept('error', `Composition '${composition.name}' cannot contain ${how}.`, { node: proto, property: 'type' });
            }
        });

        for (const connector of composition.connectors) {
            const source = connector.source;
            const target = connector.target;
            const sp = source.port.ref;
            const tp = target.port.ref;
            if (!sp || !tp) {
                // Unresolved ends are reported by the linker.
                continue;
            }
            // An end without `proto.` refers to a port of the composition itself (delegation).
            const inner = (ref: PortRef) => ref.prototype !== undefined;
            if (!inner(source) && !inner(target)) {
                accept('error', 'A connector needs at least one prototype port.', { node: connector });
                continue;
            }
            if (inner(source) && inner(target)) {
                // Assembly connector: provider -> requirer.
                if (!isProvided(sp)) {
                    accept('error', `Assembly source must be a provided port; '${portLabel(source)}' is an R-port. Swap the ends.`, { node: connector, property: 'source' });
                }
                if (!isRequired(tp)) {
                    accept('error', `Assembly target must be a required port; '${portLabel(target)}' is a P-port.`, { node: connector, property: 'target' });
                }
            } else if (!inner(source)) {
                // Delegation connector into the composition: outer R-port -> inner R-port.
                if (!isRequired(sp) || !isRequired(tp)) {
                    accept('error', 'Delegation from a composition port must go from an outer R-port to an inner R-port.', { node: connector });
                }
            } else if (!isProvided(sp) || !isProvided(tp)) {
                // Delegation connector out of the composition: inner P-port -> outer P-port.
                accept('error', 'Delegation to a composition port must go from an inner P-port to an outer P-port.', { node: connector });
            }
            // ARDL has no interface compatibility rules (yet): connected ports use the same interface.
            const si = sp.interface.ref;
            const ti = tp.interface.ref;
            if (si && ti && si !== ti) {
                accept('error', `Interface mismatch: '${portLabel(source)}' is ${si.name}, '${portLabel(target)}' is ${ti.name}.`, { node: connector });
            }
        }

        // Which `proto.Port` ends are connected, and how many connectors end at each client-server target.
        const connected = new Set<string>();
        const clientCount = new Map<string, number>();
        for (const c of composition.connectors) {
            for (const end of [c.source, c.target]) {
                connected.add(portLabel(end));
            }
            if (c.target.port.ref?.interface.ref?.kind === 'cs') {
                const key = portLabel(c.target);
                clientCount.set(key, (clientCount.get(key) ?? 0) + 1);
            }
        }

        // Every pure R-port of a prototype needs a connection. PR-ports are skipped:
        // they also provide, so leaving them unconnected is legal.
        for (const proto of composition.prototypes) {
            const protoName = proto.name ?? proto.type.$refText;
            for (const port of proto.type.ref?.ports ?? []) {
                if (port.direction === 'rport' && !connected.has(`${protoName}.${port.name}`)) {
                    accept('warning', `R-port '${protoName}.${port.name}' is not connected.`, { node: proto });
                }
            }
        }

        // A client calls exactly one server; with two connectors the RTE could not decide which.
        for (const c of composition.connectors) {
            const key = portLabel(c.target);
            if ((clientCount.get(key) ?? 0) > 1) {
                accept('error', `Client port '${key}' is connected to more than one server.`, { node: c, property: 'target' });
            }
        }
    }
}

/**
 * True if `outer` contains `wanted` somewhere in its prototype tree.
 * `visited` stops the search in cycles that do not involve `wanted`; those
 * are reported when the compositions of that cycle are validated themselves.
 */
function containsComposition(outer: Composition, wanted: Composition, visited: Set<Composition>): boolean {
    if (outer === wanted) {
        return true;
    }
    if (visited.has(outer)) {
        return false;
    }
    visited.add(outer);
    return outer.prototypes.some(p => {
        const type = p.type.ref;
        return isComposition(type) && containsComposition(type, wanted, visited);
    });
}

/** `proto.Port` for prototype ports, `Port` for ports of the composition itself; uses the source text so it works for unresolved references too. */
function portLabel(ref: PortRef): string {
    return ref.prototype ? `${ref.prototype.$refText}.${ref.port.$refText}` : ref.port.$refText;
}

/** Short description of a port for error messages, e.g. "rport of a 'cs' interface". */
function describe(port: Port): string {
    const kind = port.interface.ref?.kind ?? '?';
    return `${port.direction} of a '${kind}' interface`;
}

/**
 * Reports an error on every node whose name occurs more than once in `nodes`.
 * Unnamed prototypes take the name of their type (see `ArdlNameProvider`), so
 * `prototype A` twice is a duplicate as well; the error then sits on the whole
 * prototype because it has no name token to point at.
 */
function reportDuplicates(nodes: Array<AstNode & { name?: string }>, what: string, accept: ValidationAcceptor): void {
    const named = nodes.map(node => ({ node, name: node.name ?? (isPrototype(node) ? node.type.$refText : undefined) }));
    const count = new Map<string, number>();
    for (const { name } of named) {
        if (name) {
            count.set(name, (count.get(name) ?? 0) + 1);
        }
    }
    for (const { node, name } of named) {
        if (name && count.get(name)! > 1) {
            accept('error', `${what} name '${name}' is used more than once.`, node.name ? { node, property: 'name' } : { node });
        }
    }
}

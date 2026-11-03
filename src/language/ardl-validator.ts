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
 * - BSW modules follow the layered architecture,
 * - OS objects fit the profile, are used consistently, are locked in one
 *   order, and every runnable of a mapped component is mapped exactly once.
 *   An OS may be split into several `os` blocks of the same name; the OS
 *   checks see all parts, and each part reports what lies inside it.
 *
 * Severity convention: `error` for models that cannot be correct, `warning`
 * for models that are probably incomplete, `info` for things that are legal
 * but worth a second look.
 */
import { AstUtils, type AstNode, type IndexManager, type LangiumDocuments, type ValidationAcceptor, type ValidationChecks } from 'langium';
import {
    isComposition,
    isCompletionTrigger,
    isDataElement,
    isDataTrigger,
    isErrorTrigger,
    isModeGroup,
    isModeTrigger,
    isMutex,
    isOperation,
    isOperationTrigger,
    isOs,
    isPrototype,
    isTimingTrigger,
    isView,
    type ArdlAstType,
    type Bsw,
    type Component,
    type Composition,
    type Interface,
    type Isr,
    type Model,
    type Os,
    type OsAccess,
    type OsAccessKind,
    type OsObject,
    type Port,
    type PortRef,
    type Runnable,
    type RunnableOwner,
    type RunnableRef,
    type Task
} from './generated/ast.js';
import type { ArdlServices } from './ardl-module.js';
import {
    ACCESS_TARGET,
    BLOCKING_ACCESSES,
    DATA_KINDS,
    MUTEX_PROTOCOLS,
    OS_PROFILES,
    isOsekLike,
    isProvided,
    isRequired,
    isUpwardDependency,
    mergeOs,
    mutexProtocol,
    skipsEcuAbstraction,
    type MergedOs
} from './ardl-semantics.js';

/**
 * Registers the checks of {@link ArdlValidator} with Langium's validation registry.
 * Each AST type maps to the checks that run for every node of that type.
 */
export function registerValidationChecks(services: ArdlServices): void {
    const validator = services.validation.ArdlValidator;
    const checks: ValidationChecks<ArdlAstType> = {
        Model: validator.checkUniqueElementNames,
        Interface: validator.checkInterfaceMembers,
        Port: validator.checkPort,
        Swc: validator.checkComponentMembers,
        Bsw: [validator.checkComponentMembers, validator.checkBswDependencies],
        Composition: [validator.checkComponentMembers, validator.checkComposition],
        Runnable: validator.checkRunnable,
        Os: validator.checkOs,
        Isr: validator.checkIsr,
        OsAccess: validator.checkOsAccess
    };
    // Passing the validator as `thisObj` lets the checks use `this.indexManager`.
    services.validation.ValidationRegistry.register(checks, validator);
}

export class ArdlValidator {

    /** Index of all exported (top-level) symbols of the workspace, used for cross-file duplicate checks. */
    private readonly indexManager: IndexManager;
    /** All documents of the workspace, to collect the parts of an OS. */
    private readonly documents: LangiumDocuments;

    constructor(services: ArdlServices) {
        this.indexManager = services.shared.workspace.IndexManager;
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    /** The OS that `os` is a part of, merged from all files. */
    private merged(os: Os): MergedOs {
        return mergeOs(os.name, this.documents.all.map(d => d.parseResult.value as Model));
    }

    /**
     * Top-level names must be unique. ARDL has one global namespace for all
     * `.ardl` files of a workspace (there are no packages or imports), so a
     * name declared in another file is a conflict as well.
     *
     * Views live in a namespace of their own: `view Body composition Body`
     * is fine because a view is never the target of a model reference.
     * OS blocks are not checked: blocks with the same name are parts of one OS.
     */
    checkUniqueElementNames(model: Model, accept: ValidationAcceptor): void {
        reportDuplicates(model.elements.filter(e => !isView(e) && !isOs(e)), 'Element', accept);
        reportDuplicates(model.elements.filter(isView), 'View', accept);

        // Collect the names declared in every other document, keyed by namespace.
        const uri = AstUtils.getDocument(model).uri.toString();
        const namespace = (type: string) => type.endsWith('View') ? 'view' : 'element';
        const elsewhere = new Map<string, string>();
        for (const d of this.indexManager.allElements()) {
            if (d.documentUri.toString() !== uri && d.type !== 'Os') {
                elsewhere.set(`${namespace(d.type)}:${d.name}`, d.documentUri.path.split('/').pop() ?? '');
            }
        }
        for (const element of model.elements.filter(e => !isOs(e))) {
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
        if (iface.queued && iface.kind !== 'sr') {
            accept('error', `Only sender-receiver interfaces can be 'queued'.`, { node: iface, property: 'queued' });
        }
        // Mode declarations share the member namespace, so `modes A, A` is a duplicate too.
        reportDuplicates(iface.members.flatMap<AstNode & { name?: string }>(m => isModeGroup(m) ? m.modes : [m]), 'Member', accept);
    }

    /** E2E protection exists for sender-receiver data and client-server calls (transformer chain). */
    checkPort(port: Port, accept: ValidationAcceptor): void {
        const kind = port.interface.ref?.kind;
        if (port.e2e && kind && kind !== 'sr' && kind !== 'cs') {
            accept('error', `E2E protection needs a sender-receiver or client-server port; '${port.name}' is a ${describe(port)}.`, { node: port, property: 'e2e' });
        }
    }

    /** Port, runnable and exclusive area names are unique within their component; every exclusive area is entered. */
    checkComponentMembers(component: Component, accept: ValidationAcceptor): void {
        reportDuplicates(component.ports, 'Port', accept);
        // Compositions have no runnables.
        if ('runnables' in component) {
            reportDuplicates(component.runnables, 'Runnable', accept);
            reportDuplicates(component.exclusiveAreas, 'Exclusive area', accept);
            const entered = new Set(component.runnables.flatMap(r => r.enters.map(e => e.ref)));
            for (const area of component.exclusiveAreas.filter(a => !entered.has(a))) {
                accept('warning', `Exclusive area '${area.name}' is not entered by any runnable.`, { node: area, property: 'name' });
            }
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
     * | `on data error P` | required sr/nv     | DataReceiveErrorEvent       |
     * | `on mode error P` | provided mode      | SwcModeManagerErrorEvent    |
     * | `on transformer error P` | e2e port or provided cs | TransformerErrorEvent |
     * | `on sent P`     | provided sr/nv       | DataSendCompletedEvent      |
     * | `on written P`  | provided sr/nv, written implicitly | DataWriteCompletedEvent |
     * | `on result P`   | required cs          | AsynchronousServerCallReturnsEvent |
     * | `on switched P` | provided mode        | ModeSwitchedAckEvent        |
     * | `reads P`       | required sr/nv/param | Rte_Read / Rte_Receive / Rte_Prm |
     * | `writes P`      | provided sr/nv       | Rte_Write / Rte_Send        |
     * | `implicit reads/writes P` | unqueued sr/nv | Rte_IRead / Rte_IWrite |
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
            } else if (isErrorTrigger(trigger) || isCompletionTrigger(trigger)) {
                const event = isErrorTrigger(trigger) ? `${trigger.source} error` : trigger.event;
                const data = kind === 'sr' || kind === 'nv';
                const [ok, expected] = {
                    'data error': [isRequired(port) && data, 'a required sr/nv port'],
                    'mode error': [isProvided(port) && kind === 'mode', 'a provided mode port'],
                    'transformer error': [port.e2e || (isProvided(port) && kind === 'cs'), "an 'e2e' port or a provided cs port"],
                    sent: [isProvided(port) && data, 'a provided sr/nv port'],
                    written: [isProvided(port) && data, 'a provided sr/nv port'],
                    result: [isRequired(port) && kind === 'cs', 'a required cs port'],
                    switched: [isProvided(port) && kind === 'mode', 'a provided mode port']
                }[event] as [boolean, string];
                if (!ok) {
                    accept('error', `'on ${event}' needs ${expected}; '${port.name}' is a ${describe(port)}.`, { node: trigger, property: 'port' });
                } else if (event === 'written' && !isImplicitlyWritten(runnable.$container, port)) {
                    accept('warning', `'on written' follows an implicit write, but no runnable of '${runnable.$container.name}' has 'implicit writes ${port.name}'.`, { node: trigger, property: 'port' });
                }
            }
        }
        for (const access of runnable.accesses) {
            if (access.implicit && access.kind !== 'reads' && access.kind !== 'writes') {
                accept('error', `Only reads and writes can be 'implicit'.`, { node: access, property: 'implicit' });
            }
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
                if (ok && access.implicit && (kind === 'param' || port.interface.ref?.queued)) {
                    accept('error', `'implicit ${access.kind}' needs unqueued sr/nv data; '${port.name}' is ${kind === 'param' ? 'a parameter port (Rte_Prm)' : 'queued'}.`, { node: access, property: 'ports', index });
                } else if (!ok) {
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

    /**
     * Checks that need all tasks, ISRs and objects of an OS at once. They run
     * on the merged OS, but each part only reports the problems inside itself,
     * so a problem shows up once, in the file it is in. All checks are linear
     * in the size of the OS (plus the runnables of the mapped components), so
     * they stay cheap for large ECUs.
     */
    checkOs(os: Os, accept: ValidationAcceptor): void {
        const merged = this.merged(os);
        if (os.profile && !(OS_PROFILES as readonly string[]).includes(os.profile)) {
            accept('error', `Unknown OS profile '${os.profile}'. Use one of: ${OS_PROFILES.join(', ')}.`, { node: os, property: 'profile' });
        } else if (os.profile && merged.profile !== os.profile) {
            accept('error', `OS '${os.name}' already has profile '${merged.profile}' in another part.`, { node: os, property: 'profile' });
        }
        const here: ValidationAcceptor = (severity, message, info) => {
            if (AstUtils.getContainerOfType(info.node, isOs) === os) {
                accept(severity, message, info);
            }
        };
        reportDuplicates([...merged.tasks, ...merged.isrs, ...merged.objects], 'OS element', here);
        this.checkOsObjects(merged, here);
        this.checkLockOrder(merged, here);
        this.checkRunnableMapping(merged, here);
    }

    /** Profile rules per object, and whether every object is used the way its kind needs. */
    private checkOsObjects(os: MergedOs, accept: ValidationAcceptor): void {
        // Who uses each object, and how.
        const users = new Map<OsObject, Array<{ user: Task | Isr; kind: OsAccessKind }>>();
        for (const user of [...os.tasks, ...os.isrs]) {
            for (const access of user.accesses) {
                for (const ref of access.objects) {
                    if (ref.ref) {
                        users.set(ref.ref, [...users.get(ref.ref) ?? [], { user, kind: access.kind }]);
                    }
                }
            }
        }
        const osek = isOsekLike(os.profile);
        for (const object of os.objects) {
            const uses = users.get(object) ?? [];
            const has = (kind: OsAccessKind) => uses.some(u => u.kind === kind);
            const names = (kind: OsAccessKind) => [...new Set(uses.filter(u => u.kind === kind).map(u => u.user.name))];
            const at = { node: object, property: 'name' } as const;
            if (uses.length === 0) {
                accept('warning', `'${object.name}' is not used by any task or ISR.`, at);
            }
            switch (object.$type) {
                case 'Mutex': {
                    const protocol = mutexProtocol(object);
                    if (osek) {
                        accept('error', `${os.profile} has no mutexes. Use a resource (priority ceiling).`, at);
                    } else if (!(MUTEX_PROTOCOLS as readonly string[]).includes(protocol)) {
                        const hint = protocol === 'ceiling' ? " For priority ceiling declare a 'resource'." : '';
                        accept('error', `Unknown protocol '${protocol}'. Use one of: ${MUTEX_PROTOCOLS.join(', ')}.${hint}`, { node: object, property: 'protocol' });
                    }
                    const priorities = new Set(uses.map(u => u.user.priority));
                    if (protocol === 'none' && priorities.size > 1) {
                        accept('warning', `'${object.name}' is shared by tasks of different priority without a protocol: priority inversion. Use 'protocol inherit' or a resource.`, at);
                    }
                    break;
                }
                case 'Semaphore':
                    if (osek) {
                        accept('error', `${os.profile} has no semaphores. Use an event for signalling or a resource for mutual exclusion.`, at);
                    } else if (has('takes') && !has('gives') && !object.count) {
                        accept('warning', `'${object.name}' is taken but never given and has no initial count: ${names('takes').join(', ')} block forever.`, at);
                    }
                    break;
                case 'Queue':
                    if (has('sends') && !has('receives')) {
                        accept('warning', `'${object.name}' is sent to but nobody receives from it.`, at);
                    } else if (has('receives') && !has('sends')) {
                        accept('warning', `'${object.name}' is received from but nobody sends to it.`, at);
                    }
                    break;
                case 'Event':
                    if (has('waits') && !has('sets')) {
                        accept('warning', `'${object.name}' is never set: ${names('waits').join(', ')} wait forever.`, at);
                    } else if (has('sets') && !has('waits')) {
                        accept('warning', `'${object.name}' is set but no task waits for it.`, at);
                    }
                    if (osek && names('waits').length > 1) {
                        accept('error', `In ${os.profile} an event belongs to one task; '${object.name}' is waited for by ${names('waits').join(', ')}.`, at);
                    }
                    break;
            }
        }
    }

    /**
     * `locks A, B` means B is taken while A is held. If one task locks A then B
     * and another B then A, both can end up waiting for each other. The check
     * builds the graph of these orders and warns at every order that lies on a
     * cycle.
     */
    private checkLockOrder(os: MergedOs, accept: ValidationAcceptor): void {
        const after = new Map<string, Set<string>>();
        const orders: Array<{ access: OsAccess; from: string; to: string; index: number }> = [];
        for (const user of [...os.tasks, ...os.isrs]) {
            for (const access of user.accesses.filter(a => a.kind === 'locks')) {
                for (let i = 1; i < access.objects.length; i++) {
                    const from = access.objects[i - 1].$refText;
                    const to = access.objects[i].$refText;
                    after.set(from, (after.get(from) ?? new Set()).add(to));
                    orders.push({ access, from, to, index: i });
                }
            }
        }
        // Can `from` be reached again from `to`? Depth-first over the few mutexes of one OS.
        const reaches = (start: string, goal: string): boolean => {
            const seen = new Set<string>();
            const stack = [start];
            while (stack.length) {
                const n = stack.pop()!;
                if (n === goal) return true;
                if (!seen.has(n)) {
                    seen.add(n);
                    stack.push(...after.get(n) ?? []);
                }
            }
            return false;
        };
        for (const { access, from, to, index } of orders) {
            if (reaches(to, from)) {
                accept('warning', `Lock order ${from} → ${to} conflicts with ${to} → … → ${from} elsewhere: possible deadlock.`,
                    { node: access, property: 'objects', index });
            }
        }
    }

    /**
     * A runnable runs in exactly one task. Every component with at least one
     * mapped runnable should have all of them mapped, except pure servers
     * (`on call` only), which run in the caller's context. Components without
     * any mapping are not reported: they may belong to another ECU.
     * A periodic runnable in a periodic task needs a period that is a multiple
     * of the task's period. An exclusive area whose runnables all run in one
     * task needs no lock, as the RTE would optimize it away.
     */
    private checkRunnableMapping(os: MergedOs, accept: ValidationAcceptor): void {
        const mappedTo = new Map<Runnable, Task>();
        const firstRef = new Map<RunnableOwner, RunnableRef>();
        for (const task of os.tasks) {
            for (const ref of task.runs) {
                const runnable = ref.runnable.ref;
                const owner = ref.component.ref;
                if (!runnable || !owner) {
                    continue;
                }
                const other = mappedTo.get(runnable);
                if (other) {
                    accept('warning', `'${owner.name}.${runnable.name}' is already mapped to '${other.name}'.`, { node: ref });
                } else {
                    mappedTo.set(runnable, task);
                }
                if (!firstRef.has(owner)) {
                    firstRef.set(owner, ref);
                }
                const runnablePeriod = runnable.triggers.find(isTimingTrigger)?.period;
                if (runnablePeriod && task.period && !isMultiple(runnablePeriod, task.period)) {
                    accept('warning', `'${runnable.name}' runs every ${runnablePeriod}, which is not a multiple of the ${task.period} period of '${task.name}'.`, { node: ref });
                }
            }
        }
        for (const [owner, ref] of firstRef) {
            const missing = owner.runnables.filter(r => !mappedTo.has(r) && !(r.triggers.length > 0 && r.triggers.every(isOperationTrigger)));
            if (missing.length) {
                accept('warning', `Runnables of '${owner.name}' not mapped to a task: ${missing.map(r => r.name).join(', ')}.`, { node: ref, property: 'component' });
            }
            for (const area of owner.exclusiveAreas) {
                const users = owner.runnables.filter(r => r.enters.some(e => e.ref === area));
                const tasks = new Set(users.map(r => mappedTo.get(r)));
                const [task] = tasks;
                if (users.length && tasks.size === 1 && task) {
                    accept('info', `Exclusive area '${owner.name}.${area.name}' is only entered from '${task.name}' and needs no lock.`, { node: ref, property: 'component' });
                }
            }
        }
    }

    /**
     * ISRs: category 1 ISRs bypass the OS and must not use OS objects, and no
     * ISR may block. Category 2 ISRs may take resources (the ceiling then
     * masks interrupts); mutexes cannot be locked from interrupt context.
     */
    checkIsr(isr: Isr, accept: ValidationAcceptor): void {
        if (isr.cat !== undefined && isr.cat !== 1 && isr.cat !== 2) {
            accept('error', 'ISR category is 1 or 2.', { node: isr, property: 'cat' });
        }
        isr.accesses.forEach(access => {
            if (isr.cat === 1) {
                accept('error', `A category 1 ISR must not use OS objects; make '${isr.name}' 'cat 2'.`, { node: access, property: 'kind' });
            } else if (BLOCKING_ACCESSES.includes(access.kind)) {
                accept('error', `An ISR must not block: '${access.kind}' can wait.`, { node: access, property: 'kind' });
            } else if (access.objects.some(o => isMutex(o.ref))) {
                accept('error', 'Mutexes cannot be locked from an ISR. Use a resource.', { node: access, property: 'kind' });
            }
        });
    }

    /** `locks` needs a resource or mutex, `takes`/`gives` a semaphore, `sends`/`receives` a queue, `waits`/`sets` an event. */
    checkOsAccess(access: OsAccess, accept: ValidationAcceptor): void {
        const expected = ACCESS_TARGET[access.kind];
        access.objects.forEach((ref, index) => {
            const object = ref.ref;
            if (object && !expected.includes(object.$type)) {
                accept('error', `'${access.kind}' needs a ${expected.map(t => t.toLowerCase()).join(' or ')}; '${object.name}' is a ${object.$type.toLowerCase()}.`,
                    { node: access, property: 'objects', index });
            }
        });
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

/** True if duration `a` is a whole multiple of duration `b` (both like `10ms`, `500us`, `1s`). */
function isMultiple(a: string, b: string): boolean {
    const us = (d: string) => parseFloat(d) * (d.endsWith('us') ? 1 : d.endsWith('ms') ? 1000 : 1_000_000);
    const ratio = us(a) / us(b);
    return Math.abs(ratio - Math.round(ratio)) < 1e-9 && ratio >= 1;
}

/** True if some runnable of `owner` writes `port` with `implicit writes`. */
function isImplicitlyWritten(owner: { runnables: Runnable[] }, port: Port): boolean {
    return owner.runnables.some(r => r.accesses.some(a => a.implicit && a.kind === 'writes' && a.ports.some(p => p.ref === port)));
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

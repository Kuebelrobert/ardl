/**
 * AUTOSAR rules shared by the validator and the diagram renderers.
 *
 * Keeping them in one place guarantees that what the editor reports as a
 * problem and what the diagrams highlight (e.g. a red upward dependency in
 * the layers view) never disagree.
 */
import type { Bsw, BswLayer, InterfaceKind, Mutex, Os, OsAccessKind, OsObject, Port } from './generated/ast.js';

/**
 * A port provides data or a service if it is a P-port or a PR-port.
 * PR-ports (`prport`) count as both provided and required.
 */
export const isProvided = (port: Port): boolean => port.direction !== 'rport';

/** A port requires data or a service if it is an R-port or a PR-port. */
export const isRequired = (port: Port): boolean => port.direction !== 'pport';

/**
 * Interface kinds that carry data elements (as opposed to operations or modes).
 * Sender-receiver, NV data and parameter interfaces are all read the same way
 * by a runnable, so most checks treat them alike.
 */
export const DATA_KINDS: readonly InterfaceKind[] = ['sr', 'nv', 'param'];

/**
 * Vertical position of the layered BSW architecture. A module may use modules
 * of its own layer or of a lower one. Complex drivers (`cdd`) span all layers
 * and are therefore exempt from the layering rule; their rank is never compared.
 */
export const LAYER_RANK: Readonly<Record<BswLayer, number>> = { services: 3, ecual: 2, mcal: 1, cdd: 0 };

/**
 * True if `user` depends on a module of a higher layer, e.g. an MCAL driver
 * calling into the services layer. Dependencies from or to complex drivers
 * are never upward, because complex drivers are allowed to cut across layers.
 */
export function isUpwardDependency(user: Bsw, used: Bsw): boolean {
    return user.layer !== 'cdd' && used.layer !== 'cdd' && LAYER_RANK[used.layer] > LAYER_RANK[user.layer];
}

/**
 * True if a services module calls an MCAL driver directly instead of going
 * through the ECU abstraction. Allowed by AUTOSAR in a few places (EcuM → Mcu),
 * so it is only reported as a hint.
 */
export function skipsEcuAbstraction(user: Bsw, used: Bsw): boolean {
    return user.layer === 'services' && used.layer === 'mcal';
}

/** OS profiles the validator knows. `generic` makes no assumptions beyond the basics. */
export const OS_PROFILES = ['autosar', 'osek', 'threadx', 'freertos', 'generic'] as const;

/** Locking protocols of a mutex. */
export const MUTEX_PROTOCOLS = ['ceiling', 'inherit', 'none'] as const;

/** AUTOSAR OS and OSEK share the object model: resources with priority ceiling, events owned by one task, no semaphores. */
export function isOsekLike(os: Os): boolean {
    return os.profile === 'autosar' || os.profile === 'osek';
}

/** The protocol of a mutex: as written, or the profile's default (ceiling for AUTOSAR/OSEK resources, inheritance otherwise). */
export function mutexProtocol(mutex: Mutex): string {
    return mutex.protocol ?? (isOsekLike(mutex.$container) ? 'ceiling' : 'inherit');
}

/** The object type each access works on, e.g. `locks` needs a mutex. */
export const ACCESS_TARGET: Readonly<Record<OsAccessKind, OsObject['$type']>> = {
    locks: 'Mutex', takes: 'Semaphore', gives: 'Semaphore', sends: 'Queue', receives: 'Queue', waits: 'Event', sets: 'Event'
};

/** Accesses that can block the caller, which an ISR must not do. */
export const BLOCKING_ACCESSES: readonly OsAccessKind[] = ['takes', 'receives', 'waits'];

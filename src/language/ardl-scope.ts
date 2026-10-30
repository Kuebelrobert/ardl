/**
 * Naming and scoping of ARDL.
 *
 * Langium's defaults make every top-level element visible everywhere and every
 * nested element visible inside its container. That is right for interfaces,
 * components and BSW modules, but too permissive for ports: a runnable must
 * only see the ports of its own component, and a connector end `proto.Port`
 * must look the port up in the type of `proto`.
 */
import {
    AstUtils,
    DefaultNameProvider,
    DefaultScopeProvider,
    EMPTY_SCOPE,
    GrammarUtils,
    type AstNode,
    type CstNode,
    type ReferenceInfo,
    type Scope
} from 'langium';
import {
    isAccess,
    isBsw,
    isComposition,
    isPortRef,
    isPrototype,
    isRunnableRef,
    isSwc,
    isTrigger,
    type Bsw,
    type Swc
} from './generated/ast.js';

/**
 * Names AST nodes for linking, the index and the outline.
 *
 * `prototype LightCtrl` without an explicit name is the common case when a
 * composition contains one instance of each component, so such a prototype
 * takes the name of its type. The type reference is read as source text
 * (`$refText`), because naming happens before linking.
 */
export class ArdlNameProvider extends DefaultNameProvider {
    override getName(node: AstNode): string | undefined {
        if (isPrototype(node) && !node.name) {
            return node.type.$refText;
        }
        return super.getName(node);
    }

    /** The source location used for "go to definition" and rename: the type reference of an unnamed prototype. */
    override getNameNode(node: AstNode): CstNode | undefined {
        if (isPrototype(node) && !node.name) {
            return GrammarUtils.findNodeForProperty(node.$cstNode, 'type');
        }
        return super.getNameNode(node);
    }
}

/**
 * Restricts which ports and runnables a reference can see:
 *
 * - triggers and accesses of a runnable see the ports of their own component,
 * - `proto.Port` in a connector sees the ports of the prototype's component type,
 * - a bare `Port` in a connector sees the composition's own (delegation) ports,
 * - `proto` in a connector sees the prototypes of the enclosing composition,
 * - `Swc.Runnable` in a task's `runs` sees the runnables of that component.
 *
 * Every other reference uses Langium's default scoping (local, then global).
 */
export class ArdlScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const { container, property } = context;

        if (isPortRef(container)) {
            const composition = AstUtils.getContainerOfType(container, isComposition);
            if (!composition) {
                return EMPTY_SCOPE;
            }
            if (property === 'prototype') {
                return this.createScopeForNodes(composition.prototypes);
            }
            if (property === 'port') {
                if (container.prototype) {
                    // Resolving the prototype first is fine: Langium links lazily and caches the result.
                    const type = container.prototype.ref?.type.ref;
                    return type ? this.createScopeForNodes(type.ports) : EMPTY_SCOPE;
                }
                return this.createScopeForNodes(composition.ports);
            }
        }

        if (isRunnableRef(container) && property === 'runnable') {
            const owner = container.component.ref;
            return owner ? this.createScopeForNodes(owner.runnables) : EMPTY_SCOPE;
        }

        // Triggers reference one port (`port`), accesses a list (`ports`).
        if ((isTrigger(container) || isAccess(container)) && property.startsWith('port')) {
            const component = AstUtils.getContainerOfType(container, (n): n is Swc | Bsw => isSwc(n) || isBsw(n));
            return component ? this.createScopeForNodes(component.ports) : EMPTY_SCOPE;
        }

        return super.getScope(context);
    }
}

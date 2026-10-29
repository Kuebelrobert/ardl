/**
 * Dependency injection setup of the ARDL language.
 *
 * Langium builds a language from modules: the default modules provide parser,
 * linker, index, LSP features and so on; the generated modules contribute the
 * grammar and AST reflection; `ArdlModule` below overrides or adds the
 * services that make ARDL behave like AUTOSAR (naming, scoping, validation).
 */
import { inject, type Module } from 'langium';
import {
    createDefaultModule,
    createDefaultSharedModule,
    type DefaultSharedModuleContext,
    type LangiumServices,
    type LangiumSharedServices,
    type PartialLangiumServices
} from 'langium/lsp';
import { ArdlGeneratedModule, ArdlGeneratedSharedModule } from './generated/module.js';
import { ArdlNameProvider, ArdlScopeProvider } from './ardl-scope.js';
import { ArdlValidator, registerValidationChecks } from './ardl-validator.js';

/** Services that ARDL adds on top of the Langium defaults. */
export type ArdlAddedServices = {
    validation: {
        ArdlValidator: ArdlValidator;
    };
};

/** All services of the ARDL language: Langium defaults plus {@link ArdlAddedServices}. */
export type ArdlServices = LangiumServices & ArdlAddedServices;

/**
 * ARDL-specific service implementations. Each entry is a factory that receives
 * the fully injected services, so implementations can depend on each other.
 */
export const ArdlModule: Module<ArdlServices, PartialLangiumServices & ArdlAddedServices> = {
    references: {
        // Unnamed prototypes are named after their type.
        NameProvider: () => new ArdlNameProvider(),
        // Ports are only visible inside their component or through a prototype.
        ScopeProvider: (services) => new ArdlScopeProvider(services)
    },
    validation: {
        ArdlValidator: (services) => new ArdlValidator(services)
    }
};

/**
 * Creates the shared services (workspace, documents, index, LSP connection)
 * and the ARDL language services, and registers the language with the shared
 * service registry.
 *
 * @param context file system access and, in the language server, the LSP
 *   connection. The CLI and the tests pass no connection.
 */
export function createArdlServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Ardl: ArdlServices;
} {
    const shared = inject(createDefaultSharedModule(context), ArdlGeneratedSharedModule);
    const Ardl = inject(createDefaultModule({ shared }), ArdlGeneratedModule, ArdlModule);
    shared.ServiceRegistry.register(Ardl);
    registerValidationChecks(Ardl);
    if (!context.connection) {
        // In a language server the client sends the configuration after `initialized`.
        // Without a connection nobody does, and the document builder would wait forever.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Ardl };
}

/**
 * Dependency injection setup of the ARDL language.
 *
 * Langium builds a language from modules: the default modules provide parser,
 * linker, index, LSP features and so on; the generated modules contribute the
 * grammar and AST reflection; `ArdlModule` below overrides or adds the
 * services that make ARDL behave like AUTOSAR (naming, scoping, validation).
 */
import { DefaultDocumentBuilder, inject, type DeepPartial, type LangiumDocument, type Module } from 'langium';
import {
    createDefaultModule,
    createDefaultSharedModule,
    type DefaultSharedModuleContext,
    type LangiumServices,
    type LangiumSharedServices,
    type PartialLangiumServices
} from 'langium/lsp';
import { ArdlGeneratedModule, ArdlGeneratedSharedModule } from './generated/module.js';
import { isOs, type Model } from './generated/ast.js';
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
 * The parts of an OS can sit in different files, and the OS checks of one part
 * depend on the others (an event set in one file and waited for in another).
 * Langium only relinks and revalidates documents that reference a changed one,
 * so a document with an `os` block is revalidated after every change. There
 * are only a few such documents, so this stays cheap.
 */
export class ArdlDocumentBuilder extends DefaultDocumentBuilder {
    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        return super.shouldRelink(document, changedUris) || (document.parseResult.value as Model).elements.some(isOs);
    }
}

/** Shared services that ARDL replaces. */
export const ArdlSharedModule: Module<LangiumSharedServices, DeepPartial<LangiumSharedServices>> = {
    workspace: {
        DocumentBuilder: (services) => new ArdlDocumentBuilder(services)
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
    const shared = inject(createDefaultSharedModule(context), ArdlGeneratedSharedModule, ArdlSharedModule);
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

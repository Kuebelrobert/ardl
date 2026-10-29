/**
 * Entry point of the ARDL language server.
 *
 * The VS Code extension starts this file (bundled to `out/language/main.cjs`)
 * as a separate Node process and talks to it over LSP. Besides the standard
 * LSP features that Langium provides (diagnostics, completion, navigation,
 * rename, ...) the server offers two ARDL-specific messages for the preview:
 *
 * - request `ardl/diagrams` `{ uri }` → `RenderedDiagram[]`: the SVG views of one document,
 * - notification `ardl/changed` `{ uris }`: sent after every build, so open previews refresh.
 *
 * Diagrams are rendered here and not in the extension, because only the server
 * has the linked models of the whole workspace.
 */
import { DocumentState, URI, type LangiumDocument } from 'langium';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { renderDiagrams } from '../diagram/index.js';
import { createArdlServices } from './ardl-module.js';
import type { Model } from './generated/ast.js';

// The transport (IPC, stdio, socket) is chosen by the command line the client starts us with.
const connection = createConnection(ProposedFeatures.all);
const { shared } = createArdlServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);

/** Renders the views of one document after it, and everything it references, is validated. */
connection.onRequest('ardl/diagrams', async ({ uri }: { uri: string }) => {
    const document = await validatedDocument(URI.parse(uri));
    if (!document) {
        return [];
    }
    // All models of the workspace, so a layers view can show BSW modules from other files.
    const workspace = shared.workspace.LangiumDocuments.all.map(d => d.parseResult.value as Model).toArray();
    return renderDiagrams(document.parseResult.value as Model, workspace);
});

/**
 * Returns the document once it is validated.
 *
 * The preview may ask for diagrams before the server has processed the
 * `didOpen` of the document (e.g. right after VS Code starts), and
 * `waitUntil` rejects documents it does not know. So wait for the workspace
 * to load, then poll for up to five seconds until the document shows up.
 */
async function validatedDocument(uri: URI): Promise<LangiumDocument | undefined> {
    await shared.workspace.WorkspaceManager.ready;
    for (let attempt = 0; attempt < 50; attempt++) {
        if (shared.workspace.LangiumDocuments.hasDocument(uri)) {
            await shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, uri);
            return shared.workspace.LangiumDocuments.getDocument(uri);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return undefined;
}

// A change in one file can change the diagrams of another (shared interfaces,
// cross-file prototypes), so the preview refreshes after any build, not only
// after builds of its own document.
shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, documents => {
    connection.sendNotification('ardl/changed', { uris: documents.map(d => d.uri.toString()) });
});

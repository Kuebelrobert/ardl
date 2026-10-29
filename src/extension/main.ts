/**
 * VS Code extension entry point (bundled to `out/extension/main.cjs`).
 *
 * The extension itself is thin: it starts the ARDL language server in a
 * separate process, and everything language-related (diagnostics, completion,
 * navigation, diagram rendering) happens there. On top it registers the two
 * ARDL commands and the diagram preview.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import type { RenderedDiagram } from '../diagram/index.js';
import { DiagramPreview } from './preview.js';

let client: LanguageClient | undefined;

/**
 * Called by VS Code the first time an `.ardl` file is opened or an ARDL
 * command runs (activation events are derived from `contributes` in package.json).
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    client = startLanguageClient(context);
    await client.start();

    const preview = new DiagramPreview(context, uri => requestDiagrams(uri));
    context.subscriptions.push(
        preview,
        // From the editor title button the URI of the editor is passed in; from
        // the command palette or the key binding there is none, so use the active editor.
        vscode.commands.registerCommand('ardl.openPreview', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (target) {
                preview.show(target);
            }
        }),
        // Writes every view of the file as `<file>.<view>.svg` next to it.
        vscode.commands.registerCommand('ardl.exportSvg', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                return;
            }
            const diagrams = await requestDiagrams(target);
            const dir = path.dirname(target.fsPath);
            const base = path.basename(target.fsPath, '.ardl');
            for (const d of diagrams) {
                await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(dir, `${base}.${d.id}.svg`)), Buffer.from(d.svg));
            }
            vscode.window.showInformationMessage(`ARDL: wrote ${diagrams.length} SVG file(s) next to ${path.basename(target.fsPath)}.`);
        }),
        // The server sends this after every build; the preview re-requests its diagrams.
        client.onNotification('ardl/changed', () => preview.refresh())
    );
}

/** Called by VS Code on shutdown; stops the language server process. */
export async function deactivate(): Promise<void> {
    await client?.stop();
}

/** Asks the language server for the rendered views of a document (see src/language/main.ts). */
function requestDiagrams(uri: vscode.Uri): Promise<RenderedDiagram[]> {
    return client!.sendRequest<RenderedDiagram[]>('ardl/diagrams', { uri: uri.toString() });
}

/**
 * Creates the client for the bundled language server. The server runs as a
 * Node process talking over IPC; in debug mode it opens the inspector on port
 * 6009, so "Attach to Language Server" in .vscode/launch.json can connect.
 */
function startLanguageClient(context: vscode.ExtensionContext): LanguageClient {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const clientOptions: LanguageClientOptions = {
        // Saved files and new, unsaved ARDL editors.
        documentSelector: [{ scheme: 'file', language: 'ardl' }, { scheme: 'untitled', language: 'ardl' }]
    };
    return new LanguageClient('ardl', 'ARDL Language Server', serverOptions, clientOptions);
}

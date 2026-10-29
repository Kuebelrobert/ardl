/**
 * The diagram preview: one webview panel beside the editor.
 *
 * The extension side (this file) decides which document is shown, fetches its
 * diagrams from the language server and posts them to the webview. The webview
 * side (media/preview.js) shows them with tabs, zoom and pan. Messages:
 *
 * - extension → webview: `{ type: 'diagrams', file, diagrams }`, `{ type: 'error', message }`
 * - webview → extension: `{ type: 'ready' }` once loaded, `{ type: 'export', id }` for "Export SVG"
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RenderedDiagram } from '../diagram/index.js';

/** Fetches the rendered views of a document; in practice an `ardl/diagrams` request to the language server. */
type Fetch = (uri: vscode.Uri) => Promise<RenderedDiagram[]>;

/**
 * Manages the single preview panel. The panel follows the active ARDL editor,
 * like the built-in Markdown preview, and re-renders after every build of the
 * language server.
 */
export class DiagramPreview implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** The document currently shown. */
    private uri: vscode.Uri | undefined;
    /** The last diagrams sent to the webview, kept for "Export SVG". */
    private diagrams: RenderedDiagram[] = [];
    private pending: ReturnType<typeof setTimeout> | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext, private readonly fetch: Fetch) {
        // Switch to another ARDL file when its editor becomes active. Other editors
        // (and the preview itself) leave the current diagrams in place.
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            if (this.panel && editor?.document.languageId === 'ardl' && editor.document.uri.toString() !== this.uri?.toString()) {
                this.uri = editor.document.uri;
                this.refresh();
            }
        }));
    }

    /** Opens the panel beside the editor (or reveals it) and shows `uri`. */
    show(uri: vscode.Uri): void {
        this.uri = uri;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('ardl.preview', 'ARDL Preview', {
                viewColumn: vscode.ViewColumn.Beside,
                // Keep the cursor in the editor, so the user can type on.
                preserveFocus: true
            }, {
                enableScripts: true,
                // Keeps zoom, scroll position and the active tab when the panel is hidden behind another tab.
                retainContextWhenHidden: true,
                // The webview may load files from media/ only.
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
            });
            this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
            this.panel.webview.html = this.html(this.panel.webview);
            this.panel.webview.onDidReceiveMessage(message => this.onMessage(message), undefined, this.disposables);
            this.panel.onDidDispose(() => this.panel = undefined, undefined, this.disposables);
        } else {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
        }
        this.refresh();
    }

    /**
     * Schedules an update. Debounced by 150 ms: while typing, the language server
     * builds after every keystroke, and one layout run per pause is enough.
     */
    refresh(): void {
        if (!this.panel || !this.uri) {
            return;
        }
        clearTimeout(this.pending);
        this.pending = setTimeout(() => this.update(), 150);
    }

    /** Fetches the diagrams of the current document and posts them to the webview. */
    private async update(): Promise<void> {
        const uri = this.uri;
        if (!this.panel || !uri) {
            return;
        }
        try {
            const diagrams = await this.fetch(uri);
            // The user may have switched to another file while the server was rendering.
            if (!this.panel || this.uri?.toString() !== uri.toString()) {
                return;
            }
            this.diagrams = diagrams;
            this.panel.title = `Preview ${path.basename(uri.fsPath)}`;
            this.panel.webview.postMessage({ type: 'diagrams', file: path.basename(uri.fsPath), diagrams });
        } catch (e) {
            this.panel?.webview.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
    }

    /** Handles messages from the webview script. */
    private async onMessage(message: { type: string; id?: string }): Promise<void> {
        if (message.type === 'ready') {
            // The webview (re)loaded and has no diagrams yet.
            this.refresh();
        } else if (message.type === 'export' && this.uri) {
            const diagram = this.diagrams.find(d => d.id === message.id);
            if (!diagram) {
                return;
            }
            const base = path.basename(this.uri.fsPath, '.ardl');
            const target = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(this.uri.fsPath), `${base}.${diagram.id}.svg`)),
                filters: { SVG: ['svg'] }
            });
            if (target) {
                await vscode.workspace.fs.writeFile(target, Buffer.from(diagram.svg));
            }
        }
    }

    /**
     * The webview page. The content security policy allows only the extension's
     * own stylesheet and the one script carrying this page's nonce. Inline styles
     * are allowed, because the SVGs embed their own `<style>` element.
     */
    private html(webview: vscode.Webview): string {
        const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
        const nonce = randomBytes(16).toString('hex');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('preview.css')}">
<title>ARDL Preview</title>
</head>
<body>
<div id="toolbar">
  <div id="tabs" role="tablist"></div>
  <div class="spacer"></div>
  <button id="zoom-out" title="Zoom out">−</button>
  <button id="zoom-fit" title="Fit to window">Fit</button>
  <button id="zoom-in" title="Zoom in">+</button>
  <button id="export" title="Save this view as SVG">Export SVG</button>
</div>
<div id="message"></div>
<div id="viewport"><div id="canvas"></div></div>
<script nonce="${nonce}" src="${media('preview.js')}"></script>
</body>
</html>`;
    }

    dispose(): void {
        clearTimeout(this.pending);
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

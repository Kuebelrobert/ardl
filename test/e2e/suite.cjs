/**
 * Runs inside VS Code (see run.mjs). VS Code calls `run()` and treats a
 * rejected promise as a failed test run. Plain `assert`, no test framework:
 * the suite is a short smoke test of what unit tests cannot reach, i.e. the
 * extension manifest, the language server process, commands and the preview.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** Polls `check` until it returns a truthy value or `ms` have passed. */
async function waitFor(what, check, ms = 30000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 200));
    }
}

async function run() {
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const file = name => vscode.Uri.joinPath(folder, name);

    // Opening an .ardl file activates the extension and starts the language server.
    const os = await vscode.workspace.openTextDocument(file('light-control-os.ardl'));
    assert.equal(os.languageId, 'ardl');
    await vscode.window.showTextDocument(os);
    const ext = vscode.extensions.getExtension('kuebelrobert.ardl');
    await waitFor('activation', () => ext.isActive);
    console.log('ok   extension activated');

    // The server validates the whole workspace; the info on EcuM shows that it ran
    // on a file that is not open, and the OS file has no errors.
    const lightControl = file('light-control.ardl');
    await waitFor('diagnostics', () => vscode.languages.getDiagnostics(lightControl).some(d => d.message.includes('skips the ECU abstraction')));
    const errors = vscode.languages.getDiagnostics().flatMap(([, ds]) => ds).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(errors.map(d => d.message), []);
    console.log('ok   workspace validated, no errors');

    // Breaking a reference produces an error in the open document.
    const editor = vscode.window.activeTextEditor;
    const offset = os.getText().indexOf('LightCtrl.R_Init');
    await editor.edit(e => e.replace(new vscode.Range(os.positionAt(offset), os.positionAt(offset + 'LightCtrl.R_Init'.length)), 'LightCtrl.R_Nope'));
    await waitFor('error for R_Nope', () => vscode.languages.getDiagnostics(os.uri).some(d => d.message.includes("'R_Nope'")));
    await vscode.commands.executeCommand('undo');
    await waitFor('error to disappear', () => !vscode.languages.getDiagnostics(os.uri).some(d => d.message.includes("'R_Nope'")));
    console.log('ok   diagnostics follow edits');

    // Go to definition across files: LightCtrl in the OS file is declared in light-control.ardl.
    const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', os.uri, os.positionAt(os.getText().indexOf('LightCtrl.R_Init') + 2));
    assert.ok(defs.length > 0, 'no definition found');
    assert.equal(path.basename((defs[0].targetUri ?? defs[0].uri).fsPath), 'light-control.ardl');
    console.log('ok   cross-file go to definition');

    // Completion after `runs LightCtrl.` offers the component's runnables.
    const pos = os.positionAt(os.getText().indexOf('LightCtrl.R_Init') + 'LightCtrl.'.length);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', os.uri, pos);
    const labels = completions.items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
    assert.ok(labels.includes('R_Control') && labels.includes('R_Mode'), `completion: ${labels.join(', ')}`);
    console.log('ok   completion of runnables');

    // Preview opens a webview panel.
    await vscode.commands.executeCommand('ardl.openPreview');
    await waitFor('preview panel', () => vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputWebview));
    console.log('ok   preview opened');

    // Export writes the OS view next to the file.
    await vscode.commands.executeCommand('ardl.exportSvg', os.uri);
    const svg = fs.readFileSync(path.join(folder.fsPath, 'light-control-os.BodyTasks.svg'), 'utf8');
    assert.match(svg, /^<svg /);
    assert.ok(svg.includes('Task_10ms') && !svg.includes('layout failed'));
    console.log('ok   SVG export of the OS view');
}

module.exports = { run };

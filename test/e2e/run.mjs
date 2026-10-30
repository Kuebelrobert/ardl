/**
 * End-to-end test of the packaged extension in a real VS Code.
 *
 * Downloads VS Code into .vscode-test/ (once), copies examples/ into a
 * temporary workspace, starts VS Code with the extension from this folder and
 * runs suite.cjs inside it. `npm run build` must have run before.
 *
 *   node test/e2e/run.mjs                 latest stable VS Code
 *   ARDL_VSCODE_VERSION=1.91.0 node ...   a specific version, e.g. the minimum in `engines`
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = resolve(fileURLToPath(import.meta.url), '../../..');
const workspace = mkdtempSync(join(tmpdir(), 'ardl-e2e-'));
cpSync(join(root, 'examples'), workspace, { recursive: true });

try {
    // Recent macOS builds name the executable `Code` instead of `Electron`, which
    // @vscode/test-electron 2.x does not know yet; fall back to it when needed.
    let executable = await downloadAndUnzipVSCode(process.env.ARDL_VSCODE_VERSION ?? 'stable');
    const renamed = executable.replace(/\/Electron$/, '/Code');
    if (!existsSync(executable) && existsSync(renamed)) {
        executable = renamed;
    }
    await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: root,
        extensionTestsPath: join(root, 'test/e2e/suite.cjs'),
        // No other extensions, no settings sync, no welcome page: only ARDL is tested.
        launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust']
    });
} catch (e) {
    console.error('E2E tests failed:', e);
    process.exitCode = 1;
} finally {
    rmSync(workspace, { recursive: true, force: true });
}

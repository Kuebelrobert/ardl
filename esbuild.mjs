/**
 * Bundles the three Node entry points into self-contained CommonJS files in out/:
 *
 * - out/extension/main.cjs  VS Code extension (loaded by VS Code, `vscode` stays external)
 * - out/language/main.cjs   language server (started by the extension as a child process)
 * - out/cli/main.cjs        command line interface (started by bin/ardl.cjs)
 *
 * Bundling pulls Langium, elkjs and the LSP libraries into each file, so the
 * packaged extension needs no node_modules (`vsce package --no-dependencies`).
 * CommonJS output, because VS Code loads extensions with `require`.
 *
 * Usage: `node esbuild.mjs` for one build, `node esbuild.mjs --watch` to rebuild on change.
 * Type checking is not part of this; `npm run build` runs `tsc --noEmit` first.
 */
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
    entryPoints: {
        'extension/main': 'src/extension/main.ts',
        'language/main': 'src/language/main.ts',
        'cli/main': 'src/cli/main.ts'
    },
    outdir: 'out',
    // package.json has "type": "module", so CommonJS output needs the .cjs extension.
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // Provided by VS Code at runtime.
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info'
});

if (watch) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}

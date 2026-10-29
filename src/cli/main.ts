/**
 * Command line interface (bundled to `out/cli/main.cjs`, started by `bin/ardl.cjs`).
 *
 *   ardl check  <file|dir>...              validate, print diagnostics
 *   ardl render <file|dir>... [-o <dir>]   validate and write one SVG per view
 *
 * Directories are searched recursively for `.ardl` files. All files given in
 * one call form one workspace, so cross-file references resolve exactly as in
 * VS Code when the same files are open in one folder.
 *
 * Exit codes: 0 no errors, 1 validation errors (or a crash), 2 usage error.
 * Warnings never fail the run, so `ardl check` can gate a CI job on errors only.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createArdlServices } from '../language/ardl-module.js';
import type { Model } from '../language/generated/ast.js';
import { renderDiagrams } from '../diagram/index.js';

const USAGE = `ardl – AUTOSAR Design Language

Usage:
  ardl check  <file|dir>...              Validate .ardl files
  ardl render <file|dir>... [-o <dir>]   Validate and write one SVG per view (default: next to each file)
`;

/** Thrown for bad command lines; printed without a stack trace, exit code 2. */
class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command !== 'check' && command !== 'render') {
        process.stdout.write(USAGE);
        return command ? 2 : 0;
    }

    let outDir: string | undefined;
    const inputs: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-o' || rest[i] === '--out') {
            outDir = rest[++i];
            if (!outDir) {
                throw new UsageError(`${rest[i - 1]} needs a directory.`);
            }
        } else {
            inputs.push(rest[i]);
        }
    }

    // Absolute, de-duplicated paths: `ardl check examples examples/a.ardl` must not load a.ardl twice.
    const files = [...new Set((await Promise.all(inputs.map(collect))).flat().map(f => path.resolve(f)))];
    if (files.length === 0) {
        throw new UsageError('No .ardl files found.');
    }

    // No LSP connection: the services run standalone with the Node file system.
    const { shared } = createArdlServices(NodeFileSystem);
    const documents: LangiumDocument[] = [];
    for (const file of files) {
        documents.push(await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file)));
    }
    // Parse, index, link and validate all files together.
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });

    // Diagnostics in the `file:line:col: severity: message` format that editors and CI annotate.
    let errors = 0;
    for (const doc of documents) {
        const rel = path.relative(process.cwd(), doc.uri.fsPath);
        for (const d of doc.diagnostics ?? []) {
            const severity = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
            if (d.severity === 1) errors++;
            process.stdout.write(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${severity}: ${d.message}\n`);
        }
    }

    if (command === 'render') {
        const workspace = documents.map(d => d.parseResult.value as Model);
        for (const doc of documents) {
            // `<file>.<view>.svg`, the same naming as "ARDL: Export Diagrams as SVG" in VS Code.
            const base = path.basename(doc.uri.fsPath, '.ardl');
            const dir = outDir ?? path.dirname(doc.uri.fsPath);
            await fs.mkdir(dir, { recursive: true });
            for (const diagram of await renderDiagrams(doc.parseResult.value as Model, workspace)) {
                const file = path.join(dir, `${base}.${diagram.id}.svg`);
                await fs.writeFile(file, diagram.svg);
                process.stdout.write(`wrote ${path.relative(process.cwd(), file)}\n`);
            }
        }
    }
    process.stdout.write(`${files.length} file(s), ${errors} error(s)\n`);
    return errors ? 1 : 0;
}

/** A file argument as is; a directory argument expanded to all `.ardl` files below it. */
async function collect(input: string): Promise<string[]> {
    const stat = await fs.stat(input).catch(() => {
        throw new UsageError(`No such file or directory: ${input}`);
    });
    if (!stat.isDirectory()) {
        return [input];
    }
    const entries = await fs.readdir(input, { recursive: true, withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith('.ardl')).map(e => path.join(e.parentPath, e.name));
}

main(process.argv.slice(2)).then(code => process.exit(code), err => {
    if (err instanceof UsageError) {
        process.stderr.write(`ardl: ${err.message}\n\n${USAGE}`);
        process.exit(2);
    }
    process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
});

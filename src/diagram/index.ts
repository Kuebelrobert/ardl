/**
 * Entry point of the diagram renderer, shared by the language server (VS Code
 * preview) and the CLI (`ardl render`).
 *
 * The pipeline per view is: linked ARDL model → ELK graph → ELK layout → SVG
 * string. Rendering runs in Node without a DOM; the result is a complete,
 * standalone SVG document.
 */
import {
    isBsw,
    isComponentView,
    isComposition,
    isCompositionView,
    isLayersView,
    isOs,
    isOsView,
    isSwc,
    isView,
    type Model
} from '../language/generated/ast.js';
import { renderComponent } from './component-view.js';
import { renderComposition } from './composition-view.js';
import { renderLayers } from './layers-view.js';
import { renderOs } from './os-view.js';
import { esc } from './svg.js';

/** One rendered view. Sent as JSON to the preview, so it holds plain data only. */
export interface RenderedDiagram {
    /** View name, used as tab id and in exported file names (`<file>.<id>.svg`). */
    id: string;
    /** Human-readable title: the view's `title`, or its name. */
    title: string;
    /** Complete SVG document. */
    svg: string;
}

/**
 * Renders the views of one document.
 *
 * A document with `view` declarations renders exactly those, in source order.
 * A document without views gets default views: one per composition, one
 * layers view of its BSW modules, one per `os` and, if it has none of these,
 * one per SWC. That way
 * a new file shows something before the user has written any view.
 *
 * @param model the document to render.
 * @param workspace every model of the workspace. A layers view without an
 *   explicit module list shows the BSW modules of all files.
 */
export async function renderDiagrams(model: Model, workspace: Model[]): Promise<RenderedDiagram[]> {
    const views = model.elements.filter(isView);
    const result: RenderedDiagram[] = [];
    // A failing layout must not take down the other views of the document;
    // it becomes an error diagram in the failing view's tab instead.
    const safely = async (id: string, title: string, render: () => Promise<string>) => {
        try {
            result.push({ id, title, svg: await render() });
        } catch (e) {
            result.push({ id, title, svg: errorSvg(title, e) });
        }
    };

    if (views.length === 0) {
        const compositions = model.elements.filter(isComposition);
        for (const c of compositions) {
            await safely(c.name, c.name, () => renderComposition(c, c.name));
        }
        const bsw = model.elements.filter(isBsw);
        if (bsw.length) {
            await safely('layers', 'Basic software', () => renderLayers(bsw, 'Basic software'));
        }
        const systems = model.elements.filter(isOs);
        for (const os of systems) {
            await safely(os.name, os.name, () => renderOs(os, os.name));
        }
        if (compositions.length === 0 && bsw.length === 0 && systems.length === 0) {
            for (const swc of model.elements.filter(isSwc)) {
                await safely(swc.name, swc.name, () => renderComponent(swc, swc.name));
            }
        }
        return result;
    }

    // Views whose target does not resolve (yet) are skipped; the editor shows the link error.
    for (const view of views) {
        const title = view.title ?? view.name;
        if (isCompositionView(view)) {
            const c = view.composition.ref;
            if (c) await safely(view.name, title, () => renderComposition(c, title));
        } else if (isComponentView(view)) {
            // `component` also accepts a composition, which then gets the composition view.
            const c = view.component.ref;
            if (c) await safely(view.name, title, () => isComposition(c) ? renderComposition(c, title) : renderComponent(c, title));
        } else if (isLayersView(view)) {
            const modules = view.modules.length
                ? view.modules.flatMap(m => m.ref ? [m.ref] : [])
                : workspace.flatMap(m => m.elements.filter(isBsw));
            await safely(view.name, title, () => renderLayers(modules, title));
        } else if (isOsView(view)) {
            const os = view.os.ref;
            if (os) await safely(view.name, title, () => renderOs(os, title));
        }
    }
    return result;
}

/** Small SVG with the error message, shown in place of a view whose layout failed. */
function errorSvg(title: string, error: unknown): string {
    const message = String(error instanceof Error ? error.message : error).slice(0, 120);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="60" viewBox="0 0 640 60"><text x="10" y="24" fill="#cf222e">${esc(title)}: layout failed</text><text x="10" y="44" fill="#59636e" font-size="11">${esc(message)}</text></svg>`;
}

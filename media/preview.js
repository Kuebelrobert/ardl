// @ts-check
/**
 * Webview side of the ARDL diagram preview (see src/extension/preview.ts for
 * the extension side and the message protocol).
 *
 * Shows one tab per view, the SVG of the active view, zoom (buttons, pinch,
 * Ctrl/Cmd + wheel), drag to pan and "Export SVG". Plain browser JavaScript
 * without a build step, so it is also used unchanged by
 * test/preview-harness.html outside VS Code.
 */
(function () {
    // @ts-ignore acquireVsCodeApi is injected by VS Code (and mocked by the harness).
    const vscode = acquireVsCodeApi();

    /**
     * UI state that survives reloads of the webview (VS Code keeps it with the panel):
     * the active view id and the zoom factor per view id.
     * @type {{ active: string | undefined, zoom: Record<string, number> }}
     */
    const state = Object.assign({ active: undefined, zoom: {} }, vscode.getState() || {});

    const tabs = /** @type {HTMLElement} */ (document.getElementById('tabs'));
    const canvas = /** @type {HTMLElement} */ (document.getElementById('canvas'));
    const viewport = /** @type {HTMLElement} */ (document.getElementById('viewport'));
    const message = /** @type {HTMLElement} */ (document.getElementById('message'));

    /** The diagrams of the current document, as sent by the extension. @type {Array<{id: string, title: string, svg: string}>} */
    let diagrams = [];

    window.addEventListener('message', event => {
        const data = event.data;
        if (data.type === 'diagrams') {
            diagrams = data.diagrams;
            message.textContent = diagrams.length ? '' : `${data.file} has no views yet. Add a composition, BSW modules or a 'view'.`;
            // Keep the active tab across updates while it still exists (e.g. while typing).
            if (!diagrams.some(d => d.id === state.active)) {
                state.active = diagrams[0] && diagrams[0].id;
            }
            renderTabs();
            renderActive();
        } else if (data.type === 'error') {
            message.textContent = data.message;
        }
    });

    /** Rebuilds the tab bar; one button per view. */
    function renderTabs() {
        tabs.replaceChildren(...diagrams.map(d => {
            const tab = document.createElement('button');
            tab.className = 'tab' + (d.id === state.active ? ' active' : '');
            tab.textContent = d.title;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(d.id === state.active));
            tab.addEventListener('click', () => {
                state.active = d.id;
                save();
                renderTabs();
                renderActive();
            });
            return tab;
        }));
    }

    /** Puts the SVG of the active view into the page and applies its zoom. */
    function renderActive() {
        const diagram = diagrams.find(d => d.id === state.active);
        // Inline (not <img>), so the page's CSS variables can theme the SVG.
        // The SVG comes from our own language server, which escapes every model string.
        canvas.innerHTML = diagram ? diagram.svg : '';
        applyZoom();
    }

    /** The SVG element of the active view, if any. */
    function svg() {
        return canvas.querySelector('svg');
    }

    /** Zoom factor of the active view; 1 = the size the renderer chose. */
    function zoom() {
        return state.zoom[state.active] || 1;
    }

    /** Scales the SVG by setting its display size; the viewBox keeps the drawing sharp at any zoom. */
    function applyZoom() {
        const el = svg();
        if (!el) {
            return;
        }
        const [, , w, h] = (el.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        el.setAttribute('width', String(w * zoom()));
        el.setAttribute('height', String(h * zoom()));
    }

    /** Sets the zoom of the active view, limited to 20 % … 400 %. */
    function setZoom(value) {
        state.zoom[state.active] = Math.min(4, Math.max(0.2, value));
        save();
        applyZoom();
    }

    /** Zooms so the whole view fits into the panel, but not above 200 %. */
    function fit() {
        const el = svg();
        if (!el) {
            return;
        }
        const [, , w, h] = (el.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number);
        // 24 px for the canvas padding.
        setZoom(Math.min((viewport.clientWidth - 24) / w, (viewport.clientHeight - 24) / h, 2));
    }

    function save() {
        vscode.setState(state);
    }

    document.getElementById('zoom-in')?.addEventListener('click', () => setZoom(zoom() * 1.2));
    document.getElementById('zoom-out')?.addEventListener('click', () => setZoom(zoom() / 1.2));
    document.getElementById('zoom-fit')?.addEventListener('click', fit);
    // The extension owns the file system access, so it shows the save dialog.
    document.getElementById('export')?.addEventListener('click', () => vscode.postMessage({ type: 'export', id: state.active }));

    // Trackpad pinch arrives as a wheel event with ctrlKey set, so this covers
    // pinch and Ctrl/Cmd + wheel. A plain wheel scrolls the viewport as usual.
    viewport.addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setZoom(zoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        }
    }, { passive: false });

    // Drag with the mouse to pan: move the scroll position by the mouse movement.
    // Listening on window keeps the drag going when the pointer leaves the viewport.
    /** @type {{x: number, y: number, left: number, top: number} | undefined} */
    let drag = undefined;
    viewport.addEventListener('mousedown', e => {
        drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        viewport.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
        if (drag) {
            viewport.scrollLeft = drag.left - (e.clientX - drag.x);
            viewport.scrollTop = drag.top - (e.clientY - drag.y);
        }
    });
    window.addEventListener('mouseup', () => {
        drag = undefined;
        viewport.classList.remove('dragging');
    });

    // Tell the extension we can receive diagrams now.
    vscode.postMessage({ type: 'ready' });
})();

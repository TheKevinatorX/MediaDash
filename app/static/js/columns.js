// ################################################
// # COLUMN MANAGER — SHARED COLUMN STATE/PERSIST #
// ################################################
//
// Factory producing a self-contained column-management unit: visibility,
// mobile visibility, order, widths, custom labels, persistence, picker UI,
// resize handles, and drag-reorder. Pages instantiate one per table/view
// and supply page-specific bits via `config`.
//
// config shape:
//   lsPrefix       : string                         — localStorage key prefix, e.g. 'mediadash_search_'
//   viewKeyFn      : () => string                   — returns the current persistence key (library title, or view key)
//   getMasterCols  : () => Array<{key,label,...}>   — returns current full column list (incl. synthetic 'rank' if used)
//   mobileLabels   : { [key]: string }              — fallback short labels for mobile (optional, default {})
//   defaultMobileKeysFn : () => string[]            — returns default mobile column keys for current context (optional)
//   pickerEnabled  : boolean                        — whether this instance renders a picker UI (default true)
//   pickerElementId: string                         — DOM id of the picker mount element (required if pickerEnabled)
//   onChange       : () => void                     — called after any state mutation that should trigger a re-render

function createColumnManager(config) {
    const {
        lsPrefix,
        viewKeyFn,
        getMasterCols,
        mobileLabels = {},
        defaultMobileKeysFn = () => [],
        pickerEnabled = true,
        pickerElementId = null,
        onChange = () => {},
    } = config;

    const state = {
        visibleColumns: [],
        mobileColumns: [],
        columnLabels: { desktop: {}, mobile: {} },
        columnWidths: {},
        columnOrder: [],
    };

    function lsGetJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function lsSetJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch { /* localStorage unavailable or quota exceeded — preference simply won't persist */ }
    }

    function escapeHTML(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    // --------------------------------------------------------
    // PERSISTENCE
    // --------------------------------------------------------

    function loadVisibleColumns(defaultKeysFn) {
        const saved = lsGetJSON(`${lsPrefix}cols_${viewKeyFn()}`, null);
        if (Array.isArray(saved) && saved.length > 0) {
            state.visibleColumns = saved;
        } else {
            const master = getMasterCols();
            state.visibleColumns = master
                .filter(c => c.key !== 'rank' && c.default && !c.expandOnly)
                .map(c => c.key);
            if (defaultKeysFn) state.visibleColumns = defaultKeysFn(master);
        }
    }

    function saveVisibleColumns() {
        lsSetJSON(`${lsPrefix}cols_${viewKeyFn()}`, state.visibleColumns);
    }

    function loadColumnWidths() {
        const saved = lsGetJSON(`${lsPrefix}widths_${viewKeyFn()}`, null);
        state.columnWidths = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
    }

    function saveColumnWidths() {
        lsSetJSON(`${lsPrefix}widths_${viewKeyFn()}`, state.columnWidths);
    }

    function loadColumnOrder() {
        const saved = lsGetJSON(`${lsPrefix}order_${viewKeyFn()}`, null);
        state.columnOrder = (Array.isArray(saved) && saved.length > 0) ? saved : [];
    }

    function saveColumnOrder() {
        lsSetJSON(`${lsPrefix}order_${viewKeyFn()}`, state.columnOrder);
    }

    function loadMobileColumns() {
        const saved = lsGetJSON(`${lsPrefix}mobile_${viewKeyFn()}`, null);
        if (Array.isArray(saved) && saved.length > 0) {
            state.mobileColumns = saved;
            return;
        }
        const master = getMasterCols();
        const defaults = defaultMobileKeysFn();
        state.mobileColumns = master.filter(c => defaults.includes(c.key)).map(c => c.key);
    }

    function saveMobileColumns() {
        lsSetJSON(`${lsPrefix}mobile_${viewKeyFn()}`, state.mobileColumns);
    }

    function loadColumnLabels() {
        const saved = lsGetJSON(`${lsPrefix}labels_${viewKeyFn()}`, null);
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            if (saved.desktop !== undefined || saved.mobile !== undefined) {
                state.columnLabels = { desktop: saved.desktop || {}, mobile: saved.mobile || {} };
            } else {
                state.columnLabels = { desktop: saved, mobile: {} };
            }
        } else {
            state.columnLabels = { desktop: {}, mobile: {} };
        }
    }

    function saveColumnLabels() {
        lsSetJSON(`${lsPrefix}labels_${viewKeyFn()}`, state.columnLabels);
    }

    function loadAll(defaultKeysFn) {
        loadVisibleColumns(defaultKeysFn);
        loadColumnWidths();
        loadColumnOrder();
        loadMobileColumns();
        loadColumnLabels();
    }

    return {
        state,
        lsGetJSON, lsSetJSON, escapeHTML,
        loadVisibleColumns, saveVisibleColumns,
        loadColumnWidths, saveColumnWidths,
        loadColumnOrder, saveColumnOrder,
        loadMobileColumns, saveMobileColumns,
        loadColumnLabels, saveColumnLabels,
        loadAll,
        mobileLabels,
    };
}

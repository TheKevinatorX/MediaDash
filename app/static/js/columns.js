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
        alwaysOnKeyFn = () => 'title',
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

    // --------------------------------------------------------
    // ORDERING & LABELS
    // --------------------------------------------------------

    function getColLabel(col, isMobile) {
        if (col.key === 'rank') return '#';
        if (isMobile) return state.columnLabels.mobile[col.key] || mobileLabels[col.key] || col.label;
        return state.columnLabels.desktop[col.key] || col.label;
    }

    function syncColumnOrder() {
        if (state.columnOrder.length === 0) return;
        const master = getMasterCols();
        const visibleKeys = master.filter(c => c.key !== 'rank' && state.visibleColumns.includes(c.key)).map(c => c.key);
        state.columnOrder = state.columnOrder.filter(k => visibleKeys.includes(k));
        for (const k of visibleKeys) {
            if (!state.columnOrder.includes(k)) state.columnOrder.push(k);
        }
    }

    function getOrderedVisibleCols() {
        const master = getMasterCols();
        const rankCol = master.find(c => c.key === 'rank') || { key: 'rank', label: '#', sortable: false };
        const vis = master.filter(c => c.key !== 'rank' && state.visibleColumns.includes(c.key));
        if (state.columnOrder.length === 0) return [rankCol, ...vis];
        const ordered = [];
        for (const key of state.columnOrder) {
            const col = vis.find(c => c.key === key);
            if (col) ordered.push(col);
        }
        for (const col of vis) {
            if (!ordered.includes(col)) ordered.push(col);
        }
        return [rankCol, ...ordered];
    }

    // --------------------------------------------------------
    // PICKER UI
    // --------------------------------------------------------

    function renderColumnPicker() {
        if (!pickerEnabled || !pickerElementId) return;
        const picker = document.getElementById(pickerElementId);
        if (!picker) return;
        const tableCols = getMasterCols().filter(c => c.key !== 'rank' && !c.expandOnly);
        const hasLabels = Object.keys(state.columnLabels.desktop).length > 0 || Object.keys(state.columnLabels.mobile).length > 0;

        let html = '<div class="picker-col-header"><span>Desktop</span><span>Mobile</span><span title="Desktop">D</span><span title="Mobile">M</span></div>';
        html += '<div class="picker-list">';
        for (const col of tableCols) {
            const dChecked  = state.visibleColumns.includes(col.key) ? 'checked' : '';
            const mChecked  = state.mobileColumns.includes(col.key) ? 'checked' : '';
            const dDisabled = col.key === alwaysOnKeyFn() ? 'disabled' : '';
            const mDisabled = col.key === alwaysOnKeyFn() ? 'disabled' : '';
            const dCustom = state.columnLabels.desktop[col.key] || '';
            const mCustom = state.columnLabels.mobile[col.key] || '';
            const mPlaceholder = mobileLabels[col.key] || col.label;
            html += `<div class="picker-item picker-item--grid">
                <input type="text" class="picker-label-input" data-col="${col.key}" data-labeltype="desktop" value="${escapeHTML(dCustom)}" placeholder="${escapeHTML(col.label)}">
                <input type="text" class="picker-label-input picker-label-input--mobile" data-col="${col.key}" data-labeltype="mobile" value="${escapeHTML(mCustom)}" placeholder="${escapeHTML(mPlaceholder)}">
                <input type="checkbox" data-col="${col.key}" data-section="desktop" ${dChecked} ${dDisabled}>
                <input type="checkbox" data-col="${col.key}" data-section="mobile" ${mChecked} ${mDisabled}>
            </div>`;
        }
        html += '</div>';
        const orderedMob = state.mobileColumns.map(k => tableCols.find(c => c.key === k)).filter(Boolean);
        if (orderedMob.length > 0) {
            html += '<div class="picker-mobile-order"><div class="picker-order-header">Mobile Column Order</div><div class="picker-order-list">';
            orderedMob.forEach(c => {
                const lbl = getColLabel(c, true);
                html += `<div class="picker-order-item" draggable="true" data-col="${c.key}"><span class="picker-drag-handle">⠿</span><span>${escapeHTML(lbl)}</span></div>`;
            });
            html += '</div></div>';
        }
        html += '<div class="picker-footer">';
        html += '<div class="picker-footer-section"><span class="picker-footer-label">Desktop</span>';
        html += `<button class="btn btn-sm" data-act="deskAll" title="Select All">All</button>`;
        html += `<button class="btn btn-sm" data-act="deskNone" title="Deselect All">None</button>`;
        html += `<button class="btn btn-sm" data-act="deskDefaults" title="Reset to defaults">↺</button></div>`;
        html += '<div class="picker-footer-section"><span class="picker-footer-label">Mobile</span>';
        html += `<button class="btn btn-sm" data-act="mobAll" title="Select All">All</button>`;
        html += `<button class="btn btn-sm" data-act="mobNone" title="Deselect All">None</button>`;
        html += `<button class="btn btn-sm" data-act="mobDefaults" title="Reset to defaults">↺</button></div>`;
        if (hasLabels) {
            html += '<div class="picker-footer-section"><button class="btn btn-sm" data-act="resetLabels" style="flex:1">Reset Label Names</button></div>';
        }
        html += '</div>';
        picker.innerHTML = html;

        const orderList = picker.querySelector('.picker-order-list');
        if (orderList) {
            let dragSrc = null;
            orderList.querySelectorAll('.picker-order-item').forEach(item => {
                item.addEventListener('dragstart', e => {
                    dragSrc = item;
                    item.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                });
                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    state.mobileColumns = [...orderList.querySelectorAll('.picker-order-item')].map(i => i.dataset.col);
                    saveMobileColumns();
                    onChange();
                });
                item.addEventListener('dragover', e => {
                    e.preventDefault();
                    if (!dragSrc || item === dragSrc) return;
                    const { top, height } = item.getBoundingClientRect();
                    orderList.insertBefore(dragSrc, e.clientY < top + height / 2 ? item : item.nextSibling);
                });
                item.addEventListener('dragenter', e => e.preventDefault());
            });
        }

        let labelDebounce = null;
        picker.querySelectorAll('.picker-label-input').forEach(input => {
            input.addEventListener('input', () => {
                clearTimeout(labelDebounce);
                labelDebounce = setTimeout(() => {
                    const colKey = input.dataset.col;
                    const labelType = input.dataset.labeltype;
                    const val = input.value.trim();
                    if (val) state.columnLabels[labelType][colKey] = val;
                    else delete state.columnLabels[labelType][colKey];
                    saveColumnLabels();
                    onChange();
                    renderColumnPicker();
                }, 250);
            });
        });

        picker.querySelectorAll('input[data-section="desktop"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const colKey = cb.dataset.col;
                if (cb.checked) {
                    if (!state.visibleColumns.includes(colKey)) state.visibleColumns.push(colKey);
                } else {
                    state.visibleColumns = state.visibleColumns.filter(k => k !== colKey);
                    state.columnOrder = state.columnOrder.filter(k => k !== colKey);
                }
                syncColumnOrder();
                saveVisibleColumns();
                saveColumnOrder();
                onChange();
            });
        });

        picker.querySelectorAll('input[data-section="mobile"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const colKey = cb.dataset.col;
                if (cb.checked) {
                    if (!state.mobileColumns.includes(colKey)) state.mobileColumns.push(colKey);
                } else {
                    state.mobileColumns = state.mobileColumns.filter(k => k !== colKey);
                }
                saveMobileColumns();
                onChange();
            });
        });

        picker.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                switch (btn.dataset.act) {
                    case 'deskAll':
                        state.visibleColumns = tableCols.map(c => c.key);
                        break;
                    case 'deskNone': {
                        const keepCol = tableCols.find(c => c.key === alwaysOnKeyFn()) || tableCols[0];
                        state.visibleColumns = keepCol ? [keepCol.key] : [];
                        break;
                    }
                    case 'deskDefaults':
                        loadVisibleColumns();
                        state.columnOrder = [];
                        break;
                    case 'mobAll':
                        state.mobileColumns = tableCols.map(c => c.key);
                        break;
                    case 'mobNone': {
                        const keepCol = tableCols.find(c => c.key === alwaysOnKeyFn()) || tableCols[0];
                        state.mobileColumns = keepCol ? [keepCol.key] : [];
                        break;
                    }
                    case 'mobDefaults':
                        state.mobileColumns = tableCols.filter(c => defaultMobileKeysFn().includes(c.key)).map(c => c.key);
                        break;
                    case 'resetLabels':
                        state.columnLabels = { desktop: {}, mobile: {} };
                        saveColumnLabels();
                        break;
                }
                syncColumnOrder();
                saveVisibleColumns();
                saveColumnOrder();
                saveMobileColumns();
                onChange();
                renderColumnPicker();
            });
        });
    }

    // --------------------------------------------------------
    // RESIZE & DRAG
    // --------------------------------------------------------

    function initResizeHandles(thead, tableElementId, onResizingChange = () => {}) {
        thead.querySelectorAll('.resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault(); e.stopPropagation();
                onResizingChange(true);
                const th = handle.closest('th');
                const colKey = handle.dataset.col;
                const startX = e.pageX;
                const startWidth = th.offsetWidth;
                const table = document.getElementById(tableElementId);
                table?.classList.add('resizable');
                thead.querySelectorAll('th[data-col]').forEach(t => {
                    if (!t.style.width) t.style.width = t.offsetWidth + 'px';
                });

                function onMove(e) {
                    const minW = colKey === 'rank' ? 16 : 50;
                    const newW = Math.max(minW, startWidth + e.pageX - startX);
                    th.style.width = newW + 'px';
                    state.columnWidths[colKey] = newW;
                }
                function onUp() {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    saveColumnWidths();
                    setTimeout(() => onResizingChange(false), 0);
                }
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    function initColumnDrag(thead) {
        let dragColKey = null;
        const table = thead.closest('table');

        thead.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('dragstart', (e) => {
                if (e.target.closest('.resize-handle')) { e.preventDefault(); return; }
                dragColKey = th.dataset.col;

                const labelText = th.querySelector('.th-label')?.textContent?.trim() || th.dataset.col;
                const ghost = document.createElement('div');
                ghost.className = 'col-drag-ghost';
                ghost.innerHTML = `<span class="col-drag-ghost-icon">⠿</span><span>${labelText}</span>`;
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
                requestAnimationFrame(() => ghost.remove());

                th.classList.add('col-drag-source');
                table?.classList.add('col-drag-active');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', dragColKey);
            });

            th.addEventListener('dragend', () => {
                dragColKey = null;
                table?.classList.remove('col-drag-active');
                thead.querySelectorAll('th').forEach(t => t.classList.remove('col-drag-source', 'drop-before', 'drop-after'));
            });

            th.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!dragColKey || th.dataset.col === dragColKey) return;
                const rect = th.getBoundingClientRect();
                const insertAfter = e.clientX > rect.left + rect.width / 2;
                thead.querySelectorAll('th').forEach(t => t.classList.remove('drop-before', 'drop-after'));
                th.classList.add(insertAfter ? 'drop-after' : 'drop-before');
            });

            th.addEventListener('dragleave', (e) => {
                if (!th.contains(e.relatedTarget)) {
                    th.classList.remove('drop-before', 'drop-after');
                }
            });

            th.addEventListener('drop', (e) => {
                e.preventDefault();
                const insertAfter = th.classList.contains('drop-after');
                table?.classList.remove('col-drag-active');
                thead.querySelectorAll('th').forEach(t => t.classList.remove('col-drag-source', 'drop-before', 'drop-after'));

                const fromKey = e.dataTransfer.getData('text/plain');
                const toKey = th.dataset.col;
                if (!fromKey || fromKey === toKey) return;

                const keys = getOrderedVisibleCols().map(c => c.key);
                const fi = keys.indexOf(fromKey);
                if (fi === -1) return;
                keys.splice(fi, 1);
                const newTi = keys.indexOf(toKey);
                if (newTi === -1) return;
                keys.splice(insertAfter ? newTi + 1 : newTi, 0, fromKey);

                state.columnOrder = keys;
                saveColumnOrder();
                onChange();

                setTimeout(() => {
                    const landed = document.querySelector(`th[data-col="${fromKey}"]`);
                    if (landed) {
                        landed.classList.add('drop-flash');
                        landed.addEventListener('animationend', () => landed.classList.remove('drop-flash'), { once: true });
                    }
                }, 16);
            });
        });
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
        getColLabel, syncColumnOrder, getOrderedVisibleCols,
        renderColumnPicker, initResizeHandles, initColumnDrag,
    };
}

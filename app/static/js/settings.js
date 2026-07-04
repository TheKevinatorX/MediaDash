// ################################
// # SETTINGS PAGE                #
// ################################

const SettingsDash = (() => {
    //======
    // STATE
    //======
    let _tokenHint = '';
    let _tokenVisible = false;
    let _tmdbKeyHint = '';
    let _tmdbKeyVisible = false;
    let _excludedShows = [];

    //=====================
    // DOM & STATUS HELPERS
    //=====================
    function _el(id) { return document.getElementById(id); }

    const STATUS_ICONS = {
        ok: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
        testing: '<div class="spinner spinner-sm"></div>',
    };

    // Render a status banner into any element (by id)
    function _renderStatus(elId, msg, type) {
        const el = _el(elId);
        if (!el) return;
        el.style.display = 'flex';
        el.className = 'settings-status status-' + type;
        el.innerHTML = (STATUS_ICONS[type] || '') + '<span>' + escapeHTML(msg) + '</span>';
    }

    function _showStatus(msg, type)           { _renderStatus('settingsStatusMsg', msg, type); }
    function _showNamingStatus(msg, type)     { _renderStatus('namingRulesStatusMsg', msg, type); }
    function _showIntegrationsStatus(msg, type) { _renderStatus('integrationsStatusMsg', msg, type); }

    function _hideStatus() {
        const el = _el('settingsStatusMsg');
        if (el) el.style.display = 'none';
    }

    function _setLoading(loading) {
        const testBtn = _el('settingsTestBtn');
        const saveBtn = _el('settingsSaveBtn');
        if (testBtn) testBtn.disabled = loading;
        if (saveBtn) saveBtn.disabled = loading;
    }

    //==============
    // LOAD SETTINGS
    //==============
    function _loadSettings() {
        return fetch('/api/settings')
            .then(r => r.json())
            .then(data => {
                _tokenHint = data.plex_token_hint || '';

                const urlEl = _el('settingsPlexUrl');
                const tokenEl = _el('settingsPlexToken');
                const sourceEl = _el('settingsSource');

                if (urlEl) urlEl.value = data.plex_url || '';
                if (tokenEl) {
                    tokenEl.placeholder = _tokenHint
                        ? 'Current: ' + _tokenHint + '  (leave blank to keep)'
                        : 'Enter your Plex token';
                }

                _tmdbKeyHint = data.tmdb_api_key_hint || '';
                const tmdbEl = _el('settingsTmdbKey');
                if (tmdbEl) {
                    tmdbEl.placeholder = _tmdbKeyHint
                        ? 'Current: ' + _tmdbKeyHint + '  (leave blank to keep)'
                        : 'Enter your TMDB API key';
                }
                if (sourceEl) {
                    const fromFile = data.source === 'file';
                    sourceEl.innerHTML = `<span class="settings-source-badge ${fromFile ? 'source-file' : 'source-env'}">${fromFile ? 'Settings file' : 'Environment variable'}</span>`;
                }

                _applyNamingSettings(data);
            })
            .catch(err => {
                _showStatus('Failed to load settings: ' + err.message, 'error');
            });
    }

    function _applyNamingSettings(data) {
        const epFmt  = data.episode_format || 'NxEE';
        const padded = data.season_dir_zero_pad ? '1' : '0';
        const tol    = String(data.year_tolerance ?? 1);
        const repl   = data.special_char_replacement ?? ' - ';

        const epFmtEl = _el(epFmt === 'SxxExx' ? 'epFmtSxxExx' : 'epFmtNxEE');
        if (epFmtEl) epFmtEl.checked = true;

        const padEl = _el(padded === '1' ? 'seasonPadOn' : 'seasonPadOff');
        if (padEl) padEl.checked = true;

        const tolEl = _el(tol === '0' ? 'yearTol0' : 'yearTol1');
        if (tolEl) tolEl.checked = true;

        const replEl = _el('specialCharReplacement');
        if (replEl) replEl.value = repl;

        _excludedShows = Array.isArray(data.excluded_shows) ? [...data.excluded_shows] : [];
        _renderExcludedTags();

        _updateFormatPreviews();
    }

    //====================
    // EXCLUDED SHOWS TAGS
    //====================
    function _renderExcludedTags() {
        const container = _el('excludedShowsTags');
        const emptyEl   = _el('excludedShowsEmpty');
        if (!container) return;

        const existing = container.querySelectorAll('.excluded-tag');
        existing.forEach(el => el.remove());

        if (_excludedShows.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        _excludedShows.forEach(show => {
            const tag = document.createElement('span');
            tag.className = 'excluded-tag';
            tag.innerHTML = `<span class="excluded-tag-label">${escapeHTML(show)}</span><button class="excluded-tag-remove" type="button" aria-label="Remove ${escapeHTML(show)}">&times;</button>`;
            tag.querySelector('.excluded-tag-remove').addEventListener('click', () => {
                _excludedShows = _excludedShows.filter(s => s !== show);
                _renderExcludedTags();
            });
            container.appendChild(tag);
        });
    }

    function _addExcludedShow() {
        const input = _el('excludedShowInput');
        if (!input) return;
        const val = input.value.trim();
        if (!val) return;
        const lower = val.toLowerCase();
        if (_excludedShows.some(s => s.toLowerCase() === lower)) {
            input.value = '';
            return;
        }
        _excludedShows.push(val);
        _excludedShows.sort((a, b) => a.localeCompare(b));
        input.value = '';
        _renderExcludedTags();
    }

    //=======================
    // NAMING FORMAT PREVIEWS
    //=======================
    function _updateFormatPreviews() {
        const epFmtSxx = _el('epFmtSxxExx');
        const seasonPadOn = _el('seasonPadOn');
        const epPreview = _el('epFormatPreview');
        const seasonPreview = _el('seasonDirPreview');

        if (epPreview) {
            const fmt = (epFmtSxx && epFmtSxx.checked) ? 'S01E01' : '1x01';
            epPreview.textContent = `Show (Year) - ${fmt} - Episode Title.ext`;
        }
        if (seasonPreview) {
            seasonPreview.textContent = (seasonPadOn && seasonPadOn.checked) ? 'Season 01' : 'Season 1';
        }
    }

    //=============
    // VERSION INFO
    //=============
    function _loadVersion() {
        return fetch('/api/version')
            .then(r => r.json())
            .then(data => {
                const versionEl = _el('settingsVersion');
                if (versionEl && (data.display || data.version)) {
                    versionEl.textContent = data.display || ('v' + data.version);
                    if (data.is_dev && data.version && data.version !== 'dev') {
                        versionEl.title = 'Local development build based on v' + data.version;
                    }
                }
            })
            .catch(() => {});
    }

    //============
    // SAVE & TEST
    //============
    // POST JSON to /api/settings and return { ok, data }
    function _postSettings(body) {
        return fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json().then(data => ({ ok: r.ok, data })));
    }

    function _submitSettings(testOnly) {
        const urlEl = _el('settingsPlexUrl');
        const tokenEl = _el('settingsPlexToken');

        const plex_url = (urlEl ? urlEl.value : '').trim();
        const plex_token = (tokenEl ? tokenEl.value : '').trim();

        if (!plex_url) {
            _showStatus('Please enter a Plex server URL.', 'error');
            return;
        }
        if (!plex_url.startsWith('http://') && !plex_url.startsWith('https://')) {
            _showStatus('URL must start with http:// or https://', 'error');
            return;
        }
        if (!plex_token && !_tokenHint) {
            _showStatus('Please enter a Plex token.', 'error');
            return;
        }

        _setLoading(true);
        _showStatus(testOnly ? 'Testing connection…' : 'Saving and testing connection…', 'testing');

        _postSettings({ plex_url, plex_token, test_only: testOnly })
            .then(({ ok, data }) => {
                _setLoading(false);
                if (!ok) {
                    _showStatus(data.error || 'Request failed', 'error');
                    return;
                }
                const name = data.plex_name ? ' — connected to "' + data.plex_name + '"' : '';
                if (testOnly) {
                    _showStatus('Connection successful' + name, 'ok');
                } else {
                    _showStatus('Settings saved' + name + '. Connection active.', 'ok');
                    showToast('Settings saved successfully', 'success');
                    _loadSettings();
                    checkHealth();
                }
            })
            .catch(err => {
                _setLoading(false);
                _showStatus('Error: ' + err.message, 'error');
            });
    }

    function _submitNamingRules() {
        const epFmtSxx   = _el('epFmtSxxExx');
        const padOn      = _el('seasonPadOn');
        const tol1       = _el('yearTol1');
        const replEl     = _el('specialCharReplacement');
        const urlEl      = _el('settingsPlexUrl');
        const tokenEl    = _el('settingsPlexToken');

        const plex_url   = (urlEl ? urlEl.value : '').trim();
        const plex_token = (tokenEl ? tokenEl.value : '').trim();

        if (!plex_url || (!plex_token && !_tokenHint)) {
            _showNamingStatus('Plex connection settings are required — fill in Server URL and Token first.', 'error');
            return;
        }

        const payload = {
            plex_url,
            plex_token,
            episode_format:          epFmtSxx && epFmtSxx.checked ? 'SxxExx' : 'NxEE',
            season_dir_zero_pad:     !!(padOn && padOn.checked),
            year_tolerance:          (tol1 && tol1.checked) ? 1 : 0,
            special_char_replacement: replEl ? replEl.value : ' - ',
            excluded_shows:          [..._excludedShows],
        };

        const saveBtn = _el('namingRulesSaveBtn');
        if (saveBtn) saveBtn.disabled = true;
        _showNamingStatus('Saving…', 'testing');

        _postSettings(payload)
            .then(({ ok, data }) => {
                if (saveBtn) saveBtn.disabled = false;
                if (!ok) {
                    _showNamingStatus(data.error || 'Save failed', 'error');
                    return;
                }
                _showNamingStatus('Naming rules saved. Refresh your libraries on the Naming page to re-check names.', 'ok');
                showToast('Naming rules saved', 'success');
                _updateFormatPreviews();
            })
            .catch(err => {
                if (saveBtn) saveBtn.disabled = false;
                _showNamingStatus('Error: ' + err.message, 'error');
            });
    }

    function _submitIntegrations() {
        const urlEl   = _el('settingsPlexUrl');
        const tokenEl = _el('settingsPlexToken');
        const tmdbEl  = _el('settingsTmdbKey');

        const plex_url   = (urlEl ? urlEl.value : '').trim();
        const plex_token = (tokenEl ? tokenEl.value : '').trim();
        const tmdb_key   = (tmdbEl ? tmdbEl.value : '').trim();

        if (!plex_url || (!plex_token && !_tokenHint)) {
            _showIntegrationsStatus('Plex connection settings are required — fill in Server URL and Token first.', 'error');
            return;
        }

        const payload = {
            plex_url,
            plex_token,
            tmdb_api_key: tmdb_key,
        };

        const saveBtn = _el('integrationsSaveBtn');
        if (saveBtn) saveBtn.disabled = true;
        _showIntegrationsStatus('Saving…', 'testing');

        _postSettings(payload)
            .then(({ ok, data }) => {
                if (saveBtn) saveBtn.disabled = false;
                if (!ok) {
                    _showIntegrationsStatus(data.error || 'Save failed', 'error');
                    return;
                }
                if (tmdbEl) tmdbEl.value = '';
                _showIntegrationsStatus('Integrations saved.', 'ok');
                showToast('Integrations saved', 'success');
                _loadSettings();
            })
            .catch(err => {
                if (saveBtn) saveBtn.disabled = false;
                _showIntegrationsStatus('Error: ' + err.message, 'error');
            });
    }

    //=======================
    // KEY VISIBILITY TOGGLES
    //=======================
    function _initKeyToggle(btnId, inputId, iconId, visibleRef, setVisible) {
        const btn   = _el(btnId);
        const input = _el(inputId);
        const icon  = _el(iconId);
        if (!btn || !input) return;

        btn.addEventListener('click', () => {
            const nowVisible = !visibleRef();
            setVisible(nowVisible);
            input.type = nowVisible ? 'text' : 'password';
            if (icon) {
                icon.innerHTML = nowVisible
                    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
                    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
            }
        });
    }

    function _initTokenToggle() {
        _initKeyToggle(
            'settingsTokenToggle', 'settingsPlexToken', 'tokenEyeIcon',
            () => _tokenVisible, v => { _tokenVisible = v; }
        );
        _initKeyToggle(
            'tmdbKeyToggle', 'settingsTmdbKey', 'tmdbKeyEyeIcon',
            () => _tmdbKeyVisible, v => { _tmdbKeyVisible = v; }
        );
    }

    //=====
    // INIT
    //=====
    function init() {
        _hideStatus();
        _loadSettings();
        _loadVersion();
        _initTokenToggle();

        const testBtn           = _el('settingsTestBtn');
        const saveBtn           = _el('settingsSaveBtn');
        const namingSaveBtn     = _el('namingRulesSaveBtn');
        const integrationsSaveBtn = _el('integrationsSaveBtn');

        if (testBtn) testBtn.addEventListener('click', () => _submitSettings(true));
        if (saveBtn) saveBtn.addEventListener('click', () => _submitSettings(false));
        if (namingSaveBtn) namingSaveBtn.addEventListener('click', _submitNamingRules);
        if (integrationsSaveBtn) integrationsSaveBtn.addEventListener('click', _submitIntegrations);

        const urlEl = _el('settingsPlexUrl');
        const tokenEl = _el('settingsPlexToken');
        [urlEl, tokenEl].forEach(el => {
            if (el) el.addEventListener('input', _hideStatus);
        });

        // Live-update format previews when naming rule radios change
        ['epFmtNxEE', 'epFmtSxxExx', 'seasonPadOff', 'seasonPadOn'].forEach(id => {
            const el = _el(id);
            if (el) el.addEventListener('change', _updateFormatPreviews);
        });

        // EXCLUDED SHOWS — add on button click or Enter key
        const addBtn   = _el('excludedShowAddBtn');
        const addInput = _el('excludedShowInput');
        if (addBtn)   addBtn.addEventListener('click', _addExcludedShow);
        if (addInput) addInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); _addExcludedShow(); }
        });
    }

    return { init };
})();

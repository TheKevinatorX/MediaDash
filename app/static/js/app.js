// ################################
// # SPA — APP SHELL AND ROUTER   #
// ################################

// ============================================================
// THEME TOGGLE — PERSIST PREFERENCE TO LOCALSTORAGE
// ============================================================

function initThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
    });
}

// ============================================================
// HAMBURGER MENU — MOBILE NAV DROPDOWN
// ============================================================

function initHamburgerMenu() {
    const btn = document.getElementById('hamburgerBtn');
    const actions = document.getElementById('headerActions');
    if (!btn || !actions) return;

    function isOpen() { return actions.classList.contains('menu-open'); }

    function openMenu() {
        actions.classList.add('menu-open');
        btn.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        actions.classList.remove('menu-open');
        btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        isOpen() ? closeMenu() : openMenu();
    });

    // CLOSE ON CLICK/TAP OUTSIDE
    document.addEventListener('click', (e) => {
        if (isOpen() && !actions.contains(e.target) && !btn.contains(e.target)) {
            closeMenu();
        }
    });

    // CLOSE AFTER NAVIGATING VIA A LINK IN THE MENU
    actions.addEventListener('click', (e) => {
        if (e.target.closest('a[href]')) {
            setTimeout(closeMenu, 120);
        }
    });

    // SWIPE GESTURE: SWIPE LEFT FROM RIGHT EDGE = OPEN; SWIPE RIGHT = CLOSE
    let txStart = 0, tyStart = 0;
    document.addEventListener('touchstart', (e) => {
        txStart = e.touches[0].clientX;
        tyStart = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (window.innerWidth > 640) return;
        const dx = e.changedTouches[0].clientX - txStart;
        const dy = e.changedTouches[0].clientY - tyStart;
        if (Math.abs(dy) > Math.abs(dx) * 1.2) return; // mostly vertical — ignore
        const fromRightEdge = txStart > window.innerWidth - 32;
        if (!isOpen() && fromRightEdge && dx < -40) { openMenu(); }
        else if (isOpen() && dx > 50) { closeMenu(); }
    }, { passive: true });
}

// ============================================================
// CACHE WARMING
// ============================================================

// Cache warming is intentionally user-triggered only.
// The Sync button calls /api/sync explicitly.

// ============================================================
// SPA ROUTER — HASH-BASED PAGE SWITCHER
// ============================================================

const PAGES = {
    home: {
        pageId: 'page-home',
        navId: 'nav-home',
        bnavId: 'bnav-home',
        init: () => HomeDash.init(),
    },
    naming: {
        pageId: 'page-naming',
        navId: 'nav-naming',
        bnavId: 'bnav-naming',
        init: () => NamingDash.init(),
    },
    size: {
        pageId: 'page-size',
        navId: 'nav-size',
        bnavId: 'bnav-size',
        init: () => SizeDash.init(),
    },
    settings: {
        pageId: 'page-settings',
        navId: 'nav-settings',
        bnavId: 'bnav-settings',
        init: () => SettingsDash.init(),
    },
};

const initialized = new Set();

function showPage(pageName) {
    const page = PAGES[pageName] || PAGES.home;

    for (const [name, cfg] of Object.entries(PAGES)) {
        const el = document.getElementById(cfg.pageId);
        const nav = document.getElementById(cfg.navId);
        const bnav = document.getElementById(cfg.bnavId);
        const isActive = name === pageName;

        if (el) el.style.display = isActive ? '' : 'none';
        if (nav) nav.classList.toggle('active', isActive);
        if (bnav) bnav.classList.toggle('active', isActive);
    }

    if (typeof HomeDash !== 'undefined') HomeDash.refreshSyncDisplay();

    if (!initialized.has(pageName)) {
        initialized.add(pageName);
        page.init();
    }
}

function getHashPage() {
    const hash = window.location.hash.replace('#', '').toLowerCase().trim();
    return PAGES[hash] ? hash : 'home';
}

window.addEventListener('hashchange', () => showPage(getHashPage()));

document.addEventListener('DOMContentLoaded', () => {
    initThemeToggle();
    initHamburgerMenu();
    showPage(getHashPage());
    if (typeof ProgressHub !== 'undefined') ProgressHub.init();
    if (typeof HomeDash !== 'undefined') HomeDash.updateSyncAge();
    setInterval(() => { if (typeof HomeDash !== 'undefined') HomeDash.refreshSyncDisplay(); }, 60000);
});

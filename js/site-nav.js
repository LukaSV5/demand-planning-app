/* site-nav.js — shared nav behaviour for all pages.
   1. Glass background on the top bar once the page has scrolled.
   2. On phones: a menu button opens the page links; on the dashboard a
      second button opens the sidebar sections. */
(function () {
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  ready(function () {
    var wrap = document.querySelector('.nav-wrapper');
    var nav  = wrap && wrap.querySelector('nav');
    if (!wrap || !nav) return;

    /* 1 — scrolled state. Some pages scroll an inner container rather than
       the window, so listen in the capture phase for any scroll. */
    function onScroll(e) {
      var t = e && e.target && e.target !== document ? e.target : document.scrollingElement;
      var y = (t && t.scrollTop) || window.scrollY || 0;
      wrap.classList.toggle('is-scrolled', y > 8);
    }
    document.addEventListener('scroll', onScroll, true);
    onScroll();

    /* 2a — page links menu */
    var burger = document.createElement('button');
    burger.type = 'button';
    burger.className = 'nav-burger';
    burger.setAttribute('aria-label', 'Open menu');
    burger.setAttribute('aria-expanded', 'false');
    burger.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
    nav.insertBefore(burger, nav.firstChild);
    function closeMenu() { nav.classList.remove('is-open'); burger.setAttribute('aria-expanded', 'false'); }
    burger.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !nav.classList.contains('is-open');
      nav.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) { if (!nav.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); document.body.classList.remove('sidebar-open'); } });

    /* 2b — dashboard sidebar drawer */
    var sidebar = document.querySelector('.app-shell .sidebar');
    if (sidebar) {
      var sec = document.createElement('button');
      sec.type = 'button';
      sec.className = 'nav-sections';
      sec.setAttribute('aria-label', 'Open sections');
      sec.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Sections';
      nav.insertBefore(sec, burger);
      var backdrop = document.createElement('div');
      backdrop.className = 'sidebar-backdrop';
      document.body.appendChild(backdrop);
      sec.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); document.body.classList.toggle('sidebar-open'); });
      backdrop.addEventListener('click', function () { document.body.classList.remove('sidebar-open'); });
      /* picking a section closes the drawer */
      sidebar.addEventListener('click', function (e) {
        if (e.target.closest('.sidebar-item')) document.body.classList.remove('sidebar-open');
      });
    }
  });
})();

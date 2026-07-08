// ── I18N Engine ─────────────────────────────────────────
const I18N = (() => {
  let lang = 'en';
  let data = {};

  const SUPPORTED = ['en', 'zh'];

  function detectLang() {
    const saved = localStorage.getItem('poleduel_lang');
    if (saved && SUPPORTED.includes(saved)) return saved;
    return 'en';
  }

  async function init(initialLang) {
    lang = initialLang || detectLang();
    const ok = await loadLang(lang);
    if (!ok) {
      lang = 'en';
      await loadLang('en');
    }
    applyToDOM();
  }

  async function loadLang(l) {
    try {
      const res = await fetch(`/static/i18n/${l}.json?v=20260704`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      return true;
    } catch (e) {
      console.error(`Failed to load i18n/${l}.json`, e);
      return false;
    }
  }

  function t(key, params) {
    let val = data[key];
    if (val === undefined || val === null) return key;
    if (params) {
      Object.keys(params).forEach(k => {
        val = val.replace(`{${k}}`, params[k]);
      });
    }
    return val;
  }

  function applyToDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key);
      if (val) el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = t(key);
      if (val) el.placeholder = val;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const val = t(key);
      if (val) el.title = val;
    });
    document.documentElement.lang = lang;
  }

  async function switchLang(l) {
    if (l === lang || !SUPPORTED.includes(l)) return;
    const ok = await loadLang(l);
    if (!ok) return;
    lang = l;
    localStorage.setItem('poleduel_lang', l);
    applyToDOM();
    if (typeof window._onLangChange === 'function') {
      window._onLangChange(l);
    }
  }

  function getLang() { return lang; }

  function getCategoryKey(cat) {
    const map = {
      'General': 'category_general',
      'Sports': 'category_sports',
      'World': 'category_world',
      'Technology': 'category_technology',
      'Economy': 'category_economy',
      'Environment': 'category_environment',
      'Science': 'category_science',
      'Society': 'category_society'
    };
    return map[cat] ? t(map[cat]) : cat;
  }

  return { init, t, switchLang, getLang, getCategoryKey, applyToDOM };
})();

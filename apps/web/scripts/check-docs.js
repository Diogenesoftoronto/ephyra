// Evaluate in the served /docs page. Clipboard APIs are stubbed locally; no system clipboard or provider is used.
(async () => {
  const checks = [];
  const check = (name, condition) => { checks.push({ name, passed: Boolean(condition) }); };
  const frame = () => new Promise(resolve => {
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
  });
  await document.fonts.ready;
  await frame(); // Let viewport/media-query changes settle before checking responsive controls.
  const sections = [...document.querySelectorAll('[data-doc-id]')];
  const search = document.querySelector('#docs-search');
  const results = document.querySelector('#docs-results');
  const setSearch = value => { search.value = value; search.dispatchEvent(new Event('input', { bubbles: true })); };
  const previousQuery = search.value;
  const previousHash = location.hash;
  check('all ten topics are rendered', sections.length === 10 && sections.every(section => section.getBoundingClientRect().height > 0));
  check('one document heading', document.querySelectorAll('h1').length === 1);
  check('all local anchors resolve', [...document.querySelectorAll('a[href^="#"]')]
    .every(link => document.getElementById(link.getAttribute('href').slice(1))));
  check('page has no horizontal overflow', document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check('search enhancement loaded', !document.querySelector('.docs-search').hidden);
  if (matchMedia('(max-width: 54rem)').matches) {
    const menu = document.querySelector('.docs-menu');
    check('mobile contents start collapsed', !menu.open);
    menu.querySelector('summary').click();
    check('native mobile contents opens', menu.open);
    document.querySelector('[data-doc-link="trails"]').click(); await frame();
    check('choosing a topic closes mobile contents', !menu.open && location.hash === '#trails');
  }
  setSearch('proof');
  check('body search finds proof requirements', [...results.querySelectorAll('a')].some(link => link.getAttribute('href') === '#proof'));
  setSearch('uncached-nonexistent-zzzz');
  check('no-result state is useful', results.querySelectorAll('a').length === 0 && results.textContent.includes('Try'));
  setSearch('<img src=x onerror=alert(1)>');
  check('search text is never HTML', !results.querySelector('img,script'));
  setSearch('budgets');
  const budgetLink = [...results.querySelectorAll('a')].find(link => link.getAttribute('href') === '#budgets');
  budgetLink?.click(); await frame();
  check('search result navigates and transfers focus', location.hash === '#budgets' && document.activeElement?.id === 'budgets');
  check('search clears after choosing a result', search.value === '' && results.hidden);
  check('scroll position updates the contents', document.querySelector('[data-doc-link][aria-current]')?.getAttribute('href') === '#budgets');

  const button = document.querySelector('.docs-copy');
  const code = button.closest('.docs-code').querySelector('code').textContent;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let copied;
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
    button.click(); await frame();
    check('copy passes exact command bytes', copied === code && button.textContent === 'Copied');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Test permission denial'); } } });
    button.click(); await frame();
    check('denied clipboard selects actual code', getSelection().toString() === code && button.textContent === 'Code selected');
    check('denied clipboard announces a truthful fallback', document.querySelector('#docs-announcement').textContent.includes('unavailable'));
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else delete navigator.clipboard;
    getSelection()?.removeAllRanges();
  }

  const themeButton = document.querySelector('#docs-theme');
  const originalTheme = document.documentElement.dataset.theme;
  let oldPreference;
  try { oldPreference = localStorage.getItem('ephyra-docs-theme'); } catch { oldPreference = undefined; }
  const themes = new Set();
  for (let i = 0; i < 3; i++) { themeButton.click(); themes.add(themeButton.textContent); }
  check('all three theme choices work', themes.size === 3 && document.documentElement.dataset.theme === originalTheme);
  try {
    if (oldPreference === null) localStorage.removeItem('ephyra-docs-theme');
    else if (oldPreference !== undefined) localStorage.setItem('ephyra-docs-theme', oldPreference);
  } catch { /* A denied preference store does not invalidate current-page theming. */ }
  setSearch(previousQuery);
  history.replaceState(null, '', location.pathname + location.search + previousHash);
  scrollTo(0, 0); await frame();
  check('code remains independently scrollable', [...document.querySelectorAll('.docs-code pre')]
    .every(pre => getComputedStyle(pre).overflowX === 'auto' && pre.tabIndex === 0));
  const failures = checks.filter(item => !item.passed);
  return { passed: checks.length - failures.length, failed: failures.length, width: innerWidth, height: innerHeight,
    theme: document.documentElement.dataset.theme ?? 'system', checks, scope: 'Public docs UI with a stubbed clipboard; no provider or account flow.' };
})()

// Evaluate in any served documentation page. Clipboard APIs are stubbed locally; no system clipboard or provider is used.
(async () => {
  const checks = [];
  const check = (name, condition) => { checks.push({ name, passed: Boolean(condition) }); };
  const frame = () => new Promise(resolve => {
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
  });
  const until = async (condition, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return true; await frame(); } return false; };
  await document.fonts.ready;
  await frame(); // Let viewport/media-query changes settle before checking responsive controls.
  const guide = document.querySelector('.docs-guide');
  const base = guide.dataset.docsBase;
  const search = document.querySelector('#docs-search');
  const results = document.querySelector('#docs-results');
  const setSearch = value => { search.value = value; search.dispatchEvent(new Event('input', { bubbles: true })); };
  check('one document heading', document.querySelectorAll('h1').length === 1);
  check('the page list marks exactly this page', document.querySelectorAll('.docs-nav-group a[aria-current="page"]').length === 1);
  check('all local anchors resolve', [...document.querySelectorAll('a[href^="#"]')]
    .every(link => document.getElementById(link.getAttribute('href').slice(1))));
  check('page has no horizontal overflow', document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check('search enhancement loaded', !document.querySelector('.docs-search').hidden);
  if (matchMedia('(max-width: 60rem)').matches) {
    const menu = document.querySelector('.docs-menu');
    check('mobile page list starts collapsed', !menu.open);
    menu.querySelector('summary').click();
    check('native mobile page list opens', menu.open);
    menu.querySelector('summary').click();
  }
  setSearch('stale decision');
  check('search finds the troubleshooting section for a symptom', await until(() => [...results.querySelectorAll('a')]
    .some(link => link.getAttribute('href').startsWith(`${base}/troubleshooting`))));
  check('a result names its page and marks the match', Boolean(results.querySelector('a span')?.textContent && results.querySelector('a mark')));
  setSearch('uncached-nonexistent-zzzz');
  check('no-result state is useful', await until(() => results.querySelectorAll('a').length === 0 && results.textContent.includes('Try')));
  setSearch('<img src=x onerror=alert(1)>');
  await frame();
  check('search text is never HTML', !results.querySelector('img,script'));
  setSearch('');
  await frame();
  check('clearing the search hides the results', results.hidden);

  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let copied;
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
    const pageButton = document.querySelector('[data-copy-markdown]');
    pageButton.click();
    check('copy page puts this page\'s Markdown on the clipboard', await until(() => copied?.startsWith(`# ${document.querySelector('h1').textContent}`)
      && pageButton.textContent === 'Copied as Markdown'));
    copied = undefined;
    document.querySelector('[data-copy-text]').click();
    check('copy a prompt names the agent brief', await until(() => copied?.includes('/agent.md')));
    const button = document.querySelector('.docs-copy');
    if (button) {
      const code = button.closest('.docs-code').querySelector('code').textContent;
      button.click(); await frame();
      check('copy passes exact example bytes', copied === code && button.textContent === 'Copied');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Test permission denial'); } } });
      await new Promise(resolve => setTimeout(resolve, 2600));
      button.click(); await frame();
      check('denied clipboard selects the example', getSelection().toString() === code && button.textContent === 'Selected');
      check('denied clipboard announces a truthful fallback', document.querySelector('#docs-announcement').textContent.includes('unavailable'));
    }
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
  check('code remains independently scrollable', [...document.querySelectorAll('.docs-code:not([data-language="prompt"]) pre')]
    .every(pre => getComputedStyle(pre).overflowX === 'auto' && pre.tabIndex === 0));
  const failures = checks.filter(item => !item.passed);
  return { passed: checks.length - failures.length, failed: failures.length, width: innerWidth, height: innerHeight,
    theme: document.documentElement.dataset.theme ?? 'system', failures: failures.map(item => item.name),
    scope: 'Public docs UI with a stubbed clipboard; no provider or account flow.' };
})()

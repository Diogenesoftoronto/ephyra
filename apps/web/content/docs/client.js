// Progressive enhancement only: every page, its anchors and its code are complete without JavaScript.
const guide = document.querySelector('.docs-guide');
const base = guide?.dataset.docsBase ?? '';
const searchArea = document.querySelector('.docs-search');
const search = document.querySelector('#docs-search');
const results = document.querySelector('#docs-results');
const status = document.querySelector('#docs-result-status');
const menu = document.querySelector('.docs-menu');
const tocLinks = [...document.querySelectorAll('[data-doc-link]')];
const narrow = matchMedia('(max-width: 60rem)');
const announcement = document.querySelector('#docs-announcement');
const announce = text => { if (announcement) announcement.textContent = text; };

// The guide used to be one page. Its old section links (/docs#policy) go to the page that replaced the section.
const MOVED = { 'getting-started': 'quickstart', trails: 'concepts', reference: 'api', 'agent-setup': 'agent-setup',
  connections: 'connections', policy: 'policy', proof: 'proof', 'study-evidence': 'study-evidence',
  'landing-watch': 'landing-watch', budgets: 'budgets', 'self-hosting': 'self-hosting' };
const wanted = location.hash.slice(1);
if (guide?.dataset.docsSlug === 'index' && MOVED[wanted] && !document.getElementById(wanted)) location.replace(`${base}/${MOVED[wanted]}`);

if (menu) {
  const adaptMenu = () => { menu.open = !narrow.matches; };
  adaptMenu();
  narrow.addEventListener('change', adaptMenu);
}

// Search reads one index of every section of every page, fetched the first time it is needed.
let index;
const loadIndex = () => index ??= fetch(`${base}/search.json`).then(response => response.ok ? response.json() : [])
  .then(entries => entries.map(entry => ({ ...entry, lower: entry.text.toLocaleLowerCase(), head: `${entry.page} ${entry.title}`.toLocaleLowerCase() })))
  .catch(() => []);

function snippet(entry, terms) {
  const at = Math.max(0, ...terms.map(term => entry.lower.indexOf(term)).filter(position => position >= 0).slice(0, 1));
  const start = Math.max(0, at - 40);
  const text = (start ? '…' : '') + entry.text.slice(start, start + 120).trim() + (entry.text.length > start + 120 ? '…' : '');
  const small = document.createElement('small');
  let rest = text;
  while (rest) {
    const lower = rest.toLocaleLowerCase();
    const hits = terms.map(term => [lower.indexOf(term), term.length]).filter(([position]) => position >= 0).sort((a, b) => a[0] - b[0]);
    if (!hits.length) { small.append(rest); break; }
    const [position, length] = hits[0];
    small.append(rest.slice(0, position));
    const mark = document.createElement('mark');
    mark.textContent = rest.slice(position, position + length);
    small.append(mark);
    rest = rest.slice(position + length);
  }
  return small;
}

async function searchDocs() {
  const query = search.value.trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const list = results.querySelector('ul');
  results.hidden = !terms.length;
  if (!terms.length) { list.replaceChildren(); status.textContent = ''; return; }
  const entries = await loadIndex();
  if (search.value.trim().toLocaleLowerCase() !== query) return; // A newer keystroke owns the list.
  const matches = entries.filter(entry => terms.every(term => entry.lower.includes(term) || entry.head.includes(term)))
    .map(entry => ({ entry, score: terms.reduce((sum, term) => sum + (entry.head.includes(term) ? 10 : 0) + (entry.url.includes('#') ? 0 : 2), 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 8);
  list.replaceChildren();
  status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'result' : 'results'}`
    : 'Nothing found. Try “stuck”, “approve”, “policy” or a command name.';
  for (const { entry } of matches) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = entry.url;
    const where = document.createElement('span'); where.textContent = entry.page;
    const title = document.createElement('b'); title.textContent = entry.title;
    link.append(where, title, snippet(entry, terms));
    item.append(link);
    list.append(item);
  }
}

if (searchArea && search && results && status) {
  searchArea.hidden = false;
  search.addEventListener('focus', loadIndex, { once: true });
  search.addEventListener('input', searchDocs);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') { const first = results.querySelector('a'); if (first) { event.preventDefault(); location.assign(first.href); } }
    if (event.key === 'ArrowDown') { const first = results.querySelector('a'); if (first) { event.preventDefault(); first.focus(); } }
  });
  results.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...results.querySelectorAll('a')];
    const at = links.indexOf(document.activeElement);
    event.preventDefault();
    if (event.key === 'ArrowUp' && at <= 0) search.focus(); else links[Math.min(links.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
  });
  document.addEventListener('keydown', event => {
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (menu && narrow.matches) menu.open = false;
      search.focus();
    }
    if (event.key === 'Escape' && results.contains(document.activeElement)) search.focus();
    if (event.key === 'Escape' && document.activeElement === search && search.value) {
      event.preventDefault(); search.value = ''; searchDocs();
    }
  });
}

// "On this page" follows the reader.
const headings = tocLinks.map(link => document.getElementById(link.dataset.docLink)).filter(Boolean);
function setCurrent(id) {
  for (const link of tocLinks) {
    if (link.dataset.docLink === id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
const updateCurrent = () => {
  const current = headings.filter(heading => heading.getBoundingClientRect().top <= 140).at(-1);
  setCurrent(current?.id ?? '');
};
if (headings.length) {
  let scrollPending = false;
  document.addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => { updateCurrent(); scrollPending = false; });
  }, { passive: true });
  window.addEventListener('hashchange', updateCurrent);
  updateCurrent();
}

/** Copy, and say truthfully what happened: a denied clipboard selects the text instead of claiming success. */
async function copy(text, button, labels, fallback) {
  const original = button.dataset.label ??= button.textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    button.textContent = labels.done; button.dataset.done = '';
    announce(labels.announce);
  } catch {
    fallback?.();
    button.textContent = labels.denied;
    announce(labels.deniedAnnounce);
  }
  window.setTimeout(() => { button.textContent = original; delete button.dataset.done; }, 2500);
}
const select = node => () => {
  const range = document.createRange(); range.selectNodeContents(node);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
};

for (const button of document.querySelectorAll('.docs-copy')) {
  button.hidden = false;
  button.addEventListener('click', () => {
    const code = button.closest('.docs-code').querySelector('code');
    copy(code.textContent, button, { done: 'Copied', announce: 'Copied to the clipboard.', denied: 'Selected',
      deniedAnnounce: 'Clipboard access is unavailable. The text is selected so you can copy it.' }, select(code));
  });
}

// The page as Markdown, for pasting into an agent. If it cannot be fetched or copied, open it instead.
for (const button of document.querySelectorAll('[data-copy-markdown]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const url = button.dataset.copyMarkdown;
    let markdown;
    try { const response = await fetch(url); if (response.ok) markdown = await response.text(); } catch { /* handled below */ }
    if (markdown === undefined) { location.assign(url); return; }
    copy(markdown, button, { done: 'Copied as Markdown', announce: 'This page was copied as Markdown. Paste it into your agent.',
      denied: 'Opening Markdown…', deniedAnnounce: 'Clipboard access is unavailable. Opening the Markdown version instead.' }, () => location.assign(url));
  });
}
for (const button of document.querySelectorAll('[data-copy-text]')) {
  button.hidden = false;
  button.addEventListener('click', () => copy(button.dataset.copyText, button, { done: 'Prompt copied',
    announce: 'A prompt for your agent was copied.', denied: 'Copy unavailable',
    deniedAnnounce: 'Clipboard access is unavailable. Use the Markdown link instead.' }));
}

const themeButton = document.querySelector('#docs-theme');
if (themeButton) {
  const allowed = ['system', 'light', 'dark'];
  let theme = 'system';
  try { const stored = localStorage.getItem('ephyra-docs-theme'); if (allowed.includes(stored)) theme = stored; } catch { /* Preferences are optional. */ }
  const applyTheme = () => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    themeButton.textContent = `Theme: ${theme}`;
    themeButton.setAttribute('aria-label', `Color theme: ${theme}. Change theme.`);
  };
  applyTheme(); themeButton.hidden = false;
  themeButton.addEventListener('click', () => {
    theme = allowed[(allowed.indexOf(theme) + 1) % allowed.length];
    applyTheme();
    try { localStorage.setItem('ephyra-docs-theme', theme); } catch { /* The current-page choice still works. */ }
  });
}

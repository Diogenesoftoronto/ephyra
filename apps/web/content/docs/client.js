// Progressive enhancement only: the complete guide, anchors and code remain available without JavaScript.
const searchArea = document.querySelector('.docs-search');
const search = document.querySelector('#docs-search');
const results = document.querySelector('#docs-results');
const status = document.querySelector('#docs-result-status');
const menu = document.querySelector('.docs-menu');
const sections = [...document.querySelectorAll('[data-doc-id]')];
const navLinks = [...document.querySelectorAll('[data-doc-link]')];
const narrow = matchMedia('(max-width: 54rem)');
const announcement = document.querySelector('#docs-announcement');

if (menu) {
  const adaptMenu = () => { menu.open = !narrow.matches; };
  adaptMenu();
  narrow.addEventListener('change', adaptMenu);
}

const index = sections.map(section => ({
  id: section.dataset.docId,
  title: section.querySelector('h2').textContent.trim(),
  summary: section.dataset.docSummary,
  text: section.textContent.toLocaleLowerCase(),
}));

function searchGuide() {
  const query = search.value.trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const list = results.querySelector('ul');
  list.replaceChildren();
  results.hidden = !terms.length;
  if (!terms.length) { status.textContent = ''; return; }
  const matches = index.filter(section => terms.every(term => section.text.includes(term)));
  status.textContent = matches.length ? `${matches.length} matching ${matches.length === 1 ? 'section' : 'sections'}`
    : 'No matching sections. Try “policy”, “proof” or “hosting”.';
  for (const match of matches) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${match.id}`;
    link.textContent = match.title;
    const summary = document.createElement('small');
    summary.textContent = match.summary;
    link.addEventListener('click', () => {
      search.value = '';
      searchGuide();
      document.getElementById(match.id)?.focus({ preventScroll: true });
    });
    item.append(link, summary);
    list.append(item);
  }
}

if (searchArea && search && results && status) {
  searchArea.hidden = false;
  search.addEventListener('input', searchGuide);
  document.addEventListener('keydown', event => {
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); search.focus();
    }
    if (event.key === 'Escape' && document.activeElement === search && search.value) {
      event.preventDefault(); search.value = ''; searchGuide();
    }
  });
}

function setCurrent(id) {
  for (const link of navLinks) {
    if (link.dataset.docLink === id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

for (const link of navLinks) link.addEventListener('click', () => {
  setCurrent(link.dataset.docLink);
  if (narrow.matches) menu.open = false;
});

const updateCurrent = () => {
  const current = sections.filter(section => section.getBoundingClientRect().top <= 160).at(-1) ?? sections[0];
  if (current) setCurrent(current.dataset.docId);
};
let scrollPending = false;
document.addEventListener('scroll', () => {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => { updateCurrent(); scrollPending = false; });
}, { passive: true });
window.addEventListener('hashchange', updateCurrent);
updateCurrent();

for (const button of document.querySelectorAll('.docs-copy')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = button.closest('.docs-code').querySelector('code');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      announcement.textContent = 'Code copied to the clipboard.';
    } catch {
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      button.textContent = 'Code selected';
      announcement.textContent = 'Clipboard access is unavailable. The code is selected so you can copy it.';
    }
    window.setTimeout(() => { button.textContent = 'Copy'; }, 2500);
  });
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

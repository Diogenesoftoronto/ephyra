// Same-origin, local-only app build. Only named scenes cross the frame boundary.
const frames = new Map();
function sync(frame, scene) {
  const theme = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  frame.contentWindow?.postMessage({ type: 'ephyra:tour', scene, theme }, location.origin);
}
export function showProductScreen(container, scene, { interactive = false } = {}) {
  let frame = container.querySelector('iframe[data-product-frame]');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.dataset.productFrame = '';
    frame.title = interactive ? 'Ephyra application · interactive sample' : 'Ephyra application · guided preview';
    // The page owns scrolling until the reader deliberately opens the interactive view.
    frame.inert = !interactive;
    if (!interactive) { frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); }
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = `/e/app/walkthrough.html?scene=${encodeURIComponent(scene)}`;
    frame.addEventListener('load', () => sync(frame, frames.get(frame)));
    container.replaceChildren(frame);
  }
  frames.set(frame, scene);
  sync(frame, scene);
}
export function readProductScreen(scene, title, note = 'Sample data · actual application') {
  const reader = document.querySelector('.screen-dialog');
  reader.classList.add('gui-reading');
  reader.querySelector('h2').textContent = title;
  reader.querySelector('.screen-heading p').textContent = note;
  reader.querySelector('pre').hidden = true;
  const surface = reader.querySelector('.gui-reader');
  surface.hidden = false;
  showProductScreen(surface, scene, { interactive: true });
  if (!reader.open) reader.showModal();
}
addEventListener('message', event => {
  if (event.origin !== location.origin || event.data?.type !== 'ephyra:tour-ready') return;
  for (const [frame, scene] of frames) if (event.source === frame.contentWindow) sync(frame, scene);
});
const showcase = document.querySelector('[data-product-tour]');
if (showcase) {
  const choices = [...showcase.querySelectorAll('[data-product-scene]')];
  const surface = showcase.querySelector('.product-tour-screen');
  const caption = showcase.querySelector('.product-tour-caption');
  const explore = showcase.querySelector('.product-tour-explore');
  let selected = choices[0];
  const choose = button => {
    selected = button;
    choices.forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
    caption.textContent = button.dataset.description;
    showProductScreen(surface, button.dataset.productScene);
  };
  explore.addEventListener('click', () => readProductScreen(selected.dataset.productScene, selected.textContent));
  choices.forEach((button, i) => {
    button.addEventListener('click', () => choose(button));
    button.addEventListener('keydown', event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
      choices[index].focus({ preventScroll: true }); choose(choices[index]);
    });
  });
  choose(choices[0]);
}

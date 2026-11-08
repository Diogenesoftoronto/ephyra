// Same-origin, local-only app build. Only named scenes cross the frame boundary.
const frames = new Map();
function sync(frame, scene) {
  const theme = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  frame.contentWindow?.postMessage({ type: 'ephyra:tour', scene, theme }, location.origin);
}
export function showProductScreen(container, scene) {
  let frame = container.querySelector('iframe[data-product-frame]');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.dataset.productFrame = '';
    frame.title = 'Ephyra application · interactive sample';
    frame.loading = 'lazy';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = `/e/app/walkthrough.html?scene=${encodeURIComponent(scene)}`;
    frame.addEventListener('load', () => sync(frame, frames.get(frame)));
    container.replaceChildren(frame);
  }
  frames.set(frame, scene);
  sync(frame, scene);
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
  const choose = button => {
    choices.forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
    caption.textContent = button.dataset.description;
    showProductScreen(surface, button.dataset.productScene);
  };
  choices.forEach((button, i) => {
    button.addEventListener('click', () => choose(button));
    button.addEventListener('keydown', event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
      choices[index].focus(); choose(choices[index]);
    });
  });
  choose(choices[0]);
}

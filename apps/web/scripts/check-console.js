// Evaluate in the served landing page. Tests the same-origin app walkthrough, page scroll and details dialog.
// Check at 1440x900, 390x844 and 320x640, with normal and reduced motion.
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label) => {
    for (let i = 0; i < 150; i++) { if (read()) return; await wait(100); }
    throw new Error(`Timed out: ${label}`);
  };
  await document.fonts.ready;
  await until(() => document.querySelector('.tour.live'), 'walkthrough data');
  const steps = [...document.querySelectorAll('.step')];
  const compact = matchMedia('(max-width: 69.99rem) and (max-height: 700px)').matches;
  const split = matchMedia('(min-width: 70rem)').matches;
  const frame = () => document.querySelector('#gui-panel iframe');
  const scene = () => frame()?.contentDocument?.querySelector('[data-tour-scene]')?.dataset.tourScene;
  const results = [];
  const settle = async id => {
    await until(() => scene() === id && (id === 'triaged'
      ? frame().contentDocument.querySelector('.trail-head')
      : frame().contentDocument.querySelector('[data-tour-focus]')), id);
    await wait(250);
  };
  for (const index of [...steps.keys(), ...steps.keys()].map((n, i) => i < steps.length ? n : steps.length - 1 - n)) {
    const step = steps[index], id = step.dataset.step;
    let expected;
    if (compact) {
      let current = steps.findIndex(s => s.classList.contains('is-on'));
      while (current !== index) {
        document.querySelector(current < index ? '.term-next' : '.term-prev').click();
        current += current < index ? 1 : -1;
      }
      expected = scrollY;
    } else {
      const term = document.querySelector('.term');
      const top = document.querySelector('.bar').offsetHeight + document.querySelector('.console-switch').offsetHeight + (split ? 8 : 16);
      const bottom = top + term.offsetHeight;
      const line = split ? innerHeight * .5 : bottom + (innerHeight - bottom) * .25;
      expected = Math.round(scrollY + step.querySelector('h3').getBoundingClientRect().top - line + 8);
      scrollTo({ top: expected, behavior: 'instant' });
    }
    await settle(id);
    assert(Math.abs(scrollY - expected) <= 2, `${id}: page jumped ${scrollY - expected}px`);
    assert(step.getAttribute('aria-current') === 'step', `${id}: story and app disagree`);
    const rect = frame().getBoundingClientRect();
    assert(frame().inert && getComputedStyle(frame()).pointerEvents === 'none', `${id}: preview captures page gestures`);
    assert(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) !== frame(), `${id}: iframe captures pointer`);
    if (!compact && !split) {
      assert(step.querySelector('h3').getBoundingClientRect().top > document.querySelector('.term').getBoundingClientRect().bottom,
        `${id}: sticky preview covers the active heading`);
    }
    results.push({ id, y: scrollY, drift: scrollY - expected });
  }
  // A direct arrow selection settles on the same step instead of immediately bouncing back.
  document.querySelector('.term-next').click();
  await settle('hypothesis');
  const arrowY = scrollY;
  await wait(1200);
  assert(scene() === 'hypothesis' && scrollY === arrowY, 'Next bounces back');
  document.querySelector('.term-read').click();
  const dialog = document.querySelector('.screen-dialog');
  await until(() => dialog.open && dialog.querySelector('iframe')?.contentDocument?.querySelector('.trail-head'), 'details dialog');
  assert(!dialog.querySelector('iframe').inert, 'details cannot be explored');
  dialog.close();
  await wait(1200);
  assert(Math.abs(scrollY - arrowY) <= 2, 'closing details loses page position');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page overflows horizontally');
  return { viewport: [innerWidth, innerHeight], reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    compact, checks: results.length, maxDrift: Math.max(...results.map(r => Math.abs(r.drift))), results };
})()

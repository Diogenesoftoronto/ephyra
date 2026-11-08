// Evaluate in the shared browser. The sample uses local fictional adapters only.
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const until = async (read, message) => {
    for (let i = 0; i < 150; i++) { if (read()) return; await wait(100); }
    throw new Error(message);
  };
  const showcase = document.querySelector('[data-product-tour]');
  showcase.scrollIntoView({ block: 'start', behavior: 'instant' });
  const frame = showcase.querySelector('iframe');
  await until(() => frame.contentDocument.querySelector('h1'), 'initial workspace missing');
  await frame.contentDocument.fonts.ready;
  const y = scrollY, results = [];
  for (const button of showcase.querySelectorAll('[data-product-scene]')) {
    button.click();
    await until(() => frame.contentDocument.querySelector('[data-tour-scene]')?.dataset.tourScene === button.dataset.productScene
      && frame.contentWindow.location.hash === `#/${button.dataset.productScene}`, 'scene not selected');
    await wait(1200);
    assert(scrollY === y, `${button.dataset.productScene}: tab change moved page by ${scrollY-y}px`);
    const overflow = frame.contentDocument.documentElement.scrollWidth - frame.clientWidth;
    assert(overflow <= 1, `${button.dataset.productScene}: content clips by ${overflow}px`);
    assert(frame.inert, 'inline sample captures input');
    results.push({ scene: button.dataset.productScene, heading: frame.contentDocument.querySelector('h1')?.textContent, overflow });
  }
  // The reader is interactive and returns focus and position to its opener.
  const opener = showcase.querySelector('.product-tour-explore');
  opener.focus({ preventScroll: true }); opener.click();
  const dialog = document.querySelector('.screen-dialog');
  await until(() => dialog.open && dialog.querySelector('iframe')?.contentDocument?.querySelector('h1'), 'explorer missing');
  const explorer = dialog.querySelector('iframe');
  assert(!explorer.inert, 'explorer is not interactive');
  assert(dialog.getBoundingClientRect().bottom <= innerHeight, 'dialog close/content outside viewport');
  assert(explorer.contentDocument.documentElement.scrollWidth <= explorer.clientWidth + 1, 'explorer clips');
  dialog.close(); await wait(1200);
  assert(scrollY === y && document.activeElement === opener, 'closing explorer loses position or focus');
  const child = frame.contentWindow;
  child.dispatchEvent(new child.MessageEvent('message', {
    origin: 'https://other.example', source: window, data: { type: 'ephyra:tour', scene: 'overview' },
  }));
  await wait(200);
  assert(frame.contentDocument.querySelector('[data-tour-scene]')?.dataset.tourScene === 'team', 'foreign origin changed scene');
  return { viewport: [innerWidth, innerHeight], checks: results.length, results };
})()

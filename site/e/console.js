// A guided graphical presentation of the exact fixture used by the terminal walkthrough.
// Every result comes from the exported trail/events. The buttons navigate the sample; they never call the server.
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const code = (value) => `<code>${escape(value)}</code>`;
const pill = (text, tone = '') => `<span class="g-pill ${tone}">${escape(text)}</span>`;
const action = (text, step, primary = false) =>
  `<button type="button" class="g-button${primary ? ' primary' : ''}" data-preview-go="${step}">${escape(text)}</button>`;
const event = (events, type) => events.find((item) => item.type === type)?.data;
const clock = (at) => new Date(at).toLocaleTimeString('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit' });
const words = (text) => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>');
const documentBody = (text) => text.replace(/^# [^\n]+\n?/, '').trim().split(/\n\s*\n/).map((part) => {
  if (part.startsWith('## ')) {
    const [heading, ...rows] = part.split('\n');
    return `<h5>${escape(heading.slice(3))}</h5>${rows.map((line) => `<p>${words(line.replace(/^- /, '• '))}</p>`).join('')}`;
  }
  if (/^1\. /.test(part)) return `<ol>${part.split('\n').map((line) => `<li>${words(line.replace(/^\d+\. /, ''))}</li>`).join('')}</ol>`;
  return `<p>${words(part).replace(/\n/g, '<br>')}</p>`;
}).join('');

function rail(id) {
  const selected = { triaged: 0, hypothesis: 1, explain: 1, revise: 1, plan: 2, proof: 3, watching: 4, set: 5, rollback: 4 }[id];
  return `<ol class="g-rail" aria-label="Quest progress">${['Signal', 'A · Cause', 'B · Plan', 'C · Proof', 'Landed', 'Set'].map((label, i) =>
    `<li class="${i === selected ? 'current' : i < selected ? 'done' : ''}"><span>${i < selected ? '✓' : i === selected ? '●' : '○'}</span>${label}</li>`).join('')}</ol>`;
}

const toolNames = { review: 'Review', evidence: 'Evidence', files: 'Files', activity: 'Activity', discuss: 'Discuss' };
const icons = {
  review: '<path d="M9 3H6a2 2 0 0 0-2 2v15h16V5a2 2 0 0 0-2-2h-3M9 2h6v4H9ZM8 13l3 3 5-6"/>',
  evidence: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M8 10.5h5M10.5 8v5"/>',
  files: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5"/>',
  activity: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  discuss: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 8 8 0 0 1 8-8h2a8 8 0 0 1 8 8ZM7 10h10M7 14h6"/>',
};
function toolbox(selected) {
  return `<nav class="g-toolbox" aria-label="Quest tools">${Object.entries(toolNames).map(([tool, label]) =>
    `<button type="button" data-console-tool="${tool}" aria-pressed="${tool === selected}" aria-controls="gui-tool-content" title="${label}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[tool]}</svg><span>${label}</span></button>`).join('')}</nav>`;
}

function inspectEvidence(id, data, events) {
  if (id === 'rollback') {
    const regression = event(events, 'probe_regressed_after_landing');
    return heading('Watch evidence', 'The signal that triggered the revert.')
      + `<div class="g-regression"><p>${escape(regression.criterion)}</p></div><p class="g-inspector-note">Recorded in ${code(regression.evidence)}.</p>`;
  }
  const evidence = event(events, 'research_completed') ? data.gui.evidence : data.gui.evidence.slice(0, 1);
  return heading('Evidence', 'Follow the source.', pill(`${evidence.length} ${evidence.length === 1 ? 'source' : 'sources'}`))
    + evidenceRows(evidence) + (evidence.length === 1 ? '<p class="g-inspector-note">Research has not completed at this point in the quest.</p>' : '');
}

function inspectFiles(id, data, events) {
  const entries = [];
  if (id !== 'rollback' && event(events, 'research_completed')) entries.push(['hypothesis.md', data.gui.hypothesis]);
  if (id !== 'rollback' && event(events, 'plan_completed')) entries.push(['plan.md', data.gui.plan]);
  const proof = event(events, 'proof_completed')?.bundle;
  const scope = proof?.items.find((item) => item.kind === 'diff_scope');
  const documents = entries.map(([path, body]) => `<details class="g-file-document"><summary>${code(path)}<span>Read document</span></summary><div class="g-document">${documentBody(body)}</div></details>`).join('');
  const changed = scope ? `<h5 class="g-file-heading">Changed in revision ${proof.rev}</h5><ul class="g-file-list">${scope.paths.map((path) => `<li>${code(path)}</li>`).join('')}</ul><p class="g-inspector-note">${scope.lines} lines changed. This sample includes the file paths and proof summary; it does not include a source diff.</p>` : '';
  if (!documents && !changed) return heading('Quest files', 'No documents at this step.') + '<p class="g-inspector-note">The quest keeps its hypothesis, plan, and proof in git as the investigation progresses. Use Activity to inspect what has happened so far.</p>';
  return heading('Quest files', 'The work stays with the quest.') + documents + changed;
}

function inspectActivity(events) {
  const labels = {
    trail_created: 'Quest opened', triage_completed: 'Triage completed', research_completed: 'Hypothesis written',
    repro_completed: 'Repro completed', plan_completed: 'Plan written', human_comment: 'Comment added',
    patch_completed: 'Patch completed', proof_completed: 'Proof recorded', landing_completed: 'Fix landed',
    watch_started: 'Production watch started', watch_completed: 'Production watch completed',
    probe_regressed_after_landing: 'Regression detected', rollback_completed: 'Fix reverted',
  };
  return heading('Activity', 'Every decision, in order.', pill(`${events.length} events`))
    + `<ol class="g-activity">${events.map((entry) => {
      const label = entry.type === 'checkpoint_decided'
        ? `Checkpoint ${entry.data.checkpoint}: ${entry.data.decision.verdict}` : labels[entry.type] ?? entry.type.replaceAll('_', ' ');
      return `<li><time datetime="${escape(entry.at)}">${clock(entry.at)}</time><div><h5>${escape(label)}</h5><p>${escape(entry.actor.kind)} · ${escape(entry.actor.id)}</p>${entry.type === 'human_comment' ? `<blockquote>${escape(entry.data.text)}</blockquote>` : ''}
        <details><summary>Inspect event</summary><pre>${escape(JSON.stringify(entry.data, null, 2))}</pre></details></div></li>`;
    }).join('')}</ol>`;
}

const recordedComments = (events) => events.filter((entry) => entry.type === 'human_comment');
const localControl = (room) => !room?.claimed ? 'No local review claim.'
  : room.isOwner ? 'You hold the demo review.' : 'Another tab holds the demo review.';

function roomPreview(events, room, reader) {
  const recorded = recordedComments(events).at(-1);
  const count = recordedComments(events).length + (room?.comments.length ?? 0);
  return `<aside class="g-room-preview" aria-label="Shared quest discussion"><div class="g-room-preview-copy">
    <span class="g-room-preview-label">${recorded ? 'Reviewer · recorded sample' : 'Shared quest'}</span>
    ${recorded ? `<p>${escape(recorded.data.text)}</p>` : '<p>Keep questions and handoffs beside the work.</p>'}
    ${room?.claimed ? `<span class="g-room-preview-control">${localControl(room)}</span>` : ''}</div>
    ${reader ? `<span>${count} ${count === 1 ? 'note' : 'notes'}</span>` : `<button type="button" class="g-button g-discuss-open" data-console-tool="discuss">Discuss${count ? ` · ${count}` : ''}</button>`}</aside>`;
}

/** Render recorded comments and optional local-browser notes. It never creates or sends a message. */
export function renderDiscussion(events, room = null, { reader = false, draft = '' } = {}) {
  const recorded = recordedComments(events);
  const notes = room?.comments ?? [];
  const messages = recorded.map((entry) => `<li class="g-room-message recorded" data-room-message-id="recorded-${escape(entry.id)}">
    <span class="g-room-avatar" aria-hidden="true">R</span><div><header><b>Reviewer</b><span>Recorded sample · ${clock(entry.at)}</span></header><p>${escape(entry.data.text)}</p></div></li>`)
    .concat(notes.map((entry) => `<li class="g-room-message local" data-room-message-id="local-${escape(entry.id)}">
      <span class="g-room-avatar" aria-hidden="true">${entry.authorId === room.viewerId ? 'Y' : 'T'}</span><div><header><b>${entry.authorId === room.viewerId ? 'You' : 'Another local tab'}</b><span>Local note · ${clock(entry.at)}</span></header><p>${escape(entry.text)}</p></div></li>`));
  const scope = room ? 'Local demo, in this browser only. No messages are sent to a server.'
    : 'Recorded sample conversation. Local notes are available in the interactive walkthrough.';
  const status = room?.persistence === 'memory' ? '<p class="g-room-storage">Browser storage is unavailable. Notes in this tab will be lost when it closes.</p>' : '';
  return `<section class="g-room" aria-label="Quest discussion">
    ${heading('Discuss', 'The quest is shared.', pill('Local demo'))}
    <p class="g-room-scope">${scope}</p>${status}
    <div class="g-room-control"><div><b>${localControl(room)}</b><p>Demo controls only. No agent is started or stopped.</p></div>
      ${room && !reader ? `<button type="button" class="g-button" data-room-action="${room.isOwner ? 'release' : 'claim'}">${room.isOwner ? 'Release review' : 'Claim review'}</button>` : ''}</div>
    <ol class="g-room-messages" aria-label="Recorded and local notes">${messages.join('')}</ol>
    ${messages.length ? '' : '<p class="g-room-empty">No comments recorded at this step. Add a local note to try the shared discussion.</p>'}
    ${room && !reader ? `<form class="g-room-form" data-room-trail="${escape(room.trailId)}"><label for="gui-room-note">Leave a local note</label>
      <textarea id="gui-room-note" name="note" data-room-draft="${escape(room.trailId)}" maxlength="1000" rows="3" required placeholder="What should the next person know?">${escape(draft)}</textarea>
      <div class="g-room-compose-actions"><span>Up to 1,000 characters. Agents do not reply in this demo.</span><button type="submit" class="g-button primary">Add note</button></div>
      <p class="g-room-feedback" role="status" aria-live="polite"></p></form>` : ''}
    <p class="g-room-update" role="status" aria-live="polite"></p>
  </section>`;
}
function heading(label, title, meta = '') {
  return `<div class="g-section-head"><div><span class="g-label">${escape(label)}</span><h4>${escape(title)}</h4></div>${meta}</div>`;
}
function evidenceRows(evidence) {
  return `<div class="g-evidence">${evidence.map((item) => `<article><span class="g-source">${escape(item.source)}</span>
    <div><h5>${escape(item.title)}</h5><p>${escape(item.snippet)}</p></div></article>`).join('')}</div>`;
}
function proofRows(bundle) {
  if (!bundle) return '<p>Proof is not available at this step.</p>';
  const before = bundle.items.find((item) => item.kind === 'repro_before');
  const after = bundle.items.find((item) => item.kind === 'repro_after');
  const comparison = `<div class="g-repro"><div><span>On main</span><b class="g-bad">${escape(before?.result ?? 'Unavailable')}</b></div>
    <span class="g-repro-arrow" aria-hidden="true">→</span><div><span>With the patch</span><b class="g-good">${escape(after?.result ?? 'Unavailable')}</b></div></div>`;
  const rows = bundle.items.flatMap((item) => {
    switch (item.kind) {
      case 'tests': return [['Tests', `${item.passed} passed · ${item.failed} failed · ${item.newFailures} new failures`, item.failed === 0]];
      case 'regression_probes': return [['Regression probes', `${item.ran.length} checked · ${item.failed.length} failed`, item.failed.length === 0]];
      case 'intent_probes': return [['Intent probes', `${item.ran.length} checked · ${item.failed.length} failed`, item.failed.length === 0]];
      case 'traffic_replay': return [['Traffic replay', `${item.diffs} diffs · ${item.unexplained} unexplained`, item.unexplained === 0]];
      case 'diff_scope': return [['Changed', `${item.files} files · ${item.lines} lines${item.exportedTypesChanged ? '' : ' · exported types unchanged'}`, null]];
      case 'bug_review': return [['Review', `${item.findings.length ? `${item.findings.length} findings` : 'No findings'} (${item.reviewer})`, item.findings.length === 0]];
      default: return [];
    }
  });
  const scope = bundle.items.find((item) => item.kind === 'diff_scope');
  return comparison + `<dl class="g-proof-list">${rows.map(([label, value, ok]) => `<div><dt><span class="${ok === false ? 'g-bad' : 'g-good'}" aria-hidden="true">${ok == null ? '·' : ok ? '✓' : '!'}</span>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`
    + (scope ? `<details class="g-files"><summary>Inspect the ${scope.files} changed files</summary>${scope.paths.map((path) => `<p>${code(path)}</p>`).join('')}</details>` : '');
}
function landing(events, settled) {
  const receipt = event(events, 'landing_completed')?.receipt;
  const watch = event(events, 'watch_started')?.config;
  const result = event(events, 'watch_completed');
  return heading(settled ? 'Watch complete' : 'Landing receipt', settled ? 'The fix has set.' : 'Landed. Now watching.', pill(settled ? 'Closed' : 'Watching', 'accepted'))
    + `<div class="g-receipt"><span class="g-receipt-icon" aria-hidden="true">✓</span><div><h5>${escape(receipt?.externalId ?? 'Landing')}</h5><p>${code(receipt?.target)}</p><p class="g-muted">Commit ${code(receipt?.newOid?.slice(0, 7))}</p></div></div>`
    + `<ol class="g-watch"><li class="done"><span class="g-watch-dot"></span><div><b>Fix landed</b><p>${receipt ? clock(receipt.at) : ''} · approval recorded at C</p></div></li>
      <li class="${settled ? 'done' : 'current'}"><span class="g-watch-dot"></span><div><b>${watch ? watch.windowS / 3600 : ''}-hour production watch</b><p>${escape(watch?.routes.join(', '))}</p></div></li>
      <li class="${settled ? 'done' : ''}"><span class="g-watch-dot"></span><div><b>${result ? `Watch ${escape(result.outcome)}` : 'Close after a clean watch'}</b><p>${settled ? 'The quest is closed. Its repro protects against regression.' : 'The quest stays open while production is being watched.'}</p></div></li></ol>`;
}

/** Pure renderer: no generated results, provider calls, account changes, or invented later events. */
export function renderConsole(id, data, { reader = false, tool = id === 'explain' ? 'evidence' : 'review', room = null, draft = '' } = {}) {
  if (!Object.hasOwn(toolNames, tool)) throw new Error(`Unknown console tool: ${tool}`);
  const sample = data.gui.moments[id];
  if (!sample) throw new Error(`No graphical walkthrough moment: ${id}`);
  const { trail, events } = sample;
  // A snapshot for another trail must never leak its local discussion into this one.
  if (room && room.trailId !== trail.id) room = null;
  const cp = { hypothesis: 'A', explain: 'A', revise: 'A', plan: 'B', proof: 'C' }[id];
  const waiting = cp ? pill(`${cp} · Waiting on you`, 'waiting') : pill(id === 'rollback' ? 'Reopened' : trail.state, id === 'rollback' ? 'undo' : 'accepted');
  let content = '', actions = '';
  if (id === 'triaged') {
    const triage = event(events, 'triage_completed')?.result;
    content = heading('Triage', 'An error worth following.')
      + `<div class="g-signal"><span class="g-signal-dot" aria-hidden="true"></span><div><h5>${escape(data.gui.evidence[0].title)}</h5><p>${escape(data.gui.evidence[0].snippet)}</p></div></div>`
      + `<dl class="g-facts"><div><dt>Actionable</dt><dd>${Math.round(triage.actionable * 100)}%</dd></div><div><dt>Risk</dt><dd>${escape(triage.risk)}</dd></div><div><dt>Route</dt><dd>${escape(triage.route.replaceAll('_', ' '))}</dd></div></dl>`
      + `<ul class="g-checks">${triage.reasons.map((reason) => `<li><span aria-hidden="true">✓</span>${escape(reason)}</li>`).join('')}</ul>`
      + `<p class="g-engine">Decision backend <code>${escape(triage.backends.decide)}</code></p>`;
    actions = action('Read the hypothesis →', 'hypothesis', true);
  } else if (id === 'hypothesis' || id === 'explain') {
    content = heading('Checkpoint A', 'Is this the right cause?', pill('hypothesis.md'))
      + `<div class="g-document">${documentBody(data.gui.hypothesis)}</div>`;
    actions = action('Approve hypothesis', 'plan', true) + action('See evidence', 'explain') + action('Ask for changes', 'revise');
  } else if (id === 'revise') {
    content = heading('Checkpoint A', 'Send it back with a note.')
      + `<blockquote class="g-excerpt">${words(data.gui.hypothesis.split('\n')[1])}</blockquote>`
      + `<div class="g-note"><label>Revision note<textarea rows="3" readonly>check the coupon path too</textarea></label><p>No code is written until someone approves the cause.</p></div>`;
    actions = action('Preview the plan →', 'plan', true) + action('Back to hypothesis', 'hypothesis');
  } else if (id === 'plan') {
    const repro = event(events, 'repro_completed');
    content = heading('Checkpoint B', 'Reproduced. Here’s the plan.', pill('plan.md'))
      + `<div class="g-repro-note"><span class="g-bad">Fails on main</span>${code(repro?.probe)}</div>`
      + `<div class="g-document">${documentBody(data.gui.plan)}</div>`;
    actions = action('Approve plan', 'proof', true);
  } else if (id === 'proof') {
    const proof = event(events, 'proof_completed')?.bundle;
    content = heading('Checkpoint C', 'Proof, before landing.', pill(`Revision ${trail.rev}`)) + proofRows(proof);
    actions = action('Approve and land', 'watching', true) + action('Review the plan', 'plan');
  } else if (id === 'watching' || id === 'set') {
    content = landing(events, id === 'set');
    actions = id === 'watching' ? action('See the watch result →', 'set', true) : action('What if it regresses?', 'rollback', true);
  } else if (id === 'rollback') {
    const regression = event(events, 'probe_regressed_after_landing');
    const receipt = event(events, 'rollback_completed')?.receipt;
    const landedAt = events.find((e) => e.type === 'landing_completed')?.at;
    const regressedAt = events.find((e) => e.type === 'probe_regressed_after_landing')?.at;
    const minutes = Math.round((Date.parse(regressedAt) - Date.parse(landedAt)) / 60000);
    content = heading('A different quest', 'A regression. Then a revert.', pill('Rolled back', 'undo'))
      + `<div class="g-regression"><b>${minutes} minutes after landing</b><p>${escape(regression?.criterion)}</p></div>`
      + `<dl class="g-proof-list"><div><dt>Revert commit</dt><dd>${code(receipt?.newOid?.slice(0, 7))}</dd></div><div><dt>Target</dt><dd>${code(receipt?.target)}</dd></div><div><dt>Evidence</dt><dd>${code(regression?.evidence)}</dd></div></dl>`
      + `<p class="g-next-revision">Back to research at revision ${trail.rev}. The failed attempt stays on the quest.</p>`;
    actions = action('Replay the example', 'triaged', true);
  }
  if (tool === 'evidence') content = inspectEvidence(id, data, events);
  if (tool === 'files') content = inspectFiles(id, data, events);
  if (tool === 'activity') content = inspectActivity(events);
  if (tool === 'discuss') content = renderDiscussion(events, room, { reader, draft });
  else content = roomPreview(events, room, reader) + content;
  return `<div class="g-workspace${reader ? ' g-workspace-reader' : ''}" data-gui-moment="${id}" data-gui-tool="${tool}"><header class="g-trail-head"><div class="g-trail-meta"><span>${escape(trail.short)}</span><span>${escape(trail.area)} · ${escape(trail.risk)} risk</span>${waiting}</div>
    <h3>${escape(trail.title)}</h3></header>${rail(id)}<div class="g-stage">${reader ? '' : toolbox(tool)}<div class="g-scroll" tabindex="0" aria-label="${toolNames[tool]} content"><div class="g-body" ${reader ? '' : 'id="gui-tool-content"'}>${content}</div></div></div>${reader ? '' : `<div class="g-actions">${actions}</div>`}</div>`;
}

// The selector shares the walkthrough's current step; it changes presentation only.
export function setupConsoleSelector(tour, onChange) {
  const choices = [...tour.querySelectorAll('[data-console-view]')];
  const invite = tour.querySelector('.terminal-invite');
  const note = tour.querySelector('.console-view-note');
  const switcher = tour.querySelector('.console-switch');
  const select = (view) => {
    if (!['gui', 'tui'].includes(view)) return;
    const invitationFocused = document.activeElement === invite;
    tour.dataset.consoleView = view;
    choices.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.consoleView === view)));
    invite.hidden = view === 'tui';
    note.hidden = view !== 'tui';
    if (invitationFocused) document.getElementById('tui-choice').focus({ preventScroll: true });
    onChange(view);
  };
  choices.forEach((button, index) => {
    button.addEventListener('click', () => select(button.dataset.consoleView));
    button.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const i = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - index;
      choices[i].focus({ preventScroll: true }); choices[i].click();
    });
  });
  invite.addEventListener('click', () => select('tui'));
  new ResizeObserver(() => tour.style.setProperty('--console-switch-h', `${switcher.offsetHeight}px`)).observe(switcher);
  select('gui');
}

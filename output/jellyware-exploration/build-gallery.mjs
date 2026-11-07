#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const serialized = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function validateManifest(manifest) {
  if (!manifest || typeof manifest.title !== 'string') throw new Error('Manifest needs a title.');
  if (manifest.axes?.x?.length !== 3 || manifest.axes?.y?.length !== 3) throw new Error('Archive axes must each contain three labels.');
  if (!Array.isArray(manifest.criteria) || manifest.criteria.length !== 6) throw new Error('Six assessment criteria are required.');
  if (manifest.criteria.some((criterion) => !criterion.name || !Number.isFinite(criterion.weight) || criterion.weight < 0)
    || manifest.criteria.every((criterion) => criterion.weight === 0)) throw new Error('Criterion weights must be nonnegative and total more than zero.');
  if (!Array.isArray(manifest.concepts) || !manifest.concepts.length) throw new Error('No generated concepts have been recorded yet.');
  const ids = new Set();
  for (const concept of manifest.concepts) {
    if (!concept.id || ids.has(concept.id)) throw new Error(`Duplicate or missing concept ID: ${concept.id}`);
    ids.add(concept.id);
    if (!Number.isInteger(concept.generation) || concept.generation < 1) throw new Error(`Invalid generation for ${concept.id}`);
    if (!concept.path || typeof concept.path !== 'string') throw new Error(`No image path for ${concept.id}`);
    if (concept.scores?.length !== 6 || concept.scores.some((score) => !Number.isFinite(score) || score < 0 || score > 5)) {
      throw new Error(`Six scores from zero to five are required for ${concept.id}`);
    }
    if (concept.cell?.length !== 2 || concept.cell.some((axis) => !Number.isInteger(axis) || axis < 0 || axis > 2)) {
      throw new Error(`Invalid archive cell for ${concept.id}`);
    }
  }
  return manifest;
}

export function weightedScore(concept, criteria) {
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  return concept.scores.reduce((sum, score, index) => sum + score * criteria[index].weight, 0) / total * 20;
}

export function archiveAt(manifest, generation) {
  const archive = new Map();
  for (const concept of manifest.concepts.filter((item) => item.generation <= generation)) {
    const key = concept.cell.join(':');
    const incumbent = archive.get(key);
    if (!incumbent || weightedScore(concept, manifest.criteria) > weightedScore(incumbent, manifest.criteria)) archive.set(key, concept);
  }
  return archive;
}

export function renderGallery(input) {
  const manifest = validateManifest(input);
  // Embed only descriptive data. Some HTML hosts inline every absolute image path they encounter,
  // including paths inside JSON; images therefore appear exactly once, in the static tile markup.
  const inlineManifest = {
    ...manifest,
    concepts: manifest.concepts.map(({ path, previewPath, ...concept }) => concept),
  };
  const generations = [...new Set(manifest.concepts.map((concept) => concept.generation))].sort((a, b) => a - b);
  const initial = generations.at(-1);
  const totalWeight = manifest.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const parentText = (parent) => Array.isArray(parent) ? parent.join(', ') : parent;
  const scores = (concept) => `<dl class="score-list">${manifest.criteria.map((criterion, i) =>
    `<div><dt>${escape(criterion.name)}</dt><dd><meter min="0" max="5" value="${concept.scores[i]}" aria-label="${escape(criterion.name)}"></meter><span>${concept.scores[i].toFixed(1)}<small> / 5</small></span></dd></div>`).join('')}</dl>`;
  const card = (concept) => `<article class="concept" id="concept-${escape(concept.id)}" data-concept="${escape(concept.id)}" data-generation="${concept.generation}" ${concept.generation === initial ? '' : 'hidden'}>
    <button class="image-button" type="button" data-open="${escape(concept.id)}" aria-label="Enlarge ${escape(concept.name)}">
      <img src="${escape(concept.previewPath ?? concept.path)}" alt="Generated interface concept: ${escape(concept.name)}" width="1536" height="1024" loading="lazy">
      <span class="enlarge">Enlarge ↗</span>
    </button>
    <div class="concept-info"><div class="concept-heading"><div><p class="concept-id">${escape(concept.id)}${concept.selected ? ' <span class="winner">Selected for implementation</span>' : ''}</p><h3>${escape(concept.name)}</h3></div><p class="fitness">${weightedScore(concept, manifest.criteria).toFixed(1)}<span> / 100</span></p></div>
    <p class="cell-label">${escape(manifest.axes.x[concept.cell[0]])} · ${escape(manifest.axes.y[concept.cell[1]])}</p>
    <p class="assessment">${escape(concept.assessment)}</p>
    ${concept.parent ? `<p class="lineage">From <b>${escape(parentText(concept.parent))}</b>${concept.mutation ? ` · ${escape(concept.mutation)}` : ''}</p>` : '<p class="lineage">Independent first-generation concept</p>'}
    <details class="score-details"><summary>Assessment breakdown</summary>${scores(concept)}</details></div>
  </article>`;
  const archive = archiveAt(manifest, initial);
  const archiveRows = manifest.axes.y.map((label, y) => `<tr><th scope="row">${escape(label)}</th>${manifest.axes.x.map((_, x) => {
    const elite = archive.get(`${x}:${y}`);
    return `<td data-cell="${x}:${y}">${elite ? `<button type="button" class="elite" data-open="${escape(elite.id)}"><span>${escape(elite.id)} · G${elite.generation}</span><b>${escape(elite.name)}</b><strong>${weightedScore(elite, manifest.criteria).toFixed(1)}<small> / 100</small></strong></button>` : '<span class="empty">Unoccupied</span>'}</td>`;
  }).join('')}</tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(manifest.title)}</title>
<style>
:root{color-scheme:light dark;--ink:var(--foreground,#173e3b);--muted:var(--muted-foreground,#476a65);--surface:var(--card,#f0f8f4);--wash:var(--secondary,#dfede7);--line:var(--border,#b5ccc3);--accent:var(--primary,#096357);--on-accent:var(--primary-foreground,#fff);--selected:var(--primary,#91601c);--shadow:0 12px 36px #0b332a20;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--ink)}body{line-height:1.5}button,input{font:inherit}button{cursor:pointer}button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}[hidden]{display:none!important}.exploration{max-width:1200px;padding:0 0 24px;margin:auto;background:transparent}h2,h3,p{margin:0}h2{font-size:1.25rem;font-weight:650;line-height:1.25}h3{font-size:1.1rem;font-weight:650;line-height:1.3}.intro{max-width:74ch;margin-top:0;font-size:1rem;color:var(--muted)}.method{margin-top:1rem;color:var(--muted);font-size:.85rem;max-width:82ch}.method b{color:var(--ink)}.generation-controls{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:2rem 0 1.5rem;padding-block:1rem;border-block:1px solid var(--line)}.generation-buttons{display:flex;gap:.35rem;flex-wrap:wrap}.generation-buttons button{border:0;border-radius:999px;padding:.65rem 1rem;min-height:44px;color:var(--muted);background:var(--wash);font-weight:600;font-size:.9rem}.generation-buttons button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}.generation-buttons button:hover{box-shadow:inset 0 0 0 2px var(--accent)}.generation-status{font-size:.85rem;color:var(--muted)}.archive-intro{margin:.4rem 0 1rem;color:var(--muted);font-size:.85rem}.map-scroll{overflow-x:auto;padding-bottom:.3rem}.elite-map{width:100%;border-collapse:separate;border-spacing:5px;table-layout:fixed;min-width:540px}.elite-map caption{text-align:left;color:var(--muted);font-size:.8rem;margin-bottom:.4rem}.elite-map th{font-size:.76rem;font-weight:600;color:var(--muted);text-align:left;padding:.3rem .4rem;vertical-align:middle}.elite-map th:first-child{width:20%}.elite-map td{padding:0;background:var(--surface);border-radius:10px;vertical-align:top;height:115px}.elite{border:0;color:var(--ink);background:transparent;text-align:left;padding:.8rem;width:100%;height:100%;display:flex;flex-direction:column;gap:.3rem;min-height:115px}.elite:hover{background:var(--wash);border-radius:10px}.elite span{font-size:.7rem;color:var(--muted)}.elite b{font-size:.85rem;font-weight:600}.elite strong{font-size:1rem;margin-top:auto;font-weight:650}.elite small{font-weight:400;color:var(--muted);font-size:.7rem}.empty{display:block;padding:.8rem;color:var(--muted);font-size:.8rem}.rubric{margin:1rem 0 2rem;font-size:.82rem;color:var(--muted)}summary{cursor:pointer;min-height:40px;padding:.55rem 0}.rubric ul{list-style:none;padding:0;display:flex;gap:.5rem 1.5rem;flex-wrap:wrap;margin:.5rem 0}.rubric li{display:flex;gap:.5rem}.rubric strong{color:var(--ink)}.gallery-heading{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:1rem}.gallery-heading p{font-size:.85rem;color:var(--muted)}.concepts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2rem 1.25rem}.concept{min-width:0;border-bottom:1px solid var(--line);padding-bottom:1.25rem}.image-button{display:block;width:100%;padding:0;border:0;border-radius:12px;position:relative;overflow:hidden;background:var(--wash);text-align:left}.image-button img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:contain}.enlarge{position:absolute;right:.65rem;bottom:.65rem;padding:.25rem .6rem;border-radius:999px;background:var(--surface);color:var(--ink);font-size:.72rem;box-shadow:0 2px 6px #0002}.image-button:hover .enlarge{background:var(--accent);color:var(--on-accent)}.concept-info{padding:.9rem .1rem 0}.concept-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:.7rem}.concept-id{font:500 .72rem/1.5 ui-monospace,monospace;color:var(--muted);margin-bottom:.3rem}.winner{display:inline-block;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.68rem;font-weight:600;color:var(--selected);margin-left:.5rem}.fitness{font-size:1.1rem;font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap}.fitness span{font-size:.7rem;font-weight:400;color:var(--muted)}.cell-label{font-size:.75rem;color:var(--muted);margin-top:.5rem}.assessment{font-size:.88rem;margin-top:.75rem}.lineage{font-size:.76rem;color:var(--muted);margin-top:.75rem}.lineage b{font-weight:600}.score-details{font-size:.8rem;margin-top:.3rem;color:var(--muted)}.score-list{margin:.5rem 0 0;display:grid;gap:.5rem}.score-list>div{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:1rem;align-items:center}.score-list dd{margin:0;display:flex;align-items:center;justify-content:flex-end;gap:.5rem;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--ink)}.score-list small{color:var(--muted)}meter{width:54px;height:7px;border:0;background:var(--wash);border-radius:999px}meter::-webkit-meter-bar{background:var(--wash);border:0;border-radius:999px}meter::-webkit-meter-optimum-value{background:var(--accent);border-radius:999px}meter::-moz-meter-bar{background:var(--accent);border-radius:999px}.detail{border:0;padding:0;max-width:min(96vw,1536px);width:96vw;max-height:900px;border-radius:14px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}.detail::backdrop{background:#0a211de6}.detail[open]{display:flex;flex-direction:column}.detail-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.2rem;border-bottom:1px solid var(--line);flex:none}.detail-head p{font-size:.75rem;color:var(--muted);margin-top:.2rem}.detail-close{border:0;border-radius:999px;min-height:44px;padding:.65rem 1rem;background:var(--wash);color:var(--ink);font-weight:600;flex:none}.detail-close:hover{background:var(--accent);color:var(--on-accent)}.detail-body{overflow:auto;overscroll-behavior:contain;padding:0 0 1.4rem}.detail-image{display:block;width:100%;height:auto}.detail-copy{padding:1.2rem;max-width:85ch}.detail-copy .score-list{margin-top:1rem}.detail-copy h3{margin-bottom:.6rem}.detail-copy>p{margin-top:.7rem;font-size:.9rem}.footer-note{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.8rem;color:var(--muted)}
@media(prefers-color-scheme:dark){:root{--ink:var(--foreground,#e1f1e9);--muted:var(--muted-foreground,#acc8bb);--surface:var(--card,#18392f);--wash:var(--secondary,#24493d);--line:var(--border,#3c6654);--accent:var(--primary,#9edac2);--on-accent:var(--primary-foreground,#0e3024);--selected:var(--primary,#efc581)}}
@media(max-width:620px){.exploration{padding:0 0 24px}.concepts{grid-template-columns:1fr}.elite-map{min-width:540px}.generation-controls{gap:.7rem}.generation-buttons button{padding:.6rem .8rem}.gallery-heading{align-items:start;flex-direction:column;gap:.35rem}.detail-head{padding:.8rem;align-items:start}.detail-head h2{font-size:1rem}.detail-close{padding:.5rem .8rem}.detail-copy{padding:.9rem}.score-list>div{grid-template-columns:minmax(0,1fr) 110px;gap:.6rem}}
</style></head><body><main class="exploration">
<header><p class="intro">${escape(manifest.description)}</p><p class="method"><b>Designer assessments, not a user study.</b> Scores compare inferred persona tasks. Presence and team interactions are proposed concepts, not live capabilities.</p></header>
<div class="generation-controls"><div class="generation-buttons" role="group" aria-label="Generation">${generations.map((generation) => `<button type="button" data-generation-choice="${generation}" aria-pressed="${generation === initial}">Generation ${generation}</button>`).join('')}</div><p class="generation-status" role="status" aria-live="polite"></p></div>
<section aria-labelledby="archive-heading"><h2 id="archive-heading">MAP-Elites archive</h2><p class="archive-intro">The best assessed concept in each cell, retained through the selected generation. Higher scores win within a cell; ties retain the earlier concept.</p><div class="map-scroll" tabindex="0" role="region" aria-label="MAP-Elites archive; scroll horizontally on small screens"><table class="elite-map"><caption>Columns: workspace topology. Rows: collaboration placement.</caption><thead><tr><th scope="col">Collaboration ↓<br>Workspace →</th>${manifest.axes.x.map((label) => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead><tbody>${archiveRows}</tbody></table></div>
<details class="rubric"><summary>How the assessment is weighted</summary><ul>${manifest.criteria.map((criterion) => `<li><span>${escape(criterion.name)}</span><strong>${Math.round(criterion.weight / totalWeight * 100)}%</strong></li>`).join('')}</ul><p>Each criterion is scored from 0 to 5. The weighted result is reported out of 100. Unoccupied cells are left open.</p></details></section>
<section aria-labelledby="gallery-heading"><div class="gallery-heading"><h2 id="gallery-heading">Generation ${initial} concepts</h2><p>Open an image to inspect the full interface.</p></div><div class="concepts">${manifest.concepts.map(card).join('')}</div></section>
<p class="footer-note">Generated visuals explore form and interaction. Any invented copy, numbers, names, or controls inside a raster concept are illustrative. Implementation must use the actual trail data and label sample-only interactions.</p>
</main><dialog class="detail" aria-labelledby="detail-title"><div class="detail-head"><div><h2 id="detail-title"></h2><p class="detail-subtitle"></p></div><button class="detail-close" type="button">Close</button></div><div class="detail-body"></div></dialog>
<script type="application/json" id="manifest-data">${serialized(inlineManifest)}</script>
<script>
(()=>{
  const data=JSON.parse(document.getElementById('manifest-data').textContent);
  const total=data.criteria.reduce((sum,c)=>sum+c.weight,0);
  const score=c=>c.scores.reduce((sum,s,i)=>sum+s*data.criteria[i].weight,0)/total*20;
  const cards=new Map([...document.querySelectorAll('[data-concept]')].map(card=>[card.dataset.concept,card]));
  const concepts=new Map(data.concepts.map(c=>[c.id,c]));
  const dialog=document.querySelector('.detail');
  let opener=null;
  function open(id,button){
    const concept=concepts.get(id),card=cards.get(id);if(!concept||!card)return;
    opener=button;
    document.getElementById('detail-title').textContent=concept.name;
    document.querySelector('.detail-subtitle').textContent=concept.id+' · Generation '+concept.generation+' · '+score(concept).toFixed(1)+'/100'+(concept.selected?' · Selected for implementation':'');
    const body=document.querySelector('.detail-body');body.replaceChildren();
    const source=card.querySelector('img');const img=source.cloneNode();img.className='detail-image';img.loading='eager';img.src=source.currentSrc||source.src;body.append(img);
    const copy=document.createElement('div');copy.className='detail-copy';
    const assessment=document.createElement('p');assessment.textContent=concept.assessment;copy.append(assessment);
    const lineage=card.querySelector('.lineage').cloneNode(true);copy.append(lineage);
    const scores=card.querySelector('.score-list').cloneNode(true);copy.append(scores);body.append(copy);
    dialog.showModal();body.scrollTop=0;document.querySelector('.detail-close').focus();
  }
  function select(generation){
    document.querySelectorAll('[data-generation-choice]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.generationChoice)===generation)));
    cards.forEach(card=>card.hidden=Number(card.dataset.generation)!==generation);
    const count=data.concepts.filter(c=>c.generation===generation).length;
    document.getElementById('gallery-heading').textContent='Generation '+generation+' concepts';
    const archive=new Map();
    for(const concept of data.concepts.filter(c=>c.generation<=generation)){
      const key=concept.cell.join(':'),incumbent=archive.get(key);
      if(!incumbent||score(concept)>score(incumbent))archive.set(key,concept);
    }
    document.querySelector('.generation-status').textContent=count+' concepts · '+archive.size+'/9 archive cells occupied';
    document.querySelectorAll('[data-cell]').forEach(cell=>{
      const concept=archive.get(cell.dataset.cell);cell.replaceChildren();
      if(!concept){const empty=document.createElement('span');empty.className='empty';empty.textContent='Unoccupied';cell.append(empty);return;}
      const button=document.createElement('button');button.type='button';button.className='elite';button.dataset.open=concept.id;
      const id=document.createElement('span');id.textContent=concept.id+' · G'+concept.generation;
      const name=document.createElement('b');name.textContent=concept.name;
      const fitness=document.createElement('strong');fitness.textContent=score(concept).toFixed(1);const unit=document.createElement('small');unit.textContent=' / 100';fitness.append(unit);
      button.append(id,name,fitness);cell.append(button);
    });
  }
  document.addEventListener('click',event=>{
    const generation=event.target.closest('[data-generation-choice]');if(generation){select(Number(generation.dataset.generationChoice));return;}
    const button=event.target.closest('[data-open]');if(button)open(button.dataset.open,button);
  });
  document.querySelector('.detail-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus({preventScroll:true});});
  select(${initial});
})();
</script></body></html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve(process.argv[2] ?? resolve(here, 'manifest.json'));
  const target = resolve(process.argv[3] ?? resolve(here, 'gallery.html'));
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  // Delivery copies keep the source PNGs and manifest intact. The dialog clones these static images,
  // so it also uses WebP after an embedder rewrites their src values to inlined data URLs.
  const concepts = await Promise.all(manifest.concepts.map(async (concept) => {
    const path = resolve(dirname(source), concept.path);
    const previewPath = concept.previewPath
      ? resolve(dirname(source), concept.previewPath) : path.replace(/\.png$/i, '.webp');
    try {
      await access(previewPath);
      return { ...concept, path, previewPath };
    } catch {
      return { ...concept, path, previewPath: undefined };
    }
  }));
  await writeFile(target, renderGallery({ ...manifest, concepts }));
  console.log(`${target}: ${manifest.concepts.length} concepts, ${new Set(manifest.concepts.map((c) => c.generation)).size} generations`);
}

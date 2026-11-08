import type { RunVisual } from "@ephyra/core";

/** Fictional visual for Storybook/demo only. It is not an agent result or test proof. */
export const demoRunVisual: RunVisual = {
  id: "rounding-explanation", title: "Inspect the rounding change", height: 400,
  html: `<style>
body{line-height:1.55}h2{font-size:clamp(22px,4vw,30px);margin:0 0 10px;letter-spacing:-.025em}
.note{font-size:12px;opacity:.7;margin:0 0 12px}label{display:grid;gap:10px;margin-top:24px}
.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:24px 0}
.comparison>div{border:1px solid var(--border);border-radius:12px;padding:16px}.amount{font-size:30px;font-weight:700;display:block}
.after{background:color-mix(in srgb,var(--accent) 12%,transparent)}button{padding:8px 14px;border:1px solid var(--border);
background:var(--card);color:var(--foreground);border-radius:8px;cursor:pointer}input{width:100%;accent-color:var(--accent)}
</style><p class="note">FICTIONAL DEMO · explanation only</p><h2>One rounding step.</h2>
<p>Compare rounding each line with rounding the combined total. Move the slider to inspect the calculation.</p>
<label>Number of items <input aria-label="Number of items" type="range" min="1" max="12" value="3"></label>
<div class="comparison"><div>Per-line rounding<strong class="amount" id="before"></strong></div>
<div class="after">Round the total<strong class="amount" id="after"></strong></div></div>
<button id="reset" type="button">Reset example</button><p class="note">Each item contributes $0.335 before rounding.</p>
<script>const input=document.querySelector('input');function paint(){const n=Number(input.value);
document.querySelector('#before').textContent='$'+(Math.round(33.5)*n/100).toFixed(2);
document.querySelector('#after').textContent='$'+(Math.round(33.5*n)/100).toFixed(2)}
input.addEventListener('input',paint);document.querySelector('#reset').onclick=()=>{input.value='3';paint()};paint();</script>`,
};

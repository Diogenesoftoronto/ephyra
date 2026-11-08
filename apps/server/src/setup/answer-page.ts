/** The capability stays in the fragment and Authorization header, never in request URLs or analytics. */
export const answerPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer"><title>Answer an Ephyra question</title>
<style>body{max-width:42rem;margin:8vh auto;padding:1.5rem;font:18px/1.6 system-ui;background:#f5f3ee;color:#182b25}
textarea{display:block;box-sizing:border-box;width:100%;min-height:10rem;margin:1rem 0;font:inherit;padding:.8rem}
button{font:inherit;padding:.6rem 1.2rem;background:#244d3f;color:white;border:0;border-radius:.4rem}</style>
<h1>A question from Ephyra</h1><p id="question">Loading your question…</p><p id="reason"></p>
<form hidden id="form"><label for="answer">Your answer</label><textarea id="answer" maxlength="4000" required></textarea>
<button>Send answer</button></form><p id="status" role="status"></p>
<script>
const token=location.hash.slice(1);history.replaceState(null,'','/answer');
const status=document.getElementById('status'),form=document.getElementById('form');
async function request(method,body){const r=await fetch('/callbacks/investigation',{
method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},cache:'no-store',
...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('This question is unavailable or has already been answered.');return r.json()}
request('GET').then(q=>{document.getElementById('question').textContent=q.question;
document.getElementById('reason').textContent=q.reason;form.hidden=false}).catch(e=>{status.textContent=e.message});
form.onsubmit=async e=>{e.preventDefault();form.querySelector('button').disabled=true;try{
const q=await request('POST',{text:document.getElementById('answer').value});
status.textContent=q.status==='answered'?'Answer recorded. Ephyra is continuing its investigation.':
'Answer recorded. Its check is available in the investigation trail.';form.hidden=true;
}catch(e){status.textContent='The outcome is uncertain. Reload this link to check it before sending again.'}};
</script></html>`;

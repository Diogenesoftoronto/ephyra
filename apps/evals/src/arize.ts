import { readFile,writeFile } from 'node:fs/promises';
import { ReconciliationRequired } from '@ephyra/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { APP,corpusHash,canonical,type Case } from './data';
import { clean } from './telemetry';
import type { CaseResult } from './results';
export type Ax=(args:string[],stdin?:string)=>Promise<string>;
export const ax:Ax=async(args,stdin)=>{
  const child=Bun.spawn(['rtk','proxy',process.env.EPHYRA_AX_BIN??`${process.env.HOME}/.local/bin/ax`,...args],{stdin:stdin===undefined?'ignore':new Blob([stdin]),stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0)throw new Error(clean(`ax ${args.slice(0,2).join(' ')} failed: ${stderr||stdout}`));
  return stdout;
};
export function jsonFrom(text:string):any {const start=text.search(/[\[{]/);if(start<0)throw new Error('ax returned no JSON');return JSON.parse(text.slice(start));}
function entries(value:any):any[]{if(Array.isArray(value))return value;for(const k of ['datasets','experiments','data','results'])if(Array.isArray(value[k]))return value[k];throw new Error('ax returned no list');}
export function experimentRows(rows:CaseResult[],examples:Map<string,string>) {
  const names=[...new Set(rows.flatMap(r=>Object.keys(r.scores)))];
  const labelOnly=names.filter(n=>rows.some(r=>r.status!=='scored'||r.scores[n]?.score==null));
  return {labelOnly,rows:rows.map(r=>{
    const example=examples.get(r.case_id);if(!example)throw new Error('missing Arize case mapping');
    const out:Record<string,unknown>={example_id:example,output:clean(r.output),case_id:r.case_id,identity:r.identity,status:r.status,trace_id:r.traceId,wall_ms:r.wallMs,tokens:r.tokens??'',cost_microusd:r.costMicrousd??''};
    for(const n of names){const score=r.scores[n];const available=r.status==='scored'&&score?.score!=null;
      if(!labelOnly.includes(n))out[`eval.${n}.score`]=score!.score;
      out[`eval.${n}.label`]=available?score!.label:r.status==='scored'?'unverified':r.status;
      out[`eval.${n}.explanation`]=clean((available&&labelOnly.includes(n)?`score=${score!.score}; `:'')+(r.reason??score?.explanation??'not evaluated'));
    }return out;
  })};
}
export async function ensureDataset(rows:Case[],runAx:Ax=ax) {
  const name=`ephyra-${rows[0]!.suite}-${corpusHash(rows)}`;
  const existing=entries(jsonFrom(await runAx(['datasets','list','--space','kmannoel Space','--name',name,'--limit','100','-o','json']))).filter(d=>d.name===name);
  if(existing.length>1)throw new Error('ambiguous duplicate dataset names');
  const data=rows.map(r=>({case_id:r.case_id,input:canonical(r.input),expected:canonical(r.expected),provenance:r.provenance,version:r.version}));
  let dataset=existing[0];
  if(!dataset){try{dataset=jsonFrom(await runAx(['datasets','create','--name',name,'--space','kmannoel Space','--file','-','-o','json'],JSON.stringify(data)));}catch(e){throw new ReconciliationRequired(name,clean(String(e)));}}
  if(!dataset.id)throw new ReconciliationRequired(name,'dataset creation returned no id');
  const exported=jsonFrom(await runAx(['datasets','export',dataset.id,'--all','--stdout']));
  if(!Array.isArray(exported))throw new Error('dataset export not an array');
  const examples=new Map<string,string>();
  for(const e of exported){const props=e.additional_properties??e;const row=data.find(r=>r.case_id===props.case_id);
    if(!row||!e.id||examples.has(row.case_id))throw new Error('unexpected or duplicate exported example');
    // Some AX versions promote input/expected to top level. Verify fields when exported.
    const input=props.input??e.input;
    if(input!==undefined&&input!==row.input)throw new Error('Arize dataset input mismatch');
    examples.set(row.case_id,e.id);
  }
  if(examples.size!==rows.length)throw new Error('incomplete Arize dataset export');
  return {id:dataset.id as string,name,examples,url:dataset.url??null};
}
export function tracePayload(spans:ReadableSpan[]):Uint8Array {const body=ProtobufTraceSerializer.serializeRequest(spans);if(!body)throw new Error('cannot serialize OTLP');return body;}
export async function sendTraces(body:Uint8Array,opts:{endpoint:string;apiKey:string;spaceId:string;key:string;fetch?:typeof fetch}) {
  let response:Response;
  try{response=await (opts.fetch??fetch)(opts.endpoint,{method:'POST',headers:{'Content-Type':'application/x-protobuf','arize-space-id':opts.spaceId,'arize-api-key':opts.apiKey,'Idempotency-Key':opts.key},body:Buffer.from(body),signal:AbortSignal.timeout(30000)});}catch{throw new ReconciliationRequired(opts.key,'OTLP delivery outcome unknown');}
  if(!response.ok)throw new Error(`OTLP HTTP ${response.status}`);
  const data=new Uint8Array(await response.arrayBuffer());
  const ack=data.length?ProtobufTraceSerializer.deserializeResponse(data):{};
  const partial=(ack as any).partialSuccess;
  if(partial&&(Number(partial.rejectedSpans)>0||partial.errorMessage))throw new Error('OTLP partial rejection: '+clean(partial));
  return {accepted:true,project:'ephyra-evals',endpoint:opts.endpoint};
}
export async function arizeConfig(){
  const parsed=Bun.TOML.parse(await readFile(`${process.env.HOME}/.arize/profiles/default.toml`,'utf8')) as any;
  const routing=parsed.routing??{};
  if(!process.env.ARIZE_API_KEY||!process.env.ARIZE_SPACE_ID)throw new Error('ARIZE_API_KEY and ARIZE_SPACE_ID required');
  const region=process.env.ARIZE_REGION??routing.region;
  if(!region)throw new Error('Arize region unavailable');
  const host=routing.otlp_host??'otlp.arize.com';
  return {endpoint:process.env.ARIZE_OTLP_ENDPOINT??`https://${host.replace('otlp.',`otlp.${region}.`)}/v1/traces`,apiKey:process.env.ARIZE_API_KEY,spaceId:process.env.ARIZE_SPACE_ID};
}
export async function uploadRun(resultPath:string,runAx:Ax=ax){
  const report=JSON.parse(await readFile(resultPath,'utf8'));
  if(report.arize?.state==='pending'||report.arize?.state==='reconciliation_required')throw new ReconciliationRequired(report.runId,'Prior upload needs readback reconciliation; no blind retry');
  if(report.arize?.state==='complete')return report.arize;
  report.arize={state:'pending',datasets:[],experiments:[],traces:null};
  const save=()=>writeFile(resultPath,JSON.stringify(report,null,2)+'\n');await save();
  try{
    for(const identity of [...new Set((report.cases as CaseResult[]).map(r=>r.identity))]){
      const cases=(report.cases as CaseResult[]).filter(r=>r.identity===identity);
      const corpus=(report.corpus as Case[]).filter(r=>cases.some(c=>c.case_id===r.case_id));
      const dataset=await ensureDataset(corpus,runAx);report.arize.datasets.push({id:dataset.id,name:dataset.name,url:dataset.url});await save();
      const name=`ephyra-${report.suite}-${String(identity).replace(/[^a-zA-Z0-9_.-]/g,'_')}-${report.gitSha.slice(0,12)}-${report.runId}`;
      const flattened=experimentRows(cases,dataset.examples);
      const created=jsonFrom(await runAx(['experiments','create','--name',name,'--dataset',dataset.id,'--file','-','-o','json'],JSON.stringify(flattened.rows)));
      if(!created.id)throw new ReconciliationRequired(name,'experiment returned no id');
      const verified=entries(jsonFrom(await runAx(['experiments','list','--dataset',dataset.id,'--limit','100','-o','json']))).find(e=>e.id===created.id);
      if(!verified)throw new Error('experiment absent from list readback');
      report.arize.experiments.push({...created,name,datasetId:dataset.id,labelOnly:flattened.labelOnly,verified:true});await save();
    }
    const config=await arizeConfig();
    report.arize.traces=await sendTraces(new Uint8Array(await readFile(resultPath+'.otlp')),{...config,key:report.runId});
    report.arize.state='complete';await save();return report.arize;
  }catch(e){report.arize.state='reconciliation_required';report.arize.reason=clean(String(e));await save();throw e;}
}

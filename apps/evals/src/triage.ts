import { readFile } from 'node:fs/promises';
import { JudgementResponse, Unverified, type ExtractionResponse } from '@ephyra/core';
import { ParserExtract, TypeSafeDecide, WorkersAiClairicExtract } from '@ephyra/models';
import { applyTriage, buildExtractionRequest, buildTriageRequest, DEFAULT_THRESHOLDS } from '@ephyra/policy';
import { APP, TriageInput, TriageLabel, type Case } from './data';
import { area, type Options, type Outcome } from './common';
import { check, unscored, type CaseResult } from './results';
import { brier,ece,reliability,confusion,bootstrap } from './stats';
import { clean } from './telemetry';
const thresholdIdentities=['fixture/oracle-v1','jev-1.14','jev-1.14.0','judgement-jev/jev-1.14'];
export async function decide(row:Case,extracted:ExtractionResponse,opts:Options) {
  const {signal,candidates}=TriageInput.parse(row.input);
  const request=buildTriageRequest(signal,extracted,candidates,area);
  if(!opts.live) {
    const rows=(await readFile(APP+'datasets/offline-judgements.jsonl','utf8')).trim().split('\n').map(l=>JSON.parse(l));
    const found=rows.find(r=>r.case_id===row.case_id);
    if(!found) throw new Unverified('no scripted judgement for case');
    return {request,response:JudgementResponse.parse(found.response)};
  }
  if(!process.env.TYPESAFE_API_KEY) throw new Unverified('TYPESAFE_API_KEY missing');
  const backend=new TypeSafeDecide({alias:'typesafe',endpoint:'https://api.typesafe.ai',credential:process.env.TYPESAFE_API_KEY,model:process.env.TYPESAFE_MODEL??'jev-1.14',supports:['noul','choice','score'],purpose:'decide.triage',http:{retries:0,timeoutMs:20000}});
  const response=await opts.telemetry.span('LLM','triage.decide',request,opts.span,async span=>{
    const r=await backend.decide(request,{idempotencyKey:`${opts.runId}:${row.case_id}:decide`});
    span.setAttributes({'llm.model_name':r.model,'ephyra.backend.identity':r.model,'output.value':clean(r)});
    if(r.usage?.input_tokens!==undefined)span.setAttribute('llm.token_count.prompt',r.usage.input_tokens);
    if(r.usage?.cost_microusd!=null)span.setAttribute('llm.cost.total',r.usage.cost_microusd/1e6);
    return r;
  });
  if(response.fallback) throw new Unverified('backend reported unauthorized fallback');
  return {request,response};
}
export async function extract(row:Case,opts:Options):Promise<ExtractionResponse> {
  const {signal}=TriageInput.parse(row.input);const req=buildExtractionRequest(signal);
  const worker=opts.backend==='workers-ai';
  if(worker&&!opts.live) throw new Unverified('workers-ai requires --live');
  if(worker&&(!process.env.CLOUDFLARE_ACCOUNT_ID||!process.env.CLOUDFLARE_AI_API_TOKEN))throw new Unverified('Cloudflare credentials missing');
  const backend=worker?new WorkersAiClairicExtract({alias:'workers-ai',accountId:process.env.CLOUDFLARE_ACCOUNT_ID!,credential:process.env.CLOUDFLARE_AI_API_TOKEN!,http:{retries:0,timeoutMs:20000}}):new ParserExtract();
  return opts.telemetry.span(worker?'LLM':'TOOL','triage.extract',req,opts.span,async span=>{
    const r=await backend.extract(req,{idempotencyKey:`${opts.runId}:${row.case_id}:extract`});
    span.setAttributes({'ephyra.backend.identity':r.model,'output.value':clean(r)});
    if(worker)span.setAttribute('llm.model_name',r.model);
    if(r.usage?.input_tokens!==undefined)span.setAttribute('llm.token_count.prompt',r.usage.input_tokens);
    if(r.usage?.cost_microusd!=null)span.setAttribute('llm.cost.total',r.usage.cost_microusd/1e6);
    return r;
  });
}
export async function runTriage(row:Case,opts:Options):Promise<Outcome> {
  const input=TriageInput.parse(row.input),label=TriageLabel.parse(row.expected);
  const extraction=await extract(row,opts);
  const scores={exception:check(extraction.answers.exception_type?.value===label.exception_type,'Exact exception class'),frame:check(extraction.answers.top_app_frame?.value===label.top_app_frame,'Exact path, excluding line number')};
  if(opts.backend==='parser'||opts.backend==='workers-ai')return {identity:extraction.model,scores:{...scores,route:unscored('Extraction backend has no decision capability')},output:{extraction},tokens:extraction.usage?.input_tokens??null,costMicrousd:opts.backend==='parser'?0:extraction.usage?.cost_microusd??null};
  const {request,response}=await decide(row,extraction,opts);
  const thresholds=Object.fromEntries(thresholdIdentities.map(id=>[id,DEFAULT_THRESHOLDS]));
  const result=applyTriage(response,extraction,thresholds,area,input.candidates,input.signal.kind);
  const identity=`${response.model} + ${extraction.model}`;
  return {identity,scores:{...scores,
    route:check(result.route===label.route,`expected ${label.route}; observed ${result.route}`),
    duplicate:check((result.duplicateOf??null)===label.duplicate_of,'Exact duplicate identity'),
    regression:check((result.regressionOf??null)===label.regression_of,'Exact regression identity'),
    conflict:check((result.conflictsWith??null)===label.conflicts_with,'Exact conflicting identity'),
    severity:check(result.severity>=label.severity[0]&&result.severity<=label.severity[1],`band ${label.severity.join('–')}; observed ${result.severity}`),
    dangerous_miss:check(label.actionable&&label.severity[0]>=2.5&&result.route==='ignore','Rate: actionable high-severity signal abandoned/muted; lower is better'),
    over_escalation:check(label.route!=='human'&&(result.route==='human'||result.notifyHuman)&&label.severity[1]<2.5,'Rate: unnecessary human escalation; lower is better'),
    actionable_brier:{score:brier([result.actionable],[label.actionable]),label:'loss',explanation:'Squared probability error; lower is better'}},
    output:{request,response,extraction,result,label,signalKind:input.signal.kind,candidates:input.candidates},tokens:response.usage?.input_tokens??null,costMicrousd:response.usage?.cost_microusd??null};
}
/** Each exact decision + extraction identity gets its own calibration and sweep. Never pool providers. */
export function triageMetrics(rows:CaseResult[]) {
  const ids=[...new Set(rows.filter(r=>r.status==='scored'&&(r.output as any)?.result).map(r=>r.identity))];
  return Object.fromEntries(ids.map(id=>{
    const cases=rows.filter(r=>r.identity===id&&r.status==='scored').map(r=>r.output as any);
    const ps=cases.map(c=>c.result.actionable),ys=cases.map(c=>c.label.actionable);
    const routePs=cases.map(c=>c.response.answers.route.probabilities[c.response.answers.route.choice]??0);
    const routeYs=cases.map(c=>c.response.answers.route.choice===c.label.route);
    const dupPs=cases.map(c=>c.response.answers.duplicate_of.probabilities[c.response.answers.duplicate_of.choice]??0);
    const dupYs=cases.map(c=>c.response.answers.duplicate_of.choice===(c.label.duplicate_of??'none'));
    const calibration=(p:number[],y:boolean[])=>({brier:brier(p,y),ece:ece(p,y),reliability:reliability(p,y)});
    const sweep=['actionable','ignore','confidence','duplicate','regression','conflict','severity'].flatMap(key=>(key==='severity'?[1.5,2.5,3.5]:[.2,.4,.6,.8,.95]).map(value=>{
      const results=cases.map(c=>applyTriage(c.response,c.extraction,{[c.response.model]:{...DEFAULT_THRESHOLDS,[key]:value}},area,c.candidates,c.signalKind));
      return {key,value,route:bootstrap(results.map((r,i)=>Number(r.route===cases[i].label.route))),dangerousMisses:results.filter((r,i)=>r.route==='ignore'&&cases[i].label.actionable&&cases[i].label.severity[0]>=2.5).length,duplicates:results.filter(r=>r.duplicateOf).length,notifications:results.filter(r=>r.notifyHuman).length};
    }));
    return [id,{actionable:calibration(ps,ys),routeTopLabel:calibration(routePs,routeYs),duplicateTopLabel:calibration(dupPs,dupYs),confusion:confusion(cases.map(c=>c.label.route),cases.map(c=>c.result.route)),sweep}];
  }));
}

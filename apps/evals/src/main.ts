import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Unverified,ReconciliationRequired } from '@ephyra/core';
import { APP,SUITES,loadCorpus,corpusHash,type Suite } from './data';
import { CaseResult,summarize,unscored } from './results';
import { Telemetry,clean } from './telemetry';
import { runTriage,triageMetrics } from './triage';
import { runInjection } from './injection';
import { runProof } from './proof';
import { runAgent } from './agent';
import { runFeedback } from './feedback';
import { tracePayload,uploadRun } from './arize';
import { git } from './local';
import type { SuiteRunner } from './common';
export function parseArgs(args:string[]){
  if(args[0]!=='run')throw new Error('Usage: run --suite <name|all> [--backend fixture|parser|typesafe|workers-ai|typesafe-workers-ai] [--agent mock|claude-code|codex|amp] [--live] [--arize] [--limit N]');
  const flags=new Map<string,string|boolean>();
  for(let i=1;i<args.length;i++){const k=args[i]!;if(['--live','--arize'].includes(k)){flags.set(k,true);continue;}if(!['--suite','--backend','--agent','--limit'].includes(k)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error(`invalid option ${k}`);flags.set(k,args[++i]!);}
  const suite=String(flags.get('--suite')??'all');if(suite!=='all'&&!SUITES.includes(suite as Suite))throw new Error('invalid suite');
  const live=flags.has('--live');const backend=String(flags.get('--backend')??(live?'typesafe':'fixture'));const agent=String(flags.get('--agent')??(live?'codex':'mock'));
  if(!['fixture','parser','typesafe','workers-ai','typesafe-workers-ai'].includes(backend)||!['mock','claude-code','codex','amp'].includes(agent))throw new Error('unknown backend or agent');
  if(!live&&(backend==='typesafe'||backend==='workers-ai'||backend==='typesafe-workers-ai'||agent!=='mock'))throw new Error('real backends and agents require --live');
  if(live&&backend==='fixture')throw new Error('fixture backend cannot be labeled live');
  const limit=flags.has('--limit')?Number(flags.get('--limit')):undefined;if(limit!==undefined&&(!Number.isInteger(limit)||limit<1))throw new Error('invalid limit');
  return {suite,live,backend,agent,arize:flags.has('--arize'),limit};
}
/** Conservative reservations, not a claim of billing. Retained across invocations; never auto-reset. */
async function reserveBudget(runId:string,usd:number){
  const path=APP+'results/live-budget.json';let ledger:{ceiling:number;reservations:{runId:string;usd:number}[]}={ceiling:10,reservations:[]};
  try{ledger=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as any).code!=='ENOENT')throw e;}
  if(ledger.reservations.reduce((n,r)=>n+r.usd,0)+usd>ledger.ceiling)throw new Unverified('live budget reservation would exceed $10; stopped');
  ledger.reservations.push({runId,usd});await writeFile(path,JSON.stringify(ledger,null,2));
}
export function markdown(report:any){
  const lines=[`# Ephyra ${report.suite} — ${report.mode}`,`Run ${report.runId}; git ${report.gitSha}; corpus ${report.corpusHash}.`,'','95% deterministic bootstrap intervals describe this synthetic corpus; they do not establish production generalization. Offline oracle replay measures plumbing, not model quality.',''];
  for(const [identity,g]of Object.entries(report.summary)as [string,any][]){lines.push(`## ${identity}`,`Scored ${g.scored}/${g.cases}; unavailable ${g.unavailable}; errors ${g.errors}.`,'','| Metric | Mean | 95% interval | N |','|---|---:|---:|---:|');for(const [name,m]of Object.entries(g.metrics)as[string,any][])lines.push(`| ${name} | ${m.point??'Unverified'} | ${m.low??'—'} … ${m.high??'—'} | ${m.n} |`);lines.push('');}
  for(const r of report.cases)if(r.reason)lines.push(`- ${r.case_id}: ${r.status}: ${r.reason}`);
  return lines.join('\n')+'\n';
}
const runners:Record<Suite,SuiteRunner>={triage:runTriage,injection:runInjection,proof:runProof,agent:runAgent,feedback:runFeedback};
export async function run(options:ReturnType<typeof parseArgs>){
  if(options.live&&process.env.EPHYRA_LIVE!=='1')throw new Error('--live requires EPHYRA_LIVE=1');
  await mkdir(APP+'results',{recursive:true});
  // Prevent overlapping paid runs and racy budget reservations.
  const lock=APP+'results/live.lock';let locked=false;
  if(options.live){await writeFile(lock,String(process.pid),{flag:'wx'});locked=true;}
  try{
    const files:string[]=[];
    for(const suite of options.suite==='all'?SUITES:[options.suite as Suite]){
      const telemetry=new Telemetry();const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8);
      const corpus=(await loadCorpus(suite)).slice(0,options.limit);
      if(options.live&&['triage','injection','agent'].includes(suite)){
        const usd=suite==='agent'?Math.min(3,corpus.filter(c=>!c.input.recorded).length)*2:suite==='injection'?corpus.length*.04:options.backend==='parser'?0:corpus.length*(options.backend==='typesafe-workers-ai'?.04:.02);
        await reserveBudget(runId,usd);
      }
      const gitSha=await git(resolve(APP,'../..'),'rev-parse','HEAD');
      const report:any={schema:1,runId,suite,mode:options.live?'live':'offline',gitSha,sourceDirty:Boolean(await git(resolve(APP,'../..'),'status','--porcelain')),corpusHash:corpusHash(corpus),corpus,cases:[],summary:{},limitations:['Synthetic toy corpus; confidence intervals are descriptive','Agent adapter reports requested model, not provider-resolved identity','Unknown cost and tokens remain null; reservations are not measured spend']};
      const path=APP+`results/${runId}-${suite}.json`;let unavailable:string|undefined;
      for(const row of corpus){
        const started=Date.now();
        const result=await telemetry.span('CHAIN',`eval.${suite}.${row.case_id}`,row.input,undefined,async span=>{
          span.setAttributes({'ephyra.eval.case_id':row.case_id,'ephyra.eval.run_id':runId,'ephyra.eval.git_sha':gitSha});
          let outcome;
          try{if(unavailable)throw new Unverified(unavailable);outcome=await runners[suite](row,{...options,runId,span,telemetry});}
          catch(e){const reason=clean(String(e));outcome={identity:`requested:${suite==='agent'?options.agent:options.backend}`,status:e instanceof Unverified||e instanceof ReconciliationRequired||/HTTP|credentials|validation|model|api/i.test(reason)?'unavailable':'error',reason,scores:{completion:unscored(reason)},output:{reason}};}
          if(options.live&&outcome.status==='unavailable'&&suite!=='agent')unavailable=outcome.reason;
          const parsed=CaseResult.parse({...outcome,status:outcome.status??'scored',case_id:row.case_id,wallMs:Date.now()-started,tokens:outcome.tokens??null,costMicrousd:outcome.costMicrousd??null,traceId:span.spanContext().traceId});
          span.setAttributes({'output.value':clean(parsed),'ephyra.eval.status':parsed.status});return parsed;
        });
        report.cases.push(result);await writeFile(path,JSON.stringify(report,null,2)+'\n');
        console.log(`${suite} ${row.case_id}: ${result.status} (${result.identity})`);
        // No blind retry after failed/auth-ambiguous paid agent execution.
        if(options.live&&suite==='agent'&&result.status==='unavailable')break;
      }
      report.corpus=corpus.filter(c=>report.cases.some((r:CaseResult)=>r.case_id===c.case_id));report.corpusHash=corpusHash(report.corpus);
      report.summary=summarize(report.cases);if(suite==='triage')report.calibration=triageMetrics(report.cases);
      await telemetry.provider.forceFlush();
      await writeFile(path+'.otlp',tracePayload(telemetry.memory.getFinishedSpans()));
      await writeFile(path,JSON.stringify(report,null,2)+'\n');await writeFile(path.replace(/\.json$/,'.md'),markdown(report));
      await telemetry.provider.shutdown();
      console.log(`Result: ${path}`);files.push(path);
      if(options.arize){const uploaded=await uploadRun(path);console.log(`Arize: ${uploaded.state}; experiments ${uploaded.experiments.map((e:any)=>e.id).join(', ')}`);}
    }return files;
  }finally{if(locked){const{unlink}=await import('node:fs/promises');await unlink(lock);}}
}
if(import.meta.main){
  try{if(Bun.argv[2]==='upload'){const file=resolve(Bun.argv[3]??'');if(!file.startsWith(APP+'results/'))throw new Error('upload must reference apps/evals/results');console.log(JSON.stringify(await uploadRun(file)));}else await run(parseArgs(Bun.argv.slice(2)));}
  catch(e){console.error(clean(String(e)));process.exitCode=1;}
}

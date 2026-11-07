// The boundary guard permits relative imports within apps. Use the production wiring, not a copied oracle.
import { FakeContext } from '../../server/src/wiring/context';
import { humanHandlers,httpPort } from '../../server/src/wiring/human';
import { agentHandlers } from '../../server/src/wiring/agents';
import { EffectExecutor,MemoryOperationLedger } from '../../server/src/orchestrator/effects';
import type { EffectHandlers } from '../../server/src/orchestrator';
import { MemorySignalStore } from '@ephyra/ingest';
import { parseAutonomy } from '@ephyra/policy';
import { transition,Unverified,type Journal } from '@ephyra/core';
import { MockAgent } from '@ephyra/agent';
import { trail,context,event,type SuiteRunner } from './common';
import { actualProof,digest } from './proof';
import { check } from './results';
import { localRunner } from './local';
import { APP } from './data';
function fakeContext(){
  const no=async()=>{throw new Unverified('unused fake journal operation');};
  const files=new Map<string,string>();
  const journal:Journal={create:no,append:no,read:async()=>null,readFile:async(_id,p)=>files.has(p)?new TextEncoder().encode(files.get(p)!):null,list:async()=>[],pinRevision:no,pinProof:no};
  return {files,ctx:new FakeContext({id:'eval-toy',url:'unused',mirrorDir:APP+'.work',baseRef:'refs/heads/main',forge:'plain',remote:'unused'},{autonomy:parseAutonomy(''),thresholds:{}},journal,new MemorySignalStore())};
}
export const runFeedback:SuiteRunner=async(row)=>{
  const scenario=String(row.input.scenario),{ctx,files}=fakeContext();let t=trail();ctx.put(t);
  const human=humanHandlers(ctx);let safe=false,output:unknown;
  if(scenario==='reconciliation'){
    const notes:string[]=[];const ledger=new MemoryOperationLedger();
    const handlers={notify_inbox:async()=>{throw new Error('fixture storage acknowledgement lost');}} as unknown as EffectHandlers;
    const executor=new EffectExecutor(ledger,handlers,{record:async(_key,n)=>{notes.push(n);}});
    try{await executor.execute({type:'notify_inbox',key:'eval-reconcile',reason:'fixture'},t);}catch{}
    const record=await ledger.get('eval-reconcile');safe=notes.some(n=>n.includes('storage acknowledgement lost'))&&record?.status==='reconciliation_required';output={notes,record};
  }else if(scenario.startsWith('agent-')){
    const agent=scenario==='agent-false'?new MockAgent([{ok:false,artefacts:{'hypothesis.md':'Must never be accepted from failed turn'},outputs:{},usage:{tokens:0,costMicrousd:null,model:'fixture/failure'},sessions:[],error:'reauthentication required'}]):{name:'fixture/throw',async run(){throw new Unverified(scenario==='agent-timeout'?'command deadline exceeded':'agent authentication failed');}};
    // Third failure: the actual retry limiter should now park the trail with the cause.
    ctx.trails.events=async()=>scenario==='agent-false'?[]:[1,2].map(()=>event(t,{type:'agent_failed',data:{step:'research',reason:'prior fixture failure',retryable:true}}));
    const runner=localRunner(APP);const handlers=agentHandlers(ctx,{agent,runner,profile:{name:'fake',digest:'fixture',network:'none',readOnlyProd:true,credentials:[],limits:{cpu:1,memoryMb:256,diskMb:10,timeoutS:1}},stepTimeoutS:1,buildProof:async()=>{throw new Unverified('unused');}});
    await handlers.start_agent!({type:'start_agent',key:'eval-step',step:'research'},t);
    let error:string|undefined;try{await ctx.drainJobs();}catch(e){error=String(e);}
    const failure=ctx.emitted.find(e=>e.type==='agent_failed');
    const tr=failure?.type==='agent_failed'?transition(t,event(t,{type:'agent_failed',data:failure.data}),context):null;
    safe=Boolean(tr?.ok&&tr.trail.state==='parked'&&tr.effects.some(e=>e.type==='notify_inbox'&&e.reason.length>10));
    output={emitted:ctx.emitted,transition:tr,error};
  }else{
    const cp=scenario==='checkpoint-a'?'A':scenario==='checkpoint-b'?'B':'C';
    t.state=cp==='A'?'hypothesised':cp==='B'?'planned':'ready';
    let proofDigest:string|undefined;
    if(cp==='C'){
      const proof=await actualProof();t={...proof.trail,state:'ready'};proofDigest=digest(proof.bundle);
      ctx.trails.events=async()=>[event(t,{type:'proof_completed',data:{bundle:proof.bundle,digest:proofDigest!}})];
      if(scenario!=='missing-citation')files.set('proof/manifest.json',JSON.stringify(proof.bundle));
    }else files.set(cp==='A'?'hypothesis.md':'plan.md','Fixture evidence citation: value.js; this is synthetic wiring input.');
    ctx.put(t);
    await human.request_checkpoint!({type:'request_checkpoint',key:'eval-cp',checkpoint:cp,blocking:true},t);
    const item=(await ctx.inbox.list())[0]!;
    if(scenario.startsWith('stale-')){
      if(scenario==='stale-rev')ctx.put({...t,rev:t.rev+1});
      if(scenario==='stale-head')ctx.put({...t,head:'c'.repeat(40)});
      if(scenario==='stale-digest')ctx.trails.events=async()=>[{...event(t,{type:'proof_completed',data:{bundle:(await actualProof()).bundle,digest:'sha256:'+'9'.repeat(64)}})}];
      const port=httpPort(ctx,{append:async()=>({} as never)});let reason='';
      try{await port.decide(t.id,{checkpoint:cp,verdict:'approve'},'fixture-human');}catch(e){reason=String(e);}
      safe=reason.includes('changed');output={item,rejection:reason};
    }else{
      const cited=files.has(item.artefact.path);
      safe=item.bound.rev===t.rev&&item.bound.head===t.head&&item.bound.proofDigest===proofDigest&&cited;
      output={item,citationExists:cited,availableFiles:[...files.keys()]};
    }
  }
  return {identity:'server/feedback',scores:{safe:check(safe,scenario)},output,tokens:0,costMicrousd:0};
};

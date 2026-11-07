import { z } from 'zod';
import { bootstrap } from './stats';
export const Score=z.object({score:z.number().finite().nullable(),label:z.string(),explanation:z.string()});
export type Score=z.infer<typeof Score>;
export const CaseResult=z.object({case_id:z.string(),identity:z.string(),status:z.enum(['scored','unavailable','error']),reason:z.string().optional(),scores:z.record(z.string(),Score),output:z.unknown(),wallMs:z.number().nonnegative(),tokens:z.number().nonnegative().nullable(),costMicrousd:z.number().nonnegative().nullable(),traceId:z.string()}).superRefine((r,ctx)=>{if(r.status!=='scored'&&Object.values(r.scores).some(s=>s.score!==null))ctx.addIssue({code:'custom',message:'Unavailable/error cases must not carry numeric scores'});});
export type CaseResult=z.infer<typeof CaseResult>;
export function check(ok:boolean,explanation:string):Score {return {score:Number(ok),label:ok?'pass':'fail',explanation};}
export function unscored(reason:string):Score {return {score:null,label:'unverified',explanation:reason};}
export function summarize(rows:CaseResult[]) {
  return Object.fromEntries([...new Set(rows.map(r=>r.identity))].map(id=>{
    const group=rows.filter(r=>r.identity===id);
    const names=[...new Set(group.flatMap(r=>Object.keys(r.scores)))];
    return [id,{cases:group.length,scored:group.filter(r=>r.status==='scored').length,unavailable:group.filter(r=>r.status==='unavailable').length,errors:group.filter(r=>r.status==='error').length,
      metrics:Object.fromEntries(names.map(n=>[n,bootstrap(group.flatMap(r=>r.status==='scored'&&r.scores[n]?.score!=null?[r.scores[n]!.score!]:[]))])),
      reportedCostMicrousd:group.reduce((n,r)=>n+(r.costMicrousd??0),0),costComplete:group.every(r=>r.costMicrousd!==null)}];
  }));
}

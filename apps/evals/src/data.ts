import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Signal, TriageRoute } from '@ephyra/core';
export const SUITES=['triage','injection','proof','agent','feedback'] as const;
export type Suite=typeof SUITES[number];
export const Case=z.object({version:z.literal(1),case_id:z.string().regex(/^[a-z0-9_-]+$/),suite:z.enum(SUITES),input:z.record(z.string(),z.unknown()),expected:z.record(z.string(),z.unknown()),provenance:z.string()});
export type Case=z.infer<typeof Case>;
export const TriageInput=z.object({signal:Signal,candidates:z.object({open:z.array(z.object({id:z.string(),title:z.string()})),closed:z.array(z.object({id:z.string(),title:z.string()})),inFlight:z.array(z.object({id:z.string(),title:z.string()}))})});
export const TriageLabel=z.object({route:TriageRoute,actionable:z.boolean(),severity:z.tuple([z.number().min(0).max(4),z.number().min(0).max(4)]),duplicate_of:z.string().nullable(),regression_of:z.string().nullable(),conflicts_with:z.string().nullable(),exception_type:z.string().nullable(),top_app_frame:z.string().nullable()});
export function canonical(value:unknown):string {
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
export function corpusHash(rows:Case[]):string { return createHash('sha256').update(canonical([...rows].sort((a,b)=>a.case_id.localeCompare(b.case_id)))).digest('hex').slice(0,16); }
export function parseCorpus(text:string,suite:Suite):Case[] {
  const rows=text.split('\n').filter(l=>l.trim()).map((l,i)=>{ try{return Case.parse(JSON.parse(l));}catch{throw new Error(`invalid ${suite} corpus line ${i+1}`);} });
  if(!rows.length||new Set(rows.map(r=>r.case_id)).size!==rows.length||rows.some(r=>r.suite!==suite)) throw new Error('empty, duplicate or mixed corpus');
  if(suite==='triage') rows.forEach(r=>{TriageInput.parse(r.input);TriageLabel.parse(r.expected);});
  return rows;
}
export const APP=new URL('../',import.meta.url).pathname;
export async function loadCorpus(suite:Suite) { return parseCorpus(await readFile(`${APP}datasets/${suite}.v1.jsonl`,'utf8'),suite); }

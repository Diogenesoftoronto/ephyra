import { Trail, Signal, TrailEvent, type TrailEventBody, type TransitionContext } from '@ephyra/core';
import type { Area } from '@ephyra/policy';
import type { Span } from '@opentelemetry/api';
import type { Case } from './data';
import type { Score } from './results';
import type { Telemetry } from './telemetry';
export const now='2026-11-07T12:00:00Z';
export const area:Area={name:'eval-toy',risk:'low',paths:['src/**'],ui:[],user_facing:false,overrides:{},prose:'Investigate code defects; security, outages and conflicting fixes need a human.'};
export const context:TransitionContext={now,blocking:{A:true,B:true,C:true},landingModes:['trail_ref']};
export function signal():Signal {return Signal.parse({schema:1,id:'018f0000-0000-7000-8000-000000000010',kind:'error',repo:'eval-toy',fingerprint:'eval-fingerprint',title:'Seed bug',message:'TypeError at src/cart.ts:2',source:'fixture',count:1,firstSeen:now,lastSeen:now});}
export function trail():Trail {return Trail.parse({schema:1,id:'018f0000-0000-7000-8000-000000000020',short:'T-eval',repo:'eval-toy',title:'Seeded evaluation bug',rev:1,state:'researching',signals:[signal().id],area:area.name,risk:'low',route:'auto_fix',severity:2,base:{ref:'refs/heads/main',sha:'a'.repeat(40)},checkpoints:{spend:[]},attempts:{proof:0,maxProof:3},budget:{tokensUsed:0,tokensMax:6000,wallclockMaxS:120,spendMicrousdUsed:0,spendMicrousdMax:1000000},mirrors:{},createdAt:now,updatedAt:now});}
export function event(t:Trail,body:TrailEventBody):TrailEvent {return TrailEvent.parse({schema:1,id:crypto.randomUUID(),trail:t.id,rev:t.rev,at:now,actor:{kind:'system',id:'eval'},...body});}
export type Outcome={identity:string;scores:Record<string,Score>;output:unknown;tokens?:number|null;costMicrousd?:number|null;status?:'scored'|'unavailable';reason?:string};
export type Options={live:boolean;backend:string;agent:string;runId:string;telemetry:Telemetry;span:Span};
export type SuiteRunner=(row:Case,opts:Options)=>Promise<Outcome>;

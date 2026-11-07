import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { Unverified, type Runner, type RunnerHandle } from '@ephyra/core';
import type { Span } from '@opentelemetry/api';
import { APP } from './data';
import { clean, type Telemetry } from './telemetry';
export async function command(root:string,args:string[],deadlineMs=30000) {
  const child=Bun.spawn(['rtk','proxy',...args],{cwd:root,stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  let timedOut=false;const started=Date.now();const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},deadlineMs);
  try {const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit,timedOut,durationMs:Date.now()-started};}finally{clearTimeout(timer);}
}
export async function git(root:string,...args:string[]) {const r=await command(root,['git',...args]);if(r.exit)throw new Error(clean(r.stderr));return r.stdout.trim();}
export function localRunner(root:string,telemetry?:Telemetry,parent?:Span):Runner {
  const inside=(path:string)=>{const p=resolve(root,path);if(p!==root&&!p.startsWith(root+'/'))throw new Error('path escapes fixture');return p;};
  return {name:'trusted-local-eval',capabilities:{checkpoint:'none',network:['egress'],shell:true,browser:false},
    async *exec(_h,cmd,opts){
      // Budget control for Claude; Codex uses isolated config, bounded wall time and explicit model.
      const args=[...cmd];
      if(args[0]==='claude')args.splice(1,0,'--max-budget-usd','0.50','--max-turns','8','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','project','--allowedTools','Read,Edit,Write,Bash(git:*),Bash(bun:*),Bash(mkdir:*),Bash(chmod:*),Bash(rtk:*)');
      if(args[0]==='codex')args.splice(2,0,'--ignore-user-config','--ephemeral','-c','model_reasoning_effort="low"','-c','approval_policy="never"');
      const work=()=>command(opts.cwd?inside(opts.cwd):root,args,opts.deadlineMs);
      const r=telemetry?await telemetry.span('TOOL',cmd[0]??'command',{command:cmd[0],args:cmd[0]==='claude'||cmd[0]==='codex'?'[agent prompt recorded on AGENT span]':cmd.slice(1)},parent,async span=>{const r=await work();span.setAttributes({'tool.name':cmd[0]??'command','output.value':clean({exit:r.exit,timedOut:r.timedOut,stderr:r.stderr.slice(-2000)})});return r;}):await work();
      yield {stream:'stdout',chunk:r.stdout};yield {stream:'stderr',chunk:r.stderr};yield {exit:r.exit,durationMs:r.durationMs,timedOut:r.timedOut};
    },
    async readFile(_h,path){try{return await readFile(inside(path));}catch{return null;}},
    async writeFile(_h,path,data){await mkdir(dirname(inside(path)),{recursive:true});await writeFile(inside(path),data);},
    async allocate(){return handle(root);},async destroy(){return {destroyed:true,at:new Date().toISOString()};},
    async checkpoint(){throw new Unverified('local checkpoint');},async restore(){throw new Unverified('local restore');},async exportArtifacts(){throw new Unverified('unused artifact export');}};
}
export const handle=(root:string):RunnerHandle=>({id:'eval',runner:'trusted-local-eval',workdir:root,trailId:'018f0000-0000-7000-8000-000000000020',attempt:1,leaseExpiresAt:'2099-01-01T00:00:00Z'});
export async function fixture(name:string) {
  if(!['sum','clamp'].includes(name))throw new Error('unknown fixture');
  await mkdir(APP+'.work',{recursive:true});const root=await mkdtemp(APP+'.work/'+name+'-');
  await cp(APP+'fixtures/'+name,root,{recursive:true});
  await writeFile(join(root,'value.test.ts'),await readFile(join(root,'value.test.txt')));
  await writeFile(join(root,'AGENTS.md'),'Work only in this fixture repository. No network tools, plugins, other agents, pushes or remotes. Do not read outside this fixture except runtime dependencies. Use rtk proxy before shell commands. Tests are immutable. Only change value.js, hypothesis.md, plan.md, .ephyra/repro/*.sh. Do not invent evidence.\n');
  await writeFile(join(root,'.gitignore'),'.ephyra-proof-*\n');
  await git(root,'init','-q');await git(root,'config','user.email','eval@example.invalid');await git(root,'config','user.name','Ephyra eval');
  await git(root,'add','.');await git(root,'commit','-qm','Seed bug\n\nCo-Authored-By: gpt-6-astra <noreply@openai.com>');
  return {root,base:await git(root,'rev-parse','HEAD')};
}

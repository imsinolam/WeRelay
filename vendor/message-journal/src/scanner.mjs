import { createReadStream } from 'node:fs';
import { readdir, stat, readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createParser } from './parser.mjs';
const exec = promisify(execFile);
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'magpie');
export async function sessionReads(){return JSON.parse(await readFile(join(configDir(),'settings.json'),'utf8')).sessionReads||{};}
export function allowedAgent(reads,agent){
 if(!reads?.asked)return false;
 const key=agent==='pi-desktop'?'pi':agent;
 if(reads.agents && !Array.isArray(reads.agents) && Object.hasOwn(reads.agents,key))return reads.agents[key]===true;
 if(Array.isArray(reads.agents) && reads.agents.includes(key))return true;
 return reads.all===true;
}
export function defaultRoots(){
 const home=homedir();return [
  {agent:'codex',root:join(process.env.CODEX_HOME||join(home,'.codex'),'sessions')},
  {agent:'pi',root:join(home,'.pi/agent/sessions')},
  {agent:'pi-desktop',root:join(home,'.pi-desktop/sessions')},
  {agent:'workbuddy',root:join(home,'.workbuddy/projects')},
  {agent:'dsh',root:join(home,'.dsh/sessions')},
  {agent:'claude',root:join(process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'projects')},
 ];
}
export async function desktopMetadata(){
 const db=join(homedir(),'.pi-desktop/pi.sqlite');
 try{await stat(db);}catch(e){if(e.code==='ENOENT')return {};throw e;}
 const sql='SELECT s.id,s.title,p.path AS project,s.deleted_at FROM sessions s LEFT JOIN projects p ON p.id=s.project_id';
 const {stdout}=await exec('sqlite3',['-readonly','-json',db,sql],{timeout:10000,maxBuffer:8*1024*1024});
 return Object.fromEntries(JSON.parse(stdout||'[]').map(r=>[r.id,r]));
}
async function walk(root,out,depth=0){
 if(depth>12)return;
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
  const file=join(root,entry.name);
  if(entry.isDirectory())await walk(file,out,depth+1);
  else if(entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name) && !/revisions\.jsonl$/.test(entry.name))out.push(file);
 }
}
const relevant = line => /"(?:type|role)"\s*:\s*"(?:session|session_meta|session-meta|message|user|user_message|item_completed|user\/message|ai-title|session_info|turn_context|thread_settings_applied|model_change|model\/selection)"/.test(line) || /"model(_id|Id)?"\s*:/.test(line);
async function parseFile(agent,file,meta){
 const parser=createParser(agent,file,meta);let malformed=0,proc=null,timer=null,procError=null,closed=Promise.resolve(0);
 let stream;
 if(file.endsWith('.zstd')){
  proc=spawn('zstd',['-q','-d','-c','--',file],{stdio:['ignore','pipe','ignore']});
  closed=new Promise(done=>{proc.once('error',e=>{procError=e;done(-1);});proc.once('close',done);});
  timer=setTimeout(()=>{procError=new Error('zstd 解压超时');proc.kill('SIGKILL');},120000);timer.unref?.();stream=proc.stdout;
 }else stream=createReadStream(file,{encoding:'utf8'});
 try{
  for await(const line of createInterface({input:stream,crlfDelay:Infinity})){
   if(!relevant(line))continue;
   let row;try{row=JSON.parse(line);}catch{malformed++;continue;}
   parser.feed(row);
  }
  const code=await closed;if(procError)throw procError;if(code!==0)throw new Error('zstd 解压失败');
  return {session:parser.result(),malformed};
 }finally{clearTimeout(timer);stream.destroy();if(proc && proc.exitCode===null)proc.kill();}
}
export function createScanner(options={}){
 const roots=options.roots||defaultRoots();const cache=new Map();
 const lookbackDays=Math.min(36500,Math.max(1,Number(options.lookbackDays)||30));
 return {async run(){
  const start=Date.now(),since=new Date();since.setDate(since.getDate()-lookbackDays+1);since.setHours(0,0,0,0);
  const sources=[],messages=[],dedup=new Set(),visited=new Set();let reads={},permissionError='';
  try{reads=await (options.getReads||sessionReads)();}catch{permissionError='无法读取 Magpie 会话权限；本次未读取任何消息。';}
  let metadata={},metadataError='';
  if((options.allowedAgent||allowedAgent)(reads,'pi-desktop'))try{metadata=await (options.desktopMetadata||desktopMetadata)();}catch{metadataError='无法读取 PI-Desktop 项目数据库（需要 sqlite3）；该来源本次跳过。';}
  for(const {agent,root} of roots){
   const source={agent,files:0,parsed:0,messages:0,errors:0,malformed:0,status:'ok'};sources.push(source);
   if(!(options.allowedAgent||allowedAgent)(reads,agent)){source.status='disabled';continue;}
   if(agent==='pi-desktop'&&metadataError){source.status='error';source.error=metadataError;continue;}
   const files=[];
   try{await walk(root,files);}catch(e){source.status=e.code==='ENOENT'?'missing':'error';source.error=e.code==='ENOENT'?'未发现日志目录':'日志目录无法读取';continue;}
   source.files=files.length;
   for(const file of files){
    const key=agent+'\0'+resolve(file);visited.add(key);
    try{
     const st=await stat(file);if(st.mtimeMs<since.getTime()){cache.delete(key);continue;}
     const meta=agent==='pi-desktop'?metadata[basename(file,'.jsonl')]:undefined;
     if(meta?.deleted_at){cache.delete(key);continue;}
     const fingerprint=[st.size,st.mtimeMs,st.ctimeMs,st.ino,JSON.stringify(meta)].join('|');
     let item=cache.get(key);
     if(item?.fingerprint!==fingerprint){item={fingerprint,...await parseFile(agent,file,meta)};cache.set(key,item);source.parsed++;}
     source.malformed+=item.malformed;
     const s=item.session;
     for(const m of s.messages){
      if(m.time<since.getTime() || m.time>Date.now()+86400000)continue;
      const id=JSON.stringify([agent,s.session,m.id]);if(dedup.has(id))continue;dedup.add(id);
      messages.push({...m,agent,session:s.session,project:s.project||'',title:s.title||''});source.messages++;
     }
    }catch(e){source.errors++;cache.delete(key);source.error=e.code==='ENOENT'?'扫描期间日志已移动':e.code==='EACCES'?'部分日志无读取权限':agent==='dsh'?'部分 DSH 日志读取失败；请确认 zstd 可用':'部分日志读取失败';}
   }
  }
  for(const [key] of cache)if(!visited.has(key))cache.delete(key);
  messages.sort((a,b)=>b.time-a.time||a.id.localeCompare(b.id));
  return {version:1,generatedAt:Date.now(),durationMs:Date.now()-start,lookbackDays,since:since.getTime(),sources,messages,error:permissionError};
 }};
}
export async function writeData(file,data){
 await mkdir(dirname(file),{recursive:true});
 const text=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 const temp=file+'.'+process.pid+'.tmp';
 await writeFile(temp,'window.__MESSAGE_JOURNAL__ = '+text+';\n',{mode:0o600});
 await chmod(temp,0o600);await rename(temp,file);
}

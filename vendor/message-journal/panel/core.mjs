export const AGENTS = { codex: 'Codex', pi: 'Pi', 'pi-desktop': 'PI-Desktop', claude: 'Claude Code', workbuddy: 'WorkBuddy', dsh: 'DSH' };
export function dayKey(time) {
 const d = new Date(time);
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function shiftDay(date,offset=0) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return '';
 const [y,m,d]=date.split('-').map(Number),local=new Date(y,m-1,d,12);
 if(dayKey(local)!==date)return '';
 local.setDate(local.getDate()+offset);return dayKey(local);
}
export function rankProjects(messages,date) {
 const previous=shiftDay(date,-1),counts=new Map();if(!previous)return [];
 for(const m of messages){const day=dayKey(m.time);if(day!==date&&day!==previous)continue;const path=m.project||'';counts.set(path,(counts.get(path)||0)+1);}
 return [...counts].map(([path,count])=>({path,count})).sort((a,b)=>b.count-a.count||a.path.localeCompare(b.path));
}
export const showMessageTime=(message,previous)=>!previous||Math.abs(message.time-previous.time)>600000;
export const sessionKey = m => JSON.stringify([m.agent,m.session]);
export const groupKey = m => JSON.stringify([dayKey(m.time),m.project,m.agent,m.session]);
export function searchMessages(messages, {query='',agent='',project='',from='',to=''}={}) {
 const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 return messages.filter(m=>{
  if(agent && m.agent!==agent || project && (m.project||'__unknown__')!==project)return false;
  const day=dayKey(m.time);if(from && day<from || to && day>to)return false;
  if(!words.length)return true;
  const haystack=[m.text,m.project,m.title,m.agent,AGENTS[m.agent],m.session].join('\n').toLocaleLowerCase();
  return words.every(w=>haystack.includes(w));
 });
}
export function groupMessages(messages,{order='desc'}={}) {
 const days=new Map(), sign=order==='asc'?1:-1;
 for(const m of messages){
  const date=dayKey(m.time);
  if(!days.has(date))days.set(date,{date,projects:new Map(),count:0});
  const day=days.get(date);day.count++;
  if(!day.projects.has(m.project))day.projects.set(m.project,{path:m.project,sessions:new Map(),count:0,time:m.time});
  const project=day.projects.get(m.project);project.count++; project.time=order==='asc'?Math.min(project.time,m.time):Math.max(project.time,m.time);
  const key=sessionKey(m);
  if(!project.sessions.has(key))project.sessions.set(key,{key:groupKey(m),session:m.session,agent:m.agent,project:m.project,title:m.title||'',messages:[],first:m.time,last:m.time});
  const session=project.sessions.get(key);session.messages.push(m);session.first=Math.min(session.first,m.time);session.last=Math.max(session.last,m.time);
 }
 const compare=(a,b)=>sign*(a.time-b.time)||a.path.localeCompare(b.path);
 return [...days.values()].sort((a,b)=>sign*a.date.localeCompare(b.date)).map(d=>({...d,projects:[...d.projects.values()].sort(compare).map(p=>({...p,sessions:[...p.sessions.values()].sort((a,b)=>sign*((order==='asc'?a.first:a.last)-(order==='asc'?b.first:b.last))||a.key.localeCompare(b.key)).map(s=>({...s,messages:s.messages.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id))}))}))}));
}
export function excerpt(text,query='',max=160){
 const word=query.trim().split(/\s+/).find(w=>text.toLocaleLowerCase().includes(w.toLocaleLowerCase()));
 const index=word?text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase()):0;
 const start=Math.max(0,index-45);return (start?'…':'')+text.slice(start,start+max).replace(/\s+/g,' ')+(text.length>start+max?'…':'');
}
export const messageIdentity=m=>m.ref||JSON.stringify([m.project||'',m.agent,m.session,m.id]);
export function timeMessages(messages,order='desc'){
 const sign=order==='asc'?1:-1;return [...messages].sort((a,b)=>sign*(a.time-b.time)||messageIdentity(a).localeCompare(messageIdentity(b)));
}
export function fitView(boxes,width,height,padding=16){
 if(!boxes.length||!(width>0)||!(height>0))return null;
 const left=Math.min(...boxes.map(b=>b.left)),top=Math.min(...boxes.map(b=>b.top)),right=Math.max(...boxes.map(b=>b.right)),bottom=Math.max(...boxes.map(b=>b.bottom));
 const w=Math.max(1,right-left),h=Math.max(1,bottom-top);
 const scale=Math.max(.15,Math.min(1,(width-padding*2)/w,(height-padding*2)/h));
 return {scale,x:(width-w*scale)/2-left*scale,y:(height-h*scale)/2-top*scale};
}
export function taskBranches(messages,classification,order='desc'){
 const sorted=timeMessages(messages,order);if(!classification?.tasks?.length)return [{id:'',title:'',messages:sorted}];
 const buckets=new Map(classification.tasks.map(t=>[t.id,{...t,messages:[]}])),unknown={id:'__unclassified__',title:'未分类',messages:[]};
 for(const m of sorted)(buckets.get(classification.assignments?.[messageIdentity(m)])||unknown).messages.push(m);
 return [...buckets.values()].filter(t=>t.messages.length).sort((a,b)=>b.messages.length-a.messages.length||a.id.localeCompare(b.id)).concat(unknown.messages.length?[unknown]:[]);
}

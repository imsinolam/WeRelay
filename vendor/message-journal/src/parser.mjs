import { basename } from 'node:path';
const timeOf = v => { const n=typeof v==='number'?v:Date.parse(v);return Number.isFinite(n)&&n>0?n:null; };
const injected = text => /^(?:# AGENTS\.md instructions for |<environment_context>|<environment_details>|<permissions instructions>|<subagent_notification>|<agent_message>|\[Agent message\]|<INSTRUCTIONS>|<system-reminder>|<task-notification>)/i.test(text.trim());
function cleanText(text){
 text=String(text||'').trim();
 // Codex prepends ambient browser state to a real user request in the same block.
 while(/^<in-app-browser-context\b/i.test(text)){
  const end=text.indexOf('</in-app-browser-context>');if(end<0)return '';
  text=text.slice(end+'</in-app-browser-context>'.length).trim();
 }
 return injected(text)?'':text;
}
export function textOf(content) {
 if(typeof content==='string')return cleanText(content);
 if(!Array.isArray(content))return '';
 return content.map(b=>{
  if(typeof b==='string')return cleanText(b);
  if(!b||typeof b!=='object')return '';
  if(['text','input_text'].includes(b.type))return cleanText(b.text);
  if(['image','input_image','image_url'].includes(b.type))return '[图片]';
  if(['file','input_file','attachment'].includes(b.type))return '[文件]';
  return '';
 }).filter(Boolean).join('\n').trim();
}
function human(message) {
 const kind=message?.source?.kind;
 return (!kind || ['user','human'].includes(kind)) && !message?.isMeta && !message?.isCompactSummary && !message?.isSidechain;
}
export function createParser(agent,file,metadata={}) {
 const state={agent,session:metadata.session||basename(file).replace(/\.jsonl(?:\.zstd)?$/,''),project:metadata.project||'',title:metadata.title||'',messages:[],hidden:false};
 const canonical=[],legacy=[],fallback=[], seen=new Set();let seq=0;
 // Model in effect over time: logs change model mid-session, so each message takes the last selection at or before it.
 const picks=[];
 function pick(model,time){const name=typeof model==='string'?model.trim():'';if(!name)return;const at=timeOf(time)||0;if(picks.some(p=>p.model===name&&p.time===at))return;picks.push({model:name,time:at});picks.sort((a,b)=>a.time-b.time);}
 function modelAt(time){const at=timeOf(time)||0;let found='';for(const p of picks){if(!p.time)continue;if(!at||p.time<=at)found=p.model;}return found||picks.find(p=>!p.time)?.model||picks[0]?.model||'';}
 function add(list,id,time,text,model=''){if(!text||!time)return;list.push({id:String(id||`line-${seq}`),time,text,model:String(model||'').slice(0,120)});}
 return {
  feed(row){
   seq++; if(!row||typeof row!=='object')return;
   const p=row.payload||{}, m=row.message||row;
   if(agent==='codex'){
    if(row.type==='session_meta'){
     state.session=p.id||p.session_id||state.session;state.project=p.cwd||state.project;
     pick(p.model,timeOf(p.timestamp)||timeOf(row.timestamp));
     state.hidden=!!(typeof p.source==='object' && p.source?.subagent)||p.source==='subagent';return;
    }
    if(row.type==='turn_context'){pick(p.model,timeOf(p.timestamp)||timeOf(row.timestamp));return;}
    if(row.type==='event_msg' && p.type==='thread_settings_applied'){pick(p.thread_settings?.model,timeOf(p.timestamp)||timeOf(row.timestamp));return;}
    if(row.type==='event_msg' && p.type==='item_completed' && p.item?.type==='UserMessage'){
     add(canonical,p.item.id,timeOf(p.completed_at_ms)||timeOf(row.timestamp),textOf(p.item.content));return;
    }
    if(row.type==='event_msg' && p.type==='user_message' && human(p)){
     add(legacy,p.id,timeOf(row.timestamp),textOf(p.message)+(p.images?.length?'\n[图片]':''));return;
    }
    if(row.type==='response_item' && p.type==='message' && p.role==='user' && human(p))add(fallback,p.id||row.metadata?.retained_source?.id?.message_id,timeOf(row.timestamp),textOf(p.content));
    return;
   }
   if(row.type==='session' || row.type==='session-meta'){
    state.session=row.sessionId||row.id||state.session;state.project=row.cwd||state.project;
    if(row.delegationDepth>0)state.hidden=true;return;
   }
   if(row.cwd)state.project=row.cwd;
   if(row.sessionId)state.session=row.sessionId;
   if(row.type==='ai-title' && row.aiTitle)state.title=row.aiTitle;
   if(row.type==='session_info' && row.name)state.title=row.name;
   if(row.type==='model_change'){pick(row.modelId,timeOf(row.timestamp));return;}
   if(m.role==='assistant' && m.model)pick(m.model,timeOf(m.timestamp)||timeOf(row.timestamp));
   if(agent==='dsh'){
    if(row.type==='model/selection'){pick(row.data?.model||row.data?.modelId,timeOf(row.time));return;}
    if(row.type==='user/message' && row.data?.source?.kind==='user')add(state.messages,row.data.id,timeOf(row.time),textOf(row.data.content));return;
   }
   if(agent==='workbuddy' && row.providerData?.model)pick(row.providerData.model,timeOf(row.timestamp));
   if(agent==='workbuddy' && row.providerData?.startsNewUserRequest===false)return;
   if(m.role==='user' && human(row) && human(m) && (row.type==='message'||row.type==='user')){
    add(state.messages,row.id||row.uuid||m.id,timeOf(row.createdAt)||timeOf(row.timestamp)||timeOf(m.timestamp),textOf(m.blocks||m.content));
   }
  },
  result(){
   const source=agent==='codex'?(canonical.length?canonical:legacy.length?legacy:fallback):state.messages;
   const messages=[];seen.clear();
   if(!state.hidden)for(const m of source){if(seen.has(m.id))continue;seen.add(m.id);messages.push({...m,model:m.model||modelAt(m.time)});}
   return {...state,messages:messages.sort((a,b)=>a.time-b.time)};
  }
 };
}

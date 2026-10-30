// Generate a self-contained, offline preview. No server, account or Agent is contacted.
// Usage: bun scripts/examples/chat-components.mjs /absolute/path/example.html
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CHAT_COMPONENTS_CSS, CHAT_COMPONENTS_JS, renderChatComposerHtml } from "../../src/web/chat-components/index.ts";

const output = resolve(process.argv[2] || "tmp/chat-components/example.html");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WeRelay 通用会话组件</title>
<style>${CHAT_COMPONENTS_CSS}
body { margin: 0; background: #f5f5f5; }
main { max-width: 1080px; margin: auto; padding: 24px; }
h1 { font-size: 24px; margin: 0 0 6px; } h2 { font-size: 16px; margin: 0 0 20px; }
.intro { color: #777; margin: 0 0 24px; font-size: 13px; }
.examples { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 24px; }
.example { min-width: 0; padding: 20px 0 0; border-radius: 24px; background: var(--page); overflow: visible; }
.example h2, .transcript, .event-log { padding: 0 24px; }
.transcript { min-height: 240px; } .event-log { font-size: 12px; min-height: 36px; color: var(--muted); }
.composer-wrap { position: relative; border-radius: 0 0 24px 24px; }
@media(max-width:760px) { main { padding: 16px 8px; } .examples { grid-template-columns: minmax(0,1fr); } .example { overflow: visible; } }
@media(prefers-color-scheme:dark) { body { background: #171717; } }
</style></head><body><main class="werelay-chat"><h1>通用会话组件</h1>
<p class="intro">独立运行的合成示例 · 所有操作只在本页生效，不发送真实任务</p>
<div class="examples">
<section class="example" id="example-first"><h2>完整会话与输入框</h2><div class="transcript"></div><div class="event-log" aria-live="polite"></div>${renderChatComposerHtml("first")}</section>
<section class="example" id="example-second"><h2>第二个独立实例</h2><div class="transcript"></div><div class="event-log" aria-live="polite"></div>${renderChatComposerHtml("second")}</section>
</div></main><script>
window.fixtureErrors=[];
addEventListener('error', function(e) { fixtureErrors.push(e.message); });
addEventListener('unhandledrejection', function(e) { fixtureErrors.push(String(e.reason)); });
${CHAT_COMPONENTS_JS}
var examples = {};
function mountExample(id) {
  var root = document.getElementById('example-' + id);
  var transcript = root.querySelector('.transcript');
  var log = root.querySelector('.event-log');
  var text = WeRelayChatUI.createText();
  var model = 'model-a', reasoning = 'medium', activeGroup = null;
  var modelOpen = false, sessionOpen = false, running = false, images = [], queue = [];
  function note(value) { log.textContent = value; }
  var bubble = WeRelayChatUI.createMessageBubble({document:document, text:text, actions:{
    onRetry: function() { note('已触发重新提交回调（示例）'); },
    onCopy: function(value) { note('复制回调：' + value); },
    onOpenImage: function() { note('已触发图片预览回调（示例）'); }
  }});
  function message(role, value, extra) {
    transcript.appendChild(bubble.render(Object.assign({id:id+'-'+transcript.children.length,
      message:{role:role, text:value}, text:value}, extra || {})));
  }
  function update() {
    var hasContent=Boolean(composer.getValue().trim() || images.length);
    composer.updateAction({enabled:true, hasContent:hasContent, stopMode:running && !hasContent, beamActive:hasContent && !running});
    composer.renderModel({visible:true, canChange:true, open:modelOpen, activeGroup:activeGroup,
      label:model==='model-a'?'示例模型 A':'示例模型 B', value:model,
      options:[{id:'model-a',label:'示例模型 A',group:'来源 A'},{id:'model-b',label:'示例模型 B',group:'来源 B'}]});
    composer.renderSession({visible:true, canChange:true, open:sessionOpen, label:(reasoning==='high'?'高':'中')+' · 项目内读写',groups:[
      {kind:'reasoning',label:'推理强度',value:reasoning,options:[{id:'medium',label:'中'},{id:'high',label:'高'}]},
      {kind:'permission',label:'访问权限',value:'workspace-write',options:[{id:'workspace-write',label:'项目内读写',description:'项目外操作仍需确认'}]}
    ]});
    composer.renderImages(images); composer.renderQueue(queue, {});
  }
  var composer = WeRelayChatUI.createComposer(root.querySelector('form'), {actions:{
    onSubmit:function() {
      var value=composer.getValue();
      if(running && !value.trim() && !images.length) { running=false; note('已触发停止回调（示例）'); update(); return; }
      if(!value.trim() && !images.length)return;
      message('user',value,{message:{role:'user',text:value,images:images}});
      composer.setValue(''); images=[]; running=true; note('已接收本地示例消息'); update();
    },
    onInput:update,
    onToggleMenu:function(kind) { if(kind==='model'){modelOpen=!modelOpen;sessionOpen=false;}else{sessionOpen=!sessionOpen;modelOpen=false;} update(); },
    onCloseMenu:function(kind) { if(kind==='model'){modelOpen=false;activeGroup=null;}else sessionOpen=false; },
    onModelGroup:function(group) { activeGroup=group; update(); },
    onModelSelect:function(value) { model=value; modelOpen=false; note('下一条消息将使用所选模型'); update(); },
    onSettingSelect:function(kind,value) { if(kind==='reasoning')reasoning=value;sessionOpen=false;update(); },
    onQueueEdit:function(item) { composer.setValue(item.text); queue=queue.filter(function(q){return q.id!==item.id;});update(); },
    onQueueDelete:function(key) { queue=queue.filter(function(q){return q.id!==key;});update(); },
    onQueueSteer:function(key) { note('已触发引导回调：'+key); },
    onFiles:function(files) { files.forEach(function(file) { var reader=new FileReader(); reader.onload=function(){images.push({id:String(images.length),fileName:file.name,previewUrl:reader.result});update();};reader.readAsDataURL(file); }); },
    onImageRemove:function(key){images=images.filter(function(image){return image.id!==key;});update();},
    onOpenImage:function(){note('已触发图片预览回调（示例）');}
  }});
  message('user', id==='first'?'保留现有气泡、工具展示和输入框。':'这里的输入和模型选择互不影响。');
  if(id==='first') {
    message('assistant', '工具命令保持默认折叠。\\n\\n\`\`\`bash\\npwd\\n\`\`\`\\n然后\\n\`\`\`sh\\nls\\n\`\`\`\\n最终结论保持可见。', {footer:{model:'示例模型 A',time:'完成于 18:00'}});
    queue=[{id:'example-queue',text:'稍后补充一条较长的检查说明，确认排队框仍然紧凑且按钮始终可见。',status:'queued'}];
  } else {
    message('user','这条失败消息始终保留',{message:{role:'user',text:'这条失败消息始终保留',clientId:'example-failed',pending:true,status:'failed'},delivery:{text:'连接暂时不可用，内容已保留',failed:true,retryLabel:'重新提交',copy:true}});
  }
  update(); examples[id]={composer:composer};
}
mountExample('first');mountExample('second');
</script></body></html>`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(output);

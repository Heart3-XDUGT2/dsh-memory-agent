globalThis.EchoViews = globalThis.EchoViews || {};
globalThis.EchoViews.config = (function () {
  'use strict';
  const S=globalThis.EchoSettingsState,F=globalThis.EchoSettingsForm,{el,button,safe,labelOf}=F,drafts=new S.Drafts();
  const categories=[['common','常用'],['persona','称呼与人格'],['chat','聊天与回复'],['memory','记忆与检索'],['emotion','情绪与关系'],['active','主动陪伴'],['model','模型与运行'],['qq','QQ与连接'],['rules','进阶规则']];
  const titles={'persona.json':'人格文本','profile.json':'称呼与显示','aliases.json':'别名规则','names.json':'人名词表','graph.json':'图谱规则','state-defaults.json':'新建状态初值','lexicon.json':'语言与词表',core:'主设置',main:'主设置',qq:'QQ插件设置',power:'Echo在线状态',scope:'会话范围','memory-tools':'子代理记忆工具','graph-gate':'影子边开关','qq-pin':'QQ兜底会话'};
  const common=new Set(['injectTopK','sharedRounds','reflectionEnabled','emotionDecayEnabled','wakeEnabled','llmDirectEnabled','bubble.enabled','bubble.maxChars','bubble.delayScale','relay.enabled','newSessionOn.dsh','newSessionOn.qq']);
  const when={'now':'保存后生效','next-turn':'下一轮对话生效','next-engine-call':'下次引擎调用生效','next-use':'下次使用该设置时读取；在途任务不变','applied':'按实际工具注册状态生效','next-client':'下次客户端或插件加载时读取','next-load':'下次插件加载时读取','next-poll':'下一次配置轮询时读取','retired':'兼容保留；当前不影响行为'};
  let host,category='common',query='',filter='all',advanced=false,preview=false,entries=[],sessions=[],errors=[],loaded=false,loading=false,mounted=false,serial=0,content,bar,notice,timer=null,feedback=[],errorPanel,readJobs=new Map();
  const graphCandidates={rows:[],busy:false,loaded:false,error:'',selected:null,controller:null,serial:0,shown:60};
  const categoryOf=g=>/传话/.test(g.title)?'qq':/群聊|新会话|气泡/.test(g.title)?'chat':/反思直调|会话清理/.test(g.title)?'model':/情绪|时间/.test(g.title)?'emotion':/主动|自由|想念|余波|议程|心跳/.test(g.title)?'active':/人格|称呼/.test(g.title)?'persona':'memory';
  const fileCategory=f=>/persona|profile/.test(f)?'persona':/state-defaults/.test(f)?'emotion':'rules';
  const pathHidden=p=>/(?:^|\.)(?:cwd|bridgeDir|script|bridgeArgs|qzoneBridgeDir|qzoneBridgeScript|qzoneBridgeArgs)$/.test(p);
  const pending=()=>[...drafts.sources.values()].some(s=>s.pendingRead),work=()=>drafts.count()>0||pending();
  async function request(path,method='GET',body,externalSignal){
    const controller=new AbortController(),clock=setTimeout(()=>controller.abort(),12000);
    try{const r=await fetch(path,{method,signal:externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal,cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','x-echo-edit':'1','x-echo-qq-edit':'1'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok){const detail=await r.json().catch(()=>({})),fields=(Array.isArray(detail.errors)?detail.errors:[]).map(s=>String(s).match(/^[\w.\[\]-]+/)?.[0]).filter(Boolean);throw Object.assign(Error('request failed'),{status:r.status,fields});}return await r.json();}finally{clearTimeout(clock);}
  }
  const sourceCategory=id=>id==='qq'||id==='qq-pin'?'qq':/\.json$/.test(id)?fileCategory(id):id==='scope'?'model':id==='core'||id==='main'?'common':'memory';
  function failure(e,{name='',phase='读取',draft=work()}={}){
    const reason=e.status===405?'接口方式不匹配，此项暂不可用。':e.status===404?'此项接口暂不可用。':e.status===403?'没有写入权限或当前来源不允许此操作。':e.status===400?'校验未通过，请检查字段类型、范围和规则格式。':e.name==='AbortError'?'请求超时，可重试。':e.status?'服务暂时无法完成请求，可重试。':'连接失败，请恢复连接后重试。';
    return name+phase+'失败：'+reason+(draft?' 草稿仍在。':'');
  }
  function sourceError(id,e){return{id,name:titles[id]||id,category:sourceCategory(id),text:failure(e,{name:titles[id]||id}),status:e.status};}
  function renderErrors(){
    if(!errorPanel)return;errorPanel.replaceChildren();errorPanel.hidden=!errors.length;
    if(!errors.length)return;const details=el('details','sc-source-errors');details.append(el('summary','',errors.length+' 个来源读取未完成'));
    for(const error of errors){const row=el('div','sc-source-error');row.dataset.errorSource=error.id;row.append(el('p','sc-error',error.text),changeButton(error.id,'重试读取',()=>retrySource(error.id),'sc-secondary'),button('前往相关分类',()=>choose(error.category),'sc-link'));details.append(row);}errorPanel.append(details);
  }
  async function retrySource(id){
    const job=readJobs.get(id);if(!job){await load(true);return;}if(job.busy||drafts.busy)return;job.busy=true;
    const trigger=errorPanel?.querySelector('[data-error-source="'+id+'"] button');if(trigger){trigger.disabled=true;trigger.textContent='正在读取…';}
    try{await job.run();if(id==='scope'||id==='qq-pin')syncSessions();errors=errors.filter(e=>e.id!==id);
      const active=document.activeElement,row=active?.closest('.sc-row'),key=row?.dataset.fieldKey,source=row?.dataset.source,index=row?[...row.querySelectorAll('input,textarea,select,button')].indexOf(active):-1,start=active?.selectionStart,end=active?.selectionEnd;
      const affected=entries.some(i=>i.id===(id==='qq'||id.endsWith('.json')?id:'control:'+id)&&visible(i));if(affected)renderContent();if(row&&affected){const replacement=[...content.querySelectorAll('.sc-row')].find(r=>r.dataset.fieldKey===key&&r.dataset.source===source)?.querySelectorAll('input,textarea,select,button')[index];replacement?.focus({preventScroll:true});if(replacement?.setSelectionRange&&start!==null)try{replacement.setSelectionRange(start,end);}catch{}}else if(errorPanel?.contains(active))notice?.focus();
    }catch(e){errors=errors.filter(x=>x.id!==id);errors.push(sourceError(id,e));}finally{job.busy=false;renderErrors();if(notice)notice.textContent=errors.length?'部分来源未读取，其他设置仍可编辑。':'设置来源已读取。';}
  }

  function entry(id,path,field,extra={}){const item={id,path,field,title:labelOf(field),...extra};entries.push(item);return item;}
  const sourceOf=i=>drafts.sources.get(i.id);
  const dirty=i=>[...(sourceOf(i)?.changes.values()||[])].some(c=>c.path.every((k,j)=>i.path[j]===k)||i.path.every((k,j)=>c.path[j]===k));
  const different=i=>{const s=sourceOf(i);return s?.defaults&&S.get(s.defaults,i.path)!==undefined&&!S.equal(S.get(s.value,i.path),S.get(s.defaults,i.path));};
  function options(scope,pin){const seen=new Set(),out=[];for(const r of scope?.sessions||[]){const id=r.sessionId;if(!id||seen.has(id))continue;seen.add(id);const label=safe(scope.sessionLabels?.[id]||r.label||r.title||'');out.push({value:id,label:label&&label!=='会话'?label:`会话 ${out.length+1}`});}for(const id of pin?.candidates||[])if(!seen.has(id)){seen.add(id);out.push({value:id,label:`可选会话 ${out.length+1}`});}return out;}
  async function readFile(file){const d=await request('/api/echo/data/'+file),fingerprint=d.unreadable?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(d.raw||'')))).map(n=>n.toString(16).padStart(2,'0')).join(''):null;return {value:d.unreadable||!d.exists?{}:d.value,exists:d.exists,broken:!!d.unreadable,template:d.template,fingerprint};} // taste-skill-ignore: hexadecimal SHA-256 byte encoding, never a visible section number.
  async function load(preserve=false){
    if(loading||drafts.busy)return;loading=true;if(notice)notice.textContent='正在读取设置…';
    try{
      const [main,schema]=await Promise.all([request('/api/echo/settings'),request('/api/echo/settings-schema')]);entries=[];errors=[];
      drafts.load('main',main.settings,{title:'主设置',kind:'patch',path:'/api/echo/settings',revision:main.revision,defaults:main.defaults,secretSet:main.relayTokenSet,effective:'next-use',read:async()=>{const d=await request('/api/echo/settings');return {value:d.settings,secretSet:d.relayTokenSet,revision:d.revision};}});
      for(const g of main.fields||[])for(const f of g.fields||[]){const path=[...(g.nested?[g.nested]:[]),...f.key.split('.')],key=path.join('.');entry('main',path,f,{category:categoryOf(g),group:g.title,key,common:common.has(key),secret:f.type==='password',pathHidden:pathHidden(key),session:key==='relay.sessionId'});}
      const jobs=[...(schema.files||[]).map(def=>({id:def.file,run:async()=>{
        const data=await readFile(def.file);drafts.load(def.file,data.value,{...data,title:titles[def.file]||def.file,kind:'file',path:'/api/echo/data/'+def.file,effective:def.effective,read:()=>readFile(def.file)});
        const fields=[...def.fields],known=new Set(fields.map(f=>f.key));for(const key of Object.keys(data.value||{}))if(!known.has(key)&&!['__proto__','constructor','prototype'].includes(key))fields.push({key,note:'额外字段会保留，可用结构编辑器调整。'});
        for(const f of fields)entry(def.file,[f.key],f,{category:fileCategory(def.file),group:titles[def.file]||def.file,key:f.key});
      }})),...(schema.controls||[]).map(def=>({id:def.id,run:async()=>{
        const read=async()=>{const raw=await request(def.readPath||(def.id==='power'?'/api/echo/status':def.path));return {value:{[def.key]:raw[def.readKey||def.key]},raw};},data=await read();drafts.load('control:'+def.id,data.value,{...data,def,title:def.label,kind:'control',path:def.path,effective:def.effective,read});
        if(def.id!=='qq-pin')entry('control:'+def.id,[def.key],def,{category:def.id==='scope'?'model':'memory',group:'运行开关',key:def.key,common:true});
      }}))];
      jobs.push({id:'qq',run:async()=>{const read=async()=>{const d=await request('/api/echo-qq/settings');return {value:d.broken||!d.exists?{}:d.settings,exists:d.exists,broken:d.broken,revision:d.revision,template:d.defaults,defaults:d.defaults,secretSet:d.secretSet};};const d=await request('/api/echo-qq/settings'),data={value:d.broken||!d.exists?{}:d.settings,exists:d.exists,broken:d.broken,revision:d.revision,template:d.defaults,defaults:d.defaults,secretSet:d.secretSet};drafts.load('qq',data.value,{...data,title:'QQ插件设置',kind:'qq',path:'/api/echo-qq/settings',effective:d.effective,read});for(const f of [...d.fields,...d.retired||[]])entry('qq',[f.key],['allowedUsers','allowedGroups','qzoneWatchList'].includes(f.key)?{...f,control:'qq-allowlist',listStorage:f.key==='qzoneWatchList'?'watch-string':'string-array',hint:f.control?f.hint:f.key==='qzoneWatchList'?'仅识别4至15位数字。空名单不感知其他人的空间评论；主人单独通道不受此名单影响。':f.key==='allowedUsers'?'空名单不接收私聊。未指定你的QQ号时，第一项作为主人兜底；顺序有意义。':'空名单不接收任何群。'}:f,{category:'qq',group:f.group||'旧兼容字段',key:f.key,secret:f.secret,pathHidden:f.path,common:f.key==='enabled'});}});
      for(const job of jobs){const original=job.run;job.run=async()=>{const id=job.id==='qq'||job.id.endsWith('.json')?job.id:'control:'+job.id,before=entries.filter(i=>i.id===id);entries=entries.filter(i=>i.id!==id);try{return await original();}catch(e){entries=entries.filter(i=>i.id!==id).concat(before);throw e;}};readJobs.set(job.id,job);}
      const results=await Promise.allSettled(jobs.map(j=>j.run()));results.forEach((r,i)=>{if(r.status==='rejected')errors.push(sourceError(jobs[i].id,r.reason));});
      syncSessions();
      loaded=true;
    }catch(e){errors=[sourceError('core',e)];}finally{loading=false;if(mounted){
      const active=document.activeElement,row=active?.closest('.sc-row'),focus=preserve&&row?{source:row.dataset.source,key:row.dataset.fieldKey,index:[...row.querySelectorAll('input,textarea,select,button')].indexOf(active),start:active.selectionStart,end:active.selectionEnd}:null;
      const bulk=preserve?[...host.querySelectorAll('.sc-list-bulk textarea')].map(n=>({source:n.closest('.sc-row').dataset.source,key:n.closest('.sc-row').dataset.fieldKey,value:n.value,open:n.closest('details').open})):[];
      const errorFocus=preserve&&errorPanel?.contains(active),scroll=scrollY;render();
      for(const item of bulk){const row=[...host.querySelectorAll('.sc-row')].find(r=>r.dataset.source===item.source&&r.dataset.fieldKey===item.key),n=row?.querySelector('.sc-list-bulk textarea');if(n){n.value=item.value;n.closest('details').open=item.open;n.dispatchEvent(new Event('input'));}}
      if(focus){const n=[...host.querySelectorAll('.sc-row')].find(r=>r.dataset.source===focus.source&&r.dataset.fieldKey===focus.key)?.querySelectorAll('input,textarea,select,button')[focus.index];n?.focus({preventScroll:true});if(n?.setSelectionRange&&focus.start!==null)try{n.setSelectionRange(focus.start,focus.end);}catch{}scrollTo({top:scroll,behavior:'instant'});}else if(errorFocus)notice?.focus({preventScroll:true});
    }}

  }
  function syncSessions(){
    entries=entries.filter(i=>! /^(?:session|label):/.test(i.id));
      const scope=drafts.sources.get('control:scope')?.raw,pin=drafts.sources.get('control:qq-pin')?.raw;sessions=options(scope,pin);
      if(scope)for(const option of sessions.filter(o=>(scope.sessions||[]).some(s=>s.sessionId===o.value))){
        const sid=option.value,index=sessions.indexOf(option),id='session:'+index,labelId='label:'+index,on=r=>!(r.manualOff||[]).includes(sid)&&(r.scope==='whitelist'?(r.whitelist||[]).includes(sid):!(r.exempt||[]).includes(sid));
        drafts.load(id,{on:on(scope)},{title:option.label+' · 启用',kind:'session',path:'/api/echo/scope',sid,effective:'next-turn',read:async()=>({value:{on:on(await request('/api/echo/scope'))}})});
        drafts.load(labelId,{label:scope.sessionLabels?.[sid]||''},{title:option.label+' · 标签',kind:'label',path:'/api/echo/session-label',sid,effective:'now',read:async()=>({value:{label:(await request('/api/echo/scope')).sessionLabels?.[sid]||''}})});
        entry(id,['on'],{key:'on',label:option.label+' · 允许陪伴',type:'bool'},{category:'model',group:'会话范围与标签',key:'sessionOn'});entry(labelId,['label'],{key:'label',label:option.label+' · 标签',type:'text',maxLen:24},{category:'model',group:'会话范围与标签',key:'sessionLabel'});
      }
      for(const i of entries.filter(e=>e.session))if(drafts.sources.has('control:qq-pin')){i.id='control:qq-pin';i.path=['sessionId'];}
  }
  function schemaWords(f){return [f.key,labelOf(f),f.note,...(f.nested||f.itemFields||[]).flatMap(schemaWords)];}
  function visible(i){if(query){const q=query.toLowerCase();if(![i.title,i.key,i.group,i.field.hint,...schemaWords(i.field)].some(t=>String(t||'').toLowerCase().includes(q)))return false;}else if(category==='common'?!i.common:i.category!==category)return false;
    if(!query&&category!=='common'&&!advanced&&!i.common&&!i.field.control&&!i.id.endsWith('.json')&&!/^(?:session|label|control):/.test(i.id))return false;if(filter==='dirty'&&!dirty(i))return false;if(filter==='different'&&!different(i))return false;return true;}
  function describe(v,i){if(i?.secret)return v?'替换密钥':'留空不改';if(i?.pathHidden)return v?'已配置路径':'空路径';if(i?.session)return sessions.find(s=>s.value===v)?.label||'已选会话';if(v===undefined)return '未记录';if(v===null)return '空值 / 继承';if(v==='')return '空文字';if(typeof v==='boolean')return v?'开':'关';if(Array.isArray(v))return `列表 · ${v.length} 项`;if(typeof v==='object')return `规则与映射 · ${Object.keys(v).length} 项`;return safe(String(v)).slice(0,180);}
  function changeButton(id,text,run,cls){const n=button(text,()=>{if(!drafts.locked(id))run();},cls);n.disabled=drafts.locked(id);return n;}
  function aliasCandidates(item){
    const source=sourceOf(item),box=el('section','pb-alias-candidates');
    const rules=()=>S.get(drafts.sources.get('aliases.json')?.value,['rules']);
    const existing=()=>new Set((Array.isArray(rules())?rules():[]).map(rule=>rule?.canonical).filter(name=>typeof name==='string'));
    box.append(el('h3','','从图谱提候选'),el('p','sc-help','只读取已有节点名称。选择并确认后加入当前别名草稿，别名留空等你补；仍需预览并保存才会写入。'));
    const fetchButton=button(graphCandidates.busy?'正在读取图谱…':'读取图谱候选',async()=>{
      if(graphCandidates.busy||drafts.locked(item.id)||!mounted)return;
      const controller=new AbortController(),job=++graphCandidates.serial;
      graphCandidates.controller=controller;graphCandidates.busy=true;graphCandidates.error='';graphCandidates.selected=null;renderContent();
      try{
        const data=await request('/api/echo/graph','GET',undefined,controller.signal);
        if(!mounted||controller.signal.aborted||job!==graphCandidates.serial)return;
        if(data?.offline===true||!Array.isArray(data?.nodes))throw Error('graph unavailable');
        graphCandidates.rows=[...new Set(data.nodes.map(n=>n?.name).filter(name=>typeof name==='string'&&name.trim()
          &&name.trim().length<=160&&globalThis.EchoPanels.text(name.trim())===name.trim()).map(name=>name.trim()))];
        graphCandidates.loaded=true;graphCandidates.shown=60;
      }catch(e){if(mounted&&!controller.signal.aborted&&job===graphCandidates.serial)graphCandidates.error='图谱候选读取失败，可重试；当前别名草稿保持。';}
      finally{if(job===graphCandidates.serial){graphCandidates.busy=false;graphCandidates.controller=null;if(mounted)renderContent();}}
    },'sc-secondary');
    fetchButton.disabled=graphCandidates.busy||drafts.locked(item.id)||!Array.isArray(rules())||source.broken&&!source.repair;
    box.append(fetchButton);
    if(graphCandidates.error)box.append(el('p','sc-error',graphCandidates.error));
    const candidates=graphCandidates.rows.filter(name=>!existing().has(name));
    if(graphCandidates.loaded)box.append(el('p','sc-help',candidates.length+' 个尚未加入规则的候选；不从节点ID推测名称。'));
    const list=el('div','pb-candidate-list');
    for(const name of candidates.slice(0,graphCandidates.shown)){
      const choose=button(name,()=>{graphCandidates.selected=name;renderContent();},'sc-secondary');
      choose.disabled=drafts.locked(item.id);list.append(choose);
    }
    box.append(list);
    if(candidates.length>graphCandidates.shown)box.append(button('查看更多候选',()=>{graphCandidates.shown+=60;renderContent();},'sc-link'));
    if(graphCandidates.selected&&candidates.includes(graphCandidates.selected)){
      const selected=graphCandidates.selected,confirm=el('div','pb-candidate-confirm');
      confirm.append(el('p','sc-help','将“'+selected+'”作为规范名称加入别名草稿，别名暂留空。'),changeButton(item.id,'确认加入草稿',()=>{
        const current=rules();if(!Array.isArray(current)||existing().has(selected))return;
        drafts.edit('aliases.json',['rules'],[...current,{alias:'',canonical:selected,tier:1,why:'图谱候选'}],{
          title:'别名规则',key:'rules',effective:source.effective});
        graphCandidates.selected=null;render();
      },'sc-secondary'),button('取消加入',()=>{graphCandidates.selected=null;renderContent();},'sc-link'));box.append(confirm);
    }
    return box;
  }
  function renderRow(i){
    const s=sourceOf(i),row=el('section','sc-row'),info=el('div','sc-field-info');row.dataset.fieldKey=i.key;row.dataset.source=i.id;row.id='sc-field-'+(++serial);row.tabIndex=-1;info.append(el('h3','',i.title));if(i.field.hint||i.field.note)info.append(el('p','sc-help',i.field.hint||i.field.note));
    if(i.id==='aliases.json'&&i.path[0]==='rules')info.append(aliasCandidates(i));
    if(i.field.effective)info.append(el('p','sc-help',when[i.field.effective]||'由所属插件读取。'));
    if(s.def&&['memory-tools','graph-gate'].includes(s.def.id))info.append(el('p','sc-help',`实际开关：${s.raw.on?'开':'关'}；也受环境与宿主配置影响。${s.def.id==='memory-tools'?'工具已注册：'+(s.raw.applied?'是':'否')+'。':''}`));
    const detail=el('details','sc-meta'),def=s.defaults?S.get(s.defaults,i.path):undefined;detail.append(el('summary','','字段与默认值'),el('p','sc-help',i.key),el('p','sc-help',def===undefined?'此来源没有公布默认值。':'默认：'+describe(def,i)));
    if(def!==undefined&&!i.field.readOnly&&!i.secret)detail.append(changeButton(i.id,'使用默认值',()=>{drafts.edit(i.id,i.path,def,{title:i.title,secret:i.secret,pathHidden:i.pathHidden,session:i.session,key:i.key});render();},'sc-link'));info.append(detail);row.append(info);
    if(i.field.readOnly||i.field.derived||i.field.retired)row.append(el('div','sc-readonly',i.field.retired?'当前已退役':describe(S.get(s.value,i.path),i)+' · 只读'));
    else{const f={...i.field};if(s.def?.id==='power')f.unknownLabel='状态未知';if(i.session)f.type='session';row.append(F.control(f,S.get(s.value,i.path),next=>{if(drafts.locked(i.id))return;drafts.edit(i.id,i.path,next,{title:i.title,secret:i.secret,pathHidden:i.pathHidden,session:i.session,key:i.key,effective:i.field.effective});row.classList.toggle('is-dirty',dirty(i));updateBar();},{name:i.title,secret:i.secret,path:i.pathHidden,secretSet:typeof s.secretSet==='object'?s.secretSet[i.key]:s.secretSet,sessions,disabled:drafts.locked(i.id)}));if(i.secret&&dirty(i))row.append(changeButton(i.id,'撤销密钥替换',()=>{drafts.edit(i.id,i.path,'',{secret:true});render();},'sc-link'));}if(query)for(const d of row.querySelectorAll('.sc-structure'))d.open=true;row.classList.toggle('is-dirty',dirty(i));return row;
  }
  function render(){
    if(!host||!mounted)return;stop();host.className='settings-center';host.replaceChildren();const toolbar=el('div','sc-toolbar'),search=el('input');search.type='search';search.placeholder='搜索设置名称或键名';search.setAttribute('aria-label','搜索全部设置');search.value=query;search.oninput=()=>{query=search.value;preview=false;renderContent();};
    const select=el('select');select.setAttribute('aria-label','设置筛选');for(const [v,t]of [['all','全部设置'],['different','与默认不同'],['dirty','待保存']]){const o=el('option','',t);o.value=v;select.append(o);}select.value=filter;select.onchange=()=>{filter=select.value;preview=false;renderContent();};
    const adv=el('label','sc-check'),check=el('input');check.type='checkbox';check.checked=advanced;check.onchange=()=>{advanced=check.checked;renderContent();};adv.append(check,el('span','','显示进阶项'));toolbar.append(search,select,adv);host.append(toolbar);
    const destinations=el('nav','pb-entry-links');destinations.setAttribute('aria-label','设置相关页面');
    for(const [href,title]of [['#/maintenance','文件与运行维护'],['#/injection','最近注入透视'],['/echo/','旧审查台']]){
      const link=el('a','sc-secondary',title);link.href=href;if(href==='/echo/'){link.target='_blank';link.rel='noopener noreferrer';}destinations.append(link);
    }host.append(destinations);
    notice=el('p','sc-notice');notice.setAttribute('role','status');notice.textContent=drafts.busy?'正在保存，暂时不能修改设置；仍可搜索和浏览。':loading?'正在读取设置…':errors.length?'部分来源未读取，可重试。':'草稿只保留在当前页面；保存前可集中检查。';notice.tabIndex=-1;host.append(notice);errorPanel=el('div');host.append(errorPanel);renderErrors();
    const layout=el('div','sc-layout'),nav=el('nav','sc-categories'),mobile=el('select','sc-category-select');nav.setAttribute('aria-label','设置分类');mobile.setAttribute('aria-label','设置分类');for(const [id,title]of categories){const b=button(title,()=>choose(id));b.dataset.category=id;b.setAttribute('aria-current',category===id?'page':'false');nav.append(b);const o=el('option','',title);o.value=id;mobile.append(o);}mobile.value=category;mobile.onchange=()=>choose(mobile.value);content=el('div','sc-workspace');layout.append(nav,mobile,content);host.append(layout);bar=el('div','sc-savebar');host.append(bar);renderContent();updateBar();
  }
  function choose(id){category=id;query='';preview=false;render();content?.focus();}
  function renderContent(){
    stop();if(!content)return;content.replaceChildren();content.tabIndex=-1;if(preview){renderPreview();return;}content.append(el('h2','sc-section-title',query?'搜索结果':categories.find(c=>c[0]===category)?.[1]||'设置'));if(query)content.append(el('p','sc-help','在所有分类和进阶项中查找。'));
    if(!loaded&&!loading)content.append(button('重新读取设置',load,'sc-secondary'));
    const shown=entries.filter(visible),groups=new Map();for(const i of shown){if(!groups.has(i.group))groups.set(i.group,[]);groups.get(i.group).push(i);}if(loaded&&!shown.length)content.append(el('p','sc-empty',filter==='different'?'此范围内没有与已公布默认值不同的设置。':filter==='dirty'?'此范围内没有待保存项。':query?'没有匹配设置，试试中文名称或技术键。':'打开「显示进阶项」查看这个分类的全部设置。'));
    for(const [title,items]of groups){const section=el('section','sc-group'),s=sourceOf(items[0]);section.append(el('h2','sc-group-title',title),el('p','sc-help',s.id==='state-defaults.json'?'仅设置新建状态的初值；不会重置当前情绪。':when[s.effective]||'生效时机由该来源报告。'));
      if(['file','qq'].includes(s.kind)&&(s.broken||!s.exists)&&!s.repair){const n=el('div','sc-error');n.append(el('p','',s.broken?'文件无法读取，不会自动覆盖。修复保存会经过原有备份流程。':'文件尚未建立，不会自动创建。'),changeButton(s.id,s.broken?'从空模板准备修复':'从空模板准备创建',()=>{s.repair=true;for(const i of entries.filter(i=>i.id===s.id&&!i.field.readOnly&&!i.field.retired)){const v=S.get(s.template,i.path);if(v!==undefined)drafts.edit(s.id,i.path,v,{title:i.title,key:i.key,secret:i.secret,pathHidden:i.pathHidden,effective:i.field.effective});}render();},'sc-secondary'));section.append(n);}else for(const i of items)section.append(renderRow(i));
      if(s.kind==='control'&&s.raw&&['memory-tools','graph-gate'].includes(s.def.id))section.append(el('p','sc-help',`实际开关：${s.raw.on?'开':'关'}；也受环境与宿主配置影响。${s.def.id==='memory-tools'?'工具已注册：'+(s.raw.applied?'是':'否')+'。':''}`));content.append(section);
    }
    if(!query&&['common','chat'].includes(category))rhythm();if(!query&&category==='qq'&&!drafts.sources.has('qq'))content.append(el('p','sc-help','QQ插件自有设置将在其受保护接口可用时读取。'));
    if(feedback.length){const n=el('section','sc-results');n.setAttribute('aria-label','上次保存结果');n.append(el('h2','sc-group-title','保存结果'));for(const r of feedback)n.append(el('p',r.ok?'sc-success':'sc-error',r.text));content.append(n);}
  }
  function updateBar(){if(!bar)return;bar.replaceChildren();bar.hidden=!work();if(!work())return;bar.append(el('span','',drafts.busy?'正在逐项保存…':`${drafts.count()} 项待保存${pending()?' · 有结果待读回':''}`));const discard=button('放弃草稿',()=>{if(drafts.busy||pending())return;drafts.discard();preview=false;render();},'sc-secondary');discard.disabled=drafts.busy||pending();const show=button(preview?'返回编辑':'查看改动',()=>{preview=!preview;renderContent();updateBar();},'sc-primary');bar.append(discard,show);}
  function deltaList(before,after,path=[],out=[]){
    if(S.equal(before,after))return out;
    if((before&&typeof before==='object')||(after&&typeof after==='object')){for(const key of new Set([...Object.keys(before||{}),...Object.keys(after||{})]))deltaList(before?.[key],after?.[key],[...path,Array.isArray(after)||Array.isArray(before)?`第 ${Number(key)+1} 项`:labelOf({key})],out);}
    else out.push({label:path.join(' / '),before,after});return out;
  }
  function renderPreview(){
    content.append(el('h2','sc-section-title','确认这次改动'),el('p','sc-help','逐个来源保存；某一来源失败时，其他已保存结果会保留。'));
    for(const s of drafts.sources.values())if(s.changes.size||s.pendingRead){const n=el('section','sc-group');n.append(el('h2','sc-group-title',s.title));for(const c of s.changes.values()){const row=el('div','sc-change');row.append(el('strong','',c.title||labelOf({key:c.path.at(-1)})),el('p','',c.secret?'替换密钥（内容不展示）':describe(c.before,c)+' → '+describe(c.after,c)));if(!c.secret&&!c.pathHidden&&!c.session){const deltas=deltaList(c.before,c.after,c.path.length>1?[labelOf({key:c.path.at(-1)})]:[]);if(deltas.length&&(typeof c.before==='object'||typeof c.after==='object')){const d=el('details');d.append(el('summary','','查看具体改动'));for(const v of deltas)d.append(el('p','',v.label+'：'+describe(v.before)+' → '+describe(v.after)));row.append(d);}}if(c.effective)row.append(el('p','sc-help',when[c.effective]));n.append(row);}
      if(s.pendingRead)n.append(el('p','sc-help','已收到保存成功响应，待读回实际值；重试只读取，不重复写入。'));
      if(s.conflicts?.length){n.append(el('p','sc-error','服务端的同一字段已有变化，先选择处理方式。'));for(const c of s.conflicts)n.append(el('p','sc-help',c.title||'此来源中的字段'));n.append(changeButton(s.id,'以最新值为基线，保留我的修改',()=>{for(const c of s.changes.values())c.before=S.clone(S.get(s.fresh,c.path));s.base=S.clone(s.fresh);s.revision=s.freshRevision;s.conflicts=null;renderContent();},'sc-secondary'),changeButton(s.id,'使用最新值，放弃此来源草稿',()=>{drafts.accepted(s.id,s.fresh,{revision:s.freshRevision});render();},'sc-link'));}
      for(const text of s.errors)n.append(el('p','sc-error',text));for(const i of s.errorFields||[])n.append(button('定位：'+i.title,()=>{query=i.key;preview=false;render();const row=[...content.querySelectorAll('.sc-row')].find(r=>r.dataset.source===i.id&&r.dataset.fieldKey===i.key);row?.scrollIntoView({block:'center'});row?.focus();},'sc-link'));content.append(n);}
    for(const r of feedback.filter(r=>r.ok))content.append(el('p','sc-success',r.text));
    const save=button(pending()?'读回并保存其余改动':'保存这些改动',saveAll,'sc-primary');save.disabled=drafts.busy||[...drafts.sources.values()].some(s=>s.conflicts?.length);content.append(save);
  }
  async function saveAll(){
    if(drafts.busy)return;drafts.busy=true;feedback=[];render();for(const s of [...drafts.sources.values()].filter(s=>s.changes.size||s.pendingRead)){let wrote=false,phase='保存前读取';const changed=[...s.changes.values()],name=s.id==='qq'&&changed.length===1?'QQ插件 / '+changed[0].title:s.title;try{
      if(s.pendingRead){phase='保存后读取';const actual=await s.read();drafts.accepted(s.id,actual.value,actual);feedback.push({ok:true,text:s.title+'：已读回实际保存值。'});continue;}
      const fresh=await s.read();if(['file','qq'].includes(s.kind)&&(fresh.exists!==s.exists||fresh.broken!==s.broken||fresh.fingerprint!==s.fingerprint))throw Object.assign(Error('file changed'),{fileChanged:true});const conflicts=drafts.rebase(s.id,fresh.value);
      if(fresh.revision!==s.revision)for(const c of s.changes.values())if(c.secret)conflicts.push(c.path);
      if(conflicts.length){s.fresh=fresh.value;s.freshRevision=fresh.revision;s.conflicts=conflicts.map(p=>[...s.changes.values()].find(c=>S.equal(c.path,p)));s.errors=['同一字段已有并发修改，尚未写入。'];feedback.push({ok:false,text:s.title+'：需要处理冲突，尚未保存。'});continue;}
      let payload=drafts.payload(s.id,fresh.value,['patch','control','qq'].includes(s.kind));if(s.kind==='file'){if((fresh.broken||!fresh.exists)&&!s.repair)throw Error('explicit repair required');if(fresh.broken||!fresh.exists)payload={...s.template,...payload};if(s.id==='persona.json')payload.edited=true;}
      if(s.kind==='qq')payload={settings:payload,revision:fresh.revision,...(!fresh.exists?{create:s.repair===true}:{}),...(fresh.broken?{repair:s.repair===true}:{})};
      if(s.kind==='session'||s.kind==='label')payload={sessionId:s.sid,...payload};const effects=[...new Set([...s.changes.values()].map(c=>c.effective).filter(Boolean))];phase='保存';const result=await request(s.path,s.kind==='file'?'PUT':'POST',payload);wrote=true;s.pendingRead=true;s.savedEffective=result.effective||s.effective;phase='保存后读取';const actual=await s.read();drafts.accepted(s.id,actual.value,{...actual,repair:false});
      let effective=s.kind==='qq'?effects.map(e=>when[e]||e).join('；'):when[s.savedEffective]||when[s.effective]||'请按该来源加载时机确认生效。';if(s.def?.id==='memory-tools')effective=actual.raw.applied?'实际工具已注册。':'面板值已保存；实际工具尚未注册。';if(s.def?.id==='graph-gate')effective=`实际开关${actual.raw.on?'开':'关'}；引擎下一帧读取，环境与宿主配置也参与判定。`;feedback.push({ok:true,text:s.title+'：已保存并读回。'+effective});
    }catch(e){s.errors=[e.fileChanged?'文件状态已改变，请重新读取后审查草稿再保存。':failure(e,{name,phase})];s.errorFields=entries.filter(i=>i.id===s.id&&(e.fields||[]).some(p=>p===i.key||p.startsWith(i.key+'.')||p.startsWith(i.key+'[')));feedback.push({ok:false,text:s.title+'：'+(wrote?'已保存，实际值待读回。':s.errors[0])});}}
    drafts.busy=false;preview=work();if(mounted){render();notice.textContent=feedback.some(r=>!r.ok)?'部分来源尚未完成；草稿与待读回项已保留。':'本次改动已逐来源保存并读回。';}
  }
  function stop(){if(timer!==null)clearTimeout(timer);timer=null;}
  function rhythm(){const n=el('section','sc-rhythm'),stage=el('div','sc-rhythm-stage');stage.setAttribute('aria-live','polite');stage.append(el('p','sc-help','点播放，看看气泡长度与停顿的感觉。'));n.append(el('h2','sc-group-title','感受聊天节奏'),el('p','sc-help','固定合成句的本地示意，不请求模型、不发送QQ；真实分条与延时还取决于回复内容。'),stage,button('播放示意',()=>{stop();stage.replaceChildren();const v=drafts.sources.get('main')?.value.bubble||{},sample='我记得这件事。先把眼前的一小步做完，我们再慢慢说。',length=Math.max(4,Number(v.maxChars)||sample.length),parts=v.enabled===false?[sample]:sample.match(new RegExp('.{1,'+Math.min(1000,length)+'}','gu'))||[sample];let index=0;function next(){if(!mounted)return;stage.append(el('p','sc-bubble',parts[index++]));if(index<parts.length){if(matchMedia('(prefers-reduced-motion: reduce)').matches){while(index<parts.length)stage.append(el('p','sc-bubble',parts[index++]));}else timer=setTimeout(next,Math.min(2500,Math.max(100,400*(Number(v.delayScale)||1))));}}next();},'sc-secondary'),button('停止',()=>{stop();stage.append(el('p','sc-help','已停止。'));},'sc-link'));content.append(n);}
  addEventListener('beforeunload',e=>{if(work()){e.preventDefault();e.returnValue='';}});
  return {mount(root){host=root;mounted=true;render();if(!loaded)load();},unmount(){mounted=false;stop();graphCandidates.controller?.abort();graphCandidates.controller=null;graphCandidates.busy=false;graphCandidates.serial++;graphCandidates.selected=null;},refresh:load};
})();

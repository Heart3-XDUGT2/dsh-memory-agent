/* Content projection only: never infer a step input from neighbouring audit rows. */
(function(root){
 'use strict';
 const own=(o,k)=>o!==null&&typeof o==='object'&&Object.prototype.hasOwnProperty.call(o,k);
 const object=v=>{try{const p=typeof v==='string'?JSON.parse(v):v;return p&&typeof p==='object'&&!Array.isArray(p)?p:null;}catch{return null;}};
 function safe(value){let text=String(value??'');text=text.replace(/[A-Za-z]:[\\/][^\s]+/gu,'（本地路径已隐藏）').replace(/session-[A-Za-z0-9_-]*/gu,'会话').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,'（内部标识已隐藏）');if(/^\s*[\{\[]/u.test(text))return '返回格式未能拆为字段，原始格式不上屏';const start=text.indexOf('{"');return start<0?text:text.slice(0,start)+'（原始格式不上屏）';}
 const tools=['retrieve','query_expand','same_turn_emotion'];
 const labels={text:'实际输入',previousVector:'起跑时的情绪',modelText:'送入模型的文本',topK:'请求条数',options:'本次检索选项',extraSeeds:'额外检索线索',terms:'扩展词',score:'解析后的情绪',vector:'情绪维度',global:'整体感受',target_master:'对你的感受',fatigue:'疲惫',valence:'心情',arousal:'唤醒度',affection:'爱意',playfulness:'玩心',sadness:'委屈',dependency:'依赖',intensity:'强度',reason:'原因',summary:'记忆摘要',total:'综合分值',r_now:'当前可回忆度',hits:'词法覆盖率',emotion_score:'情绪分值',emotionScore:'情绪分值',layer:'记忆层级',totalScore:'综合分值',similarity:'相似分值',importance:'重要程度',count:'数量',source:'来源',engine:'检索路径',status:'结果状态',graph:'关联知识路径',fromCache:'来自缓存',maxTerms:'最多线索数',timeoutMs:'超时上限（毫秒）',applied:'后续采用',raw:'模型原始返回',forced:'常驻记忆',truncated:'保存时有裁剪',version:'观测版本'};
 const statuses={success:'已完成',empty_result:'结果为空',cache_hit:'命中缓存，未重复调用',empty_query:'输入为空，提前结束',no_run:'没有可用调用，提前结束',timeout:'超时，未取得有效结果',failed:'调用失败',invalid:'返回未通过解析',skipped:'提前结束',ok:'已完成',not_requested:'未请求',unavailable:'未取得'};
 const state=v=>statuses[v]||null;
 const scalar=v=>v===undefined?'未保存':v===null?'未记录（null）':v===''?'空字符串':v===false?'否':v===true?'是':String(v);
 const purpose={retrieve:'寻找相关记忆，返回候选供组装选择。',query_expand:'把这句话换成有助于检索的短词。',same_turn_emotion:'准备同轮情绪读数，供组装尝试使用。'};
 function build(row,clean=safe){
  const tool=String(row.toolCall||row.stage||'');if(!tools.includes(tool))return null;
  const d=object(row.stageDetail)||{},io=object(d.io),fresh=io?.version===1&&io.source===tool;
  const input=fresh&&object(io.input),output=fresh&&object(io.output),process=fresh&&object(io.process);
  const inputText=input&&own(input,'text')?input.text:tool==='retrieve'&&own(row,'userInput')?row.userInput:undefined;
  let status=state(process?.status)||state(d.reason)||(d.timedOut===true?'超时，未取得有效结果':d.failed===true||d.error?'调用失败':d.ok===false?'未取得有效结果':d.ok===true?'记录标为成功':'本次过程未完整保存');
  const sections=[{kind:'input',title:'输入',entries:inputText===undefined?[['本次输入',fresh?'这条记录未保存输入':'这条旧记录未保存输入','input.text']]:[['实际输入',inputText===''?'输入为空':inputText===null?'输入未记录（null）':clean(String(inputText)),'input.text']]}];
  if(input)for(const[k,v]of Object.entries(input))if(k!=='text')sections[0].entries.push([labels[k]||k,v,'input.'+k]);
  const steps=[['用途',purpose[tool],'purpose'],['本次记录',status,'status']];
  if(process)for(const[k,v]of Object.entries(process))if(k!=='status'&&k!=='adopted')steps.push([labels[k]||k,k==='graph'?(state(v)||v):k==='engine'?({python:'完整检索引擎',baseline:'本地基线'}[v]||v):v,'process.'+k]);
  if(d.error)steps.push(['记录的错误',d.error,'error']);
  sections.push({kind:'process',title:'处理',entries:steps});
  const entries=[];
  if(tool==='retrieve'){
   const count=output&&own(output,'count')?output.count:own(d,'candidates')?d.candidates:undefined;
   entries.push(['返回候选数',count,'output.count']);
   if(output&&Array.isArray(output.items)){
    if(!output.items.length)entries.push(['返回记忆','没有返回记忆摘要','output.items']);
    output.items.forEach((item,i)=>entries.push(['已保存的返回摘要 '+(i+1),item,'output.items.'+i]));
   }else entries.push(['返回明细',fresh?'这条记录未保存记忆明细':'旧记录只保留查询与数量，未保存记忆明细','output.items']);
  }else if(tool==='query_expand'){
   if(output&&Array.isArray(output.terms))entries.push(['可供检索的词',output.terms.length?output.terms:'扩展词为空','output.terms']);
   else entries.push(['扩展词',fresh?'这条记录未保存词列表':'这条旧记录未保存词列表','output.terms']);
  }else{
   if(output&&own(output,'score')){const score=object(output.score);if(score){entries.push(['触发原因',score.reason,'output.score.reason'],['情绪强度',score.intensity,'output.score.intensity'],['情绪维度',score.vector,'output.score.vector']);}else entries.push(['校验后的情绪',output.score,'output.score']);}
   else entries.push(['校验后的情绪','未保存有效的解析读数','output.score']);
   const raw=output&&own(output,'raw')?output.raw:d.raw;
   if(raw!==undefined&&raw!==null&&raw!==''){
    entries.push(['记录中的模型返回',object(raw)||raw,'output.raw']);
    entries.push(['返回说明',fresh?'原始返回与校验后的读数分别保存':'原始返回不代表当时通过校验或实际采用','raw.note']);
   }
  }
  entries.push(['后续采用',process?.adopted===true?'明确已采用':process?.adopted===false?'明确未采用':'记录未说明，无法确认','adopted']);
  if(fresh&&io.truncation?.truncated)entries.push(['保存范围','摘要保存时有裁剪；原数量与裁剪项见专家字段','truncation']);
  sections.push({kind:'output',title:'输出',entries});
  let summary=tool==='retrieve'?((output?.count??d.candidates)!==undefined&& (output?.count??d.candidates)!==null?String(output?.count??d.candidates)+' 条候选 · 查看已存摘要':'查看查询与返回记录'):tool==='query_expand'&&Array.isArray(output?.terms)?(output.terms.length?output.terms.join('、'):'扩展词为空'):tool==='same_turn_emotion'&&output?.score?.reason?output.score.reason:status;
  return {tool,version:fresh?1:null,sections,summary:clean(String(summary))};
 }
 const omitted=Symbol('omitted'),identities=new Set(['turnTrace','traceId','sessionId']);
 function useful(value){return value!==null&&value!==undefined&&value!==''&&(!Array.isArray(value)||value.length>0)&&(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!identities.has(k)&&useful(value[k])));}
 function prune(value){if(!useful(value))return omitted;if(Array.isArray(value))return value.map(v=>{const p=prune(v);return p===omitted?v:p});if(value&&typeof value==='object'){const out={};for(const[k,v]of Object.entries(value)){if(identities.has(k))continue;const p=prune(v);if(p!==omitted)out[k]=p;}return out;}return value;}
 function contract(row){const d=object(row.stageDetail)||{},io=object(d.io),tool=String(row.toolCall||row.stage||'');return{d,io:io?.version===1&&io.source===tool?io:null,tool};}
 function project(row){
  const reading=build(row);if(!reading)return null;const{d,io,tool}=contract(row),input=object(io?.input),process=object(io?.process),output=object(io?.output);
  const knownResult=tool==='retrieve'?Array.isArray(output?.items)||typeof output?.count==='number':tool==='query_expand'?Array.isArray(output?.terms):!!object(output?.score);
  const hide=entry=>{const key=entry[2],v=entry[1];if(key==='purpose')return true;if(key==='adopted')return process?.adopted!==true&&process?.adopted!==false;if(key==='raw.note')return !!object(output?.score);if(key==='output.raw')return !!object(output?.score);if(key==='status')return knownResult&&['success','ok'].includes(process?.status);if(key==='input.modelText')return v===input?.text;if(key==='input.maxTerms')return true;if(key==='process.engine')return process?.engine==='python';if(key==='process.graph')return ['ok','not_requested'].includes(process?.graph);if(key==='process.fromCache')return process?.fromCache===false||process?.status==='cache_hit';if(key==='process.timeoutMs')return !['timeout','failed'].includes(process?.status);if(key==='input.text'||key.startsWith('output.')||key==='truncation')return false;return !useful(v);};
  return{...reading,sections:reading.sections.map(s=>({...s,entries:s.entries.filter(e=>!hide(e))})).filter(s=>s.entries.length),unknownAdoption:process?.adopted!==true&&process?.adopted!==false,legacy:!io,detail:d};
 }
 function expertProjection(row,node={}){
  const{d,io,tool}=contract(row),reading=project(row),out={},contents=node.contents||[],same=(a,b)=>{try{return JSON.stringify(a)===JSON.stringify(b);}catch{return false;}},shown=v=>typeof v==='string'&&contents.some(c=>c.text===safe(v));
  const omitRoot=new Set(['timestamp','toolCall','stage','step','traceId','sessionId']);
  for(const[k,v]of Object.entries(row)){
   if(omitRoot.has(k))continue;
   if(k==='latency'&&node.ms!==null&&node.ms!==undefined)continue;
   if(['userInput','llmReply','injectedMemories'].includes(k)&&shown(v))continue;
   if(k==='userInput'&&reading&&(io&&same(v,io.input?.text)||tool==='retrieve'&&!io||['query_expand','same_turn_emotion'].includes(tool)&&!io&&/^\(并行支 /u.test(String(v))))continue;
   if(k==='emotionVector'&&io&&same(v,io.output?.score?.vector))continue;
   if(k!=='stageDetail'){const p=prune(v);if(p!==omitted)out[k]=p;continue;}
   const detail={};
   for(const[key,value]of Object.entries(d)){
    if(['turnTrace','turnAssociation','beginAt','settleAt'].includes(key))continue;
    if(key==='ms'&&node.ms!==null&&node.ms!==undefined)continue;
    if(reading&&['raw','ok','timedOut'].includes(key))continue;
    if(reading&&key==='error')continue;
    if(reading&&key==='reason'&&state(value))continue;
    if(reading&&key==='candidates'&&(tool==='retrieve')&&(!io||same(value,io.output?.count)))continue;
    if(key==='io'&&io){const extra={};for(const[a,b]of Object.entries(io)){
      if(['version','source','input','process'].includes(a))continue;
      if(a==='truncation'&&b?.truncated!==true)continue;
      if(a==='output'&&b&&typeof b==='object'){const known=tool==='retrieve'?['items','count']:tool==='query_expand'?['terms']:['score','raw'];const rest=Object.fromEntries(Object.entries(b).filter(([name])=>!known.includes(name)));if(tool==='same_turn_emotion'&&object(b.score)){const score=Object.fromEntries(Object.entries(b.score).filter(([name])=>!['reason','intensity','vector'].includes(name)));if(useful(score))rest.score=score;}const p=prune(rest);if(p!==omitted)extra.output=p;continue;}
      const p=prune(b);if(p!==omitted)extra[a]=p;
    }if(useful(extra))detail.io=extra;continue;}
    const p=prune(value);if(p!==omitted)detail[key]=p;
   }
   if(useful(detail))out.stageDetail=detail;
  }
  return out;
 }
 function valueNode(api,value,depth=0,projected=value,path=''){
  const e=api.el,clean=safe;
  if(value===null||typeof value!=='object')return e('p','rn-value',clean(scalar(value)));
  const array=Array.isArray(value),list=e('dl','rn-pairs'),entries=array?value.map((v,i)=>[String(i),v]):Object.entries(value);
  if(!entries.length)return e('p','rn-value',Array.isArray(value)?'空数组':'空对象');
  if(depth>=12)return e('p','rn-value','嵌套层次过深，未展开');
  for(const[k,v]of entries){if(identities.has(k))continue;const next=projected!==omitted&&projected!==null&&typeof projected==='object'&&own(projected,k)?projected[k]:omitted,part=e('div','rn-pair');part.dataset.readKey=path+'.'+k;if(next===omitted)part.dataset.simpleHide='true';part.append(e('dt','',array?String(Number(k)+1):clean(labels[k]||k)),e('dd'));part.lastChild.append(valueNode(api,v,depth+1,next,path+'.'+k));list.append(part);}return list;
 }
 function render(api,reading,compactReading=reading){const allowed=new Set(compactReading.sections.flatMap(s=>s.entries.map(e=>e[2]))),group=api.el('div','rn-reading');for(const s of reading.sections){const section=api.el('section','rn-section');if(!s.entries.some(e=>allowed.has(e[2])))section.dataset.simpleHide='true';section.append(api.el('h3','',s.title));for(const[label,v,key]of s.entries){const folded=s.kind==='input'&&key!=='input.text'||key==='output.raw',part=api.el(folded?'details':'div','rn-entry');part.dataset.readKey=key;if(!allowed.has(key))part.dataset.simpleHide='true';part.append(api.el(folded?'summary':'h4','',label),valueNode(api,v,0,typeof v==='object'&&v!==null?prune(v):v,key));section.append(part);}group.append(section);}return group;}
 function expert(api,node,row,projection=row){
  const translations={timestamp:'记录时刻',userInput:'输入记录',llmReply:'回复记录',stageDetail:'步骤详情',agentState:'代理状态',emotionVector:'情绪向量',emotionPackStructured:'结构化情绪',injectedMemories:'注入记忆',injectedProfile:'注入画像',latency:'报告耗时',stage:'阶段',step:'步骤',traceId:'事件标识',sessionId:'会话标识'};
  for(const field of node.querySelectorAll('.au-l3-field')){const k=field.dataset.field,key=field.querySelector('.au-l3-key');field.dataset.readKey='expert.'+k;if(!own(projection,k))field.dataset.simpleHide='true';if(translations[k]){const name=api.el('span','rn-field-name',k);name.dataset.simpleHide='true';key.replaceChildren(api.el('span','rn-field-label',translations[k]),name);}
   if(['stageDetail','emotionVector','emotionPackStructured','agentState'].includes(k)){const obj=object(row[k]);if(obj){field.querySelector('.au-l3-val').replaceChildren(valueNode(api,obj,0,projection[k]??omitted,'expert.'+k));}}
  }return node;
 }
 root.EchoRoundNodeIO={safe,build,project,expertProjection,render,expert,object,valueNode,useful};
})(globalThis);

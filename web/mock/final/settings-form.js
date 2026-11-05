/* Structured controls; metadata and defaults are supplied by the owning API. */
(function (root) {
  'use strict';
  const S = root.EchoSettingsState;
  const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
  let serial = 0;
  const words = {
    prefix:'身份与人格', suffix:'说话方式与规则', userName:'你希望被怎样称呼', userAliases:'你的其他称呼',
    agentName:'她的名字', agentSelfRef:'她的自称', agentAliases:'她的其他称呼', nicknamePatterns:'昵称匹配规则',
    nicknameStrict:'严格匹配昵称', uiIndexPrefix:'情绪标题前缀', fallbackAddress:'备用称呼', locale:'界面语言', timezone:'时区',
    rules:'别名规则', alias:'别名', canonical:'规范名称', tier:'层级', why:'说明', speakers:'说话人名单',
    personNames:'人名词表', ownerNames:'你的称呼名单', familyTerms:'家人称谓', weights:'打分权重',
    thresholds:'分数阈值', windows:'时间窗口', relations:'关系规则', typeRules:'类型规则', relation:'关系名称', pairs:'类型配对',
    singleValue:'单值关系', multiValueKeys:'多值关系', identityRelations:'身份关系', pending:'待确认规则', defaultRelation:'默认关系',
    display:'图谱显示', moodIntensity:'情绪强度初值', prevMoodIntensity:'上次情绪强度初值', userEmotion:'用户情绪初始标签',
    emotionVector:'情绪向量初值', affinity:'好感度初值', longing:'想念初值', energy:'精力初值',
    synonymGroups:'同义词组', timeWords:'时间词表', bannedWords:'禁词', herInterests:'兴趣词表', retiredAliases:'旧称呼',
    stopwords:'检索停用词', topicStopwords:'话题停用词', powerWords:'上线与休眠口令', longingMarkers:'思念词根',
    wUnstale:'未过时权重',wSpecificity:'具体程度权重',wEmotion:'情感权重',topic:'话题',thread:'待跟进',memory:'记忆',
    stateFuzzy:'模糊状态',stateForgotten:'遗忘状态',candidateHours:'候选时间范围（小时）',cooldownMin:'冷却时间（分钟）',
    nightHoldFromHour:'夜间静默起点（时）',nightHoldToHour:'夜间静默终点（时）', wMin:'最小权重',wMax:'最大权重',
    radiusBase:'节点基础半径',radiusScale:'节点半径倍率',edgeWidthMin:'最小连线宽度',edgeWidthMax:'最大连线宽度',
    flowSlowSec:'慢速流动（秒）',flowFastSec:'快速流动（秒）',enterDelayMaxMs:'最大入场延时（毫秒）',
    schemaRev:'数据版本',savedAt:'保存时间',updatedAt:'更新时间',edited:'用户已编辑',defaultsRev:'默认文本版本',
    label:'会话标签',on:'该会话启用',off:'休眠口令'
  };
  function safe(value) { return String(value ?? '').replace(/[A-Za-z]:[\\/][^\s，。；）)]+/g,'已配置路径').replace(/(?:~[\\/]|[\\/](?:Users|home)[\\/])[^\s，。；）)]+/g,'本地目录').replace(/session-[0-9a-z-]+/gi,'会话').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'内部标识'); }
  function el(tag, cls, text) { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=safe(text); return n; }
  function button(text, fn, cls='') { const n=el('button',cls,text); n.type='button'; n.addEventListener('click',fn); return n; }
  const labelOf=f=>f.label||words[f.key]||f.note?.split(/[（(:：]/)[0]||f.key;
  function typeOf(f,v) { if(f.type)return f.type; return Array.isArray(v)?'array':typeof v==='boolean'?'bool':typeof v==='number'?'number':v&&typeof v==='object'?'object':'string'; }
  const empty = f => /\[\]$/.test(f.type)||f.type==='array'?[]:f.type==='object'?{}:['num','int','number'].includes(f.type)?null:f.type==='bool'?false:'';
  function whitelist(field,value,change,options){
    const name=options.name||labelOf(field),kind=field.listStorage,model=root.EchoWhitelist.model(value,kind),box=el('div','sc-control sc-allowlist');
    const count=el('p','sc-list-count'),rows=el('div','sc-list-rows'),status=el('p','sc-help');status.setAttribute('role','status');
    let shown=6;
    function changed(next){change(next);status.textContent=kind==='watch-string'?'按当前行顺序保存为文字；分隔符整理为换行，不排序、不去重。':'保留当前行顺序，不排序、不去重。';}
    function paint(focus){
      rows.replaceChildren();count.textContent=`${model.rows.length} 项`;const issues=model.issues();
      for(const [i,text] of model.rows.slice(0,shown).entries()){
        const row=el('div','sc-list-row'),label=el('label','sc-list-label',`第 ${i+1} 项`),n=el('textarea'),error=el('p','sc-list-warning');
        n.rows=1;n.wrap='soft';n.id='sc-list-'+(++serial);n.value=text;n.setAttribute('aria-label',`${name} 第 ${i+1} 项`);n.autocomplete='off';label.htmlFor=n.id;
        const hint=()=>{const issue=model.issues()[i];error.textContent=!issue.valid?(kind==='watch-string'?'此项不符合4至15位数字规则，空间评论不会识别；请更正或移除。':'空文字会被配置解析器忽略；请填写或移除。'):issue.duplicate?(kind==='watch-string'?'重复项：空间评论只按同一号码识别一次。':'重复项会按原顺序保留。'):'';n.setAttribute('aria-invalid',String(!issue.valid));};
        error.id=n.id+'-error';n.setAttribute('aria-describedby',error.id);hint();
        const resize=()=>{n.style.height='auto';n.style.height=Math.max(38,n.scrollHeight)+'px';};queueMicrotask(resize);n.oninput=()=>{resize();changed(model.replace(i,n.value));hint();};n.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();add.click();}};
        const remove=button('移除',()=>{changed(model.remove(i));paint(Math.min(i,model.rows.length-1));if(!model.rows.length)add.focus();},'sc-link');remove.setAttribute('aria-label',`${name} 移除第 ${i+1} 项`);
        row.append(label,n,remove,error);rows.append(row);
      }
      let expand;if(model.rows.length>shown)rows.append(expand=button(`展开其余 ${model.rows.length-shown} 项`,()=>{shown=model.rows.length;paint();},'sc-link'));
      if(focus!==undefined)rows.querySelectorAll('textarea')[focus]?.focus();
      for(const n of box.querySelectorAll('input,textarea,button'))if(n!==apply)n.disabled=!!options.disabled;apply.disabled=!!options.disabled||!candidates.length||candidates.some(i=>!i.valid);if(expand)expand.disabled=false;
    }
    const add=button('添加一项',()=>{shown=model.rows.length+1;changed(model.add(''));paint(model.rows.length-1);},'sc-secondary');
    const bulk=el('details','sc-list-bulk');bulk.append(el('summary','','批量添加'));
    const label=el('label','sc-help','粘贴多项，用逗号、空格或换行分开'),input=el('textarea'),review=el('div','sc-list-review');
    input.id='sc-bulk-'+(++serial);input.setAttribute('aria-label',name+' 批量添加');label.htmlFor=input.id;input.rows=3;
    let candidates=[];
    const apply=button('添加这些项',()=>{if(!candidates.length||candidates.some(i=>!i.valid))return;shown=model.rows.length+candidates.length;changed(model.append(candidates));input.value='';candidates=[];review.replaceChildren();apply.disabled=true;paint();add.focus();},'sc-secondary');apply.disabled=true;
    input.oninput=()=>{candidates=model.review(input.value);review.replaceChildren();for(const item of candidates){const line=el('p',item.valid?'sc-help':'sc-list-warning',item.text+(!item.valid?' · 无效，请在粘贴框更正':item.duplicate?' · 重复，将保留这一项':''));review.append(line);}apply.textContent=`添加这 ${candidates.length} 项`;apply.disabled=!!options.disabled||!candidates.length||candidates.some(i=>!i.valid);};
    bulk.append(label,input,review,apply);box.append(count,rows,add,bulk,status);paint();return box;
  }
  function control(field, value, change, options={}) {
    if(field.control==='qq-allowlist')return whitelist(field,value,change,options);
    const box=el('div','sc-control');
    const type=typeOf(field,value), name=options.name||labelOf(field), id='sc-input-'+(++serial);
    const bind=n=>{n.id=id;n.setAttribute('aria-label',name);n.disabled=!!options.disabled;return n;};
    if (type==='bool') {
      if (value===null || value===undefined || field.nullable) {
        const n=bind(el('select')); for(const [v,t] of [['',field.unknownLabel||'未设置 / 继承'],['true','开'],['false','关']]){const o=el('option','',t);o.value=v;n.append(o);} n.value=value===true?'true':value===false?'false':'';
        n.onchange=()=>change(n.value===''?null:n.value==='true');box.append(n);
      } else {
        const line=el('label','sc-check'), n=bind(el('input'));n.type='checkbox';n.checked=value===true;const state=el('span','',n.checked?'开':'关');n.onchange=()=>{state.textContent=n.checked?'开':'关';change(n.checked);};line.append(n,state);box.append(line);
      }
    } else if (type==='enum'||type==='session') {
      const n=bind(el('select')); const opts=type==='session'?options.sessions||[]:field.options||[];
      const all=[{value:'',label:type==='session'?'选择会话':'未设置'},...opts];
      if(value&&!all.some(o=>o.value===value))all.push({value,label:'当前已选会话（未列入可选项）'});
      for(const o of all){const opt=el('option','',o.label);opt.value=o.value;n.append(opt);}n.value=value??'';n.onchange=()=>change(n.value);box.append(n);
    } else if (type==='object'||type==='array'||type.endsWith('[]')) {
      const array=type!=='object',shapeOK=value!==null&&typeof value==='object'&&(array?Array.isArray(value):!Array.isArray(value)),current=S.clone(shapeOK?value:(array?[]:{}));
      const details=el('details','sc-structure'); details.append(el('summary','',`${array?'列表':'规则与映射'} · ${Object.keys(current).length} 项`));
      const body=el('div','sc-structure-body');details.append(body);
      function paint() {
        body.replaceChildren(); details.querySelector('summary').textContent=`${array?'列表':'规则与映射'} · ${Object.keys(current).length} 项`;
        const declared=array?[]:field.nested||[], keys=array?Object.keys(current):[...new Set([...declared.map(f=>f.key),...Object.keys(current)])];
        for(const key of keys) {
          if(unsafe.has(key))continue;
          const member=array?(type==='string[]'?{type:'string',maxLen:field.itemMaxLen}:type==='object[]'?{type:'object',nested:field.itemFields}:{}):declared.find(f=>f.key===key)||{};
          const item=el('div','sc-member'), head=el('div','sc-member-head');
          head.append(el('span','',array?`第 ${Number(key)+1} 项`:labelOf({...member,key})));
          if(array||!declared.some(f=>f.key===key))head.append(button('移除',()=>{if(array)current.splice(Number(key),1);else delete current[key];change(S.clone(current));paint();},'sc-link'));
          item.append(head,control(member,current[key],next=>{current[key]=next;change(S.clone(current));},{...options,name:`${name} / ${array?Number(key)+1:labelOf({...member,key})}`}));body.append(item);
        }
        const add=el('div','sc-add');
        const choose=el('select');choose.setAttribute('aria-label',name+' 新项类型');
        const types=type==='string[]'?[['string','文字']]:type==='object[]'?[['object','规则']]:[['string','文字'],['number','数字'],['bool','开关'],['array','列表'],['object','映射']];
        for(const [v,t]of types){const o=el('option','',t);o.value=v;choose.append(o);}
        const keyInput=el('input');keyInput.placeholder='新字段键名';keyInput.setAttribute('aria-label',name+' 新字段键名');
        if(!array)add.append(keyInput);if(types.length>1)add.append(choose);
        add.append(button(array?'添加一项':'添加字段',()=>{
          const key=array?current.length:keyInput.value.trim();
          if(!array&&(!key||unsafe.has(key)||Object.hasOwn(current,key))){keyInput.setCustomValidity('请输入尚未使用的安全键名');keyInput.reportValidity();return;}
          const f={type:choose.value};let initial=f.type==='number'?0:empty(f);
          if(type==='object[]'&&field.itemFields)initial=Object.fromEntries(field.itemFields.map(f=>[f.key,empty(f)]));
          current[key]=initial;change(S.clone(current));paint();body.querySelector('.sc-add button')?.focus();
        },'sc-secondary'));body.append(add);
        for(const n of body.querySelectorAll('button,input,select,textarea'))if(options.disabled)n.disabled=true;
      }
      paint();box.append(details);
      if(value!==null&&value!==undefined&&!shapeOK)box.append(el('p','sc-help','当前字段结构不匹配；添加内容会替换此字段，保存前可检查具体改动。'));
      if(value===null||value===undefined)box.append(el('p','sc-help','未设置；展开后添加内容会建立此项。'));
      if(field.nullable)box.append(button('设为空值 / 继承',()=>change(null),'sc-link'));
    } else {
      const secret=type==='password'||options.secret, hiddenPath=!!options.path;
      const n=bind(el(type==='textarea'||(!secret&&!hiddenPath&&field.maxLen>500)?'textarea':'input'));
      if(n.tagName==='INPUT')n.type=secret?'password':['num','number','int'].includes(type)?'number':'text';
      if(secret){n.autocomplete='new-password';n.value='';n.placeholder=options.secretSet?'已配置；留空不改':'未配置；留空不改';}
      else if(hiddenPath){n.value='';n.placeholder=value?'已配置；输入替换路径':'未配置；输入路径';}
      else n.value=value??'';
      if(n.type==='number'){if(field.min!==undefined)n.min=field.min;if(field.max!==undefined)n.max=field.max;n.step=field.step??(type==='int'?1:'any');n.placeholder='未设置';}
      if(field.maxLen!==undefined)n.maxLength=field.maxLen;
      n.oninput=()=>{if(n.type==='number'&&!n.validity.valid)n.reportValidity();change(n.type==='number'?(n.value===''?null:Number(n.value)):n.value);};
      box.append(n);
      if(hiddenPath)box.append(button('清空路径',()=>{n.value='';n.placeholder='待保存：清空';change('');},'sc-link'));
    }
    if(options.disabled)for(const n of box.querySelectorAll('button,input,select,textarea'))n.disabled=true;
    return box;
  }
  root.EchoSettingsForm={el,button,safe,labelOf,control,empty};
})(globalThis);

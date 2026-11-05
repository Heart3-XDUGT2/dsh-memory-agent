/* One recorded event per node. Camera and local offsets never alter audit facts. */
globalThis.EchoViews=globalThis.EchoViews||{};
globalThis.EchoViews.round=(function(){
 'use strict';
 const NS='http://www.w3.org/2000/svg',DASH=String.fromCharCode(0x2014);
 let host=null,screen=null,turnRef=null,model=null,viewport=null,world=null,frame=null,overlay=null,overlayBody=null,camera=null,preview=null;
 let layout=new Map(),offsets=new Map(),nodeEls=new Map(),edgeEls=new Map(),selected=-1,selectedEdge=null,returnFocus=null,adjusting=false,loadId=0;
 let demoIndex=-1,demoPlaying=false,demoTimer=0,playButton=null,status=null,resizeObserver=null,stopOwnership=()=>{},lifecycle=null,skipFocusCamera=false;
 const animations=new Set(),api=()=>globalThis.EchoViews.audit,reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 const preferenceKey='echo.round.compact.v1';let simple=true,simpleButton=null,hiddenNote=null,readingPositions={};
 try{simple=localStorage.getItem(preferenceKey)!=='0';}catch{ /* A blocked preference store leaves a usable default. */ }
 const el=(tag,cls,text)=>screen.el(tag,cls,text);
 function applySimple(preserve=false){
   if(simpleButton)simpleButton.setAttribute('aria-pressed',String(simple));if(!overlayBody)return;
   const pane=overlayBody,top=pane.scrollTop,mode=simple?'compact':'full',prior=simple?'full':'compact',rect=pane.getBoundingClientRect();
   const visible=n=>!n.closest('[hidden]'),willShow=n=>!simple||!n.closest('[data-simple-hide="true"]');
   const anchor=preserve?[...pane.querySelectorAll('[data-read-key]')].find(n=>visible(n)&&willShow(n)&&n.getBoundingClientRect().bottom>rect.top+8):null,anchorTop=anchor?.getBoundingClientRect().top;
   if(preserve)readingPositions[prior]=top;
   for(const node of pane.querySelectorAll('[data-simple-hide="true"]'))node.hidden=simple;
   const expert=pane.querySelector('.rf-expert'),fields=expert?.querySelectorAll('.au-l3-field');if(expert){const count=[...fields].filter(n=>!n.hidden).length;expert.querySelector('summary').textContent=simple?'补充字段'+(fields.length?' · '+count+'项':''):'专家字段 · 21项';}
   const hidden=[...pane.querySelectorAll('[data-simple-hide="true"]')].filter(n=>!n.parentElement.closest('[data-simple-hide="true"]')).length;
   if(hiddenNote){hiddenNote.textContent='已收起 '+hidden+'项';hiddenNote.hidden=!simple||hidden===0;}
   if(preserve){if(Number.isFinite(readingPositions[mode]))pane.scrollTop=readingPositions[mode];else if(anchor&&!anchor.closest('[hidden]'))pane.scrollTop=top+anchor.getBoundingClientRect().top-anchorTop;else pane.scrollTop=top;}
 }
 function toggleSimple(){simple=!simple;try{localStorage.setItem(preferenceKey,simple?'1':'0');}catch{ /* The in-memory choice still persists across this view's refresh/navigation. */ }applySimple(true);}
 function auxiliary(node,hide=true){if(hide)node.dataset.simpleHide='true';return node;}
 function svg(tag,attrs={},text){const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;}
 function button(text,action,cls=''){const b=el('button','rm-button '+cls,text);b.type='button';b.addEventListener('click',action);return b;}
 function motion(node,keyframes,options){if(reduced())return null;const a=node.animate(keyframes,options);animations.add(a);a.finished.catch(()=>{}).finally(()=>animations.delete(a));return a;}
 function cancelMotion(){for(const a of animations)a.cancel();animations.clear();}
 function clock(ms){if(!(ms>0))return DASH;const d=new Date(ms),p=n=>n<10?'0'+n:String(n);return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+'.'+String(d.getMilliseconds()).padStart(3,'0');}
 function identities(turn){const seen=new Map();return turn.rows.map(row=>{const key=JSON.stringify([row.traceId,row.timestamp,row.toolCall,row.stage,row.step]),count=seen.get(key)||0;seen.set(key,count+1);return key+'#'+count;});}
  function widthOf(text, size) {
    let wide = 0;
    for (const ch of Array.from(String(text))) {
      wide += /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/u.test(ch) ? size : size * 0.56;
    }
    return wide;
  }

  // 超宽就裁：图形里的字没有第二行，裁掉的部分在浮层与文字明细里。
  function fitText(text, room, size) {
    const line = String(text);
    if (widthOf(line, size) <= room) return line;
    let out = '';
    let used = 0;
    for (const ch of Array.from(line)) {
      const step = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/u.test(ch) ? size : size * 0.56;
      if (used + step > room - size) break;
      out += ch;
      used += step;
    }
    return `${out}…`;
  }

  // 单位向量（箭头三角与折线取方向用）。
  function norm(dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  // 折线 + 圆角拐角：需要"走直角再抹圆"的线用它（时间轴的引线、以后的多段走线）。
  function pathOf(points, radius) {
    if (points.length < 2) return '';
    let d = `M${points[0][0]},${points[0][1]}`;
    for (let i = 1; i < points.length; i += 1) {
      const here = points[i];
      const prev = points[i - 1];
      if (i === points.length - 1) {
        d += ` L${here[0]},${here[1]}`;
        break;
      }
      const next = points[i + 1];
      const back = norm(prev[0] - here[0], prev[1] - here[1]);
      const out = norm(next[0] - here[0], next[1] - here[1]);
      const room = Math.min(radius, Math.hypot(prev[0] - here[0], prev[1] - here[1]) / 2, Math.hypot(next[0] - here[0], next[1] - here[1]) / 2);
      const a = [here[0] + back[0] * room, here[1] + back[1] * room];
      const b = [here[0] + out[0] * room, here[1] + out[1] * room];
      d += ` L${a[0]},${a[1]} Q${here[0]},${here[1]} ${b[0]},${b[1]}`;
    }
    // 折线长度（stroke-dashoffset 的"按序画出"用）：留一段余量，宁可长一点。
    return d;
  }
  // 折线长度（用来做 stroke-dashoffset 的"按序画出"）。圆角让真实路径略短，所以估值只会偏长：
  // 偏长的后果是起点那一瞬间线头还没露出来，不会出现"线没画到却已经到头"。
  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return total;
  }

  // 箭头：自己画三角，不用 marker —— marker 在 line 还没画到的时候就会露出来，抢"按序画出"的戏。
  function headPath(tip, from) {
    const [ux, uy] = norm(tip[0] - from[0], tip[1] - from[1]);
    const base = [tip[0] - ux * 9, tip[1] - uy * 9];
    const side = [-uy * 4, ux * 4];
    return `M${tip[0]},${tip[1]} L${base[0] + side[0]},${base[1] + side[1]} L${base[0] - side[0]},${base[1] - side[1]} Z`;
  }


 function project(){
   const spots=new Map(),put=(i,x,y,w=244,h=132)=>spots.set(i,{x,y,w,h});
   if(model.groups.length===1){
     const g=model.groups[0];put(g.from,28,100,244,g.from<0?44:132);
     g.arms.forEach((i,k)=>put(i,28,280+k*200,244,156));
     if(g.to>=0)put(g.to,420,310);
     let primary=0,secondary=0;
     for(const n of model.nodes){if(spots.has(n.index))continue;
       if(['inject','extract'].includes(n.tool)){put(n.index,800,310+primary*210);primary++;}
       else{if(secondary<2)put(n.index,420+secondary*380,100);else put(n.index,420,540+(secondary-2)*210);secondary++;}
     }
   }else{
     // A spatial reading grid, independent of timestamps and step numbers.
     let col=0,row=0;
     for(const level of model.levels){const x=28+col*360;level.forEach((i,k)=>put(i,x,120+row*240+k*190,244,model.nodes[i].parallel?156:132));col++;if(col===3){col=0;row+=level.length>1?2:1;}}
   }
   return spots;
 }
 function box(i){const b=layout.get(i),o=offsets.get(i)||{x:0,y:0};return b?{...b,x:b.x+o.x,y:b.y+o.y}:null;}
 function bounds(){const b=[...layout.keys()].map(box);if(!b.length)return{x:0,y:0,w:800,h:500};const x=Math.min(...b.map(v=>v.x))-24,y=Math.min(...b.map(v=>v.y))-24;return{x,y,w:Math.max(...b.map(v=>v.x+v.w))-x+24,h:Math.max(...b.map(v=>v.y+v.h))-y+24};}
 function route(e){
   const a=box(e.from),b=box(e.to);if(!a||!b)return{points:[[0,0],[0,0]],label:[0,0]};
   const ac=[a.x+a.w/2,a.y+a.h/2],bc=[b.x+b.w/2,b.y+b.h/2];
   if(e.kind==='fork'&&model.groups.length===1){const x=a.x-20,from=[a.x,ac[1]],to=[b.x,bc[1]],k=model.groups[0].arms.indexOf(e.to);return{points:[from,[x,from[1]],[x,to[1]],to],label:k?[b.x+14,b.y-16]:[a.x+a.w+10,a.y+28]};}
   if(e.kind==='take'&&model.groups.length===1){const k=model.groups[0].arms.indexOf(e.from),x=a.x+a.w+48+k*36,from=[a.x+a.w,ac[1]],to=[b.x,b.y+42+k*38];return{points:[from,[x,from[1]],[x,to[1]],to],label:[a.x+a.w+10,from[1]-12]};}
   if(e.kind==='pipeline'){
     if(Math.abs(ac[0]-bc[0])<30){const from=[ac[0],a.y+a.h],to=[bc[0],b.y];return{points:[from,[ac[0],(from[1]+to[1])/2],[bc[0],(from[1]+to[1])/2],to],label:[ac[0]+12,(from[1]+to[1])/2-12]};}
     const from=[a.x+a.w,ac[1]],to=[b.x,bc[1]],x=(from[0]+to[0])/2;return{points:[from,[x,from[1]],[x,to[1]],to],label:[from[0]+14,from[1]-12]};
   }
   if(a.x===b.x){const peers=model.edges.filter(v=>v.kind===e.kind&&box(v.from)?.x===a.x&&box(v.to)?.x===b.x),from=[a.x+a.w,ac[1]],to=[b.x+b.w,bc[1]],lane=a.x+a.w+22+Math.max(0,peers.indexOf(e))*24;return{points:[from,[lane,from[1]],[lane,to[1]],to],label:[b.x+8,b.y-14]};}
   const side=bc[0]>ac[0]?1:-1,from=[ac[0]+side*a.w/2,ac[1]],to=[bc[0]-side*b.w/2,bc[1]],x=(from[0]+to[0])/2;
   return{points:[from,[x,from[1]],[x,to[1]],to],label:[Math.min(from[0],to[0])+12,to[1]-12]};
 }
 function redrawLines(){
   for(const[e,group]of edgeEls){const r=route(e),d=pathOf(r.points,10);group.querySelector('.rg-hit').setAttribute('d',d);group.querySelector('.rg-line').setAttribute('d',d);group.querySelector('.rg-head').setAttribute('d',headPath(r.points.at(-1),r.points.at(-2)));const label=group.querySelector('.rg-edge-label');label.setAttribute('x',r.label[0]);label.setAttribute('y',r.label[1]);}
 }
 function previewFor(item){
   if(!overlay.hidden||!item)return;const edge=item.dataset.edge,idx=Number(item.dataset.node),r=item.getBoundingClientRect(),vr=viewport.getBoundingClientRect();
   preview.textContent=edge?model.edges.find(e=>e.from+':'+e.to===edge)?.label:model.nodes[idx]?.status;preview.hidden=false;
   preview.style.left=Math.max(10,Math.min(viewport.clientWidth-250,r.left-vr.left))+'px';preview.style.top=Math.max(70,Math.min(viewport.clientHeight-90,r.top-vr.top-38))+'px';
 }
 function draw(){
   const b=bounds();frame=svg('svg',{width:Math.max(1200,b.x+b.w),height:Math.max(700,b.y+b.h),class:'rg-svg rm-diagram',role:'group','aria-label':'本轮记录关系地图'});world.append(frame);
   const lines=svg('g',{class:'rg-lines'}),nodes=svg('g',{class:'rg-nodes'});frame.append(lines,nodes);nodeEls.clear();edgeEls.clear();
   for(const e of model.edges){const g=svg('g',{class:'rg-edge is-'+e.kind,tabindex:0,role:'button','aria-label':e.fromText+'到'+e.toText+'：'+e.label});g.dataset.edge=e.from+':'+e.to;
     g.append(svg('path',{class:'rg-hit'}),svg('path',{class:'rg-line'}),svg('path',{class:'rg-head'}),svg('text',{class:'rg-edge-label'},e.label));edgeEls.set(e,g);lines.append(g);wire(g,()=>selectEdge(e,g));}
   for(const n of model.nodes){const b=layout.get(n.index),g=svg('g',{class:'rg-node'+(n.failed?' is-bad':'')+(n.outsider?' is-out':''),tabindex:0,role:'button','aria-label':n.label+'，'+n.status+'，点选读取证据'});g.dataset.node=n.index;
     g.append(svg('rect',{class:'rg-box',x:b.x,y:b.y,width:b.w,height:b.h,rx:9}),svg('text',{class:'rg-name',x:b.x+14,y:b.y+26},fitText(n.label,b.w-28,16)),svg('text',{class:'rg-stat',x:b.x+14,y:b.y+50},n.status));
     const summary=svg('text',{class:'rg-stat is-say',x:b.x+14,y:b.y+74});let rest=globalThis.EchoRoundNodeIO.build(turnRef.rows[n.index])?.summary||n.summary;
     for(let k=0;k<(n.parallel?2:1)&&rest;k++){let text=fitText(rest,b.w-28,14);const raw=text.replace(/…$/u,'');summary.append(svg('tspan',{x:b.x+14,dy:k?19:0},k===0&&n.parallel?raw:text));rest=rest.slice(raw.length);}
     g.append(summary,svg('text',{class:'rf-node-time',x:b.x+14,y:b.y+b.h-14},n.parallel?'报告 '+n.msText:n.startText));nodes.append(g);nodeEls.set(n.index,g);wire(g,()=>selectNode(n.index,g));
   }
   if(layout.has(-1)){const b=box(-1),g=svg('g',{class:'rf-origin'});g.append(svg('rect',{x:b.x,y:b.y,width:b.w,height:b.h,rx:6}),svg('text',{x:b.x+12,y:b.y+27,class:'rg-stat'},'起点未记录 · 非审计事件'));nodes.append(g);}
   redrawLines();
 }
 function wire(item,choose){
   item.addEventListener('click',choose);item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();choose();}});
   item.addEventListener('mouseenter',()=>previewFor(item));item.addEventListener('mouseleave',()=>{preview.hidden=true;});
   item.addEventListener('focus',()=>{if(!skipFocusCamera&&item.dataset.node!==undefined){const r=item.getBoundingClientRect(),v=viewport.getBoundingClientRect();if(r.right<v.left||r.left>v.right||r.bottom<v.top||r.top>v.bottom)camera.focus(box(Number(item.dataset.node)));}previewFor(item);});item.addEventListener('blur',()=>{preview.hidden=true;});
 }
 function highlight(){
   for(const[i,n]of nodeEls)n.classList.toggle('is-active',selected===i||selectedEdge?.from===i||selectedEdge?.to===i);
   for(const[e,g]of edgeEls)g.classList.toggle('is-active',selectedEdge===e||selected>=0&&(e.from===selected||e.to===selected));
 }
 function facts(rows){const d=el('dl','rm-facts');for(const[k,v]of rows){const r=el('div');r.append(el('dt','',k),el('dd','',v));d.append(r);}return d;}
 function open(title,source){
   stopDemo(false);cancelMotion();preview.hidden=true;returnFocus=source;overlay.hidden=false;overlay.querySelector('h2').textContent=title;globalThis.EchoBackgroundView.invalidate(overlayBody);overlayBody.replaceChildren();
   readingPositions={};hiddenNote=null;motion(overlay,[{transform:'translateY(14px)',opacity:.5},{transform:'translateY(0)',opacity:1}],{duration:200,easing:'cubic-bezier(.16,1,.3,1)'});
   overlay.focus({preventScroll:true});
 }
 function close(restore=true){if(!overlay||overlay.hidden)return;cancelMotion();overlay.hidden=true;globalThis.EchoBackgroundView.invalidate(overlayBody);overlayBody.replaceChildren();selected=-1;selectedEdge=null;highlight();if(restore&&returnFocus?.isConnected){skipFocusCamera=true;returnFocus.focus({preventScroll:true});skipFocusCamera=false;}returnFocus=null;}
 function selectNode(i,source=nodeEls.get(i),navigate=false){
   selected=i;selectedEdge=null;const n=model.nodes[i];open(n.label,source);highlight();
   const row=turnRef.rows[i],reader=globalThis.EchoRoundNodeIO,reading=reader.build(row),compact=reader.project(row);if(reading)overlayBody.append(reader.render(screen,reading,compact));
   for(const c of n.contents.filter(c=>!reading||c.label!=='检索查询')){const s=el('section','rf-content');s.append(el('h3','',c.label),el('p','',c.text));overlayBody.append(s);}
   if(!reading&&!n.contents.length){let found=false;for(const[field,label]of[['userInput','输入'],['llmReply','返回']])if(reader.useful(row[field])){const s=el('section','rf-content');s.append(el('h3','',label),reader.valueNode(screen,reader.object(row[field])||row[field]));overlayBody.append(s);found=true;}if(!found)overlayBody.append(el('p','rf-detail-note','这条记录未保存输入或结果。'));}
   const values=[['状态',n.status,!reading&&(n.failed||n.queueSuccess||n.queueFailure)],['在干什么',n.summary,!reading&&!n.contents.length],['记录时刻',n.startText,false],['已记录区间',n.intervalRecorded?clock(n.at)+' → '+clock(n.end):'未记录；时间轴显示时刻点',false],['该记录报告时长',n.msText,n.ms!==null],['信号',n.failed?n.failText:'未记录明确失败信号',!reading&&n.failed],...(n.drops?[['未采纳原因',n.drops,true]]:[]),...(n.rawText?[['原始名',n.rawText,false]]:[])],details=el('dl','rm-facts');for(const[label,value,keep]of values){const part=el('div');part.dataset.readKey='fact.'+label;part.append(el('dt','',label),el('dd','',value));details.append(auxiliary(part,!keep));}overlayBody.append(details);
   overlayBody.append(auxiliary(globalThis.EchoOwnershipView.label(screen,row,true)));
   const expert=el('details','rf-expert');expert.append(el('summary','',simple?'补充字段':'专家字段 · 21项'));expert.addEventListener('toggle',()=>{if(expert.open&&!expert.querySelector('.au-l3')){expert.append(reader.expert(screen,api().l3For(row,i,'round-map',screen),row,reader.expertProjection(row,n)));applySimple();}});overlayBody.append(expert);
   const background=globalThis.EchoBackgroundEvents.ofTurn(turnRef,model.nodes.map(n=>({rowIndex:n.index,outsider:n.outsider})));const event=background.events.find(e=>e.rowIndex===i);if(event){const bg=el('details','rf-background');bg.append(el('summary','','触发 / 处理 / 产出'),globalThis.EchoBackgroundView.render({...background,events:[event]},screen,turnRef.rows));overlayBody.append(bg);}
   if(n.generated.length||n.queueSuccess||n.queueFailure)overlayBody.append(auxiliary(el('p','rf-detail-note',n.queueFailure?'此记录明确未进入发送队列。':'生成内容与队列记录分别保留；送达未确认。')));
   hiddenNote=el('p','rm-simple-note');overlayBody.append(hiddenNote);applySimple();
   if(navigate)camera.focus(box(i),viewport.clientWidth>=768?390:0);
 }
 function selectEdge(e,source){selected=-1;selectedEdge=e;open('连线 · '+e.label,source);highlight();overlayBody.append(facts([['关系依据',e.note],['从 → 到',e.fromText+' → '+e.toText],['记录时刻差',e.gapText],['时刻',e.seamText],['关系性质',e.kind==='take'?'尝试取用，不确认实际采用':e.confirmed?'源码确认的关系':'仅记录先后或关联']]));}
 function records(source){selected=-1;selectedEdge=null;open('本轮记录 · '+model.nodes.length+'条',source);highlight();
   for(const n of model.nodes){const b=button(n.label,()=>selectNode(n.index,b,true),'rm-record');b.dataset.record=n.index;b.append(el('span','',n.status+' · '+n.startText));overlayBody.append(b);}
 }
 function information(source){selected=-1;selectedEdge=null;open('本轮信息',source);highlight();overlayBody.append(facts([['当前记录',model.head],['记录跨度',model.totalText],['送达状态','送达未确认'],['线型','实线：源码确认关系；虚线：尝试取用；点线：记录先后或关联。'],['阅读边界','并起不代表共同落定屏障；缺少记录不代表没有执行。'],['本地调整','拖动节点只调整观看位置，不改变执行顺序或审计记录。']]));
   if(model.ambiguities.length)overlayBody.append(el('p','rf-detail-note','有 '+model.ambiguities.length+' 条准备支缺少唯一配对依据，未拼成并行组。'));
   overlayBody.append(screen.audit.controls(),globalThis.EchoOwnershipView.label(screen,turnRef),globalThis.EchoOwnershipView.note(screen,screen.ownership));
 }
 function timeline(source){selectedEdge=null;open('记录时间轴',source);highlight();overlayBody.append(el('p','rf-detail-note','记录时刻与已记录区间分别保留；空白不推断为等待。'));
   const drawBand=(band,start,end,nodes)=>{const w=310,left=0,usable=310,wrap=el('div','rm-time-list'),s=svg('svg',{width:w,height:nodes.length*56+30,class:'rg-svg rg-map',role:'group','aria-label':band==='A'?'总记录时间轴':'已记录区间放大'});
     nodes.forEach((n,i)=>{const y=i*56,x=Math.min(usable-3,Math.max(0,(n.at-start)/Math.max(1,end-start)*usable)),width=Math.min(usable-x,Math.max(3,(n.end-n.at)/Math.max(1,end-start)*usable));s.append(svg('text',{x:0,y:y+15,class:'rg-note'},n.label),svg('rect',{x:left,y:y+26,width:usable,height:14,rx:4,class:'rg-track','data-band':band}));const g=svg('g',{class:'rg-seg'+(selected===n.index?' is-active':''),tabindex:0,role:'button','aria-label':n.label+'，记录时刻'+n.startText});g.dataset.node=n.index;g.dataset.band=band;g.append(svg('rect',{x:left+x,y:y+26,width,height:14,rx:4,class:'rg-seg-box'}));g.addEventListener('click',()=>selectNode(n.index,nodeEls.get(n.index),true));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectNode(n.index,nodeEls.get(n.index),true);}});s.append(g);});wrap.append(s);overlayBody.append(wrap);};
   if(model.axis)drawBand('A',model.axis.start,model.axis.end,model.nodes.filter(n=>n.recordAt!==null||n.intervalRecorded));
   for(const n of model.nodes.filter(n=>n.recordAt===null&&!n.intervalRecorded)){const b=button(n.label+' · 记录时刻 '+DASH,()=>selectNode(n.index,nodeEls.get(n.index),true),'rm-record');overlayBody.append(b);}
   if(model.window&&model.zoom>2){const d=el('details','rf-time-zoom');d.append(el('summary','','放大已记录区间'));const holder=overlayBody;d.addEventListener('toggle',()=>{if(d.open&&!d.querySelector('svg')){drawBand('B',model.window.start,model.window.end,model.nodes.filter(n=>n.intervalRecorded));d.append(holder.lastChild);}});overlayBody.append(d);}
 }
 function paintDemo(){
   const layer=model?.levels[demoIndex]||[];for(const[i,n]of nodeEls)n.classList.toggle('is-demo',layer.includes(i));
   for(const[e,n]of edgeEls)n.classList.toggle('is-demo',layer.includes(e.to));
   if(playButton)playButton.textContent=reduced()?'查看下一层':demoPlaying?'暂停演示':'演示关系';
   if(status)status.textContent=demoIndex<0?model.nodes.length+' 条记录 · 拖动探索 · 送达未确认':(demoPlaying?'关系演示':'已暂停')+' · '+layer.map(i=>model.nodes[i].label).join(' / ')+' · 非执行录像';
 }
 function stopDemo(reset){if(demoTimer)clearTimeout(demoTimer);demoTimer=0;demoPlaying=false;cancelMotion();if(reset)demoIndex=-1;paintDemo();}
 function advance(){
   if(!model?.levels.length)return;demoIndex=(demoIndex+1)%model.levels.length;paintDemo();const layer=model.levels[demoIndex];
   if(!reduced()){
     for(const[e,g]of edgeEls){if(!layer.includes(e.to))continue;const line=g.querySelector('.rg-line'),pulse=svg('path',{class:'rm-pulse',d:line.getAttribute('d')});if(e.kind==='take')pulse.setAttribute('stroke-dasharray','7 5');g.append(pulse);const len=line.getTotalLength();const a=motion(pulse,[{strokeDasharray:len+' '+len,strokeDashoffset:len},{strokeDasharray:len+' '+len,strokeDashoffset:0}],{duration:650,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'});a?.finished.catch(()=>{}).finally(()=>pulse.remove());}
     for(const i of layer){const n=nodeEls.get(i);motion(n,[{opacity:.65},{opacity:1}],{duration:300});}
   }
   if(demoPlaying&&demoIndex<model.levels.length-1)demoTimer=setTimeout(advance,1000);else{demoPlaying=false;demoTimer=0;paintDemo();}
 }
 function toggleDemo(){if(demoPlaying){stopDemo(false);return;}close(false);if(reduced()){advance();return;}if(demoIndex>=model.levels.length-1)demoIndex=-1;demoPlaying=true;advance();}
 function initial(){const b=bounds();camera.fit(b,true);if(viewport.clientWidth<600){const n=model.nodes.find(n=>n.tool==='retrieve')||model.nodes[0];if(n){const r=box(n.index);camera.set({x:viewport.clientWidth/2-(r.x+r.w/2),y:viewport.clientHeight*.4-(r.y+r.h/2),k:1});}}}
 function reset(){stopDemo(true);close();offsets.clear();for(const n of nodeEls.values())n.removeAttribute('transform');redrawLines();initial();}
 function render(turn,key,restore){
   turnRef=turn;model=api().graphOf(turn,screen);host.replaceChildren();host.dataset.roundKey=key;selected=-1;selectedEdge=null;adjusting=false;layout=project();const ids=identities(turn),saved=new Map(restore?.offsets||[]);offsets=new Map(ids.flatMap((id,i)=>saved.has(id)?[[i,saved.get(id)]]:[]));
   const lead=document.getElementById('view-lead');if(lead)lead.textContent=model.head+' · 记录跨度 '+model.totalText;
   simpleButton=button('精简信息',toggleSimple,'rm-simple-toggle');simpleButton.setAttribute('aria-pressed',String(simple));simpleButton.setAttribute('aria-label','精简信息');document.querySelector('.view-tools')?.insertBefore(simpleButton,document.getElementById('view-refresh'));
   viewport=el('section','rm-map');viewport.tabIndex=0;viewport.setAttribute('aria-label','本轮流程地图；方向键平移，加减键缩放，0适应，Home恢复');host.append(viewport);
   world=el('div','rm-world');viewport.append(world);draw();
   const hud=el('div','rm-hud'),nav=el('div'),results=el('div','rm-results');const back=el('a','rm-button','回审计');back.href=screen.audit.href('audit');nav.append(back);
   const info=button('本轮信息',()=>information(info)),list=button('记录 '+model.nodes.length,()=>records(list)),time=button('时间带',()=>timeline(time));nav.append(info,list,time);hud.append(nav,results);viewport.append(hud);
   for(const[label,count,match]of[['生成',model.generatedCount,n=>n.generated.length],['队列',model.queueCount,n=>n.queueSuccess||n.queueFailure],['消息',model.messageCount,n=>n.messages.length]])if(count){const b=button(label+' '+count,()=>selectNode(model.nodes.find(match).index,b,true));results.append(b);}
   const dock=el('div','rm-dock');playButton=button('演示关系',toggleDemo,'rm-primary');const replay=button('重播',()=>{stopDemo(true);toggleDemo();}),adjust=button('调整节点',()=>{adjusting=!adjusting;adjust.setAttribute('aria-pressed',String(adjusting));viewport.classList.toggle('is-adjusting',adjusting);stopDemo(false);});adjust.setAttribute('aria-pressed','false');dock.append(playButton,replay,adjust);viewport.append(dock);
   const zoom=el('div','rm-zoom'),scale=el('output','rm-scale','100%');scale.setAttribute('aria-label','地图比例');zoom.append(button('−',()=>{stopDemo(false);camera.zoom(1/1.2);}),scale,button('+',()=>{stopDemo(false);camera.zoom(1.2);}),button('适应',()=>{stopDemo(false);camera.fit(bounds());}),button('恢复',reset));viewport.append(zoom);
   status=el('p','rm-status');status.setAttribute('aria-live','polite');viewport.append(status);
   overlay=el('section','rm-overlay');overlay.hidden=true;overlay.tabIndex=-1;overlay.setAttribute('aria-label','地图内证据阅读面');const bar=el('header','rm-overlay-head'),closeButton=button('关闭',()=>close());let closePoint=null;
   closeButton.addEventListener('pointerdown',e=>{closePoint=e.pointerType==='touch'?{x:e.clientX,y:e.clientY}:null;if(closePoint)e.preventDefault();});
   closeButton.addEventListener('pointercancel',()=>{closePoint=null;});
   closeButton.addEventListener('pointerup',e=>{const start=closePoint;closePoint=null;if(!start)return;const r=closeButton.getBoundingClientRect();if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<8&&e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom){e.preventDefault();close();}});
   bar.append(el('h2'),closeButton);overlayBody=el('div','rm-overlay-body');overlay.append(bar,overlayBody);viewport.append(overlay);
   preview=el('div','rm-preview');preview.hidden=true;viewport.append(preview);
   camera=globalThis.EchoRoundMap.attach(viewport,world,{adjusting:()=>adjusting,onCamera:c=>{scale.textContent=Math.round(c.k*100)+'%';},onInterrupt:()=>{stopDemo(false);preview.hidden=true;},onTap:n=>{const key=n.dataset.edge;if(key){const e=model.edges.find(e=>e.from+':'+e.to===key);selectEdge(e,n);}else selectNode(Number(n.dataset.node),n);},onNodeDrag:(i,dx,dy)=>{const o=offsets.get(i)||{x:0,y:0};nodeEls.get(i).setAttribute('transform','translate('+(o.x+dx)+','+(o.y+dy)+')');const previous=offsets.get(i);offsets.set(i,{x:o.x+dx,y:o.y+dy});redrawLines();if(previous)offsets.set(i,previous);else offsets.delete(i);},onNodeCommit:(i,dx,dy)=>{const o=offsets.get(i)||{x:0,y:0};offsets.set(i,{x:o.x+dx,y:o.y+dy});redrawLines();},onFit:()=>camera.fit(bounds()),onReset:reset});
   initial();if(restore?.camera)camera.set(restore.camera);for(const[i,o]of offsets)nodeEls.get(i)?.setAttribute('transform','translate('+o.x+','+o.y+')');redrawLines();paintDemo();
   const restoredIndex=restore?.selected?ids.indexOf(restore.selected):-1;if(restoredIndex>=0)selectNode(restoredIndex,nodeEls.get(restoredIndex));
   resizeObserver=new ResizeObserver(()=>{camera?.cancel();});resizeObserver.observe(viewport);
 }
 async function mount(root,screenApi,key,restore){
   const id=++loadId;host=root;screen=screenApi;lifecycle=new AbortController();host.dataset.roundKey=key||'';host.replaceChildren(el('p','au-none','正在读取这一轮…'));
   document.addEventListener('keydown',e=>{if(e.key==='Escape'){stopDemo(false);if(overlay&&!overlay.hidden){e.preventDefault();close();}}},{signal:lifecycle.signal});
   document.addEventListener('visibilitychange',()=>{if(document.hidden){stopDemo(true);camera?.cancel();preview&&(preview.hidden=true);}},{signal:lifecycle.signal});
   try{const payload=await screen.audit.read();if(id!==loadId||!host)return;screen.ownership=screen.audit.ownership();stopOwnership=screen.audit.subscribe(()=>globalThis.EchoOwnershipView.update(host));const turns=globalThis.EchoAuditView.buildTurns(payload?.rows||[]),turn=turns.find(t=>api().roundKeyOf(t)===String(key||''));
     if(!turn){host.replaceChildren();const map=el('section','rm-map'),empty=el('div','rm-empty');empty.append(el('h2','','这一轮不在当前窗口'),el('p','','缺少记录不能断言没有执行。回审计可查看当前范围内的轮。'),screen.audit.controls());const back=el('a','rm-button','回审计');back.href=screen.audit.href('audit');empty.append(back);map.append(empty);host.append(map);return;}render(turn,String(key),restore);
   }catch(error){if(id!==loadId||error?.name==='AbortError')return;host.replaceChildren(el('p','au-none','暂时读不到这一轮，请刷新重试。'));}
 }
 function unmount(){screen?.audit.cancel();loadId++;lifecycle?.abort();lifecycle=null;stopOwnership();stopOwnership=()=>{};stopDemo(true);camera?.destroy();camera=null;resizeObserver?.disconnect();resizeObserver=null;globalThis.EchoBackgroundView.invalidate(host);simpleButton?.remove();simpleButton=null;hiddenNote=null;readingPositions={};host?.replaceChildren();host=null;model=null;turnRef=null;viewport=null;world=null;overlay=null;overlayBody=null;preview=null;frame=null;offsets.clear();layout.clear();nodeEls.clear();edgeEls.clear();selected=-1;selectedEdge=null;returnFocus=null;status=null;playButton=null;}
 function refresh(){if(!host)return;const root=host,api=screen,key=root.dataset.roundKey,ids=turnRef?identities(turnRef):[],restore={camera:camera?.get(),offsets:[...offsets].map(([i,o])=>[ids[i],o]),selected:ids[selected]};unmount();return mount(root,api,key,restore);}
 return{mount,unmount,refresh};
})();

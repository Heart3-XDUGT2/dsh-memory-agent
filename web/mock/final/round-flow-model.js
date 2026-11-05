/* Local read model. Audit rows remain the events; connectors are navigation, never events. */
(function (root) {
  'use strict';
  const detailOf = row => { try { const d = typeof row.stageDetail === 'string' ? JSON.parse(row.stageDetail) : row.stageDetail; return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const millis = value => { if (finite(value)) return Number(value) > 1e11 ? Number(value) : Number(value) * 1000; const n = Date.parse(value); return Number.isFinite(n) ? n : null; };
  const failureOf = row => { const d = detailOf(row); return d.ok === false || d.timedOut === true || (d.error !== null && d.error !== undefined && String(d.error).trim() !== ''); };
  const durationOf = row => finite(row.latency) && Number(row.latency) >= 0 ? Number(row.latency) : finite(detailOf(row).ms) && Number(detailOf(row).ms) >= 0 ? Number(detailOf(row).ms) : null;
  const names = { relay_in:'收到输入', care:'主动关怀触发', same_turn_emotion:'理解同轮情绪', query_expand:'准备检索线索', retrieve:'查找相关记忆', inject:'组装注入上下文', extract:'保留生成与记忆', relay_out:'发送队列记录', relay_proactive:'主动发送队列', 'ipc-appraise':'更新后续感受' };
  const armTool = tool => tool === 'same_turn_emotion' || tool === 'query_expand';
  const outbound = tool => tool === 'relay_out' || tool === 'relay_proactive';
  function build(turn, originals, options) {
    const clean = options.clean, fmt = options.duration, clock = options.clock, missing = options.missing;
    const rows = turn.rows;
    const nodes = rows.map((row,index) => {
      const d=detailOf(row), tool=String(row.toolCall || row.stage || ''), stamp=millis(row.timestamp);
      const interval=finite(d.beginAt) && finite(d.settleAt) && Number(d.settleAt)>=Number(d.beginAt) && Number(d.beginAt)>0;
      const begin=interval ? Number(d.beginAt) : null, end=interval ? Number(d.settleAt) : null;
      const ms=durationOf(row), failed=failureOf(row);
      const contents=[];
      const put=(label,value)=>{if(value!==null&&value!==undefined&&String(value).trim()!==''){const text=clean(String(value));if(text.trim())contents.push({label,text});}};
      if(tool==='relay_in')put('收到的消息',row.userInput);
      else if(tool==='extract')put('记录中的输入',row.userInput);
      else if(tool==='retrieve')put('检索查询',row.userInput);
      if(tool==='extract'||tool==='care')put('记录中的生成内容',row.llmReply);
      const messageLabels={echo_qq_say:'工具消息（记录片段）',echo_qq_call:'呼叫工具消息（记录片段）',echo_wake:'提醒记录正文',care:'关怀记录正文'};
      if(messageLabels[tool]&&!contents.some(c=>c.label==='记录中的生成内容')){
        const raw=String(row.userInput||''),marked=tool==='echo_qq_say'?/^\(用 QQ 说\)/u.test(raw):tool==='echo_qq_call'?/^\(用 QQ 喊他\)/u.test(raw):tool==='echo_wake'?/^\(她自己排了个闹钟\)/u.test(raw):false;
        const known=String(originals[index]?.sayText||'')||(marked?raw.replace(/^\([^)]*\)/u,''):'');
        put(messageLabels[tool],known);
      }
      if(outbound(tool))put('队列记录正文片段',String(row.llmReply || row.userInput || '').replace(/^\[[^\]]+\]\s+/u,''));
      put('注入上下文',row.injectedMemories);
      const queueFailure=outbound(tool)&&(failed||/^\(\*\*没发出去\*\*:/u.test(String(row.userInput||'')));
      const queueSuccess=outbound(tool)&&!queueFailure&&/^\[[^\]]+\]\s+\S/u.test(String(row.llmReply||row.userInput||''));
      const generated=contents.filter(c=>c.label==='记录中的生成内容');
      const messages=contents.filter(c=>c.label===messageLabels[tool]);
      const spoken=contents.find(c=>['收到的消息','记录中的生成内容','队列记录正文片段',messageLabels[tool]].includes(c.label));
      const count=finite(d.candidates)?Number(d.candidates):null;
      const drops=d.dropReasons;
      const status=queueFailure?'未进入发送队列':failed?'该步骤未完成':queueSuccess?'已进入发送队列':d.ok===true?'明确成功':generated.length?'生成内容已记录':messages.length?'消息正文已记录':'已有记录';
      let summary=spoken?.text || (count!==null?`${count} 条候选记忆`:originals[index]?.what || '展开查看原记录');
      if(tool==='inject'&&String(row.injectedMemories||''))summary=clean(String(row.injectedMemories));
      if(armTool(tool)) {
        const reasons={empty_query:'查询为空，提前结束',cache_hit:'命中已有检索线索',no_result:'没有有效结果'};
        summary=clean(String(d.reason ? reasons[d.reason]||d.reason : d.error || (tool==='query_expand'?'结果供组装尝试取用':'无有效结果时沿用旧值')));
      }
      return {...originals[index],index,tool,label:names[tool]||originals[index]?.label||tool,name:names[tool]||originals[index]?.name||tool,
        recordAt:stamp,at:begin??stamp??0,end:end??stamp??0,intervalRecorded:interval,endRecorded:interval,
        startText:stamp===null?missing:clock(stamp),endText:interval?clock(end):missing,ms,msText:ms===null?missing:ms===0?'0 毫秒':fmt(ms),
        parallel:armTool(tool),failed,failText:failed?clean(String(d.error||d.reason||(d.timedOut?'超时；未记录原因':'未记录失败原因'))):'',
        flags:[...(armTool(tool)?['独立准备支']:[]),...(failed?['步骤未完成']:[])],status,summary,contents,count,generated,messages,
        sayText:spoken?.text||'',saySide:tool==='relay_in'?'him':'her',queueFailure,queueSuccess,
        drops: drops===undefined||drops===null?null:clean(typeof drops==='object'?Object.entries(drops).map(([k,v])=>`${Array.isArray(drops)?'':k+'：'}${typeof v==='string'?v:JSON.stringify(v)}`).join('；'):String(drops)),
        detail:d, outsider:!['relay_in','care','same_turn_emotion','query_expand','retrieve','inject','extract','relay_out','relay_proactive'].includes(tool)&&originals[index]?.outsider===true};
    });
    // A pair needs a shared explicit round AND session, unique branch kinds and recorded starts.
    // Audit order, equal timestamp, step numbers and body text alone cannot pair branches.
    const candidates=new Map(),groups=[],ambiguities=[];
    for(const n of nodes.filter(n=>n.parallel)) {
      const trace=String(n.detail.turnTrace||''),sid=String(rows[n.index].sessionId||'');
      if(!trace||!sid||!finite(n.detail.beginAt)){ambiguities.push(n.index);continue;}
      const key=sid+'\u0000'+trace;
      if(!candidates.has(key))candidates.set(key,[]);
      candidates.get(key).push(n);
    }
    for(const list of candidates.values()) {
      const a=list.filter(n=>n.tool==='same_turn_emotion'),b=list.filter(n=>n.tool==='query_expand');
      if(a.length!==1||b.length!==1){ambiguities.push(...list.map(n=>n.index));continue;}
      const arms=[a[0].index,b[0].index].sort((x,y)=>x-y);
      const earliest=Math.min(...list.map(n=>Number(n.detail.beginAt)));
      const starts=nodes.filter(n=>n.tool==='relay_in'&&n.recordAt!==null&&n.recordAt<=earliest&&String(rows[n.index].sessionId||'')===String(rows[list[0].index].sessionId||'')&&n.detail.turnTrace===list[0].detail.turnTrace);
      const from=starts.length===1?starts[0].index:-1;
      const retrieval=nodes.filter(n=>n.tool==='retrieve'&&n.detail.turnTrace===list[0].detail.turnTrace&&String(rows[n.index].sessionId||'')===String(rows[list[0].index].sessionId||''));
      groups.push({arms,from,to:retrieval.length===1?retrieval[0].index:-1,evidence:'同一显式轮标和会话；两种准备支各一条；起点均有记录',earliest});
    }
    const edges=[];
    const edge=(from,to,kind,label,note)=>{
      if(from===to||edges.some(e=>e.from===from&&e.to===to))return;
      const a=nodes[from],b=nodes[to];
      edges.push({from,to,kind,label,carryText:note,note,fromText:a?.label||'起点未记录',toText:b.label,
        gapText:a?.recordAt!==null&&a?.recordAt!==undefined&&b.recordAt!==null?(b.recordAt===a.recordAt?'0 毫秒':fmt(Math.abs(b.recordAt-a.recordAt))):missing,
        seamText:`${a?.startText||missing} → ${b.startText}`,confirmed:kind==='pipeline'||kind==='fork',blocking:false});
    };
    for(const g of groups) {
      for(const arm of g.arms) {
        edge(g.from,arm,'fork','独立启动',g.from<0?'连接器表示原始触发起点未记录，不增加审计事件。':'源码确认两支平级启动；不代表两个结果都会被采用。');
        if(g.to>=0){const n=nodes[arm],late=finite(n.detail.settleAt)&&nodes[g.to].recordAt!==null&&Number(n.detail.settleAt)>nodes[g.to].recordAt;
          edge(arm,g.to,'take',(n.tool==='same_turn_emotion'?'情绪':'线索')+(late?' · 晚于检索':' · 尝试取用'),n.tool==='same_turn_emotion'?'组装尝试等待同轮情绪；无有效结果时沿用旧值。审计未证明本次采用，非共同屏障。':'查询扩展只取组装当时已有且查询匹配的扩展；晚于检索、空值可能未采用，不等待该支，非共同屏障。');}
      }
    }
    // Known pipeline order, only for unique explicitly scoped records. Other adjacency is observation.
    const unique=tool=>{const v=nodes.filter(n=>n.tool===tool);return v.length===1?v[0]:null;};
    for(const [fromTool,toTool] of [['retrieve','inject'],['inject','extract']]) {
      const a=unique(fromTool),b=unique(toTool);
      if(a&&b&&a.detail.turnTrace&&a.detail.turnTrace===b.detail.turnTrace&&String(rows[a.index].sessionId||'')===String(rows[b.index].sessionId||'')) {
        const count=a.count;
        edge(a.index,b.index,'pipeline',fromTool==='retrieve'?(count===null?'检索结果':`${count} 条候选`):'注入后续记录',fromTool==='retrieve'?'检索结果供组装使用；候选数量不等于最终注入数量。':'源码管线在注入后保留轮末生成与记忆；不是实际生成开始/结束时刻，也不证明发送。');
      }
    }
    for(let i=1;i<nodes.length;i++){
      const a=nodes[i-1],b=nodes[i];
      if(groups.some(g=>g.arms.includes(a.index)||g.arms.includes(b.index)))continue;
      edge(a.index,b.index,a.outsider||b.outsider?'out':'record',a.outsider||b.outsider?'关联后台':'记录先后','仅表示审计记录先后或关联，不确认内容传递、执行依赖、等待或发送送达。');
    }
    // Preserve isolated records without manufacturing execution dependencies.
    for(const n of nodes)if(!edges.some(e=>e.to===n.index||e.from===n.index)&&nodes.length>1){const prev=nodes[n.index-1]||nodes[n.index+1];if(prev)edge(prev.index,n.index,n.outsider?'out':'record',n.outsider?'关联后台':'关联记录','仅为同轮阅读关联，不是执行或取用关系。');}
    const timestamps=nodes.map(n=>n.recordAt).filter(v=>v!==null),span=timestamps.length?{start:Math.min(...timestamps),end:Math.max(...timestamps)}:null;
    if(span)span.total=span.end-span.start;
    const intervals=nodes.filter(n=>n.intervalRecorded),axisPoints=[...timestamps,...intervals.flatMap(n=>[n.at,n.end])];
    const axis=axisPoints.length?{start:Math.min(...axisPoints),end:Math.max(...axisPoints)}:null;if(axis)axis.total=axis.end-axis.start;
    const recordedWindow=intervals.length?{start:Math.min(...intervals.map(n=>n.at)),end:Math.max(...intervals.map(n=>n.end))}:null;
    if(recordedWindow)recordedWindow.total=recordedWindow.end-recordedWindow.start;
    const levels=[],seen=new Set();
    for(const n of nodes){if(seen.has(n.index))continue;const g=groups.find(g=>g.arms.includes(n.index));const members=g?g.arms:[n.index];members.forEach(i=>seen.add(i));levels.push(members);}
    const labels=nodes.some(n=>n.tool==='care')?'主动关怀':nodes.some(n=>n.tool==='relay_in')?'收到消息':nodes.some(n=>n.tool==='extract'&&n.contents.some(c=>c.label==='记录中的输入'))?'对话记录':'活动记录';
    return {nodes,edges,groups,ambiguities,levels,span,axis,window:recordedWindow,waitMs:null,waitText:missing,zoom:axis&&recordedWindow?.total>0?axis.total/recordedWindow.total:1,
      totalText:span?(span.total===0?'0 毫秒':fmt(span.total)):missing,head:`${nodes.length} 条记录 · ${labels}`,meta:`记录跨度 ${span?(span.total===0?'0 毫秒':fmt(span.total)):missing} · 送达未确认`,
      failed:nodes.filter(n=>n.failed).map(n=>n.index),slowest:[],queueCount:nodes.filter(n=>n.queueSuccess||n.queueFailure).length,queueSuccessCount:nodes.filter(n=>n.queueSuccess).length,queueFailureCount:nodes.filter(n=>n.queueFailure).length,messageCount:nodes.reduce((a,n)=>a+n.messages.length,0),generatedCount:nodes.reduce((a,n)=>a+n.generated.length,0)};
  }
  root.EchoRoundFlowModel={build,detailOf,durationOf,failureOf,millis};
})(globalThis);

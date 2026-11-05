import fs from'node:fs';import path from'node:path';import os from'node:os';import vm from'node:vm';
if(!process.env.DSH_HOME||!path.resolve(process.env.DSH_HOME).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Run with --import ./tests/_isolate.mjs before importing production dependencies');
export const toggle=await import('../lib/toggle.js');
if(!path.resolve(toggle.CONFIG_PATH).startsWith(path.resolve(process.env.DSH_HOME)+path.sep))throw Error('Configuration escaped isolated home');
const {createRelay}=await import('../lib/relay.js'),{relayToolDefinitions}=await import('../lib/relay-tools.js');
export const qqConfig=await import('../../dsh-qq-bridge/lib/config.js');
export const qqAPI=await import('../../dsh-qq-bridge/lib/settings-api.js');
export const qqDir=path.join(process.env.DSH_HOME,'echo-qq');fs.mkdirSync(qqDir,{recursive:true});
export const source=(old=false)=>({main:fs.readFileSync(old?'.scratch/echo017-before/lib/index.js':'lib/index.js','utf8'),qq:fs.readFileSync(old?'.scratch/echo017-qq-before/lib/index.js':'../dsh-qq-bridge/lib/index.js','utf8')});
const slice=(s,start,end)=>{const a=s.indexOf(start);if(a<0)throw Error('missing start '+start);const b=s.indexOf(end,a);if(b<0)throw Error('missing end '+end);return s.slice(a,b);};
export function relayAssembly(s,{clock=1000}={}){
 const getter=slice(s,'  const relayCfg =','  /**'),call=slice(s,'  relay = createRelay({','\n  })')+'\n  })',rows=[],channels=[{platform:'qq',chatId:'10001',sessionId:'synthetic-session',enabled:1,proactive:1,isPrimary:1,chatType:'private',lastInAt:1,label:'合成私聊'}];
 const store={relayChannelsOfSession:()=>channels,relayListChannels:()=>channels,relayEnqueue:r=>{rows.push(structuredClone(r));return{ok:true};},relayQueueStats:()=>({}),relaySetChannel:()=>({ok:true})};
 const args={readSettings:toggle.readSettings,createRelay:opts=>createRelay({...opts,now:()=>clock}),requireStore:()=>store,store,ctx:{logger:{info(){},warn(){}}},mouthOpen:()=>true,resolveCompanion:async()=>({sessionId:'synthetic-session'}),injectInbound:async()=>({ok:true}),applyRelayPermission:()=>{},setSessionLabel:()=>{},randomUUID:()=> 'synthetic-audit',MASTER_ID:'synthetic-owner',speaker:null};
 const assembly=new Function(...Object.keys(args),getter+';let relay;'+call+';return{relay,config:relayCfg};')(...Object.values(args));
 const tool=relayToolDefinitions({relay:assembly.relay,isEnabled:()=>true,sessionEnabledOf:()=>true}).find(t=>t.name==='echo_qq_say');
 return{...assembly,rows,async run(entry,text,{kind='reply'}={}){rows.length=0;const random=Math.random;Math.random=()=>.5;try{if(entry==='turn'){assembly.relay.captureSegment('synthetic-session',text);assembly.relay.finishTurn('synthetic-session',{kind});}else if(kind==='reply')await tool.execute({text},{agent:{session:{id:'synthetic-session'}}});else assembly.relay.say({sessionId:'synthetic-session',text,mode:'call'});return rows.map(r=>({text:r.text,notBefore:r.notBefore,seq:r.seq,kind:r.kind,chatId:r.chatId,platform:r.platform}));}finally{Math.random=random;}}};
}
export async function qqAssembly(s,{responses=[{ok:false,reason:'agent-busy'}],onWait=null,injectError=null}={}){
 const reload=slice(s,'  async function reload ()','\n  // 配置的**活视图**'),view=slice(s,'  const settingsView = {','\n  }')+'\n  }',ctor=slice(s,'    channel = createChannel({','\n    })')+'\n    })';
 const runtime=new Function('readSettings','dir','DEFAULT_SETTINGS','let settings=null,problems=[];'+reload+'\n'+view+';return{reload,settingsView};')(qqConfig.readSettings,qqDir,qqConfig.DEFAULT_SETTINGS);
 await runtime.reload();const waits=[],envelopes=[];let hook=onWait;
 const contract=fs.readFileSync('../dsh-qq-bridge/lib/contract.js','utf8').replace(/export /g,''),context={setTimeout:(fn,ms)=>{waits.push(ms);Promise.resolve().then(async()=>{if(hook)await hook(ms,waits.length);fn();});return 1;},clearTimeout(){},Date,console};
 vm.runInNewContext(contract+'\nglobalThis.channelFactory=createChannel;',context);
 const service={inject:async envelope=>{envelopes.push(structuredClone(envelope));if(injectError)throw injectError;return responses[Math.min(envelopes.length-1,responses.length-1)];}};
 const channel=new Function('createChannel','settingsView','ctx','log','onebot','let channel;'+ctor+';return channel;')(context.channelFactory,runtime.settingsView,{get:()=>service},()=>{},{status:()=>({clients:1})});
 return{...runtime,channel,waits,envelopes,setHook:v=>hook=v};
}
export async function gapBehavior(s,gap){
 const fn=slice(s,'  async function deliver (rows)','\n  /**'),waits=[],sent=[];const settings={...qqConfig.DEFAULT_SETTINGS,replyMaxChars:4,segmentGapMs:gap};
 const {splitForSend}=await import('../../dsh-qq-bridge/lib/split.js'),{stripEmoMarkers}=await import('../../dsh-qq-bridge/lib/emo-marker.js');
 const onebot={sendPrivateMsg:async(chatId,text)=>{sent.push({chatId,text});return{ok:true};},sendGroupMsg:async()=>{throw Error('unexpected group');}};
 const deliver=new Function('settings','onebot','splitForSend','stripEmoMarkers','stats','log','DELIVER_BUDGET_MS','BUBBLE_WAIT_CAP_MS','setTimeout',fn+';return deliver;')(settings,onebot,splitForSend,stripEmoMarkers,{sent:0,failed:0},()=>{},20000,3000,(fn,ms)=>{waits.push(ms);queueMicrotask(fn);});
 const ids=await deliver([{id:'synthetic-row',chatId:'10001',text:'甲乙丙丁戊己庚辛壬癸',raw:{notBefore:0},chatType:'private'}]);return{gap,waits,sent,ids};
}

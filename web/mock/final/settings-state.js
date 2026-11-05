/* Drafts stay in memory. This module has no storage, network or DOM dependency. */
(function(root){
 'use strict';
 const blocked=new Set(['__proto__','constructor','prototype']);
 const pathOf=p=>Array.isArray(p)?p:String(p).split('.');
 const clone=v=>v===undefined?undefined:structuredClone(v);
 const equal=(a,b)=>Object.is(a,b)||(a!==null&&b!==null&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k])));
 const prefix=(a,b)=>a.length<=b.length&&a.every((k,i)=>String(k)===String(b[i]));
 function get(value,path){for(const key of pathOf(path)){if(blocked.has(String(key)))throw Error('不支持的字段');value=value===null||value===undefined?undefined:value[key];}return value;}
 function set(value,path,next){const parts=pathOf(path);for(const key of parts)if(blocked.has(String(key)))throw Error('不支持的字段');let cursor=value;for(const key of parts.slice(0,-1)){if(!cursor[key]||typeof cursor[key]!=='object')cursor[key]={};cursor=cursor[key];}if(next===undefined)delete cursor[parts.at(-1)];else cursor[parts.at(-1)]=clone(next);return value;}
 class Drafts{
  constructor(){this.sources=new Map();this.busy=false;}
  locked(id){return this.busy||!!this.sources.get(id)?.pendingRead;}
  load(id,value,extra={}){const {value:ignored,...metadata}=extra;const source=this.sources.get(id);if(source?.changes.size||source?.pendingRead){source.remote=clone(value);for(const k of ['revision','fingerprint','exists','broken'])delete metadata[k];Object.assign(source,metadata);return source;}const next={...source,id,base:clone(value??{}),value:clone(value??{}),remote:clone(value??{}),changes:new Map(),errors:[],conflicts:null,pendingRead:false,...metadata};this.sources.set(id,next);return next;}
  edit(id,path,value,meta={}){const source=this.sources.get(id);if(!source)throw Error('此来源尚未读取');if(this.busy)return source;if(source.pendingRead)throw Error('先读回上次保存结果');let parts=pathOf(path);const previous=get(source.value,parts);if(previous&&value&&typeof previous==='object'&&typeof value==='object'&&!Array.isArray(previous)&&!Array.isArray(value)){for(const k of new Set([...Object.keys(previous),...Object.keys(value)]))if(!equal(previous[k],value[k]))this.edit(id,[...parts,k],value[k],meta);return source;}if(meta.secret&&value==='')value=get(source.base,parts);set(source.value,parts,value);const ancestor=[...source.changes.values()].find(c=>prefix(c.path,parts));if(ancestor){parts=ancestor.path;meta={...ancestor,...meta};value=get(source.value,parts);}for(const [k,c]of source.changes)if(prefix(parts,c.path))source.changes.delete(k);const before=get(source.base,parts);if(!equal(before,value))source.changes.set(JSON.stringify(parts),{...meta,path:parts,before:clone(before),after:clone(value)});source.errors=[];return source;}
  changed(){return[...this.sources.values()].filter(s=>s.changes.size);}
  count(){return this.changed().reduce((n,s)=>n+s.changes.size,0);}
  discard(id){if(this.busy)return;const list=id?[this.sources.get(id)]:[...this.sources.values()];for(const s of list)if(s&&!s.pendingRead){s.value=clone(s.remote);s.base=clone(s.remote);s.changes.clear();s.errors=[];}}
  rebase(id,fresh){const s=this.sources.get(id),conflicts=[];for(const change of s.changes.values())if(!change.secret&&!equal(get(fresh,change.path),change.before)&&!equal(get(fresh,change.path),change.after))conflicts.push(change.path);return conflicts;}
  payload(id,fresh,partial=false){const s=this.sources.get(id),out=partial?{}:clone(fresh);for(const c of s.changes.values())set(out,c.path,c.after);return out;}
  accepted(id,actual,extra={}){const s=this.sources.get(id);s.changes.clear();s.pendingRead=false;return this.load(id,actual,extra);}
 }
 root.EchoSettingsState={Drafts,get,set,equal,clone};
})(globalThis);

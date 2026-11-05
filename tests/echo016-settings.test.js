import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';
const context={structuredClone};vm.runInNewContext(fs.readFileSync('web/mock/final/settings-state.js','utf8'),context);const {Drafts}=context.EchoSettingsState;
test('save lock rejects all central edits and discard, but accepts its own readback',()=>{
 const d=new Drafts();d.load('main',{top:3,secret:'',nested:{a:1}});d.load('qq',{list:['001234']});d.edit('main',['top'],4);d.busy=true;
 for(const [id,p,v]of [['main',['top'],8],['main',['secret'],'synthetic'],['main',['nested'],{a:9}],['qq',['list'],['00005678']]])d.edit(id,p,v,{secret:p[0]==='secret'});
 d.discard();assert.equal(d.sources.get('main').value.top,4);assert.equal(d.count(),1);assert.equal(d.sources.get('qq').value.list[0],'001234');
 d.accepted('main',{top:4,secret:'',nested:{a:1}});assert.equal(d.count(),0);assert.equal(d.sources.get('main').value.top,4);
 d.busy=false;d.edit('main',['top'],8);assert.equal(d.count(),1);assert.equal(d.sources.get('main').value.top,8);
});
test('pending read locks one source and retry accepts without blocking unrelated edits',()=>{
 const d=new Drafts();d.load('main',{top:3});d.load('qq',{on:false});d.edit('main',['top'],4);d.sources.get('main').pendingRead=true;
 assert.throws(()=>d.edit('main',['top'],8));d.edit('qq',['on'],true);d.discard('main');assert.equal(d.sources.get('main').value.top,4);assert.equal(d.count(),2);
 d.busy=true;d.accepted('main',{top:4});d.busy=false;assert.equal(d.sources.get('qq').value.on,true);d.edit('main',['top'],8);assert.equal(d.sources.get('main').value.top,8);
});

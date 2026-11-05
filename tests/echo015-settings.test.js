import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {settingsUIManifest} from '../lib/settings-ui.js';
import {parseSettings,saveSettings} from '../../dsh-qq-bridge/lib/config.js';
import {parseWatchList,classifyComment} from '../../dsh-qq-bridge/lib/qzone-events.js';
const context={structuredClone};vm.runInNewContext(fs.readFileSync('web/mock/final/settings-whitelist.js','utf8'),context);
const {model}=context.EchoWhitelist,plain=v=>JSON.parse(JSON.stringify(v));
for(const kind of ['string-array','watch-string']){
 test(kind+' preserves order, leading zeros, duplicates and irregular existing content without edits',()=>{
   const original=kind==='string-array'?['001234','legacy value','001234']: '001234, invalid;001234  00005678';
   const m=model(original,kind);assert.deepEqual(plain(m.value()),original);m.issues();m.review('');assert.deepEqual(plain(m.value()),original);
   m.replace(0,'009999');assert.equal(m.rows[0],'009999');assert.ok(m.rows.includes(kind==='string-array'?'legacy value':'invalid'));m.replace(0,'001234');assert.deepEqual(plain(m.value()),original);
 });
 test(kind+' explicit add/edit/remove and bulk review never sort or silently deduplicate',()=>{
   const m=model(kind==='string-array'?['009999']:'009999',kind),r=plain(m.review('001234，009999\n00005678;001234'));
   assert.deepEqual(r.map(i=>i.text),['001234','009999','00005678','001234']);assert.deepEqual(r.map(i=>i.duplicate),[false,true,false,true]);
   m.append(r);assert.deepEqual(plain(m.rows),['009999','001234','009999','00005678','001234']);m.remove(2);m.replace(1,'001111');
   assert.deepEqual(plain(m.rows),['009999','001111','00005678','001234']);assert.equal(Array.isArray(m.value()),kind==='string-array');
 });
}
test('array parser accepts nonempty strings; space parser accepts only 4-15 digits',()=>{
 assert.equal(model([],'string-array').review('abc')[0].valid,true);assert.equal(model('','watch-string').review('abc')[0].valid,false);
 assert.equal(model('','watch-string').review('123')[0].valid,false);assert.equal(model('','watch-string').review('1234')[0].valid,true);
 assert.equal(model('','watch-string').review('1234567890123456')[0].valid,false);
 const raw='00001234, odd;00001234 99887766';assert.deepEqual([...parseWatchList(model(raw,'watch-string').value())],[...parseWatchList(raw)]);
});
test('allowedUsers first item still supplies master fallback and empty group rejects',()=>{
 const s=parseSettings({allowedUsers:['001234','00005678'],allowedGroups:[]}).settings;
 assert.equal(s.masterId,'001234');assert.deepEqual(s.allowedUsers,['001234','00005678']);assert.deepEqual(s.allowedGroups,[]);
});
test('empty space list retains separate master channel',()=>{
 const who={masterId:'001234',watchList:parseWatchList('')};assert.equal(classifyComment({userId:'001234'},who),'master');assert.equal(classifyComment({userId:'00005678'},who),'ignore');
});
test('power metadata separates existing GET status from POST toggle',()=>{
 const power=settingsUIManifest().controls.find(f=>f.id==='power');assert.equal(power.readPath,'/api/echo/status');assert.equal(power.readKey,'enabled');assert.equal(power.path,'/api/echo/toggle');
});
test('unrelated QQ save preserves existing raw list shapes, order and irregular entries',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'echo015-'));
 assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
 try{
  const lists={allowedUsers:['001234','001234','legacy value'],allowedGroups:['009999','00008888'],qzoneWatchList:'001234 , odd;001234 00005678'};
  fs.writeFileSync(path.join(temp,'config.json'),JSON.stringify({...lists,unknownFuture:{keep:true}}));
  await saveSettings({groupEnabled:true},temp);
  const saved=JSON.parse(fs.readFileSync(path.join(temp,'config.json')));
  for(const key of Object.keys(lists))assert.deepEqual(saved[key],lists[key]);
  assert.deepEqual(saved.unknownFuture,{keep:true});
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

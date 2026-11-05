import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { settingsUIManifest, publicSettings, panelSettingsPatch, settingsRevision } from '../lib/settings-ui.js'
import { SETTINGS_FIELDS } from '../lib/settings-fields.js'
import { SETTINGS_DEFAULTS } from '../lib/toggle.js'
import { fieldsOf, DATA_FILES } from '../lib/data-schema.js'
const context={structuredClone};vm.runInNewContext(fs.readFileSync('web/mock/final/settings-state.js','utf8'),context)
const {Drafts,get,equal}=context.EchoSettingsState
const value=v=>JSON.parse(JSON.stringify(v))
test('metadata derives all seven editable data sources and readonly accounting',()=>{
 const manifest=settingsUIManifest();assert.deepEqual(manifest.files.map(f=>f.file),DATA_FILES.filter(f=>f!=='config.json'))
 for(const file of manifest.files){assert.equal(file.fields.length,fieldsOf(file.file).length);for(const f of file.fields)if(['schemaRev','edited','savedAt','updatedAt','defaultsRev'].includes(f.key))assert.equal(f.readOnly,true)}
 assert.equal(SETTINGS_FIELDS.length,21);assert.equal(SETTINGS_FIELDS.flatMap(g=>g.fields).length,131)
 assert.equal(SETTINGS_FIELDS.flatMap(g=>g.fields).filter(f=>f.readOnly).length,2)
})
test('every settings field has a current default path, nested and dotted paths included',()=>{
 for(const g of SETTINGS_FIELDS)for(const f of g.fields)assert.notEqual(get(SETTINGS_DEFAULTS,[...(g.nested?[g.nested]:[]),...f.key.split('.')]),undefined,g.title+'/'+f.key)
})
test('password stays write-only and blank replacement does not erase it',()=>{
 const original={relay:{token:'synthetic-secret',enabled:true},injectTopK:4};assert.equal(publicSettings(original).relay.token,'');assert.equal(original.relay.token,'synthetic-secret');assert.deepEqual(panelSettingsPatch({relay:{token:'',enabled:false}}),{relay:{enabled:false}});assert.equal(panelSettingsPatch({relay:{token:'synthetic-replacement'}}).relay.token,'synthetic-replacement')
})
test('readonly and derived keys cannot be written through panel patch',()=>{const p=panelSettingsPatch({herBaselineSource:'forged',herBaselineUpdatedAt:1,injectTopK:0});assert.deepEqual(p,{injectTopK:0})})
test('unsafe prototypes and malformed bodies are rejected recursively',()=>{for(const p of [null,[],5,JSON.parse('{"__proto__":{}}'),JSON.parse('{"relay":{"constructor":{}}}'),{a:[JSON.parse('{"prototype":1}')]}])assert.equal(panelSettingsPatch(p),null)})
test('draft preserves false, zero, empty string and empty list independently',()=>{const d=new Drafts();d.load('a',{on:true,n:2,text:'old',list:['a']});for(const[k,v]of Object.entries({on:false,n:0,text:'',list:[]}))d.edit('a',k,v);assert.equal(d.count(),4);assert.deepEqual(value(d.payload('a',{},true)),{on:false,n:0,text:'',list:[]});assert.equal(d.sources.get('a').base.on,true)})
test('refresh preserves draft input and updates remote for discard',()=>{const d=new Drafts();d.load('a',{n:2});d.edit('a','n',3);d.load('a',{n:4},{value:{n:4}});assert.equal(d.sources.get('a').value.n,3);assert.equal(d.rebase('a',{n:4}).length,1);d.discard();assert.equal(d.sources.get('a').value.n,4)})
test('object leaf edits merge from fresh snapshot and retain unknown keys',()=>{const d=new Drafts();d.load('a',{map:{a:1,extra:2}});d.edit('a','map',{a:3,extra:2});assert.deepEqual(value(d.payload('a',{map:{a:1,extra:7,newKey:9}})),{map:{a:3,extra:7,newKey:9}});assert.equal(d.rebase('a',{map:{a:1,extra:7}}).length,0)})
test('array parent edits fold subsequent child edits into one atomic change',()=>{const d=new Drafts();d.load('a',{rows:[{v:1}]});d.edit('a','rows',[{v:1},{v:2}]);d.edit('a',['rows',1,'v'],3);assert.equal(d.count(),1);assert.deepEqual(value(d.payload('a',{},true)),{rows:[{v:1},{v:3}]})})
test('parent replacement removes obsolete child changes and revert clears draft',()=>{const d=new Drafts();d.load('a',{m:{n:1}});d.edit('a','m.n',2);d.edit('a','m',null);assert.equal(d.count(),1);d.edit('a','m',{n:1});assert.equal(d.count(),0)})
test('structural equal ignores object ordering, respects array order and undefined',()=>{assert.ok(equal({a:1,b:2},{b:2,a:1}));assert.ok(!equal([1,2],[2,1]));assert.ok(!equal({}, {a:undefined}))})
test('secret cleared input reverts replacement, accepted readback clears only that source',()=>{const d=new Drafts();d.load('a',{token:''});d.load('b',{v:1});d.edit('a','token','synthetic',{secret:true});d.edit('a','token','',{secret:true});assert.equal(d.count(),0);d.edit('a','token','synthetic',{secret:true});d.edit('b','v',2);d.accepted('a',{token:''});assert.equal(d.count(),1);assert.equal(d.sources.get('b').value.v,2)})
test('readback pending cannot be discarded or edited and accepted unlocks it',()=>{const d=new Drafts();d.load('a',{v:1});d.edit('a','v',2);d.sources.get('a').pendingRead=true;d.discard();assert.equal(d.count(),1);assert.throws(()=>d.edit('a','v',3));d.accepted('a',{v:2});assert.equal(d.count(),0);assert.equal(d.sources.get('a').pendingRead,false)})
test('frontend rejects unsafe paths and does not persist secrets or fetch full config',()=>{const d=new Drafts();d.load('a',{});assert.throws(()=>d.edit('a','__proto__.p',1));const text=fs.readFileSync('web/mock/final/views/config.js','utf8');assert.ok(!text.includes('localStorage'));assert.ok(!text.includes('data/config.json'));assert.ok(!text.includes('EventSource'))})
test('secret revision changes without exposing the credential, dirty refresh retains original revision',()=>{assert.notEqual(settingsRevision({relay:{token:'synthetic-a'}}),settingsRevision({relay:{token:'synthetic-b'}}));const d=new Drafts();d.load('a',{token:''},{revision:'old'});d.edit('a','token','replacement',{secret:true});d.load('a',{token:''},{revision:'new'});assert.equal(d.sources.get('a').revision,'old')})
test('registered main settings handler exercises real protection and redacted GET/POST response',async()=>{
 const text=fs.readFileSync('lib/index.js','utf8'),match=text.match(/path: '\/api\/echo\/settings',\s*handler: async \(req, res\) => \{([\s\S]*?)\n    \}\n  \}\), 'echo.api.settings\(\)'/);assert.ok(match)
 let state={relay:{token:'synthetic-private'},injectTopK:4},writes=0
 const handler=new Function('json','readSettings','writeSettings','writeAllowed','readBody','SETTINGS_DEFAULTS','SETTINGS_FIELDS','derivedPersonaFields','loadPersona','ctx','publicSettings','panelSettingsPatch','settingsRevision','return async(req,res)=>{'+match[1]+'}')((res,status,payload)=>({status,payload}),()=>state,p=>{writes++;state={...state,...p,relay:{...state.relay,...p.relay}};return state},req=>req.headers?.['x-echo-edit']==='1',async req=>req.body,SETTINGS_DEFAULTS,SETTINGS_FIELDS,()=>({}),()=>({}),{logger:{info(){}}},publicSettings,panelSettingsPatch,settingsRevision)
 const get=await handler({method:'GET'},{});assert.equal(get.payload.settings.relay.token,'');assert.equal(get.payload.relayTokenSet,true);assert.equal(typeof get.payload.revision,'string')
 assert.equal((await handler({method:'POST',headers:{},body:{injectTopK:6}},{})).status,403);assert.equal(writes,0)
 const saved=await handler({method:'POST',headers:{'x-echo-edit':'1'},body:{relay:{token:''},herBaselineSource:'forged',injectTopK:6}},{});assert.equal(saved.status,200);assert.equal(saved.payload.settings.relay.token,'');assert.equal(state.relay.token,'synthetic-private');assert.equal(state.herBaselineSource,undefined);assert.equal(saved.payload.effective,'next-use')
})

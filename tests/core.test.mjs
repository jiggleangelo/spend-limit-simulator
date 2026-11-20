import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url), L=require('../core.js');
const policy={daily:100,weekly:200,monthly:300,rpm:5,maxAgeMs:10};
const clock=now=>({now,observedAt:now});
const reserve=(s,id,amount,at=100)=>L.apply(s,{type:'reserve',id,amount},clock(at));
const settle=(s,id,actual,at=101)=>L.apply(s,{type:'settle',id,actual},clock(at));
test('exact caps admit, one over latches without charging blocked request',()=>{
 let r=reserve(L.create(policy),'a',100);assert.equal(r.ack,true);
 r=reserve(r.state,'b',1);assert.equal(r.ack,false);assert.equal(r.reason,'daily_cap');assert.equal(L.project(r.state,100).usage.daily,100);
});
for(const key of ['weekly','monthly']) test(key+' cap is enforced independently',()=>{
 const p={...policy,daily:1000,[key]:5};let r=reserve(L.create(p),'a',6);
 assert.equal(r.reason,key+'_cap');assert.equal(r.state.records.length,0);
});
test('rolling settled windows exclude exactly the lower boundary',()=>{
 let s=settle(reserve(L.create(policy),'a',50,0).state,'a',50,1).state;
 for(const [key,ms] of Object.entries(L.WINDOWS)){
  assert.equal(L.project(s,ms).usage[key],50);assert.equal(L.project(s,ms+1).usage[key],0);
 }
});
test('unsettled reservations do not age out of any spend window',()=>{
 const s=reserve(L.create(policy),'a',70,0).state;
 assert.deepEqual(L.project(s,10*L.WINDOWS.monthly).usage,{daily:70,weekly:70,monthly:70});
});
test('actual below reservation releases difference, positive drift consumes exposure',()=>{
 let s=reserve(L.create(policy),'a',80).state;s=settle(s,'a',30).state;
 assert.equal(L.project(s,101).remaining.daily,70);
 s=reserve(s,'b',10,102).state;s=settle(s,'b',20,103).state;
 assert.equal(L.project(s,103).positiveDrift,10);assert.equal(L.project(s,103).usage.daily,50);
});
test('overrun records full actual and latches; settlement still records after hard stop',()=>{
 let s=reserve(L.create(policy),'a',40).state;s=reserve(s,'b',40).state;
 let r=settle(s,'a',110);assert.equal(r.ack,true);assert.equal(r.state.latch,'actual_over_cap');
 r=settle(r.state,'b',60,102);assert.equal(r.ack,true);assert.equal(L.project(r.state,102).usage.daily,170);
});
test('rate cap and exact rolling rate boundary',()=>{
 const p={...policy,rpm:1};const s=reserve(L.create(p),'a',0,1).state;
 assert.equal(reserve(s,'b',0,60000).reason,'rate_cap');assert.equal(reserve(s,'b',0,60001).ack,true);
});
test('negative boundary 1: stale/missing/NaN/negative clocks fail closed',()=>{
 for(const c of [null,{}, {now:100}, {now:100,observedAt:89},{now:NaN,observedAt:100},{now:-1,observedAt:0},{now:100,observedAt:101}]){
  const r=L.apply(L.create(policy),{type:'reserve',id:'a',amount:1},c);assert.equal(r.ack,false);assert.equal(r.state.records.length,0);assert.ok(r.state.latch);
 }
 const s=reserve(L.create(policy),'a',1).state;
 assert.equal(L.apply(s,{type:'reserve',id:'b',amount:1},clock(99)).ack,false);
});
test('all malformed amounts and policy fields are rejected without coercion',()=>{
 for(const amount of [NaN,Infinity,-1,0.1,true,'1',null,undefined,Number.MAX_SAFE_INTEGER+1]){
  assert.equal(reserve(L.create(policy),'a',amount).ack,false);
  assert.equal(settle(reserve(L.create(policy),'a',1).state,'a',amount).ack,false);
 }
 for(const key of Object.keys(policy)) for(const value of [undefined,-1,NaN,true,'1',0.1]) assert.throws(()=>L.create({...policy,[key]:value}));
});
test('duplicates, unknown settlement and out-of-order settlement cannot lose accounting',()=>{
 let s=reserve(L.create(policy),'a',50).state;
 assert.equal(reserve(s,'a',1).ack,false);assert.equal(settle(s,'absent',0).ack,false);
 s=settle(s,'a',40).state;assert.equal(settle(s,'a',0,102).ack,false);assert.equal(L.project(s,102).usage.daily,40);
});
test('negative boundary 2: persist-before-ack, failure retains reservation, serialized concurrent admissions',async()=>{
 let disk='',writes=0,release;
 const hold=new Promise(resolve=>{release=resolve;});
 const session=L.createSession({...policy,daily:1},{async write(v){writes++;await hold;disk=v;},async read(){return disk;}});
 let acknowledged=false;
 const first=session.dispatch({type:'reserve',id:'a',amount:1},clock(100)).then(r=>{acknowledged=true;return r;});
 const second=session.dispatch({type:'reserve',id:'b',amount:1},clock(100));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,1);assert.equal(acknowledged,false);release();
 assert.equal((await first).ack,true);assert.equal((await second).ack,false);assert.equal(JSON.parse(disk).records.length,1);
 const bad=L.createSession(policy,{async write(){throw Error('disk unavailable');},async read(){return '';}});
 assert.equal((await bad.dispatch({type:'reserve',id:'x',amount:80},clock(100))).ack,false);
 assert.equal(L.project(bad.inspect(),100).pending,80);
 assert.equal((await bad.dispatch({type:'reserve',id:'y',amount:1},clock(100))).ack,false);
});
test('negative boundary 3: fake read-back/projection cannot earn acknowledgement or forge totals',async()=>{
 const session=L.createSession(policy,{async write(){},async read(){return '{"ack":true,"usage":0}';}});
 const r=await session.dispatch({type:'reserve',id:'a',amount:70},clock(100));
 assert.equal(r.ack,false);assert.equal(r.reason,'persistence_uncertain');
 const state=session.inspect();state.usage={daily:0};state.remaining={daily:999};
 assert.equal(L.project(state,100).usage.daily,70);
 state.records=[];assert.equal(L.project(session.inspect(),100).usage.daily,70);
 assert.match(L.project(session.inspect(),100).source,/unverified/);
});
test('negative boundary 4: no override/reset can bypass a hard stop',()=>{
 const s=reserve(L.create(policy),'a',101).state;
 for(const e of [{type:'reset',id:'r'},{type:'reserve',id:'b',amount:0,override:true,force:true},{type:'reserve',id:'c',amount:0,admin:true}]){
  const r=L.apply(s,e,clock(99999999));assert.equal(r.ack,false);assert.equal(r.state.records.length,0);assert.equal(r.state.latch,'daily_cap');
 }
});
test('input bounds, unsafe aggregate totals and forged ledger shape fail closed',()=>{
 assert.throws(()=>L.simulate(policy,Array(501).fill({})));
 assert.throws(()=>L.project({...L.create(policy),records:[{id:'a'}]},1));
 let s=L.create({...policy,daily:Number.MAX_SAFE_INTEGER,weekly:Number.MAX_SAFE_INTEGER,monthly:Number.MAX_SAFE_INTEGER});
 s=reserve(s,'a',1).state;s=reserve(s,'b',1).state;
 s=settle(s,'a',Number.MAX_SAFE_INTEGER).state;s=settle(s,'b',1,102).state;
 assert.ok(s.latch);assert.throws(()=>L.project(s,102),/overflow/);assert.equal(reserve(s,'c',0,103).ack,false);
});
test('UMD browser export and frozen API',()=>{
 const context={};vm.runInNewContext(readFileSync(new URL('../core.js',import.meta.url),'utf8'),context);
 assert.equal(typeof context.LimitLatch.apply,'function');assert.equal(Object.isFrozen(L),true);
});

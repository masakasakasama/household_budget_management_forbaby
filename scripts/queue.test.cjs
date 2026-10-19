const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function fixture(write) {
  const stored = new Map(), statuses=[];
  const context = { remoteReady:false, KEY_PENDING:'pending', Date, newId:()=> 'op-'+Math.random(),
    operationData:(_type,data)=>structuredClone(data), loadJson:(key,fallback)=>stored.has(key)?JSON.parse(stored.get(key)):fallback,
    localStorage:{setItem:(key,value)=>stored.set(key,value)}, setDataStatus:message=>statuses.push(message) };
  const begin=source.indexOf('  function queueOperation('),end=source.indexOf('  async function writeOperation(',begin);
  vm.runInNewContext(source.slice(begin,end),context);
  const start=source.indexOf('  let flushingPending'),stop=source.indexOf('  function syncMonth(',start);
  vm.runInNewContext(source.slice(start,stop),context);
  context.writeOperation=write;
  return {context,stored,pending:()=>JSON.parse(stored.get('pending')||'[]')};
}
test('offline queue retains more than 500 edits and persists before attempted network write',async()=>{
  const f=fixture(async op=>assert.ok(f.pending().some(item=>item.operationId===op.operationId)));
  for(let i=0;i<601;i++)f.context.queueOperation('expense','id-'+i,{amount:i},'create');
  assert.equal(f.pending().length,601);
  f.context.remoteReady=true;await f.context.flushPending();assert.equal(f.pending().length,0);
});
test('new edits during a pending write survive ack; concurrent drains preserve FIFO',async()=>{
  let release;const waiting=new Promise(resolve=>release=resolve),received=[];
  const f=fixture(async op=>{received.push(op.id);if(op.id==='first')await waiting;});
  f.context.queueOperation('expense','first',{amount:1},'create');f.context.remoteReady=true;
  const first=f.context.flushPending();await Promise.resolve();
  f.context.queueOperation('expense','second',{amount:2},'create');await f.context.flushPending();
  assert.equal(f.pending().length,2);release();await first;
  assert.deepEqual(received,['first','second']);assert.equal(f.pending().length,0);
});
test('failed auth or network write retains every operation and retries original order',async()=>{
  const received=[];let fail=true;
  const f=fixture(async op=>{if(fail)throw Error('permission-denied');received.push(op.id);});
  for(const id of ['a','b','c'])f.context.queueOperation('expense',id,{},'edit');
  f.context.remoteReady=true;await f.context.flushPending();assert.equal(f.pending().length,3);
  fail=false;await f.context.flushPending();assert.deepEqual(received,['a','b','c']);assert.equal(f.pending().length,0);
});
test('transaction retries are idempotent and preserve other device fields plus previous contents in history',async()=>{
  const records=new Map([['spaces/space/months/month',{salary:200,savingGoal:20}]]);
  const context={remoteReady:true,firestore:{},authUser:{uid:'spouseA'},SPACE_ID:'space',entityCollection:()=> 'months',cleanRemote:x=>x,setDataStatus:()=>{},fsApi:{
    doc:(_,...parts)=>parts.join('/'),serverTimestamp:()=>123,
    runTransaction:async(_db,callback)=>{const writes=[];await callback({get:async ref=>({exists:()=>records.has(ref),data:()=>records.get(ref)}),set:(ref,value)=>writes.push([ref,value])});for(const [ref,value]of writes)records.set(ref,structuredClone(value));}
  }};
  const start=source.indexOf('  async function writeOperation('),end=source.indexOf('  let flushingPending',start);
  vm.runInNewContext(source.slice(start,end),context);
  const operation={id:'month',operationId:'stable',type:'month',before:{salary:100,savingGoal:10},data:{salary:100,savingGoal:30},action:'edit',queuedAt:1};
  await context.writeOperation(operation);await context.writeOperation(operation);
  assert.equal(records.get('spaces/space/months/month').salary,200);
  assert.equal(records.get('spaces/space/months/month').savingGoal,30);
  assert.equal(records.get('spaces/space/history/stable').before.salary,200);
  assert.equal(records.size,2);
});
test('concurrent changes to separate budget rows and remote-added rows survive reconciliation',async()=>{
  const prior=[{id:'rent',amount:80},{id:'food',amount:30}];
  const local=[{id:'rent',amount:90},{id:'food',amount:30}];
  const remote=[{id:'rent',amount:80},{id:'food',amount:40},{id:'new-on-other-device',amount:5}];
  const records=new Map([['spaces/space/months/month',{budgets:remote}]]);
  const context={remoteReady:true,firestore:{},authUser:{uid:'spouseA'},SPACE_ID:'space',entityCollection:()=> 'months',cleanRemote:x=>x,setDataStatus:()=>{},fsApi:{
    doc:(_,...parts)=>parts.join('/'),serverTimestamp:()=>123,
    runTransaction:async(_db,callback)=>{const writes=[];await callback({get:async ref=>({exists:()=>records.has(ref),data:()=>records.get(ref)}),set:(ref,value)=>writes.push([ref,value])});for(const [ref,value]of writes)records.set(ref,structuredClone(value));}
  }};
  const start=source.indexOf('  async function writeOperation('),end=source.indexOf('  let flushingPending',start);
  vm.runInNewContext(source.slice(start,end),context);
  await context.writeOperation({id:'month',operationId:'budget-edit',type:'month',before:{budgets:prior},data:{budgets:local},action:'edit',queuedAt:1});
  assert.deepEqual(JSON.parse(JSON.stringify(records.get('spaces/space/months/month').budgets)),[{id:'rent',amount:90},{id:'food',amount:40},{id:'new-on-other-device',amount:5}]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {validateTask,COURTS} from '../src/domain.ts';
import type {Task,Snapshot,AttemptResult,Booking} from '../src/domain.ts';

const now=Date.parse('2026-10-20T18:00:00+08:00');
const snap:Snapshot={accountId:'me',accountName:'测试用户',corpId:'corp',settingsHash:'h',rules:{startHour:10,endHour:23,meetingInterval:30,maxDuration:120,bookingLimitDays:2},rooms:Object.values(COURTS).map(c=>({...c,canBooking:true,disabled:false})),serverOffsetMs:0,sampledAt:now,submissionReady:true,submissionReason:'test verified transport'};
function booking(t:Task,roomId:string):Booking{return {id:'booked-1',ownerId:'me',roomId,beginTime:`${t.date} ${t.start}:00`,endTime:`${t.date} ${t.end}:00`,status:'OPEN'};}
class FakeSite {
  snapshot=structuredClone(snap); attempts:string[]=[]; records:Booking[]=[]; results:AttemptResult[]=[];
  failList=false; failPreflight=false; afterSubmit:((t:Task,r:string)=>void)|undefined; rehearseError?:string;
  refineClock?:(samples?:number,budgetMs?:number)=>Promise<{offsetMs:number;uncertaintyMs:number}>;
  preflightTimeouts:(number|undefined)[]=[]; listTimeouts:(number|undefined)[]=[];
  async preflight(timeoutMs?:number){this.preflightTimeouts.push(timeoutMs);if(this.failPreflight)throw Error('request timeout');return structuredClone(this.snapshot);}
  async list(_date:string,timeoutMs?:number){this.listTimeouts.push(timeoutMs);if(this.failList)throw Error('offline');return this.records;}
  async submit(t:Task,r:string){this.attempts.push(r);this.afterSubmit?.(t,r);return this.results.shift()??{kind:'conflict' as const};}
  async rehearse(t:Task,r:string){if(this.rehearseError)throw Error(this.rehearseError);return {intercepted:1,forwarded:0,fields:['roomId','meetingDate','startTime','duration','subject'],roomId:r};}
}
async function setup(fn:(s:Store,e:Engine,site:FakeSite)=>Promise<void>){
  const parent=join(import.meta.dirname,'../test-results');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(join(parent,'engine-')); const s=await Store.open(dir),site=new FakeSite();
  let clock=now;const e=new Engine(s,site,{now:()=>clock,sleep:async ms=>{clock+=ms;},monotonic:()=>clock});
  try{await fn(s,e,site);}finally{await rm(dir,{recursive:true,force:true});}
}
const input={date:'2026-10-21',start:'19:00',end:'21:00',mode:'live'};
test('场地1明确冲突才尝试场地2，核对成功后停止',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'conflict'},{kind:'created',booking:booking(t,COURTS['2'].id)}];
  site.afterSubmit=(t,r)=>{if(r===COURTS['2'].id)site.records=[booking(t,r)];};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(t.receipt?.id,'booked-1');assert.deepEqual(site.attempts,Object.values(COURTS).map(c=>c.id));
}));
test('两场都明确冲突后失败，不缩短或换时',()=>setup(async(s,e,site)=>{
  const t=s.add(input);await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'failed');assert.equal(site.attempts.length,2);
}));
test('明确冲突后先用缓存立刻换场，不再为下一次提交先查占用',()=>setup(async(s,e,site)=>{
  const t=s.add(input),actions:string[]=[];const originalList=site.list.bind(site);site.list=async date=>{actions.push('list');return originalList(date);};
  site.results=[{kind:'conflict'},{kind:'created'}];site.afterSubmit=(sent,r)=>{actions.push('submit');if(r===COURTS['1'].id)site.records=[{...booking(t,r),ownerId:'other',id:'occupied'}];else site.records.push(booking(sent,r));};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'succeeded');assert.deepEqual(site.attempts,[COURTS['1'].id,COURTS['2'].id]);
  assert.deepEqual(actions.slice(0,3),['list','submit','submit']);
}));
test('只有一场且冲突查询有延迟时，结合明确冲突区间改抢剩余半小时',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,start:'22:00',end:'23:00',courtPriority:['1']});
  site.results=[{kind:'conflict',conflictInterval:{date:t.date,start:'22:00',end:'22:30'}},{kind:'created'}];
  const slots:string[]=[];site.afterSubmit=(sent,r)=>{slots.push(sent.start+'–'+sent.end);if(slots.length===2)site.records=[booking(sent,r)];};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'partial');assert.deepEqual(slots,['22:00–23:00','22:30–23:00']);assert.equal(t.start,'22:00');assert.equal(s.state.freeze,undefined);
}));
test('冲突后刷新到本人已有部分预约时停止，不再换场或补订',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'conflict'},{kind:'conflict'}];site.afterSubmit=(sent,r)=>{site.records=[{...booking(sent,r),endTime:`${t.date} 19:30:00`}];};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'partial');assert.equal(site.attempts.length,2);assert.equal(s.state.freeze,undefined);
}));
test('明确冲突后先用缓存换场，第二次冲突刷新失败才停止，且不冻结已明确拒绝的请求',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'conflict'}];site.afterSubmit=()=>{site.failList=true;};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'failed');assert.equal(site.attempts.length,2);assert.equal(s.state.freeze,undefined);assert.match(t.message,/刷新占用失败/);
}));
test('连续冲突后才刷新占用，缓存换场不额外查询',()=>setup(async(s,e,site)=>{
  const t=s.add(input),lists:string[]=[];const originalList=site.list.bind(site);site.list=async date=>{lists.push(date);return originalList(date);};
  site.results=[{kind:'conflict'},{kind:'conflict'},{kind:'conflict'}];
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(site.attempts.length,2);assert.equal(lists.length,2);assert.equal(t.status,'failed');
}));
test('首场明确冲突后，备用场结果不明仍暂停，不能继续尝试剩余时段',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,start:'22:00',end:'23:00'});
  site.results=[{kind:'conflict',conflictInterval:{date:t.date,start:'22:00',end:'22:30'}},{kind:'unknown'}];
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'unknown');assert.equal(site.attempts.length,2);assert.equal(s.state.freeze?.taskId,t.id);
}));
test('首选场冲突后即使还有半小时，也优先提交完整空闲的备用场',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,start:'22:00',end:'23:00'}),slots:string[]=[];
  site.results=[{kind:'conflict',conflictInterval:{date:t.date,start:'22:00',end:'22:30'}},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{slots.push(sent.start+'–'+sent.end);if(r===COURTS['2'].id)site.records=[booking(sent,r)];};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'succeeded');assert.deepEqual(site.attempts,[COURTS['1'].id,COURTS['2'].id]);assert.deepEqual(slots,['22:00–23:00','22:00–23:00']);
}));
test('未完成表单验证时拒绝启用正式任务',()=>setup(async(s,e,site)=>{
  site.snapshot.submissionReady=false;const t=s.add(input);await assert.rejects(e.arm(t.id),/表单|验证/);assert.equal(site.attempts.length,0);
}));
test('演练不调用正式提交且输出零转发记录',()=>setup(async(s,e,site)=>{
  site.snapshot.submissionReady=false;const t=s.add({...input,mode:'dry-run'});await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'rehearsed');assert.equal(site.attempts.length,0);assert.match(t.message,/0/);
}));
test('演练失败提示真实原因，不再一律误报为扫码或网络问题',()=>setup(async(s,e,site)=>{
  site.snapshot.submissionReady=false;site.rehearseError='脚本参数与网页请求不一致，所有预约写请求已拦截：fixedEndDate=2026-11-03(网页)/2026-11-02(脚本)';
  const t=s.add({...input,mode:'dry-run'});await e.rehearseNow(t.id);
  assert.equal(t.status,'failed');assert.match(t.message,/fixedEndDate/);assert.doesNotMatch(t.message,/请先扫码登录/);
}));
test('响应丢失但查询发现完整预约，记成功不补发',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'unknown'}];site.afterSubmit=(t,r)=>{site.records=[booking(t,r)];};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);assert.equal(s.state.freeze,undefined);
}));
test('结果不明时冻结账号后续任务，重启仍保留',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'unknown'}];await e.arm(t.id);site.afterSubmit=()=>{site.failList=true;};
  await e.execute(t.id);assert.equal(t.status,'unknown');assert.equal(s.state.freeze?.taskId,t.id);
  const other=s.add({...input,start:'21:00',end:'22:00'});await assert.rejects(e.arm(other.id),/暂停|冻结/);
  const restored=await Store.open(s.directory);assert.equal(restored.state.freeze?.taskId,t.id);assert.equal(site.attempts.length,1);
}));
test('持久化处于提交中时崩溃，恢复为结果待确认',()=>setup(async(s)=>{
  const t=s.add(input);t.status='submitting';t.accountId='me';s.save();const restored=await Store.open(s.directory);
  assert.equal(restored.get(t.id).status,'unknown');assert.equal(restored.state.freeze?.taskId,t.id);
  assert.match(restored.get(t.id).message,/结果尚未确认/);
}));
test('结果待确认的具体错误在重启后仍保留',()=>setup(async(s)=>{
  const t=s.add(input);t.status='unknown';t.message='HTTP 200，业务代码200：不能预订超过2天的会议';s.save();
  const restored=await Store.open(s.directory);assert.equal(restored.get(t.id).message,t.message);assert.equal(restored.get(t.id).status,'unknown');
}));
test('重叠任务不能同时启用，取消等待不会改动网站',()=>setup(async(s,e,site)=>{
  const a=s.add(input),b=s.add({...input,start:'20:00',end:'22:00'});await e.arm(a.id);
  await assert.rejects(e.arm(b.id),/重叠/);e.cancel(a.id);await e.execute(a.id);assert.equal(a.status,'cancelled');assert.equal(site.attempts.length,0);
}));
for(const status of ['partial','succeeded'] as const){
  test(`${status}历史对应的网站预约已取消后，可手动新建同一时段任务`,()=>setup(async(s,e,site)=>{
    const old=s.add(input);old.status=status;s.save();
    const next=s.add({...input,subject:'1'});site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
    await e.arm(next.id);await e.execute(next.id);
    assert.equal(next.status,'succeeded');assert.equal(site.attempts.length,1);assert.equal(old.status,status);
  }));
  test(`${status}历史对应的网站预约仍有效时，新任务核对到记录而不重复提交`,()=>setup(async(s,e,site)=>{
    const old=s.add(input);old.status=status;site.records=[booking(old,COURTS['1'].id)];s.save();
    const next=s.add({...input,subject:'1'});await e.arm(next.id);await e.execute(next.id);
    assert.equal(next.status,'succeeded');assert.equal(site.attempts.length,0);assert.equal(old.status,status);
  }));
}
test('登录过期后终止，不换场重试',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'auth'}];await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'failed');assert.equal(site.attempts.length,1);
}));
test('限流遵循等待时间，超过15秒窗口不再提交',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'limited',waitMs:16000}];await e.arm(t.id);await e.execute(t.id);assert.equal(site.attempts.length,1);assert.equal(t.status,'failed');
}));
test('尚未开放最多重试3次后停止，不冻结',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=Array.from({length:30},()=>({kind:'not-open'}));await e.arm(t.id);await e.execute(t.id);
  assert.equal(site.attempts.length,4);assert.equal(t.status,'failed');assert.equal(s.state.freeze,undefined);assert.match(t.message,/重试边界/);
}));
test('限流重试最多20次，按网站等待时间串行',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=Array.from({length:30},()=>({kind:'limited' as const,waitMs:300}));await e.arm(t.id);await e.execute(t.id);
  assert.equal(site.attempts.length,20);assert.equal(t.status,'failed');assert.ok((t.sentAt??0)>=now+5700);
}));
test('抢到部分时段就保留并停止，展示实际时段，不再补订或换场',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'created'}];
  site.afterSubmit=(t,r)=>{site.records=[{...booking(t,r),beginTime:`${t.date} 20:30:00`,allowSectionBooking:true}];};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'partial');assert.equal(t.receipts?.[0].begin,`${t.date} 20:30:00`);assert.equal(site.attempts.length,1);assert.equal(s.state.freeze,undefined);
}));
test('响应丢失但核对到部分成功，同样保留并停止',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'unknown'}];site.afterSubmit=(t,r)=>{site.records=[{...booking(t,r),endTime:`${t.date} 19:30:00`}];};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'partial');assert.equal(site.attempts.length,1);
}));
test('本来就有部分预约时不重复抢场',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.records=[{...booking(t,COURTS['1'].id),endTime:`${t.date} 19:30:00`}];
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'partial');assert.equal(site.attempts.length,0);
}));
test('部分成功重启后仍是终止状态',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.afterSubmit=(t,r)=>{site.records=[{...booking(t,r),endTime:`${t.date} 19:30:00`}];};site.results=[{kind:'created'}];
  await e.arm(t.id);await e.execute(t.id);const reopened=await Store.open(s.directory);assert.equal(reopened.get(t.id).status,'partial');assert.equal(reopened.state.freeze,undefined);
}));
test('完整优先：首选场仅有部分空闲而备用场完整空闲时先尝试备用场',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.records=[{...booking(t,COURTS['1'].id),id:'occupied',ownerId:'other',endTime:`${t.date} 19:30:00`}];site.results=[{kind:'created'}];
  site.afterSubmit=(t,r)=>{site.records.push(booking(t,r));};await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.deepEqual(site.attempts,[COURTS['2'].id]);
}));
test('只有剩余半小时可用时只提交该半小时，保留原目标并停止',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,start:'22:00',end:'23:00'});
  site.records=[{...booking(t,COURTS['1'].id),id:'full',ownerId:'other'}, {...booking(t,COURTS['2'].id),id:'occupied',ownerId:'other',beginTime:`${t.date} 21:00:00`,endTime:`${t.date} 22:30:00`}];
  site.results=[{kind:'created'}];
  site.afterSubmit=(sent,r)=>{assert.equal(sent.start,'22:30');assert.equal(sent.end,'23:00');site.records.push(booking(sent,r));};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'partial');assert.equal(t.start,'22:00');assert.equal(t.end,'23:00');assert.deepEqual(site.attempts,[COURTS['2'].id]);
  assert.equal(t.receipts?.[0].begin,`${t.date} 22:30:00`);
}));
test('提交失败的脱敏响应写入任务和日志，结果不明仍保持暂停',()=>setup(async(s,e,site)=>{
  const t=s.add(input);const diagnostic={httpStatus:200,businessCode:400,serverMessage:'参数无效'};
  site.results=[{kind:'unknown',message:'HTTP 200，业务代码 400：参数无效',diagnostic}];
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'unknown');assert.deepEqual(t.lastResponse,diagnostic);assert.match(t.message,/参数无效/);
  const events=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(events,/businessCode/);
}));
test('已开始任务不执行',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-20',start:'10:00',end:'11:00'});await assert.rejects(e.arm(t.id),/开始|过期/);assert.equal(site.attempts.length,0);
}));
test('导入批次无效时不留下半批任务',()=>setup(async(s)=>{
  assert.throws(()=>s.importTasks([{...input},{...input,start:'19:15'}]));assert.equal(s.state.tasks.length,0);
}));
test('零点之前即使手动触发执行也不提交',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});await e.arm(t.id);await e.execute(t.id);assert.equal(site.attempts.length,0);assert.equal(t.status,'scheduled');
}));
test('并发启用重叠任务时仍只有一个得到启用',()=>setup(async(s,e)=>{
  const a=s.add(input),b=s.add({...input,start:'20:00',end:'22:00'});
  const settled=await Promise.allSettled([e.arm(a.id),e.arm(b.id)]);
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);
}));
test('传输抛错但网站已有完整记录时先核对，不直接冻结',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.afterSubmit=(t,r)=>{site.records=[booking(t,r)];throw Error('response lost');};
  await e.arm(t.id);await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);assert.equal(s.state.freeze,undefined);
}));
test('最后预检完成后，零点首个操作直接提交而非再查询占用',()=>setup(async(s,e,site)=>{
  const t=s.add(input);await e.arm(t.id);await e.prepare(t.id);
  const actions:string[]=[];const list=site.list.bind(site);site.list=async date=>{actions.push('list');return list(date);};
  site.results=[{kind:'conflict'},{kind:'conflict'}];const submit=site.submit.bind(site);site.submit=async(t,r)=>{actions.push('submit');return submit(t,r);};
  await e.execute(t.id);assert.equal(actions[0],'submit');
}));
test('预检后已有预约被取消，不把旧缓存宣称为成功',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.records=[booking(t,COURTS['1'].id)];await e.arm(t.id);await e.prepare(t.id);site.records=[];
  await e.execute(t.id);assert.equal(t.status,'failed');assert.equal(site.attempts.length,2);
}));
test('零点预检快照显示目标全占时，复查到空闲就继续提交',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22',courtPriority:['1']});let wall=t.releaseAt-10_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  site.records=[{id:'occupied',ownerId:'other',roomId:COURTS['1'].id,beginTime:`${t.date} 19:00:00`,endTime:`${t.date} 21:00:00`,status:'OPEN'}];
  await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt+100;mono+=10_100;site.records=[];
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
  assert.equal(site.listTimeouts.filter(ms=>ms===1500).length,1,'零点复查只查一次');
  const events=await readFile(join(s.directory,'events.ndjson'),'utf8');
  assert.match(events,/precheck-occupied-recheck/);assert.match(events,/precheck-recheck-recovered/);
}));
test('零点复查仍全占时按原结论失败，不提交',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22',courtPriority:['1']});let wall=t.releaseAt-10_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  site.records=[{id:'occupied',ownerId:'other',roomId:COURTS['1'].id,beginTime:`${t.date} 19:00:00`,endTime:`${t.date} 21:00:00`,status:'OPEN'}];
  await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt+100;mono+=10_100;
  await e.execute(t.id);
  assert.equal(t.status,'failed');assert.equal(site.attempts.length,0);
  assert.match(t.message,/候选场地在目标时段均已占用/);
  assert.equal(site.listTimeouts.filter(ms=>ms===1500).length,1,'复查仍失败时也只查一次');
  const events=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(events,/precheck-recheck-still-occupied/);
}));
test('零点复查查询失败时停止，不提交也不冻结',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22',courtPriority:['1']});let wall=t.releaseAt-10_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  site.records=[{id:'occupied',ownerId:'other',roomId:COURTS['1'].id,beginTime:`${t.date} 19:00:00`,endTime:`${t.date} 21:00:00`,status:'OPEN'}];
  await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt+100;mono+=10_100;
  site.list=async()=>{throw Error('offline');};
  await e.execute(t.id);
  assert.equal(t.status,'failed');assert.equal(site.attempts.length,0);assert.equal(s.state.freeze,undefined);
  assert.match(t.message,/零点复查失败/);
}));
test('预检快照已有候选时不额外复查',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt+100;mono+=10_100;
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
  assert.equal(site.listTimeouts.filter(ms=>ms===1500).length,0,'已有候选时不做零点复查');
}));
test('最后预检后电脑时钟回拨，仍按单调时钟的服务器时间开抢',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt-30000;mono=11000;await e.execute(t.id);assert.equal(site.attempts.length,2);
}));
test('服务器估计快351毫秒也不能在电脑零点前347毫秒发出预约',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-347,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.serverOffsetMs=351;site.snapshot.serverUncertaintyMs=60;
  await e.arm(t.id);await e.execute(t.id);assert.equal(site.attempts.length,0);assert.equal(t.status,'scheduled');
  wall+=427;mono+=427;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);assert.ok(t.localTriggerDelayMs!>=80);
}));
test('电脑已过零点但服务器保守时间尚未到点时仍然等待',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt+1000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.serverOffsetMs=-1500;site.snapshot.serverUncertaintyMs=50;
  await e.arm(t.id);await e.execute(t.id);assert.equal(site.attempts.length,0);
  wall+=700;mono+=700;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
}));
test('零点触发点取双时钟较晚者加15毫秒，校时误差只记录不参与等待',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt+10,mono=1000;
  site.snapshot.serverUncertaintyMs=50;e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  await e.arm(t.id);await e.execute(t.id);assert.equal(site.attempts.length,0,'未到15毫秒余量不得提交');
  wall=t.releaseAt+20;mono+=10;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(t.clockUncertaintyMs,50,'误差仍记录到任务');
}));
test('资源分配错误不冻结账号，等待并核对后重试成功',()=>setup(async(s,e,site)=>{
  const t=s.add(input),actions:string[]=[];const originalList=site.list.bind(site);site.list=async date=>{actions.push('list');return originalList(date);};
  site.results=[{kind:'transient',waitMs:10_000},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(r===COURTS['1'].id)site.records=[{...booking(t,r),ownerId:'other',id:'occupied'}];else site.records.push(booking(sent,r));};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.deepEqual(site.attempts,[COURTS['1'].id,COURTS['2'].id]);
  assert.equal(s.state.freeze,undefined);assert.deepEqual(actions,['list','list','list'],'每次重试前都必须先核对本人记录');
}));
test('资源分配错误反复出现时按退避重试，窗口结束后失败但不冻结',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=Array.from({length:20},()=>({kind:'transient' as const,waitMs:10_000}));
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'failed');assert.equal(s.state.freeze,undefined);
  assert.ok(site.attempts.length>=2&&site.attempts.length<=10);
  assert.match(t.message,/资源分配|窗口/);
  const events=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(events,/retry-after-transient/);
}));
test('日期上限拒绝视为未创建，立即重试而不冻结',()=>setup(async(s,e,site)=>{
  const t=s.add(input),submits:number[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(sent,r)=>{submits.push(e.clock.monotonic());return originalSubmit(sent,r);};
  site.results=[{kind:'not-open'},{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,2);assert.equal(s.state.freeze,undefined);
  assert.ok(submits[1]-submits[0]>=100,'两次提交至少间隔100毫秒');
}));
test('已校时后的系统时钟回拨不会使原有单调时钟预约失效',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10000,mono=1000;
  site.snapshot.serverUncertaintyMs=80;e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  await e.arm(t.id);await e.prepare(t.id);wall=t.releaseAt-30000;mono=11160;
  await e.execute(t.id);assert.equal(site.attempts.length,2);
}));
test('放号前多采样仍会执行，但触发边界固定为双时钟较晚者加15毫秒',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10_000,mono=1000,refined=0;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  site.snapshot.serverOffsetMs=0;site.snapshot.serverUncertaintyMs=137;
  site.refineClock=async()=>{refined++;return {offsetMs:0,uncertaintyMs:20};};
  await e.arm(t.id);await e.prepare(t.id);
  assert.equal(refined,1,'放号前30秒内应做多采样');
  wall=t.releaseAt+10;mono+=10_010;await e.execute(t.id);assert.equal(site.attempts.length,0,'未到15毫秒余量不得提交');
  wall=t.releaseAt+20;mono+=10;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(site.attempts.length,1);assert.equal(t.status,'succeeded');
  assert.ok((t.localTriggerDelayMs??0)>=15,'最多提前到开放后15毫秒');
}));
test('放号前多采样失败时沿用已有校时，不中断任务',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  site.snapshot.serverUncertaintyMs=60;site.refineClock=async()=>{throw Error('offline');};
  await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt+200;mono+=10_200;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
}));



test('临时错误后连续两次查询失败则不提交第二次，也不冻结',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'transient',waitMs:10_000},{kind:'created'}];
  let calls=0;const originalList=site.list.bind(site);
  site.list=async date=>{calls++;if(calls>1)throw Error('offline');return originalList(date);};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'failed');assert.equal(site.attempts.length,1);assert.equal(s.state.freeze,undefined);
  assert.match(t.message,/无法核对本人记录/);
}));
test('放号前校时采样有总预算，剩余时间不足时跳过',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10_000,mono=1000;const budgets:number[]=[];
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  site.refineClock=async(_samples?:number,budgetMs?:number)=>{budgets.push(budgetMs??-1);return {offsetMs:0,uncertaintyMs:20};};
  await e.arm(t.id);await e.prepare(t.id);
  assert.equal(budgets.length,1);assert.ok((budgets[0]>0)&&budgets[0]<=2000,'采样总预算不超过2秒');
  budgets.length=0;wall=t.releaseAt-1_000;mono+=9_000;await e.prepare(t.id);
  assert.equal(budgets.length,0,'放号前只剩约1秒时不再采样，保证不阻塞零点');
}));
test('保存浏览器实测的发送与响应时刻，便于核对真实耗时',()=>setup(async(s,e,site)=>{
  const t=s.add(input),wire={sentAt:now+1234,receivedAt:now+1400,elapsedMs:166};
  site.results=[{kind:'created',wire}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(t.wireSentAt,wire.sentAt);assert.equal(t.wireResponseMs,166);
  assert.equal(typeof t.wireTriggerDelayMs,'number');
  const events=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(events,/wireSentAt/);
}));


test('零点前预检超时时用最近成功快照继续提交，不判死',()=>setup(async(s,e,site)=>{
  const t=s.add(input);await e.arm(t.id);
  site.failPreflight=true;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
  const events=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(events,/using-cached-snapshot/);
}));
test('零点前10秒预检失败只记真实原因并等待重试，不直接判死',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-9_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;
  await e.arm(t.id);site.failPreflight=true;
  const first=await e.precheck(t.id,2);
  assert.equal(first,false);assert.equal(t.status,'scheduled');assert.match(t.message,/稍后自动重试/);
  assert.deepEqual(site.preflightTimeouts.slice(-1),[2500],'阶段2预检必须使用短超时');
  site.failPreflight=false;
  assert.equal(await e.precheck(t.id,2),true);assert.equal(t.status,'scheduled');
}));
test('没有可用快照且预检失败时，失败原因写入任务而不是通用文案',()=>setup(async(s,e,site)=>{
  const t=s.add(input);await e.arm(t.id);
  e.cached!.sampledAt=now-11*60_000;site.failPreflight=true;
  await e.execute(t.id);
  assert.equal(t.status,'failed');assert.equal(site.attempts.length,0);
  assert.match(t.message,/预约预检未通过（request timeout）/);
}));

test('零点降级执行时占用查询最多300毫秒，不把零点提交推后2秒',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let wall=t.releaseAt+5,mono=1000,firstList=true;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;
  await e.arm(t.id);e.cached!.sampledAt=wall;
  site.failPreflight=true;
  const listTimeouts:(number|undefined)[]=[];
  site.list=async(_date,timeout)=>{listTimeouts.push(timeout);if(firstList){firstList=false;const ms=timeout??8000;wall+=ms;mono+=ms;return [];}return site.records;};
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  const submits:number[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(task,r)=>{submits.push(wall);return originalSubmit(task,r);};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
  assert.equal(listTimeouts[0],300,'零点降级查询必须使用300毫秒上限');
  assert.ok(submits[0]-t.releaseAt<=350,`首次提交被降级查询推后 ${submits[0]-t.releaseAt} 毫秒`);
}));
test('放号后迟到启用的任务先完整预检，按占用直接避开冲突场地',()=>setup(async(s,e,site)=>{
  const t=s.add(input);
  site.records=[{id:'other',ownerId:'other',roomId:COURTS['1'].id,beginTime:`${t.date} 19:00:00`,endTime:`${t.date} 21:00:00`,status:'OPEN'}];
  const listTimeouts:(number|undefined)[]=[];const originalList=site.list.bind(site);
  site.list=async(date,timeout)=>{listTimeouts.push(timeout);return originalList(date,timeout);};
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records.push(booking(sent,r));};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.deepEqual(site.attempts,[COURTS['2'].id]);
  assert.notEqual(listTimeouts[0],300,'迟到任务的首个占用查询不应使用300毫秒降级上限');
}));test('到点后预检仍失败也立即用最近快照提交，不被预检重试拖住',()=>setup(async(s,e,site)=>{
  const t=s.add(input);await e.arm(t.id);
  site.failPreflight=true;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  (e as unknown as {stopped:boolean}).stopped=false;
  await (e as unknown as {tick:()=>Promise<void>}).tick();
  e.stop();
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
}));

test('预检耗时跨过触发点后同一轮立即执行，不再多等一次调度',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-300_000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;await e.arm(t.id);await e.prepare(t.id);
  wall=t.releaseAt-1000;mono+=299_000;
  site.preflight=async()=>{wall+=2500;mono+=2500;throw Error('request timeout');};
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  (e as unknown as {stopped:boolean}).stopped=false;
  try{await (e as unknown as {tick:()=>Promise<void>}).tick();}finally{e.stop();}
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);assert.equal(t.localTriggerDelayMs,1500);
}));

test('临近触发点时预检各步骤共用剩余预算，查询不能再独占2.5秒',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-1000,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;await e.arm(t.id);
  const calls:{step:string;budget:number|undefined}[]=[];
  site.preflight=async timeout=>{calls.push({step:'settings',budget:timeout});wall+=600;mono+=600;return structuredClone(site.snapshot);};
  site.list=async(_date,timeout)=>{calls.push({step:'list',budget:timeout});wall+=timeout??8000;mono+=timeout??8000;throw Error('read timeout');};
  assert.equal(await e.precheck(t.id,2),false);
  assert.ok(calls[0].budget!<=1000&&calls[0].budget!>600);
  assert.ok(calls[1].budget!>0&&calls[1].budget!<=400);
  assert.ok(wall<=t.releaseAt,'预检不能耗尽零点后的提交时间');assert.equal(t.status,'scheduled');assert.equal(site.attempts.length,0);
}));

test('触发点将至时不再启动预检请求，保留时间给调度',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-10,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;await e.arm(t.id);
  let reads=0;site.preflight=async()=>{reads++;throw Error('must not start');};
  assert.equal(await e.precheck(t.id,2),false);assert.equal(reads,0);assert.equal(t.status,'scheduled');
}));

test('占用查询在预算末尾成功时保留结果，跳过校时而不重新查询',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-1000,mono=1000,lists=0;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;await e.arm(t.id);
  site.preflight=async()=>{wall+=600;mono+=600;return structuredClone(site.snapshot);};
  site.list=async(_date,timeout)=>{lists++;if(lists===1){wall+=timeout??0;mono+=timeout??0;}return site.records;};
  site.refineClock=async()=>{throw Error('时间不足不应校时');};
  assert.equal(await e.precheck(t.id,2),true,'已完成的有效查询结果不能因校时预算耗尽而丢弃');
  wall=t.releaseAt+100;mono=2100;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);assert.equal(t.status,'succeeded');assert.equal(lists,2,'一次预检查询、一次提交后核对');
}));

test('零点前11秒首次调度时阶段1也受截止限制，失败后仍保留执行机会',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt-11_000,mono=1000,lists=0;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;await e.arm(t.id);
  site.preflight=async timeout=>{const elapsed=Math.min(timeout??8000,8000);wall+=elapsed;mono+=elapsed;return structuredClone(site.snapshot);};
  site.list=async(_date,timeout)=>{if(++lists===1){const elapsed=Math.min(timeout??8000,8000);wall+=elapsed;mono+=elapsed;if(elapsed<8000)throw Error('read timeout');}return site.records;};
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  (e as unknown as {stopped:boolean}).stopped=false;
  try{await (e as unknown as {tick:()=>Promise<void>}).tick();}finally{e.stop();}
  assert.ok(wall<=t.releaseAt,'阶段1也不能等待到零点以后');assert.equal(t.status,'scheduled');assert.equal(site.attempts.length,0);
  mono+=t.releaseAt+100-wall;wall=t.releaseAt+100;
  (e as unknown as {stopped:boolean}).stopped=false;
  try{await (e as unknown as {tick:()=>Promise<void>}).tick();}finally{e.stop();}
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
}));






test('首发触发点约为服务器点估计的开放后15毫秒，不再叠加校时误差',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,date:'2026-10-22'});let wall=t.releaseAt+50,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.serverOffsetMs=-40;site.snapshot.serverUncertaintyMs=57;
  await e.arm(t.id);await e.execute(t.id);assert.equal(site.attempts.length,0,'服务器点估计未过开放后15毫秒不得提交');
  wall=t.releaseAt+56;mono+=6;site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,1);
  assert.equal(t.triggerDelayMs,16,'服务器时间相对开放时刻约16毫秒');
}));
test('零点首个临时错误不查询占用，按最小间隔原目标快速重试',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let wall=t.releaseAt+5,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;
  await e.arm(t.id);
  const listTimeouts:(number|undefined)[]=[];
  site.list=async(_d,timeout)=>{listTimeouts.push(timeout);return site.records;};
  site.results=[{kind:'transient'},{kind:'conflict',conflictInterval:{date:t.date,start:'19:00',end:'19:30'}},{kind:'created'}];
  const submits:{room:string;start:string}[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(task,r)=>{submits.push({room:r,start:task.start});return originalSubmit(task,r);};
  site.afterSubmit=(sent,r)=>{if(r===COURTS['2'].id)site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,3);
  assert.deepEqual(submits.slice(0,2).map(x=>x.room),[COURTS['1'].id,COURTS['1'].id],'首个临时错误后原目标重试');
  assert.equal(submits[2].room,COURTS['2'].id,'冲突提示后用缓存换到备用场地');
  assert.equal(listTimeouts.length,2,'仅在初始降级查询与提交后核对时查询，重试热路径不查询');
}));
test('零点第二次临时错误后的占用刷新限时150毫秒，超时用缓存继续',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let wall=t.releaseAt+5,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;
  await e.arm(t.id);
  const timeouts:(number|undefined)[]=[];
  site.list=async(_d,timeout)=>{timeouts.push(timeout);if(site.records.length)return site.records;const ms=timeout??8000;wall+=ms;mono+=ms;throw Error('slow');};
  site.results=[{kind:'transient'},{kind:'transient'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(site.attempts.length===3)site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(timeouts[0],300,'初始降级查询仍用300毫秒');
  assert.equal(timeouts[1],150,'第二次临时错误后的刷新必须限时150毫秒');
  assert.equal(t.status,'succeeded');assert.equal(site.attempts.length,3);
  const ev=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(ev,/refresh-timeout-zero/);
}));
test('零点首个临时错误后立即重试，不再叠加100毫秒等待（仍受100毫秒下限）',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let clock=t.releaseAt+5;
  e.clock.now=()=>clock;e.clock.monotonic=()=>clock;e.clock.sleep=async ms=>{clock+=ms;};
  site.snapshot.sampledAt=clock;
  await e.arm(t.id);
  const submits:number[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(task,r)=>{submits.push(clock);const result=await originalSubmit(task,r);clock+=50;return result;};
  site.results=[{kind:'transient'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(site.attempts.length===2)site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(submits.length,2);
  const gap=submits[1]-submits[0];
  assert.ok(gap>=100,`两次提交至少间隔100毫秒：${gap}`);
  assert.ok(gap<=300,`零点首个临时错误后不应再额外等待100毫秒：${gap}`);
}));
test('零点连续临时错误按100毫秒下限密集重试，刷新限时150毫秒',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let clock=t.releaseAt+5;
  e.clock.now=()=>clock;e.clock.monotonic=()=>clock;e.clock.sleep=async ms=>{clock+=ms;};
  site.snapshot.sampledAt=clock;
  await e.arm(t.id);
  const submits:number[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(task,r)=>{submits.push(clock);return originalSubmit(task,r);};
  site.results=[{kind:'transient'},{kind:'transient'},{kind:'transient'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(site.attempts.length===4)site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(submits.length,4);
  assert.ok(submits[1]-submits[0]>=100,'第二刀仍受100毫秒下限');
  assert.ok(submits[2]-submits[1]<=400,`零点第3刀应在约300毫秒后：${submits[2]-submits[1]}`);
  assert.ok(submits[3]-submits[2]<=400,`零点第4刀应在约300毫秒后：${submits[3]-submits[2]}`);
  assert.ok(site.listTimeouts.includes(150),'零点临时错误后的刷新必须限时150毫秒');
}));
test('非零点临时错误仍保持原有退避节奏',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let clock=t.releaseAt+60_000;
  e.clock.now=()=>clock;e.clock.monotonic=()=>clock;e.clock.sleep=async ms=>{clock+=ms;};
  site.snapshot.sampledAt=clock;
  await e.arm(t.id);
  const submits:number[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(task,r)=>{submits.push(clock);return originalSubmit(task,r);};
  site.results=[{kind:'transient'},{kind:'transient'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(site.attempts.length===3)site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.equal(submits.length,3);
  assert.ok(submits[2]-submits[1]>=550,`非零点第二次临时错误后仍按600毫秒退避：${submits[2]-submits[1]}`);
}));
test('零点冲突刷新超时仍用冲突提示换到剩余时段',()=>setup(async(s,e,site)=>{
  const t=s.add(input);let wall=t.releaseAt+5,mono=1000;
  e.clock.now=()=>wall;e.clock.monotonic=()=>mono;site.snapshot.sampledAt=wall;
  await e.arm(t.id);
  const timeouts:(number|undefined)[]=[];
  site.list=async(_d,timeout)=>{timeouts.push(timeout);if(site.records.length)return site.records;const ms=timeout??8000;wall+=ms;mono+=ms;throw Error('slow');};
  site.results=[{kind:'conflict',conflictInterval:{date:t.date,start:'19:00',end:'19:30'}},
    {kind:'conflict',conflictInterval:{date:t.date,start:'19:30',end:'21:00'}},
    {kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(site.attempts.length===3)site.records=[booking(sent,r)];};
  await e.execute(t.id);
  assert.equal(t.status,'partial');assert.equal(site.attempts.length,3);
  assert.equal(t.receipts?.[0].begin,`${t.date} 19:30:00`);
  const ev=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(ev,/refresh-timeout-zero/);
}));
test('过早提交的日期上限拒绝会记录重试事件',()=>setup(async(s,e,site)=>{
  const t=s.add(input);site.results=[{kind:'not-open'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{site.records=[booking(sent,r)];};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');
  const ev=await readFile(join(s.directory,'events.ndjson'),'utf8');assert.match(ev,/retry-after-not-open/);
}));


test('1.2.21首波并发：时段不重叠的两条任务同时发出首刀，不等待彼此响应',()=>setup(async(s,e,site)=>{
  const a=s.add({...input,start:'19:00',end:'19:30',courtPriority:['1']});
  const b=s.add({...input,start:'19:30',end:'20:00',courtPriority:['1']});
  await e.arm(a.id);await e.arm(b.id);
  const sent:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  site.submit=async(t,r)=>{sent.push(r);await gate;site.records.push({...booking(t,r),id:'b-'+t.id});return {kind:'created'};};
  const run=e.executeTasks([a.id,b.id]);
  await new Promise<void>(r=>setImmediate(r));
  assert.equal(sent.length,2,'两条任务的首刀都应在任何响应返回前发出');
  release();await run;
  assert.equal(a.status,'succeeded');assert.equal(b.status,'succeeded');
}));
test('1.2.21首波并发只放行时段不重叠的任务：同时段两块场地仍串行',()=>setup(async(s,e,site)=>{
  const a=s.add({...input,start:'19:00',end:'20:00',courtPriority:['1']});
  const b=s.add({...input,start:'19:00',end:'20:00',courtPriority:['2']});
  await e.arm(a.id);await e.arm(b.id);
  const sent:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  site.submit=async(t,r)=>{sent.push(r);await gate;site.records.push({...booking(t,r),id:'b-'+t.id});return {kind:'created'};};
  const run=e.executeTasks([a.id,b.id]);
  await new Promise<void>(r=>setImmediate(r));
  assert.equal(sent.length,1,'时段重叠时第二条必须等第一条响应');
  release();await run;
  assert.equal(sent.length,2);
  assert.deepEqual(sent.slice(0,2),[COURTS['1'].id,COURTS['2'].id]);
  assert.equal(a.status,'succeeded');assert.equal(b.status,'succeeded');
}));
test('不同场地的重叠任务可分别启用，同轮交错首发且共用预检',()=>setup(async(s,e,site)=>{
  const a=s.add({...input,courtPriority:['1']});
  const b=s.add({...input,end:'21:00',courtPriority:['2']});
  await e.arm(a.id);await e.arm(b.id);
  assert.match(b.message,/同时段/);
  site.preflightTimeouts.length=0;site.listTimeouts.length=0;
  site.results=[{kind:'created'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{site.records.push(booking(sent,r));};
  const sends:{room:string;at:number}[]=[];const originalSubmit=site.submit.bind(site);
  site.submit=async(task,r)=>{sends.push({room:r,at:e.clock.monotonic()});return originalSubmit(task,r);};
  await e.executeTasks([a.id,b.id]);
  assert.equal(a.status,'succeeded');assert.equal(b.status,'succeeded');
  assert.deepEqual(site.attempts,[COURTS['1'].id,COURTS['2'].id]);
  assert.ok(sends[1].at-sends[0].at>=100,'两条任务的首刀至少间隔100毫秒');
  assert.equal(site.preflightTimeouts.length,1,'同一轮两条任务共用一次预检');
  assert.equal(site.listTimeouts.length,3,'共用预检占用1次，两条任务各自核对1次');
}));

test('同场地重叠任务仍被拒绝，单场地与任一场地备选任务也不得重叠',()=>setup(async(s,e)=>{
  const a=s.add({...input,courtPriority:['1']});
  const b=s.add({...input,courtPriority:['1']});
  await e.arm(a.id);await assert.rejects(e.arm(b.id),/重叠/);
  const c=s.add({...input,start:'19:30',end:'20:30',courtPriority:['1','2']});
  await assert.rejects(e.arm(c.id),/重叠/);
}));

test('本人另一块场地的重叠预约不阻止本任务提交（多场地同时预约）',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,courtPriority:['2']});
  site.records=[{...booking(t,COURTS['1'].id),id:'own-court1',beginTime:`${t.date} 19:00:00`,endTime:`${t.date} 20:30:00`}];
  site.results=[{kind:'created'}];site.afterSubmit=(sent,r)=>{site.records.push(booking(sent,r));};
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'succeeded');assert.deepEqual(site.attempts,[COURTS['2'].id]);
}));

test('本人目标场地已有重叠预约仍然停止',()=>setup(async(s,e,site)=>{
  const t=s.add({...input,courtPriority:['2']});
  site.records=[{...booking(t,COURTS['2'].id),id:'own-court2',beginTime:`${t.date} 18:30:00`,endTime:`${t.date} 19:30:00`}];
  await e.arm(t.id);await e.execute(t.id);
  assert.equal(t.status,'failed');assert.equal(site.attempts.length,0);assert.match(t.message,/重叠/);
}));

test('交错首发：第二条任务的首刀早于第一条的冲突重试',()=>setup(async(s,e,site)=>{
  const a=s.add({...input,end:'20:30',courtPriority:['1']});
  const b=s.add({...input,end:'21:00',courtPriority:['2']});
  await e.arm(a.id);await e.arm(b.id);
  site.results=[{kind:'conflict',conflictInterval:{date:a.date,start:'19:00',end:'19:30'}},{kind:'created'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{site.records.push(booking(sent,r));};
  await e.executeTasks([a.id,b.id]);
  assert.deepEqual(site.attempts,[COURTS['1'].id,COURTS['2'].id,COURTS['1'].id]);
  assert.equal(a.status,'partial');assert.equal(b.status,'succeeded');
  assert.equal(a.receipts?.[0].begin,`${a.date} 19:30:00`);
}));

test('一条任务结果不明冻结后，同批次另一块场地仍提交成功，账号仍暂停后续任务',()=>setup(async(s,e,site)=>{
  const a=s.add({...input,end:'20:30',courtPriority:['1']});
  const b=s.add({...input,end:'21:00',courtPriority:['2']});
  await e.arm(a.id);await e.arm(b.id);
  site.results=[{kind:'unknown'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{if(r===COURTS['2'].id)site.records.push(booking(sent,r));};
  await e.executeTasks([a.id,b.id]);
  assert.equal(a.status,'unknown');assert.equal(b.status,'succeeded');
  assert.equal(s.state.freeze?.taskId,a.id);
  const c=s.add({...input,start:'22:00',end:'23:00',courtPriority:['1']});
  await assert.rejects(e.arm(c.id),/暂停|冻结/);
}));

test('两条任务同时结果不明时逐条核对，全部核对后才解除暂停',()=>setup(async(s,e,site)=>{
  const a=s.add({...input,end:'20:30',courtPriority:['1']});
  const b=s.add({...input,end:'21:00',courtPriority:['2']});
  await e.arm(a.id);await e.arm(b.id);
  site.results=[{kind:'unknown'},{kind:'unknown'}];
  await e.executeTasks([a.id,b.id]);
  assert.equal(a.status,'unknown');assert.equal(b.status,'unknown');assert.equal(s.state.freeze?.taskId,a.id);
  const c=s.add({...input,start:'22:00',end:'23:00',courtPriority:['1']});
  await assert.rejects(e.arm(c.id),/暂停|冻结/);
  e.confirmManual(a.id,'我已在网站核对该次请求的结果，停止该任务并恢复后续任务');
  assert.equal(a.status,'cancelled');assert.equal(s.state.freeze?.taskId,b.id);
  await assert.rejects(e.arm(c.id),/暂停|冻结/);
  e.confirmManual(b.id,'我已在网站核对该次请求的结果，停止该任务并恢复后续任务');
  assert.equal(b.status,'cancelled');assert.equal(s.state.freeze,undefined);
  await e.arm(c.id);assert.equal(c.status,'scheduled');
}));

test('两条同轮到点任务在同一次 tick 内依次提交',()=>setup(async(s,e,site)=>{
  const a=s.add({date:'2026-10-20',start:'22:00',end:'23:00',mode:'live',courtPriority:['1']});
  const b=s.add({date:'2026-10-20',start:'22:00',end:'23:00',mode:'live',courtPriority:['2']});
  await e.arm(a.id);await e.arm(b.id);
  site.preflightTimeouts.length=0;
  site.results=[{kind:'created'},{kind:'created'}];
  site.afterSubmit=(sent,r)=>{site.records.push(booking(sent,r));};
  const originalSubmit=site.submit.bind(site);const rooms:string[]=[];
  site.submit=async(task,r)=>{rooms.push(r);return originalSubmit(task,r);};
  (e as unknown as {stopped:boolean}).stopped=false;
  try{await (e as unknown as {tick:()=>Promise<void>}).tick();}finally{e.stop();}
  assert.deepEqual(rooms,[COURTS['1'].id,COURTS['2'].id]);
  assert.equal(a.status,'succeeded');assert.equal(b.status,'succeeded');
  assert.equal(site.preflightTimeouts.length,1,'同轮任务共用预检');
}));

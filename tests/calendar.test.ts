import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Engine} from '../src/engine.ts';
import {createApp} from '../src/server.ts';
import {COURTS,calendarBookings,validateCalendarRange,validateTask} from '../src/domain.ts';
import type {Snapshot,Booking} from '../src/domain.ts';
const snapshot:Snapshot={accountId:'me',accountName:'日历测试账号',corpId:'corp',settingsHash:'h',rules:{startHour:10,endHour:23,meetingInterval:30,maxDuration:120,bookingLimitDays:2},rooms:Object.values(COURTS).map(c=>({...c,canBooking:true,disabled:false})),serverOffsetMs:0,sampledAt:Date.now(),submissionReady:true,submissionReason:'fixture'};
const record:Booking={id:'active',ownerId:'me',roomId:COURTS['2'].id,beginTime:'2026-10-19 22:30:00',endTime:'2026-10-19 23:00:00',status:'OPEN',subject:'1'};
test('日历只显示本人有效场地记录，显示实际半小时并去重',()=>{
  const bookings=calendarBookings([record,record,{...record,id:'cancelled',status:'CANCELLED'},{...record,id:'other',ownerId:'someone'},{...record,id:'different-room',roomId:'elsewhere'},{...record,id:'invalid',endTime:'invalid'}],'me','2026-10-01','2026-10-31');
  assert.deepEqual(bookings,[{id:'active',court:'2',date:'2026-10-19',start:'22:30',end:'23:00',subject:'1'}]);
  assert.equal(calendarBookings([record],'me','2026-11-01','2026-11-30').length,0);
});
test('日历查询限制有效日期和至多42天，支持跨年',()=>{
  assert.doesNotThrow(()=>validateCalendarRange('2026-12-28','2027-02-07'));
  for(const [start,end] of [['2026-02-30','2026-03-01'],['2026-10-31','2026-10-01'],['2026-10-01','2026-12-01'],['bad','2026-10-31']])assert.throws(()=>validateCalendarRange(start,end));
});
test('刷新日历读取网站当前记录，取消后消失，不修改历史任务或提交预约',async()=>{
  const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'calendar-'));
  const store=await Store.open(dir),history=store.add({date:'2026-10-19',start:'22:00',end:'23:00',mode:'live'});history.status='partial';store.save();
  let records=[record],writes=0,fail=false;const ranges:any[]=[];
  const site={preflight:async()=>structuredClone(snapshot),list:async()=>records,listRange:async(start:string,end:string)=>{ranges.push([start,end]);if(fail)throw Error('网站查询失败');return records;},submit:async()=>{writes++;throw Error('禁止提交');},rehearse:async()=>{throw Error('禁止演练');}};
  const {server}=createApp(store,site);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const state=await (await fetch(url+'/api/state')).json() as any;
    const body=JSON.stringify({start:'2026-10-01',end:'2026-10-31'}),headers={'content-type':'application/json','x-local-token':state.localToken};
    assert.equal((await fetch(url+'/api/calendar',{method:'POST',headers:{'content-type':'application/json'},body})).status,403);
    const read=async()=>fetch(url+'/api/calendar',{method:'POST',headers,body});
    const first=await (await read()).json() as any;assert.equal(first.bookings.length,1);assert.equal(first.bookings[0].start,'22:30');
    records=[{...record,status:'CANCELLED'}];assert.equal(((await (await read()).json()) as any).bookings.length,0);
    records=[];assert.equal(((await (await read()).json()) as any).bookings.length,0);
    fail=true;const failed=await read();assert.equal(failed.status,400);assert.match((await failed.json() as any).error,/查询失败/);
    assert.deepEqual(ranges[0],['2026-10-01','2026-10-31']);assert.equal(writes,0);assert.equal(history.status,'partial');assert.equal(store.state.tasks.length,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('临近执行的任务优先，日历查询不占用抢约时间',async()=>{
  const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'calendar-priority-'));
  try{
    const store=await Store.open(dir),task=store.add({date:'2026-10-19',start:'22:00',end:'23:00',mode:'live'});task.status='scheduled';
    const engine=new Engine(store,{preflight:async()=>{throw Error('不应查询');},list:async()=>[],submit:async()=>{throw Error('不应提交');},rehearse:async()=>{throw Error('不应演练');}},{now:()=>task.releaseAt-120000});
    await assert.rejects(engine.calendar('2026-10-01','2026-10-31'),/临近|正在/);assert.equal(engine.busy,false);assert.equal(task.status,'scheduled');
  }finally{await rm(dir,{recursive:true,force:true});}
});

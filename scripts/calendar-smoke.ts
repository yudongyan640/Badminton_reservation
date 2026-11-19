import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {createApp} from '../src/server.ts';
import {COURTS,chinaDate} from '../src/domain.ts';
import type {Snapshot,Booking} from '../src/domain.ts';
const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'calendar-ui-'));
const current=chinaDate(),tomorrow=chinaDate(Date.now()+86400000),date=tomorrow.slice(0,7)===current.slice(0,7)?tomorrow:current;
const snapshot:Snapshot={accountId:'fixture-me',accountName:'日历演示账号',corpId:'fixture',settingsHash:'fixture',rules:{startHour:10,endHour:23,meetingInterval:30,maxDuration:120,bookingLimitDays:2},rooms:Object.values(COURTS).map(c=>({...c,canBooking:true,disabled:false})),serverOffsetMs:0,sampledAt:Date.now(),submissionReady:true,submissionReason:'仅本地界面测试'};
let records:Booking[]=[{id:'current-fixture-booking',ownerId:snapshot.accountId,roomId:COURTS['2'].id,beginTime:date+' 22:30:00',endTime:date+' 23:00:00',status:'OPEN',subject:'1'}],fail=false,writes=0;
const ranges:string[][]=[];
const site={preflight:async()=>structuredClone(snapshot),list:async()=>records,listRange:async(start:string,end:string)=>{ranges.push([start,end]);if(fail)throw Error('本地模拟网络断开');return records;},submit:async()=>{writes++;throw Error('禁止提交');},rehearse:async()=>{throw Error('禁止演练');}};
const store=await Store.open(dir),task=store.add({date,start:'22:00',end:'23:00',mode:'live',subject:'1'});task.status='partial';task.message='演示历史记录，不代表当前有效预约';task.receipt={id:'cancelled-old-fixture',court:COURTS['2'].name,begin:date+' 22:30:00',end:date+' 23:00:00'};store.save();
const {server}=createApp(store,site);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  await page.locator('.calendar-booking').waitFor();assert.equal(await page.locator('.calendar-booking').count(),1);
  assert.match(await page.locator('.calendar-booking').innerText(),/22:30–23:00/);assert.match(await page.locator('.calendar-booking').innerText(),/场地2/);
  assert.equal(await page.locator('.calendar-booking[data-booking-id="cancelled-old-fixture"]').count(),0);
  await page.screenshot({path:join(base,'calendar-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(base,'calendar-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1100});
  records=[{...records[0],status:'CANCELLED'}];await page.getByRole('button',{name:'刷新预约',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#calendar-next')?.textContent==='本月暂无有效预约。');assert.equal(await page.locator('.calendar-booking').count(),0);assert.equal(await page.locator('.task').count(),1);
  fail=true;await page.getByRole('button',{name:'刷新预约',exact:true}).click();await page.locator('#calendar-next.error').waitFor();
  assert.match(await page.locator('#calendar-next').innerText(),/未能同步/);assert.equal(await page.locator('.calendar-booking').count(),0);
  fail=false;records=[];
  const moves=13-Number(current.slice(5,7));
  for(let i=0;i<moves;i++){
    const done=page.waitForResponse(r=>r.url().endsWith('/api/calendar'));await page.getByRole('button',{name:'下个月',exact:true}).click();await done;
    await page.waitForFunction(()=>document.querySelector('#calendar-refresh') instanceof HTMLButtonElement&&!(document.querySelector('#calendar-refresh') as HTMLButtonElement).disabled);
  }
  const nextYear=Number(current.slice(0,4))+1;assert.deepEqual(ranges.at(-1),[`${nextYear}-01-01`,`${nextYear}-01-31`]);
  assert.equal(writes,0);assert.deepEqual(errors,[]);
  const report={checkedAt:new Date().toISOString(),actualHalfHourVisible:true,cancellationRefresh:true,historySeparate:true,networkFailureNotEmptySuccess:true,crossYearNavigation:true,mobileNoOverflow:true,realBookingWrites:writes,pageErrors:errors};
  await writeFile(join(base,'calendar-smoke-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}

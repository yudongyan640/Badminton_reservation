import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {BrowserSite} from '../src/browser.ts';
import {createApp} from '../src/server.ts';
import {ORIGIN,BOOKING_URL,COURTS,validateTask} from '../src/domain.ts';

const project=join(import.meta.dirname,'..'),base=join(project,'test-results');await mkdir(base,{recursive:true});
const dir=await mkdtemp(join(base,'smoke-'));const browser=await chromium.launch({channel:'msedge',headless:true});
const fake=await browser.newContext({serviceWorkers:'block'});let writesReachedBoundary=0;
const trace:string[]=[];
fake.on('request',r=>trace.push(r.method()+' '+new URL(r.url()).pathname));
fake.on('page',p=>{p.on('pageerror',e=>trace.push('PAGE_ERROR '+e.message));p.on('console',m=>{if(m.type()==='error')trace.push('CONSOLE '+m.text().slice(0,200));});});
const fixture={meetingTimes:{startHour:10,endHour:23,meetingInterval:30,maxDuration:120,bookingLimitDays:2},meetingRooms:{currentMeetingRooms:Object.values(COURTS).map(c=>({...c,canBooking:true,disabled:false}))}};
const html=`<!doctype html><html><head><meta charset="utf-8"><title>预约表单测试夹具</title></head><body><form><input id="subject"><button type="submit">预订会议室</button></form><script>
var loginUser={id:'fixture-me',name:'演练测试账号',corp:{id:'fixture-corp'}};var sessionId='fixture-session';var platform='WEBAPP';document.cookie='authenticityToken=fixture-token;path=/';
document.querySelector('form').onsubmit=function(e){e.preventDefault();var q=new URLSearchParams(location.search),start=(q.get('startTime')||'19-00').replace('-',':'),end=(q.get('endTime')||'21-00').replace('-',':'),subject=document.querySelector('#subject').value,sender=window;if(subject.startsWith('popup')){var form=document.createElement('form');form.method='POST';form.action=location.origin+'/api/v2.0/meetings';form.target='_blank';var x=document.createElement('input');x.name='subject';x.value=subject;form.append(x);document.body.append(form);form.submit();return;}sender.fetch(location.origin+'/api/v2.0/meetings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({roomId:q.get('resourceId'),ownerId:'fixture-me',meetingDate:q.get('meetingDate'),startTime:start,duration:(Number(end.slice(0,2))*60+Number(end.slice(3)))-(Number(start.slice(0,2))*60+Number(start.slice(3))),subject:subject,meetingRepeatType:'NONE'})}).catch(function(){})};</script></body></html>`;
await fake.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(!['GET','HEAD','OPTIONS'].includes(r.method())){writesReachedBoundary++;await route.abort();return;}
  if(u.origin!==ORIGIN){await route.abort();return;}
  if(u.pathname==='/api/v2.0/settings')await route.fulfill({json:{success:true,code:0,timestamp:Date.now(),data:fixture}});
  else if(u.pathname==='/api/v2.0/meeting-rooms/day-meetings')await route.fulfill({json:{success:true,code:0,data:[]}});
  else await route.fulfill({contentType:'text/html',body:html});
});
const site=new BrowserSite(dir);site.context=fake;site.page=await fake.newPage();await site.page.goto(BOOKING_URL);
const store=await Store.open(dir),{server}=createApp(store,site);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`,ui=await browser.newContext({viewport:{width:1440,height:1080}}),page=await ui.newPage();
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(url);const checkResponse=page.waitForResponse(r=>r.url().endsWith('/api/check'));
  await page.getByRole('button',{name:'检查登录',exact:true}).click();
  const checked=await checkResponse;assert.equal(checked.ok(),true,await checked.text());
  await page.waitForFunction(()=>document.querySelector('#login-status')?.textContent?.includes('演练测试账号'));
  const settingsBefore=trace.filter(t=>t==='GET /api/v2.0/settings').length;
  await site.page!.evaluate(()=>{const w=window as any,saved=w.loginUser;w.loginUser=undefined;setTimeout(()=>{w.loginUser=saved;},150);});
  await assert.rejects(site.preflight(40),/扫码|截止|超时|Timeout/,'短预检必须将页面就绪等待计入总预算');
  assert.equal(trace.filter(t=>t==='GET /api/v2.0/settings').length,settingsBefore,'预算耗尽后不得再启动设置请求');
  await site.page!.waitForFunction(()=>!!(window as any).loginUser?.id);
  await fake.clearCookies({name:'authenticityToken'});
  const noCsrf=await site.preflight();assert.equal(noCsrf.accountId,'fixture-me','已登录而无可选Cookie时仍应读取场馆设置');
  await site.page!.evaluate(()=>{(window as any).sessionId='';});
  const noSession=await site.preflight();assert.equal(noSession.accountId,'fixture-me','网页sessionId为空时仍由网站验证Cookie会话');
  assert.deepEqual(await site.listRange('2026-12-01','2026-12-31'),[]);
  const expiredGuard=async(route:any)=>{await route.fulfill({status:401,json:{success:false,code:401}});};
  await fake.route('**/api/v2.0/settings**',expiredGuard);
  try{await assert.rejects(site.preflight(),/网站未接受当前登录会话.*401/);}
  finally{await fake.unroute('**/api/v2.0/settings**',expiredGuard);}
  await page.locator('#date').fill('2026-12-31');await page.locator('#subject').fill('羽毛球（演练示例）');
  await page.getByRole('button',{name:'保存任务',exact:true}).click();await page.locator('.task').waitFor();
  await page.getByRole('button',{name:'立即演练',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.task')?.getAttribute('data-status')==='rehearsed',{},{timeout:35_000});
  assert.equal(writesReachedBoundary,0,'预约POST不应到达外层网络边界');assert.equal(store.state.tasks[0].status,'rehearsed');
  assert.equal(await page.locator('#live-mode').isDisabled(),false);assert.deepEqual(errors,[]);
  const popupTask=validateTask({date:'2026-12-31',start:'19:00',end:'21:00',subject:'popup拦截演练'});
  const beforePopup=trace.filter(t=>t==='POST /api/v2.0/meetings').length;
  await assert.rejects(site.rehearse(popupTask,COURTS['1'].id),/字段与任务不一致/);
  assert.equal(trace.filter(t=>t==='POST /api/v2.0/meetings').length,beforePopup+1);assert.equal(writesReachedBoundary,0);
  await site.preflight();await fake.clearCookies({name:'authenticityToken'});
  await site.page!.evaluate(()=>{delete (window as any).platform;});
  let adapterRequests=0;
  const submissionGuard=async(route:any)=>{
    adapterRequests++;const headers=await route.request().allHeaders();
    assert.equal(headers['x-hys-platform'],'webapp');assert.equal(headers['x-authenticity-token'],'undefined');
    assert.equal(headers['x-hys-session'],'','空sessionId不伪造凭据，仍沿用网页请求头');
    assert.equal(headers['content-type'],'application/json;charset=UTF-8');
    const form=JSON.parse(await readFile(join(dir,'form-check.json'),'utf8'));
    assert.deepEqual(route.request().postDataJSON(),form.requestTemplate);
    await route.fulfill({json:{success:false,code:400,warnMessage:'本地模拟的业务拒绝'}});
  };
  await fake.route('**/api/v2.0/meetings',submissionGuard);
  const guarded=validateTask({date:'2026-12-31',start:'19:00',end:'21:00',subject:'羽毛球（演练示例）',mode:'live'});guarded.accountId='fixture-me';
  const rejected=await site.submit(guarded,COURTS['1'].id);
  assert.equal(rejected.kind,'unknown');assert.equal(rejected.diagnostic?.businessCode,400);assert.equal(adapterRequests,1);
  await fake.unroute('**/api/v2.0/meetings',submissionGuard);
  const current=await site.preflight();
  await writeFile(join(dir,'site-verification.json'),JSON.stringify({version:1,corpId:current.corpId,settingsHash:current.settingsHash,verifiedAt:new Date().toISOString(),evidenceSource:'本地夹具核对指定失败形态，不作为真实接口验证',noCreationErrors:[{httpStatus:200,code:200,kind:'conflict',noCreation:true,messageType:'room-conflict'}]}));
  await site.preflight();
  const conflictGuard=async(route:any)=>{await route.fulfill({json:{success:false,code:200,data:null,warnMessage:'您的会议与测试用户发起的会议2(2026-12-31 19:00~19:30)冲突，请另选时间或会议室'}});};
  await fake.route('**/api/v2.0/meetings',conflictGuard);
  const conflict=await site.submit(guarded,COURTS['1'].id);assert.equal(conflict.kind,'conflict');assert.deepEqual(conflict.conflictInterval,{date:guarded.date,start:'19:00',end:'19:30'});assert.equal(writesReachedBoundary,0);
  await fake.unroute('**/api/v2.0/meetings',conflictGuard);
  await site.preflight();await site.page!.evaluate(()=>{(window as any).loginUser.id='changed-account';});
  const probe=validateTask({date:'2026-12-31',start:'19:00',end:'21:00',mode:'live'});probe.accountId='fixture-me';
  const blocked=await site.submit(probe,COURTS['1'].id);assert.equal(blocked.kind,'rejected');assert.equal(writesReachedBoundary,0);
  await page.waitForFunction(()=>!document.querySelector('#clock')?.textContent?.includes('--'));
  await page.screenshot({path:join(project,'界面预览.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(base,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'移动端不应横向溢出');
  const report={checkedAt:new Date().toISOString(),ui:'passed',mobile:'passed',loggedInWithoutCsrfCookie:'passed',genuineAdapterRehearsal:'passed against local fixture',nativeHeaderAndPayloadParity:'passed against local fixture',serverErrorDiagnostic:'passed',boundConflictRule:'passed against local fixture',popupWriteGuard:'passed',accountChangeBlocked:'passed',intercepted:trace.filter(t=>t==='POST /api/v2.0/meetings').length,forwarded:writesReachedBoundary,actualSiteBookingCreated:false,pageErrors:errors};
  await writeFile(join(base,'smoke-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){
  await page.screenshot({path:join(base,'smoke-failure.png'),fullPage:true});
  console.error(JSON.stringify({trace:trace.slice(-20),writesReachedBoundary,login:await page.locator('#login-status').textContent(),toast:await page.locator('#toast').textContent(),notice:await page.locator('#notice').textContent(),tasks:store.state.tasks.map(t=>({status:t.status,message:t.message}))}));throw e;
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}

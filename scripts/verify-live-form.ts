import {chromium} from 'playwright';
import {BrowserSite} from '../src/browser.ts';
import {BOOKING_URL,COURTS,chinaDate,validateTask} from '../src/domain.ts';
import {resolve,join} from 'node:path';
const directory=resolve(process.argv[2]||join(import.meta.dirname,'../data'));
const context=await chromium.launchPersistentContext(join(directory,'edge-profile'),{channel:'msedge',headless:true,serviceWorkers:'block'});
const site=new BrowserSite(directory);site.context=context;site.page=context.pages()[0]||await context.newPage();
try{
  await site.page.goto(BOOKING_URL,{waitUntil:'domcontentloaded',timeout:30000});
  const s=await site.preflight();
  const task=validateTask({date:process.argv[3]||chinaDate(Date.now()+86400000),start:'22:00',end:'23:00',subject:'羽毛球表单验证（不提交）'});
  const r=await site.rehearse(task,COURTS['1'].id);const after=await site.preflight();
  console.log(JSON.stringify({date:task.date,intercepted:r.intercepted,forwarded:r.forwarded,fields:r.fields,submissionReady:after.submissionReady,bookingCreated:false},null,2));
}finally{await context.close();}

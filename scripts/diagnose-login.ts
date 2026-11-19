import {chromium} from 'playwright';
import {BrowserSite} from '../src/browser.ts';
import {BOOKING_URL,ORIGIN} from '../src/domain.ts';
import {resolve,join} from 'node:path';

const directory=resolve(process.argv[2]||join(import.meta.dirname,'../data'));
const context=await chromium.launchPersistentContext(join(directory,'edge-profile'),{channel:'msedge',headless:true,serviceWorkers:'block'});
try{
  const page=context.pages()[0]||await context.newPage();await page.goto(BOOKING_URL,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>!!(window as any).loginUser?.id,{},{timeout:10000}).catch(()=>{});
  const comparison=await page.evaluate(async()=>{
    const w=window as any;
    const names=document.cookie.split(';').map(s=>s.trim().split('=')[0]).filter(Boolean);
    const r=await fetch('/api/v2.0/settings?officeAreaId=all&roomType=ROOM&extraRoomId=',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    const b=await r.json().catch(()=>null);
    return {pagePath:location.pathname,hasSession:!!w.sessionId,hasAccount:!!w.loginUser?.id,cookieNames:names,plainRead:{httpStatus:r.status,success:b?.success,code:b?.code,hasMeetingTimes:!!b?.data?.meetingTimes}};
  });
  const site=new BrowserSite(directory);site.context=context;site.page=page;
  let adapter:{ok:boolean;message?:string};
  try{await site.preflight();adapter={ok:true};}catch(e){adapter={ok:false,message:(e as Error).message};}
  console.log(JSON.stringify({comparison,adapter,bookingWrites:0},null,2));
}finally{await context.close();}

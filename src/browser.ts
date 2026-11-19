import {chromium} from 'playwright';
import type {BrowserContext,Page,Route} from 'playwright';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {ORIGIN,BOOKING_URL,COURTS,apiOK,classifyResponse,buildPayload,duration,chinaDate,validateCalendarRange} from './domain.ts';
import type {Task,Snapshot,Booking,ApiResponse,AttemptResult} from './domain.ts';
import type {Site} from './engine.ts';

export interface ErrorRule {httpStatus:number;code:string|number;kind:'conflict'|'not-open'|'rejected'|'limited'|'transient';noCreation:true;messageType?:'room-conflict'|'allocation-error'|'date-limit';}
export function serverClockSample(r:ApiResponse):{offsetMs:number;uncertaintyMs:number}{
  const sent=r.clientSentAt,received=r.clientReceivedAt,elapsed=r.elapsedMs,stamp=r.body?.timestamp;
  if(typeof sent!=='number'||typeof received!=='number'||typeof elapsed!=='number'||typeof stamp!=='number'||![sent,received,elapsed,stamp].every(Number.isFinite)||received<sent||elapsed<0||elapsed>10000||Math.abs(received-sent-elapsed)>50||Math.abs(stamp-received)>86400000)throw Error('服务器校时未通过，电脑时钟可能发生调整，请重新检查登录');
  return {offsetMs:stamp-(sent+received)/2,uncertaintyMs:Math.ceil(Math.max(received-sent,elapsed)/2)+1};
}
// 多采样取往返最短的样本：它的误差上界最小，可以在不突破保守判定的前提下更早触发。
export function bestClockSample(samples:{offsetMs:number;uncertaintyMs:number}[]):{offsetMs:number;uncertaintyMs:number}{
  if(!samples.length)throw Error('没有可用的校时样本');
  return samples.reduce((best,s)=>s.uncertaintyMs<best.uncertaintyMs?s:best);
}
// 真实网页（2026-11-02 只读诊断）用 moment(settings.newMeeting.meetingDate).add(bookingLimitDays,'d').subtract(1,'m')
// 生成表单请求里的 fixedEndDate；基准日期来自服务器 settings，而不是本地“今天”。
// 服务器日期可能比北京零点提前切换（诊断中 2026-11-01 23:56 时 newMeeting.meetingDate 已是 2026-11-02），
// 用本地日期+1 会与网页请求相差一天，导致表单演练的参数一致性校验永远失败。
export function siteBookingLimitDate(newMeetingDate:unknown,bookingLimitDays:number,now:number,offsetMs:number):string{
  const base=typeof newMeetingDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(newMeetingDate)?Date.parse(`${newMeetingDate}T00:00:00+08:00`):NaN;
  return chinaDate((Number.isFinite(base)?base:now+offsetMs)+bookingLimitDays*86_400_000-60_000);
}
const readJSON=(path:string):any=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
function remainingTimeout(deadline:number|undefined,limit:number):number{
  if(deadline===undefined)return limit;
  const left=Math.floor(deadline-performance.now());
  if(left<=0)throw Error('放号前检查已到截止时间');
  return Math.min(limit,left);
}
export function isReadOnlyRequest(method:string,url:string):boolean{
  if(['GET','HEAD','OPTIONS'].includes(method))return true;
  const u=new URL(url);
  return method==='POST'&&u.origin===ORIGIN&&['/api/v2.0/meeting-schedulings/user-meetings','/api/v2.0/meeting-schedulings/check-conflicts'].includes(u.pathname);
}
export function checkEvidence(value:any,s:Snapshot):{valid:boolean;reason:string;rules:ErrorRule[]} {
  if(!value||value.version!==1||value.corpId!==s.corpId||value.settingsHash!==s.settingsHash||typeof value.evidenceSource!=='string'||value.evidenceSource.length<10||!Number.isFinite(Date.parse(value.verifiedAt)))
    return {valid:false,reason:'未配置已验证的安全重试错误码，未知结果将先核对再暂停',rules:[]};
  const rules:ErrorRule[]=Array.isArray(value.noCreationErrors)?value.noCreationErrors.filter((r:any)=>r&&r.noCreation===true&&[200,400,409,422,429].includes(r.httpStatus)&&['conflict','not-open','rejected','limited','transient'].includes(r.kind)&&['number','string'].includes(typeof r.code)&&(!(r.code===200||r.code==='200')||(r.kind==='conflict'&&r.messageType==='room-conflict')||(r.kind==='transient'&&r.messageType==='allocation-error')||(r.kind==='not-open'&&r.messageType==='date-limit'))):[];
  return {valid:true,reason:'已匹配当前规则的安全重试错误码证据',rules};
}
export function parseSettings(data:any,user:{id:string;name:string;corpId:string;asset:string},offset:number):Snapshot {
  const source=data?.meetingTimes,rooms=data?.meetingRooms?.currentMeetingRooms;
  if(!source||!Array.isArray(rooms)||!user.id||!user.corpId)throw Error('未能读取登录信息或场地规则');
  const rules={startHour:source.startHour,endHour:source.endHour,meetingInterval:source.meetingInterval,maxDuration:source.maxDuration,bookingLimitDays:source.bookingLimitDays};
  if(Object.values(rules).some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('场地规则格式已变化');
  const selected=rooms.map((r:any)=>({id:r.id,name:r.name,canBooking:r.canBooking===true,disabled:r.disabled===true}));
  return {accountId:user.id,accountName:user.name,corpId:user.corpId,rules,rooms:selected,
    settingsHash:createHash('sha256').update(JSON.stringify({corp:user.corpId,rules,rooms:selected,asset:user.asset})).digest('hex'),
    serverOffsetMs:offset,sampledAt:Date.now(),bookingLimitDate:siteBookingLimitDate(data?.newMeeting?.meetingDate,rules.bookingLimitDays,Date.now(),offset),
    submissionReady:false,submissionReason:'请先完成一次真实网页表单演练（不提交）'};
}
export function formAllowsSubmission(form:any,s:Snapshot):boolean{
  return !!form&&form.version===3&&form.payloadMatched===true&&form.settingsHash===s.settingsHash&&form.accountId===s.accountId&&form.forwarded===0&&form.matched===true&&!!form.requestTemplate&&typeof form.requestTemplate==='object';
}
export function interpretSubmission(r:ApiResponse,rules:ErrorRule[],task?:Task):AttemptResult {
  const sanitize=(value:unknown):string|undefined=>{
    if(typeof value!=='string')return undefined;
    if(/session|token|authorization|cookie|bearer/i.test(value))return '服务返回信息包含敏感字段，已隐藏';
    return value.replace(/https?:\/\/\S+/gi,'[链接已隐藏]').replace(/\b1[3-9]\d{9}\b/g,'[手机号已隐藏]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱已隐藏]').slice(0,240);
  };
  const code=r.body?.code;
  const diagnostic={httpStatus:r.status,...(typeof code==='number'&&Number.isFinite(code)||typeof code==='string'&&/^[\w.-]{1,40}$/.test(code)?{businessCode:code}:{}),...(sanitize(r.body?.warnMessage??r.body?.noticeMessage??r.body?.message)?{serverMessage:sanitize(r.body?.warnMessage??r.body?.noticeMessage??r.body?.message)}:{}),...(typeof r.body?.success==='boolean'?{serverSuccess:r.body.success}:{}),hasResponseData:r.body?.data!==undefined&&r.body?.data!==null};
  const wire=typeof r.clientSentAt==='number'&&typeof r.clientReceivedAt==='number'&&Number.isFinite(r.clientSentAt)&&Number.isFinite(r.clientReceivedAt)?{sentAt:r.clientSentAt,receivedAt:r.clientReceivedAt,elapsedMs:typeof r.elapsedMs==='number'&&Number.isFinite(r.elapsedMs)?r.elapsedMs:r.clientReceivedAt-r.clientSentAt}:undefined;
  const base={...classifyResponse(r),diagnostic,...(wire?{wire}:{})};
  if(base.kind==='unknown')base.message=`HTTP ${r.status}${diagnostic.businessCode!==undefined?'，业务代码 '+diagnostic.businessCode:''}${diagnostic.serverMessage?'：'+diagnostic.serverMessage:''}；结果需核对`;
  if(base.kind!=='unknown')return base;
  const rawMessage=r.body?.warnMessage??r.body?.noticeMessage??r.body?.message;
  // 真实日志（2026-10-21 00:00）：HTTP200/code200、success=true、无 data、文案“资源分配错误,请十秒后重试！”，
  // 随后只读核对本人无新记录。2026-11-12 00:00：同一文案的响应改为 success=false（仍为HTTP200/code200/无data），
  // 两个账号提交后只读核对均无本人记录，用户随后在网站人工核对也确认没有预约。
  // 因此 success 为布尔值时两种取值都按同一“已确认未创建”形态处理；仍严格绑定文案、无响应数据、HTTP200/code200
  // 和当前场馆规则，其他未知形态仍先核对并暂停。
  const allocationMessage=typeof rawMessage==='string'?/^资源分配错误[,，]\s*请十秒后重试[！!]+$/.test(rawMessage.trim()):false;
  const allocationSuccessFlag=r.body?.success===true||r.body?.success===false;
  const transientRule=allocationMessage&&r.status===200&&r.body?.code===200&&allocationSuccessFlag&&r.body?.data==null
    ?rules.find(x=>x.httpStatus===200&&x.code===200&&x.kind==='transient'&&x.messageType==='allocation-error'&&x.noCreation===true):undefined;
  if(transientRule)return {kind:'transient',waitMs:10_000,message:'网站提示资源分配繁忙，稍后重试；本次未创建预约',diagnostic,...(wire?{wire}:{})};
  // 真实日志（2026-10-20 00:00）显示过早提交会收到HTTP200/code200/“不能预订超过2天的会议”，且未创建预约；
  // 只在严格命中该文案且绑定规则时，允许立即重试（配合15毫秒余量，防止偶然过早提交演变成冻结）。
  const dateLimitMessage=typeof rawMessage==='string'?/^不能预订超过2天的会议$/.test(rawMessage.trim()):false;
  const dateLimitRule=dateLimitMessage&&r.status===200&&r.body?.code===200&&r.body?.data==null
    ?rules.find(x=>x.httpStatus===200&&x.code===200&&x.kind==='not-open'&&x.messageType==='date-limit'&&x.noCreation===true):undefined;
  if(dateLimitRule)return {kind:'not-open',message:'网站尚未放号（日期上限拒绝）；本次未创建预约，稍后重试',diagnostic,...(wire?{wire}:{})};
  if(r.status>=500)return base;
  const matched=typeof rawMessage==='string'?/^您的会议与[\s\S]{1,240}发起的会议[\s\S]{0,240}\((\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d)~((?:[01]\d|2[0-3]):[0-5]\d)\)冲突，请另选时间或会议室$/.exec(rawMessage):null;
  let interval:{date:string;start:string;end:string}|undefined;
  if(matched&&task&&matched[1]===task.date&&matched[2]<matched[3]&&matched[2]<task.end&&task.start<matched[3]){
    try{validateCalendarRange(matched[1],matched[1]);interval={date:matched[1],start:matched[2],end:matched[3]};}catch{}
  }
  // 真实日志（2026-10-24 18:02）：真实冲突响应为HTTP200/code200、success=true、无data、完整原生冲突文案。
  // 因此冲突识别不再要求success严格为false；仍要求无响应数据、同日且与提交区间重叠、规则绑定当前场馆。
  const conflictRule=interval&&r.status===200&&r.body?.code===200&&r.body?.data==null
    ?rules.find(x=>x.httpStatus===200&&x.code===200&&x.kind==='conflict'&&x.messageType==='room-conflict'&&x.noCreation===true):undefined;
  if(conflictRule)return {kind:'conflict',waitMs:base.waitMs,message:'网站明确拒绝了本次预约（时段冲突）',diagnostic,...(wire?{wire}:{}),conflictInterval:interval};
  // 其他规则仍要求明确的失败标志（success严格false），避免把成功响应当作可重试拒绝。
  if(r.body?.success!==false)return base;
  const known=rules.find(x=>x.httpStatus===r.status&&x.code===r.body?.code&&x.noCreation===true&&(!(x.code===200||x.code==='200')||x.messageType==='room-conflict')&&(x.messageType!=='room-conflict'||(x.kind==='conflict'&&r.status===200&&r.body?.data==null&&!!interval)));
  return known?{kind:known.kind,waitMs:base.waitMs,message:'网站明确拒绝了本次预约',diagnostic,...(known.messageType==='room-conflict'?{conflictInterval:interval}:{})}:base;
}

export class BrowserSite implements Site {
  directory:string;context?:BrowserContext;page?:Page;private opening?:Promise<void>;
  private last?:Snapshot;private errorRules:ErrorRule[]=[];
  private template:Record<string,unknown>={};
  constructor(directory:string){this.directory=directory;}
  async open(deadline?:number):Promise<void>{
    if(this.page&&!this.page.isClosed())return;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      this.context=await chromium.launchPersistentContext(join(this.directory,'edge-profile'),{channel:'msedge',headless:false,serviceWorkers:'block',viewport:{width:1280,height:880},timeout:remainingTimeout(deadline,30_000)});
      this.page=this.context.pages()[0]||await this.context.newPage();
      await this.page.goto(BOOKING_URL,{waitUntil:'domcontentloaded',timeout:remainingTimeout(deadline,30_000)});
    })();
    try{await this.opening;}finally{this.opening=undefined;}
  }
  async close():Promise<void>{await this.context?.close();this.context=undefined;this.page=undefined;}
  private async ready(deadline?:number):Promise<Page>{
    // 较早阶段保留浏览器预热；短时预检不启动或等待另一个无预算的启动流程。
    if(deadline!==undefined&&(!this.page||this.page.isClosed())&&(this.opening||remainingTimeout(deadline,30_000)<=2500))throw Error('专用Edge未打开，请先打开扫码登录');
    await this.open(deadline);const page=this.page!;
    if(new URL(page.url()).origin!==ORIGIN||!new URL(page.url()).pathname.startsWith('/web/'))await page.goto(BOOKING_URL,{waitUntil:'domcontentloaded',timeout:remainingTimeout(deadline,20_000)});
    try{await page.waitForFunction(()=>{const w=window as any;return !!w.loginUser?.id;},{},{timeout:remainingTimeout(deadline,4000)});}
    catch{throw Error('请在专用Edge窗口微信扫码登录，再点击检查登录');}
    return page;
  }
  private async api(path:string,method:'GET'|'POST'='GET',body?:unknown,expectedOwner?:string,timeoutMs=8000,deadline?:number):Promise<ApiResponse>{
    if(!path.startsWith('/api/v2.0/'))throw Error('不支持的网站请求');
    const page=this.page&&!this.page.isClosed()?this.page:await this.ready(deadline);
    timeoutMs=remainingTimeout(deadline,timeoutMs);
    const deadlineAt=deadline===undefined?undefined:Date.now()+timeoutMs;
    return page.evaluate(async({path,method,body,expectedOwner,expectedOrigin,timeoutMs,deadlineAt})=>{
      const w=window as any;
      if(location.origin!==expectedOrigin)return {status:409,body:{success:false},localBlock:true};
      if(expectedOwner&&String(w.loginUser?.id)!==expectedOwner)return {status:409,body:{success:false},localBlock:true};
      if(method==='POST'&&(!expectedOwner||String(w.loginUser?.id)!==expectedOwner))return {status:409,body:{success:false},localBlock:true};
      const csrf=document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('authenticityToken='));
      // 网页可能以空 sessionId 配合 Cookie 登录，是否有效仍由网站接口验证。
      if(!w.loginUser?.id)return {status:401,body:{success:false}};
      const headers:Record<string,string>={'accept':'application/json, text/plain, */*','x-hys-session':String(w.sessionId),'x-hys-platform':String(w.platform||'webapp').toLowerCase(),'x-lang':String(w.loginUser?.lang||'zh'),'x-authenticity-token':csrf?decodeURIComponent(csrf.slice('authenticityToken='.length)):'undefined'};
      if(method==='POST')headers['content-type']='application/json;charset=UTF-8';
      const requestTimeout=deadlineAt===undefined?timeoutMs:Math.min(timeoutMs,Math.floor(deadlineAt-Date.now()));
      if(requestTimeout<=0)throw Error('放号前检查已到截止时间');
      const clientSentAt=Date.now(),started=performance.now();
      const r=await fetch(path,{method,body:method==='POST'?JSON.stringify(body):undefined,headers,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(requestTimeout)});
      if(r.redirected||new URL(r.url).pathname==='/login')return {status:401,body:{success:false}};
      const data=await r.json().catch(()=>null);
      const clientReceivedAt=Date.now(),elapsedMs=performance.now()-started;
      if(method==='GET'&&expectedOwner&&String(w.loginUser?.id)!==expectedOwner)return {status:409,body:{success:false},localBlock:true};
      return {status:r.status,body:data,retryAfter:r.headers.get('retry-after'),elapsedMs,clientSentAt,clientReceivedAt};
    },{path,method,body,expectedOwner,expectedOrigin:ORIGIN,timeoutMs,deadlineAt});
  }
  async preflight(timeoutMs?:number):Promise<Snapshot>{
    const deadline=timeoutMs===undefined?undefined:performance.now()+timeoutMs;
    const page=await this.ready(deadline);
    const r=await this.api('/api/v2.0/settings?officeAreaId=all&roomType=ROOM&extraRoomId=','GET',undefined,undefined,timeoutMs??8000,deadline);
    if(!apiOK(r)){
      if(r.status===401||r.status===403)throw Error(`网站未接受当前登录会话（HTTP ${r.status}），请在专用Edge确认登录后重试`);
      if(r.localBlock)throw Error('专用Edge已离开指定预约网站，请重新打开扫码登录窗口');
      const code=typeof r.body?.code==='number'?`，业务代码 ${r.body.code}`:'';
      throw Error(`场馆设置读取失败（HTTP ${r.status}${code}），请检查网络后重试`);
    }
    remainingTimeout(deadline,8000);
    const user=await page.evaluate(()=>{const w=window as any;return {id:String(w.loginUser.id),name:String(w.loginUser.name||''),corpId:String(w.loginUser.corp?.id||''),asset:Array.from(document.scripts).map(s=>s.src).find(s=>/desktop\/static\/js\/main\./.test(s))||''};});
    remainingTimeout(deadline,8000);
    const timing=serverClockSample(r),s=parseSettings(r.body.data,user,timing.offsetMs);s.serverUncertaintyMs=timing.uncertaintyMs;
    const evidence=checkEvidence(readJSON(join(this.directory,'site-verification.json')),s);
    const form=readJSON(join(this.directory,'form-check.json'));
    s.submissionReady=formAllowsSubmission(form,s);
    s.submissionReason=s.submissionReady?'网页表单已核对；接受部分时段，取得任何时段后停止':'请先用当前账号完成一次真实网页表单演练（不会提交预约）';
    this.template=s.submissionReady?form.requestTemplate:{};
    this.errorRules=evidence.rules;this.last=s;
    writeFileSync(join(this.directory,'site-status.json'),JSON.stringify(s,null,2),'utf8');return s;
  }
  // 零点前多采几次服务器时间：只保留往返最短的样本，越小的时间不确定度意味着越早、但仍保守的触发点。
  // budgetMs 是总预算：放号前必须留出提交余量，预算用尽立即返回已采到的最优样本，绝不阻塞零点。
  async refineClock(samples=3,budgetMs=2000):Promise<{offsetMs:number;uncertaintyMs:number}>{
    const deadline=performance.now()+Math.max(0,Math.trunc(budgetMs));
    await this.ready(deadline);
    const rounds=Math.max(1,Math.min(5,Math.trunc(samples)||1));
    const collected:{offsetMs:number;uncertaintyMs:number}[]=[];let lastError:unknown;
    for(let i=0;i<rounds;i++){
      const left=deadline-performance.now();
      if(i>0&&left<250)break;
      try{
        const timeout=Math.max(500,Math.min(left>0?left:budgetMs,4000));
        const r=await this.api('/api/v2.0/settings?officeAreaId=all&roomType=ROOM&extraRoomId=','GET',undefined,undefined,timeout,deadline);
        if(!apiOK(r)){lastError=Error(`校时采样失败（HTTP ${r.status}）`);continue;}
        collected.push(serverClockSample(r));
      }catch(e){lastError=e;}
    }
    if(!collected.length)throw lastError instanceof Error?lastError:Error('校时多采样失败');
    const best=bestClockSample(collected);
    if(this.last){this.last.serverOffsetMs=best.offsetMs;this.last.serverUncertaintyMs=best.uncertaintyMs;this.last.sampledAt=Date.now();}
    return best;
  }
  async list(date:string,timeoutMs?:number):Promise<Booking[]>{
    return this.listRange(date,date,timeoutMs);
  }
  async listRange(start:string,end:string,timeoutMs?:number):Promise<Booking[]>{
    validateCalendarRange(start,end);
    const q=new URLSearchParams({start,end,officeAreaId:'all',showJoinStatus:'true',roomType:'ROOM'});
    const deadline=timeoutMs===undefined?undefined:performance.now()+timeoutMs;
    const r=await this.api('/api/v2.0/meeting-rooms/day-meetings?'+q,'GET',undefined,this.last?.accountId,timeoutMs??8000,deadline);
    if(r.localBlock)throw Error('登录账号已变化，请重新检查登录后刷新日历');
    if(!apiOK(r)||!Array.isArray(r.body.data))throw Error('无法可靠读取已有预约');
    return r.body.data.flatMap((room:any)=>(room.meetings||[]).map((m:any)=>({id:m.id,ownerId:m.ownerId,roomId:m.roomId||room.id,beginTime:m.beginTime,endTime:m.endTime,status:m.status,subject:m.subject,allowSectionBooking:m.allowSectionBooking,conflictMeetings:m.conflictMeetings})));
  }
  async submit(task:Task,roomId:string):Promise<AttemptResult>{
    if(task.mode!=='live')throw Error('演练任务禁止正式提交');
    if(!this.last?.submissionReady||this.last.accountId!==task.accountId)throw Error('网页表单验证或账号不匹配');
    if(!task.courtPriority.some(c=>COURTS[c].id===roomId))throw Error('场地不在任务范围内');
    const limitDate=this.last.bookingLimitDate??siteBookingLimitDate(undefined,this.last.rules.bookingLimitDays,Date.now(),this.last.serverOffsetMs);
    const r=await this.api('/api/v2.0/meetings','POST',buildPayload(task,roomId,this.last.accountId,this.template,limitDate),task.accountId);
    if(r.localBlock)return {kind:'rejected',message:'登录账号已变化，本机已阻止提交'};
    return interpretSubmission(r,this.errorRules,task);
  }
  async rehearse(task:Task,roomId:string):Promise<{intercepted:number;forwarded:number;fields:string[];roomId:string}>{
    // 每次演练都重新读取 settings：fixedEndDate 的基准日期来自服务器 settings.newMeeting，
    // 临近服务器换日时旧快照会与网页实际请求相差一天。
    await this.ready();const s=await this.preflight();
    const context=this.context!,priorPages=new Set(context.pages());let intercepted=0,forwarded=0,captured:any=null;const blockedPaths:string[]=[];
    const report={intercepted:0,forwarded:0,fields:[] as string[],roomId};
    // Route at the browser boundary, before any write can reach the network.
    const guard=async(route:Route)=>{
      const req=route.request();
      if(!isReadOnlyRequest(req.method(),req.url())){
        blockedPaths.push(new URL(req.url()).pathname);
        if(new URL(req.url()).origin===ORIGIN&&new URL(req.url()).pathname==='/api/v2.0/meetings'&&req.method()==='POST'){
          intercepted++;try{captured=req.postDataJSON();}catch{}
        }
        await route.abort('blockedbyclient');return;
      }
      await route.fallback();
    };
    const finished=(req:any)=>{if(!isReadOnlyRequest(req.method(),req.url()))forwarded++;};
    context.on('requestfinished',finished);await context.route('**/*',guard);
    try{
      const page=await context.newPage();
      const pageErrors:string[]=[];
      page.on('pageerror',e=>pageErrors.push(String(e?.message??e).slice(0,200)));
      const q=new URLSearchParams({meetingDate:task.date,meetingEndDate:task.date,resourceId:roomId,resourceType:'ROOM',startTime:task.start.replace(':','-'),endTime:task.end.replace(':','-')});
      await page.goto(`${ORIGIN}/web/resource/ROOM/blocks/meeting/booking?${q}`,{waitUntil:'domcontentloaded',timeout:25_000});
      await page.locator('form #subject').waitFor({timeout:20_000});await page.locator('form #subject').fill(task.subject);
      const request=context.waitForEvent('request',{predicate:r=>r.method()==='POST'&&new URL(r.url()).origin===ORIGIN&&new URL(r.url()).pathname==='/api/v2.0/meetings',timeout:10_000});
      void request.catch(()=>{});
      await page.locator('form button[type="submit"]').click();
      try{await request;}catch{
        const errors=await page.locator('.ant-form-explain,.ant-message-notice-content,.ant-modal-body').allTextContents();
        const times=await page.locator('form input').evaluateAll(inputs=>inputs.filter(e=>/Select date|Select time/.test((e as HTMLInputElement).placeholder)).map(e=>({type:(e as HTMLInputElement).placeholder,value:(e as HTMLInputElement).value})));
        throw Error('网页未发起预约提交，写请求均已拦截。'+JSON.stringify({errors,times,pageErrors,blockedPaths}));
      }
      await page.waitForTimeout(100);
      const p=captured as Record<string,any>|null;
      const matched=!!p&&p.roomId===roomId&&p.ownerId===s.accountId&&p.meetingDate===task.date&&p.startTime===task.start&&p.duration===duration(task)&&p.subject===task.subject&&!p.id&&!p.roomIds?.length&&(!p.meetingRepeatType||p.meetingRepeatType==='NONE');
      if(!matched||intercepted!==1||forwarded!==0)throw Error('网页提交字段与任务不一致，演练未通过，所有写请求均已拦截。'+JSON.stringify({date:p?.meetingDate,start:p?.startTime,duration:p?.duration,subject:p?.subject,roomMatches:p?.roomId===roomId,ownerMatches:p?.ownerId===s.accountId,subjectMatches:p?.subject===task.subject,hasId:!!p?.id,roomIds:p?.roomIds?.length??0,intercepted,forwarded}));
      report.intercepted=intercepted;report.forwarded=forwarded;report.fields=Object.keys(p!).sort();
      const businessFields=new Set(['roomId','ownerId','meetingDate','startTime','duration','subject','meetingRepeatType','fixedEndDate','abilities','longTimeUse','adjusterIds','meetingEndDate','meetingEndTime','endTime','memberNumbers','meetingMembers','notPublic','content','extras','customFormId','bookingTimePointMinutes','allowSectionBooking']);
      const unknownFields=Object.keys(p!).filter(k=>!businessFields.has(k));
      if(unknownFields.length)throw Error('网页新增了未适配的业务字段（'+unknownFields.join('、')+'），所有预约写请求已拦截');
      const requestTemplate=structuredClone(p!);
      const limitDate=s.bookingLimitDate??siteBookingLimitDate(undefined,s.rules.bookingLimitDays,Date.now(),s.serverOffsetMs);
      const expected=buildPayload(task,roomId,s.accountId,requestTemplate,limitDate);
      if(!isDeepStrictEqual(expected,p)){
        const changed=Object.keys({...expected,...p}).filter(k=>!isDeepStrictEqual((expected as any)[k],(p as any)[k])).slice(0,6).map(k=>`${k}=${JSON.stringify((p as any)[k])}(网页)/${JSON.stringify((expected as any)[k])}(脚本)`);
        throw Error('脚本参数与网页请求不一致，所有预约写请求已拦截：'+changed.join('；'));
      }
      writeFileSync(join(this.directory,'form-check.json'),JSON.stringify({...report,version:3,payloadMatched:true,requestTemplate,matched:true,accountId:s.accountId,settingsHash:s.settingsHash,checkedAt:new Date().toISOString()},null,2),'utf8');
      return report;
    }finally{
      for(const p of context.pages())if(!priorPages.has(p))await p.close().catch(()=>{});
      await context.unroute('**/*',guard);context.off('requestfinished',finished);
    }
  }
}







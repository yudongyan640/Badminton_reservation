import { randomUUID } from 'node:crypto';

export const ORIGIN = 'https://86366168.hyshi.cn';
export const BOOKING_URL = `${ORIGIN}/web/resource/ROOM/blocks`;
export const COURTS = {
  '1': { id: 'RhJgrsKd4o238tPfkLyDEZ', name: '19-羽球场1（远离瑞幸）' },
  '2': { id: '6misbbNPhfeXrg2nnd9cSL', name: '19-羽球场2（靠近瑞幸）' }
} as const;
export type Court = keyof typeof COURTS;
export type TaskStatus = 'draft'|'scheduled'|'checking'|'submitting'|'succeeded'|'partial'|'failed'|'unknown'|'cancelled'|'rehearsed';
export interface Receipt {id:string;court:string;begin:string;end:string;}
export interface Task {
  id: string; date: string; start: string; end: string; subject: string;
  courtPriority: Court[]; mode: 'dry-run'|'live'; status: TaskStatus;
  releaseAt: number; createdAt: number; message: string; attempts: number;
  accountId?: string; receipt?:Receipt;receipts?:Receipt[];
  attemptedRoomId?:string;baselineIds?:string[];
  sentAt?: number; responseMs?: number; triggerDelayMs?: number;
  lastResponse?:ResponseDiagnostic; submittedStart?:string;submittedEnd?:string;
  localTriggerDelayMs?:number;clockOffsetMs?:number;clockUncertaintyMs?:number;releaseGuardMs?:number;
  wireSentAt?:number;wireResponseMs?:number;wireTriggerDelayMs?:number;
  // 1.2.22：首刀自身的落点与耗时单独留痕，后续重试不会覆盖（上面的字段永远指向最近一次尝试）。
  firstShot?:{at:number;roomId:string;start:string;end:string;triggerDelayMs:number;wireTriggerDelayMs?:number;responseMs?:number;kind?:string};
  // 1.2.22：最近一次冲突的场地/区间与本地改投结果，便于复盘“为什么没拿到某块场”。
  lastConflict?:{at:number;roomId:string;begin?:string;end?:string;reselectRoomId?:string;reselectStart?:string;reselectEnd?:string};
}
export interface Booking {
  id?: string; ownerId?: string; roomId?: string; beginTime?: string; endTime?: string;
  status?: string; allowSectionBooking?: boolean; conflictMeetings?: unknown[];subject?:string;
}
export interface CalendarBooking {id:string;court:Court;date:string;start:string;end:string;subject:string;}
export interface CalendarSnapshot {start:string;end:string;accountId:string;accountName:string;checkedAt:number;bookings:CalendarBooking[];}
export interface ApiResponse { status: number; body: any; retryAfter?: string|null; elapsedMs?: number; localBlock?:boolean;clientSentAt?:number;clientReceivedAt?:number; }
export interface Snapshot {
  accountId: string; accountName: string; corpId: string; settingsHash: string;
  rules: { startHour: number; endHour: number; meetingInterval: number; maxDuration: number; bookingLimitDays: number };
  rooms: {id: string; name: string; canBooking: boolean; disabled: boolean}[];
  serverOffsetMs: number; sampledAt: number;serverUncertaintyMs?:number;
  // 网页 fixedEndDate 的实际取值（由 settings.newMeeting.meetingDate 与放号天数推导），演练与提交共用。
  bookingLimitDate?: string;
  submissionReady: boolean; submissionReason: string;
}
export interface ResponseDiagnostic {httpStatus:number;businessCode?:string|number;serverMessage?:string;serverSuccess?:boolean;hasResponseData?:boolean;}
export interface AttemptResult {kind:'created'|'conflict'|'not-open'|'limited'|'transient'|'auth'|'rejected'|'unknown'; booking?: Booking; waitMs?:number; message?:string;diagnostic?:ResponseDiagnostic;conflictInterval?:{date:string;start:string;end:string};wire?:{sentAt:number;receivedAt:number;elapsedMs:number};}

export function dateAt(date: string, time='00:00'): number {
  return Date.parse(`${date}T${time}:00+08:00`);
}
export function releaseAt(date: string): number { return dateAt(date)-86_400_000; }
export function minutes(time:string):number { const [h,m]=time.split(':').map(Number); return h*60+m; }
export function duration(t:Pick<Task,'start'|'end'>):number {return minutes(t.end)-minutes(t.start);}
export function chinaDate(epoch=Date.now()):string { return new Date(epoch+8*3600_000).toISOString().slice(0,10); }
export function validateTask(raw:unknown):Task {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('任务应为一个对象');
  const r=raw as Record<string,unknown>;
  if(typeof r.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(dateAt(r.date))||chinaDate(dateAt(r.date))!==r.date) throw new Error('请输入真实日期，格式为 YYYY-MM-DD');
  for(const k of ['start','end']) if(typeof r[k]!=='string'||!/^([01]\d|2[0-3]):(00|30)$/.test(r[k] as string)) throw new Error('时间须以半小时为单位');
  const start=r.start as string,end=r.end as string, d=duration({start,end});
  if(minutes(start)<600||minutes(end)>1380||![30,60,90,120].includes(d)) throw new Error('开放时间为10:00–23:00，每次预约30–120分钟');
  const mode=r.mode??'dry-run'; if(mode!=='dry-run'&&mode!=='live') throw new Error('预约模式无效');
  const priority=r.courtPriority??['1','2'];
  if(!Array.isArray(priority)||!priority.length||priority.length>2||new Set(priority).size!==priority.length||priority.some(c=>c!=='1'&&c!=='2')) throw new Error('场地顺序应为1和2，可只选一个');
  const subject=r.subject===undefined?'1':r.subject;
  if(typeof subject!=='string'||!subject.trim()||subject.length>80) throw new Error('预约主题应为1–80个字');
  return {id:randomUUID(),date:r.date,start,end,subject:subject.trim(),mode,courtPriority:priority as Court[],status:'draft',releaseAt:releaseAt(r.date),createdAt:Date.now(),attempts:0,message:'尚未启用'};
}
export function overlaps(a:Pick<Task,'date'|'start'|'end'>,b:Pick<Task,'date'|'start'|'end'>):boolean {
  return a.date===b.date&&minutes(a.start)<minutes(b.end)&&minutes(b.start)<minutes(a.end);
}
export function bookingInterval(b:Booking):{date:string;start:string;end:string}|null {
  if(!b.beginTime||!b.endTime) return null;
  const begin=bookingEpoch(b.beginTime),end=bookingEpoch(b.endTime);
  if(!Number.isFinite(begin)||!Number.isFinite(end)) return null;
  return {date:chinaDate(begin),start:new Date(begin+8*3600_000).toISOString().slice(11,16),end:new Date(end+8*3600_000).toISOString().slice(11,16)};
}
export function bookingEpoch(text:string):number {
  const t=text.replace(' ','T');return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(t)?t:t+'+08:00');
}
export const VALID_STATUSES=new Set(['OPEN']);
export function validateCalendarRange(start:unknown,end:unknown):asserts start is string {
  const valid=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(dateAt(s))&&chinaDate(dateAt(s))===s;
  if(!valid(start)||!valid(end)||dateAt(end)<dateAt(start)||dateAt(end)-dateAt(start)>41*86400000)throw Error('日历日期范围无效，每次最多查询42天');
}
export function calendarBookings(records:Booking[],account:string,start:string,end:string):CalendarBooking[]{
  validateCalendarRange(start,end);const found=new Map<string,CalendarBooking>();
  for(const b of records){
    if(!b.id||b.ownerId!==account||!VALID_STATUSES.has(b.status||'')||!b.beginTime||!b.endTime)continue;
    const court=(Object.keys(COURTS) as Court[]).find(c=>COURTS[c].id===b.roomId);
    const begin=bookingEpoch(b.beginTime),finish=bookingEpoch(b.endTime);
    if(!court||!Number.isFinite(begin)||!Number.isFinite(finish)||finish<=begin)continue;
    const date=chinaDate(begin);if(date<start||date>end)continue;
    const time=(n:number)=>new Date(n+8*3600000).toISOString().slice(11,16);
    found.set(b.id,{id:b.id,court,date,start:time(begin),end:(chinaDate(finish)!==date?chinaDate(finish)+' ':'')+time(finish),subject:typeof b.subject==='string'?b.subject:''});
  }
  return [...found.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.court.localeCompare(b.court));
}
export function matchesBooking(t:Task,b:Booking,account:string,roomIds:string[]):boolean {
  const i=bookingInterval(b);
  return !!b.id&&b.ownerId===account&&!!b.roomId&&roomIds.includes(b.roomId)&&VALID_STATUSES.has(b.status||'')&&!!i&&bookingEpoch(b.beginTime!)===dateAt(t.date,t.start)&&bookingEpoch(b.endTime!)===dateAt(t.date,t.end)&&!b.allowSectionBooking&&!b.conflictMeetings?.length;
}
export function confirmedBookings(t:Task,records:Booking[],account:string,roomIds:string[],excludedIds:string[]=[]):Booking[]{
  const from=dateAt(t.date,t.start),to=dateAt(t.date,t.end),exclude=new Set(excludedIds);let partial:Booking[]=[];
  for(const room of roomIds){
    const unique=new Map<string,Booking>();
    for(const b of records){
      if(!b.id||exclude.has(b.id)||b.ownerId!==account||b.roomId!==room||!VALID_STATUSES.has(b.status||'')||!b.beginTime||!b.endTime)continue;
      const a=bookingEpoch(b.beginTime),z=bookingEpoch(b.endTime);
      if(Number.isFinite(a)&&Number.isFinite(z)&&a>=from&&z<=to&&z>a&&a%1800000===0&&z%1800000===0)unique.set(b.id,b);
    }
    const found=[...unique.values()].sort((a,b)=>bookingEpoch(a.beginTime!)-bookingEpoch(b.beginTime!));
    if(coverageMinutes(found)===duration(t))return found;
    if(!partial.length&&found.length)partial=found;
  }
  return partial;
}
export function coverageMinutes(records:Booking[]):number{
  const intervals=records.map(b=>[bookingEpoch(b.beginTime!),bookingEpoch(b.endTime!)]).sort((a,b)=>a[0]-b[0]);
  let total=0,end=-Infinity;for(const [a,b]of intervals){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total/60000;
}
export function apiOK(r:ApiResponse):boolean {return r.status>=200&&r.status<300&&r.body&&r.body.success===true&&(r.body.code===200||r.body.code===0);}
export function classifyResponse(r:ApiResponse):AttemptResult {
  if(r.status===401||r.status===403) return {kind:'auth',message:'登录失效或没有权限'};
  if(r.status===429) {
    const v=r.retryAfter??'', n=Number(v);
    const waitMs=v&&Number.isFinite(n)?Math.max(300,n*1000):Math.max(300,Date.parse(v)-Date.now()||1000);
    return {kind:'unknown',waitMs,message:'收到限流响应，尚未验证是否未创建预约'};
  }
  if(apiOK(r)&&r.body.data?.id&&!r.body.data.allowSectionBooking&&!r.body.data.conflictMeetings?.length) return {kind:'created',booking:r.body.data};
  // Do not guess undocumented business codes or translate messages into safe retry permission.
  return {kind:'unknown',message:'网站返回尚未验证的结果，需要核对预约记录'};
}
export function buildPayload(t:Task,roomId:string,ownerId:string,template?:Record<string,unknown>,bookingLimitDate=t.date):Record<string,unknown> {
  const p:Record<string,unknown>={...structuredClone(template??{meetingMembers:[],memberNumbers:0,notPublic:false,content:'',meetingEndDate:null,endTime:null}),
    roomId,meetingDate:t.date,startTime:t.start,duration:duration(t),subject:t.subject,ownerId,meetingRepeatType:'NONE'};
  if(typeof p.meetingEndDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.meetingEndDate))p.meetingEndDate=t.date;
  if(typeof p.fixedEndDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.fixedEndDate))p.fixedEndDate=bookingLimitDate;
  for(const k of ['endTime','meetingEndTime'])if(typeof p[k]==='string'&&/^\d{2}:\d{2}$/.test(p[k] as string))p[k]=t.end;
  return p;
}
export function validateRules(t:Task,s:Snapshot):void {
  const r=s.rules;
  if(r.bookingLimitDays!==2||r.meetingInterval!==30||duration(t)>r.maxDuration||minutes(t.start)<r.startHour*60||minutes(t.end)>r.endHour*60) throw new Error('场馆规则已变化，请先更新适配，任务未执行');
  for(const c of t.courtPriority) if(!s.rooms.some(r=>r.id===COURTS[c].id&&r.canBooking&&!r.disabled)) throw new Error(`场地${c}暂不可预约或标识已变化`);
}


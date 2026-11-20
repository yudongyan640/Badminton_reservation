import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {COURTS,dateAt,overlaps,validateRules,bookingInterval,bookingEpoch,VALID_STATUSES,confirmedBookings,coverageMinutes,duration,calendarBookings,validateCalendarRange} from './domain.ts';
import type {Task,Snapshot,AttemptResult,Booking,CalendarSnapshot} from './domain.ts';
import type {Store} from './store.ts';

export interface Site {
  preflight(timeoutMs?:number):Promise<Snapshot>;
  list(date:string,timeoutMs?:number):Promise<Booking[]>;
  listRange?(start:string,end:string):Promise<Booking[]>;
  refineClock?(samples?:number,budgetMs?:number):Promise<{offsetMs:number;uncertaintyMs:number}>;
  submit(task:Task,roomId:string):Promise<AttemptResult>;
  rehearse(task:Task,roomId:string):Promise<{intercepted:number;forwarded:number;fields:string[];roomId:string}>;
}
interface Clock {now:()=>number;sleep:(ms:number)=>Promise<unknown>;monotonic:()=>number;}
interface Prepared {snapshot:Snapshot;records:Booking[];monoAt:number;date:string;accountId:string;}
interface SlotChoice {id:string;index:number;slot:{minutes:number;start:string;end:string};}
// 一条任务在一次放号批次里的执行上下文。同一轮到点的多条任务各自持有上下文；
// 1.2.21起时段互不重叠的任务首波并发，其余任务与后续重试仍串行。
interface ExecContext {
  t:Task;s:Snapshot;records:Booking[];targetRooms:string[];allowedRooms:string[];
  conflictHints:Booking[];rejectedSlots:Set<string>;conflictedRooms:Set<string>;
  choices:SlotChoice[];courtIndex:number;conflictsSinceRefresh:number;transientRetries:number;notOpenRetries:number;
  begin:number;last:number;submitted:boolean;result?:AttemptResult;pendingVerify:boolean;done:boolean;notBefore:number;error?:unknown;
}
// 零点触发点：取“本机墙钟 / 服务器点估计”的较晚者，再等EARLY_GUARD_MS。
// 1.2.11起不再叠加校时误差下界（误差只记录）；1.2.19起余量由40毫秒降为30毫秒，
// 1.2.20起再由30毫秒降为15毫秒，预计在服务器时间开放后约15毫秒发出（wire约+22~33ms）；
// 万一提前，网站会返回“不能预订超过2天的会议”，由日期上限规则立即重试兜底。
export const EARLY_GUARD_MS=15;
// 零点错误后的占用刷新限时：与零点密集重试节奏（约300毫秒）匹配，超时就用缓存+冲突提示继续重选，
// 不再让刷新把下一次提交拖后（原400毫秒会把密集节奏重新拖到约0.4~0.55秒）。
const ZERO_REFRESH_TIMEOUT_MS=150;
const ZERO_WINDOW_MS=15_000;
// 非零点（迟到任务）临时资源分配错误后的重试间隔：首次约150毫秒后先核对再试，之后逐步退避，
// 仍受15秒窗口限制；零点窗口内改用下面的密集节奏。
const TRANSIENT_DELAYS=[150,600,1500,3000];
// 零点窗口内的重试节奏：首个临时错误不再额外等待（仍受100毫秒提交下限约束），之后按300/300/600毫秒
// 密集重试，在竞争对手落地的头几秒内多争取几次提交；单在途、100毫秒间隔、20次/15秒边界不变。
const ZERO_TRANSIENT_DELAYS=[0,300,300,600];
// 零点降级执行时的占用查询上限：预检已失败时不能为查询占用再耗掉零点窗口（原为2000毫秒）。
const DEGRADED_LIST_TIMEOUT_MS=300;
// 1.2.18：零点预检快照显示目标全占时，放号后最多再查一次占用，避免把放号前的陈旧占用直接当成最终结论。
// 这是一次有界只读查询；查询失败按“未确认可用”处理，不提交、不冻结，100毫秒提交节奏不变。
const ZERO_RECHECK_TIMEOUT_MS=1_500;
// 同一放号时刻的多条任务共用预检结果的时效：只复用同一轮预检刚拿到的快照，避免陈旧占用。
const PREPARE_SHARE_MS=3_000;
// 1.2.21：同一批到点任务里，时段互不重叠的任务首刀最多两条并发（互不等待响应），
// 让第二条不再损失“第一条的响应时间”。时段重叠的任务（含同时段多场地）仍严格串行，
// 因为平台按账号拒绝同一时间的第二个会议；首波之外的重试/核对也仍是单在途、100毫秒间隔。
const MAX_PARALLEL_FIRST_SHOTS=2;
function errorText(e:unknown):string{
  const raw=(e instanceof Error?e.message:String(e)).replace(/https?:\/\/\S+/gi,'[链接已隐藏]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱已隐藏]').replace(/\s+/g,' ').trim();
  return (raw||'未知错误').slice(0,200);
}
// Completed tasks are history. Before submitting, execute() checks current website records.
const active=new Set(['scheduled','checking','submitting','unknown']);
export class Engine {
  store:Store;site:Site;clock:Clock;busy=false;cached?:Snapshot;
  private timer?:ReturnType<typeof setTimeout>; private deadlines=new Map<string,number>();
  private prechecked=new Map<string,number>(); private stopped=true;
  private prepared=new Map<string,Prepared>();
  // 跨任务统一的提交节奏：同一账号任意两次提交起始间隔≥100毫秒；
  // 唯一例外是1.2.21的首波并发（仅限时段互不重叠的任务，最多两条，见MAX_PARALLEL_FIRST_SHOTS）。
  private lastSubmitMono=-Infinity;
  private timeAnchor?:{serverAt:number;monoAt:number;uncertaintyMs?:number};
  private localAnchor?:{at:number;monoAt:number};
  constructor(store:Store,site:Site,clock:Partial<Clock>={}){
    this.store=store;this.site=site;this.clock={now:Date.now,sleep:delay,monotonic:()=>performance.now(),...clock};
  }
  private serverNow():number{return this.timeAnchor?this.timeAnchor.serverAt+this.clock.monotonic()-this.timeAnchor.monoAt:this.clock.now();}
  private releaseWait(t:Task):number{
    if(this.timeAnchor?.uncertaintyMs===undefined)return t.releaseAt-this.serverNow();
    const local=this.localAnchor?this.localAnchor.at+this.clock.monotonic()-this.localAnchor.monoAt:this.clock.now();
    // 双时钟取较晚者：任一估算未过开放时间都不发；不再减误差下界，以换取更早的触发点。
    const conservative=Math.min(local,this.serverNow());
    return t.releaseAt+EARLY_GUARD_MS-conservative;
  }
  // 零点尝试窗口：放号后15秒内（与20次/15秒窗口一致）。
  private zeroWindow(t:Task):boolean{return this.serverNow()-t.releaseAt<=ZERO_WINDOW_MS;}
  // 零点窗口内的占用刷新限时150毫秒；失败返回undefined，由调用方决定用缓存继续。非零点仍用常规超时。
  private async refreshForRetry(t:Task):Promise<Booking[]|undefined>{
    const near=this.zeroWindow(t);
    try{return await this.site.list(t.date,near?ZERO_REFRESH_TIMEOUT_MS:undefined);}
    catch{this.store.event(t,near?'refresh-timeout-zero':'refresh-failed');return undefined;}
  }
  // 账号级暂停：有任一任务结果待确认，或持久化了冻结记录，正式任务就不能再自动提交。
  private accountPaused():boolean{return !!this.store.state.freeze||this.store.state.tasks.some(t=>t.status==='unknown');}
  private blocked(t:Task):boolean{return t.mode==='live'&&this.accountPaused();}
  async inspect(timeoutMs?:number):Promise<Snapshot>{
    const before=this.clock.now(),monoBefore=this.clock.monotonic(),snapshot=await this.site.preflight(timeoutMs),now=this.clock.now(),mono=this.clock.monotonic();
    if(snapshot.serverUncertaintyMs!==undefined&&Math.abs(now-before-(mono-monoBefore))>50)throw Error('校时期间电脑时钟发生调整，请重新检查登录');
    this.cached=snapshot;this.localAnchor??={at:now,monoAt:mono};
    this.timeAnchor={serverAt:now+snapshot.serverOffsetMs,monoAt:mono,uncertaintyMs:snapshot.serverUncertaintyMs};return snapshot;
  }
  async calendar(start:string,end:string):Promise<CalendarSnapshot>{
    validateCalendarRange(start,end);
    const imminent=()=>this.store.state.tasks.some(t=>t.status==='scheduled'&&!this.blocked(t)&&t.releaseAt-this.serverNow()<=300000);
    if(this.busy||imminent())throw Error('预约正在执行或临近执行，请稍后刷新日历');
    this.busy=true;
    try{
      const s=await this.inspect();
      if(imminent())throw Error('预约临近执行，请稍后刷新日历');
      if(!this.site.listRange)throw Error('当前网站适配器尚不支持日历范围查询');
      const records=await this.site.listRange(start,end);
      return {start,end,accountId:s.accountId,accountName:s.accountName,checkedAt:this.clock.now(),bookings:calendarBookings(records,s.accountId,start,end)};
    }finally{this.busy=false;}
  }
  async arm(id:string):Promise<void>{
    const t=this.store.get(id);
    const original=t.status;
    if(!['draft','failed','cancelled','rehearsed'].includes(t.status))throw Error('该任务已启用或已有结果');
    if(t.mode==='live'&&this.accountPaused())throw Error('账号已暂停正式预约，请先核对待确认记录');
    // 1.2.13：只有“时段重叠且场地集合有交集”才算冲突。两条各自只约一块场地（一单一双）的任务允许同一时段分别启用，
    // 用于“同一时段两块场地”同时抢；任一任务是“任一场地”备选（[1,2]）时仍按重叠拒绝，避免两块都落到同一场地。
    if(this.store.state.tasks.some(a=>a.id!==id&&a.mode===t.mode&&active.has(a.status)&&overlaps(a,t)&&!disjointSingleCourt(a,t)))throw Error('与已有任务时段重叠，请取消重复任务');
    const s=await this.inspect();validateRules(t,s);
    if(t.status!==original)throw Error('任务状态已改变，请刷新后重试');
    if(t.mode==='live'&&this.accountPaused())throw Error('账号已暂停正式预约');
    if(this.store.state.tasks.some(a=>a.id!==id&&a.mode===t.mode&&active.has(a.status)&&overlaps(a,t)&&!disjointSingleCourt(a,t)))throw Error('与已有任务时段重叠');
    if(dateAt(t.date,t.start)<=this.serverNow())throw Error('预约开始时间已过期');
    if(t.mode==='live'&&!s.submissionReady)throw Error('网页表单尚未验证，暂不能启用正式任务。'+s.submissionReason);
    t.accountId=s.accountId;t.status='scheduled';
    t.message=t.mode==='live'?(this.store.state.tasks.some(a=>a.id!==id&&a.mode===t.mode&&active.has(a.status)&&overlaps(a,t))?'已启用：与另一块场地的任务同时段，将按创建顺序分别预约':'已启用，到点自动预约'):'已启用，到点执行无提交演练';
    t.attempts=0;this.deadlines.delete(id);this.prechecked.delete(id);this.store.save();this.store.event(t,'armed');
  }
  async prepare(id:string,opts:{preflightTimeoutMs?:number;listTimeoutMs?:number;deadlineMono?:number}={}):Promise<Snapshot>{
    const t=this.store.get(id);
    // 1.2.13 零点预检去重：同一放号时刻、同账号同日期的多条任务共用刚拿到的快照与占用，
    // 不重复设置/占用/校时，保持零点前的请求量与单任务时一致。
    const shared=this.shareablePreparation(id,t);
    if(shared){
      validateRules(t,shared.snapshot);
      if(t.accountId!==shared.snapshot.accountId)throw Error('登录账号已变化');
      if(t.mode==='live'&&!shared.snapshot.submissionReady)throw Error('网页表单未验证');
      this.prepared.set(id,{snapshot:shared.snapshot,records:[...shared.records],monoAt:this.clock.monotonic(),date:shared.date,accountId:shared.accountId});
      return shared.snapshot;
    }
    const remaining=(limit?:number)=>{
      if(opts.deadlineMono===undefined)return limit;
      const left=Math.floor(Math.min(opts.deadlineMono-this.clock.monotonic(),this.releaseWait(t)-100));
      if(left<=0)throw Error('放号前检查已到截止时间');
      return Math.min(limit??left,left);
    };
    const s=await this.inspect(remaining(opts.preflightTimeoutMs));validateRules(t,s);
    if(t.accountId!==s.accountId)throw Error('登录账号已变化');
    if(t.mode==='live'&&!s.submissionReady)throw Error('网页表单未验证');
    const records=[...(await this.site.list(t.date,remaining(opts.listTimeoutMs)))];
    // 距放号30秒内再做几次采样，取最短往返样本；只收紧误差上界，不改变保守判定和15毫秒余量。
    // 采样有总预算且必须给零点留出至少1.5秒：放号前时间不够就跳过，绝不阻塞提交。
    if(this.site.refineClock&&t.releaseAt-this.serverNow()<=30_000){
      const clockBudget=opts.deadlineMono===undefined?2_000:Math.max(0,opts.deadlineMono-this.clock.monotonic());
      const budget=Math.floor(Math.min(2_000,this.releaseWait(t)-1_500,clockBudget));
      if(budget>=500){
        const before=this.clock.now(),monoBefore=this.clock.monotonic();
        try{
          const refined=await this.site.refineClock(5,budget);
          const now=this.clock.now(),mono=this.clock.monotonic();
          if(Math.abs(now-before-(mono-monoBefore))<=50){
            s.serverOffsetMs=refined.offsetMs;s.serverUncertaintyMs=refined.uncertaintyMs;s.sampledAt=now;
            this.cached=s;this.timeAnchor={serverAt:now+refined.offsetMs,monoAt:mono,uncertaintyMs:refined.uncertaintyMs};
          }
        }catch{/* 多采样失败时继续使用已有校时，不在零点前中断任务 */}
      }
    }
    this.prepared.set(id,{snapshot:s,records,monoAt:this.clock.monotonic(),date:t.date,accountId:s.accountId});return s;
  }
  // 只复用“同一轮、同账号、同日期、刚完成”的预检结果；超过时效一律重新查询。
  private shareablePreparation(id:string,t:Task):Prepared|undefined{
    if(!t.accountId)return undefined;
    for(const [other,entry] of this.prepared){
      if(other===id||entry.date!==t.date)continue;
      if(entry.accountId!==t.accountId)continue;
      if(this.clock.monotonic()-entry.monoAt>PREPARE_SHARE_MS)continue;
      return entry;
    }
    return undefined;
  }
  cancel(id:string):void{
    const t=this.store.get(id);if(!['draft','scheduled'].includes(t.status))throw Error('只能取消尚未开始的本机任务；不会取消网站预约');
    t.status='cancelled';t.message='已停止等待，未取消任何网站预约';this.deadlines.delete(id);this.store.save();this.store.event(t,'cancelled');
  }
  private finish(t:Task,status:Task['status'],message:string):void{t.status=status;t.message=message;this.store.save();this.store.event(t,'finished');}
  private freeze(t:Task,message:string):void{
    this.finish(t,'unknown',message);
    // 多条任务同时结果不明时保留第一条作为账号暂停的锚点，其余任务也各自保持“待确认”；
    // 逐条核对后由 afterResolved 转移或解除暂停，避免只解除一条就放行正式任务。
    if(!this.store.state.freeze)this.store.state.freeze={taskId:t.id,accountId:t.accountId||'',reason:message,at:this.clock.now()};
    this.store.save();
  }
  private afterResolved(id:string):void{
    if(this.store.state.freeze?.taskId!==id)return;
    const next=this.store.state.tasks.find(t=>t.id!==id&&t.status==='unknown');
    if(next)this.store.state.freeze={taskId:next.id,accountId:next.accountId||'',reason:'另有任务结果待确认，请核对网站记录',at:this.clock.now()};
    else delete this.store.state.freeze;
    this.store.save();
  }
  private success(t:Task,records:Booking[]):void{
    t.receipts=records.map(b=>({id:b.id!,court:Object.values(COURTS).find(c=>c.id===b.roomId)?.name||'',begin:b.beginTime!,end:b.endTime!}));t.receipt=t.receipts[0];
    const complete=coverageMinutes(records)===duration(t);
    this.finish(t,complete?'succeeded':'partial',complete?'预约成功，已核对目标时段全部覆盖':`部分成功：已保留${coverageMinutes(records)}分钟，已停止，不补订或换场`);
  }
  private async verify(t:Task):Promise<Booking[]>{
    const records=await this.site.list(t.date);return confirmedBookings(t,records,t.accountId!,t.attemptedRoomId?[t.attemptedRoomId]:t.courtPriority.map(c=>COURTS[c].id),t.baselineIds);
  }
  async reconcile(id:string):Promise<void>{
    if(this.busy)throw Error('预约正在执行，请稍后核对');
    const t=this.store.get(id);if(t.status!=='unknown')throw Error('该任务无需核对');
    const s=await this.inspect();if(s.accountId!==t.accountId)throw Error('请登录原预约账号后核对');
    const b=await this.verify(t);
    if(!b.length)throw Error('尚未查到可确认的预约，继续保持暂停；请在网站核对');
    this.success(t,b);this.afterResolved(id);this.store.save();
  }
  async rehearseNow(id:string):Promise<void>{
    const t=this.store.get(id);
    if(this.busy||t.mode!=='dry-run'||!['draft','failed','cancelled','rehearsed'].includes(t.status))throw Error('请选择一个未启用的演练任务');
    this.busy=true;
    try{
      const s=await this.inspect();validateRules(t,s);t.accountId=s.accountId;
      const r=await this.site.rehearse(t,COURTS[t.courtPriority[0]].id);
      if(r.intercepted!==1||r.forwarded!==0)throw Error('拦截检查未通过');
      await this.inspect().catch(()=>{});
      this.finish(t,'rehearsed',`演练通过：拦截${r.intercepted}次，实际发送${r.forwarded}次，没有预约场地`);
    }catch(e){this.finish(t,'failed','演练未完成：'+errorText(e)+'；没有正式提交');}
    finally{this.busy=false;}
  }
  confirmManual(id:string,confirmation:string):void{
    if(this.busy)throw Error('请等待当前检查完成');
    if(confirmation!=='我已在网站核对该次请求的结果，停止该任务并恢复后续任务')throw Error('请完整输入核对确认文字');
    const t=this.store.get(id);if(t.status!=='unknown')throw Error('没有对应的待确认任务');
    this.finish(t,'cancelled','用户已在网站人工核对；该任务停止，不会重发');this.afterResolved(id);this.store.save();
  }
  private slotKey(room:string,start:string,end:string):string{return `${room}|${start}|${end}`;}
  // 目标时段内某场地最长连续空闲段；占用来自本轮查询 + 冲突提示。
  private available(ctx:ExecContext,room:string):{minutes:number;start:string;end:string}{
    let begin=0,end=0,bestBegin=0,bestEnd=0;const t=ctx.t;
    for(let a=dateAt(t.date,t.start);a<dateAt(t.date,t.end);a+=1800000){
      const occupied=[...ctx.records,...ctx.conflictHints].some(b=>b.roomId===room&&VALID_STATUSES.has(b.status||'')&&b.beginTime&&b.endTime&&bookingEpoch(b.beginTime)<a+1800000&&bookingEpoch(b.endTime)>a);
      if(occupied){begin=0;end=0;continue;}
      if(!begin)begin=a;end=a+1800000;
      if(end-begin>bestEnd-bestBegin){bestBegin=begin;bestEnd=end;}
    }
    const time=(n:number)=>new Date(n+8*3600000).toISOString().slice(11,16);
    return {minutes:(bestEnd-bestBegin)/60000,start:bestBegin?time(bestBegin):'',end:bestEnd?time(bestEnd):''};
  }
  // 完整空闲优先；未冲突场地优先；再按配置场地顺序。已明确拒绝的相同场地/时段组合本轮不再提交。
  private choose(ctx:ExecContext):SlotChoice[]{
    return ctx.allowedRooms.map((id,index)=>({id,index,slot:this.available(ctx,id)}))
      .filter(x=>x.slot.minutes>0&&!ctx.rejectedSlots.has(this.slotKey(x.id,x.slot.start,x.slot.end)))
      .sort((a,b)=>(b.slot.minutes===duration(ctx.t)?1:0)-(a.slot.minutes===duration(ctx.t)?1:0)||Number(ctx.conflictedRooms.has(a.id))-Number(ctx.conflictedRooms.has(b.id))||a.index-b.index);
  }
  // 只按本任务的目标场地判断“本人已取得/已有重叠预约”：同一账号在另一块场地的同时段预约是本次多场地同时预约的预期结果，
  // 不应阻止本任务继续；目标场地上的本人重叠记录仍然停止，保留防重复占场语义。
  private stopIfOwned(ctx:ExecContext):boolean{
    const owned=confirmedBookings(ctx.t,ctx.records,ctx.s.accountId,ctx.allowedRooms);
    if(owned.length){this.success(ctx.t,owned);ctx.done=true;return true;}
    if(ctx.records.some(b=>b.ownerId===ctx.s.accountId&&VALID_STATUSES.has(b.status||'')&&!!b.roomId&&ctx.targetRooms.includes(b.roomId)&&bookingInterval(b)&&overlaps(ctx.t,bookingInterval(b)!))){this.finish(ctx.t,'failed','核对发现本人已有重叠预约，已停止后续提交');ctx.done=true;return true;}
    return false;
  }
  // 提交前准备：快照/占用/规则/账号/表单/已有预约检查，并给出首轮候选。返回 null 表示该任务已结束或改回等待。
  private async prepareExecution(t:Task):Promise<ExecContext|null>{
    t.status='checking';
    const nearTrigger=this.serverNow()-t.releaseAt<=10_000;
    let ready=(()=>{const p=this.prepared.get(t.id);return p&&this.clock.monotonic()-p.monoAt<=15_000?p:undefined;})();
    // 迟到启用（放号早已过去，如当天18点建当晚任务）没有零点时间压力：先做完整预检拿准确占用，
    // 避免只用缓存+短超时查询而拿到空占用、盲发已冲突的场地。
    if(!ready&&!nearTrigger){
      try{await this.prepare(t.id);}catch{this.store.event(t,'precheck-late-failed');}
      const p=this.prepared.get(t.id);ready=p&&this.clock.monotonic()-p.monoAt<=15_000?p:undefined;
    }
    // 零点前预检可能因服务端繁忙/网络抖动失败：若10分钟内有过成功快照，就用它继续到点提交，而不是放弃整夜任务。
    const cachedFresh=!ready&&this.cached&&this.clock.now()-this.cached.sampledAt<=600_000?this.cached:undefined;
    const s=ready?ready.snapshot:cachedFresh??await this.inspect();
    if(!ready&&cachedFresh)this.store.event(t,'using-cached-snapshot');
    validateRules(t,s);if(t.accountId!==s.accountId)throw Error('登录账号已变化，请重新建立任务');
    if(this.releaseWait(t)>0){t.status='scheduled';this.store.save();return null;}
    if(dateAt(t.date,t.start)<=this.serverNow())throw Error('预约开始时间已过期');
    if(t.mode==='live'&&!s.submissionReady)throw Error('网页表单未验证，停止正式提交');
    const targetRooms:string[]=t.courtPriority.map(c=>COURTS[c].id);
    let records:Booking[];let recordsRefreshed=false;
    if(ready)records=[...ready.records];
    else if(cachedFresh){
      // 降级路径：仅零点时间敏感场景允许在查询占用失败时继续，并留痕；提交后的核对仍会确认结果。
      // 300毫秒上限只用于临近触发点；放号已过很久的迟到任务用常规超时，尽量拿到真实占用。
      const timeout=nearTrigger?DEGRADED_LIST_TIMEOUT_MS:2_000;
      try{records=[...(await this.site.list(t.date,timeout))];}catch{this.store.event(t,'list-failed-degraded');records=[];}
    }else records=[...(await this.site.list(t.date))];
    if(ready&&records.some(b=>b.ownerId===s.accountId&&bookingInterval(b)&&overlaps(t,bookingInterval(b)!))){records=[...(await this.site.list(t.date))];recordsRefreshed=true;}
    const existing=confirmedBookings(t,records,s.accountId,targetRooms);
    if(existing.length){this.success(t,existing);return null;}
    if(records.some(b=>b.ownerId===s.accountId&&VALID_STATUSES.has(b.status||'')&&!!b.roomId&&targetRooms.includes(b.roomId)&&bookingInterval(b)&&overlaps(t,bookingInterval(b)!)))throw Error('本人已有重叠预约，已停止以避免重复占场');
    if(t.mode==='dry-run'){
      const report=await this.site.rehearse(t,targetRooms[0]);
      if(report.intercepted!==1||report.forwarded!==0)throw Error('演练未通过，未进入正式提交');
      this.finish(t,'rehearsed',`演练通过：已拦截${report.intercepted}次预约请求，实际发送${report.forwarded}次；没有预约场地`);return null;
    }
    const ctx:ExecContext={t,s,records,targetRooms,allowedRooms:[...targetRooms],conflictHints:[],rejectedSlots:new Set(),conflictedRooms:new Set(),choices:[],courtIndex:0,conflictsSinceRefresh:0,transientRetries:0,notOpenRetries:0,begin:this.clock.monotonic(),last:-Infinity,submitted:false,pendingVerify:false,done:false,notBefore:0};
    ctx.choices=this.choose(ctx);
    // 1.2.18：预检快照（放号前读取）显示目标全占时，零点最多再查一次实时占用再下结论。
    // 只在这一种情况下复查：已有候选时直接按原节奏提交；迟到任务/本轮已刷新过占用时不重复查询。
    if(!ctx.choices.length&&ready&&nearTrigger&&!recordsRefreshed){
      this.store.event(t,'precheck-occupied-recheck');
      let rechecked:Booking[];
      try{rechecked=[...(await this.site.list(t.date,ZERO_RECHECK_TIMEOUT_MS))];}
      catch{
        this.store.event(t,'precheck-recheck-failed');
        this.finish(t,'failed','预检快照显示目标已占用，零点复查失败，未提交');
        return null;
      }
      ctx.records=rechecked;
      if(this.stopIfOwned(ctx))return null;
      ctx.choices=this.choose(ctx);
      this.store.event(t,ctx.choices.length?'precheck-recheck-recovered':'precheck-recheck-still-occupied');
    }
    if(!ctx.choices.length){this.finish(t,'failed','候选场地在目标时段均已占用，没有提交');return null;}
    return ctx;
  }
  // 发一次提交（受全局100毫秒节奏与单在途约束），记录响应与耗时；结果交给 processResult 处理。
  // parallel=true 仅用于1.2.21首波：互不重叠的任务同时发出，不等待彼此响应，也不做100毫秒节流。
  private async submitAttempt(ctx:ExecContext,parallel=false):Promise<AttemptResult>{
    const t=ctx.t;
    const wait=parallel?0:Math.max(0,100-(this.clock.monotonic()-ctx.last),100-(this.clock.monotonic()-this.lastSubmitMono));
    if(wait)await this.clock.sleep(wait);
    const choice=ctx.choices[ctx.courtIndex];
    ctx.submitted=true;
    t.status='submitting';t.attempts++;t.sentAt=this.clock.now();
    t.attemptedRoomId=choice.id;t.baselineIds=ctx.records.map(b=>b.id).filter((id):id is string=>!!id);
    t.submittedStart=choice.slot.start;t.submittedEnd=choice.slot.end;
    t.triggerDelayMs=Math.round(this.serverNow()-t.releaseAt);
    t.localTriggerDelayMs=this.clock.now()-t.releaseAt;t.clockOffsetMs=ctx.s.serverOffsetMs;t.clockUncertaintyMs=ctx.s.serverUncertaintyMs;
    t.releaseGuardMs=this.timeAnchor?.uncertaintyMs===undefined?0:EARLY_GUARD_MS;
    // Flush the potentially in-flight state before allowing any network write.
    this.store.save();ctx.last=this.clock.monotonic();this.lastSubmitMono=ctx.last;
    const result=await this.site.submit({...t,start:choice.slot.start,end:choice.slot.end},choice.id);
    t.lastResponse=result.diagnostic;t.responseMs=Math.round(this.clock.monotonic()-ctx.last);
    if(result.wire){t.wireSentAt=result.wire.sentAt;t.wireResponseMs=result.wire.receivedAt-result.wire.sentAt;t.wireTriggerDelayMs=Math.round(result.wire.sentAt+ctx.s.serverOffsetMs-t.releaseAt);}
    this.store.event(t,'response');
    ctx.submitted=false;ctx.result=result;
    return result;
  }
  private async processResult(ctx:ExecContext):Promise<void>{
    const t=ctx.t,result=ctx.result;if(!result)return;
    if(result.kind==='created'||result.kind==='unknown'){ctx.pendingVerify=true;return;}
    if(result.kind==='auth'||result.kind==='rejected'){this.finish(t,'failed',result.message||'登录失效或网站拒绝预约');ctx.done=true;return;}
    if(result.kind==='conflict'){
      const choice=ctx.choices[ctx.courtIndex],room=choice.id;
      ctx.rejectedSlots.add(this.slotKey(room,choice.slot.start,choice.slot.end));ctx.conflictedRooms.add(room);
      if(result.conflictInterval?.date===t.date)ctx.conflictHints.push({roomId:room,status:'OPEN',beginTime:`${t.date} ${result.conflictInterval.start}:00`,endTime:`${t.date} ${result.conflictInterval.end}:00`});
      if(this.stopIfOwned(ctx))return;
      // 明确冲突后先用提交前缓存+冲突提示本地重选并直接提交，不先做网络占用查询；连续冲突或缓存无候选时才刷新。
      if(ctx.conflictsSinceRefresh<1){ctx.conflictsSinceRefresh++;ctx.choices=this.choose(ctx);ctx.courtIndex=0;if(ctx.choices.length)return;}
      t.status='checking';this.store.save();
      if(this.zeroWindow(t)){
        const refreshed=await this.refreshForRetry(t);
        if(refreshed)ctx.records=[...refreshed];else this.store.event(t,'refresh-using-cache');
      }else{
        try{ctx.records=[...(await this.site.list(t.date))];}catch{this.finish(t,'failed','网站明确拒绝本次预约；刷新占用失败，已停止，未继续提交');ctx.done=true;return;}
      }
      if(this.stopIfOwned(ctx))return;
      this.store.event(t,'conflict-refreshed');ctx.conflictsSinceRefresh=0;
      ctx.choices=this.choose(ctx);ctx.courtIndex=0;
      if(!ctx.choices.length){this.finish(t,'failed','明确冲突后候选场地没有可继续尝试的时段');ctx.done=true;}
      return;
    }
    if(result.kind==='transient'){
      t.status='checking';this.store.save();
      const zero=this.zeroWindow(t);
      const delays=zero?ZERO_TRANSIENT_DELAYS:TRANSIENT_DELAYS;
      const delay=delays[Math.min(ctx.transientRetries,delays.length-1)];ctx.transientRetries++;
      if(this.clock.monotonic()-ctx.begin+delay>=15_000){this.finish(t,'failed','网站提示资源分配繁忙，本次尝试窗口内已无时间重试，未取得预约');ctx.done=true;return;}
      this.store.event(t,'retry-after-transient');
      ctx.notBefore=this.clock.monotonic()+delay;
      // B2：零点首个临时错误不查询，按最小间隔原目标快速重试；若对方已占该场地，下一次会得到可识别的冲突文案。
      if(zero&&ctx.transientRetries===1){this.store.event(t,'retry-without-refresh');return;}
      // B1：零点窗口内刷新限时150毫秒；超时用缓存+冲突提示继续，不停止。
      if(zero){
        const refreshed=await this.refreshForRetry(t);
        if(refreshed)ctx.records=[...refreshed];else this.store.event(t,'refresh-using-cache');
      }else{
        // 非零点（迟到任务）：保持“核对不成功就不提交”的严格行为。
        try{ctx.records=[...(await this.site.list(t.date))];}catch{
          await this.clock.sleep(200);
          try{ctx.records=[...(await this.site.list(t.date))];}catch{this.finish(t,'failed','临时错误后无法核对本人记录，已停止本次提交，未取得预约');ctx.done=true;return;}
        }
      }
      if(this.stopIfOwned(ctx))return;
      ctx.choices=this.choose(ctx);ctx.courtIndex=0;
      if(!ctx.choices.length){this.finish(t,'failed','网站提示稍后重试；重新查询后候选场地已无空闲，未取得预约');ctx.done=true;}
      return;
    }
    if(result.kind==='not-open'){
      t.status='checking';this.store.save();ctx.notOpenRetries++;
      this.store.event(t,'retry-after-not-open');
      if(ctx.notOpenRetries>3||this.clock.monotonic()-ctx.begin>5_000){this.finish(t,'failed','网站提示尚未放号；已到重试边界，未取得预约');ctx.done=true;return;}
      ctx.notBefore=this.clock.monotonic();return;
    }
    if(result.kind==='limited'){
      t.status='checking';this.store.save();
      const ms=result.waitMs??1000;
      if(this.clock.monotonic()-ctx.begin+ms>=15_000){this.finish(t,'failed','本次尝试窗口结束，未取得可确认的预约时段');ctx.done=true;return;}
      ctx.notBefore=this.clock.monotonic()+ms;
    }
  }
  // 提交后核对：查到本人目标场地内的记录即成功/部分成功，否则持久化暂停（多条任务时保留各自待确认状态）。
  private async verifyContext(ctx:ExecContext):Promise<void>{
    try{
      const match=await this.verify(ctx.t);
      if(match.length){this.success(ctx.t,match);ctx.done=true;return;}
      this.freeze(ctx.t,(ctx.result?.message?ctx.result.message+'。':'')+'提交结果无法可靠确认，账号暂停正式预约，请先核对网站记录');
      ctx.done=true;
    }catch{
      this.freeze(ctx.t,'提交后发生异常，结果待确认；账号暂停正式预约');
      ctx.done=true;
    }
  }
  private failPrecheck(t:Task,e:unknown):void{
    if(['scheduled','checking','submitting'].includes(t.status))this.finish(t,'failed',`预约预检未通过（${errorText(e)}），没有提交；请检查登录和网络后重新启用`);
  }
  private async resolveError(ctx:ExecContext,e?:unknown):Promise<void>{
    const t=ctx.t;
    if(ctx.pendingVerify||ctx.submitted||ctx.result?.kind==='created'||ctx.result?.kind==='unknown'){
      try{const match=await this.verify(t);if(match.length){this.success(t,match);ctx.done=true;return;}}catch{}
      this.freeze(t,'提交后发生异常，结果待确认；账号暂停正式预约');ctx.done=true;return;
    }
    this.failPrecheck(t,e??ctx.error);
  }
  // 首波并发只取创建顺序上的前缀：一旦遇到与已选任务时段重叠、或已到并发上限，后续任务全部回到串行，
  // 既保持“按创建顺序”的可预期性，也避免把可能触发平台“同一时间有其它会议”的两条请求并发发出。
  private planFirstWave(contexts:ExecContext[]):{wave:ExecContext[];serial:ExecContext[]}{
    const wave:ExecContext[]=[];
    for(const ctx of contexts){
      if(wave.length>=MAX_PARALLEL_FIRST_SHOTS)break;
      if(wave.some(w=>overlaps(w.t,ctx.t)))break;
      wave.push(ctx);
    }
    return {wave,serial:contexts.slice(wave.length)};
  }
  async execute(id:string):Promise<void>{await this.executeTasks([id]);}
  // 同一放号时刻的多条任务在同一轮执行：时段互不重叠的任务首波并发（最多2条），其余任务在首波结束后
  // 按创建顺序串行补发第一刀，再处理结果与重试，最后统一核对。首波只放开“互不等待响应”这一点，
  // 之后的重试/核对仍严格单在途、100毫秒间隔，各任务仍各自受20次/15秒窗口限制。
  async executeTasks(ids:string[]):Promise<void>{
    const tasks=ids.map(id=>this.store.get(id)).filter(t=>t.status==='scheduled'&&!this.blocked(t));
    if(!tasks.length||this.busy)return;
    const due=tasks.filter(t=>this.releaseWait(t)<=0);
    if(!due.length)return;
    this.busy=true;
    const contexts:ExecContext[]=[];
    try{
      for(const t of due){
        try{const ctx=await this.prepareExecution(t);if(ctx)contexts.push(ctx);}
        catch(e){this.failPrecheck(t,e);}
      }
      // 1) 首波：时段互不重叠（最多2条）的任务并发发出首个创建请求，互不等待响应；
      //    其余任务在首波结束后按创建顺序串行补发。这样第二条不再被第一条的响应时间拖慢。
      const {wave,serial}=this.planFirstWave(contexts);
      if(wave.length>1){
        for(const ctx of wave)this.store.event(ctx.t,'first-wave-parallel');
        await Promise.all(wave.map(async ctx=>{try{await this.submitAttempt(ctx,true);}catch(e){ctx.error=e;}}));
      }else{
        for(const ctx of wave){try{await this.submitAttempt(ctx);}catch(e){ctx.error=e;}}
      }
      for(const ctx of serial){try{await this.submitAttempt(ctx);}catch(e){ctx.error=e;}}
      for(const ctx of contexts){if(ctx.error)continue;try{await this.processResult(ctx);}catch(e){ctx.error=e;}}
      // 2) 重试阶段：按创建顺序轮流给每条任务一次提交机会，各自受自己的20次/15秒窗口限制。
      while(contexts.some(c=>!c.done&&!c.pendingVerify&&!c.error)){
        let progressed=false,wait=Infinity;
        for(const ctx of contexts){
          if(ctx.done||ctx.pendingVerify||ctx.error)continue;
          if(this.clock.monotonic()-ctx.begin>=15_000||ctx.t.attempts>=20){this.finish(ctx.t,'failed','本次尝试窗口结束，未取得可确认的预约时段');ctx.done=true;continue;}
          const now=this.clock.monotonic();
          if(ctx.notBefore>now){wait=Math.min(wait,ctx.notBefore-now);continue;}
          try{await this.submitAttempt(ctx);progressed=true;await this.processResult(ctx);}catch(e){ctx.error=e;}
        }
        if(!progressed){
          if(wait===Infinity)break;
          const sleepStart=this.clock.monotonic();
          await this.clock.sleep(wait);
          // 防御：若注入的时钟不随 sleep 推进单调时间（测试/异常环境），放行已到期的退避，避免死循环。
          // 真实时钟下 sleep 会推进，退避语义不变；尝试次数上限仍然生效。
          if(this.clock.monotonic()-sleepStart<wait/2){
            for(const ctx of contexts)if(ctx.notBefore>this.clock.monotonic())ctx.notBefore=this.clock.monotonic();
          }
        }
      }
      // 3) 待核对结果与异常：核对不到才冻结；另一条任务已经提交的预约不受影响。
      for(const ctx of contexts){
        if(ctx.done)continue;
        if(ctx.error){await this.resolveError(ctx);continue;}
        if(ctx.pendingVerify)await this.verifyContext(ctx);
      }
    }catch(e){
      for(const ctx of contexts){if(!ctx.done)await this.resolveError(ctx,e);}
    }finally{
      this.busy=false;
      for(const t of due){this.deadlines.delete(t.id);this.prepared.delete(t.id);}
    }
  }
  start():void{this.stopped=false;void this.tick();}
  stop():void{this.stopped=true;if(this.timer)clearTimeout(this.timer);}
  // 零点前预检：阶段1（约5分钟前）用常规超时；阶段2（约10秒前）用短超时，失败只记录真实原因并让 tick 下一轮重试，
  // 不再因一次超时把任务判死。真正到点时若仍无预检结果，execute 会用最近一次成功的快照继续提交。
  async precheck(id:string,phase:number):Promise<boolean>{
    const t=this.store.get(id);
    // 各阶段均以触发点为截止；阶段2另设2.5秒总上限，不能把逐步超时相加。
    const budget=Math.floor(Math.min(phase>=2?2_500:Infinity,this.releaseWait(t)-100));
    if(budget<=0)return false;
    const quick={preflightTimeoutMs:phase>=2?2_500:8_000,listTimeoutMs:phase>=2?2_500:8_000,deadlineMono:this.clock.monotonic()+budget};
    try{await this.prepare(id,quick);return true;}
    catch(e){
      if(phase<2&&this.releaseWait(t)>10_000)throw e;
      if(t.status==='scheduled'){
        t.message='放号前检查未通过，稍后自动重试：'+errorText(e);this.store.save();this.store.event(t,'precheck-quick-failed');
      }
      return false;
    }
  }
  private async tick():Promise<void>{
    if(this.stopped)return;
    let next=1000;
    try{
      if(!this.busy){
        const pending=this.store.state.tasks.filter(t=>t.status==='scheduled'&&!this.blocked(t)).sort((a,b)=>a.releaseAt-b.releaseAt);
        const due:string[]=[];
        for(const t of pending){
          const until=t.releaseAt-this.serverNow(),phase=until<=10_000?2:until<=300_000?1:0;
          if(phase>(this.prechecked.get(t.id)||0)&&until>0){
            const ok=await this.precheck(t.id,phase);if(t.status!=='scheduled')continue;
            if(!ok){
              const wait=this.releaseWait(t);
              this.deadlines.set(t.id,this.clock.monotonic()+Math.max(0,wait));
              if(wait<=0){due.push(t.id);continue;}
              next=Math.min(next,Math.max(1,Math.min(1_000,wait)));continue;
            }
            this.prechecked.set(t.id,phase);
            this.deadlines.set(t.id,this.clock.monotonic()+Math.max(0,this.releaseWait(t)));
          }
          const ms=this.deadlines.has(t.id)?this.deadlines.get(t.id)!-this.clock.monotonic():this.releaseWait(t);
          if(ms<=0)due.push(t.id);
          else next=Math.min(next,Math.max(1,ms));
        }
        // 同一轮到点的任务一起执行（交错首发），不再一次 tick 只执行一条。
        if(due.length)await this.executeTasks(due);
      }
    }catch(e){
      for(const t of this.store.state.tasks.filter(t=>t.status==='scheduled'&&t.releaseAt-this.serverNow()<=10_000))this.finish(t,'failed',`放号前检查未通过（${errorText(e)}），没有提交；请检查登录和网络后重新启用`);
    }
    if(!this.stopped)this.timer=setTimeout(()=>void this.tick(),next);
  }
}
// 两条任务都只锁定一块场地且场地不同时，允许同一时段分别启用（多场地同时预约）。
// “任一场地”备选任务（长度不为1）仍按重叠拒绝，避免两块都落到同一场地。
function disjointSingleCourt(a:Pick<Task,'courtPriority'>,b:Pick<Task,'courtPriority'>):boolean{
  return a.courtPriority.length===1&&b.courtPriority.length===1&&a.courtPriority[0]!==b.courtPriority[0];
}

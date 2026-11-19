import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserSite,checkEvidence,parseSettings,interpretSubmission,formAllowsSubmission,isReadOnlyRequest,serverClockSample,bestClockSample,siteBookingLimitDate} from '../src/browser.ts';
import {COURTS,validateTask,buildPayload} from '../src/domain.ts';

const data={meetingTimes:{startHour:10,endHour:23,meetingInterval:30,maxDuration:120,bookingLimitDays:2},meetingRooms:{currentMeetingRooms:Object.values(COURTS).map(r=>({...r,canBooking:true,disabled:false}))}};

test('已登录网页的sessionId为空时仍可通过页面就绪检查',async()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{value:{sessionId:'',loginUser:{id:'fixture'}},configurable:true});
  try{
    const site=new BrowserSite('unused-memory-fixture');
    (site as any).page={isClosed:()=>false,url:()=> 'https://86366168.hyshi.cn/web/resource/ROOM/blocks',waitForFunction:async(fn:any)=>{if(!fn())throw Error('未就绪');}};
    await (site as any).ready();
    (globalThis as any).window.loginUser=undefined;
    await assert.rejects((site as any).ready(),/扫码登录/);
  }finally{if(saved)Object.defineProperty(globalThis,'window',saved);else Reflect.deleteProperty(globalThis,'window');}
});

test('空sessionId沿用网页请求头与Cookie认证，未登录及账号变化仍在本机阻止',async()=>{
  const names=['window','location','document','fetch'],saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  const user={sessionId:'',loginUser:{id:'fixture',lang:'zh'}};let fetches=0,serverStatus=200;
  const values=[user,{origin:'https://86366168.hyshi.cn'},{cookie:''},async(_path:string,options:any)=>{
    fetches++;assert.equal(options.headers['x-hys-session'],'');assert.equal(options.credentials,'same-origin');
    return {status:serverStatus,redirected:false,url:'https://86366168.hyshi.cn/api/v2.0/settings',json:async()=>({success:serverStatus===200,code:serverStatus===200?0:401}),headers:{get:()=>null}};
  }];
  try{
    names.forEach((name,i)=>Object.defineProperty(globalThis,name,{value:values[i],configurable:true,writable:true}));
    const site=new BrowserSite('unused-memory-fixture');
    (site as any).page={isClosed:()=>false,evaluate:async(fn:any,args:any)=>fn(args)};
    const read=()=> (site as any).api('/api/v2.0/settings','GET');
    assert.equal((await read()).status,200);assert.equal(fetches,1);
    serverStatus=401;assert.equal((await read()).status,401);assert.equal(fetches,2);
    const changed=await (site as any).api('/api/v2.0/meetings','POST',{},'other');
    assert.equal(changed.localBlock,true);assert.equal(fetches,2);
    user.loginUser=undefined as any;
    assert.equal((await read()).status,401);assert.equal(fetches,2);
  }finally{names.forEach((name,i)=>{if(saved[i])Object.defineProperty(globalThis,name,saved[i]!);else Reflect.deleteProperty(globalThis,name);});}
});
test('较早预检可按截止时间启动专用浏览器，临近触发则不再启动',async()=>{
  const site=new BrowserSite('unused-memory-fixture');let launches=0,launchDeadline:number|undefined;
  (site as any).open=async(deadline?:number)=>{launches++;launchDeadline=deadline;(site as any).page={isClosed:()=>false,url:()=> 'https://86366168.hyshi.cn/web/resource/ROOM/blocks',waitForFunction:async()=>true};};
  const deadline=performance.now()+8000;
  await (site as any).ready(deadline);assert.equal(launches,1);assert.equal(launchDeadline,deadline);
  site.page=undefined;
  await assert.rejects((site as any).ready(performance.now()+1000),/扫码|浏览器/);assert.equal(launches,1);
});
test('浏览器驱动排队耗尽预检预算后不再启动网络请求',async()=>{
  const names=['window','location','document','fetch'],saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));let fetches=0;
  const values=[{sessionId:'fixture',loginUser:{id:'fixture'}},{origin:'https://86366168.hyshi.cn'},{cookie:''},async()=>{fetches++;throw Error('不应启动请求');}];
  try{
    names.forEach((name,i)=>Object.defineProperty(globalThis,name,{value:values[i],configurable:true,writable:true}));
    const site=new BrowserSite('unused-memory-fixture');
    (site as any).page={isClosed:()=>false,evaluate:async(fn:any,args:any)=>{await new Promise(resolve=>setTimeout(resolve,80));return fn(args);}};
    await assert.rejects((site as any).api('/api/v2.0/settings','GET',undefined,undefined,30,performance.now()+30),/截止时间/);
    assert.equal(fetches,0);
  }finally{names.forEach((name,i)=>{if(saved[i])Object.defineProperty(globalThis,name,saved[i]!);else Reflect.deleteProperty(globalThis,name);});}
});
test('校时仅使用浏览器实际网络区间，驱动排队延迟不被算成服务器快了',()=>{
  const base=Date.parse('2026-10-19T00:00:00+08:00');
  const sample=serverClockSample({status:200,body:{timestamp:base-940},clientSentAt:base-1000,clientReceivedAt:base-900,elapsedMs:100});
  assert.equal(sample.offsetMs,10);assert.ok(sample.uncertaintyMs>=50);
  assert.throws(()=>serverClockSample({status:200,body:{timestamp:base},clientSentAt:base-1000,clientReceivedAt:base,elapsedMs:100}),/校时|时钟/);
});
test('多采样只采用往返最短的样本，未知样本不可用',()=>{
  assert.deepEqual(bestClockSample([{offsetMs:5,uncertaintyMs:137},{offsetMs:9,uncertaintyMs:52},{offsetMs:7,uncertaintyMs:90}]),{offsetMs:9,uncertaintyMs:52});
  assert.throws(()=>bestClockSample([]),/校时|样本/);
});
test('资源分配错误只在严格形态且绑定规则时允许稍后重试',()=>{
  const rules=[{httpStatus:200,code:200,kind:'transient' as const,noCreation:true as const,messageType:'allocation-error' as const},
    {httpStatus:200,code:200,kind:'conflict' as const,noCreation:true as const,messageType:'room-conflict' as const}];
  const body={success:true,code:200,data:null,warnMessage:'资源分配错误,请十秒后重试！'};
  const result=interpretSubmission({status:200,body},rules);
  assert.equal(result.kind,'transient');assert.ok((result.waitMs??0)>=1000);
  assert.equal(interpretSubmission({status:200,body},[]).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body},[rules[1]]).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{...body,warnMessage:undefined,message:'资源分配错误，请十秒后重试！'}},rules).kind,'transient');
  assert.equal(interpretSubmission({status:200,body:{...body,data:{id:'possibly-created'}}},rules).kind,'created');
  for(const change of [{success:undefined},{data:[]},{warnMessage:'资源分配错误'},{warnMessage:'资源分配错误，请稍后重试！'},{code:500}])
    assert.equal(interpretSubmission({status:200,body:{...body,...change}},rules).kind,'unknown');
});
test('2026-11-12真实形态：资源分配错误success=false且无data时仍按已确认未创建重试',()=>{
  const rules=[{httpStatus:200,code:200,kind:'transient' as const,noCreation:true as const,messageType:'allocation-error' as const}];
  const body={success:false,code:200,data:null,warnMessage:'资源分配错误,请十秒后重试！'};
  const result=interpretSubmission({status:200,body},rules);
  assert.equal(result.kind,'transient');assert.ok((result.waitMs??0)>=1000);
  assert.equal(result.diagnostic?.serverSuccess,false);
  // 仍必须严格绑定：无规则、有响应数据、文案不符或业务码不为200时都保持未知
  assert.equal(interpretSubmission({status:200,body},[]).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{...body,data:[]}},rules).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{...body,warnMessage:'资源分配错误，请稍后重试！'}},rules).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{...body,code:500}},rules).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{...body,success:undefined}},rules).kind,'unknown');
});
test('临时资源分配错误的证据必须绑定场馆规则',()=>{
  const s=parseSettings(data,{id:'me',name:'me',corpId:'corp',asset:'main.js'},0);
  const proof={version:1,corpId:'corp',settingsHash:s.settingsHash,verifiedAt:new Date().toISOString(),evidenceSource:'经核实的指定错误码未创建预约',noCreationErrors:[]};
  const rule={httpStatus:200,code:200,kind:'transient',noCreation:true};
  assert.equal(checkEvidence({...proof,noCreationErrors:[rule]},s).rules.length,0);
  assert.equal(checkEvidence({...proof,noCreationErrors:[{...rule,messageType:'allocation-error'}]},s).rules.length,1);
  const dateRule={httpStatus:200,code:200,kind:'not-open',noCreation:true};
  assert.equal(checkEvidence({...proof,noCreationErrors:[dateRule]},s).rules.length,0);
  assert.equal(checkEvidence({...proof,noCreationErrors:[{...dateRule,messageType:'date-limit'}]},s).rules.length,1);
});
test('日期上限拒绝只在严格文案且绑定规则时允许立即重试',()=>{
  const rules=[{httpStatus:200,code:200,kind:'not-open' as const,noCreation:true as const,messageType:'date-limit' as const}];
  const body={success:true,code:200,data:null,warnMessage:'不能预订超过2天的会议'};
  assert.equal(interpretSubmission({status:200,body},rules).kind,'not-open');
  assert.equal(interpretSubmission({status:200,body},[]).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{...body,data:{id:'possibly-created'}}},rules).kind,'created');
  for(const change of [{warnMessage:'不能预订超过2天'},{warnMessage:'不能预订超过2天的会议，请稍后'},{code:500}])
    assert.equal(interpretSubmission({status:200,body:{...body,...change}},rules).kind,'unknown');
});
test('真实表单演练匹配账号与规则后可提交，无需整段拒绝证明',()=>{
  const s=parseSettings(data,{id:'me',name:'me',corpId:'corp',asset:'main.js'},0);
  assert.equal(s.submissionReady,false);assert.equal(formAllowsSubmission(null,s),false);
  const form={version:3,matched:true,payloadMatched:true,forwarded:0,accountId:'me',settingsHash:s.settingsHash,requestTemplate:{}};
  assert.equal(formAllowsSubmission(form,s),true);assert.equal(formAllowsSubmission({...form,accountId:'other'},s),false);
  assert.equal(formAllowsSubmission({...form,version:2},s),false);
  assert.equal(formAllowsSubmission({...form,payloadMatched:false},s),false);
});
test('证据必须绑定场馆、规则指纹和真实来源，规则变化立即失效',()=>{
  const s=parseSettings(data,{id:'me',name:'me',corpId:'corp',asset:'main.js'},0);
  const proof={version:1,corpId:'corp',settingsHash:s.settingsHash,verifiedAt:new Date().toISOString(),evidenceSource:'经核实的指定错误码未创建预约',noCreationErrors:[]};
  assert.equal(checkEvidence(proof,s).valid,true);
  assert.equal(checkEvidence({...proof,settingsHash:'other'},s).valid,false);
  const rule={httpStatus:200,code:200,kind:'conflict',noCreation:true};
  assert.equal(checkEvidence({...proof,noCreationErrors:[rule]},s).rules.length,0);
  assert.equal(checkEvidence({...proof,noCreationErrors:[{...rule,messageType:'room-conflict'}]},s).rules.length,1);
});
test('只有经验证的拒绝码允许换场，未识别失败按结果不明处理',()=>{
  const r={status:200,body:{success:false,code:40901,message:'conflict'}};
  assert.equal(interpretSubmission(r,[]).kind,'unknown');
  const rules=[{httpStatus:200,code:40901,kind:'conflict' as const,noCreation:true as const}];
  assert.equal(interpretSubmission(r,rules).kind,'conflict');
  assert.equal(interpretSubmission({...r,status:503},[{...rules[0],httpStatus:503}]).kind,'unknown');
  assert.equal(interpretSubmission({status:200,body:{success:true,code:40901}},rules).kind,'unknown');
});
test('通用200的真实冲突形态允许换场，success不再要求严格false',()=>{
  const task=validateTask({date:'2026-10-21',start:'22:00',end:'23:00',mode:'live'});
  const rules=[{httpStatus:200,code:200,kind:'conflict' as const,noCreation:true as const,messageType:'room-conflict' as const}];
  const response={status:200,body:{success:false,code:200,data:null,warnMessage:'您的会议与测试用户发起的会议2(2026-10-21 22:00~22:30)冲突，请另选时间或会议室'}};
  const result=interpretSubmission(response,rules,task);assert.equal(result.kind,'conflict');assert.deepEqual(result.conflictInterval,{date:'2026-10-21',start:'22:00',end:'22:30'});
  // 真实日志（2026-10-24 18:02）：平台以 success=true 返回冲突文案，旧规则因此永远识别不到
  const realTask=validateTask({date:'2026-10-25',start:'21:00',end:'22:30',mode:'live'});
  const real={status:200,body:{success:true,code:200,data:null,warnMessage:'您的会议与任澍阳发起的会议123(2026-10-25 21:00~23:00)冲突，请另选时间或会议室'}};
  const realResult=interpretSubmission(real,rules,realTask);
  assert.equal(realResult.kind,'conflict');assert.deepEqual(realResult.conflictInterval,{date:'2026-10-25',start:'21:00',end:'23:00'});
  assert.equal(interpretSubmission({...real,body:{...real.body,success:undefined}},rules,realTask).kind,'conflict');
  assert.equal(interpretSubmission(real,[],realTask).kind,'unknown');
  assert.equal(interpretSubmission(real,[{httpStatus:200,code:200,kind:'conflict',noCreation:true}],realTask).kind,'unknown');
  assert.equal(interpretSubmission({...real,body:{...real.body,data:{id:'possibly-created'}}},rules,realTask).kind,'created');
  for(const change of [{warnMessage:'不能预订超过2天的会议'},{data:[]},{warnMessage:real.body.warnMessage.replace('2026-10-25','2026-10-26')},{code:500}])
    assert.equal(interpretSubmission({...real,body:{...real.body,...change}},rules,realTask).kind,'unknown');
});
test('预约参数不携带凭据，不允许偷偷请求部分预约或多场地预约',()=>{
  const t=validateTask({date:'2026-10-21',start:'19:00',end:'21:00'}),p=buildPayload(t,COURTS['1'].id,'me');
  assert.equal(p.duration,120);assert.equal(p.startTime,'19:00');assert.equal(p.meetingDate,'2026-10-21');
  assert.equal('roomIds' in p,false);assert.equal('allowSectionBooking' in p,false);assert.equal('session' in p,false);
});
test('未验证的429不能仅凭Retry-After自动重试',()=>{
  const r={status:429,body:{success:false,code:429},retryAfter:'1'};
  assert.equal(interpretSubmission(r,[]).kind,'unknown');
  assert.equal(interpretSubmission(r,[{httpStatus:429,code:429,kind:'limited',noCreation:true}]).kind,'limited');
});
test('演练允许已核实为查询的POST，预约POST及相似路径仍须拦截',()=>{
  assert.equal(isReadOnlyRequest('POST','https://86366168.hyshi.cn/api/v2.0/meeting-schedulings/user-meetings'),true);
  assert.equal(isReadOnlyRequest('POST','https://86366168.hyshi.cn/api/v2.0/meetings'),false);
  assert.equal(isReadOnlyRequest('POST','https://86366168.hyshi.cn/api/v2.0/meeting-schedulings/user-meetings/create'),false);
  assert.equal(isReadOnlyRequest('POST','https://other.example/api/v2.0/meeting-schedulings/user-meetings'),false);
});
test('复用完整网页业务模板，更新日期且不额外添加网页没有的字段',()=>{
  const t=validateTask({date:'2026-10-21',start:'22:30',end:'23:00'});
  const captured={meetingDate:'2026-10-19',meetingEndDate:'Invalid date',endTime:'Invalid date',startTime:'22:00',duration:60,fixedEndDate:'2026-10-19',subject:'旧主题',content:'',roomId:'old',notPublic:false,meetingRepeatType:'NONE',ownerId:'me',abilities:[],longTimeUse:false,bookingTimePointMinutes:15,memberNumbers:1,extras:{},meetingMembers:['me'],adjusterIds:[],meetingEndTime:'Invalid date'};
  assert.deepEqual(buildPayload(t,COURTS['2'].id,'me',captured),{...captured,meetingDate:t.date,fixedEndDate:t.date,startTime:t.start,duration:30,subject:t.subject,roomId:COURTS['2'].id});
  assert.equal(buildPayload(t,COURTS['2'].id,'me',captured,'2026-10-22').fixedEndDate,'2026-10-22','当天预约也使用场馆当前的末次可预约日期');
  const lean={roomId:'old',ownerId:'me',meetingDate:t.date,startTime:t.start,duration:30,subject:t.subject,meetingRepeatType:'NONE'};
  assert.deepEqual(buildPayload(t,COURTS['2'].id,'me',lean),{...lean,roomId:COURTS['2'].id});
});
test('网页 fixedEndDate 按 settings.newMeeting 与放号天数推导，不能按本地今天推算',()=>{
  // 2026-11-02 00:05 真实只读诊断：settings.newMeeting.meetingDate=2026-11-02，网页 POST 的 fixedEndDate=2026-11-03。
  assert.equal(siteBookingLimitDate('2026-11-02',2,Date.parse('2026-11-02T00:05:00+08:00'),0),'2026-11-03');
  // 2026-10-29 21:44 真实表单演练抓包：settings.newMeeting.meetingDate=2026-10-29，网页 fixedEndDate=2026-10-30。
  assert.equal(siteBookingLimitDate('2026-10-29',2,Date.parse('2026-10-29T21:44:00+08:00'),0),'2026-10-30');
  // 先加放号天数再减一分钟，按北京时间取日期，覆盖跨月与跨年。
  assert.equal(siteBookingLimitDate('2026-10-31',2,0,0),'2026-11-01');
  assert.equal(siteBookingLimitDate('2026-12-31',2,0,0),'2027-01-01');
  // settings 缺少 newMeeting 时网页以当前时刻为基准，程序同样回退，避免演练与提交各自漂移。
  assert.equal(siteBookingLimitDate(undefined,2,Date.parse('2026-11-02T00:05:00+08:00'),0),'2026-11-04');
  assert.equal(siteBookingLimitDate('not-a-date',2,Date.parse('2026-11-02T00:05:00+08:00'),0),'2026-11-04');
  // parseSettings 把该值写入快照：演练校验与正式提交共用同一个日期。
  const s=parseSettings({...data,newMeeting:{meetingDate:'2026-11-02'}},{id:'me',name:'me',corpId:'corp',asset:'main.js'},0);
  assert.equal(s.bookingLimitDate,'2026-11-03');
  assert.equal(formAllowsSubmission({version:3,payloadMatched:true,matched:true,forwarded:0,accountId:s.accountId,settingsHash:s.settingsHash,requestTemplate:{}},s),true);
});
test('未知业务错误保留脱敏原因，但不会授权重试或记录响应数据',()=>{
  const result=interpretSubmission({status:200,body:{success:false,code:400,warnMessage:'参数无效：fixedEndDate',data:{session:'secret'}}},[]);
  assert.equal(result.kind,'unknown');assert.match(result.message||'',/400.*fixedEndDate/);
  assert.deepEqual(result.diagnostic,{httpStatus:200,businessCode:400,serverMessage:'参数无效：fixedEndDate',serverSuccess:false,hasResponseData:true});
  const privateResult=interpretSubmission({status:500,body:{message:'session=secret token=private 13812345678'}},[]);
  assert.doesNotMatch(JSON.stringify(privateResult),/secret|private|13812345678/);
});

test('浏览器实测收发时刻随结果返回，用于核对真实发送时间',()=>{
  const rules=[{httpStatus:200,code:200,kind:'transient' as const,noCreation:true as const,messageType:'allocation-error' as const}];
  const result=interpretSubmission({status:200,body:{success:true,code:200,data:null,warnMessage:'资源分配错误,请十秒后重试！'},clientSentAt:1000,clientReceivedAt:1100,elapsedMs:100},rules);
  assert.equal(result.kind,'transient');assert.deepEqual(result.wire,{sentAt:1000,receivedAt:1100,elapsedMs:100});
  const unknown=interpretSubmission({status:200,body:{success:false,code:400},clientSentAt:5,clientReceivedAt:9},[]);
  assert.deepEqual(unknown.wire,{sentAt:5,receivedAt:9,elapsedMs:4});
});


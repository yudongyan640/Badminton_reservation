const $=s=>document.querySelector(s);
document.querySelectorAll('button').forEach(b=>b.disabled=true);
let state,token='',busy=false,audio;const seen=new Map();
const statusNames={draft:'尚未启用',scheduled:'等待执行',checking:'检查中',submitting:'预约中',succeeded:'完整成功',partial:'部分成功',failed:'未完成',unknown:'结果待确认',cancelled:'已停止',rehearsed:'演练完成'};
const stamp=n=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(n));
const dateString=n=>new Date(n+8*3600000).toISOString().slice(0,10);
let calendarMonth=dateString(Date.now()).slice(0,7),calendarData=null,calendarLoading=false,calendarError='',calendarNeedsRefresh=false,calendarSequence=0;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6500);}
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-local-token':token},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||'操作未完成');return j;}
function node(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function calendarBounds(){const first=calendarMonth+'-01',end=new Date(Date.UTC(Number(calendarMonth.slice(0,4)),Number(calendarMonth.slice(5,7)),0)).toISOString().slice(0,10);return {start:first,end};}
function calendarButtons(){for(const id of ['calendar-refresh','calendar-prev','calendar-next-month','calendar-today'])$('#'+id).disabled=calendarLoading||busy||!!state?.busy||!token;}
function renderCalendar(){
  const grid=$('#calendar-grid'),today=dateString(Date.now()),{start,end}=calendarBounds();grid.replaceChildren();grid.classList.toggle('loading',calendarLoading);grid.setAttribute('aria-busy',String(calendarLoading));
  $('#calendar-month').textContent=calendarMonth.slice(0,4)+'年'+Number(calendarMonth.slice(5,7))+'月';
  const bookings=calendarData?.bookings||[];$('#calendar-count').textContent=calendarData?bookings.length+'段':'';
  const summary=$('#calendar-next');summary.classList.toggle('error',!!calendarError);
  const next=bookings.find(b=>Date.parse(`${b.date}T${b.start}:00+08:00`)>Date.now());
  summary.textContent=calendarLoading?'正在向场馆核对有效预约…':calendarError?'未能同步预约：'+calendarError:next?`下一场：${next.date} ${new Intl.DateTimeFormat('zh-CN',{weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date(next.date+'T12:00:00+08:00'))}　${next.start}–${next.end}　场地${next.court}${next.subject?' · '+next.subject:''}`:calendarData?(bookings.length?'本月的有效预约如下，目前没有尚未开始的时段。':'本月暂无有效预约。'):'请检查登录后刷新预约。';
  $('#calendar-sync').textContent=calendarLoading?'正在同步':calendarError?'当前预约未确认，暂不显示旧数据':calendarData?`${calendarData.accountName} · 同步于 ${stamp(calendarData.checkedAt)}`:'';
  for(const name of ['一','二','三','四','五','六','日'])grid.append(node('div','calendar-weekday','周'+name));
  const first=new Date(start+'T00:00:00Z'),offset=(first.getUTCDay()+6)%7,count=Math.ceil((offset+Number(end.slice(8,10)))/7)*7;
  for(let i=0;i<count;i++){
    const date=new Date(first.getTime()+(i-offset)*86400000).toISOString().slice(0,10),outside=date.slice(0,7)!==calendarMonth;
    const cell=node('div','calendar-day'+(outside?' outside':'')+(date===today?' today':''));cell.dataset.date=date;
    cell.append(node('span','calendar-day-number',String(Number(date.slice(8,10)))));
    if(!outside)for(const b of bookings.filter(b=>b.date===date)){
      const event=node('div','calendar-booking');event.dataset.bookingId=b.id;event.append(node('strong','',b.start+'–'+b.end),node('span','',`场地${b.court}${b.subject?' · '+b.subject:''}`));event.title=`${date} ${b.start}–${b.end}\n场地${b.court}\n主题：${b.subject}\n编号：${b.id}`;cell.append(event);
    }
    grid.append(cell);
  }
  calendarButtons();
}
async function loadCalendar(){
  if(!token||calendarLoading||busy)return;
  const sequence=++calendarSequence;calendarLoading=true;calendarError='';calendarData=null;renderCalendar();
  try{const data=await api('/api/calendar',calendarBounds());if(sequence===calendarSequence){calendarData=data;await refresh();}}
  catch(e){if(sequence===calendarSequence)calendarError=e.message;}
  finally{if(sequence===calendarSequence){calendarLoading=false;renderCalendar();}}
}
function moveCalendarMonth(change){const date=new Date(calendarMonth+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+change);calendarMonth=date.toISOString().slice(0,7);loadCalendar();}
$('#calendar-refresh').onclick=()=>loadCalendar();$('#calendar-prev').onclick=()=>moveCalendarMonth(-1);$('#calendar-next-month').onclick=()=>moveCalendarMonth(1);$('#calendar-today').onclick=()=>{calendarMonth=dateString(Date.now()).slice(0,7);loadCalendar();};
function alertResult(t){if(!$('#sound').checked||!audio)return;const o=audio.createOscillator(),g=audio.createGain();o.connect(g);g.connect(audio.destination);o.frequency.value=t.status==='succeeded'?660:440;g.gain.setValueAtTime(.07,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.3);o.start();o.stop(audio.currentTime+.3);}
// 1.2.26：任务按“进行中 / 待启用 / 历史”分组；历史默认只显示最近5条，单行紧凑显示，点开看详情与操作。
const ACTIVE_STATUSES=['scheduled','checking','submitting','unknown'],IDLE_STATUSES=['draft','rehearsed'],HISTORY_PREVIEW=5;
let showAllHistory=false,lastTaskKey='';const openHistory=new Set();
const weekday=date=>new Intl.DateTimeFormat('zh-CN',{weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date(date+'T12:00:00+08:00'));
function taskBody(t){
  const parts=[node('p','task-meta',`${t.mode==='live'?'正式预约':'演练'} · ${t.courtPriority.map(c=>'场'+c).join('，然后')} · ${t.subject}`),node('p','task-meta','开抢时间：'+stamp(t.releaseAt)),node('p','task-message',t.message)];
  for(const r of (t.receipts||(t.receipt?[t.receipt]:[])))parts.push(node('p','receipt',`实际预约：${r.begin} 至 ${r.end}，${r.court}，编号：${r.id}`));
  if(t.sentAt)parts.push(node('p','task-meta',`尝试 ${t.attempts} 次，最近响应 ${t.responseMs??'--'} 毫秒`));
  if(t.submittedStart&&t.submittedEnd)parts.push(node('p','task-meta',`本次提交时段：${t.date} ${t.submittedStart}–${t.submittedEnd}`));
  const actions=node('div','task-actions');
  const add=(text,action,cls='secondary')=>{const b=node('button',cls,text);b.disabled=busy||state.busy;b.onclick=()=>operateTask(t,action);actions.append(b);};
  if(['draft','failed','cancelled','rehearsed'].includes(t.status)){
    if(t.mode==='dry-run')add('立即演练','rehearse');
    add(t.mode==='live'?'启用自动预约':'启用到点演练','arm');
  }
  if(['draft','scheduled'].includes(t.status))add('停止等待','cancel','quiet');
  if(t.status==='unknown'){add('核对网站记录','reconcile');add('我已人工核对','confirm','quiet');}
  if(actions.children.length)parts.push(actions);
  return parts;
}
function fullCard(t){
  const card=node('article','task');card.dataset.status=t.status;const top=node('div','task-head');
  top.append(node('div','task-date',t.date+' '+weekday(t.date)),node('span','badge',statusNames[t.status]||t.status));
  card.append(top,node('div','task-time',`${t.start} – ${t.end}`),...taskBody(t));return card;
}
function compactCard(t){
  const card=node('article','task compact');card.dataset.status=t.status;const details=node('details');details.open=openHistory.has(t.id);
  details.ontoggle=()=>{if(details.open)openHistory.add(t.id);else openHistory.delete(t.id);};
  const summary=node('summary','task-row');const receipts=t.receipts||(t.receipt?[t.receipt]:[]);
  const got=receipts.length&&t.status==='partial'?'（实得 '+receipts.map(r=>r.begin.slice(11,16)+'–'+r.end.slice(11,16)).join('、')+'）':'';
  summary.append(node('span','task-row-date',t.date.slice(5)+' '+weekday(t.date).replace('星期','周')),node('span','task-row-time',`${t.start}–${t.end}`),node('span','task-row-meta',`${t.courtPriority.map(c=>'场'+c).join('/')} · ${t.mode==='live'?'正式':'演练'}${got}`),node('span','badge',statusNames[t.status]||t.status));
  const body=node('div','task-body');body.append(...taskBody(t));details.append(summary,body);card.append(details);return card;
}
function taskGroup(title,count,cls){const head=node('h3','task-group '+cls);head.append(document.createTextNode(title),node('span','',String(count)));return head;}
function renderTasks(){
  for(const t of state.tasks){
    if(seen.has(t.id)&&seen.get(t.id)!==t.status&&['succeeded','partial','failed','unknown','rehearsed'].includes(t.status)){toast(`${statusNames[t.status]}：${t.date} ${t.start}–${t.end}`);alertResult(t);if(['succeeded','partial','unknown'].includes(t.status))calendarNeedsRefresh=true;}seen.set(t.id,t.status);
  }
  // 每1.5秒轮询一次；内容没变就不重绘，避免展开的历史被收起、按钮焦点被重置。
  const key=JSON.stringify([state.tasks,busy,!!state.busy,showAllHistory]);if(key===lastTaskKey)return;lastTaskKey=key;
  const list=$('#tasks');list.replaceChildren();$('#count').textContent=state.tasks.length;
  // hidden must win over the empty-state flex layout.
  $('#empty').hidden=state.tasks.length>0;$('#empty').style.display=state.tasks.length?'none':'flex';
  const byCreated=(a,b)=>b.createdAt-a.createdAt;
  const active=state.tasks.filter(t=>ACTIVE_STATUSES.includes(t.status)).sort((a,b)=>(a.status==='unknown'?0:1)-(b.status==='unknown'?0:1)||a.releaseAt-b.releaseAt||a.createdAt-b.createdAt);
  const idle=state.tasks.filter(t=>IDLE_STATUSES.includes(t.status)).sort(byCreated);
  const history=state.tasks.filter(t=>!ACTIVE_STATUSES.includes(t.status)&&!IDLE_STATUSES.includes(t.status)).sort((a,b)=>b.date.localeCompare(a.date)||b.start.localeCompare(a.start)||byCreated(a,b));
  if(!state.tasks.length)return;
  list.append(taskGroup('进行中',active.length,'active'));
  if(active.length)for(const t of active)list.append(fullCard(t));
  else list.append(node('p','task-group-empty','当前没有等待执行的任务。启用任务后会显示在这里，并在顶部倒计时。'));
  if(idle.length){list.append(taskGroup('待启用',idle.length,'idle'));for(const t of idle)list.append(fullCard(t));}
  if(history.length){
    list.append(taskGroup('历史记录',history.length,'history'));
    const shown=showAllHistory?history:history.slice(0,HISTORY_PREVIEW);for(const t of shown)list.append(compactCard(t));
    if(history.length>HISTORY_PREVIEW){const more=node('button','quiet history-toggle',showAllHistory?'收起历史记录':`显示全部 ${history.length} 条历史记录`);more.type='button';more.disabled=busy;more.onclick=()=>{showAllHistory=!showAllHistory;renderTasks();};list.append(more);}
  }
}
const instanceName=inst=>inst.dataDir==='data'?'账号1':inst.dataDir==='data-b'?'账号2':inst.dataDir;
function duration(ms){
  const s=Math.max(0,Math.floor(ms/1000)),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),pad=n=>String(n).padStart(2,'0');
  return d?`${d} 天 ${h} 小时`:`${pad(h)}:${pad(m)}:${pad(s%60)}`;
}
// 1.2.26：顶栏显示下一次开抢的倒计时（与引擎相同，取未暂停的等待任务中最早的放号时刻）。
function renderCountdown(){
  const box=$('#next-release');if(!state){box.hidden=true;return;}
  const paused=!!state.freeze||state.tasks.some(t=>t.status==='unknown');
  const running=state.tasks.filter(t=>['checking','submitting'].includes(t.status));
  const waiting=state.tasks.filter(t=>t.status==='scheduled'&&!(paused&&t.mode==='live'));
  const blockedLive=paused&&state.tasks.some(t=>t.status==='scheduled'&&t.mode==='live');
  box.hidden=!running.length&&!waiting.length&&!blockedLive;if(box.hidden)return;
  const s=state.site,sub=s?`校时误差 ±${s.serverUncertaintyMs??'--'} 毫秒 · 最近检查 ${stamp(s.sampledAt).slice(11)}`:'尚未检查登录，请先检查登录';
  let main,tone='';
  if(running.length){main=`正在预约 ${running.length} 条任务…`;tone='live';}
  else if(!waiting.length){main='账号已暂停：到点不会自动提交';tone='warn';}
  else{
    const next=Math.min(...waiting.map(t=>t.releaseAt)),batch=waiting.filter(t=>t.releaseAt===next).length,left=next-Date.now();
    const when=stamp(next).slice(5,16).replace('/','-');
    if(left<=0){main=`已到开抢时间（${when}），正在执行`;tone='live';}
    else{main=`下次开抢 ${when} · 还有 ${duration(left)} · ${batch} 条任务`;if(left<=300_000)tone='soon';}
  }
  $('#next-release-main').textContent=main;
  $('#next-release-sub').textContent=tone==='warn'?'请先核对“结果待确认”的任务':tone==='soon'?'临近开抢：请勿演练、刷新日历或关闭专用 Edge':sub;
  box.dataset.tone=tone;
}
function render(){
  const s=state.site;$('#login-status').textContent=s?`已检查：${s.accountName}`:'尚未检查登录';$('#login-status').classList.toggle('ok',!!s);
  // 1.2.14：同一台电脑可跑两个账号实例；页脚显示本页对应的数据目录与端口，避免两个窗口混淆。
  const inst=state.instance;
  $('#instance-label').textContent=inst?`实例 ${inst.dataDir} · 端口 ${inst.port} · 任务与登录资料保存在这台电脑`:'任务与登录资料保存在这台电脑';
  // 1.2.26：顶栏醒目标出账号与端口；账号2（非 data 目录）整页换用蓝色强调色，两个窗口并排时不易混淆。
  const badge=$('#instance-badge');badge.hidden=!inst;
  if(inst){
    const label=instanceName(inst);badge.textContent=`${label}${s?' · '+s.accountName:''} · ${inst.port}`;
    document.body.classList.toggle('instance-alt',inst.dataDir!=='data');document.title=`${label} · 场边 · 羽毛球预约 · ${inst.port}`;
  }
  renderCountdown();
  // 1.2.13：同一放号时刻可能有多条任务结果待确认，按任务逐条核对后才会解除暂停。
  const pending=state.tasks.filter(t=>t.status==='unknown');
  const paused=!!state.freeze||pending.length>0;
  const notice=$('#notice');notice.classList.toggle('ready',!!s?.submissionReady&&!paused);
  notice.textContent=pending.length?`有 ${pending.length} 个任务结果待确认，已暂停该账号的正式任务。请逐条核对对应任务后恢复。`:state.freeze?'有一次提交结果待确认，已暂停该账号的正式任务。请核对对应任务后恢复。':s?.submissionReady?'已连接场馆并核对网页表单，可启用正式任务。接受部分时段，取得任何时段后立即停止。':s?'已连接场馆。请先完成一次网页表单演练（不提交），再启用正式任务。':'首次使用，请打开扫码登录，再检查登录状态。默认使用演练模式。';
  $('#live-mode').disabled=!s?.submissionReady||paused;
  if($('#live-mode').disabled&&$('#live-mode').checked)$('input[name=mode][value="dry-run"]').checked=true;
  $('#live-caption').textContent=s?.submissionReady?'到点自动提交，部分成功也保留':'先完成网页表单演练';
  $('#verification').textContent=s?`场馆规则已读取，开放时间 ${s.rules.startHour}:00–${s.rules.endHour}:00，单次最长 ${s.rules.maxDuration} 分钟。${s.submissionReason}`:'尚未连接场馆。';renderTasks();calendarButtons();
  if(calendarData&&s&&calendarData.accountId!==s.accountId){calendarData=null;calendarNeedsRefresh=true;renderCalendar();}
}
async function refresh(){if(busy)return;try{const first=!token;state=await api('/api/state');token=state.localToken;render();if(first){document.querySelectorAll('button').forEach(b=>b.disabled=false);loadCalendar();}else if(calendarNeedsRefresh&&!state.busy&&!calendarLoading){calendarNeedsRefresh=false;loadCalendar();}}catch{toast('无法连接本机程序，请检查启动窗口是否仍在运行');}}
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){toast(e.message);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);lastTaskKey='';await refresh();}}
async function operateTask(t,action){
  let body={};if(action==='confirm'){const confirmation=prompt('请先在网站确认该次请求结果。恢复后该任务不会重发。\n请输入：我已在网站核对该次请求的结果，停止该任务并恢复后续任务');if(!confirmation)return;body={confirmation};}
  await run(async()=>{const j=await api(`/api/tasks/${t.id}/${action}`,body);toast(j.message||'操作完成');});
}
$('#login').onclick=()=>run(async()=>{await api('/api/login',{});toast('请在专用 Edge 窗口扫码登录，完成后点击检查登录');});
$('#check').onclick=()=>run(async()=>{await api('/api/check',{});toast('登录和场馆规则已检查');}).then(()=>loadCalendar());
$('#task-form').onsubmit=e=>{e.preventDefault();run(async()=>{await api('/api/tasks',{date:$('#date').value,start:$('#start').value,end:$('#end').value,subject:$('#subject').value,courtPriority:$('#court').value.split(','),mode:$('input[name=mode]:checked').value});toast('任务已保存，请在右侧启用或演练');});};
$('#import').onchange=async e=>{const f=e.target.files[0];if(!f)return;await run(async()=>{if(f.size>262144)throw Error('文件超过256KB');let j;try{j=JSON.parse(await f.text());}catch{throw Error('请导入有效的JSON任务文件');}await api('/api/import',j);toast('已导入，所有任务均未启用，请检查后启用');});e.target.value='';};
function download(name,value){const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=node('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
$('#example').onclick=()=>download('预约任务示例.json',[{date:dateString(Date.now()+2*86400000),start:'19:00',end:'21:00',courtPriority:['1','2'],subject:'1',mode:'dry-run'}]);
$('#sound').onchange=()=>{if($('#sound').checked){audio??=new AudioContext();audio.resume();}};
for(let i=20;i<=46;i++){const t=String(Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00');if(i<46)$('#start').append(new Option(t,t));if(i>20)$('#end').append(new Option(t,t));}
$('#date').value=dateString(Date.now()+2*86400000);$('#date').min=dateString(Date.now());$('#start').value='19:00';$('#end').value='21:00';
function preview(){const date=$('#date').value;if(!date)return;const release=Date.parse(date+'T00:00:00+08:00')-86400000;$('#release-preview').textContent=`开抢：${stamp(release)}${release<=Date.now()?'（已开放，启用后立即尝试）':''}`;}
$('#date').onchange=preview;preview();setInterval(()=>{$('#clock').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());renderCountdown();},1000);
refresh();setInterval(refresh,1500);

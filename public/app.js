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
function renderTasks(){
  const list=$('#tasks');list.replaceChildren();$('#count').textContent=state.tasks.length;$('#empty').hidden=state.tasks.length>0;
  // hidden must win over the empty-state flex layout.
  $('#empty').style.display=state.tasks.length?'none':'flex';
  for(const t of [...state.tasks].reverse()){
    if(seen.has(t.id)&&seen.get(t.id)!==t.status&&['succeeded','partial','failed','unknown','rehearsed'].includes(t.status)){toast(`${statusNames[t.status]}：${t.date} ${t.start}–${t.end}`);alertResult(t);if(['succeeded','partial','unknown'].includes(t.status))calendarNeedsRefresh=true;}seen.set(t.id,t.status);
    const card=node('article','task');card.dataset.status=t.status;const top=node('div','task-head');
    top.append(node('div','task-date',t.date+' '+new Intl.DateTimeFormat('zh-CN',{weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date(t.date+'T12:00:00+08:00'))),node('span','badge',statusNames[t.status]||t.status));card.append(top,node('div','task-time',`${t.start} – ${t.end}`));
    card.append(node('p','task-meta',`${t.mode==='live'?'正式预约':'演练'} · ${t.courtPriority.map(c=>'场'+c).join('，然后')} · ${t.subject}`));
    card.append(node('p','task-meta','开抢时间：'+stamp(t.releaseAt)),node('p','task-message',t.message));
    for(const r of (t.receipts||(t.receipt?[t.receipt]:[])))card.append(node('p','receipt',`实际预约：${r.begin} 至 ${r.end}，${r.court}，编号：${r.id}`));
    if(t.sentAt)card.append(node('p','task-meta',`尝试 ${t.attempts} 次，最近响应 ${t.responseMs??'--'} 毫秒`));
    if(t.submittedStart&&t.submittedEnd)card.append(node('p','task-meta',`本次提交时段：${t.date} ${t.submittedStart}–${t.submittedEnd}`));
    const actions=node('div','task-actions');
    const add=(text,action,cls='secondary')=>{const b=node('button',cls,text);b.disabled=busy||state.busy;b.onclick=()=>operateTask(t,action);actions.append(b);};
    if(['draft','failed','cancelled','rehearsed'].includes(t.status)){
      if(t.mode==='dry-run')add('立即演练','rehearse');
      add(t.mode==='live'?'启用自动预约':'启用到点演练','arm');
    }
    if(['draft','scheduled'].includes(t.status))add('停止等待','cancel','quiet');
    if(t.status==='unknown'){add('核对网站记录','reconcile');add('我已人工核对','confirm','quiet');}
    if(actions.children.length)card.append(actions);list.append(card);
  }
}
function render(){
  const s=state.site;$('#login-status').textContent=s?`已检查：${s.accountName}`:'尚未检查登录';$('#login-status').classList.toggle('ok',!!s);
  // 1.2.14：同一台电脑可跑两个账号实例；页脚显示本页对应的数据目录与端口，避免两个窗口混淆。
  const inst=state.instance;
  $('#instance-label').textContent=inst?`实例 ${inst.dataDir} · 端口 ${inst.port} · 任务与登录资料保存在这台电脑`:'任务与登录资料保存在这台电脑';
  if(inst)document.title='场边 · 羽毛球预约 · '+inst.port;
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
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){toast(e.message);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);await refresh();}}
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
$('#date').onchange=preview;preview();setInterval(()=>{$('#clock').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());},1000);
refresh();setInterval(refresh,1500);

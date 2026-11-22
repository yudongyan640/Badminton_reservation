import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {validateTask} from './domain.ts';
import type {Task} from './domain.ts';

export interface State {
  version:1; tasks:Task[];
  freeze?:{taskId:string;accountId:string;reason:string;at:number};
}
export class Store {
  directory:string; state:State; file:string;
  private constructor(directory:string,state:State){this.directory=directory;this.state=state;this.file=join(directory,'tasks.json');}
  static async open(directory:string):Promise<Store>{
    mkdirSync(directory,{recursive:true});let state:State={version:1,tasks:[]};const path=join(directory,'tasks.json');
    if(existsSync(path)) {
      try {state=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('任务文件损坏，已停止启动以避免重复预约。请保留data目录并检查。');}
      if(state.version!==1||!Array.isArray(state.tasks))throw Error('任务文件格式不受支持');
      for(const t of state.tasks){
        const clean=validateTask(t);
        if(typeof t.id!=='string'||t.releaseAt!==clean.releaseAt||!['draft','scheduled','checking','submitting','succeeded','partial','failed','unknown','cancelled','rehearsed'].includes(t.status))throw Error('任务文件校验失败');
        if(t.status==='submitting'||t.status==='unknown'){
          const wasSubmitting=t.status==='submitting';t.status='unknown';if(wasSubmitting||!t.message)t.message='上次提交结果尚未确认，账号暂停正式预约';
          state.freeze??={taskId:t.id,accountId:t.accountId||'',reason:t.message,at:Date.now()};
        }else if(t.status==='checking')t.status='scheduled';
      }
    }
    const store=new Store(directory,state);store.save();return store;
  }
  save():void {
    const temp=this.file+'.tmp';const fd=openSync(temp,'w');
    try{writeFileSync(fd,JSON.stringify(this.state,null,2),'utf8');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,this.file);
  }
  add(raw:unknown):Task{return this.importTasks([raw])[0];}
  importTasks(raw:unknown):Task[]{
    const list=Array.isArray(raw)?raw:[raw];
    if(!list.length||list.length>100||this.state.tasks.length+list.length>500)throw Error('每次导入1–100个任务，总任务不超过500个');
    const tasks=list.map(validateTask);this.state.tasks.push(...tasks);this.save();return tasks;
  }
  get(id:string):Task{const t=this.state.tasks.find(t=>t.id===id);if(!t)throw Error('找不到该任务');return t;}
  // 1.2.22：可选 detail 承载一次性诊断信息（冲突区间、本地改投结果等），不改变既有字段。
  event(t:Task,event:string,detail?:Record<string,unknown>):void {
    appendFileSync(join(this.directory,'events.ndjson'),JSON.stringify({at:new Date().toISOString(),taskId:t.id,event,status:t.status,attempts:t.attempts,sentAt:t.sentAt,responseMs:t.responseMs,triggerDelayMs:t.triggerDelayMs,localTriggerDelayMs:t.localTriggerDelayMs,clockOffsetMs:t.clockOffsetMs,clockUncertaintyMs:t.clockUncertaintyMs,releaseGuardMs:t.releaseGuardMs,wireSentAt:t.wireSentAt,wireResponseMs:t.wireResponseMs,wireTriggerDelayMs:t.wireTriggerDelayMs,response:t.lastResponse,submittedStart:t.submittedStart,submittedEnd:t.submittedEnd,...(detail?{detail}:{})})+'\n','utf8');
  }
}


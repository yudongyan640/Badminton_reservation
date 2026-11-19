import {mkdirSync,openSync,readFileSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
export function acquireInstance(directory:string):()=>void {
  mkdirSync(directory,{recursive:true});const path=join(directory,'instance.json');
  const acquire=():number=>openSync(path,'wx');let fd:number;
  try{fd=acquire();}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    let old:any;try{old=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('启动锁文件不完整。请先关闭所有本程序，再检查data/instance.json。');}
    if(!Number.isInteger(old.pid)||old.pid<1)throw Error('启动锁文件无效，请保留data目录并检查');
    let alive=true;try{process.kill(old.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
    if(alive)throw Error('预约程序已经运行，请打开 http://127.0.0.1:38321');
    unlinkSync(path);fd=acquire();
  }
  writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));closeSync(fd);
  let released=false;return ()=>{if(released)return;released=true;try{if(JSON.parse(readFileSync(path,'utf8')).pid===process.pid)unlinkSync(path);}catch{}};
}

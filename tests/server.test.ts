import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {createApp} from '../src/server.ts';
import type {Site} from '../src/engine.ts';
import {get} from 'node:http';

test('控制页能录入及导入任务，跨站或无本机令牌的修改被拒绝',async()=>{
  const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'http-'));
  const store=await Store.open(dir);
  const site={preflight:async()=>{throw Error('未登录');},list:async()=>[],submit:async()=>{throw Error('不能提交');},rehearse:async()=>{throw Error('不能演练');}} as Site;
  const {server}=createApp(store,site);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}`;
  try{
    const initial=await (await fetch(url+'/api/state')).json() as any;
    assert.equal(initial.tasks.length,0);assert.ok(initial.localToken);
    const payload={date:'2026-10-21',start:'19:00',end:'21:00'};
    assert.equal((await fetch(url+'/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).status,403);
    const headers={'content-type':'application/json','x-local-token':initial.localToken};
    assert.equal((await fetch(url+'/api/tasks',{method:'POST',headers:{...headers,origin:'https://evil.invalid'},body:JSON.stringify(payload)})).status,403);
    const added=await fetch(url+'/api/tasks',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(added.status,201);
    const t=await added.json() as any;assert.equal(t.status,'draft');assert.equal(t.mode,'dry-run');
    const cancelled=await fetch(url+`/api/tasks/${t.id}/cancel`,{method:'POST',headers,body:'{}'});assert.equal(cancelled.status,200);
    const invalid=await fetch(url+'/api/import',{method:'POST',headers,body:JSON.stringify([payload,{...payload,start:'19:15'}])});assert.equal(invalid.status,400);assert.equal(store.state.tasks.length,1);
    const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/羽毛球/);
    assert.equal((await fetch(url+'/data/tasks.json')).status,404);
    const badHost=await new Promise<number>(r=>{get(url+'/api/state',{headers:{host:'attacker.invalid'}},res=>{res.resume();r(res.statusCode!);});});
    assert.equal(badHost,403);
  }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await rm(dir,{recursive:true,force:true});}
});

test('两个实例的令牌、任务与冻结互不影响，状态带实例信息',async()=>{
  const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});
  const dirA=await mkdtemp(join(base,'http-a-')),dirB=await mkdtemp(join(base,'http-b-'));
  const site={preflight:async()=>{throw Error('未登录');},list:async()=>[],submit:async()=>{throw Error('不能提交');},rehearse:async()=>{throw Error('不能演练');}} as Site;
  const storeA=await Store.open(dirA),storeB=await Store.open(dirB);
  const appA=createApp(storeA,site,{instance:{port:38321,dataDir:'data'}}),appB=createApp(storeB,site,{instance:{port:38322,dataDir:'data-b'}});
  await new Promise<void>(r=>appA.server.listen(0,'127.0.0.1',r));await new Promise<void>(r=>appB.server.listen(0,'127.0.0.1',r));
  const urlA=`http://127.0.0.1:${(appA.server.address() as {port:number}).port}`,urlB=`http://127.0.0.1:${(appB.server.address() as {port:number}).port}`;
  try{
    const stateA=await (await fetch(urlA+'/api/state')).json() as any,stateB=await (await fetch(urlB+'/api/state')).json() as any;
    assert.deepEqual(stateA.instance,{port:38321,dataDir:'data'});assert.deepEqual(stateB.instance,{port:38322,dataDir:'data-b'});
    assert.notEqual(stateA.localToken,stateB.localToken);
    const payload={date:'2026-10-21',start:'19:00',end:'21:00'},headersA={'content-type':'application/json','x-local-token':stateA.localToken};
    assert.equal((await fetch(urlA+'/api/tasks',{method:'POST',headers:headersA,body:JSON.stringify(payload)})).status,201);
    assert.equal((await fetch(urlB+'/api/tasks',{method:'POST',headers:headersA,body:JSON.stringify(payload)})).status,403,'账号1令牌不能操作账号2实例');
    const stateB2=await (await fetch(urlB+'/api/state')).json() as any;assert.equal(stateB2.tasks.length,0);
    storeA.state.freeze={taskId:'x',accountId:'a',reason:'test',at:Date.now()};storeA.save();
    const stateB3=await (await fetch(urlB+'/api/state')).json() as any;assert.equal(stateB3.freeze,null,'账号1冻结不影响账号2');
    const stateA2=await (await fetch(urlA+'/api/state')).json() as any;assert.equal(stateA2.freeze.taskId,'x');
    assert.equal((await fetch(urlA)).status,200);assert.equal((await fetch(urlB)).status,200);
  }finally{
    await new Promise<void>((r,j)=>appA.server.close(e=>e?j(e):r()));await new Promise<void>((r,j)=>appB.server.close(e=>e?j(e):r()));
    await rm(dirA,{recursive:true,force:true});await rm(dirB,{recursive:true,force:true});
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireInstance} from '../src/instance.ts';
test('第二个实例必须在读取和恢复任务文件前被拒绝',async()=>{
  const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'lock-'));
  try{const release=acquireInstance(dir);assert.throws(()=>acquireInstance(dir),/运行/);release();const release2=acquireInstance(dir);release2();}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('不同数据目录可以各启动一个实例（双账号），同目录仍互斥',async()=>{
  const base=join(import.meta.dirname,'../test-results');await mkdir(base,{recursive:true});
  const dirA=await mkdtemp(join(base,'lock-a-')),dirB=await mkdtemp(join(base,'lock-b-'));
  try{
    const releaseA=acquireInstance(dirA),releaseB=acquireInstance(dirB);
    assert.throws(()=>acquireInstance(dirA),/运行/);
    releaseA();releaseB();
    const againA=acquireInstance(dirA),againB=acquireInstance(dirB);againA();againB();
  }finally{await rm(dirA,{recursive:true,force:true});await rm(dirB,{recursive:true,force:true});}
});

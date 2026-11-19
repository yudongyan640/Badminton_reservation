import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {resolveConfig,DEFAULT_PORT,DEFAULT_DATA_DIR} from '../src/config.ts';

const project=join(import.meta.dirname,'..');

test('默认配置保持旧行为：38321 端口与 data 目录',()=>{
  const c=resolveConfig(project,{});
  assert.equal(c.port,DEFAULT_PORT);
  assert.equal(c.dataDirName,DEFAULT_DATA_DIR);
  assert.equal(c.dataDir,join(project,'data'));
  assert.equal(c.url,'http://127.0.0.1:38321');
  assert.equal(c.open,false);
});

test('第二个实例可配置独立端口与数据目录',()=>{
  const c=resolveConfig(project,{BADMINTON_PORT:'38322',BADMINTON_DATA_DIR:'data-b'},['--open']);
  assert.equal(c.port,38322);
  assert.equal(c.dataDirName,'data-b');
  assert.equal(c.dataDir,join(project,'data-b'));
  assert.equal(c.url,'http://127.0.0.1:38322');
  assert.equal(c.open,true);
});

test('端口无效时拒绝启动',()=>{
  for(const bad of ['abc','0','80','70000','3832.5','38 321'])assert.throws(()=>resolveConfig(project,{BADMINTON_PORT:bad}),/端口/);
});

test('数据目录必须是项目内以 data 开头的相对目录',()=>{
  for(const bad of ['..','../outside','src','public','C:\\Windows','data/../src','data-b/../src']){
    assert.throws(()=>resolveConfig(project,{BADMINTON_DATA_DIR:bad}),/数据目录/,bad);
  }
});

test('环境变量为空时回退到默认实例',()=>{
  const c=resolveConfig(project,{BADMINTON_PORT:' ',BADMINTON_DATA_DIR:' '});
  assert.equal(c.port,DEFAULT_PORT);assert.equal(c.dataDirName,DEFAULT_DATA_DIR);
});

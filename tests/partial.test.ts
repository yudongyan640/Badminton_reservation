import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTask,confirmedBookings,coverageMinutes} from '../src/domain.ts';
const t=validateTask({date:'2026-10-19',start:'22:00',end:'23:00'});
const record=(id:string,start:string,end:string,extra={})=>({id,ownerId:'me',roomId:'r1',beginTime:`2026-10-19 ${start}:00`,endTime:`2026-10-19 ${end}:00`,status:'OPEN',...extra});
test('部分成功只接受本人在本次场地和目标范围内的真实半小时时段',()=>{
  const valid=record('new','22:30','23:00');
  const records=[valid,record('old','22:00','22:30'),record('other','22:00','22:30',{ownerId:'other'}),record('wrong','22:00','22:30',{roomId:'r2'}),record('outside','21:30','22:30')];
  const got=confirmedBookings(t,records,'me',['r1'],['old']);assert.deepEqual(got.map(b=>b.id),['new']);assert.equal(coverageMinutes(got),30);
});
test('多条连续记录覆盖完整时段，缺口不能算完整，重叠不重复计时',()=>{
  assert.equal(coverageMinutes([record('a','22:00','22:30'),record('b','22:30','23:00')]),60);
  assert.equal(coverageMinutes([record('a','22:00','22:30'),record('a','22:00','22:30')]),30);
});

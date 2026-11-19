import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTask, releaseAt, overlaps, matchesBooking, classifyResponse } from '../src/domain.ts';

const input = { date: '2026-10-21', start: '19:00', end: '21:00', mode: 'dry-run' };
test('计算预约日前一天北京时间零点，包含跨年和闰年', () => {
  assert.equal(new Date(releaseAt('2026-10-21')).toISOString(), '2026-10-19T16:00:00.000Z');
  assert.equal(new Date(releaseAt('2027-01-01')).toISOString(), '2026-12-30T16:00:00.000Z');
  assert.equal(new Date(releaseAt('2028-03-01')).toISOString(), '2028-02-28T16:00:00.000Z');
});
test('拒绝无效日期、非半小时时间、超过两小时及越界时段', () => {
  for (const change of [{ date: '2026-02-29' }, { start: '19:15' }, { end: '22:00' }, { start: '09:30' }, { end: '23:30' }, { end: '18:00' }, { mode: 'bad' }, { courtPriority: ['3'] }]) {
    assert.throws(() => validateTask({ ...input, ...change }));
  }
});
test('缺省演练模式和场地顺序，不对外部输入任务状态赋权', () => {
  const t = validateTask({ ...input, mode: undefined, status: 'succeeded', id: 'unsafe' });
  assert.equal(t.mode, 'dry-run'); assert.deepEqual(t.courtPriority, ['1','2']);
  assert.equal(t.subject, '1'); assert.equal(t.status, 'draft'); assert.notEqual(t.id, 'unsafe');
});
test('重叠时段拦截但相邻时间可分别安排', () => {
  const a=validateTask(input);
  assert.equal(overlaps(a,validateTask({...input,start:'20:30',end:'21:30'})),true);
  assert.equal(overlaps(a,validateTask({...input,start:'21:00',end:'22:00'})),false);
});
test('成功必须是本人、正确场地、完整时段和有效状态', () => {
  const t=validateTask(input), m={ id:'m1',ownerId:'me',roomId:'r1',beginTime:'2026-10-21 19:00:00',endTime:'2026-10-21 21:00:00',status:'OPEN' };
  assert.equal(matchesBooking(t,m,'me',['r1']),true);
  for(const diff of [{ownerId:'other'},{endTime:'2026-10-21 20:00:00'},{status:'CANCELLED'},{status:'UNKNOWN'},{roomId:'r2'}])
    assert.equal(matchesBooking(t,{...m,...diff},'me',['r1']),false);
});
test('秒级不一致或结束日期跨日不能被当作完整目标时段',()=>{
  const t=validateTask(input),m={id:'m1',ownerId:'me',roomId:'r1',beginTime:'2026-10-21 19:00:00',endTime:'2026-10-21 21:00:00',status:'OPEN'};
  assert.equal(matchesBooking(t,{...m,beginTime:'2026-10-21 19:00:59'},'me',['r1']),false);
  assert.equal(matchesBooking(t,{...m,endTime:'2026-10-22 21:00:00'},'me',['r1']),false);
});
test('HTTP200业务失败不算成功，5xx视为结果不明，429保留等待时间', () => {
  assert.equal(classifyResponse({status:200,body:{success:false,code:400,message:'失败'}}).kind,'unknown');
  assert.equal(classifyResponse({status:503,body:{}}).kind,'unknown');
  assert.equal(classifyResponse({status:401,body:{}}).kind,'auth');
  assert.equal(classifyResponse({status:429,body:{},retryAfter:'2'}).waitMs,2000);
  assert.equal(classifyResponse({status:200,body:{success:true,code:200,data:{id:'m1'}}}).kind,'created');
});

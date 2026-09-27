/**
 * 自检：不联网写入任何数据，验证「猫猫失败不影响签到结论」这条关键约定。
 * 用法：node scripts/self-test.mjs
 */
import assert from 'node:assert/strict';
import { runTravel, buildSummary } from '../src/tasks.mjs';
import { redactDeep } from '../src/api.mjs';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

console.log('WorkBuddy daily · 自检\n');

console.log('[1] 旅行接口不可用时，不应抛异常');
const brokenCtx = {
  endpoint: 'https://127.0.0.1:9',
  uid: 'test',
  domain: '',
  accessToken: 'test',
  trace: [],
};
let travel;
let threw = null;
try {
  travel = await runTravel(brokenCtx, { pickLocation: (l) => l[0] });
} catch (err) {
  threw = err;
}
check('runTravel 未抛异常', () => assert.equal(threw, null, `抛出了 ${threw?.message}`));
check('travel.ok 为 false', () => assert.equal(travel.ok, false));
check('travel.message 有说明', () => assert.ok(travel.message.length > 0));

console.log('\n[2] 签到成功 + 猫猫失败 → 结论仍显示签到成功、退出码为 0');
const checkin = { ok: true, message: '今天已经签到过（连续 5 天）' };
const summary = buildSummary(checkin, travel);
check('汇总里签到是 ✅', () => assert.match(summary, /签到：✅/));
check('汇总里猫猫是 ⚠️', () => assert.match(summary, /派猫出行：⚠️/));
check('退出码取 checkin.ok', () => assert.equal(checkin.ok ? 0 : 1, 0));

console.log('\n[3] 脱敏：token 类字段只保留长度');
const redacted = redactDeep({
  accessToken: 'a'.repeat(1528),
  nested: { refresh_token: 'b'.repeat(1530), ok: 'short' },
});
check('accessToken 被脱敏', () => assert.equal(redacted.accessToken, '<redacted len=1528>'));
check('refresh_token 被脱敏', () => assert.equal(redacted.nested.refresh_token, '<redacted len=1530>'));
check('普通短字符串保留', () => assert.equal(redacted.nested.ok, 'short'));

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);

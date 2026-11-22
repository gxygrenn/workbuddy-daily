// 用本机登录态（Electron 原生绑定 + at-rest 解密）查今日签到/旅行状态
// 用途：不依赖 GitHub Actions 权限，直接判断定时任务是否真跑过
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WB_AAD = Buffer.from('WB-AAD\0', 'ascii');
const FN = { file: 'WBEF1', field: 'WBEV1' };
const FC = { file: 1, field: 2 };
const u32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; };
const lp = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };
const aad = (k, s, f) => Buffer.concat([WB_AAD, Buffer.from([1]), lp(FN[f]), lp('sym-v1'), u32(s), lp(k), Buffer.from([FC[f]]), Buffer.from([0, 0])]);

function open(key, env, f) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(aad(env.keyId, env.suite, f));
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]);
}
const env = (b) => JSON.parse(Buffer.from(b, 'base64').toString('utf8'));

const pay = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
const sk = crypto.createHash('sha256').update(pay.atRestSecretKey, 'utf8').digest();

const sess = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'), 'utf8'));
const at = open(sk, env(sess.auth.accessToken.envelope), 'field').toString('utf8');

(async () => {
  const headers = {
    Authorization: 'Bearer ' + at,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const checkin = await fetch('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status', { method: 'POST', headers, body: '{}' });
  const cj = await checkin.json();
  const d = cj.data || {};
  console.log('=== 今日签到状态（本机登录态实查）===');
  console.log('today_checked_in :', d.today_checked_in);
  console.log('streak_days      :', d.streak_days);
  console.log('checkin_dates    :', JSON.stringify(d.checkin_dates));
  console.log('season           :', d.season, '|', d.activity_name);

  const travel = await fetch('https://www.workbuddy.cn/activity/growth/buddy/travel/status', { method: 'GET', headers });
  const tj = await travel.json();
  const td = tj.data || {};
  console.log('\n=== 今日旅行状态 ===');
  console.log('state             :', td.state);
  console.log('daily_limit_reached:', td.daily_limit_reached);
  console.log('record_id         :', td.record_id);
  console.log('arrive_at         :', td.arrive_at);
  console.log('reward_credit     :', td.reward_credit);
})().catch((e) => console.error('ERR', e.message));

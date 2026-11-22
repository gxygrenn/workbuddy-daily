/**
 * 本机登录凭证导出（只在你自己电脑上运行，不要上传到 GitHub）
 * ============================================================
 * 由同目录的 export-credential.cmd 自动调用，你不需要手动跑它。
 *
 * 它做三件事：
 *   1. 从 WorkBuddy 的加密登录态里解出 refreshToken
 *   2. 顺手把 refreshToken 复制到剪贴板（到 GitHub 网页上 Ctrl+V 就行）
 *   3. 同时写一份到同目录的 refresh-token.txt 作为备份
 *
 * 为什么必须借助 WorkBuddy 自己启动：
 *   WorkBuddy 的登录态在磁盘上是加密的（at-rest 加密），解密用的静态密钥由
 *   Electron 原生绑定 electron_browser_workbuddy_storage.loggerGet() 提供，
 *   只有 WorkBuddy 进程自己能拿到。所以要用
 *     ELECTRON_RUN_AS_NODE=1 WorkBuddy.exe export-credential.cjs
 *   的方式运行。
 *
 * 解密链路（已在真机验证）：
 *   loggerGet() → atRestSecretKey（base64 字符串）
 *   → staticKey = sha256(该字符串的 utf8 字节)
 *   → 登录态文件里的 accessToken / refreshToken 是 field 信封
 *     （AES-256-GCM，AAD = "WB-AAD\0" + 版本 + "WBEV1" + "sym-v1" + suite + keyId + 2）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ENDPOINT = (process.env.WB_ENDPOINT || 'https://www.workbuddy.cn').replace(/\/+$/, '');
const HERE = __dirname;
const TOKEN_FILE = path.join(HERE, 'refresh-token.txt');
const ENV_FILE = path.join(HERE, 'credentials.env');

/* ---------- at-rest 解密 ---------- */
const WB_AAD = Buffer.from('WB-AAD\0', 'ascii');
const FRAMING_NAME = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
const u32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; };
const lp = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };
const buildAad = (keyId, suite, framing) => Buffer.concat([
  WB_AAD, Buffer.from([1]), lp(FRAMING_NAME[framing]), lp('sym-v1'),
  u32(suite), lp(keyId), Buffer.from([FRAMING_CODE[framing]]), Buffer.from([0, 0]),
]);

function openEnvelope(key, envelope, framing) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(buildAad(envelope.keyId, envelope.suite, framing));
  d.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(envelope.ciphertext, 'base64')), d.final()]);
}

const parseEnvelope = (b64) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
const isEncryptedField = (v) => v && typeof v === 'object' && v.$wbEncrypted === 1 && typeof v.envelope === 'string';

/** 兼容：既支持明文，也支持 $wbEncrypted 信封 */
function readField(key, value, framing = 'field') {
  if (isEncryptedField(value)) return openEnvelope(key, parseEnvelope(value.envelope), framing).toString('utf8');
  if (typeof value === 'string') return value;
  return null;
}

/* ---------- 定位本机登录态文件 ---------- */
function authFileCandidates() {
  const home = os.homedir();
  const roots = [
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension'),
    path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension'),
    path.join(home, '.local', 'share', 'CodeBuddyExtension'),
  ];
  const names = ['workbuddy-desktop.info', 'workbuddy.info', 'auth.info'];
  const out = [];
  for (const r of roots) for (const n of names) out.push(path.join(r, 'Data', 'Public', 'auth', n));
  return out;
}

function parseAuthFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw && raw.auth && (raw.auth.accessToken || raw.auth.refreshToken)) return raw;
  const list = raw?.sessions || raw?.accounts;
  if (Array.isArray(list)) {
    const hit = list.find((s) => s?.auth?.accessToken || s?.auth?.refreshToken);
    if (hit) return hit;
  }
  return raw;
}

/* ---------- 复制到剪贴板 ---------- */
function copyToClipboard(text) {
  if (process.platform !== 'win32') return false;
  try {
    // 通过环境变量传递，避免命令行长度和引号转义问题；Set-Clipboard 不会追加换行
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:WB_CLIP'],
      { env: { ...process.env, WB_CLIP: text }, stdio: 'ignore', timeout: 20000 },
    );
    return true;
  } catch {
    return false;
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  // 1) 拿静态密钥（只有 WorkBuddy 进程内有这个原生绑定）
  let payload;
  try {
    payload = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  } catch (err) {
    console.log('');
    console.log('【失败】拿不到 WorkBuddy 的内部密钥。');
    console.log('原因通常是：没有用「双击 .cmd」的方式运行，或者 WorkBuddy 安装位置很特殊。');
    console.log('原始错误：' + err.message);
    console.log('');
    process.exit(1);
  }
  const staticKey = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();

  // 2) 找登录态文件
  const file = authFileCandidates().find((p) => fs.existsSync(p));
  if (!file) {
    console.log('');
    console.log('【失败】没找到登录态文件。尝试过：');
    authFileCandidates().forEach((p) => console.log('   ' + p));
    console.log('请先打开 WorkBuddy 客户端，确认已经登录，再重新双击本脚本。');
    console.log('');
    process.exit(1);
  }

  const session = parseAuthFile(file);
  const refreshToken = readField(staticKey, session?.auth?.refreshToken);
  const accessToken = readField(staticKey, session?.auth?.accessToken);

  if (!refreshToken) {
    console.log('');
    console.log('【失败】登录态里没有解析出 refreshToken。');
    console.log('可能是当前没有登录，或客户端加密格式发生了变化。');
    console.log('文件：' + file);
    console.log('');
    process.exit(1);
  }

  // 3) 写本地备份（不写任何到仓库里的东西）
  fs.writeFileSync(TOKEN_FILE, refreshToken, { mode: 0o600 });
  fs.writeFileSync(ENV_FILE, [
    '# WorkBuddy 每日任务凭证 —— 只存在你本机，请勿上传或提交',
    `# 生成时间：${new Date().toISOString()}`,
    `# 来源文件：${file}`,
    '',
    `WB_REFRESH_TOKEN=${refreshToken}`,
    `WB_ENDPOINT=${ENDPOINT}`,
    '',
  ].join('\n'), { mode: 0o600 });

  const copied = copyToClipboard(refreshToken);

  console.log('');
  console.log('=================================================================');
  console.log('  凭证导出成功');
  console.log('=================================================================');
  console.log(`  refreshToken 长度 ：${refreshToken.length}`);
  console.log(`  来源文件          ：${file}`);
  console.log(`  本地备份          ：${TOKEN_FILE}`);
  console.log(`  已复制到剪贴板    ：${copied ? '是（到 GitHub 网页上直接 Ctrl+V）' : '否（请手动打开上面那个 refresh-token.txt 复制）'}`);
  console.log('');

  // 4) 只读自检：确认这个凭证是活的
  if (accessToken) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    try {
      const r = await fetch(`${ENDPOINT}/v2/billing/meter/checkin-activity-status`, {
        method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      const d = j?.data ?? {};
      if (j?.code === 0) {
        console.log('  ── 自检（只读，不会改动任何数据）──');
        console.log(`  活动      ：${d.theme_name ?? '-'} · 第 ${d.season ?? '-'} 期 · ${d.activity_name ?? '-'}`);
        console.log(`  今日签到  ：${d.today_checked_in ? '已签到' : '未签到'} · 连续 ${d.streak_days ?? 0} 天 · 累计 ${d.total_credits ?? 0} 积分`);
        try {
          const t = await fetch(`${ENDPOINT}/activity/growth/buddy/travel/status`, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
          const td = (await t.json())?.data ?? {};
          console.log(`  猫猫旅行  ：状态=${td.state ?? '-'} · 今日已派=${td.daily_limit_reached ? '是' : '否'}`);
        } catch { /* 自检失败不影响导出 */ }
      } else {
        console.log(`  ⚠️ 自检返回 code=${j?.code}（${j?.msg ?? ''}）。本机 accessToken 可能已过期，`);
        console.log('     但 refreshToken 通常仍然有效，可以继续按教程填入 Secret。');
      }
    } catch (err) {
      console.log(`  ⚠️ 自检请求失败（不影响导出）：${err.message}`);
    }
  } else {
    console.log('  ⚠️ 本机没取到 accessToken，跳过自检。');
  }

  console.log('');
  console.log('-----------------------------------------------------------------');
  console.log('  下一步：');
  console.log(`  1. 浏览器打开你的 GitHub 仓库 → Settings → Secrets and variables → Actions`);
  console.log(`  2. 点 New repository secret`);
  console.log(`     Name  填：WB_REFRESH_TOKEN`);
  console.log(`     Secret 填：${copied ? '直接 Ctrl+V（已在你剪贴板里）' : `打开 ${TOKEN_FILE} 复制里面的内容`}`);
  console.log(`  3. 点 Add secret，完成。`);
  console.log('-----------------------------------------------------------------');
  console.log('');
  console.log('  提醒：refresh-token.txt 和 credentials.env 里是明文凭证。');
  console.log('        请不要把这两个文件上传到 GitHub，也不要发给任何人。');
  console.log('');
}

main().catch((err) => {
  console.log('');
  console.log('【失败】导出过程出错：', err && err.message ? err.message : err);
  console.log('');
  process.exit(1);
});

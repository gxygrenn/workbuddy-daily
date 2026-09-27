/**
 * 本地凭证导出（只在你自己电脑上跑）。
 *
 * 为什么必须跑在 WorkBuddy 里：WorkBuddy 的登录态在磁盘上是加密的（at-rest 加密），
 * 解密用的静态密钥由 Electron 原生绑定 electron_browser_workbuddy_storage.loggerGet()
 * 提供 —— 只有 WorkBuddy 进程自己能拿到。所以本脚本要用
 *   ELECTRON_RUN_AS_NODE=1 WorkBuddy.exe export-credential.cjs
 * 的方式运行（见同目录的 export-credential.sh / .cmd）。
 *
 * 产出：refreshToken / accessToken / uid，用于写入仓库 Secret。
 * 明文只写进本地 .local/credentials.env（已被 .gitignore 忽略），绝不进仓库。
 *
 * 解密链路（已在真机验证）：
 *   loggerGet() → atRestSecretKey(base64 字符串)
 *   → staticKey = sha256(该字符串的 utf8 字节)
 *   → auth 文件里 accessToken/refreshToken 是 field-framing 信封（AES-256-GCM，
 *     AAD = "WB-AAD\0" + 版本 + framingName + "sym-v1" + suite + keyId + framingCode）
 *   → 用 staticKey + WBEV1 解开
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ENDPOINT = (process.env.WB_ENDPOINT || 'https://www.workbuddy.cn').replace(/\/+$/, '');
const OUT_DIR = path.join(__dirname, '..', '.local');
const OUT_FILE = path.join(OUT_DIR, 'credentials.env');

// ---------- at-rest 解密 ----------
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

function isEncryptedField(v) {
  return v && typeof v === 'object' && v.$wbEncrypted === 1 && typeof v.envelope === 'string';
}

/** 兼容：既支持明文，也支持 $wbEncrypted 信封 */
function readField(key, value, framing = 'field') {
  if (isEncryptedField(value)) return openEnvelope(key, parseEnvelope(value.envelope), framing).toString('utf8');
  if (typeof value === 'string') return value;
  return null;
}

// ---------- 定位本机文件 ----------
function configDir() {
  return process.env.CODEBUDDY_CONFIG_DIR || process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy');
}

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
  // 可能直接是 session，也可能包一层 { sessions: [...] }
  if (raw && raw.auth && (raw.auth.accessToken || raw.auth.refreshToken)) return raw;
  const list = raw?.sessions || raw?.accounts;
  if (Array.isArray(list)) {
    const hit = list.find((s) => s?.auth?.accessToken || s?.auth?.refreshToken);
    if (hit) return hit;
  }
  return raw;
}

// ---------- 主流程 ----------
async function main() {
  const verify = !process.argv.includes('--no-verify');

  // 1) 拿静态密钥（只有 WorkBuddy 进程内有这个原生绑定）
  let payload;
  try {
    payload = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  } catch (err) {
    console.error('❌ 拿不到 WorkBuddy 原生存储绑定。请确认脚本是通过 WorkBuddy 自带运行时启动的：');
    console.error('   ELECTRON_RUN_AS_NODE=1 "<WorkBuddy 安装目录>/WorkBuddy.exe" scripts/export-credential.cjs');
    console.error('   （推荐直接用 scripts/export-credential.sh 或 .cmd，会自己找路径）');
    console.error('   原始错误：' + err.message);
    process.exit(1);
  }
  const staticKey = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();

  // 2) 找登录态文件
  const file = authFileCandidates().find((p) => fs.existsSync(p));
  if (!file) {
    console.error('❌ 没找到登录态文件，尝试过：');
    authFileCandidates().forEach((p) => console.error('   ' + p));
    console.error('   请先打开 WorkBuddy 客户端并确认已登录。');
    process.exit(1);
  }

  const session = parseAuthFile(file);
  const refreshToken = readField(staticKey, session?.auth?.refreshToken);
  const accessToken = readField(staticKey, session?.auth?.accessToken);
  const uid = session?.account?.uid || session?.auth?.uid || '';

  if (!refreshToken || !uid) {
    console.error('❌ 登录态里没有解析出 refreshToken / uid。可能是加密格式变了，或当前未登录。');
    console.error(`   文件：${file}`);
    process.exit(1);
  }

  // 3) 写本地文件（gitignore 已忽略 .local/）
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const envText = [
    '# WorkBuddy 每日任务凭证 —— 本文件只存在你本机，已被 .gitignore 忽略，请勿提交',
    `# 生成时间：${new Date().toISOString()}`,
    `# 来源文件：${file}`,
    '',
    `WB_REFRESH_TOKEN=${refreshToken}`,
    `WB_ACCESS_TOKEN=${accessToken || ''}`,
    `WB_USER_ID=${uid}`,
    `WB_ENDPOINT=${ENDPOINT}`,
    '',
  ].join('\n');
  fs.writeFileSync(OUT_FILE, envText, { mode: 0o600 });

  console.log('✅ 凭证已导出\n');
  console.log('  uid            : ' + uid);
  console.log('  refreshToken   : ' + `长度 ${refreshToken.length}（不在此回显）`);
  console.log('  accessToken    : ' + (accessToken ? `长度 ${accessToken.length}（不在此回显）` : '未取得'));
  console.log('  登录态文件     : ' + file);
  console.log('  本地输出       : ' + OUT_FILE);
  console.log('');

  // 4) 可选：只读校验一下凭证可用
  if (verify && accessToken) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-User-Id': encodeURIComponent(uid),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    try {
      const r = await fetch(`${ENDPOINT}/v2/billing/meter/checkin-activity-status`, {
        method: 'POST', headers, body: '{}',
      });
      const j = await r.json();
      const d = j?.data ?? {};
      console.log(`🔎 连通性自检：HTTP ${r.status} / code ${j?.code}`);
      console.log(`   活动：${d.theme_name ?? '-'}（第 ${d.season ?? '-'} 期 · ${d.activity_name ?? '-'}）`);
      console.log(`   今日已签到：${d.today_checked_in ? '是' : '否'} · 连续 ${d.streak_days ?? 0} 天 · 累计 ${d.total_credits ?? 0} 积分`);
      const t = await fetch(`${ENDPOINT}/activity/growth/buddy/travel/status`, { method: 'GET', headers });
      const tj = await t.json();
      const td = tj?.data ?? {};
      console.log(`   猫猫旅行：state=${td.state ?? '-'} · 今日已派=${td.daily_limit_reached ? '是' : '否'}`);
      if (td.state === 'traveling') console.log(`   预计到家：${new Date((td.arrive_at || 0) * 1000).toISOString()}`);
    } catch (err) {
      console.log(`⚠️ 自检请求失败（不影响凭证导出）：${err.message}`);
    }
    console.log('');
  }

  console.log('下一步：把下面三项填进 GitHub 仓库的 Secrets');
  console.log('  Settings → Secrets and variables → Actions → New repository secret');
  console.log('  ┌ WB_REFRESH_TOKEN   （从 ' + path.relative(process.cwd(), OUT_FILE) + ' 里复制）');
  console.log('  ├ WB_USER_ID         ' + uid);
  console.log('  └ WB_ENDPOINT        ' + ENDPOINT + '   （可选，默认就是它）');
  console.log('');
  console.log('  想让 refreshToken 自动轮换回写（长期免维护），再额外加一个：');
  console.log('  └ GH_SECRETS_PAT     细粒度 PAT，仅需勾选本仓库的 Secrets: Read and write');
}

main().catch((err) => {
  console.error('❌ 导出失败：', err);
  process.exit(1);
});

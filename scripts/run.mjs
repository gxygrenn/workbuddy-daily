/**
 * 云端入口：一次跑完「刷新登录态 → 签到 → 领旅行奖励 → 派猫出行」。
 *
 * 退出码约定（对应用户需求：猫猫失败不影响签到结论）
 *   0 = 签到成功（含「今天已签到」），猫猫部分无论成败都不改变退出码
 *   1 = 签到失败
 *
 * 环境变量（都从 GitHub Secrets 注入，禁止明文落盘）
 *   WB_REFRESH_TOKEN   必填，本地导出脚本产出
 *   WB_USER_ID         必填，本地导出脚本产出
 *   WB_ENDPOINT        可选，默认 https://www.workbuddy.cn
 *   WB_ACCESS_TOKEN    可选，仅当刷新失败时兜底
 *   GH_SECRETS_PAT     可选，配置后会自动把轮换的新 refreshToken 回写 secret
 *
 * 用法：node scripts/run.mjs [--dry-run]
 */
import { resolveEndpoint, redactDeep } from '../src/api.mjs';
import { refreshAccessToken, persistRefreshToken } from '../src/auth.mjs';
import { runCheckin, runTravel, buildSummary } from '../src/tasks.mjs';

const dryRun = process.argv.includes('--dry-run');

/** 在 Actions 日志里给动态值打码，避免意外外泄 */
function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::add-mask::${value}\n`);
  }
}

function log(line = '') {
  process.stdout.write(line + '\n');
}

/** 目的地按「一年中的第几天」轮换，避免每天都去同一处 */
function pickByDay(locations) {
  const day = Math.floor(Date.now() / 86_400_000);
  return locations[day % locations.length];
}

async function main() {
  const ctx = {
    endpoint: resolveEndpoint(),
    uid: process.env.WB_USER_ID || '',
    domain: '',
    refreshToken: process.env.WB_REFRESH_TOKEN || '',
    accessToken: process.env.WB_ACCESS_TOKEN || '',
    dryRun,
    trace: [],
  };

  log('=== WorkBuddy 每日任务 ===');
  log(`时间：${new Date().toISOString()}`);
  log(`端点：${ctx.endpoint}`);
  log(`模式：${dryRun ? 'dry-run（只读，不写入）' : '实跑'}`);
  log('');

  mask(ctx.refreshToken);
  mask(ctx.accessToken);

  if (!ctx.uid) {
    log('❌ 缺少 WB_USER_ID，请先运行本地凭证导出脚本。');
    process.exit(1);
  }
  if (!ctx.refreshToken) {
    log('❌ 缺少 WB_REFRESH_TOKEN，请先运行本地凭证导出脚本。');
    process.exit(1);
  }

  // —— 步骤 1：刷新 accessToken ——
  let refreshInfo = null;
  try {
    const r = await refreshAccessToken(ctx);
    ctx.accessToken = r.accessToken;
    mask(r.accessToken);
    if (r.refreshToken) mask(r.refreshToken);
    refreshInfo = r;
    log(`✅ 登录态已刷新（accessToken 有效期 ${Math.round((r.expiresIn ?? 0) / 3600)} 小时）`);
    if (r.rotated) {
      const wb = ctx.dryRun
        ? { saved: false, reason: 'dry-run 不回写' }
        : await persistRefreshToken(ctx, r.refreshToken);
      if (wb.saved) {
        log(`✅ 轮换后的 refreshToken 已回写 secret「${wb.secretName}」`);
      } else {
        log(`ℹ️ refreshToken 已轮换但未回写：${wb.reason}`);
        log('   （配置 GH_SECRETS_PAT 后可自动回写；否则请在约 60 天内重跑一次本地导出脚本）');
      }
    }
  } catch (err) {
    if (ctx.accessToken) {
      log(`⚠️ 刷新失败，回退使用 WB_ACCESS_TOKEN：${err.message}`);
    } else {
      log(`❌ ${err.message}`);
      process.exit(1);
    }
  }
  log('');

  // —— 步骤 2：签到 ——
  let checkin;
  try {
    checkin = await runCheckin(ctx);
  } catch (err) {
    checkin = { ok: false, message: `签到异常：${err.message}` };
  }
  log(`【签到】${checkin.ok ? '✅' : '❌'} ${checkin.message}`);

  // —— 步骤 3：派猫出行（独立兜底，任何异常都不影响签到结论）——
  let travel;
  try {
    travel = await runTravel(ctx, { pickLocation: pickByDay });
  } catch (err) {
    travel = { ok: false, message: `派猫异常：${err.message}`, claimed: null, departed: null };
  }
  log(`【旅行】${travel.ok ? '✅' : '⚠️'} ${travel.message}`);

  // —— 汇总 ——
  log('');
  log('=== 结论 ===');
  log(buildSummary(checkin, travel));

  // —— 原始返回（脱敏）——
  log('');
  log('=== 原始返回（脱敏）===');
  for (const t of ctx.trace) {
    log(`--- ${t.method} ${t.path} → HTTP ${t.status}`);
    log(JSON.stringify(redactDeep(t.body), null, 2));
  }

  // —— GitHub Actions Step Summary ——
  const summary = [
    '## WorkBuddy 每日任务',
    '',
    buildSummary(checkin, travel),
    '',
    `<sub>运行于 ${new Date().toISOString()} · 模式 ${dryRun ? 'dry-run' : 'live'}</sub>`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }

  process.exit(checkin.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('未捕获异常：', err);
  process.exit(1);
});

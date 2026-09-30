#!/usr/bin/env node
/**
 * WorkBuddy 每日任务 —— 单文件版
 * ============================================================
 * 一次跑完：刷新登录态 → 签到 → 领取已到家的旅行积分 → 判断并派出新一趟
 *
 * 特点：整个脚本只有这一个文件，没有任何本地依赖、不需要 npm install。
 *       直接 `node wb-daily.mjs` 就能跑。
 *
 * 退出码约定（对应「猫猫失败不影响签到结论」）
 *   0 = 签到成功（含「今天已签到」）。猫猫无论成败都不改变退出码。
 *   1 = 签到失败，或登录态不可用。
 *
 * 环境变量（在 GitHub 仓库的 Secrets 里配置，不要写进代码）
 *   WB_REFRESH_TOKEN   必填。由「export-credential.cmd」产出。
 *   WB_ENDPOINT        可选。默认 https://www.workbuddy.cn
 *   WB_ACCESS_TOKEN    可选。仅当刷新失败时兜底（一般不填）。
 *   WB_STATE_DIR       可选。轮换后的登录态落盘目录（配合 Actions Cache 使用）。
 *   GH_SECRETS_PAT     可选。填了就把轮换后的新 token 自动回写 Secret，彻底免维护。
 *
 * 接口出处（都以客户端/网页版真实发出的请求为准，非网上流传的旧接口名）
 *   刷新登录态  POST /v2/plugin/auth/token/refresh      ← app.asar → code-cache.js
 *   签到状态    POST /v2/billing/meter/checkin-activity-status ← app.asar → main/tar.js
 *   签到领取    POST /v2/billing/meter/daily-checkin    ← app.asar → main/tar.js
 *   旅行状态    GET  /activity/growth/buddy/travel/status
 *   旅行配置    GET  /activity/growth/buddy/travel/config
 *   派出旅行    POST /activity/growth/buddy/travel/depart   body { location_id }
 *   领取奖励    POST /activity/growth/buddy/travel/claim
 *   （后四条取自网页版成长中心前端包 growthSpace-*.js 里真实的 axios 调用）
 *
 * 用法
 *   node wb-daily.mjs              实跑
 *   node wb-daily.mjs --dry-run    只读，不签到、不派猫，仅校验凭证与状态
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import nodePath from 'node:path';

const VERSION = '2.0.0';

/* ============================================================
 * 1. 常量与配置
 * ============================================================ */

/** 云端 API base。来自 cli/product.json 的 endpoint 字段。 */
const DEFAULT_ENDPOINT = 'https://www.workbuddy.cn';

const PATHS = {
  tokenRefresh: '/v2/plugin/auth/token/refresh',
  checkinStatus: '/v2/billing/meter/checkin-activity-status',
  checkinClaim: '/v2/billing/meter/daily-checkin',
  travelConfig: '/activity/growth/buddy/travel/config',
  travelStatus: '/activity/growth/buddy/travel/status',
  travelDepart: '/activity/growth/buddy/travel/depart',
  travelClaim: '/activity/growth/buddy/travel/claim',
};

/** 旅行状态机：idle（在家，可派）→ traveling（在路上）→ arrived（到家，可领） */
const TRAVEL_STATE = { IDLE: 'idle', TRAVELING: 'traveling', ARRIVED: 'arrived' };

/** 业务码：今天已签到 */
const CODE_ALREADY_CHECKED_IN = 10001;

/* ============================================================
 * 2. 基础工具
 * ============================================================ */

function log(line = '') {
  process.stdout.write(line + '\n');
}

/** 在 Actions 日志里给动态值打码，避免意外外泄 */
function mask(value) {
  if (value && process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::add-mask::${value}\n`);
  }
}

function resolveEndpoint(env = process.env) {
  const raw = (env.WB_ENDPOINT || DEFAULT_ENDPOINT).trim();
  return raw.replace(/\/+$/, '');
}

function authority(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}

/**
 * 统一请求封装。返回 { status, body }。
 *
 * 关键约定：**永不抛异常**。网络不通 / DNS 失败 / 超时都归一化成
 * status=0 + body.code=-1，让调用方（尤其是猫猫那条链路）能优雅降级，
 * 不会把整个任务带崩。
 */
async function request(ctx, method, urlPath, { body, headers, timeoutMs = 20000 } = {}) {
  const url = ctx.endpoint + urlPath;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {}),
        // X-User-Id 实测非必需（不带也返回 200），仅在明确提供时才发送
        ...(ctx.uid ? { 'X-User-Id': encodeURIComponent(ctx.uid) } : {}),
        ...(ctx.domain ? { 'X-Domain': ctx.domain } : {}),
        ...headers,
      },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body ?? {}),
      // Node 18+ 原生支持；超时不会抛到外层，被下面的 catch 归一化
      signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    const msg = `网络错误 ${method} ${urlPath}：${err?.cause?.message || err.message}`;
    const failed = { status: 0, body: { code: -1, msg } };
    if (ctx.trace) ctx.trace.push({ method, path: urlPath, status: 0, body: failed.body });
    return failed;
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text.slice(0, 500) };
  }
  if (ctx.trace) ctx.trace.push({ method, path: urlPath, status: res.status, body: parsed });
  return { status: res.status, body: parsed };
}

/** 业务成功判定：HTTP 2xx 且 envelope.code === 0 */
function isOk(result) {
  return result.status >= 200 && result.status < 300 && result.body?.code === 0;
}

/** 脱敏：长字符串只保留长度 */
function redact(value) {
  if (typeof value !== 'string') return value;
  if (value.length > 64) return `<已隐藏 长度${value.length}>`;
  return value;
}

/** 递归脱敏对象里的 token / secret 类字段 */
function redactDeep(input, depth = 0) {
  if (depth > 8) return '<层级过深>';
  if (typeof input === 'string') return redact(input);
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => redactDeep(v, depth + 1));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (/token|secret|authorization|password|cookie/i.test(k)) {
        out[k] = typeof v === 'string' ? `<已隐藏 长度${v.length}>` : '<已隐藏>';
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

/* ============================================================
 * 3. 登录态落盘（配合 GitHub Actions Cache，实现免维护轮换）
 * ============================================================ */

function stateDir() {
  return process.env.WB_STATE_DIR || nodePath.resolve('.wb-state');
}

function stateFile() {
  return nodePath.join(stateDir(), 'token.json');
}

function loadState() {
  try {
    const file = stateFile();
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
    writeFileSync(stateFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    log(`ℹ️ 登录态落盘失败（不影响本次任务）：${err.message}`);
    return false;
  }
}

/* ============================================================
 * 4. 鉴权
 * ============================================================ */

/**
 * 用 refreshToken 换 accessToken。
 * 实测：refreshToken 会轮换，accessToken 30 天、refreshToken 60 天。
 */
async function refreshAccessToken(ctx) {
  const rt = ctx.refreshToken;
  if (!rt) throw new Error('缺少登录凭证：请先在本机双击「export-credential.cmd」，把结果填进仓库 Secret');

  const result = await request(ctx, 'POST', PATHS.tokenRefresh, {
    body: {},
    headers: {
      'X-Refresh-Token': rt,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': authority(ctx.endpoint),
    },
  });

  if (!isOk(result)) {
    const code = result.body?.code ?? result.status;
    const msg = result.body?.msg ?? result.body?.message ?? 'unknown';
    throw new Error(`刷新登录态失败（HTTP ${result.status} / code ${code}）：${msg}`);
  }

  const d = result.body.data ?? {};
  const rotated = !!d.refreshToken && d.refreshToken !== rt;
  if (d.domain) ctx.domain = d.domain;

  return {
    accessToken: d.accessToken,
    refreshToken: d.refreshToken,
    expiresIn: d.expiresIn,
    refreshExpiresIn: d.refreshExpiresIn,
    domain: d.domain,
    rotated,
  };
}

/**
 * 可选的「彻底免维护」：把新 refreshToken 回写仓库 Secret。
 * 需要仓库里额外配置 GH_SECRETS_PAT（细粒度 PAT，权限只需 Secrets: Read and write）。
 * 值在本地用仓库公钥做 sealed-box 加密后上传，明文不出现在日志里。
 */
async function persistRefreshToken(newRefreshToken) {
  const repo = process.env.GITHUB_REPOSITORY;
  const pat = process.env.GH_SECRETS_PAT;
  const secretName = process.env.WB_REFRESH_SECRET_NAME || 'WB_REFRESH_TOKEN';

  if (!pat) return { saved: false, reason: '未配置 GH_SECRETS_PAT' };
  if (!repo) return { saved: false, reason: '不在 GitHub Actions 环境中' };

  let sodium;
  try {
    sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
  } catch (err) {
    return { saved: false, reason: `加密库不可用（${err.message}）` };
  }

  const ghHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workbuddy-daily',
  };

  const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, { headers: ghHeaders });
  if (!keyRes.ok) return { saved: false, reason: `获取仓库公钥失败 HTTP ${keyRes.status}` };
  const { key, key_id } = await keyRes.json();

  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const encrypted_value = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(newRefreshToken), binKey),
    sodium.base64_variants.ORIGINAL,
  );

  const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${secretName}`, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value, key_id }),
  });

  if (putRes.status === 201 || putRes.status === 204) return { saved: true, secretName };
  const detail = await putRes.text();
  return { saved: false, reason: `回写失败 HTTP ${putRes.status}: ${detail.slice(0, 200)}` };
}

/* ============================================================
 * 5. 签到
 * ============================================================ */

async function runCheckin(ctx) {
  const out = { name: 'checkin', ok: false, already: false, status: null, claim: null, message: '' };

  const st = await request(ctx, 'POST', PATHS.checkinStatus, { body: {} });
  if (!isOk(st)) {
    out.message = `读取签到状态失败：HTTP ${st.status} / code ${st.body?.code} ${st.body?.msg ?? ''}`;
    return out;
  }
  const s = st.body.data ?? {};
  out.status = {
    active: s.active,
    today_checked_in: s.today_checked_in,
    streak_days: s.streak_days,
    daily_credit: s.daily_credit,
    today_credit: s.today_credit,
    total_credits: s.total_credits,
    theme_name: s.theme_name,
    season: s.season,
    activity_name: s.activity_name,
    start_time: s.start_time,
    end_time: s.end_time,
  };

  if (s.active === false) {
    out.ok = true; // 活动不在期，不算失败
    out.message = '签到活动当前不在进行中，跳过';
    return out;
  }
  if (s.today_checked_in === true) {
    out.ok = true;
    out.already = true;
    out.message = `今天已经签到过（连续 ${s.streak_days} 天），无需重复领取`;
    return out;
  }

  if (ctx.dryRun) {
    out.ok = true;
    out.message = `[只读模式] 本可领取今日签到（${s.daily_credit} 积分，连续 ${(s.streak_days ?? 0) + 1} 天）`;
    return out;
  }

  const cl = await request(ctx, 'POST', PATHS.checkinClaim, { body: {} });
  const code = cl.body?.code;
  if (isOk(cl)) {
    out.ok = true;
    out.claim = {
      credit: cl.body.data?.credit ?? s.daily_credit,
      streak_days: cl.body.data?.streak_days ?? s.streak_days,
      is_streak_day: cl.body.data?.is_streak_day ?? false,
    };
    out.message = `签到成功，获得 ${out.claim.credit} 积分（连续 ${out.claim.streak_days} 天）`;
    return out;
  }
  if (code === CODE_ALREADY_CHECKED_IN) {
    out.ok = true;
    out.already = true;
    out.message = `今天已经签到过：${cl.body?.msg ?? ''}`;
    return out;
  }
  out.message = `签到失败：HTTP ${cl.status} / code ${code} ${cl.body?.msg ?? ''}`;
  out.claim = { code, msg: cl.body?.msg };
  return out;
}

/* ============================================================
 * 6. 派猫出行
 * ============================================================ */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function fmtTime(sec) {
  if (!sec) return '-';
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

async function fetchTravelStatus(ctx) {
  const r = await request(ctx, 'GET', PATHS.travelStatus);
  if (!isOk(r)) return { data: null, error: `HTTP ${r.status} / code ${r.body?.code} ${r.body?.msg ?? ''}` };
  return { data: r.body.data ?? {}, error: null };
}

function describeStatus(s) {
  if (!s) return '读取失败';
  const parts = [`状态=${s.state}`];
  if (s.state === TRAVEL_STATE.TRAVELING) {
    parts.push(`目的地=${s.location?.name ?? s.location?.code ?? '?'}`, `预计到家=${fmtTime(s.arrive_at)}`);
  }
  if (s.state === TRAVEL_STATE.ARRIVED) {
    parts.push(`可领积分=${s.reward_credit ?? 0}`);
  }
  parts.push(`今日已派=${s.daily_limit_reached ? '是' : '否'}`);
  return parts.join('，');
}

/**
 * 旅行主流程。顺序严格按需求：**先领掉已到家的积分，再判断能不能派新的一趟**。
 * 任何一步失败都不抛异常，只把 ok 置为 false，交给上层决定（不影响签到结论）。
 */
async function runTravel(ctx, { pickLocation } = {}) {
  const out = { name: 'travel', ok: false, claimed: null, departed: null, before: null, after: null, message: '' };

  let fetched = await fetchTravelStatus(ctx);
  let st = fetched.data;
  out.before = st;
  if (!st) {
    out.message = `读取旅行状态失败：${fetched.error}`;
    return out;
  }

  // —— 第 1 步：先领掉「已经到家」的积分 ——
  if (st.state === TRAVEL_STATE.ARRIVED) {
    if (ctx.dryRun) {
      out.claimed = { skipped: '只读模式不执行领取' };
    } else {
      const c = await request(ctx, 'POST', PATHS.travelClaim, { body: {} });
      if (isOk(c)) {
        out.claimed = {
          reward_credit: c.body.data?.reward_credit ?? st.reward_credit ?? 0,
          letter: c.body.data?.letter ?? null,
        };
      } else {
        out.claimed = { error: `HTTP ${c.status} / code ${c.body?.code} ${c.body?.msg ?? ''}` };
      }
      fetched = await fetchTravelStatus(ctx);
      st = fetched.data ?? st;
    }
  }

  // —— 第 2 步：判断能不能派新的一趟 ——
  out.after = st;
  if (st.state === TRAVEL_STATE.TRAVELING) {
    out.ok = true;
    out.message = `猫猫正在旅途中，不重复派出（${describeStatus(st)}）`;
    return out;
  }
  if (st.daily_limit_reached === true) {
    out.ok = true;
    out.message = `今天已经派过一趟了，明天再来（${describeStatus(st)}）`;
    return out;
  }
  if (st.state !== TRAVEL_STATE.IDLE) {
    out.ok = true;
    out.message = `当前状态 ${st.state}，跳过派猫`;
    return out;
  }

  // —— 第 3 步：挑一个目的地派出 ——
  const cfg = await request(ctx, 'GET', PATHS.travelConfig);
  const locations = isOk(cfg) ? (cfg.body.data?.locations ?? []) : [];
  if (!locations.length) {
    out.message = '拿不到可用目的地列表，跳过派猫';
    return out;
  }
  const chosen = pickLocation ? pickLocation(locations) : locations[0];

  if (ctx.dryRun) {
    out.ok = true;
    out.departed = { skipped: '只读模式不执行派出' };
    out.message = `[只读模式] 本可派猫 → ${chosen.name}`;
    return out;
  }

  const dep = await request(ctx, 'POST', PATHS.travelDepart, { body: { location_id: chosen.id } });
  if (isOk(dep)) {
    const ns = dep.body.data?.state ? dep.body.data : (await fetchTravelStatus(ctx)).data;
    out.departed = {
      location_id: chosen.id,
      location_name: chosen.name,
      state: ns?.state,
      arrive_at: ns?.arrive_at,
      duration_hours: ns?.duration_hours,
      reward_credit: ns?.reward_credit,
    };
    out.ok = true;
    out.message = `派猫成功 → ${chosen.name}，预计 ${fmtTime(ns?.arrive_at)} 到家`;
    return out;
  }

  // 失败归一化（文案对齐网页版 GrowthCenterPage 的错误处理）
  const code = dep.body?.code;
  const msg = dep.body?.msg ?? '';
  if (dep.status === 429 || /daily limit/i.test(msg)) {
    out.ok = true;
    out.message = '猫猫今天累啦，明天再来吧（触发每日上限）';
  } else if (/already traveling/i.test(msg)) {
    out.ok = true;
    out.message = '猫猫已在旅途中，跳过';
  } else if (/no active buddy/i.test(msg)) {
    out.message = '账号还没有激活的猫猫，请先在客户端领取';
  } else if (/location not available/i.test(msg)) {
    out.message = `地点「${chosen.name}」当前不可用`;
  } else {
    out.message = `派猫失败：HTTP ${dep.status} / code ${code} ${msg}`;
  }
  out.departed = { error: out.message };
  return out;
}

/* ============================================================
 * 7. 汇总
 * ============================================================ */

function buildSummary(checkin, travel) {
  const lines = [];
  lines.push(`签到：${checkin.ok ? '成功' : '失败'} — ${checkin.message}`);
  if (travel.claimed?.error) {
    lines.push(`旅行奖励：领取失败 ${travel.claimed.error}`);
  } else if (travel.claimed?.skipped) {
    lines.push(`旅行奖励：${travel.claimed.skipped}`);
  } else if (travel.claimed) {
    lines.push(`旅行奖励：已领取 ${travel.claimed.reward_credit} 积分`);
  }
  lines.push(`派猫出行：${travel.ok ? '成功' : '异常'} — ${travel.message}`);
  if (travel.departed?.arrive_at) {
    lines.push(`预计到家：${fmtTime(travel.departed.arrive_at)}`);
  }
  return lines.join('\n');
}

/* ============================================================
 * 8. 入口
 * ============================================================ */

/** 目的地按「一年中的第几天」轮换，避免每天都去同一处 */
function pickByDay(locations) {
  const day = Math.floor(Date.now() / 86400000);
  return locations[day % locations.length];
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // 登录凭证优先取「上一次轮换后落盘的新值」，没有才用 Secret 里的初始值
  const state = loadState();
  const stateToken = state.refreshToken || '';
  const envToken = process.env.WB_REFRESH_TOKEN || '';
  const refreshToken = stateToken || envToken;

  const ctx = {
    endpoint: resolveEndpoint(),
    uid: process.env.WB_USER_ID || '',
    domain: '',
    refreshToken,
    accessToken: process.env.WB_ACCESS_TOKEN || '',
    dryRun,
    trace: [],
  };

  log('=================================================================');
  log(`WorkBuddy 每日任务 v${VERSION}`);
  log(`时间：${new Date().toISOString()}`);
  log(`端点：${ctx.endpoint}`);
  log(`模式：${dryRun ? '只读模式（不签到、不派猫）' : '正式执行'}`);
  log(`凭证来源：${stateToken ? '上次轮换落盘的新登录态' : '仓库 Secret'}`);
  log('=================================================================');

  mask(refreshToken);
  mask(ctx.accessToken);

  if (!refreshToken) {
    log('');
    log('失败：没有拿到登录凭证。');
    log('请在本机双击「export-credential.cmd」，把输出的 WB_REFRESH_TOKEN 填进仓库 Secret。');
    process.exit(1);
  }

  // —— 步骤 1：刷新 accessToken ——
  try {
    const r = await refreshAccessToken(ctx);
    ctx.accessToken = r.accessToken;
    mask(r.accessToken);
    if (r.refreshToken) mask(r.refreshToken);
    log('');
    log(`登录态已刷新（accessToken 有效期约 ${Math.round((r.expiresIn ?? 0) / 3600)} 小时）`);

    if (r.rotated) {
      // a) 落盘，交给 Actions Cache 保存，下次直接复用 —— 零配置的自动续期
      const saved = dryRun ? false : saveState({ refreshToken: r.refreshToken });
      if (saved) log('轮换后的新登录态已落盘（将由 Actions 缓存保存）');

      // b) 可选：同时回写仓库 Secret —— 缓存被清理时仍能兜底
      if (dryRun) {
        log('只读模式：不落盘、不回写');
      } else {
        const wb = await persistRefreshToken(r.refreshToken);
        if (wb.saved) {
          log(`轮换后的新登录态已回写 Secret「${wb.secretName}」`);
        } else {
          log(`未回写 Secret：${wb.reason}`);
        }
      }

      if (r.refreshExpiresIn) {
        const days = Math.round(r.refreshExpiresIn / 86400);
        const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
        log(`本次刷新得到的登录态有效期约 ${days} 天（至 ${until}）`);
      }
    }
  } catch (err) {
    if (ctx.accessToken) {
      log('');
      log(`刷新失败，回退使用 WB_ACCESS_TOKEN：${err.message}`);
    } else {
      log('');
      log(`失败：${err.message}`);
      if (stateToken && envToken) {
        log('提示：缓存里的登录态可能已失效。请在本机重新双击「export-credential.cmd」更新 Secret。');
      }
      process.exit(1);
    }
  }

  // —— 步骤 2：签到 ——
  let checkin;
  try {
    checkin = await runCheckin(ctx);
  } catch (err) {
    checkin = { ok: false, message: `签到异常：${err.message}` };
  }
  log('');
  log(`【签到】${checkin.ok ? '成功' : '失败'} — ${checkin.message}`);

  // —— 步骤 3：派猫（独立兜底，任何异常都不影响签到结论）——
  let travel;
  try {
    travel = await runTravel(ctx, { pickLocation: pickByDay });
  } catch (err) {
    travel = { ok: false, message: `派猫异常：${err.message}`, claimed: null, departed: null };
  }
  log(`【旅行】${travel.ok ? '成功' : '异常'} — ${travel.message}`);

  // —— 汇总 ——
  log('');
  log('------------------------- 结论 -------------------------');
  log(buildSummary(checkin, travel));
  log('--------------------------------------------------------');

  // —— 原始返回（脱敏）——
  log('');
  log('=========== 原始返回（已脱敏）===========');
  for (const t of ctx.trace) {
    log(`--- ${t.method} ${t.path} → HTTP ${t.status}`);
    log(JSON.stringify(redactDeep(t.body), null, 2));
  }

  // —— GitHub Actions 任务摘要 ——
  const summary = [
    '## WorkBuddy 每日任务',
    '',
    '```',
    buildSummary(checkin, travel),
    '```',
    '',
    `<sub>运行于 ${new Date().toISOString()} · ${dryRun ? '只读模式' : '正式执行'} · v${VERSION}</sub>`,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    } catch {
      /* 摘要写失败不影响结果 */
    }
  }

  process.exit(checkin.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('未捕获异常：', err);
  process.exit(1);
});

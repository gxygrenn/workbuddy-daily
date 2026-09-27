/**
 * 签到 + 派猫出行。
 *
 * 签到（app.asar → main/tar.js）
 *   POST /v2/billing/meter/checkin-activity-status  → data.today_checked_in
 *   POST /v2/billing/meter/daily-checkin            → 成功 code 0；已签到 code 10001
 *
 * 派猫（网页版 growthSpace-*.js 的真实调用）
 *   GET  /activity/growth/buddy/travel/status       → { state, daily_limit_reached, arrive_at, reward_credit, ... }
 *   GET  /activity/growth/buddy/travel/config       → { locations: [{ id, name, ... }] }
 *   POST /activity/growth/buddy/travel/claim        → { reward_credit, letter, use_deeplink }
 *   POST /activity/growth/buddy/travel/depart       → body { location_id } → 返回最新 status
 */
import { PATHS, TRAVEL_STATE, request, isOk } from './api.mjs';

/** 业务码：今天已签到（/v2 通道实测返回 10001，文案「今天已签到，请明天再来」） */
const CODE_ALREADY_CHECKED_IN = 10001;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function fmtTime(sec) {
  if (!sec) return '-';
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** ============ 签到 ============ */
export async function runCheckin(ctx) {
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
    checkin_dates: s.checkin_dates,
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

  const cl = ctx.dryRun
    ? { status: 0, body: { code: -1, msg: 'dry-run 不执行签到' } }
    : await request(ctx, 'POST', PATHS.checkinClaim, { body: {} });
  const code = cl.body?.code;
  if (ctx.dryRun) {
    out.ok = true;
    out.message = `[dry-run] 本可领取今日签到（${s.daily_credit} 积分，连续 ${s.streak_days + 1} 天）`;
    return out;
  }
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

/** ============ 派猫出行 ============ */
async function fetchTravelStatus(ctx) {
  const r = await request(ctx, 'GET', PATHS.travelStatus);
  if (!isOk(r)) return { data: null, error: `HTTP ${r.status} / code ${r.body?.code} ${r.body?.msg ?? ''}` };
  return { data: r.body.data ?? {}, error: null };
}

function describeStatus(s) {
  if (!s) return '读取失败';
  const parts = [`state=${s.state}`];
  if (s.state === TRAVEL_STATE.TRAVELING) {
    parts.push(`目的地=${s.location?.name ?? s.location?.code ?? '?'}`, `预计到家=${fmtTime(s.arrive_at)}`);
  }
  if (s.state === TRAVEL_STATE.ARRIVED) {
    parts.push(`可领积分=${s.reward_credit ?? 0}`);
  }
  parts.push(`今日已派=${s.daily_limit_reached ? '是' : '否'}`);
  return parts.join('，');
}

export async function runTravel(ctx, { pickLocation } = {}) {
  const out = { name: 'travel', ok: false, claimed: null, departed: null, before: null, after: null, message: '' };

  let fetched = await fetchTravelStatus(ctx);
  let st = fetched.data;
  out.before = st;
  if (!st) {
    out.message = `读取旅行状态失败：${fetched.error}`;
    return out;
  }

  // 1) 先领掉「已经到家」的积分
  if (st.state === TRAVEL_STATE.ARRIVED) {
    if (ctx.dryRun) {
      out.claimed = { skipped: 'dry-run 不执行领取' };
    } else {
      const c = await request(ctx, 'POST', PATHS.travelClaim, { body: {} });
      if (isOk(c)) {
        out.claimed = {
          reward_credit: c.body.data?.reward_credit ?? st.reward_credit ?? 0,
          letter: c.body.data?.letter ?? null,
        };
      } else {
        out.claimed = { error: `HTTP ${c.status} / code ${c.body?.code} ${c.body?.msg ?? ''}` };
        // 领失败不影响后续：刷新状态再决定
      }
      fetched = await fetchTravelStatus(ctx);
      st = fetched.data ?? st;
    }
  }

  // 2) 判断能不能派新的一趟
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

  // 3) 从 config 里挑一个目的地派出
  const cfg = await request(ctx, 'GET', PATHS.travelConfig);
  const locations = isOk(cfg) ? (cfg.body.data?.locations ?? []) : [];
  if (!locations.length) {
    out.message = '拿不到可用目的地列表，跳过派猫';
    return out;
  }
  const chosen = pickLocation ? pickLocation(locations) : locations[0];

  if (ctx.dryRun) {
    out.ok = true;
    out.departed = { skipped: 'dry-run 不执行派出' };
    out.message = `[dry-run] 本可派猫 → ${chosen.name}（今日已派=${st.daily_limit_reached ? '是' : '否'}）`;
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

/** ============ 汇总 ============ */
export function buildSummary(checkin, travel) {
  const lines = [];
  lines.push(`签到：${checkin.ok ? '✅' : '❌'} ${checkin.message}`);
  if (travel.claimed && !travel.claimed.error) {
    lines.push(`旅行奖励：✅ 领取 ${travel.claimed.reward_credit} 积分`);
  } else if (travel.claimed?.error) {
    lines.push(`旅行奖励：⚠️ 领取失败 ${travel.claimed.error}`);
  }
  lines.push(`派猫出行：${travel.ok ? '✅' : '⚠️'} ${travel.message}`);
  if (travel.departed?.arrive_at) {
    lines.push(`  预计到家：${fmtTime(travel.departed.arrive_at)}`);
  }
  return lines.join('\n');
}

export { fmtTime, nowSec };

/**
 * 全部接口路径都以「客户端实际发出的请求」为准，出处已标注。
 *
 * 桌面端渲染层把「成长中心 / 派猫」交给网页版 /profile/growth-center 处理，
 * 所以这些路径取自网页版前端包（growthSpace-*.js）里真实的 axios 调用；
 * 签到链路取自 app.asar 内 main/tar.js 的 getCheckinStatus / claimDailyCheckin。
 */

/** 云端 API base。来自 cli/product.json 的 `endpoint` 字段。 */
export const DEFAULT_ENDPOINT = 'https://www.workbuddy.cn';

export const PATHS = {
  // —— 鉴权（app.asar → code-cache.js，ExternalLinkAuthenticationProvider.refreshSession）
  //    注意 prefixPath = "/plugin"，来自 product.json 的 authentication.attributes.prefixPath
  tokenRefresh: '/v2/plugin/auth/token/refresh',

  // —— 签到（app.asar → main/tar.js）
  checkinStatus: '/v2/billing/meter/checkin-activity-status',
  checkinClaim: '/v2/billing/meter/daily-checkin',

  // —— 派猫出行（网页版 → growthSpace-*.js）
  travelConfig: '/activity/growth/buddy/travel/config',
  travelStatus: '/activity/growth/buddy/travel/status',
  travelDepart: '/activity/growth/buddy/travel/depart',
  travelClaim: '/activity/growth/buddy/travel/claim',
  travelRecords: '/activity/growth/buddy/travel/records',
};

/** 旅行状态机：idle（在家可派）→ traveling（在路上）→ arrived（到家可领） */
export const TRAVEL_STATE = {
  IDLE: 'idle',
  TRAVELING: 'traveling',
  ARRIVED: 'arrived',
};

export function resolveEndpoint(env = process.env) {
  const raw = (env.WB_ENDPOINT || DEFAULT_ENDPOINT).trim();
  return raw.replace(/\/+$/, '');
}

/**
 * 统一请求封装。返回 { status, body }，body 是解析后的 JSON（解析失败为 null）。
 *
 * 关键约定：**永不抛异常**。网络不通 / DNS 失败 / 超时都归一化成
 * status=0 + body.code=-1，让调用方（尤其是「猫猫」那条链路）能优雅降级，
 * 不会把整个任务带崩。
 */
export async function request(ctx, method, path, { body, headers, timeoutMs = 20_000 } = {}) {
  const url = ctx.endpoint + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {}),
        ...(ctx.uid ? { 'X-User-Id': encodeURIComponent(ctx.uid) } : {}),
        ...(ctx.domain ? { 'X-Domain': ctx.domain } : {}),
        ...headers,
      },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    const msg = `网络错误 ${method} ${path}：${err?.cause?.message || err.message}`;
    const failed = { status: 0, body: { code: -1, msg } };
    if (ctx.trace) ctx.trace.push({ method, path, status: 0, body: failed.body });
    return failed;
  }
  let parsed = null;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text.slice(0, 500) };
  }
  if (ctx.trace) ctx.trace.push({ method, path, status: res.status, body: parsed });
  return { status: res.status, body: parsed };
}

/** 业务成功判定：HTTP 2xx 且 envelope.code === 0 */
export function isOk(result) {
  return result.status >= 200 && result.status < 300 && result.body?.code === 0;
}

/** 脱敏：任何疑似 token 的字符串都只保留长度 */
export function redact(value) {
  if (typeof value !== 'string') return value;
  if (value.length > 64) return `<redacted len=${value.length}>`;
  return value;
}

/** 递归脱敏对象里的长字符串（token 通常 > 500 字符） */
export function redactDeep(input, depth = 0) {
  if (depth > 8) return '<max-depth>';
  if (typeof input === 'string') return redact(input);
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => redactDeep(v, depth + 1));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (/token|secret|authorization|password/i.test(k)) {
        out[k] = typeof v === 'string' ? `<redacted len=${v.length}>` : '<redacted>';
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

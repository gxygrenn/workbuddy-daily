/**
 * 鉴权：用 refreshToken 换 accessToken；可选把轮换后的新 refreshToken 回写仓库 secret。
 *
 * 刷新接口（app.asar → code-cache.js，ExternalLinkAuthenticationProvider.refreshSession）：
 *   POST {endpoint}/v2/plugin/auth/token/refresh
 *   headers: X-Refresh-Token: <refreshToken>
 *            X-Auth-Refresh-Source: plugin
 *            X-Domain: <endpoint 的 authority>
 *   resp:    data.data = { accessToken, refreshToken, expiresIn, refreshExpiresIn, domain, ... }
 *
 * 实测：refreshToken 会轮换（新旧不同），accessToken 30 天、refreshToken 60 天。
 * 因此若配置了 GH_SECRETS_PAT，就把新的 refreshToken 写回 secret，实现长期无人值守。
 */
import { PATHS, request, isOk } from './api.mjs';

function authority(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}

/**
 * @returns {Promise<{accessToken:string, refreshToken?:string, expiresIn?:number, refreshExpiresIn?:number, domain?:string, rotated:boolean}>}
 */
export async function refreshAccessToken(ctx) {
  const rt = ctx.refreshToken;
  if (!rt) throw new Error('缺少刷新令牌：请先运行本地凭证导出脚本并写入 secret');

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
 * 把新的 refreshToken 写回仓库 secret（需要 GH_SECRETS_PAT，细粒度 PAT 要勾 Secrets: Read and write）。
 * 走 GitHub 官方 encrypted secret API，值在本地用仓库公钥做 sealed-box 加密，明文不出现在日志/仓库里。
 */
export async function persistRefreshToken(ctx, newRefreshToken) {
  const repo = process.env.GITHUB_REPOSITORY;
  const pat = process.env.GH_SECRETS_PAT;
  const secretName = process.env.WB_REFRESH_SECRET_NAME || 'WB_REFRESH_TOKEN';

  if (!pat) return { saved: false, reason: '未配置 GH_SECRETS_PAT，跳过回写' };
  if (!repo) return { saved: false, reason: '不在 GitHub Actions 环境中，跳过回写' };

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workbuddy-daily',
    },
  });
  if (!keyRes.ok) {
    return { saved: false, reason: `获取仓库公钥失败 HTTP ${keyRes.status}` };
  }
  const { key, key_id } = await keyRes.json();

  const binkey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binsec = sodium.from_string(newRefreshToken);
  const encBytes = sodium.crypto_box_seal(binsec, binkey);
  const encrypted_value = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

  const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${secretName}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workbuddy-daily',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ encrypted_value, key_id }),
  });

  if (putRes.status === 201 || putRes.status === 204) {
    return { saved: true, secretName };
  }
  const detail = await putRes.text();
  return { saved: false, reason: `回写失败 HTTP ${putRes.status}: ${detail.slice(0, 200)}` };
}

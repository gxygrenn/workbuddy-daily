// 把 GH_SECRETS_PAT 写入仓库 Secret（用仓库公钥 sealed-box 加密后上传）
// 用法：GH_TOKEN=<细粒度PAT> node set-pat-secret.cjs
const sodium = require('libsodium-wrappers');

const TOKEN = process.env.GH_TOKEN;
const REPO = 'gxygrenn/workbuddy-daily';
const SECRET_NAME = 'GH_SECRETS_PAT';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(2);
}

async function main() {
  await sodium.ready;

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workbuddy-daily',
  };

  // 1) 取仓库公钥
  const keyRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/public-key`, { headers });
  if (!keyRes.ok) {
    console.error('获取公钥失败 HTTP', keyRes.status, await keyRes.text());
    process.exit(1);
  }
  const { key, key_id } = await keyRes.json();
  console.log('公钥 key_id =', key_id);

  // 2) sealed-box 加密（明文不出现在任何日志里）
  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(TOKEN), binKey),
    sodium.base64_variants.ORIGINAL,
  );

  // 3) 上传
  const putRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/${SECRET_NAME}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encrypted, key_id }),
  });

  if (putRes.status === 201 || putRes.status === 204) {
    console.log('✅ 成功写入 Secret:', SECRET_NAME, '(HTTP', putRes.status + ')');
    console.log('   加密后的密文长度 =', encrypted.length, '字节（明文未落盘、未出现在日志）');
  } else {
    console.error('❌ 写入失败 HTTP', putRes.status, await putRes.text());
    process.exit(1);
  }
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });

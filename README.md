# WorkBuddy 每日签到 + 派猫猫旅行

把 WorkBuddy「Buddy 加油站」的**每日签到**和**派猫猫旅行**放到 GitHub Actions 上，
每天定时跑一次，不需要任何常开设备。

> ## 👉 不懂 git、也没有仓库？请看 [`deploy/如何部署.md`](deploy/如何部署.md)
>
> `deploy/` 是**面向零基础用户**的版本：全程在 GitHub 网页上点鼠标，不需要敲任何命令。
> 它把整套逻辑压成了一个单文件脚本 `wb-daily.mjs` + 一个定时任务配置 `daily.yml`，
> 并带一个**双击即用**的本机凭证导出工具。
>
> 本 README 描述的是**开发版**（多文件结构，便于改动和测试）。
> 两者功能一致，日常使用推荐 `deploy/`。

- 一次跑完：**签到** → **领掉已经到家的旅行积分** → **判断能不能派新的一趟**
- 今天已经派过就**不会**重复派（靠服务端 `daily_limit_reached` / `state` 判断）
- **猫猫那部分失败不影响签到结论**：退出码只看签到，签到成功就是成功
- 明文 token 不进仓库、不进日志：仓库里只放 Secret，日志里 token 只以「长度」形式出现

---

## 一、5 分钟上手

### 1. 建仓库并推代码

```bash
cd workbuddy-daily
git init -b main
git add .
git commit -m "chore: workbuddy daily checkin + travel"
git remote add origin git@github.com:<你的账号>/<你的仓库>.git
git push -u origin main
```

> 推送前确认 `.gitignore` 生效：`.local/` 必须被忽略（里面有明文凭证）。

### 2. 在本机导出登录凭证

云端拿不到你电脑上的登录态，所以要在**你自己电脑**上把凭证导出来，再填进仓库 Secret。

```bash
# macOS / Linux / Windows Git Bash
bash scripts/export-credential.sh
```

```cmd
:: Windows 也可以双击
scripts\export-credential.cmd
```

脚本会自动找到 WorkBuddy 安装位置（不写死版本号：先看环境变量、再查 `PATH`、再看缓存，
最后在有界目录里搜），然后用 WorkBuddy 自带的 Electron 运行时解密登录态。

跑完会打印自检结果，并生成 `.local/credentials.env`（已被 gitignore 忽略）。

> 找不到 WorkBuddy？指定一下路径即可：
> `WORKBUDDY_EXE="/路径/WorkBuddy.exe" bash scripts/export-credential.sh`

### 3. 填仓库 Secret

仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret 名 | 必填 | 说明 |
| --- | --- | --- |
| `WB_REFRESH_TOKEN` | ✅ | 从 `.local/credentials.env` 复制 |
| `WB_USER_ID` | ✅ | 导出脚本会直接打印出来 |
| `WB_ENDPOINT` | ⭕ | 默认 `https://www.workbuddy.cn`，一般不用配 |
| `WB_ACCESS_TOKEN` | ⭕ | 兜底用。刷新失败时才会用到 |
| `GH_SECRETS_PAT` | ⭕ | **推荐配**，见下一节 |

### 4. 手动跑一次验证

Actions → `WorkBuddy daily` → `Run workflow` → 勾上 `dry_run` 先试只读模式。
通过后取消勾选再跑一次实跑。

---

## 二、关于 token 过期（重要）

服务端返回的时效（实测）：

| 凭证 | 有效期 |
| --- | --- |
| accessToken | 30 天（`expiresIn = 2592000`） |
| refreshToken | 60 天（`refreshExpiresIn = 5183999`） |
| 刷新接口 | `POST {endpoint}/v2/plugin/auth/token/refresh` |

**refreshToken 会轮换**——每次刷新都会返回一个新的。所以有两种用法：

### 方案 A：配 `GH_SECRETS_PAT`（推荐，长期免维护）

新建一个**细粒度 PAT**，只授权你这一个仓库，权限只勾 **Secrets: Read and write**，
存成 Secret `GH_SECRETS_PAT`。

之后每次运行都会自动把轮换出来的新 refreshToken 写回 `WB_REFRESH_TOKEN`
（值用仓库公钥做 sealed-box 加密后走 GitHub 官方 API，明文不落盘、不进日志）。

→ 之后基本不用再管。

### 方案 B：不配 PAT

工作流仍然每天用 Secret 里的 refreshToken 换取新 accessToken，但**不回写**。
Secret 里那个 refreshToken 本身约 60 天到期，**到期前重跑一次 `export-credential.sh`
并更新 `WB_REFRESH_TOKEN`** 即可。

> 每次运行日志里都会有明确提示，告诉你当前是哪种状态、还剩多少天该更新。

---

## 三、它每天到底做了什么

```
1. 刷新登录态      POST /v2/plugin/auth/token/refresh
2. 读签到状态      POST /v2/billing/meter/checkin-activity-status
   ├ 没签到 → 领   POST /v2/billing/meter/daily-checkin
   └ 已签到 → 跳过
3. 读旅行状态      GET  /activity/growth/buddy/travel/status
   ├ state = arrived    → 先领积分 POST /activity/growth/buddy/travel/claim
   ├ state = traveling  → 已在路上，不重复派
   ├ daily_limit_reached → 今天派过了，不重复派
   └ state = idle       → 从 config 挑目的地 → POST /activity/growth/buddy/travel/depart
```

目的地按「一年中的第几天」轮换，不会每天只去同一处。

### 接口出处（全部以客户端真实请求为准）

桌面端把「成长中心 / 派猫」交给网页版 `/profile/growth-center` 处理，所以这些路径来自
网页版前端包里真实的 axios 调用，而不是网上流传的旧接口名：

| 用途 | 方法 | 路径 | 出处 |
| --- | --- | --- | --- |
| 刷新登录态 | POST | `/v2/plugin/auth/token/refresh` | `app.asar` → `code-cache.js`，`ExternalLinkAuthenticationProvider.refreshSession`（路径里的 `/plugin` 来自 `product.json` 的 `authentication.attributes.prefixPath`） |
| 签到状态 | POST | `/v2/billing/meter/checkin-activity-status` | `app.asar` → `main/tar.js`，`getCheckinStatus()` |
| 签到领取 | POST | `/v2/billing/meter/daily-checkin` | `app.asar` → `main/tar.js`，`claimDailyCheckin()` |
| 旅行状态 | GET | `/activity/growth/buddy/travel/status` | 网页版 `growthSpace-*.js` |
| 目的地配置 | GET | `/activity/growth/buddy/travel/config` | 网页版 `growthSpace-*.js` |
| 派猫出行 | POST | `/activity/growth/buddy/travel/depart` | 网页版 `growthSpace-*.js`，body `{ location_id }` |
| 领旅行积分 | POST | `/activity/growth/buddy/travel/claim` | 网页版 `growthSpace-*.js` + `app.asar` 里 `claimTravelReward()` |

### 签到领取的业务码

`POST /v2/billing/meter/daily-checkin` 成功是 `code: 0`；
今天已经签到时返回 `code: 10001`（文案「今天已签到，请明天再来」），脚本按成功处理、不报错。

---

## 四、本地自检 / 调试

```bash
# 单元自检：不联网，验证容错与脱敏
node scripts/self-test.mjs

# 只读模式：只刷新登录态 + 读状态，不签到、不派猫
node scripts/run.mjs --dry-run

# 实跑（凭证从环境变量读）
set -a && . ./.local/credentials.env && set +a
node scripts/run.mjs
```

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 签到成功（含「今天已签到」）。猫猫成功或失败都不改变退出码 |
| `1` | 签到失败 / 凭证失效，需要处理 |

---

## 五、目录结构

```
workbuddy-daily/
├─ .github/workflows/daily.yml   # 每天 01:00 UTC（北京 09:00）自动跑
├─ scripts/
│  ├─ export-credential.sh       # 本地：导出凭证（macOS/Linux/Git Bash）
│  ├─ export-credential.cmd      # 本地：导出凭证（Windows 双击）
│  ├─ export-credential.cjs      # 本地：真正干活的脚本，跑在 WorkBuddy 运行时里
│  ├─ run.mjs                    # 云端入口：刷新 → 签到 → 派猫
│  └─ self-test.mjs              # 自检
├─ src/
│  ├─ api.mjs                    # 接口常量 + 请求封装（永不抛异常）+ 脱敏
│  ├─ auth.mjs                   # 刷新登录态 + 回写 Secret
│  └─ tasks.mjs                  # 签到 / 派猫 具体逻辑
└─ package.json
```

## 六、为什么本机导出必须跑在 WorkBuddy 里

WorkBuddy 的登录态在磁盘上是**加密**的。解密用的静态密钥由 Electron 原生绑定
`electron_browser_workbuddy_storage.loggerGet()` 提供，只有 WorkBuddy 进程自己能拿到。
所以导出脚本要用：

```bash
ELECTRON_RUN_AS_NODE=1 "<WorkBuddy 安装目录>/WorkBuddy.exe" scripts/export-credential.cjs
```

`export-credential.sh` / `.cmd` 就是帮你自动拼这条命令并找到安装路径的。

## 七、注意事项

- 定时任务是 GitHub 的**免费额度**，高峰期可能有几分钟延迟，属正常。
- 仓库建议设为 **Private**。即便 Secret 加密，也没必要公开这个自动化。
- 改动接口路径前，请先按上面「接口出处」的方法重新核对客户端真实请求，别用网上传的旧接口名。
- 本工具只是把你在客户端里**本来就会手动点**的操作自动化，不会绕开任何服务端限制；
  若服务端返回每日上限（`429` / `daily limit`），脚本会照常停下并明确告知。

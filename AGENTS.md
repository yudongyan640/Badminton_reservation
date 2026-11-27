# 接手本项目

个人自用的 Windows 羽毛球场地零点自动预约工具：Node.js ≥24 直接运行 TypeScript，Playwright 驱动本机 Microsoft Edge 的持久化配置，原生 `node:http` 提供本机控制页；无数据库、无构建、无云端。目标站点 `https://86366168.hyshi.cn/web/resource/ROOM/blocks`，规则 10:00–23:00、30 分钟单位、单次 ≤120 分钟、`bookingLimitDays=2` 且含当天（目标日 D 于 D−1 北京时间 00:00 放号）。

**当前基线 1.2.26**。源码与运行资料都在本目录（`E:\newdesktop\羽毛球预约程序`），不要用旧开发目录的数据覆盖。

## 先读

`项目交接.md`（历史、决策与踩坑）、`使用说明.md`（用户手册）、`docs/网站适配与验证.md`（站点契约与版本记录）；需要复盘零点时读对应的 `docs/1.2.x*.md`。

## 目录与模块

- `src/domain.ts`：类型、北京时间、`validateTask`、`overlaps`、规则与响应分类、`buildPayload`。
- `src/browser.ts`：`BrowserSite`（open/preflight/refineClock/list/listRange/submit/rehearse）与 `interpretSubmission`（严格响应判定）。
- `src/engine.ts`：状态机——零点触发、预检、`submitAttempt`、冲突本地重选/刷新、重试、核对、冻结。
- `src/store.ts`：原子落盘（tmp+fsync+rename）、`events.ndjson`、启动自愈；`src/instance.ts` 单实例锁；`src/server.ts` 回环 HTTP + 令牌；`src/config.ts` 端口/数据目录。
- `data/`、`data-b/`、`edge-profile/`：**私有运行资料**（登录 Cookie、任务、冻结、令牌、浏览器配置），已被 `.gitignore` 排除。

## 绝对不能做的事

- 不删除、重建、覆盖、上传 `data/` 或 `data-b/`；只读检查时不要输出令牌、Cookie 或完整响应数据。
- 诊断/测试/演练默认不得真实创建或取消预约，不得启用任务；模拟与演练的实际预约写转发必须为 0。
- 不能在执行抢约（尤其零点窗口）时替换运行代码；升级后必须重启两个实例才加载新代码。
- 两个实例（账号1 `启动预约程序.cmd` → 38321 + `data/`；账号2 `启动账号2.cmd` → 38322 + `data-b/`）的登录、演练证明、任务、冻结、令牌、日历完全隔离，不得互相复制 `edge-profile`、`form-check.json` 或整个 `data-b`，也不得共用同一数据目录。
- 平台按账号拒绝同一时间的第二个会议（11-03 真实零点证据：“当前用户(...)在当前时间有其它会议”）。同一时段两块场地必须用两个账号各订一块，不能用程序绕过。

## 零点链路（改动前先读懂）

1. `tick` 每 1000ms 扫描到点任务；距放号 ≤5 分钟做 phase1 预检，≤10 秒做 phase2 快速预检（预算 2.5 秒、到触发前 100ms 截止，失败只记录、到点仍提交）。
2. 浏览器内多采样校时（≤5 次，取不确定度最小者），不把误差下界叠加进等待。
3. 触发点：`releaseWait = releaseAt + EARLY_GUARD_MS − min(本机墙钟推算, 服务器点估计)`，取较晚者再加余量。
4. `executeTasks`：先逐条 `prepareExecution`（同批同账号可共用一次快照，`PREPARE_SHARE_MS=3000`）→ 首波（`planFirstWave`：按创建顺序、时段互不重叠、最多 `MAX_PARALLEL_FIRST_SHOTS=2` 条并发，见 1.2.21）→ `submitAttempt` 先落盘 `submitting` 与 `baselineIds` 再 POST。
5. 响应回来 → `processResult`：首轮冲突用缓存 + `conflictHints` 本地重选（1.2.22 起记录 `lastConflict`/`conflict-local-reselect`）；连续冲突才刷新，零点刷新限时 150ms，超时用缓存；临时错误按零点 `[0,300,300,600]ms` 或迟到任务 `[150,600,1500,3000]ms` 退避。
6. 重试阶段严格单在途；1.2.23 起“已完成本地重选、有新候选”的任务先发，其余仍按创建顺序轮转。
7. 提交后只读核对：`coverageMinutes == duration` → `succeeded`；部分覆盖 → `partial` 立即停止，不补订；查不到 → 账号级冻结（跨重启，需人工核对）。

关键常量（`src/engine.ts`）：`EARLY_GUARD_MS=10`（1.2.24）、`ZERO_WINDOW_MS=15_000`、`ZERO_REFRESH_TIMEOUT_MS=150`、`ZERO_TRANSIENT_DELAYS=[0,300,300,600]`、`TRANSIENT_DELAYS=[150,600,1500,3000]`、`DEGRADED_LIST_TIMEOUT_MS=300`、`ZERO_RECHECK_TIMEOUT_MS=1500`、`PREPARE_SHARE_MS=3000`、`MAX_PARALLEL_FIRST_SHOTS=2`；提交全局间隔 100ms、每条任务 20 次/15 秒。

## 响应判定（不得放宽）

- `created`：HTTP 2xx + `success=true` + `code∈{200,0}` + 有 `data.id` + 无 `allowSectionBooking` + 无冲突会议。
- `conflict`：仅匹配确切的冲突文案（含冲突区间），且日期相同、区间重叠；不再要求 `success` 严格为 false。
- `transient`：仅“资源分配错误,请十秒后重试”且 HTTP200/code200/success 为布尔/无 data/场馆规则绑定；零点不等 10 秒。
- `not-open`：仅“不能预订超过2天的会议”同一严格形态，约 300ms 后重试、最多 3 次/5 秒内。
- `auth`：401/403。其余一律 `unknown` → 先只读核对本人记录，无法确认立即持久化暂停；不得凭 HTTP 200 或通用 code 200 重试。

## 用户已定的产品决策

- 接受部分时段：取得任何时段即保留并停止，不补订、不撤销、不自动换场、不延长。
- 未知结果先核对；不能确认就暂停，不能把可能的手动补约当作程序成功或据此清除暂停。
- 不开发循环预约、自动签到、自动取消、云端运行；不承诺必抢到。

## 修改流程

1. 改前核对运行状态：38321/38322 是否监听、`data*/tasks.json` 是否有 `submitting` 在途；抢约期间不动代码。
2. 改代码时保持严格场馆绑定、失败标志、冲突形态校验、提交前落盘、单在途/100ms/20 次/15 秒边界；不扩大 1.2.21 首波并发的范围。
3. 版本三件套一起改：`package.json` 版本、测试、文档（README、使用说明、项目交接、验证结果、`docs/网站适配与验证.md`、新增 `docs/1.2.x*.md`），并把本文件“当前基线”改成新版本。
4. 验证：`npm run check` + `node --test --test-isolation=none --test-concurrency=1 "tests/*.test.ts"`（本机沙箱下 `npm test` 会因 `spawn EPERM` 失败，属环境限制；UI/浏览器改动再跑 `npm run smoke`、`npm run smoke:calendar`）。测试通过不等于真实抢约成功。
5. 提交推送只在用户明确要求时做；`.gitignore` 已覆盖 data、edge-profile、node_modules、日志、权重与归档；推送若遇 schannel/凭据助手不可用，用 `gh auth token` + `git -c http.sslBackend=openssl -c "http.extraHeader=Authorization: Basic ..." push` 临时完成，不把令牌写入任何配置或文件。

## 当前状态与已知风险

- 1.2.21 首波并发已于 11-24 零点真实生效（两条首刀并发、`first-wave-parallel`）；1.2.22 诊断留痕、1.2.23 重试优先级、1.2.24 触发余量 10ms、1.2.25 临近零点手动操作保护（5 分钟内拒绝立即演练、手动检查 60 秒内不覆盖更优校时）与本机墙钟锚点刷新均通过测试（现 135 项）与类型检查，但**真实零点尚未验证**。1.2.26 只改 `public/` 控制页（任务分组、开抢倒计时、账号标识），后端未改，smoke 待在 Windows 本机补跑。
- 已知未修：`src/instance.ts` 的端口占用提示硬编码 38321（账号2 会提示错端口）；降级路径“查询失败以空记录继续提交”的重复预约风险面未消除（用户未授权修改），不能声称已消除。
- 真实零点结果受竞争、网络与平台限流影响，复盘时以 `events.ndjson` 的时间戳、`firstShot`、`lastConflict` 为准，不凭感觉下结论。

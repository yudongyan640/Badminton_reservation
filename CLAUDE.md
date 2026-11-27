# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

项目约束、架构、零点链路、响应判定与修改流程的权威来源是 `AGENTS.md`（下方导入），本文件只补充 Claude Code 常用命令，不重复其内容。若两者冲突，以 `AGENTS.md` 为准；更新基线版本时只改 `AGENTS.md`。

@AGENTS.md

## 常用命令

无构建步骤：Node.js ≥24 直接运行 `.ts`（类型剥离），`tsc` 只做类型检查。

```powershell
npm run check                                                     # tsc --noEmit
node --test --test-isolation=none --test-concurrency=1 "tests/*.test.ts"   # 全部测试（本机沙箱下 npm test 会 spawn EPERM）
node --test --test-isolation=none tests/server.test.ts            # 单个测试文件
node --test --test-isolation=none --test-name-pattern="冲突" "tests/*.test.ts"  # 按名称筛选
npm run smoke; npm run smoke:calendar                             # 仅 UI/浏览器改动时
npm start                                                         # 账号1 实例（默认 38321 + data/）；正式使用走 .cmd 入口
```

- 测试使用 FakeSite，不触达真实站点；任何新增测试/脚本也必须保证真实预约写请求为 0。
- 运行实例环境变量：`BADMINTON_PORT`、`BADMINTON_DATA_DIR`（必须是项目内以 `data` 开头的相对目录）。
- 改代码前先确认 38321/38322 是否在监听、`data*/tasks.json` 是否有 `submitting` 在途；只读检查时不输出令牌、Cookie 或完整响应。
- 文档以中文为主；新增版本说明放在 `docs/1.2.x*.md`，并同步 README、使用说明、项目交接、验证结果、`docs/网站适配与验证.md`。

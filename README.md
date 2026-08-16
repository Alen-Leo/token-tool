# token-tool

**中文** | [English](./README.en.md)

一个**轻量、本地优先**的 AI 平台**订阅与用量**监控工具 —— 覆盖 Z.ai / GLM、DeepSeek、OpenCode Go、OpenRouter、SiliconFlow（硅基流动）、Moonshot / Kimi（月之暗面）等。底层是一个零运行时依赖的 Node 服务，配上一套原生 Web UI。

灵感来自开源项目 [Javis603/token-monitor](https://github.com/Javis603/token-monitor)，但剥离了跨平台无关的部分，专注于*跨平台可用*的核心——查询各家服务商的订阅 / 余额 / 配额 / 模型可用性——而不背着沉重的 Electron 桌面外壳。

> **状态：** 服务端 + UI 与平台无关。同时**也提供桌面应用**——macOS 上常驻菜单栏，Windows / Linux 上常驻系统托盘——基于 Electron 构建。完全相同的回环服务器（安全模型原样保留）被 Electron 外壳在进程内嵌入；原生 Web UI 原样复用。

## 设计取舍

| 目标 | 做法 |
|---|---|
| 轻量 | 无 npm 运行时依赖，仅用 Node 内置模块。UI 各自只有一个 HTML/CSS/JS 文件，无构建步骤。 |
| 安全 | 只绑定 `127.0.0.1`；每次启动生成会话令牌，门禁所有 API 路由；API Key 存放在 `0600` 权限文件（`~/.token-tool/config.json`）；**严格的出站主机白名单**；密钥在所有对外展示处一律打码；密钥只发给其所属服务商。 |
| 可靠 | 每个服务商独立容错、超时控制、白名单重定向。 |
| 跨平台 | 查询层是纯 Node；服务端在 Windows / Linux 上一成不变运行；静态 UI 即是 Web 版本。 |

## 支持的服务商（各自展示*不同*的数据）

| 服务商 | 鉴权 | 展示内容 |
|---|---|---|
| **Z.ai / GLM** | API Key（`Bearer`） | 套餐名 + 用量窗口（5 小时会话 / 周配额 / 月度 MCP），含已用百分比、Token 数与重置时间，以及订阅续费日期与一句话摘要。 |
| **DeepSeek** | API Key（`Bearer`）+ 可选网页授权 | 预付余额（含今日与近 30 天消费）+ 按模型的当日 Token 消耗（命中缓存 / 未命中缓存 / 输出）。 |
| **OpenCode Go** | API Key（`Bearer`） | Key 有效性 + 计划解锁的模型数量与列表；当本机装了 OpenCode 时，展示**本地花费窗口**（会话 / 周 / 月，对照 `$12/$30/$60` 套餐上限）。 |
| **OpenRouter** | API Key（`Bearer`） | 账户积分余额（已购 / 已用 / 剩余，USD）。 |
| **SiliconFlow（硅基流动）** | API Key（`Bearer`） | 账户余额（总额 / 充值 / 赠送，CNY）。 |
| **Moonshot / Kimi（月之暗面）** | API Key（`Bearer`） | 账户余额（可用 / 现金 / 代金券，CNY），支持中国 / 国际节点切换。 |

> Anthropic、OpenAI 等不提供「API Key 查余额」的公开接口，因此暂不接入；其用量只能通过各自的管理员 API 或控制台查看。

## 快速开始

```bash
cd token-tool
node src/server.js            # macOS / Linux 也可：./scripts/run.sh
```

启动器会打印一个带鉴权的 URL，并用默认浏览器打开。URL 里的令牌是你的会话凭证；页面加载后会被移入 `sessionStorage` 并从地址栏抹除。

### 添加密钥（两种方式）

- **界面**——点击 **⚙ 配置**，粘贴密钥，**Test**（实时探测，不保存），再 **Save**。
- **文件**——把 `config.example.json` 复制为 `~/.token-tool/config.json`（权限 `0600`）后编辑。或者用环境变量：

每个服务商都支持**多个账号**（比如两个 z.ai 账号）：界面里点服务商卡片内的「＋ 添加账号」即可追加，可给每个账号加备注（如「工作」）区分；文件里则是 `providers.<id>.accounts` 数组（见 `config.example.json`）。旧版单密钥格式（密钥直接写在 `providers.<id>` 上）仍然兼容，首次保存后自动迁移。每个账号一张卡片，可各自拖动排序。

```bash
export ZAI_API_KEY=...            # 或 GLM_API_KEY / ZHIPU_API_KEY
export DEEPSEEK_API_KEY=...
export OPENCODE_API_KEY=...
export OPENROUTER_API_KEY=...
export SILICONFLOW_API_KEY=...
export MOONSHOT_API_KEY=...       # 或 KIMI_API_KEY
node src/server.js
```

## 桌面应用（macOS 菜单栏 / Windows 托盘）

同一套服务端 + UI 也能作为原生桌面应用运行。macOS 上它**只活在菜单栏**（无 Dock 图标，`LSUIElement`）；悬停或左键点托盘图标弹出浮窗，点别处即收起。Windows / Linux 上常驻**系统托盘**：**首次启动会自动打开一个真正的（带边框的）主窗口**，悬停托盘图标弹出浮窗预览、左键点击切换浮窗、**双击托盘图标重新打开主窗口**，关闭主窗口后应用仍在托盘继续运行。右键托盘图标可**打开主窗口** / 刷新 / 在浏览器打开 / 退出。

Electron 外壳**在进程内**嵌入回环服务器——会话令牌、主机白名单、`0600` 密钥存储全部不变。渲染进程只是加载那个带鉴权的回环 URL。

```bash
# 从源码运行（打开桌面外壳）
npm run electron

# 生成 / 重新生成图标素材（纯 Node PNG 编码，零依赖）
npm run icons

# 打包安装包（产物落在 dist/）
npm run electron:build:mac     # → Token-Tool-<v>-arm64.dmg / .zip（arm64 + x64）
npm run electron:build:win     # → Token-Tool-Setup-<v>.exe（NSIS）+ 便携版 .exe（x64）
```

> **首次 `npm install` Electron：** Electron 二进制从 GitHub 下载，国内网络若慢，可设置国内镜像：
> ```bash
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

开发时的验证小工具：用 `TOKEN_TOOL_AUTO_SHOW=1` 启动可在启动时自动弹出浮窗（无需手动点托盘即可截图）：

```bash
TOKEN_TOOL_AUTO_SHOW=1 npm run electron
```

## 安全模型

- **仅回环。** 服务器只绑定 `127.0.0.1`，局域网不可达。
- **会话令牌。** 每次启动生成。除 `/api/health` 外，每个 `/api/*` 路由都要求携带。启动器把它交给浏览器；页面存入 `sessionStorage`，从不落盘。
- **出站白名单。** 服务商调用只发往固定的一组主机（`api.z.ai`、`open.bigmodel.cn`、`api.deepseek.com`、`opencode.ai`、`openrouter.ai`、`api.siliconflow.cn`、`api.moonshot.cn`、`api.kimi.ai`）。任何其他目标在建立 socket 前即被拒绝——这是防范被篡改配置外泄密钥的核心防线。
- **密钥处理。** 密钥存放在 `~/.token-tool/config.json`（`0600`，仅属主可读）。在 UI 与日志中一律打码，且只通过 HTTPS 发往其所属服务商。
- **无遥测。** 除了你配置的服务商，应用不向任何地方发送任何东西。

## 目录结构

```
token-tool/
  src/
    server.js            回环 HTTP 服务器、路由、鉴权；createServer()
    config.js            0600 配置存储 + 环境变量覆盖 + 打码
    security.js          会话令牌 + 主机白名单 + 常量时间比较
    providers/
      index.js           注册表 + 并行执行器
      zai.js             Z.ai / GLM 配额 + 订阅
      deepseek.js        DeepSeek 余额 + 官网同源用量看板（网页 token）
      opencode.js        OpenCode Go（本地 DB + Key 探测）
      openrouter.js      OpenRouter 积分
      siliconflow.js     SiliconFlow 余额
      moonshot.js        Moonshot / Kimi 余额
    util/
      http.js            白名单内、带超时的 JSON 获取
      format.js          共享的窗口 / 金额 / Token / 时间工具
  web/                   静态单页 UI（html/css/js）
  electron/
    main.js              Electron 外壳：托盘 + 浮窗，内嵌 createServer()
  assets/                生成的图标（应用图标、mac 托盘模板、win 托盘）
  scripts/
    run.sh               CLI 启动器（macOS/Linux）
    gen-icons.mjs        纯 Node PNG 图标生成器（零依赖）
    postpack-info.mjs    打包后列出构建产物
  config.example.json    模板（无密钥）
```

## 运行测试

```bash
npm test     # node --test（递归发现 tests/ 下的 *.test.js）
```

## 许可证

MIT。各服务商端点行为依据其公开 API 文档及参考项目整理；本实现为独立编写。

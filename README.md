# pi-clickable-toast

可点击的 Windows Toast 通知扩展，用于 [pi coding agent](https://github.com/badlogic/pi-mono)。点击 toast 本体即可把焦点切回通知来源的终端窗口或 Herdr pane。

## 功能

- **接管全部 native toast**：自动事件（`agent_end`、`workflow_end`、`ask_user_prompt` 等）和手动 `notify_user` 的 native 通道都由本扩展发送
- **点击回来源**：
  - Herdr 环境（`HERDR_ENV=1`）→ `herdr agent focus <HERDR_PANE_ID>` 精确聚焦对应 pane
  - 普通 Windows Terminal → PowerShell 沿父进程链捕获 `MainWindowHandle`，点击时恢复/前置窗口（窗口级）
- **每会话仅最新一条**：新 toast 顶替旧的，不堆叠
- **会话退出清理**：`session_shutdown` 幂等清理控制器
- **来源标识**：toast 正文末尾追加 `项目名 · pane xxx` / `项目名 · WT xxxxxxxx`

## 安装

```powershell
# 复制到 pi 扩展目录
xcopy /E /I pi-clickable-toast "%USERPROFILE%\.pi\agent\extensions\clickable-toast"
cd "%USERPROFILE%\.pi\agent\extensions\clickable-toast"
npm install
```

依赖锁定的 `node-notifier@10.0.1`（自带，不污染全局）。

## 配置

总开关：`%USERPROFILE%\.pi\agent\clickable-toast.json`

```json
{ "enabled": true }
```

事件路由 / 抑制 / 重发规则读取 `@pi-unipi/notify` 的配置 `C:\Users\1\.unipi\config\notify\config.json`（Windows 路径按实际用户目录解析）。若同时安装了 `@pi-unipi/notify`，建议将其 `native.enabled` 设为 `false`，由本扩展接管 native 通道；远程平台（gotify/telegram/ntfy）仍归原工具。

## 测试

```powershell
npm test          # 单元测试（core/windows 逻辑）
npm run smoke:rpc # 端到端冒烟：spawn RPC 模式 pi → 触发 toast → 模拟 pipe 点击 → 验证清理
```

冒烟脚本要求 Windows + PowerShell（CIM/SnoreToast 进程查询）。

## 已知限制

- Windows Terminal 只能恢复到窗口级，不定位到具体 tab/pane（WT 无公开的反查 API）
- node-notifier 的 Windows toaster 不支持主动移除 toast，靠系统自动过期
- 点击回调依赖 pi 进程存活（SnoreToast 通过 named pipe 回调）；pi 退出后 toast 不再可点

## License

MIT

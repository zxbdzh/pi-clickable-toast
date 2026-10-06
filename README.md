# pi-clickable-toast

可点击的 Windows Toast 通知扩展，用于 [pi coding agent](https://github.com/badlogic/pi-mono)。点击 toast 本体即可把焦点切回通知来源的终端窗口或 Herdr pane。

## 功能

- **接管全部 native toast**：自动事件（`agent_end`、`workflow_end`、`ask_user_prompt` 等）和手动 `notify_user` 的 native 通道都由本扩展发送
- **点击回来源**：
  - Herdr 环境（`HERDR_ENV=1`）→ `herdr agent focus <HERDR_PANE_ID>` 精确聚焦对应 pane
  - 普通 Windows Terminal → PowerShell 沿父进程链捕获 `MainWindowHandle`，点击时恢复/前置窗口（窗口级）
- **每会话仅最新一条**：新 toast 顶替旧的，不堆叠
- **会话退出清理**：`session_shutdown` 幂等清理控制器
- **只在交互终端里自动通知**：magic-context 等扩展会在后台起 `pi --mode json/rpc` 子进程，它们也加载本扩展；这些进程不发自动通知（否则会弹出不属于你的 “Agent Run Complete”，且子进程退出后点了没反应）
- **来源标识**：toast 正文末尾追加 `项目名 · pane xxx` / `项目名 · WT xxxxxxxx`

## 安装

```powershell
# 复制到 pi 扩展目录
xcopy /E /I pi-clickable-toast "%USERPROFILE%\.pi\agent\extensions\clickable-toast"
cd "%USERPROFILE%\.pi\agent\extensions\clickable-toast"
npm install
```

无运行时依赖：toast 和窗口定位都由 `focus.cs` 编译出的原生 exe 完成（见下）。

## 配置

`%USERPROFILE%\.pi\agent\clickable-toast.json`

```json
{
  "enabled": true,
  "debug": false,
  "showSource": false,
  "projectIcon": true,
  "icon": "",
  "appName": "Pi"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `debug` | `false` | 把每次 toast 和点击结果写到 `%USERPROFILE%\.pi\agent\clickable-toast.log` |
| `showSource` | `false` | 是否在正文末尾追加项目名 |
| `projectIcon` | `true` | 用项目名生成正文左侧的大图（首字母 + 固定颜色） |
| `icon` | 空 | 自定义图标路径（png/jpg/ico），相对路径按 `%USERPROFILE%\.pi\agent` 解析；填了就不用项目图标 |
| `appName` | `Pi` | toast 左上角显示的应用名 |

以上字段都是热生效，改完下一条通知就变，不需要重启 pi。

### 外观

默认 toast 有两处图标：

- **左上角小图标**：由 `appName` 和一个注册表项（`HKCU\Software\Classes\AppUserModelId\Pi.ClickableToast`，不需要管理员权限）决定，用自带图标。第一次发通知时自动写入。
- **正文左侧大图**：由 `projectIcon` 按项目名生成 —— 名字里有分隔符（`-` `_` 空格 `.`）就取前两个词的首字母（`andornot-schedule` → `AS`），否则取第一个字符（`Huajingflow` → `H`）；颜色由项目名的哈希决定，所以同一个项目永远是同一个颜色，换机器也一样。生成的文件缓存在 `%TEMP%\pi-clickable-toast\icons\`。

`icon` 指向不存在的文件时会回退到项目图标，并在 pi 里提示一次。

### 事件路由

事件路由 / 抑制 / 重发规则读取 `@pi-unipi/notify` 的配置 `%USERPROFILE%\.unipi\config\notify\config.json`。若同时安装了 `@pi-unipi/notify`，建议将其 `native.enabled` 设为 `false`，由本扩展接管 native 通道；远程平台（gotify/telegram/ntfy）仍归原工具。

## 点击后的定位行为

点击 toast 会切回通知的来源：

- **Herdr**：找到 Herdr 界面所在的 Windows Terminal 窗口并切到前台，必要时切到它所在的标签页，然后 `herdr agent focus <pane>` 切到对应 pane。找不到任何 Herdr 界面窗口时，新开一个窗口执行 `herdr session attach`。
- **普通终端**：把来源终端窗口切到前台（窗口级，不定位到标签页）。

宿主终端在其他标签页、被其他窗口遮住、或已最小化时都能切回。Windows 在前一次用户输入后的 200 秒内会拒绝后台进程抢前台，扩展会依次尝试几种绕过手段，并且只在真的切到前台后才报告成功。

## 性能

点击后的定位走一个约 10 KB 的原生 exe（`focus.cs`，用系统自带的 .NET Framework `csc.exe` 首次编译后缓存到 `%TEMP%\pi-clickable-toast\`，按源码哈希命名）。机器上没有 `csc.exe` 时自动回退到 `window.ps1`（慢 2~3 倍，功能相同）。实测点击到完成约 0.5 秒。

## 测试

```powershell
npm test          # 单元测试（core/windows 逻辑）
npm run smoke:rpc # 端到端冒烟：spawn RPC 模式 pi → 触发 toast → 模拟 pipe 点击 → 验证清理
```

冒烟脚本要求 Windows + PowerShell（CIM/SnoreToast 进程查询）。

## 已知限制

- Windows Terminal 只能恢复到窗口级，不定位到具体 tab/pane（WT 无公开的反查 API）
- 通知中心里的旧通知靠系统自行过期（12 小时），扩展不会主动清理别的会话的通知
- 点击回调依赖 pi 进程存活（helper 常驻等待系统事件）；pi 退出后通知中心里的条目不再可点
- 编译 toast 支持需要 WinRT 元数据：优先用系统自带的 `C:\Windows\System32\WinMetadata`（Windows 10/11 都有，免装 SDK），其次 Windows SDK 的 `Windows.winmd`；都找不到时 toast 不显示并在 pi 里提示一次

## License

MIT

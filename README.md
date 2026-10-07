# pi-clickable-toast

可点击的 Windows Toast 通知扩展，用于 [pi coding agent](https://github.com/badlogic/pi-mono)。点击 toast 本体即可把焦点切回通知来源的终端窗口或 Herdr pane。

## 功能

- **接管全部 native toast**：自动事件（`agent_end`、`workflow_end`、`ask_user_prompt` 等）和手动 `notify_user` 的 native 通道都由本扩展发送
- **点击回来源**：
  - Herdr 环境（`HERDR_ENV=1`）→ `herdr agent focus <HERDR_PANE_ID>` 精确聚焦对应 pane
  - 普通 Windows Terminal → 原生辅助程序沿父进程链捕获 `MainWindowHandle`，点击时恢复/前置窗口（窗口级）
- **每会话仅最新一条**：新 toast 顶替旧的，不堆叠
- **会话结束即撤通知**：pi 退出、`/reload`、崩溃或终端被关后，它留在通知中心的那条 toast 会被撤掉（这时已没有进程接收点击，留着点了也没反应）。原理：pi 把辅助程序的 stdin 当生命线，会话一结束管道就断，辅助程序收到 EOF 后撤下自己显示的 toast 再退出；辅助程序以 detached 方式启动，否则 pi 一退出它就被 Node 的 job 一起杀掉，来不及撤
- **只在交互终端里自动通知**：magic-context 等扩展会在后台起 `pi --mode json/rpc` 子进程，它们也加载本扩展；这些进程不发自动通知（否则会弹出不属于你的 “Agent Run Complete”，且子进程退出后点了没反应）
- **后台任务运行时也提醒**：agent 用 `bg_run` 等起了会唤醒它的后台任务、自己先结束这一轮时，仍弹「Reply Ready」并显示回复正文；任务全部结束后才弹「Agent Complete」。常驻开发服务器不会再吞掉回复提醒。通过 pi-background-tasks 的 EventBus `status` 查询，并忽略 `notifyOnCompletion=false` 的任务
- **完成通知分清结果**：和 pi 自己一样按最后一条回复的 `stopReason` 判定——正常结束弹「Agent Complete」，正文是回复的第一行；报错弹「Agent Failed」，正文是报错原因（`502 {"error":{"message":…}}` 这类只留 message）；被中断时，10 秒内终端有按键（你按了 Esc）就不弹，没人按键的中断（比如 magic-context 拒绝本轮）弹「Agent Stopped」。工具跑到一半被中断时，pi 常把它记成 `error: This operation was aborted`，这种也按中断处理，不报失败
- **答完不再催**：提问通知的重复提醒（renotify）在终端有按键（比如回答了问题）时立即取消
- **来源标识**：`showSource: true` 时 toast 正文末尾追加项目名

## 安装

```bash
pi install F:\github\pi-clickable-toast   # 本地路径安装，原地加载，不复制
```

`package.json` 里的 `pi.extensions` 指向 `./index.ts`。本地包按解析出的绝对路径识别，所以**不要同时**把它拷到 `%USERPROFILE%\.pi\agent\extensions\clickable-toast` —— 那样会被当成两个包各加载一次，每条通知弹两张。

无运行时依赖，也不需要 `npm install`：toast 和窗口定位都由 `focus.cs` 编译出的原生 exe 完成（见下）。`@earendil-works/pi-coding-agent` 只在 `peerDependencies` 里声明，由 pi 本身提供，实际用到的是类型导入。

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

- **左上角小图标**：由 `appName` 和一个注册表项（`HKCU\Software\Classes\AppUserModelId\Pi.AgentToast`，不需要管理员权限）决定，用自带图标。第一次发通知时自动写入。
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

toast 的显示和点击接收、点击后的定位都走一个约 16 KB 的原生 exe（`focus.cs`，用系统自带的 .NET Framework `csc.exe` 首次编译后缓存到 `%TEMP%\pi-clickable-toast\`，按源码哈希命名）。机器上没有 `csc.exe`、或找不到 WinRT 元数据导致编译失败时，toast 不可用（在 pi 里提示一次）。实测点击到完成约 0.5 秒。

## 测试

```powershell
npm test          # 单元测试（core/windows 逻辑）
npm run smoke:rpc # 端到端冒烟：spawn RPC 模式 pi → 发测试 toast → 退出 pi → 验证辅助程序已退出、通知已从通知中心撤掉
```

冒烟脚本要求 Windows + PowerShell（用 CIM 查辅助程序进程、用 WinRT 查通知中心）。扩展路径按脚本自身位置解析，pi 的 CLI 路径默认取 `PI_CLI` 环境变量、再用内置默认值，换机器可能要改默认值。

## 已知限制

- Windows Terminal 只能恢复到窗口级，不定位到具体 tab/pane（WT 无公开的反查 API）
- 点击回调依赖 pi 进程存活（helper 常驻等待系统事件），所以会话结束时会撤掉自己的通知；旧版本留下的条目、或者辅助程序被手动强杀时留下的条目，仍要等系统 12 小时后过期
- 编译 toast 支持需要 WinRT 元数据：优先用系统自带的 `C:\Windows\System32\WinMetadata`（Windows 10/11 都有，免装 SDK），其次 Windows SDK 的 `Windows.winmd`；都找不到时 toast 不显示并在 pi 里提示一次

## License

MIT

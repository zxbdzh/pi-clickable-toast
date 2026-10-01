param(
  [string]$Action,
  [Int64]$Value
)

if ($Action -notin @("capture", "focus", "foreground", "herdr-focus") -or $Value -lt 1) {
  exit 1
}

if ($Action -eq "capture") {
  $current = [int]$Value
  for ($depth = 0; $depth -lt 24 -and $current -gt 0; $depth++) {
    $process = Get-Process -Id $current -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
      Write-Output ([int64]$process.MainWindowHandle)
      exit 0
    }

    $wmi = $null
    for ($attempt = 0; $attempt -lt 5 -and -not $wmi; $attempt++) {
      if ($attempt -gt 0) { Start-Sleep -Milliseconds 100 }
      $wmi = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    }
    if (-not $wmi) { break }
    $current = [int]$wmi.ParentProcessId
  }
  exit 2
}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PiToastWin32 {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitleW(StringBuilder title, uint size);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

# 把顶层窗口提到前台；失败返回 $false
function Focus-Window([IntPtr]$h) {
  if ([PiToastWin32]::IsIconic($h)) {
    [void][PiToastWin32]::ShowWindowAsync($h, 9)
  }
  [uint32]$ownerPid = 0
  [void][PiToastWin32]::GetWindowThreadProcessId($h, [ref]$ownerPid)
  if ($ownerPid -gt 0) {
    try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$ownerPid) } catch {}
  }
  [void][PiToastWin32]::BringWindowToTop($h)
  $ok = [PiToastWin32]::SetForegroundWindow($h)
  return ($ok -or [PiToastWin32]::GetForegroundWindow() -eq $h)
}

if ($Action -eq "herdr-focus") {
  # Herdr 界面是独立的客户端进程（不带子命令的 herdr.exe），不在 pi 的父进程链上，
  # 所以要直接找它：取它所在 shell 的 ConPTY，其 owner 就是承载的 Windows Terminal 窗口。
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $clients = @(Get-CimInstance Win32_Process -Filter "Name='herdr.exe'" |
    Where-Object { $_.CommandLine -match '^"?[^"]*herdr\.exe"?\s*$' })
  foreach ($client in $clients) {
    $null = [PiToastWin32]::FreeConsole()
    if (-not [PiToastWin32]::AttachConsole([uint32]$client.ProcessId)) { continue }
    $con = [PiToastWin32]::GetConsoleWindow()
    $title = New-Object System.Text.StringBuilder 512
    [void][PiToastWin32]::GetConsoleTitleW($title, 512)
    $null = [PiToastWin32]::FreeConsole()
    if ($con -eq [IntPtr]::Zero) { continue }
    $owner = [PiToastWin32]::GetWindow($con, 4)
    if ($owner -eq [IntPtr]::Zero) { continue }

    # ConPTY 只有所在 tab 处于选中状态时才可见；不可见说明 Herdr 在别的 tab，按标题切过去
    if (-not [PiToastWin32]::IsWindowVisible($con)) {
      try {
        $ae = [System.Windows.Automation.AutomationElement]
        $root = $ae::FromHandle($owner)
        $cond = New-Object System.Windows.Automation.PropertyCondition(
          $ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
        foreach ($tab in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
          if ($tab.Current.Name -eq $title.ToString()) {
            $pattern = $null
            if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
              $pattern.Select()
            }
            break
          }
        }
      } catch {}
    }

    if (Focus-Window $owner) {
      Write-Output ([int64]$owner)
      exit 0
    }
    exit 3
  }
  exit 2
}

$hwnd = [IntPtr]$Value
if ($hwnd -eq [IntPtr]::Zero) { exit 2 }

if ($Action -eq "foreground") {
  if ([PiToastWin32]::GetForegroundWindow() -eq $hwnd) {
    Write-Output "True"
  } else {
    Write-Output "False"
  }
  exit 0
}

if (Focus-Window $hwnd) { exit 0 }
exit 3

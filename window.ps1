param(
  [string]$Action,
  [Int64]$Value
)

if ($Action -notin @("capture", "focus", "foreground", "console") -or $Value -lt 1) {
  exit 1
}

if ($Action -eq "console") {
  # AttachConsole 会改变调用者的 console，且 FreeConsole 后 stdout 失效：
  # 独立类、先输出、后 FreeConsole。
$attachCs = @'
using System;
using System.Runtime.InteropServices;
public static class PiClickableToastAttach {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
  Add-Type -TypeDefinition $attachCs
  $null = [PiClickableToastAttach]::FreeConsole()
  $ok = [PiClickableToastAttach]::AttachConsole([uint32]$Value)
  if (-not $ok) { exit 2 }
  $h = [PiClickableToastAttach]::GetConsoleWindow()
  if ($h -eq [IntPtr]::Zero) { exit 2 }
  Write-Output ([int64]$h)
  exit 0
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

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiClickableToastWin32 {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

$hwnd = [IntPtr]$Value
if ($hwnd -eq [IntPtr]::Zero) { exit 2 }

if ($Action -eq "foreground") {
  if ([PiClickableToastWin32]::GetForegroundWindow() -eq $hwnd) {
    Write-Output "True"
  } else {
    Write-Output "False"
  }
  exit 0
}

if ([PiClickableToastWin32]::IsIconic($hwnd)) {
  [void][PiClickableToastWin32]::ShowWindowAsync($hwnd, 9)
}

[uint32]$ownerPid = 0
[void][PiClickableToastWin32]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
if ($ownerPid -gt 0) {
  try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$ownerPid) } catch {}
}
[void][PiClickableToastWin32]::BringWindowToTop($hwnd)
$focused = [PiClickableToastWin32]::SetForegroundWindow($hwnd)
if ($focused -or [PiClickableToastWin32]::GetForegroundWindow() -eq $hwnd) { exit 0 }
exit 3

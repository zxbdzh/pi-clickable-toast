param(
  [string]$Action,
  [Int64]$Value
)

if ($Action -notin @("capture", "focus", "foreground", "herdr-focus") -or $Value -lt 1) {
  exit 1
}

$script:traceWatch = [System.Diagnostics.Stopwatch]::StartNew()
function Trace([string]$label) {
  if ($env:PI_TOAST_TRACE) { [Console]::Error.WriteLine(("  [trace] {0,-26} +{1} ms" -f $label, $script:traceWatch.ElapsedMilliseconds)); $script:traceWatch.Restart() }
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

$typeSource = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PiToastWin32 {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitleW(StringBuilder title, uint size);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int max);
}
'@

# Compiling the helper with csc costs ~0.5s on every run. Compile once into a hash-named DLL
# under %TEMP% and just load it afterwards; fall back to an in-memory compile on any problem.
function Import-Win32 {
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($typeSource))) -replace '-', '').Substring(0, 12)
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) 'pi-clickable-toast'
    $dll = Join-Path $dir ("Win32-" + $hash + ".dll")
    if (-not (Test-Path -LiteralPath $dll)) {
      [void](New-Item -ItemType Directory -Force -Path $dir)
      $tmp = Join-Path $dir ("Win32-" + $hash + "-" + [guid]::NewGuid().ToString('N') + ".tmp.dll")
      Add-Type -TypeDefinition $typeSource -OutputAssembly $tmp
      Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
    # Assembly.LoadFrom is ~40x cheaper than the Add-Type cmdlet (466 ms -> ~10 ms)
    [void][System.Reflection.Assembly]::LoadFrom($dll)
  } catch {
    if (-not ('PiToastWin32' -as [type])) { Add-Type -TypeDefinition $typeSource }
  }
}
Import-Win32
Trace "import win32 types"

function Wait-Foreground([IntPtr]$h, [int]$ms) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  do {
    if ([PiToastWin32]::GetForegroundWindow() -eq $h) { return $true }
    Start-Sleep -Milliseconds 20
  } while ([DateTime]::UtcNow -lt $deadline)
  return ([PiToastWin32]::GetForegroundWindow() -eq $h)
}

# Bring a top-level window to the foreground and VERIFY it. Windows blocks SetForegroundWindow
# from background processes for 200s after the last user input (foreground lock), which is exactly
# the state right after the user clicks a toast. So try several known bypasses, cheapest first,
# and only report success when GetForegroundWindow really equals the target.
$script:focusVia = "none"
function Focus-Window([IntPtr]$h) {
  if ([PiToastWin32]::IsIconic($h)) { [void][PiToastWin32]::ShowWindow($h, 9) }
  if ([PiToastWin32]::GetForegroundWindow() -eq $h) { $script:focusVia = "already"; return $true }

  # 1. synthetic Alt press: the process then counts as having received the last input event
  [PiToastWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [PiToastWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][PiToastWin32]::BringWindowToTop($h)
  [void][PiToastWin32]::SetForegroundWindow($h)
  if (Wait-Foreground $h 150) { $script:focusVia = "alt"; return $true }

  # 2. share input state with the current foreground thread
  $fg = [PiToastWin32]::GetForegroundWindow()
  [uint32]$fgPid = 0
  $fgThread = [PiToastWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $cur = [PiToastWin32]::GetCurrentThreadId()
  if ($fgThread -ne 0 -and $fgThread -ne $cur) {
    [void][PiToastWin32]::AttachThreadInput($cur, $fgThread, $true)
    [void][PiToastWin32]::BringWindowToTop($h)
    [void][PiToastWin32]::SetForegroundWindow($h)
    [void][PiToastWin32]::AttachThreadInput($cur, $fgThread, $false)
  } else {
    [void][PiToastWin32]::SetForegroundWindow($h)
  }
  if (Wait-Foreground $h 150) { $script:focusVia = "attach"; return $true }

  # 3. undocumented but effective
  [PiToastWin32]::SwitchToThisWindow($h, $true)
  if (Wait-Foreground $h 150) { $script:focusVia = "switch"; return $true }

  # 4. WScript.Shell AppActivate (COM, slowest)
  [uint32]$ownerPid = 0
  [void][PiToastWin32]::GetWindowThreadProcessId($h, [ref]$ownerPid)
  try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$ownerPid) } catch {}
  if (Wait-Foreground $h 250) { $script:focusVia = "appactivate"; return $true }
  return $false
}

function Get-WindowText([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][PiToastWin32]::GetWindowTextW($h, $sb, 512)
  return $sb.ToString()
}

# Select the Windows Terminal tab whose name equals the Herdr console title.
# Returns: selected | notfound | failed
function Select-Tab([IntPtr]$window, [string]$name) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $ae = [System.Windows.Automation.AutomationElement]
  $root = $ae::FromHandle($window)
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    $ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $match = $null
  foreach ($t in $tabs) { if ($t.Current.Name -eq $name) { $match = $t; break } }
  if (-not $match) {
    foreach ($t in $tabs) {
      $n = $t.Current.Name
      if ($n -and ($n.Contains($name) -or $name.Contains($n))) { $match = $t; break }
    }
  }
  if (-not $match) { return "notfound" }
  $pattern = $null
  if (-not $match.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    return "failed"
  }
  for ($i = 0; $i -lt 5; $i++) {
    if ($pattern.Current.IsSelected) { return "selected" }
    try { $pattern.Select() } catch {}
    Start-Sleep -Milliseconds 80
  }
  if ($pattern.Current.IsSelected) { return "selected" }
  return "failed"
}

if ($Action -eq "herdr-focus") {
  # The Herdr UI is a separate client process (herdr.exe without a subcommand). It is not on pi's
  # parent chain, so look for it directly: its console window is owned by the Windows Terminal
  # window that hosts it. Enumerate with .NET (33 ms) instead of CIM (~2 s).
  $target = [IntPtr]::Zero
  $title = ""
  [void][PiToastWin32]::FreeConsole()
  foreach ($proc in [System.Diagnostics.Process]::GetProcessesByName('herdr')) {
    if (-not [PiToastWin32]::AttachConsole([uint32]$proc.Id)) { continue }
    $con = [PiToastWin32]::GetConsoleWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][PiToastWin32]::GetConsoleTitleW($sb, 512)
    [void][PiToastWin32]::FreeConsole()
    if ($con -eq [IntPtr]::Zero) { continue }
    $owner = [PiToastWin32]::GetWindow($con, 4)
    if ($owner -eq [IntPtr]::Zero) { continue }
    $cls = New-Object System.Text.StringBuilder 128
    [void][PiToastWin32]::GetClassNameW($owner, $cls, 128)
    if ($cls.ToString() -ne 'CASCADIA_HOSTING_WINDOW_CLASS') { continue }
    $target = $owner
    $title = $sb.ToString()
    break
  }
  Trace "find herdr client"
  if ($target -eq [IntPtr]::Zero) {
    [Console]::Error.WriteLine("no herdr client window found")
    exit 2
  }

  # Raise the window first: UI Automation is unreliable on a minimized window.
  if (-not (Focus-Window $target)) {
    [Console]::Error.WriteLine(("focus failed: target=" + [int64]$target + " foreground=" + [int64][PiToastWin32]::GetForegroundWindow()))
    exit 3
  }

  Trace ("focus window via=" + $script:focusVia)

  # IsWindowVisible() on the console window stays True when another tab is selected, so compare
  # the terminal window title (= selected tab name) with the Herdr console title instead.
  $tab = "already"
  if ($title.Length -gt 0 -and (Get-WindowText $target) -ne $title) {
    $tab = Select-Tab $target $title
  }
  Trace ("tab=" + $tab)
  Write-Output (([int64]$target).ToString() + " via=" + $script:focusVia + " tab=" + $tab)
  exit 0
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
[Console]::Error.WriteLine(("focus failed: target=" + [int64]$hwnd + " foreground=" + [int64][PiToastWin32]::GetForegroundWindow()))
exit 3

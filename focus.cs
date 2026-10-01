// PiToastFocus: tiny native helper used by the clickable-toast extension.
//
// It replaces window.ps1 on the hot path. Starting PowerShell plus its first-call JIT costs
// 1.1-1.8 s on every click; this exe starts in tens of milliseconds. window.ps1 stays as a
// fallback for machines where the .NET Framework C# compiler is unavailable.
//
// Same CLI as window.ps1:   PiToastFocus.exe -Action <name> -Value <number>
//   capture <pid>     print the first ancestor window handle of <pid>        (exit 2: none)
//   focus <hwnd>      bring a top-level window to the foreground and verify   (exit 3: refused)
//   foreground <hwnd> print True/False: is the window already in the foreground
//   herdr-focus 1     raise the Windows Terminal window hosting the Herdr UI and select its tab
//                     (stdout: "<hwnd> via=<method> tab=<state>", exit 2: no herdr UI window)
//
// Must stay C# 5 compatible: it is compiled with the in-box .NET Framework csc.exe.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class Native
{
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitleW(StringBuilder title, uint size);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll")] public static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] public static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder name, int max);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
}

internal static class Program
{
    private static string focusVia = "none";

    private static int Main(string[] args)
    {
        string action = null;
        long value = 0;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "-Action") action = args[i + 1];
            else if (args[i] == "-Value") long.TryParse(args[i + 1], out value);
        }
        if (action == null || value < 1) return 1;

        // Redirected stdout/stderr are plain pipe handles, so they survive FreeConsole/AttachConsole.
        try
        {
            switch (action)
            {
                case "capture": return Capture((int)value);
                case "foreground":
                    Console.Out.Write(Native.GetForegroundWindow() == new IntPtr(value) ? "True" : "False");
                    return 0;
                case "focus":
                    if (FocusWindow(new IntPtr(value))) return 0;
                    Console.Error.WriteLine("focus failed: target=" + value + " foreground=" + Native.GetForegroundWindow().ToInt64());
                    return 3;
                case "herdr-focus": return HerdrFocus();
                default: return 1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("error: " + ex.Message);
            return 4;
        }
    }

    // ---- capture: first ancestor process that owns a top-level window ---------------------------

    private static Dictionary<int, int> ParentMap()
    {
        Dictionary<int, int> map = new Dictionary<int, int>();
        IntPtr snap = Native.CreateToolhelp32Snapshot(0x2, 0); // TH32CS_SNAPPROCESS
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
        try
        {
            Native.PROCESSENTRY32 entry = new Native.PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32));
            bool more = Native.Process32First(snap, ref entry);
            while (more)
            {
                map[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
                more = Native.Process32Next(snap, ref entry);
            }
        }
        finally { Native.CloseHandle(snap); }
        return map;
    }

    private static int Capture(int pid)
    {
        Dictionary<int, int> parents = ParentMap();
        int current = pid;
        for (int depth = 0; depth < 24 && current > 0; depth++)
        {
            try
            {
                using (Process p = Process.GetProcessById(current))
                {
                    long hwnd = p.MainWindowHandle.ToInt64();
                    if (hwnd != 0) { Console.Out.Write(hwnd.ToString()); return 0; }
                }
            }
            catch (ArgumentException) { }
            int next;
            if (!parents.TryGetValue(current, out next)) break;
            current = next;
        }
        return 2;
    }

    // ---- focus: bypass the foreground lock and verify the result -------------------------------

    private static bool WaitForeground(IntPtr h, int ms)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(ms);
        do
        {
            if (Native.GetForegroundWindow() == h) return true;
            Thread.Sleep(20);
        } while (DateTime.UtcNow < deadline);
        return Native.GetForegroundWindow() == h;
    }

    // Windows refuses SetForegroundWindow from a background process for 200 s after the last user
    // input (foreground lock), which is exactly the state right after clicking a toast. Try the known
    // bypasses, cheapest first, and only report success when the window really is in the foreground.
    private static bool FocusWindow(IntPtr h)
    {
        if (Native.IsIconic(h)) Native.ShowWindow(h, 9); // SW_RESTORE
        if (Native.GetForegroundWindow() == h) { focusVia = "already"; return true; }

        // 1. synthetic Alt press: this process then counts as having received the last input event
        Native.keybd_event(0x12, 0, 0, UIntPtr.Zero);
        Native.keybd_event(0x12, 0, 2, UIntPtr.Zero);
        Native.BringWindowToTop(h);
        Native.SetForegroundWindow(h);
        if (WaitForeground(h, 150)) { focusVia = "alt"; return true; }

        // 2. share input state with the current foreground thread
        uint fgPid;
        uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out fgPid);
        uint cur = Native.GetCurrentThreadId();
        if (fgThread != 0 && fgThread != cur)
        {
            Native.AttachThreadInput(cur, fgThread, true);
            Native.BringWindowToTop(h);
            Native.SetForegroundWindow(h);
            Native.AttachThreadInput(cur, fgThread, false);
        }
        else
        {
            Native.SetForegroundWindow(h);
        }
        if (WaitForeground(h, 150)) { focusVia = "attach"; return true; }

        // 3. undocumented but effective
        Native.SwitchToThisWindow(h, true);
        if (WaitForeground(h, 250)) { focusVia = "switch"; return true; }
        return false;
    }

    // ---- herdr-focus --------------------------------------------------------------------------

    private static string WindowText(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        Native.GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // Select the Windows Terminal tab named like the Herdr console title: selected | notfound | failed
    private static string SelectTab(IntPtr window, string name)
    {
        AutomationElement root = AutomationElement.FromHandle(window);
        AutomationElementCollection tabs = root.FindAll(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));

        AutomationElement match = null;
        foreach (AutomationElement t in tabs)
        {
            if (t.Current.Name == name) { match = t; break; }
        }
        if (match == null)
        {
            foreach (AutomationElement t in tabs)
            {
                string n = t.Current.Name;
                if (!string.IsNullOrEmpty(n) && (n.Contains(name) || name.Contains(n))) { match = t; break; }
            }
        }
        if (match == null) return "notfound";

        object raw;
        if (!match.TryGetCurrentPattern(SelectionItemPattern.Pattern, out raw)) return "failed";
        SelectionItemPattern pattern = (SelectionItemPattern)raw;
        for (int i = 0; i < 5; i++)
        {
            if (pattern.Current.IsSelected) return "selected";
            try { pattern.Select(); } catch (Exception) { }
            Thread.Sleep(80);
        }
        return pattern.Current.IsSelected ? "selected" : "failed";
    }

    // The Herdr UI is a separate client process (herdr.exe without a subcommand). It is not on pi's
    // parent chain, so look for it directly: its console window is owned by the Windows Terminal
    // window that hosts it.
    private static int HerdrFocus()
    {
        IntPtr target = IntPtr.Zero;
        string title = "";
        Native.FreeConsole();
        foreach (Process proc in Process.GetProcessesByName("herdr"))
        {
            if (!Native.AttachConsole((uint)proc.Id)) continue;
            IntPtr con = Native.GetConsoleWindow();
            StringBuilder sb = new StringBuilder(512);
            Native.GetConsoleTitleW(sb, 512);
            Native.FreeConsole();
            if (con == IntPtr.Zero) continue;
            IntPtr owner = Native.GetWindow(con, 4); // GW_OWNER
            if (owner == IntPtr.Zero) continue;
            StringBuilder cls = new StringBuilder(128);
            Native.GetClassNameW(owner, cls, 128);
            if (cls.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") continue;
            target = owner;
            title = sb.ToString();
            break;
        }
        if (target == IntPtr.Zero)
        {
            Console.Error.WriteLine("no herdr client window found");
            return 2;
        }

        // Raise the window first: UI Automation is unreliable on a minimized window.
        if (!FocusWindow(target))
        {
            Console.Error.WriteLine("focus failed: target=" + target.ToInt64() + " foreground=" + Native.GetForegroundWindow().ToInt64());
            return 3;
        }

        // IsWindowVisible() on the console window stays true when another tab is selected, so compare the
        // terminal window title (= selected tab name) with the Herdr console title instead.
        string tab = "already";
        if (title.Length > 0 && WindowText(target) != title) tab = SelectTab(target, title);
        Console.Out.Write(target.ToInt64() + " via=" + focusVia + " tab=" + tab);
        return 0;
    }
}

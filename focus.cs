// PiToastFocus: tiny native helper used by the clickable-toast extension. It shows the toasts and
// reports their clicks, and finds and focuses the source terminal afterwards. It starts in tens of
// milliseconds, where a PowerShell script needed 1.1-1.8 s per call for the same work.
//
// CLI:   PiToastFocus.exe -Action <name> -Value <number>
//   capture <pid>     print the first ancestor window handle of <pid>        (exit 2: none)
//   focus <hwnd>      bring a top-level window to the foreground and verify   (exit 3: refused)
//   foreground <hwnd> print True/False: is the window already in the foreground
//   herdr-focus 1     raise the Windows Terminal window hosting the Herdr UI and select its tab
//                     (stdout: "<hwnd> via=<method> tab=<state>", exit 2: no herdr UI window)
//   icon              draw a rounded-square project icon: -Text <1-2 chars> -Color <RRGGBB> -Out <png path>
//   toast             show a toast that reports clicks: -Title, -Message, -AppID, [-Icon png], [-Tag t],
//                     [-ParentPid pid], [-Lifeline stdin]
//                     (stdout: activated | dismissed | failed | timeout | closed | orphan; stays alive for
//                      clicks from the notification centre too, exit code 0 only on activated)
//
// Must stay C# 5 compatible: it is compiled with the in-box .NET Framework csc.exe.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

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
        // every "-Name value" pair, so actions can take more than the single numeric -Value
        Dictionary<string, string> opts = new Dictionary<string, string>();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i].StartsWith("-")) opts[args[i].Substring(1)] = args[i + 1];
        }
        string action;
        opts.TryGetValue("Action", out action);
        if (action == null) return 1;

        if (action == "icon")
        {
            string text, color, outPath;
            opts.TryGetValue("Text", out text);
            opts.TryGetValue("Color", out color);
            opts.TryGetValue("Out", out outPath);
            try { return MakeIcon(text, color, outPath); }
            catch (Exception ex) { Console.Error.WriteLine("error: " + ex.Message); return 4; }
        }

        if (action == "toast")
        {
            try { return ShowToast(opts); }
            catch (Exception ex) { Console.Error.WriteLine("error: " + ex.Message); return 4; }
        }

        long value = 0;
        string rawValue;
        if (opts.TryGetValue("Value", out rawValue)) long.TryParse(rawValue, out value);
        if (value < 1) return 1;

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

    // ---- icon: per-project avatar for the toast image ----------------------------------------
    private static double SrgbChannel(byte value)
    {
        double srgb = value / 255.0;
        return srgb <= 0.03928 ? srgb / 12.92 : Math.Pow((srgb + 0.055) / 1.055, 2.4);
    }

    // Keep initials readable on the brighter hash-generated colors.
    private static Brush IconTextBrush(Color fill)
    {
        double luminance = 0.2126 * SrgbChannel(fill.R) + 0.7152 * SrgbChannel(fill.G) + 0.0722 * SrgbChannel(fill.B);
        return luminance > 0.179 ? Brushes.Black : Brushes.White;
    }


    // 256x256 rounded square in <color> with contrast-aware centred initials (same shape as the built-in icon)
    private static int MakeIcon(string text, string colorHex, string outPath)
    {
        int rgb;
        if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(outPath) ||
            !int.TryParse(colorHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rgb)) return 1;

        const int size = 256;
        const int corner = 56;
        Color fill = Color.FromArgb(255, (rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
        using (Bitmap bmp = new Bitmap(size, size))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddArc(0, 0, corner, corner, 180, 90);
                path.AddArc(size - corner, 0, corner, corner, 270, 90);
                path.AddArc(size - corner, size - corner, corner, corner, 0, 90);
                path.AddArc(0, size - corner, corner, corner, 90, 90);
                path.CloseFigure();
                using (Brush brush = new SolidBrush(fill)) g.FillPath(brush, path);
            }
            float pixels = text.Length > 1 ? 112f : 150f;
            using (Font font = new Font("Segoe UI", pixels, FontStyle.Bold, GraphicsUnit.Pixel))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                g.DrawString(text, font, IconTextBrush(fill), new RectangleF(0, 4, size, size), format);
            }
            // write next to the target and copy over it, so a reader never sees a half-written PNG
            string tmp = outPath + "." + Process.GetCurrentProcess().Id + ".tmp";
            bmp.Save(tmp, ImageFormat.Png);
            File.Copy(tmp, outPath, true);
            File.Delete(tmp);
        }
        return 0;
    }

    // ---- toast: show it and report the click ------------------------------------------------

    private static string XmlEscape(string s)
    {
        if (s == null) return "";
        return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
    }

    // Windows keeps a toast in the action centre for hours, so a click can arrive long after the banner
    // disappeared. Stay alive for either event; only a user-close, the end of the pi session, or a very
    // long deadline ends the wait. If the session ends first nobody is left to handle a click, so take the
    // toast out of the action centre instead of leaving a dead entry behind.
    private static int ShowToast(Dictionary<string, string> opts)
    {
        string title, message, appId, icon, tag, rawParent, lifeline;
        opts.TryGetValue("Title", out title);
        opts.TryGetValue("Message", out message);
        opts.TryGetValue("AppID", out appId);
        opts.TryGetValue("Icon", out icon);
        opts.TryGetValue("Tag", out tag);
        opts.TryGetValue("ParentPid", out rawParent);
        opts.TryGetValue("Lifeline", out lifeline);
        int parentPid = 0;
        if (!string.IsNullOrEmpty(rawParent)) int.TryParse(rawParent, out parentPid);
        if (string.IsNullOrEmpty(appId)) return 1;

        string image = string.IsNullOrEmpty(icon)
            ? ""
            : "<image placement=\"appLogoOverride\" hint-crop=\"square\" src=\"" + XmlEscape(new Uri(icon).AbsoluteUri) + "\"/>";
        XmlDocument xml = new XmlDocument();
        xml.LoadXml(
            "<toast><visual><binding template=\"ToastGeneric\">" +
            "<text>" + XmlEscape(title) + "</text>" +
            "<text>" + XmlEscape(message) + "</text>" +
            image +
            "</binding></visual></toast>");

        ToastNotification toast = new ToastNotification(xml);
        if (!string.IsNullOrEmpty(tag)) toast.Tag = tag;
        toast.ExpirationTime = DateTimeOffset.Now.AddHours(12);

        ManualResetEventSlim done = new ManualResetEventSlim(false);
        object gate = new object();
        string result = null;
        // first outcome wins: a click that races the end of the session still reports "activated"
        Action<string> finish = r => { lock (gate) { if (result == null) result = r; } done.Set(); };
        toast.Activated += (s, e) => finish("activated");
        toast.Dismissed += (s, e) =>
        {
            // TimedOut only means the banner left the screen; the notification is still clickable in the
            // action centre, so keep waiting (this is the common case: the user clicks it later).
            if (e.Reason == ToastDismissalReason.TimedOut) return;
            finish("dismissed");
        };
        toast.Failed += (s, e) => finish("failed");

        ToastNotifier notifier = ToastNotificationManager.CreateToastNotifier(appId);
        notifier.Show(toast);

        // -Lifeline stdin: pi holds our stdin open and never writes to it, so EOF means its session is over
        // (exit, /reload, crash or a closed terminal alike) - right away, unlike the parent poll below.
        if (lifeline == "stdin")
        {
            Thread watcher = new Thread(() =>
            {
                try
                {
                    Stream input = Console.OpenStandardInput();
                    byte[] buffer = new byte[64];
                    while (input.Read(buffer, 0, buffer.Length) > 0) { }
                }
                catch (Exception) { }
                finish("closed");
            });
            watcher.IsBackground = true;
            watcher.Start();
        }

        // Wait in slices so a dead parent (pi crashed or was killed) does not leave us behind for hours.
        DateTime deadline = DateTime.Now.AddHours(12);
        while (DateTime.Now < deadline)
        {
            if (done.Wait(TimeSpan.FromSeconds(20))) break;
            if (parentPid > 0 && !ProcessExists(parentPid)) { finish("orphan"); break; }
        }
        lock (gate) { if (result == null) result = "timeout"; }
        if (result == "closed" || result == "orphan")
        {
            // Hide() from the process that showed the toast also drops it from the action centre
            try { notifier.Hide(toast); } catch (Exception) { }
        }
        Console.Out.Write(result);
        return result == "activated" ? 0 : 1;
    }

    private static bool ProcessExists(int pid)
    {
        try { using (Process.GetProcessById(pid)) return true; }
        catch (ArgumentException) { return false; }
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

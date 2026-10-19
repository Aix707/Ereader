param([Parameter(Mandatory=$true)][int]$ReaderProcessId)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class EreaderWindowMetrics {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public int Flags; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static object Read(int processId) {
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr window = Process.GetProcessById(processId).MainWindowHandle;
      if (window == IntPtr.Zero) throw new InvalidOperationException("Reader window not found");
      Rect frame, client;
      Point origin = new Point();
      MonitorInfo monitor = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
      if (!GetWindowRect(window, out frame) || !GetClientRect(window, out client) ||
          !ClientToScreen(window, ref origin) || !GetMonitorInfoW(MonitorFromWindow(window, 2), ref monitor))
        throw new InvalidOperationException("Cannot read native window bounds");
      return new {
        Frame = Box(frame),
        Client = new { X = origin.X, Y = origin.Y, Width = client.Right - client.Left, Height = client.Bottom - client.Top },
        Monitor = Box(monitor.Monitor), WorkArea = Box(monitor.Work),
        IsZoomed = IsZoomed(window), IsForeground = GetForegroundWindow() == window
      };
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  static object Box(Rect rect) { return new { X = rect.Left, Y = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top }; }
}
'@
[EreaderWindowMetrics]::Read($ReaderProcessId) | ConvertTo-Json -Depth 5 -Compress

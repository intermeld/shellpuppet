// A test-only console executable. Create a real console for the wrapper's
// child, but hide it so a regression run leaves the desktop undisturbed.
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

class ConsoleWrapper {
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint Pid, Tid;
    }
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string file, StringBuilder args, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment,
        string cwd, ref StartupInfo startup, out ProcessInfo child);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32")] static extern bool FreeConsole();
    [DllImport("kernel32", SetLastError = true)] static extern bool AttachConsole(uint pid);

    static int Main(string[] args) {
        if (args[0] == "probe") {
            FreeConsole();
            return AttachConsole(uint.Parse(args[1])) ? 0 : Marshal.GetLastWin32Error();
        }
        Environment.SetEnvironmentVariable("SP_WRAPPER_TEST", "stand-in-resolved");
        var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = 1, ShowWindow = 0 };
        // The fixture receives file paths and the daemon entry option.
        var command = new StringBuilder(string.Join(" ", args.Select(arg => "\"" + arg + "\"")));
        ProcessInfo child;
        const uint CREATE_NEW_CONSOLE = 0x10;
        if (!CreateProcessW(args[0], command, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE,
                IntPtr.Zero, null, ref startup, out child)) return Marshal.GetLastWin32Error();
        CloseHandle(child.Thread);
        using (var wrapper = System.Diagnostics.Process.GetCurrentProcess()) {
            File.WriteAllLines(Path.Combine(Environment.GetEnvironmentVariable("SHELLPUPPET_HOME"), "wrapper-pids"),
                new[] { wrapper.Id.ToString(), child.Pid.ToString() });
        }
        WaitForSingleObject(child.Process, uint.MaxValue);
        int exitCode;
        GetExitCodeProcess(child.Process, out exitCode);
        CloseHandle(child.Process);
        return exitCode;
    }
}

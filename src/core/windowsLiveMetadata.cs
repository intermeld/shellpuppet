// The inbox Windows PowerShell host loads this once, before shutdown. No WMI
// scan or compiler start is needed when the daemon asks for its process tree.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class LiveMetadata {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        public uint size, usage;
        public int pid;
        public UIntPtr heap;
        public uint module, threads;
        public int parent, priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }

    [DllImport("kernel32")] static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);

    static string Images() {
        var output = new StringBuilder();
        using (var snapshot = CreateToolhelp32Snapshot(2, 0)) {
            var row = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (snapshot.IsInvalid || !Process32First(snapshot, ref row)) return "";
            do {
                output.AppendFormat("{0}\t{1}\t{2}\n", row.pid, row.parent,
                    Convert.ToBase64String(Encoding.UTF8.GetBytes(row.name)));
            } while (Process32Next(snapshot, ref row));
        }
        return output.ToString();
    }

    static string Births(string pids) {
        var output = new StringBuilder();
        foreach (var pid in Array.ConvertAll(pids.Split(','), int.Parse)) {
            try {
                using (var process = Process.GetProcessById(pid)) {
                    long ticks = process.StartTime.ToUniversalTime().Ticks - 621355968000000000L;
                    var name = process.ProcessName;
                    if (!process.HasExited) output.AppendFormat("{0}\t{1}\t{2}\n", pid, ticks,
                        Convert.ToBase64String(Encoding.UTF8.GetBytes(name)));
                }
            } catch (ArgumentException) {} catch (InvalidOperationException) {} catch (System.ComponentModel.Win32Exception) {}
        }
        return output.ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
        public uint volume, sizeHigh, size, links, indexHigh, index;
    }

    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateFile(
        string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32")] static extern SafeFileHandle ReOpenFile(SafeFileHandle file, uint access, uint share, uint flags);
    [DllImport("kernel32")] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);

    // Open the component itself for attributes, including every reparse tag.
    // Holding the handle without write/delete sharing pins each checked name.
    static SafeFileHandle Inspect(string path, bool directory, out FileInfo info) {
        const uint attributes = 0x80, shareRead = 1, openExisting = 3;
        const uint reparsePoint = 0x00200000, backupSemantics = 0x02000000;
        var handle = CreateFile(path, attributes, shareRead, IntPtr.Zero, openExisting,
            reparsePoint | backupSemantics, IntPtr.Zero);
        if (!GetFileInformationByHandle(handle, out info) || (info.attributes & 0x400) != 0 ||
            ((info.attributes & 0x10) != 0) != directory || (!directory && info.links != 1)) {
            handle.Dispose();
            throw new IOException();
        }
        return handle;
    }

    static string Read(string config, int pid, long earliestMtime) {
        FileInfo info;
        string sessions = Path.Combine(config, "sessions");
        using (Inspect(config, true, out info))
        using (Inspect(sessions, true, out info))
        using (var file = Inspect(Path.Combine(sessions, pid + ".json"), false, out info)) {
            long modified = (((long)info.write.dwHighDateTime << 32) | (uint)info.write.dwLowDateTime) / 10000 - 11644473600000L;
            if (modified < earliestMtime || info.sizeHigh != 0 || info.size == 0 || info.size > 65536) return "";
            using (var data = ReOpenFile(file, 0x80000000, 1, 0x00200000))
            using (var stream = new FileStream(data, FileAccess.Read))
            using (var reader = new BinaryReader(stream)) {
                var bytes = reader.ReadBytes((int)info.size + 1);
                if (bytes.Length != info.size || !GetFileInformationByHandle(file, out info) || info.links != 1) return "";
                return Encoding.UTF8.GetString(bytes);
            }
        }
    }

    static void Respond(string[] fields) {
        string value = "";
        try {
            if (fields[1] == "images") value = Images();
            if (fields[1] == "births") value = Births(fields[2]);
            if (fields[1] == "read") value = Read(Encoding.UTF8.GetString(Convert.FromBase64String(fields[2])),
                int.Parse(fields[3]), long.Parse(fields[4]));
        } catch (Exception) { /* Unavailable evidence leaves the reported id in effect. */ }
        Console.WriteLine(fields[0] + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
    }

    public static void Run() {
        string line;
        while ((line = Console.ReadLine()) != null) {
            var fields = line.Split('\t');
            Task.Run(() => Respond(fields));
        }
    }
}

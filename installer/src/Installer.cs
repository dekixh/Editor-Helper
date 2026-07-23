// installer/src/Installer.cs — install / uninstall business logic + elevation.
// Runs on a worker thread; raises events the form marshals onto the UI thread.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace EhSetup
{
    // Wizard state serialized when relaunching elevated.
    [Serializable]
    public class Cfg
    {
        public string InstallPath;
        public bool Desktop, StartMenu, Startup, LaunchOnFinish;
        public bool AutoStart; // jump straight to installing page
    }

    public sealed class Installer
    {
        public string Repo = "dekixh/Editor-Helper-Lite";
        public string PointerUrl = "https://raw.githubusercontent.com/dekixh/Editor-Helper-Lite/main/latest.txt";
        public string AssetName = "Editor-Helper.exe";
        public string SetupName = "Editor-Helper-Setup.exe";
        public string AppName = "Editor Helper";
        public const string RegUninstall = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Editor-Helper";

        public Cfg C;

        // events (worker thread)
        public event Action<string, string> Phase;     // title, sub
        public event Action<string> Log;              // log line
        public event Action<int, long, long, double, double> Progress; // %, recv, total, speedBps, etaSec
        public event Action<string> FileCur;          // current file label
        public event Action<int, int> FileCount;      // done,total
        public event Action<string> Fail;             // fatal
        public event Action Done;

        private string resolvedUrl;
        private string oldInstallLocation;

        public void Run()
        {
            try
            {
                ForceTls12();

                RaisePhase("Подготовка", "Поиск последней версии…");
                RaiseLog("Запуск установщика Editor Helper");

                // 1. resolve latest asset URL
                string cb = DateTime.Now.Ticks.ToString();
                using (WebClient wc = NewClient())
                    resolvedUrl = wc.DownloadString(PointerUrl + "?cb=" + cb).Trim();
                if (resolvedUrl.Length == 0 || !resolvedUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    throw new Exception("Не удалось получить ссылку на последнюю версию.");
                RaiseLog("Последняя версия: " + resolvedUrl);

                // 2. detect previous install
                oldInstallLocation = ReadRegistry(RegUninstall, "InstallLocation");
                if (!string.IsNullOrEmpty(oldInstallLocation) && Directory.Exists(oldInstallLocation))
                    RaiseLog("Найдена предыдущая установка: " + oldInstallLocation);

                // 3. disk space
                long free = FreeBytes(C.InstallPath);
                long req = 100L * 1024 * 1024; // ~100 MB headroom (exe ~75)
                RaiseLog("Свободно на диске: " + FmtBytes(free) + "  требуется ~" + FmtBytes(req));
                if (free >= 0 && free < req)
                    throw new Exception("Недостаточно свободного места: " + FmtBytes(free) + ". Требуется около " + FmtBytes(req) + ".");

                // 4. close running app
                RaisePhase("Подготовка", "Завершаю запущенную программу…");
                KillRunning();

                // 5. download
                RaisePhase("Загрузка", AssetName);
                RaiseFile(AssetName);
                RaiseFileCount(0, 2);
                string tmp = Path.Combine(Path.GetTempPath(), "eh-" + Guid.NewGuid().ToString("N") + ".exe");
                long total = DownloadFile(resolvedUrl, tmp);

                // 6. copy files
                RaisePhase("Установка", "Копирование файлов…");
                Directory.CreateDirectory(C.InstallPath);
                string destExe = Path.Combine(C.InstallPath, AssetName);
                RaiseFile(AssetName);
                RaiseFileCount(1, 2);
                CopyOverwrite(tmp, destExe);
                RaiseLog("Установлен " + AssetName + " (" + FmtBytes(new FileInfo(destExe).Length) + ")");
                try { File.Delete(tmp); } catch { }

                // uninstaller (copy self)
                RaiseFile(SetupName);
                RaiseFileCount(2, 2);
                string self = Application.ExecutablePath;
                string destSetup = Path.Combine(C.InstallPath, SetupName);
                if (!string.IsNullOrEmpty(self) && File.Exists(self))
                {
                    CopyOverwrite(self, destSetup);
                    RaiseLog("Установлен деинсталлятор: " + SetupName);
                }

                // 7. remove old install at a different location
                if (!string.IsNullOrEmpty(oldInstallLocation) &&
                    !string.Equals(NormalizeDir(oldInstallLocation), NormalizeDir(C.InstallPath), StringComparison.OrdinalIgnoreCase))
                {
                    RaiseLog("Удаляю старую версию: " + oldInstallLocation);
                    try { if (Directory.Exists(oldInstallLocation)) DeleteDirRobust(oldInstallLocation); } catch (Exception ex) { RaiseLog("  не удалось удалить старую папку: " + ex.Message); }
                }

                // 8. shortcuts
                RaisePhase("Установка", "Создание ярлыков…");
                CreateShortcuts(destExe);
                RaiseLog("Ярлыки созданы (Пуск" + (C.Desktop ? ", Рабочий стол" : "") + (C.Startup ? ", Автозапуск" : "") + ")");

                // 9. registry (Add/Remove Programs + optional autostart kept as startup shortcut)
                RaisePhase("Установка", "Регистрация в системе…");
                WriteRegistry(destExe, destSetup);
                RaiseLog("Запись в реестре создана");

                RaisePhase("Завершение", "Почти готово…");
                RaiseDone();
            }
            catch (Exception ex)
            {
                RaiseFail(ex.Message);
            }
        }

        // ── download with progress/speed/eta ─────────────────────────────────────
        private long DownloadFile(string url, string dest)
        {
            long total = 0;
            using (WebClient wc = NewClient())
            {
                Exception err = null;
                AutoResetEvent done = new AutoResetEvent(false);
                DateTime start = DateTime.UtcNow;
                long lastRecv = 0; DateTime lastTick = DateTime.UtcNow; double smoothSpeed = 0;
                wc.DownloadProgressChanged += delegate(object s, DownloadProgressChangedEventArgs e)
                {
                    total = e.TotalBytesToReceive;
                    double now = (DateTime.UtcNow - lastTick).TotalSeconds;
                    if (now >= 0.25)
                    {
                        double inst = (e.BytesReceived - lastRecv) / now;
                        smoothSpeed = (smoothSpeed == 0) ? inst : smoothSpeed * 0.6 + inst * 0.4;
                        lastRecv = e.BytesReceived; lastTick = DateTime.UtcNow;
                    }
                    double eta = smoothSpeed > 0 ? (e.TotalBytesToReceive - e.BytesReceived) / smoothSpeed : 0;
                    if (Progress != null) Progress(e.ProgressPercentage, e.BytesReceived, e.TotalBytesToReceive, smoothSpeed, eta);
                };
                wc.DownloadFileCompleted += delegate(object s, AsyncCompletedEventArgs e) { err = e.Error; done.Set(); };
                wc.DownloadFileAsync(new Uri(url), dest);
                done.WaitOne();
                if (err != null) throw new Exception("Скачивание не удалось: " + err.Message);
                RaiseLog("Загружено " + FmtBytes(total) + " (" + resolvedUrl + ")");
            }
            return total;
        }

        // ── shortcuts via one PowerShell call ────────────────────────────────────
        private void CreateShortcuts(string target)
        {
            string dir = Path.GetDirectoryName(target);
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            sb.Append("$s=(New-Object -ComObject WScript.Shell);");
            if (C.StartMenu)
            {
                string p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk");
                sb.Append(MakeLnk(p, target, dir));
            }
            if (C.Desktop)
            {
                string p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), AppName + ".lnk");
                sb.Append(MakeLnk(p, target, dir));
            }
            if (C.Startup)
            {
                string p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), AppName + ".lnk");
                sb.Append(MakeLnk(p, target, dir));
            }
            if (C.StartMenu || C.Desktop || C.Startup)
                RunHidden("powershell", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"" + sb + "\"");
        }
        private static string MakeLnk(string lnk, string target, string dir)
        {
            return "$l=$s.CreateShortcut('" + lnk + "');$l.TargetPath='" + target + "';$l.WorkingDirectory='" + dir + "';$l.Description='Editor Helper';$l.Save();";
        }

        // ── registry ─────────────────────────────────────────────────────────────
        private void WriteRegistry(string exe, string setupExe)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RegUninstall))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", "");
                k.SetValue("Publisher", "dekixh");
                k.SetValue("DisplayIcon", exe);
                k.SetValue("InstallLocation", C.InstallPath);
                k.SetValue("InstallSource", resolvedUrl);
                k.SetValue("URLInfoAbout", "https://github.com/" + Repo);
                k.SetValue("UninstallString", "\"" + setupExe + "\" --uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        // ── uninstall ────────────────────────────────────────────────────────────
        public void Uninstall()
        {
            try
            {
                RaisePhase("Удаление", "Останавливаю программу…");
                ForceTls12();
                KillRunning();
                RaiseLog("Editor Helper остановлен");

                RaisePhase("Удаление", "Удаляю файлы…");
                string loc = C.InstallPath;
                if (string.IsNullOrEmpty(loc)) loc = ReadRegistry(RegUninstall, "InstallLocation");
                string self = Application.ExecutablePath;

                if (!string.IsNullOrEmpty(loc) && Directory.Exists(loc))
                {
                    foreach (string f in Directory.GetFiles(loc, "*", SearchOption.TopDirectoryOnly))
                    {
                        if (string.Equals(f, self, StringComparison.OrdinalIgnoreCase)) continue;
                        try { File.Delete(f); RaiseLog("Удалён " + Path.GetFileName(f)); } catch (Exception ex) { RaiseLog("  не удалось: " + Path.GetFileName(f) + " — " + ex.Message); }
                    }
                    foreach (string d in Directory.GetDirectories(loc, "*", SearchOption.TopDirectoryOnly))
                    { try { Directory.Delete(d, true); } catch { } }
                }

                RaisePhase("Удаление", "Удаляю ярлыки…");
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.Programs));
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.Desktop));
                DeleteShortcut(Environment.GetFolderPath(Environment.SpecialFolder.Startup));
                RaiseLog("Ярлыки удалены");

                RaisePhase("Удаление", "Очищаю реестр…");
                try { Registry.CurrentUser.DeleteSubKey(RegUninstall, false); RaiseLog("Запись реестра удалена"); } catch { }

                // schedule self-delete + remove empty folder (waits for THIS process
                // to exit so the .exe is no longer locked before we delete it)
                if (!string.IsNullOrEmpty(self))
                {
                    int pid = Process.GetCurrentProcess().Id;
                    string ps = "try { Wait-Process -Id " + pid + " -Timeout 30 -ErrorAction SilentlyContinue } catch {};";
                    ps += " Start-Sleep -Milliseconds 300; Remove-Item -LiteralPath '" + self + "' -Force -ErrorAction SilentlyContinue;";
                    if (!string.IsNullOrEmpty(loc)) ps += " Remove-Item -LiteralPath '" + loc.TrimEnd('\\') + "' -Force -Recurse -ErrorAction SilentlyContinue;";
                    RunDetached("powershell", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"" + ps + "\"");
                    RaiseLog("Завершение удаления…");
                }
                RaiseDone();
            }
            catch (Exception ex) { RaiseFail(ex.Message); }
        }
        private void DeleteShortcut(string folder)
        {
            string p = Path.Combine(folder, AppName + ".lnk");
            try { if (File.Exists(p)) File.Delete(p); } catch { }
        }

        // ── helpers ──────────────────────────────────────────────────────────────
        private static void ForceTls12()
        {
            try
            {
                PropertyInfo sp = typeof(ServicePointManager).GetProperty("SecurityProtocol");
                if (sp != null) sp.SetValue(null, Enum.ToObject(sp.PropertyType, 3072), null);
            }
            catch { }
        }
        private static WebClient NewClient() { WebClient wc = new WebClient(); wc.Headers.Add("User-Agent", "Editor-Helper-Setup"); return wc; }

        private void KillRunning()
        {
            foreach (Process p in Process.GetProcessesByName("Editor Helper"))
            {
                try { p.Kill(); p.WaitForExit(3000); RaiseLog("Завершён процесс Editor Helper (pid " + p.Id + ")"); } catch { }
            }
        }
        private static void CopyOverwrite(string src, string dst)
        {
            if (File.Exists(dst)) { File.SetAttributes(dst, FileAttributes.Normal); try { File.Delete(dst); } catch { } }
            File.Copy(src, dst, true);
        }
        private static string NormalizeDir(string d) { return (d ?? "").TrimEnd('\\').TrimEnd('/').ToLowerInvariant(); }

        public static long FreeBytes(string path)
        {
            try
            {
                string root = Path.GetFullPath(path);
                while (!Directory.Exists(root) && Path.GetPathRoot(root) != root)
                    root = Path.GetDirectoryName(root);
                DriveInfo di = new DriveInfo(Path.GetPathRoot(root));
                if (!di.IsReady) return -1;
                return di.AvailableFreeSpace;
            }
            catch { return -1; }
        }

        private static string ReadRegistry(string key, string val)
        {
            try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey(key)) return k == null ? null : (string)k.GetValue(val); } catch { return null; }
        }
        public static string ReadRegistryStatic(string key, string val) { return ReadRegistry(key, val); }

        private static void DeleteDirRobust(string dir)
        {
            foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
            { try { File.SetAttributes(f, FileAttributes.Normal); } catch { } }
            Directory.Delete(dir, true);
        }

        private static void RunHidden(string exe, string args)
        {
            try { Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden }).WaitForExit(); } catch { }
        }
        private static void RunDetached(string exe, string args)
        {
            try { Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true }).Close(); } catch { }
        }

        public static string FmtBytes(long b)
        {
            if (b < 1024) return b + " B";
            if (b < 1048576) return (b / 1024.0).ToString("0.0") + " КБ";
            if (b < 1073741824) return (b / 1048576.0).ToString("0.0") + " МБ";
            return (b / 1073741824.0).ToString("0.00") + " ГБ";
        }

        // ── elevation ───────────────────────────────────────────────────────────
        public static bool IsElevated()
        {
            try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
            catch { return false; }
        }
        public static bool CanWriteToDir(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string t = Path.Combine(dir, ".ehwrite." + Guid.NewGuid().ToString("N"));
                File.WriteAllText(t, "");
                File.Delete(t);
                return true;
            }
            catch { return false; }
        }
        public static void RelaunchElevated(string cfgPath)
        {
            ProcessStartInfo psi = new ProcessStartInfo(Application.ExecutablePath, "--elevated --cfg \"" + cfgPath + "\"")
            { Verb = "runas", UseShellExecute = true };
            try { Process.Start(psi); } catch { }
        }

        // ── event raisers ───────────────────────────────────────────────────────
        private void RaisePhase(string t, string s) { if (Phase != null) Phase(t, s); }
        private void RaiseLog(string l) { if (Log != null) Log(l); }
        private void RaiseFile(string f) { if (FileCur != null) FileCur(f); }
        private void RaiseFileCount(int d, int t) { if (FileCount != null) FileCount(d, t); }
        private void RaiseFail(string m) { if (Fail != null) Fail(m); }
        private void RaiseDone() { if (Done != null) Done(); }
    }
}
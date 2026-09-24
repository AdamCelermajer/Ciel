using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;
using System.Net;
using System.Threading;
class Installer {
  static void MoveDirectory(string source, string destination) {
    Exception last = null;
    for (int attempt = 0; attempt < 40; attempt++) {
      try { Directory.Move(source, destination); return; }
      catch (IOException error) { last = error; }
      catch (UnauthorizedAccessException error) { last = error; }
      Thread.Sleep(500);
    }
    throw new IOException("Could not activate CIEL after extraction. Close any app using its installation directory and retry.", last);
  }
  [STAThread] static int Main(string[] args) {
    bool quiet = Array.IndexOf(args, "/quiet") >= 0;
    try {
      if (!quiet && MessageBox.Show("Install CIEL for your Windows account? The host starts silently after sign-in.", "CIEL setup", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return 0;
      try { var request = WebRequest.Create("http://127.0.0.1:4317/api/v1/health"); request.Timeout = 1000; using (var response = request.GetResponse()) { throw new InvalidOperationException("CIEL is running. Finish your tasks and stop CIEL before upgrading."); } } catch (WebException) { }
      string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CIEL", "app");
      string stage = root + ".staging-" + Guid.NewGuid().ToString("N"); Directory.CreateDirectory(stage);
      using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("ciel.payload.zip"))
      using (var zip = new ZipArchive(payload, ZipArchiveMode.Read)) { foreach (var entry in zip.Entries) { string destination = Path.GetFullPath(Path.Combine(stage, entry.FullName)); if (!destination.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Invalid package path"); if (entry.FullName.EndsWith("/")) Directory.CreateDirectory(destination); else { Directory.CreateDirectory(Path.GetDirectoryName(destination)); entry.ExtractToFile(destination); } } }
      string previous = null;
      if (Directory.Exists(root)) { previous = root + ".previous-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"); MoveDirectory(root, previous); }
      try { MoveDirectory(stage, root); }
      catch { if (previous != null && !Directory.Exists(root)) MoveDirectory(previous, root); throw; }
      string startup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "CIEL.vbs");
      File.WriteAllText(startup, "CreateObject(\"WScript.Shell\").Run \"wscript.exe \"\"" + Path.Combine(root, "setup", "start.vbs") + "\"\"\", 0, False\r\n");
      string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "CIEL.url");
      File.WriteAllText(menu, "[InternetShortcut]\r\nURL=http://127.0.0.1:4317\r\n");
      Process.Start(new ProcessStartInfo("wscript.exe", "\"" + Path.Combine(root, "setup", "start.vbs") + "\"") { UseShellExecute = false, CreateNoWindow = true });
      if (!quiet) { MessageBox.Show("CIEL is installed. Open CIEL from the Start menu. Your browser can close while tasks keep running.", "CIEL", MessageBoxButtons.OK, MessageBoxIcon.Information); Process.Start("http://127.0.0.1:4317"); }
      return 0;
    } catch (Exception error) { if (!quiet) MessageBox.Show(error.Message, "CIEL setup", MessageBoxButtons.OK, MessageBoxIcon.Error); else File.WriteAllText(Path.Combine(Path.GetTempPath(), "ciel-install-error.log"), error.ToString()); return 1; }
  }
}

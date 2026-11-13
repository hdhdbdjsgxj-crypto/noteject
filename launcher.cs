using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class NotejectLauncher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string server = Path.Combine(root, "ai-server.mjs");
        if (!File.Exists(server))
        {
            MessageBox.Show("The noteject app files are missing. Keep Noteject.exe beside ai-server.mjs, app.js, index.html, and style.css.", "noteject", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        string node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe");
        if (!File.Exists(node)) node = "node.exe";
        ProcessStartInfo start = new ProcessStartInfo("powershell.exe", "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + Path.Combine(root,"Start-Noteject.ps1") + "\"");
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process.Start(start);
    }
}

import { execFile } from "node:child_process";

/**
 * Force-kill a process AND its whole descendant tree.
 *
 * Why this exists: the MCP SDK's StdioClientTransport spawns the launch command (e.g.
 * `npx -y @pkg`), which on Windows expands to cmd.exe -> node(npx) -> node(the real server). Its
 * `close()` only `abort()`s the direct child; killing a parent on Windows does NOT cascade to
 * children, so the real server survives as an orphan (the root cause of the orphan leak).
 * `taskkill /T /F` is the only reliable way to tear down the entire subtree, any depth.
 */
export function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      // /T = kill the process tree (all descendants); /F = force (no graceful phase).
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      // Posix fallback: the SDK doesn't spawn a detached process group, so a plain SIGTERM to the
      // direct pid is the best we can do without a tree walk. This gateway runs on Windows; the
      // win32 path above is the one that matters in production.
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      resolve();
    }
  });
}

/**
 * The PIDs of `ownPid` and every descendant (any process type), via a PowerShell parent->child walk.
 * A reaper uses it to refuse to touch a stale-ledger PID the OS has since handed to one of THIS
 * instance's own freshly-spawned children — the safety net against PID reuse. Win32 only; elsewhere
 * returns just `ownPid` (the reaper is a no-op off Windows).
 */
export function descendantPidsOf(ownPid: number): Promise<Set<number>> {
  const out = new Set<number>([ownPid]);
  if (process.platform !== "win32") return Promise.resolve(out);
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$kids = @{}
foreach ($p in $all) { $pp = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.Generic.List[int] }; [void]$kids[$pp].Add([int]$p.ProcessId) }
$legit = New-Object System.Collections.Generic.HashSet[int]; [void]$legit.Add(${ownPid})
$q = New-Object System.Collections.Generic.Queue[int]; $q.Enqueue(${ownPid})
while ($q.Count -gt 0) { $c = $q.Dequeue(); $list = $kids[$c]; if ($list) { foreach ($k in $list) { if (-not $legit.Contains($k)) { [void]$legit.Add($k); $q.Enqueue($k) } } } }
$legit | ForEach-Object { $_ }
`.trim();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (!err && stdout) {
        for (const line of stdout.trim().split(/\r?\n/)) {
          const n = Number(line.trim());
          if (Number.isFinite(n) && n > 0) out.add(n);
        }
      }
      resolve(out); // a PowerShell failure degrades to "only ownPid" — safe (reaps nothing extra)
    });
  });
}

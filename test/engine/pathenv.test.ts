import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { extraBinDirs, loginPath } from "../../src/engine/pathenv.js";

// Fixtures must be native to the platform running the suite: POSIX PATHs are
// `:`-delimited and Windows ones `;`-delimited, and a Windows drive-letter
// colon corrupts the split on Linux ("C:\uv:C:\x" -> ["C", "\uv", "C", "\x"]).
// That is exactly how this file failed the first ubuntu publish run.
const win = process.platform === "win32";
const uvDir = win ? "C:\\uv" : "/opt/uv";
const binDir = win ? "C:\\Windows" : "/usr/bin";
const sysDir = win ? "C:\\Windows\\System32" : "/usr/sbin";

describe("loginPath", () => {
  it("prepends extra dirs that are not already on PATH", () => {
    const path = [binDir, sysDir].join(delimiter);
    expect(loginPath(path, [uvDir, binDir])).toBe(
      [uvDir, binDir, sysDir].join(delimiter),
    );
  });

  it("is a no-op when every extra dir is already present", () => {
    const path = [uvDir, binDir].join(delimiter);
    expect(loginPath(path, [uvDir])).toBe(path);
  });

  it("keeps PATH unchanged when there are no extras", () => {
    const lone = win ? "C:\\a" : "/a";
    expect(loginPath(lone, [])).toBe(lone);
  });
});

describe("extraBinDirs", () => {
  it("only lists directories that exist on this machine", () => {
    for (const d of extraBinDirs()) expect(existsSync(d)).toBe(true);
  });
});

import fs from "node:fs";
import path from "node:path";

function isPathLike(binaryName) {
  return binaryName.includes("/") || binaryName.includes("\\");
}

function candidateExtensions(env) {
  if (process.platform !== "win32") {
    return [""];
  }

  const raw = env?.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return raw
    .split(";")
    .map(entry => entry.trim())
    .filter(Boolean);
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBinaryOnPath(binaryName, options = {}) {
  if (!binaryName) {
    return null;
  }

  if (isPathLike(binaryName)) {
    return binaryName;
  }

  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const pathValue = env.PATH || process.env.PATH || "";
  const extensions =
    process.platform === "win32" && !path.extname(binaryName)
      ? candidateExtensions(env)
      : [""];

  for (const directory of pathValue.split(path.delimiter)) {
    const baseDir = directory || cwd;

    for (const extension of extensions) {
      const candidate = path.join(baseDir, `${binaryName}${extension}`);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

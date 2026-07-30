import os from "node:os";
import path from "node:path";
import process from "node:process";

export function isWslRuntime({
  platform = process.platform,
  env = process.env,
  release = os.release(),
} = {}) {
  return platform === "linux"
    && (
      Boolean(env.WSL_DISTRO_NAME)
      || Boolean(env.WSL_INTEROP)
      || /microsoft/i.test(release)
    );
}

export function nativeProjectPath(value, runtime = {}) {
  const raw = String(value);
  const slashPath = raw.replaceAll("\\", "/");
  const windows = raw.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (windows) {
    const portable = `${windows[1].toUpperCase()}:/${
      windows[2].replaceAll("\\", "/")
    }`;
    return isWslRuntime(runtime)
      ? `/mnt/${windows[1].toLowerCase()}/${
        windows[2].replaceAll("\\", "/")
      }`
      : portable;
  }
  const wsl = slashPath.match(
    /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)$/i,
  );
  if (wsl && isWslRuntime(runtime)) return wsl[1];
  const pathApi = runtime.pathApi ?? path;
  return pathApi.resolve(runtime.cwd ?? process.cwd(), raw);
}

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createGunzip } from "node:zlib";

import { atomicWriteFile } from "./lib/atomic-file.mjs";
import { readFileLimited } from "./lib/bounded-io.mjs";
import { syncDirectory, syncFile } from "./lib/durable-fs.mjs";
import {
  optionValue,
  optionValues,
  validateValueOptions,
} from "./lib/cli-options.mjs";
import {
  errorResult,
  LodestarError,
  wrapError,
} from "./lib/errors.mjs";
import { isMainModule } from "./lib/main-entry.mjs";
import { nativeProjectPath } from "./lib/native-path.mjs";

const VALUE_OPTIONS = Object.freeze([
  "--package",
  "--prefix",
  "--home",
  "--legacy-home",
  "--codex-home",
]);

const BOOLEAN_OPTIONS = new Set([
  "--allow-downgrade",
  "--dry-run",
  "--skip-codex",
]);

const PACKAGE_NAME = "lodestar-agent-context";
export const INSTALLER_VERSION = "0.6.1";
const MAX_COMPRESSED_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_PACKAGE_BYTES = 256 * 1024 * 1024;

export function installerHelpText() {
  return [
    `Lodestar installer ${INSTALLER_VERSION}`,
    "Safely install or upgrade the Lodestar package, state home, and Codex adapter.",
    "",
    "Usage:",
    "  lodestar-install [options]",
    "  node install.mjs [options]",
    "",
    "Options:",
    "  --package <path>      Checkout or Lodestar .tgz to install",
    "  --prefix <path>       npm global prefix",
    "  --home <path>         Lodestar state home",
    "  --legacy-home <path>  Legacy flat store to migrate",
    "  --codex-home <path>   Codex home; repeat for multiple homes",
    "  --skip-codex          Do not install the managed Codex block",
    "  --allow-downgrade     Permit an older or unrecognized version replacement",
    "  --dry-run             Inspect current state and print the install plan",
    "  -h, --help            Show this help",
    "  -v, --version         Show the installer version",
  ].join("\n");
}

export async function boundedGunzip(packageSource, {
  maxCompressedBytes = MAX_COMPRESSED_PACKAGE_BYTES,
  maxExpandedBytes = MAX_EXPANDED_PACKAGE_BYTES,
} = {}) {
  const info = await stat(packageSource);
  if (info.size > maxCompressedBytes) {
    throw new Error("package archive exceeds the 128 MiB safety limit");
  }
  const stream = createReadStream(packageSource).pipe(createGunzip());
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > maxExpandedBytes) {
        stream.destroy();
        throw new Error("expanded package archive exceeds the 256 MiB safety limit");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks, bytes);
}

function assertArguments(args) {
  validateValueOptions(args, VALUE_OPTIONS);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (VALUE_OPTIONS.includes(argument)) {
      index += 1;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(argument)) continue;
    throw new LodestarError(
      "installer-argument-invalid",
      `Unknown installer argument ${argument}`,
      { detail: { argument } },
    );
  }
}

function assertNodeVersion(version) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new LodestarError(
      "node-version-unsupported",
      `Lodestar requires Node.js 22 or newer; found ${version}`,
      {
        detail: {
          required: ">=22",
          actual: version,
        },
      },
    );
  }
}

export function resolveNpmInvocation({
  platform,
  env,
  pathApi,
  nodeExecutable,
  fileExists = existsSync,
}) {
  if (platform !== "win32") {
    return {
      command: "npm",
      argsPrefix: [],
      displayCommand: "npm",
    };
  }

  const candidates = [
    env.npm_execpath,
    pathApi.join(
      pathApi.dirname(nodeExecutable),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    ...String(env.PATH ?? "")
      .split(pathApi.delimiter)
      .filter(Boolean)
      .map((entry) => pathApi.join(
        entry,
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      )),
  ];
  const npmCli = candidates.find((candidate) =>
    typeof candidate === "string"
    && candidate.length > 0
    && fileExists(candidate));
  if (!npmCli) {
    throw new LodestarError(
      "installer-npm-unavailable",
      "Unable to locate npm's JavaScript entry point for this Node.js installation",
      {
        detail: {
          node: nodeExecutable,
          checked: [...new Set(candidates.filter(Boolean))],
          repair: "Install Node.js 22 or newer with npm included",
        },
      },
    );
  }
  return {
    command: nodeExecutable,
    argsPrefix: [npmCli],
    displayCommand: "npm",
  };
}

function runProcess(command, args, {
  cwd,
  spawn = spawnSync,
  env = process.env,
  displayCommand = command,
} = {}) {
  const result = spawn(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw wrapError(
      result.error,
      "installer-process-start-failed",
      `Unable to start ${displayCommand}`,
      { command: displayCommand },
    );
  }
  if (result.status !== 0) {
    throw new LodestarError(
      "installer-process-failed",
      `${displayCommand} exited with status ${result.status}`,
      {
        detail: {
          command: displayCommand,
          exit_code: result.status,
          stderr: String(result.stderr ?? "").trim().slice(-4_096),
        },
      },
    );
  }
  return String(result.stdout ?? "").trim();
}

async function snapshotInstalledPackage({
  npm,
  npmRoot,
  prefix,
  packageRoot,
  spawn,
  env,
  pathApi,
}) {
  const installedRoot = pathApi.join(npmRoot, PACKAGE_NAME);
  try {
    await access(installedRoot);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw wrapError(
      error,
      "installer-existing-package-unreadable",
      "Unable to inspect the existing Lodestar installation",
      { package_root: installedRoot },
    );
  }
  const directory = await mkdtemp(path.join(
    os.tmpdir(),
    "lodestar-install-backup-",
  ));
  try {
    const packed = runProcess(npm.command, [
      ...npm.argsPrefix,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
      installedRoot,
    ], {
      cwd: packageRoot,
      spawn,
      env,
      displayCommand: npm.displayCommand,
    });
    const result = JSON.parse(packed);
    const filename = result?.[0]?.filename;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error("npm pack did not report a backup filename");
    }
    const tarball = pathApi.join(directory, filename);
    await syncFile(tarball);
    await syncDirectory(directory);
    return {
      directory,
      tarball,
      prefix,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof LodestarError) throw error;
    throw wrapError(
      error,
      "installer-package-backup-failed",
      "Unable to back up the existing Lodestar package before replacement",
      { package_root: installedRoot },
    );
  }
}

function rollbackInstalledPackage({
  npm,
  backup,
  prefix,
  packageRoot,
  spawn,
  env,
}) {
  const args = backup
    ? [
      "install",
      "--global",
      "--ignore-scripts",
      ...(prefix ? ["--prefix", prefix] : []),
      backup.tarball,
    ]
    : [
      "uninstall",
      "--global",
      ...(prefix ? ["--prefix", prefix] : []),
      PACKAGE_NAME,
    ];
  runProcess(npm.command, [...npm.argsPrefix, ...args], {
    cwd: packageRoot,
    spawn,
    env,
    displayCommand: npm.displayCommand,
  });
}

function validatedPackageMetadata(value, packageSource) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.name !== PACKAGE_NAME
    || typeof value.version !== "string"
    || value.version.length === 0
  ) {
    throw new Error(`expected package ${PACKAGE_NAME} with a version`);
  }
  return { name: value.name, version: value.version };
}

function parsedVersion(version) {
  const match = String(version).match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  const prerelease = match[4] ?? null;
  if (prerelease?.split(".").some((part) =>
    part.length === 0 || (/^\d+$/.test(part) && part.length > 1 && part[0] === "0"))) {
    return null;
  }
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: prerelease?.split(".") ?? null,
  };
}

function comparePrerelease(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function packageTransition(installedVersion, targetVersion) {
  if (installedVersion === null) return "install";
  const installed = parsedVersion(installedVersion);
  const target = parsedVersion(targetVersion);
  if (!installed || !target) return "replace-unknown";
  for (let index = 0; index < installed.core.length; index += 1) {
    if (target.core[index] > installed.core[index]) return "upgrade";
    if (target.core[index] < installed.core[index]) return "downgrade";
  }
  const prereleaseOrder = comparePrerelease(target.prerelease, installed.prerelease);
  if (prereleaseOrder > 0) return "upgrade";
  if (prereleaseOrder < 0) return "downgrade";
  return "reinstall";
}

async function installedPackageMetadata(npmRoot, pathApi) {
  const packageFile = pathApi.join(npmRoot, PACKAGE_NAME, "package.json");
  let text;
  try {
    text = await readFileLimited(packageFile, {
      maximum: 1024 * 1024,
      encoding: "utf8",
      resource: "installed-package-metadata-bytes",
    });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw wrapError(
      error,
      "installer-existing-package-unreadable",
      "Unable to inspect the existing Lodestar installation",
      { package: packageFile },
    );
  }
  try {
    return validatedPackageMetadata(JSON.parse(text), packageFile);
  } catch (error) {
    throw wrapError(
      error,
      "installer-existing-package-invalid",
      "The existing Lodestar installation has invalid package metadata",
      { package: packageFile },
    );
  }
}

async function activeAgentctxCommand({ env, platform, pathApi }) {
  const names = platform === "win32"
    ? ["agentctx.exe", "agentctx.cmd", "agentctx.ps1", "agentctx"]
    : ["agentctx"];
  for (const directory of String(env.PATH ?? "")
    .split(pathApi.delimiter).filter(Boolean)) {
    for (const name of names) {
      const command = pathApi.join(directory, name);
      try {
        const info = await lstat(command);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw wrapError(
          error,
          "installer-active-command-unreadable",
          "Unable to inspect the active agentctx command",
          { command },
        );
      }
      let resolved = command;
      try {
        resolved = await realpath(command);
      } catch {
        // Windows command shims are ordinary files and need no resolution.
      }
      let version = null;
      if (pathApi.basename(resolved).toLowerCase() === "agentctx.mjs") {
        try {
          version = (await packageMetadata(pathApi.dirname(resolved))).version;
        } catch {
          // A nonstandard launcher remains useful as path-drift evidence.
        }
      }
      return { command, resolved, version };
    }
  }
  return null;
}

function sameDirectory(left, right, { platform, pathApi }) {
  const normalize = (value) => {
    const resolved = pathApi.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function tarballPackageJson(packageSource) {
  const archive = await boundedGunzip(packageSource);
  let offset = 0;
  let packageJson = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8")
      .replace(/\0.*$/, "");
    const rawSize = header.subarray(124, 136).toString("ascii")
      .replace(/\0.*$/, "").trim();
    const size = Number.parseInt(rawSize || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`invalid tar entry size for ${name || "<unnamed>"}`);
    }
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) {
      throw new Error(`truncated tar entry ${name || "<unnamed>"}`);
    }
    if (name === "package/package.json" || name === "./package/package.json") {
      if (packageJson !== null) {
        throw new Error("archive contains duplicate package/package.json entries");
      }
      if (size > 1_048_576) {
        throw new Error("package.json exceeds the 1 MiB safety limit");
      }
      packageJson = JSON.parse(
        archive.subarray(bodyStart, bodyEnd).toString("utf8"),
      );
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (packageJson !== null) return packageJson;
  throw new Error("archive does not contain package/package.json");
}

export async function packageMetadata(packageSource) {
  const packageFile = packageSource.toLowerCase().endsWith(".tgz")
    ? null
    : path.join(packageSource, "package.json");
  try {
    const value = packageFile
      ? JSON.parse(await readFileLimited(packageFile, {
        maximum: 1024 * 1024,
        encoding: "utf8",
        resource: "package-metadata-bytes",
      }))
      : await tarballPackageJson(packageSource);
    return validatedPackageMetadata(value, packageSource);
  } catch (error) {
    throw wrapError(
      error,
      "installer-package-invalid",
      `Unable to validate package metadata from ${packageSource}`,
      { package: packageSource },
    );
  }
}

function parseProcessJson(output, phase) {
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== "object" || value.ok === false) {
      throw new Error("command returned an unsuccessful JSON result");
    }
    return value;
  } catch (error) {
    throw wrapError(
      error,
      "installer-output-invalid",
      `Unable to parse Lodestar output during ${phase}`,
      { phase },
    );
  }
}

function pathConfigured(binDirectory, {
  env,
  platform,
  pathApi,
} = {}) {
  const separator = pathApi.delimiter;
  const normalize = (value) => {
    const resolved = pathApi.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const wanted = normalize(binDirectory);
  return String(env.PATH ?? "")
    .split(separator)
    .filter(Boolean)
    .some((entry) => normalize(entry) === wanted);
}

function cmdQuoted(value) {
  return `"${String(value).replaceAll("%", "%%")}"`;
}

export async function installWindowsCompatibilityShims({
  npmPrefix,
  packageRoot,
  bins,
  nodeExecutable = process.execPath,
  pathApi = path.win32,
  fsApi,
} = {}) {
  if (!npmPrefix || !packageRoot || !bins || typeof bins !== "object") {
    throw new LodestarError(
      "installer-shim-input-invalid",
      "Windows compatibility shims require a prefix, package root, and bin map",
    );
  }
  const compatibilityBin = pathApi.join(npmPrefix, "bin");
  const changed = [];
  const fsReadFile = fsApi?.readFile ?? readFile;
  const fsLstat = fsApi?.lstat ?? lstat;
  const fsUnlink = fsApi?.unlink ?? unlink;
  const fsRmdir = fsApi?.rmdir ?? rmdir;
  const restore = async () => {
    const errors = [];
    for (const item of [...changed].reverse()) {
      try {
        if (item.existed) {
          await atomicWriteFile(item.shim, item.content, {
            ...(fsApi ? { fsApi } : {}),
            encoding: null,
          });
        } else {
          await fsUnlink(item.shim).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new LodestarError(
        "installer-compatibility-rollback-failed",
        "Unable to restore every Windows compatibility shim",
        { cause: new AggregateError(errors) },
      );
    }
  };
  try {
    await (fsApi?.mkdir ?? mkdir)(compatibilityBin, { recursive: true });
    const installedRoot = pathApi.resolve(packageRoot);
    const written = [];
    for (const [command, relativeTarget] of Object.entries(bins).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (
        !/^[a-zA-Z0-9._-]+$/.test(command)
        || typeof relativeTarget !== "string"
        || relativeTarget.length === 0
      ) {
        throw new LodestarError(
          "installer-package-bin-invalid",
          "Installed package contains an unsafe command mapping",
          { detail: { command, target: relativeTarget ?? null } },
        );
      }
      const target = pathApi.resolve(packageRoot, relativeTarget);
      const relative = pathApi.relative(installedRoot, target);
      if (
        relative === ".."
        || relative.startsWith(`..${pathApi.sep}`)
        || pathApi.isAbsolute(relative)
      ) {
        throw new LodestarError(
          "installer-package-bin-invalid",
          "Installed package command escapes its package root",
          { detail: { command, target: relativeTarget } },
        );
      }
      await (fsApi?.access ?? access)(target);
      const shim = pathApi.join(compatibilityBin, `${command}.cmd`);
      let existed = true;
      let content = null;
      try {
        const info = await fsLstat(shim);
        if (info.isSymbolicLink()) {
          throw new LodestarError(
            "installer-compatibility-shim-symlink",
            "Refusing to replace a symbolic-link compatibility shim",
            { detail: { shim } },
          );
        }
        content = await fsReadFile(shim);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        existed = false;
      }
      const prior = { shim, existed, content };
      await atomicWriteFile(
        shim,
        `@ECHO off\r\n${cmdQuoted(nodeExecutable)} ${cmdQuoted(target)} %*\r\n`,
        { ...(fsApi ? { fsApi } : {}) },
      );
      changed.push(prior);
      written.push(shim);
    }
    return {
      bin: compatibilityBin,
      shims: written,
      rollback: restore,
    };
  } catch (error) {
    let rollbackError = null;
    try {
      await restore();
      if (changed.every(({ existed }) => !existed)) {
        await fsRmdir(compatibilityBin).catch((failure) => {
          if (!["ENOENT", "ENOTEMPTY"].includes(failure.code)) throw failure;
        });
      }
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      throw new LodestarError(
        "installer-compatibility-shim-rollback-failed",
        "Windows compatibility shim installation failed and prior shims could not be restored",
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    if (error instanceof LodestarError) throw error;
    throw wrapError(
      error,
      "installer-compatibility-shim-failed",
      "Unable to install Windows compatibility command shims",
      { bin: compatibilityBin },
    );
  }
}

export async function installLodestar(
  args,
  {
    env = process.env,
    platform = process.platform,
    nodeVersion = process.versions.node,
    packageRoot = import.meta.dirname,
    spawn = spawnSync,
    pathApi = platform === "win32" ? path.win32 : path,
    nodeExecutable = process.execPath,
    fileExists = existsSync,
    stdout = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  if (
    args.length === 1
    && ["--help", "-h"].includes(args[0])
  ) {
    const result = { ok: true, help: true };
    stdout(installerHelpText());
    return result;
  }
  if (
    args.length === 1
    && ["--version", "-v"].includes(args[0])
  ) {
    const result = { ok: true, version: INSTALLER_VERSION };
    stdout(INSTALLER_VERSION);
    return result;
  }
  assertArguments(args);
  assertNodeVersion(nodeVersion);
  const runtime = {
    env,
    platform,
    pathApi,
    cwd: process.cwd(),
    release: os.release(),
  };
  const nativePath = (value) =>
    value === undefined
      ? undefined
      : nativeProjectPath(value, runtime);
  const packageSource = nativePath(
    optionValue(args, "--package", packageRoot),
  );
  const prefix = nativePath(optionValue(args, "--prefix"));
  const stateHome = nativePath(optionValue(args, "--home"));
  const legacyHome = nativePath(optionValue(args, "--legacy-home"));
  const codexHomes = optionValues(args, "--codex-home").map(nativePath);
  const skipCodex = args.includes("--skip-codex");
  const dryRun = args.includes("--dry-run");
  let metadata = await packageMetadata(packageSource);

  try {
    await access(packageSource);
  } catch (error) {
    throw wrapError(
      error,
      "installer-package-unreadable",
      `Package source is not readable: ${packageSource}`,
      { package: packageSource },
    );
  }

  const npm = resolveNpmInvocation({
    platform,
    env,
    pathApi,
    nodeExecutable,
    fileExists,
  });
  const installArguments = [
    "install",
    "--global",
    "--ignore-scripts",
    ...(prefix ? ["--prefix", prefix] : []),
    packageSource,
  ];
  const npmRoot = runProcess(npm.command, [
    ...npm.argsPrefix,
    "root",
    "--global",
    ...(prefix ? ["--prefix", prefix] : []),
  ], {
    cwd: packageRoot,
    spawn,
    env,
    displayCommand: npm.displayCommand,
  });
  const installedMetadata = await installedPackageMetadata(npmRoot, pathApi);
  const transition = packageTransition(
    installedMetadata?.version ?? null,
    metadata.version,
  );
  if (
    (transition === "downgrade" || transition === "replace-unknown")
    && !args.includes("--allow-downgrade")
  ) {
    const unknown = transition === "replace-unknown";
    throw new LodestarError(
      unknown
        ? "installer-version-replacement-refused"
        : "installer-downgrade-refused",
      unknown
        ? `Refusing to replace unrecognized Lodestar version ${installedMetadata.version} with ${metadata.version}`
        : `Refusing to replace Lodestar ${installedMetadata.version} with older version ${metadata.version}`,
      {
        detail: {
          installed_version: installedMetadata.version,
          target_version: metadata.version,
          repair:
            "Use --allow-downgrade only after confirming the replacement is required.",
        },
      },
    );
  }
  const npmPrefix = prefix ?? runProcess(npm.command, [
    ...npm.argsPrefix,
    "prefix",
    "--global",
  ], {
    cwd: packageRoot,
    spawn,
    env,
    displayCommand: npm.displayCommand,
  });
  const standardBin = platform === "win32"
    ? npmPrefix
    : pathApi.join(npmPrefix, "bin");
  const activeCommand = await activeAgentctxCommand({
    env,
    platform,
    pathApi,
  });
  const activeCommandMatchesTarget = activeCommand === null
    ? null
    : sameDirectory(pathApi.dirname(activeCommand.command), standardBin, {
      platform,
      pathApi,
    });
  const plan = {
    v: 1,
    package: packageSource,
    package_name: metadata.name,
    package_version: metadata.version,
    installed_version: installedMetadata?.version ?? null,
    transition,
    target_bin: standardBin,
    active_command: activeCommand,
    active_command_matches_target: activeCommandMatchesTarget,
    prefix: prefix ?? null,
    state_home: stateHome ?? null,
    legacy_home: legacyHome ?? null,
    codex_homes: codexHomes,
    install_codex: !skipCodex,
    npm: {
      command: npm.displayCommand,
      args: installArguments,
    },
  };
  if (dryRun) {
    const result = { ok: true, dry_run: true, plan };
    stdout(JSON.stringify(result));
    return result;
  }

  const backup = await snapshotInstalledPackage({
    npm,
    npmRoot,
    prefix,
    packageRoot,
    spawn,
    env,
    pathApi,
  });
  let packageReplaced = false;
  let compatibility = null;
  let stateResult = null;
  let codex = null;
  let installedMain = null;
  let preserveBackup = false;
  try {
    runProcess(npm.command, [...npm.argsPrefix, ...installArguments], {
      cwd: packageRoot,
      spawn,
      env,
      displayCommand: npm.displayCommand,
    });
    packageReplaced = true;
    installedMain = pathApi.join(
      npmRoot,
      metadata.name,
      "agentctx.mjs",
    );
    try {
      await access(installedMain);
    } catch (error) {
      throw wrapError(
        error,
        "installer-entrypoint-missing",
        `Installed agentctx entry point is missing: ${installedMain}`,
        { entrypoint: installedMain },
      );
    }
    let installedBins;
    try {
      const installedPackage = JSON.parse(await readFileLimited(
        pathApi.join(npmRoot, metadata.name, "package.json"),
        {
          maximum: 1024 * 1024,
          encoding: "utf8",
          resource: "installed-package-metadata-bytes",
        },
      ));
      if (
        installedPackage.name !== PACKAGE_NAME
        || typeof installedPackage.version !== "string"
        || !installedPackage.bin
        || typeof installedPackage.bin !== "object"
        || Array.isArray(installedPackage.bin)
      ) {
        throw new Error("installed package identity is invalid");
      }
      if (installedPackage.version !== metadata.version) {
        throw new Error(
          `installed package version ${installedPackage.version} does not match preflight ${metadata.version}`,
        );
      }
      metadata = {
        name: installedPackage.name,
        version: installedPackage.version,
      };
      installedBins = installedPackage.bin;
    } catch (error) {
      throw wrapError(
        error,
        "installer-installed-package-invalid",
        "Unable to validate the installed Lodestar package",
        { package_root: npmRoot },
      );
    }

    compatibility = platform === "win32"
      ? await installWindowsCompatibilityShims({
        npmPrefix,
        packageRoot: pathApi.join(npmRoot, metadata.name),
        bins: installedBins,
        nodeExecutable,
        pathApi,
      })
      : null;
    const commonArguments = [
      ...(stateHome ? ["--home", stateHome] : []),
    ];
    stateResult = parseProcessJson(runProcess(nodeExecutable, [
      installedMain,
      legacyHome ? "migrate-legacy" : "init",
      ...commonArguments,
      ...(legacyHome ? ["--from", legacyHome] : []),
    ], {
      cwd: packageRoot,
      spawn,
      env,
    }), legacyHome ? "legacy state migration" : "state initialization");
    if (!skipCodex) {
      codex = parseProcessJson(runProcess(nodeExecutable, [
        installedMain,
        "install-codex",
        ...commonArguments,
        ...codexHomes.flatMap((home) => ["--codex-home", home]),
      ], {
        cwd: packageRoot,
        spawn,
        env,
      }), "Codex adapter installation");
    }

    const standardConfigured = pathConfigured(standardBin, {
      env,
      platform,
      pathApi,
    });
    const compatibilityConfigured = compatibility
      ? pathConfigured(compatibility.bin, {
        env,
        platform,
        pathApi,
      })
      : false;
    const binDirectory = standardConfigured || !compatibilityConfigured
      ? standardBin
      : compatibility.bin;
    const postInstallActiveCommand = await activeAgentctxCommand({
      env,
      platform,
      pathApi,
    });
    const commandMatchesInstall = postInstallActiveCommand === null
      ? null
      : sameDirectory(
        pathApi.dirname(postInstallActiveCommand.command),
        binDirectory,
        { platform, pathApi },
      );
    const result = {
      ok: true,
      package: {
        name: metadata.name,
        version: metadata.version,
        source: packageSource,
      },
      previous_package: installedMetadata,
      transition,
      active_command: postInstallActiveCommand,
      command_matches_install: commandMatchesInstall,
      prefix: npmPrefix,
      bin: binDirectory,
      compatibility_bin: compatibility?.bin ?? null,
      path_configured: standardConfigured || compatibilityConfigured,
      initialized: legacyHome ? null : stateResult,
      migration: legacyHome ? stateResult : null,
      codex,
    };
    stdout(JSON.stringify(result));
    return result;
  } catch (error) {
    const rollbackErrors = [];
    if (codex?.manifest && installedMain) {
      try {
        runProcess(nodeExecutable, [
          installedMain,
          "rollback",
          "--manifest",
          codex.manifest,
          ...(stateResult?.home ? ["--home", stateResult.home] : []),
          ...(codex.installed ?? []).flatMap(({ home }) =>
            ["--codex-home", home]),
        ], {
          cwd: packageRoot,
          spawn,
          env,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (
      stateResult?.home
      && (
        stateResult.created === true
        || (legacyHome && stateResult.migrated === true)
      )
    ) {
      try {
        await rm(stateResult.home, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (compatibility?.rollback) {
      try {
        await compatibility.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (packageReplaced) {
      try {
        rollbackInstalledPackage({
          npm,
          backup,
          prefix,
          packageRoot,
          spawn,
          env,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        preserveBackup = true;
      }
    }
    if (rollbackErrors.length > 0) {
      throw new LodestarError(
        "installer-transaction-rollback-failed",
        "Lodestar setup failed and its prior state could not be fully restored",
        {
          cause: new AggregateError([error, ...rollbackErrors]),
          detail: {
            install_code: error.code ?? null,
            rollback_codes: rollbackErrors.map(
              (failure) => failure.code ?? null,
            ),
            backup: preserveBackup ? backup?.tarball ?? null : null,
          },
        },
      );
    }
    throw error;
  } finally {
    if (backup && !preserveBackup) {
      await rm(backup.directory, { recursive: true, force: true });
    }
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await installLodestar(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: errorResult(error),
    })}\n`);
    process.exitCode = 1;
  }
}

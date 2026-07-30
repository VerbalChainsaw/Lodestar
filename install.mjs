#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { atomicWriteFile } from "./lib/atomic-file.mjs";
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
  "--dry-run",
  "--skip-codex",
]);

const PACKAGE_NAME = "lodestar-agent-context";

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

async function packageMetadata(packageSource) {
  const packageFile = packageSource.toLowerCase().endsWith(".tgz")
    ? null
    : path.join(packageSource, "package.json");
  if (!packageFile) {
    return { name: PACKAGE_NAME, version: null };
  }
  try {
    const value = JSON.parse(await readFile(packageFile, "utf8"));
    if (
      value.name !== PACKAGE_NAME
      || typeof value.version !== "string"
    ) {
      throw new Error(`expected package ${PACKAGE_NAME} with a version`);
    }
    return { name: value.name, version: value.version };
  } catch (error) {
    throw wrapError(
      error,
      "installer-package-invalid",
      `Unable to read package metadata from ${packageFile}`,
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
      await atomicWriteFile(
        shim,
        `@ECHO off\r\nnode ${cmdQuoted(target)} %*\r\n`,
        { ...(fsApi ? { fsApi } : {}) },
      );
      written.push(shim);
    }
    return { bin: compatibilityBin, shims: written };
  } catch (error) {
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
    ...(prefix ? ["--prefix", prefix] : []),
    packageSource,
  ];
  const plan = {
    v: 1,
    package: packageSource,
    package_name: metadata.name,
    package_version: metadata.version,
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

  runProcess(npm.command, [...npm.argsPrefix, ...installArguments], {
    cwd: packageRoot,
    spawn,
    env,
    displayCommand: npm.displayCommand,
  });
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
  const installedMain = pathApi.join(
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
    const installedPackage = JSON.parse(await readFile(
      pathApi.join(npmRoot, metadata.name, "package.json"),
      "utf8",
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

  const compatibility = platform === "win32"
    ? await installWindowsCompatibilityShims({
      npmPrefix,
      packageRoot: pathApi.join(npmRoot, metadata.name),
      bins: installedBins,
      pathApi,
    })
    : null;
  const commonArguments = [
    ...(stateHome ? ["--home", stateHome] : []),
  ];
  const stateResult = parseProcessJson(runProcess(process.execPath, [
    installedMain,
    legacyHome ? "migrate-legacy" : "init",
    ...commonArguments,
    ...(legacyHome ? ["--from", legacyHome] : []),
  ], {
    cwd: packageRoot,
    spawn,
    env,
  }), legacyHome ? "legacy state migration" : "state initialization");
  let codex = null;
  if (!skipCodex) {
    codex = parseProcessJson(runProcess(process.execPath, [
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

  const standardBin = platform === "win32"
    ? npmPrefix
    : pathApi.join(npmPrefix, "bin");
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
  const result = {
    ok: true,
    package: {
      name: metadata.name,
      version: metadata.version,
      source: packageSource,
    },
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

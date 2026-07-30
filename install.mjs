#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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

function executableName(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function runProcess(command, args, {
  cwd,
  spawn = spawnSync,
  env = process.env,
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
      `Unable to start ${command}`,
      { command },
    );
  }
  if (result.status !== 0) {
    throw new LodestarError(
      "installer-process-failed",
      `${command} exited with status ${result.status}`,
      {
        detail: {
          command,
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

export async function installLodestar(
  args,
  {
    env = process.env,
    platform = process.platform,
    nodeVersion = process.versions.node,
    packageRoot = import.meta.dirname,
    spawn = spawnSync,
    pathApi = platform === "win32" ? path.win32 : path,
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

  const npm = executableName(platform);
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
    codex_homes: codexHomes,
    install_codex: !skipCodex,
    npm: {
      command: npm,
      args: installArguments,
    },
  };
  if (dryRun) {
    const result = { ok: true, dry_run: true, plan };
    stdout(JSON.stringify(result));
    return result;
  }

  runProcess(npm, installArguments, {
    cwd: packageRoot,
    spawn,
    env,
  });
  const npmRoot = runProcess(npm, [
    "root",
    "--global",
    ...(prefix ? ["--prefix", prefix] : []),
  ], {
    cwd: packageRoot,
    spawn,
    env,
  });
  const npmPrefix = prefix ?? runProcess(npm, [
    "prefix",
    "--global",
  ], {
    cwd: packageRoot,
    spawn,
    env,
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
  try {
    const installedPackage = JSON.parse(await readFile(
      pathApi.join(npmRoot, metadata.name, "package.json"),
      "utf8",
    ));
    if (
      installedPackage.name !== PACKAGE_NAME
      || typeof installedPackage.version !== "string"
    ) {
      throw new Error("installed package identity is invalid");
    }
    metadata = {
      name: installedPackage.name,
      version: installedPackage.version,
    };
  } catch (error) {
    throw wrapError(
      error,
      "installer-installed-package-invalid",
      "Unable to validate the installed Lodestar package",
      { package_root: npmRoot },
    );
  }

  const commonArguments = [
    ...(stateHome ? ["--home", stateHome] : []),
  ];
  const initialized = parseProcessJson(runProcess(process.execPath, [
    installedMain,
    "init",
    ...commonArguments,
  ], {
    cwd: packageRoot,
    spawn,
    env,
  }), "state initialization");
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

  const binDirectory = platform === "win32"
    ? npmPrefix
    : pathApi.join(npmPrefix, "bin");
  const result = {
    ok: true,
    package: {
      name: metadata.name,
      version: metadata.version,
      source: packageSource,
    },
    prefix: npmPrefix,
    bin: binDirectory,
    path_configured: pathConfigured(binDirectory, {
      env,
      platform,
      pathApi,
    }),
    initialized,
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

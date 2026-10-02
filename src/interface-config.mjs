import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabasePath } from "./paths.mjs";
import { decodeUtf8, parseJsonText } from "./json.mjs";
import { lodestarError } from "./errors.mjs";

const invalid = (message, identifiers = {}, action = "Correct the selected interface config or portable bundle using the reported location, then reload.") =>
  lodestarError("interface_config_invalid", message, { identifiers, action });
const validPath = (value) => typeof value === "string" && value.length > 0 &&
  !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
const absolute = (root, value, field) => {
  if (!validPath(value)) throw invalid(`${field} must be a nonempty Unicode path without NUL.`);
  return path.resolve(root, value);
};
async function requiredFile(file, field) {
  let info;
  try { info = await stat(file); } catch { throw invalid(`${field} is missing: ${file}`); }
  if (!info.isFile()) throw invalid(`${field} must be a file: ${file}`);
}
async function admitPortableDatabase(configPath, root, database) {
  const action = "Select an existing database outside the app, staging and previous-generation directories, using plain directories without reparse or symlink ancestors, then reload. The current config and store bytes were preserved.";
  const reject = (reason) => invalid(`${configPath} at /runtime/database: ${reason} Database: ${database}. Next action: ${action}`,
    { path: configPath, pointer: "/runtime/database", database, app_root: root }, action);
  const comparable = (file) => process.platform === "win32" ? file.toLowerCase() : file;
  const selected = comparable(database);
  for (const protectedRoot of [root, `${root}.lodestar-stage`, `${root}.lodestar-previous`]) {
    const boundary = comparable(protectedRoot);
    if (selected === boundary || selected.startsWith(`${boundary}${path.sep}`)) {
      throw reject(`The portable database is inside a protected directory: ${protectedRoot}.`);
    }
  }
  // Reject aliases rather than allowing a lexical external path to resolve into an owned directory.
  for (const start of [root, database]) {
    for (let file = start; ; file = path.dirname(file)) {
      let info;
      try { info = await lstat(file); } catch { throw reject(`Cannot verify the selected path ancestor: ${file}.`); }
      if (info.isSymbolicLink()) throw reject(`The selected path contains a reparse or symlink ancestor: ${file}.`);
      if (path.dirname(file) === file) break;
    }
  }
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function bindingDocument(bytes, file, { manifest = false } = {}) {
  const validateNumbers = (pointer, value) => {
    if (pointer === "/v") return true;
    if (!manifest || !Array.isArray(value?.files)) return false;
    const parts = pointer.split("/");
    if (parts.length !== 4 || parts[1] !== "files" || parts[3] !== "bytes") return false;
    const entry = value.files[parts[2]];
    return typeof entry?.path === "string" && entry.path.startsWith("core/");
  };
  try {
    return parseJsonText(decodeUtf8(bytes, { resource: "interface binding", identifiers: { path: file } }),
      { resource: "interface binding", identifiers: { path: file }, validateNumbers });
  } catch (error) {
    const field = error.identifiers?.pointer ?? "/";
    const reason = error.code === "invalid_utf8" ? "Invalid UTF-8" : error.message;
    const action = error.code === "unsupported_numeric_value"
      ? "Correct the named field to an exact supported numeric value: version must be 1 and core byte counts must be nonnegative safe integers. Keep the required field numeric, then reload. The original bytes were preserved."
      : "Correct the named field in this binding document using valid JSON, valid UTF-8 and unique member names, then reload. The original bytes were preserved.";
    throw invalid(`${file} at ${field}: ${reason} Next action: ${action}`, { path: file, pointer: field }, action);
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
async function fileDigest(file) { return digest(await readFile(file)); }
export async function sourceIdentity(configRoot, cli) {
  const manifestPath = path.join(configRoot, "bundle-manifest.json");
  let manifest;
  try { manifest = bindingDocument(await readFile(manifestPath), manifestPath, { manifest: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const selected = new Map();
  if (manifest) {
    if (manifest.v !== 1 || !Array.isArray(manifest.files)) throw invalid("Unsupported portable bundle manifest.");
    const coreRoot = path.join(configRoot, "core");
    for (const entry of manifest.files) {
      if (typeof entry.path !== "string" || !entry.path.startsWith("core/")) continue;
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !/^[0-9a-f]{64}$/iu.test(entry.sha256 ?? "") ||
        entry.path.includes("\\") || entry.path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw invalid("Invalid core manifest entry.");
      }
      const file = path.resolve(configRoot, entry.path);
      if (!file.startsWith(`${coreRoot}${path.sep}`) || selected.has(entry.path)) {
        throw invalid("Core manifest entry escapes the bundle or is duplicated.");
      }
      selected.set(entry.path, { file, bytes: entry.bytes, hash: entry.sha256.toLowerCase() });
    }
    if (!selected.size || ![...selected.values()].some(({ file }) => file.toLowerCase() === cli.toLowerCase())) {
      throw invalid("Portable manifest does not include the selected CLI.");
    }
  } else {
    if (cli.toLowerCase() === path.join(configRoot, "core", "lodestar.mjs").toLowerCase()) {
      throw invalid("Portable core manifest is missing.");
    }
    const sourceRoot = path.dirname(cli);
    for (const name of ["lodestar.mjs", "package.json", ".mcp.json"]) {
      const file = path.join(sourceRoot, name);
      try { if ((await lstat(file)).isFile()) selected.set(name, { file }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    async function visit(directory) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw invalid("Runtime source contains a symlink.");
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) selected.set(path.relative(sourceRoot, file).replaceAll("\\", "/"), { file });
      }
    }
    for (const name of ["src", "managed-assets", "codex-plugin", "docs"]) await visit(path.join(sourceRoot, name));
    if (!selected.size) selected.set(path.basename(cli), { file: cli });
  }
  let content = "";
  for (const [name, entry] of [...selected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const details = await lstat(entry.file);
    if (!details.isFile() || details.isSymbolicLink()) throw invalid(`Runtime source is not a plain file: ${name}`);
    const hash = await fileDigest(entry.file);
    if (entry.hash && (details.size !== entry.bytes || hash !== entry.hash)) {
      throw invalid(`Portable core drifted from its manifest: ${name}`);
    }
    content += `${name}\0${details.size}\0${hash}\n`;
  }
  return { coreSourceDigest: digest(content), coreSourceBasis: manifest ? "verified_manifest_core" : "source_inventory",
    coreSourceNotice: manifest ? "Manifest-listed core bytes verified; full bundle and provenance not checked."
      : "Source bytes observed; packaged payload unverified." };
}
export async function sourceDigest(configRoot, cli) { return (await sourceIdentity(configRoot, cli)).coreSourceDigest; }
async function codeFingerprint(node, cli, configRoot, identity = null) {
  const runtime = await stat(node);
  const source = (identity ?? await sourceIdentity(configRoot, cli)).coreSourceDigest;
  return digest(JSON.stringify([node, runtime.size, runtime.mtimeMs, cli, source]));
}

export async function loadInterfaceConfig(file, { database = undefined, requireLoader = true } = {}) {
  const configPath = absolute(process.cwd(), file, "interface config");
  let bytes;
  try { bytes = await readFile(configPath); } catch { throw invalid(`Cannot read interface config: ${configPath}`); }
  const value = bindingDocument(bytes, configPath);
  if (value?.v !== 1 || typeof value.generation !== "string" || !uuid.test(value.generation) ||
    !value.runtime || typeof value.runtime !== "object") throw invalid("Unsupported interface config version or shape.");
  const root = path.dirname(configPath);
  const node = absolute(root, value.runtime.node, "runtime.node");
  const cli = absolute(root, value.runtime.cli, "runtime.cli");
  const selectedDatabase = absolute(root, value.runtime.database, "runtime.database");
  if (database !== undefined && path.resolve(database).toLowerCase() !== selectedDatabase.toLowerCase()) {
    throw invalid("--db conflicts with the selected interface config database.");
  }
  const loader = value.loader == null ? null : absolute(root, value.loader, "loader");
  await Promise.all([requiredFile(node, "Node runtime"), requiredFile(cli, "Lodestar CLI"),
    requiredFile(selectedDatabase, "Lodestar database"),
    ...(requireLoader && loader ? [requiredFile(loader, "Lodestar Loader")] : [])]);
  if (requireLoader && !loader) throw invalid("Interface config has no Loader executable.");
  const identity = await sourceIdentity(root, cli);
  if (identity.coreSourceBasis === "verified_manifest_core") await admitPortableDatabase(configPath, root, selectedDatabase);
  return { configPath, generation: value.generation, node, cli, database: selectedDatabase,
    loader, fingerprint: digest(bytes), ...identity, runtimeFingerprint: await codeFingerprint(node, cli, root, identity), ui: value.ui ?? {} };
}

export async function directInterfaceSelection(database = undefined) {
  const node = process.execPath;
  const cli = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));
  await requiredFile(node, "Node runtime");
  await requiredFile(cli, "Lodestar CLI");
  const identity = await sourceIdentity(path.dirname(cli), cli);
  return { configPath: null, generation: null, node, cli,
    database: resolveDatabasePath({ explicit: database }), loader: null,
    fingerprint: digest(JSON.stringify([node, cli, database ?? null])),
    ...identity, runtimeFingerprint: await codeFingerprint(node, cli, path.dirname(cli), identity) };
}

export async function revalidateSelection(selection) {
  if (selection.configPath) {
    const current = await loadInterfaceConfig(selection.configPath, { requireLoader: false });
    if (current.fingerprint !== selection.fingerprint || current.generation !== selection.generation ||
      current.node !== selection.node || current.cli !== selection.cli || current.database !== selection.database ||
      current.runtimeFingerprint !== selection.runtimeFingerprint) {
      throw lodestarError("interface_config_changed", "Interface runtime or config changed during this draft.", {
        identifiers: { path: selection.configPath },
        action: "Reload the selected interface runtime and review the draft against its current binding before retrying.",
      });
    }
  }
  await Promise.all([requiredFile(selection.node, "Node runtime"), requiredFile(selection.cli, "Lodestar CLI")]);
  if (!selection.configPath && await codeFingerprint(selection.node, selection.cli,
    path.dirname(selection.cli)) !== selection.runtimeFingerprint) {
    throw lodestarError("interface_config_changed", "Lodestar runtime changed during this draft.", {
      identifiers: { path: selection.cli },
      action: "Reload the selected Lodestar runtime and review the draft against its current binding before retrying.",
    });
  }
  return selection;
}

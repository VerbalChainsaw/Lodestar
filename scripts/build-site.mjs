import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.resolve(process.argv[2] ?? path.join(root, "_site"));
const { version } = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+$/u.test(version))
  throw new Error("The landing page requires a released package version.");
const html = (
  await readFile(path.join(root, "site/index.html"), "utf8")
).replaceAll("{{VERSION}}", version);
if (/\{\{[^}]+\}\}/u.test(html))
  throw new Error("Unresolved landing-page placeholder.");
await mkdir(path.join(destination, "assets"), { recursive: true });
await writeFile(path.join(destination, "index.html"), html, "utf8");
await writeFile(path.join(destination, ".nojekyll"), "");
await copyFile(
  path.join(root, "site/style.css"),
  path.join(destination, "style.css"),
);
await copyFile(
  path.join(root, "docs/assets/lodestar-ridgeline.png"),
  path.join(destination, "assets/lodestar-ridgeline.png"),
);
console.log(JSON.stringify({ version, destination }));

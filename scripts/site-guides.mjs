// Narrow static reference export: retain every Markdown character, add navigation,
// and escape content. This deliberately leaves unsupported formatting visible.
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const initialGuides = ['README.md', 'Q&A.md', 'HEADACHES.md', 'docs/README.md',
  'docs/installation.md', 'docs/operator-recipes.md', 'docs/intent-evidence.md',
  'docs/limitations.md', 'docs/schema.md', 'docs/publishing.md'];
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const urlPath = value => value.split('/').map(encodeURIComponent).join('/');
const pagePath = file => `guides/${file.replace(/\.md$/u, '.html')}`;
const sourcePath = file => `sources/${file}`;
const relativeUrl = (from, to) => urlPath(path.posix.relative(path.posix.dirname(from), to));
const links = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)/gu;

function invalidPath(file, reason) {
  throw new Error(`guide_path_invalid: ${file}: ${reason}. Next action: select regular files and directories inside the source/output roots; remove the unsafe link or path before rebuilding.`);
}

async function inspectPath(absolute, kind, allowMissing) {
  let entry;
  try { entry = await lstat(absolute); } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    invalidPath(absolute, `cannot inspect ${kind} (${error.code ?? 'read failure'})`);
  }
  if (entry.isSymbolicLink()) invalidPath(absolute, 'symbolic links and junctions are unsupported');
  if (kind === 'directory' ? !entry.isDirectory() : !entry.isFile()) {
    invalidPath(absolute, `expected a regular ${kind}`);
  }
  return true;
}

async function inspectRoot(root, allowMissing = false) {
  const absolute = path.resolve(root);
  const drive = path.parse(absolute).root;
  for (const segment of path.relative(drive, absolute).split(path.sep).filter(Boolean)) {
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment)) invalidPath(absolute, 'unsafe directory component');
  }
  // The caller selects this root; platform aliases may exist above it (e.g. a
  // system temp directory). Refuse links at/below the root, or at the nearest
  // existing parent when creating a new output root.
  let current = absolute;
  while (!await inspectPath(current, 'directory', allowMissing)) {
    const parent = path.dirname(current);
    if (parent === current) invalidPath(absolute, 'no regular parent directory');
    current = parent;
  }
}

async function inspectChild(root, file, kind = 'file', allowMissing = false) {
  const relative = file.split('/');
  if (relative.some(segment => !segment || segment === '.' || segment === '..'
    || /[\\<>:"|?*\u0000-\u001f]/u.test(segment))) invalidPath(file, 'unsafe relative component');
  let current = path.resolve(root);
  for (let index = 0; index < relative.length; index += 1) {
    current = path.join(current, relative[index]);
    if (!await inspectPath(current, index === relative.length - 1 ? kind : 'directory', allowMissing)) break;
  }
}

export async function inspectSiteDestination(destination) {
  await inspectRoot(destination, true);
  for (const directory of ['assets', 'guides', 'sources']) {
    await inspectChild(destination, directory, 'directory', true);
  }
  for (const file of ['index.html', '.nojekyll', 'style.css',
    'assets/lodestar-ridgeline.png', 'assets/lodestar3-loader.png', 'assets/lodestar.ico']) {
    await inspectChild(destination, file, 'file', true);
  }
}

export async function inspectSiteSource(root) {
  await inspectRoot(root);
  for (const file of ['package.json', 'site/index.html', 'site/style.css',
    'docs/assets/lodestar-ridgeline.png', 'site/assets/lodestar3-loader.png',
    'desktop/Lodestar.Loader/Assets/Lodestar.ico']) {
    await inspectChild(root, file);
  }
}

function target(file, raw) {
  let href = raw.startsWith('<') ? raw.slice(1, -1) : raw;
  if (/[\u0000-\u0020\u007f]/u.test(href)) return null;
  if (/^(?:https?:|mailto:)/iu.test(href)) return { external: href };
  try { href = decodeURIComponent(href); } catch { return null; }
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])|[\u0000-\u0020\u007f]/iu.test(href)) return null;
  const hash = href.indexOf('#');
  const pathname = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? '' : href.slice(hash + 1);
  if (pathname.includes(':')) invalidPath(`${file} -> ${raw}`, 'alternate streams and colon paths are unsupported');
  if (pathname.includes('?') || pathname.includes('\\')) return null;
  const local = pathname ? path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname)) : file;
  if (local === '..' || local.startsWith('../')) return null;
  return { file: local, fragment };
}

function linesOf(text) {
  let fence = null;
  const seen = new Map();
  return text.replaceAll('\r\n', '\n').split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    const fenced = fence !== null || marker !== undefined;
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const heading = !fenced && /^#{1,6}\s+(.+?)\s*#*$/u.exec(line)?.[1];
    let id;
    if (heading) {
      const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-');
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      id = count ? `${slug}-${count}` : slug;
    }
    return { line, fenced, heading, id };
  });
}

export async function exportGuides(root, destination, version) {
  await inspectRoot(root);
  await inspectSiteDestination(destination);
  const documents = new Map();
  const resources = new Set();
  const pending = [...initialGuides, `docs/releases/v${version}.md`];
  while (pending.length) {
    const file = pending.shift();
    if (documents.has(file)) continue;
    await inspectChild(root, file);
    const bytes = await readFile(path.join(root, file));
    const lines = linesOf(bytes.toString('utf8'));
    documents.set(file, { bytes, lines });
    for (const { line, fenced } of lines) {
      if (fenced) continue;
      for (const match of line.matchAll(links)) {
        const resolved = target(file, match[1]);
        if (!resolved?.file || resolved.file === file) continue;
        if (resolved.file.endsWith('.md')) pending.push(resolved.file);
        else resources.add(resolved.file);
      }
    }
  }
  for (const file of resources) {
    await inspectChild(root, file);
    await inspectChild(destination, sourcePath(file), 'file', true);
    const output = path.join(destination, sourcePath(file));
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(path.join(root, file), output);
  }
  for (const [file, { bytes, lines }] of documents) {
    const page = pagePath(file);
    const body = lines.map(({ line, fenced, id }) => {
      let visible = escape(line);
      if (!fenced) {
        let offset = 0;
        const parts = [];
        for (const match of line.matchAll(links)) {
          parts.push(escape(line.slice(offset, match.index)));
          const resolved = target(file, match[1]);
          let href = resolved?.external;
          if (resolved?.file) {
            const document = documents.get(resolved.file);
            const anchorExists = !resolved.fragment || document?.lines.some(row => row.id === resolved.fragment);
            if (!anchorExists) {
              throw new Error(`guide_link_invalid: ${file} -> ${match[1]}: local heading is absent. Next action: correct the source link or add the matching heading in the canonical guide, then rebuild.`);
            }
            if (document || resources.has(resolved.file)) {
              href = relativeUrl(page, document ? pagePath(resolved.file) : sourcePath(resolved.file));
              if (resolved.fragment) href += `#${encodeURIComponent(resolved.fragment)}`;
            }
          }
          parts.push(href ? `<a href="${escape(href)}">${escape(match[0])}</a>` : escape(match[0]));
          offset = match.index + match[0].length;
        }
        parts.push(escape(line.slice(offset)));
        visible = parts.join('');
      }
      return id === undefined ? visible : `<span class="guide-heading" id="${escape(id)}">${visible}</span>`;
    }).join('\n');
    const title = lines.find(row => row.heading)?.heading ?? file;
    const toc = lines.filter(row => row.id !== undefined).map(row =>
      `<li><a href="#${escape(row.id)}">${escape(row.heading)}</a></li>`).join('\n');
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — Lodestar ${escape(version)}</title>
<link rel="icon" type="image/x-icon" href="${relativeUrl(page, 'assets/lodestar.ico')}" />
<link rel="stylesheet" href="${relativeUrl(page, 'style.css')}"></head>
<body class="guide-page"><a class="skip" href="#guide-content">Skip to reference</a>
<header class="wrap guide-header"><a class="wordmark" href="${relativeUrl(page, 'index.html')}">Lodestar <span class="wordmark-version">3</span></a>
<nav aria-label="Documentation"><a href="${relativeUrl(page, pagePath('docs/README.md'))}">All guides</a>
<a href="${relativeUrl(page, sourcePath(file))}" download>Download original Markdown</a></nav></header>
<main class="wrap guide-layout"><nav class="guide-contents" aria-label="Contents"><p class="eyebrow ink">Contents</p><ul>${toc}</ul></nav>
<article id="guide-content"><p class="guide-note">Lodestar ${escape(version)} reference · ${escape(file)}. See the installation guide for prerequisites and upgrade steps.</p>
<pre class="guide-source">${body}</pre></article></main></body></html>\n`;
    await inspectChild(destination, page, 'file', true);
    await inspectChild(destination, sourcePath(file), 'file', true);
    await mkdir(path.dirname(path.join(destination, page)), { recursive: true });
    await mkdir(path.dirname(path.join(destination, sourcePath(file))), { recursive: true });
    await writeFile(path.join(destination, sourcePath(file)), bytes);
    await writeFile(path.join(destination, page), html, 'utf8');
  }
  return documents.size;
}

import { readdirSync, readFileSync } from "node:fs";

/**
 * Release targets: public Pi apps (`apps/*` packages with a `pi` manifest that are not private) and public shared
 * packages (`packages/*` that are not private), such as a library an app installs from npm.
 * The CI selection and the release commands share this rule, so every release target is a package the workflow publishes.
 * Tags are named after the folder, so folder names must be unique across both directories.
 */
export function readReleaseTargets() {
  const targets = [...readPackages("apps", (pkg) => !!pkg.pi), ...readPackages("packages", () => true)];
  const slugs = new Set();
  for (const target of targets) {
    if (slugs.has(target.slug)) throw new Error(`Release targets need unique folder names: ${target.slug}`);
    slugs.add(target.slug);
  }
  return targets;
}

function readPackages(folder, isReleasable) {
  return readdirSync(new URL(`../${folder}/`, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pkg = JSON.parse(readFileSync(new URL(`../${folder}/${entry.name}/package.json`, import.meta.url), "utf8"));
      const workspaceDependencies = Object.entries(pkg.dependencies ?? {})
        .filter(([, range]) => range.startsWith("workspace:"))
        .map(([name]) => name);
      const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
      return {
        slug: entry.name,
        path: `${folder}/${entry.name}`,
        name: pkg.name,
        version: pkg.version,
        workspaceDependencies,
        bundledDependencies: Array.isArray(bundled) ? bundled : [],
        isReleaseTarget: pkg.private !== true && isReleasable(pkg),
      };
    })
    .filter((target) => target.isReleaseTarget);
}

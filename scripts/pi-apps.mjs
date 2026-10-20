import { readdirSync, readFileSync } from "node:fs";

/**
 * Public Pi apps: `apps/*` packages with a `pi` manifest that are not private.
 * The CI selection and the release commands share this rule, so every release target is a package the workflow publishes.
 */
export function readPublicPiApps() {
  return readdirSync(new URL("../apps/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pkg = JSON.parse(readFileSync(new URL(`../apps/${entry.name}/package.json`, import.meta.url), "utf8"));
      return { slug: entry.name, path: `apps/${entry.name}`, name: pkg.name, version: pkg.version, isPublicPiPackage: pkg.private !== true && !!pkg.pi };
    })
    .filter((app) => app.isPublicPiPackage);
}

import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Installed Pi packages deliberately omit host peers. Supply the same host
// instances as this verification process, without modifying either installation.
// registerHooks is available in the package's Node.js 22.19+ runtime range.
const peers = new Map(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"].map(name => [name, import.meta.resolve(name)]));
registerHooks({ resolve(specifier, context, nextResolve) {
    const url = peers.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
} });
export async function loadPackage(root) {
    const modules = await Promise.all(["index", "sources", "store", "config"].map(name => import(pathToFileURL(join(root, `dist/${name}.js`)))));
    return Object.assign({}, ...modules);
}

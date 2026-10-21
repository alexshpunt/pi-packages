import {
    type CommandEffects,
    nativeNetwork,
    READ_ONLY_GIT_SUBCOMMANDS,
    type ShellTarget,
} from "./command-effects.js";
import { executableName } from "./platform-paths.js";
import type { PowerShellCommand } from "./powershell.js";

type PathEffect = "read" | "write" | "read-write";
/** Parameter binding of a default Windows PowerShell 5.1 / PowerShell 7 command. */
interface CommandSpec {
    readonly kind: "read" | "write" | "output" | "network";
    readonly positional?: readonly string[];
    /** ValueFromRemainingArguments: extra positional words are data, not paths. */
    readonly takesRemaining?: boolean;
    readonly paths?: Readonly<Record<string, PathEffect>>;
    readonly values?: readonly string[];
    readonly switches?: readonly string[];
    readonly aliases?: Readonly<Record<string, string>>;
    /** Pipeline input binds data only, never a path parameter. */
    readonly isPipelineSafe?: boolean;
}

const LITERAL_PATH = { pspath: "literalpath", lp: "literalpath" };
const COMMON_SWITCHES = ["verbose", "debug", "whatif", "confirm"];
const COMMON_VALUES = [
    "erroraction",
    "warningaction",
    "informationaction",
    "progressaction",
    "errorvariable",
    "warningvariable",
    "informationvariable",
    "outvariable",
    "outbuffer",
    "pipelinevariable",
];
const COMMON_ALIASES: Readonly<Record<string, string>> = {
    vb: "verbose",
    db: "debug",
    wi: "whatif",
    cf: "confirm",
    ea: "erroraction",
    wa: "warningaction",
    infa: "informationaction",
    proga: "progressaction",
    ev: "errorvariable",
    wv: "warningvariable",
    iv: "informationvariable",
    ov: "outvariable",
    ob: "outbuffer",
    pv: "pipelinevariable",
};
const CONTENT_WRITE: CommandSpec = {
    kind: "write",
    positional: ["path", "value"],
    paths: { path: "write", literalpath: "write" },
    values: ["value", "encoding"],
    switches: ["force", "nonewline", "passthru", "asbytestream"],
    aliases: LITERAL_PATH,
};
const NEW_ITEM: CommandSpec = {
    kind: "write",
    positional: ["path"],
    paths: { path: "write" },
    values: ["name", "itemtype", "value"],
    switches: ["force"],
    aliases: { type: "itemtype", target: "value" },
};
const REMOVE_ITEM: CommandSpec = {
    kind: "write",
    positional: ["path"],
    paths: { path: "write", literalpath: "write" },
    switches: ["recurse", "force"],
    aliases: { ...LITERAL_PATH, r: "recurse" },
};
const COPY_ITEM: CommandSpec = {
    kind: "write",
    positional: ["path", "destination"],
    paths: { path: "read", literalpath: "read", destination: "write" },
    switches: ["recurse", "force", "container", "passthru"],
    aliases: LITERAL_PATH,
};
const MOVE_ITEM: CommandSpec = {
    kind: "write",
    positional: ["path", "destination"],
    paths: {
        path: "read-write",
        literalpath: "read-write",
        destination: "write",
    },
    switches: ["force", "passthru"],
    aliases: LITERAL_PATH,
};
const WEB_REQUEST: CommandSpec = {
    kind: "network",
    positional: ["uri"],
    paths: { outfile: "write", infile: "read" },
    values: [
        "uri",
        "method",
        "body",
        "contenttype",
        "timeoutsec",
        "maximumredirection",
        "useragent",
        "proxy",
    ],
    switches: [
        "usebasicparsing",
        "passthru",
        "disablekeepalive",
        "skipcertificatecheck",
        "skiphttperrorcheck",
    ],
};
const OUTPUT: CommandSpec = {
    kind: "output",
    takesRemaining: true,
    values: ["inputobject"],
    isPipelineSafe: true,
};
/** Cmdlets and functions by lowercase name; unknown names and parameters need review. */
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
    "get-content": {
        kind: "read",
        positional: ["path"],
        paths: { path: "read", literalpath: "read" },
        values: ["totalcount", "tail", "encoding", "delimiter", "readcount"],
        switches: ["raw", "force", "asbytestream"],
        aliases: {
            ...LITERAL_PATH,
            first: "totalcount",
            head: "totalcount",
            last: "tail",
        },
    },
    "get-childitem": {
        kind: "read",
        positional: ["path", "filter"],
        paths: { path: "read", literalpath: "read" },
        values: ["filter", "include", "exclude", "depth", "attributes"],
        switches: [
            "recurse",
            "force",
            "name",
            "file",
            "directory",
            "hidden",
            "readonly",
            "system",
            "followsymlink",
        ],
        aliases: {
            ...LITERAL_PATH,
            s: "recurse",
            ad: "directory",
            af: "file",
            ah: "hidden",
            ar: "readonly",
            as: "system",
        },
    },
    "get-item": {
        kind: "read",
        positional: ["path"],
        paths: { path: "read", literalpath: "read" },
        switches: ["force"],
        aliases: LITERAL_PATH,
    },
    "test-path": {
        kind: "read",
        positional: ["path"],
        paths: { path: "read", literalpath: "read" },
        values: ["pathtype"],
        switches: ["isvalid"],
        aliases: { ...LITERAL_PATH, type: "pathtype" },
    },
    "resolve-path": {
        kind: "read",
        positional: ["path"],
        paths: { path: "read", literalpath: "read" },
        switches: ["relative"],
        aliases: LITERAL_PATH,
    },
    "get-filehash": {
        kind: "read",
        positional: ["path"],
        paths: { path: "read", literalpath: "read" },
        values: ["algorithm"],
        aliases: LITERAL_PATH,
    },
    "select-string": {
        kind: "read",
        positional: ["pattern", "path"],
        paths: { path: "read", literalpath: "read" },
        values: ["pattern", "context", "encoding"],
        switches: [
            "simplematch",
            "casesensitive",
            "notmatch",
            "list",
            "quiet",
            "raw",
            "allmatches",
            "noemphasis",
        ],
        aliases: LITERAL_PATH,
    },
    "get-location": { kind: "read" },
    "write-output": { ...OUTPUT, switches: ["noenumerate"] },
    "write-host": {
        ...OUTPUT,
        values: ["object", "separator", "foregroundcolor", "backgroundcolor"],
        switches: ["nonewline"],
    },
    "measure-object": {
        kind: "output",
        positional: ["property"],
        values: ["property"],
        switches: [
            "line",
            "word",
            "character",
            "sum",
            "average",
            "maximum",
            "minimum",
            "ignorewhitespace",
        ],
        isPipelineSafe: true,
    },
    "select-object": {
        kind: "output",
        positional: ["property"],
        values: ["property", "expandproperty", "first", "last", "skip"],
        switches: ["unique"],
        isPipelineSafe: true,
    },
    "sort-object": {
        kind: "output",
        positional: ["property"],
        values: ["property"],
        switches: ["descending", "unique", "casesensitive"],
        isPipelineSafe: true,
    },
    "out-null": { kind: "output", isPipelineSafe: true },
    "out-host": { kind: "output", switches: ["paging"], isPipelineSafe: true },
    "out-string": {
        kind: "output",
        values: ["width"],
        switches: ["stream"],
        isPipelineSafe: true,
    },
    "set-content": CONTENT_WRITE,
    "add-content": CONTENT_WRITE,
    "clear-content": {
        kind: "write",
        positional: ["path"],
        paths: { path: "write", literalpath: "write" },
        switches: ["force"],
        aliases: LITERAL_PATH,
    },
    "out-file": {
        kind: "write",
        positional: ["filepath", "encoding"],
        paths: { filepath: "write", literalpath: "write" },
        values: ["encoding", "width"],
        switches: ["append", "force", "noclobber", "nonewline"],
        aliases: { ...LITERAL_PATH, path: "filepath" },
        isPipelineSafe: true,
    },
    "tee-object": {
        kind: "write",
        positional: ["filepath"],
        paths: { filepath: "write", literalpath: "write" },
        values: ["encoding"],
        switches: ["append"],
        aliases: { ...LITERAL_PATH, path: "filepath" },
        isPipelineSafe: true,
    },
    "new-item": NEW_ITEM,
    mkdir: NEW_ITEM,
    "remove-item": REMOVE_ITEM,
    "copy-item": COPY_ITEM,
    "move-item": MOVE_ITEM,
    "rename-item": {
        kind: "write",
        positional: ["path", "newname"],
        paths: { path: "read-write", literalpath: "read-write" },
        values: ["newname"],
        switches: ["force", "passthru"],
        aliases: LITERAL_PATH,
    },
    "invoke-webrequest": WEB_REQUEST,
    "invoke-restmethod": WEB_REQUEST,
};
/** Default aliases shared by Windows PowerShell 5.1 and PowerShell 7 on Windows. */
const ALIASES: Readonly<Record<string, string>> = {
    cat: "get-content",
    gc: "get-content",
    type: "get-content",
    dir: "get-childitem",
    gci: "get-childitem",
    ls: "get-childitem",
    gi: "get-item",
    gl: "get-location",
    pwd: "get-location",
    rvpa: "resolve-path",
    sls: "select-string",
    echo: "write-output",
    write: "write-output",
    measure: "measure-object",
    select: "select-object",
    sort: "sort-object",
    oh: "out-host",
    ac: "add-content",
    clc: "clear-content",
    tee: "tee-object",
    ni: "new-item",
    md: "mkdir",
    del: "remove-item",
    erase: "remove-item",
    rd: "remove-item",
    ri: "remove-item",
    rm: "remove-item",
    rmdir: "remove-item",
    copy: "copy-item",
    cp: "copy-item",
    cpi: "copy-item",
    mi: "move-item",
    move: "move-item",
    mv: "move-item",
    ren: "rename-item",
    rni: "rename-item",
    iwr: "invoke-webrequest",
    irm: "invoke-restmethod",
};
/** `curl`/`wget` alias Invoke-WebRequest only in 5.1; PowerShell 7 runs the native program. */
const VERSION_DEPENDENT_NETWORK = new Set(["curl", "wget"]);
const NATIVE_READS = new Set(["rg"]);

export type ResolvedPowerShellCommand =
    | {
          readonly kind: "cmdlet";
          readonly name: string;
          readonly spec: CommandSpec;
      }
    | { readonly kind: "native"; readonly name: string }
    | { readonly kind: "version-dependent"; readonly name: string };

/** Documented spellings of the table's commands, for trusted rules written with them. */
const CANONICAL_NAMES = new Map(
    [
        "Get-Content",
        "Get-ChildItem",
        "Get-Item",
        "Test-Path",
        "Resolve-Path",
        "Get-FileHash",
        "Select-String",
        "Get-Location",
        "Write-Output",
        "Write-Host",
        "Measure-Object",
        "Select-Object",
        "Sort-Object",
        "Out-Null",
        "Out-Host",
        "Out-String",
        "Set-Content",
        "Add-Content",
        "Clear-Content",
        "Out-File",
        "Tee-Object",
        "New-Item",
        "mkdir",
        "Remove-Item",
        "Copy-Item",
        "Move-Item",
        "Rename-Item",
        "Invoke-WebRequest",
        "Invoke-RestMethod",
    ].map((name) => [name.toLowerCase(), name]),
);

/** Name resolution without profiles: alias, then function/cmdlet, then application. */
export function resolvePowerShellCommand(
    word: string,
): ResolvedPowerShellCommand | undefined {
    // Path- or module-qualified names bypass the default command table.
    if (/[\\/:]/.test(word)) return undefined;
    const lower = word.toLowerCase();
    if (VERSION_DEPENDENT_NETWORK.has(lower))
        return { kind: "version-dependent", name: lower };
    const name = ALIASES[lower] ?? lower;
    const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (spec) return { kind: "cmdlet", name, spec };
    return { kind: "native", name: executableName(lower, "win32") };
}

/** The documented cmdlet name a known cmdlet or default alias invokes, in any case. */
export function canonicalPowerShellCommand(word: string): string | undefined {
    const resolved = resolvePowerShellCommand(word);
    return resolved?.kind === "cmdlet"
        ? CANONICAL_NAMES.get(resolved.name)
        : undefined;
}

export type BoundParameters = ReadonlyMap<string, string>;
/**
 * Named, then positional binding of literal words. Prefix abbreviations, repeated
 * parameters, missing values and extra positional words are unsupported.
 */
export function bindPowerShellParameters(
    spec: CommandSpec,
    args: readonly string[],
):
    | { readonly bound: BoundParameters; readonly remaining: readonly string[] }
    | undefined {
    const bound = new Map<string, string>(),
        positional: string[] = [];
    let isPositionalOnly = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (!isPositionalOnly && arg === "--") {
            isPositionalOnly = true;
            continue;
        }
        if (isPositionalOnly || !/^-[A-Za-z_?]/.test(arg)) {
            positional.push(arg);
            continue;
        }
        const raw = arg.slice(1).toLowerCase();
        const name = spec.aliases?.[raw] ?? COMMON_ALIASES[raw] ?? raw;
        if (bound.has(name)) return undefined;
        if (spec.switches?.includes(name) || COMMON_SWITCHES.includes(name)) {
            bound.set(name, "");
            continue;
        }
        const value = args[index + 1];
        if (
            (!spec.values?.includes(name) &&
                !Object.hasOwn(spec.paths ?? {}, name) &&
                !COMMON_VALUES.includes(name)) ||
            value === undefined ||
            /^-[A-Za-z_?]/.test(value)
        )
            return undefined;
        bound.set(name, value);
        index++;
    }
    const remaining: string[] = [];
    let slot = 0;
    for (const value of positional) {
        while (
            spec.positional &&
            slot < spec.positional.length &&
            bound.has(spec.positional[slot])
        )
            slot++;
        if (spec.positional && slot < spec.positional.length)
            bound.set(spec.positional[slot++], value);
        else if (spec.takesRemaining) remaining.push(value);
        else return undefined;
    }
    return { bound, remaining };
}

const WILDCARD = /[*?[\]]/;
/** A path argument; wildcard patterns only bound the directory before the first wildcard. */
function pathTarget(parameter: string, value: string): ShellTarget {
    if (parameter === "literalpath" || !WILDCARD.test(value))
        return { operand: value, isExact: true };
    const prefix = value.slice(0, value.search(WILDCARD));
    const separator = Math.max(
        prefix.lastIndexOf("\\"),
        prefix.lastIndexOf("/"),
    );
    return {
        operand: separator < 0 ? "." : prefix.slice(0, separator + 1) || ".",
        isExact: false,
    };
}
/** Provider-qualified paths (`Env:`, `HKLM:`, `Temp:`, `FileSystem::`) are not file paths. */
export function isProviderPath(value: string): boolean {
    return value.includes("::") || /^[^\\/:]{2,}:/.test(value);
}

const unknown: CommandEffects = {
    isKnown: false,
    reads: [],
    writes: [],
    writesGitMetadata: false,
};

/** Effects of one PowerShell command, with parameter-aware path and network classification. */
export function powershellCommandEffects(
    command: PowerShellCommand,
    isSupported: boolean,
): CommandEffects {
    // Redirection binds `Out-File -FilePath`, which resolves wildcards like the parameter.
    const redirects = command.writes.map((operand) =>
        isProviderPath(operand)
            ? { operand, isExact: false, isUnlocatable: true }
            : pathTarget("filepath", operand),
    );
    const resolved = resolvePowerShellCommand(command.argv[0] ?? "");
    if (!isSupported || !resolved) return { ...unknown, writes: redirects };
    const args = command.argv.slice(1);
    if (resolved.kind === "version-dependent")
        return {
            ...unknown,
            writes: redirects,
            network: {
                ...nativeNetwork(resolved.name, args),
                isIndirect: true,
            },
        };
    if (resolved.kind === "native") {
        // Native arguments are passed as typed only when no quote re-escaping is involved.
        const isPlain = args.every((arg) => !arg.includes('"'));
        const operands = args.filter((arg) => !arg.startsWith("-"));
        if (resolved.name === "git")
            return {
                isKnown: isPlain,
                reads: [],
                writes: redirects,
                writesGitMetadata: !READ_ONLY_GIT_SUBCOMMANDS.has(
                    args[0] ?? "",
                ),
            };
        if (NATIVE_READS.has(resolved.name))
            return {
                isKnown: isPlain,
                reads: operands.map((operand) => ({ operand, isExact: true })),
                writes: redirects,
                writesGitMetadata: false,
            };
        if (resolved.name === "curl" || resolved.name === "wget")
            return {
                isKnown: isPlain,
                reads: [],
                writes: redirects,
                writesGitMetadata: false,
                network: nativeNetwork(resolved.name, args),
            };
        return { ...unknown, writes: redirects };
    }
    const { spec } = resolved;
    const binding = bindPowerShellParameters(spec, args);
    if (!binding || (command.receivesPipeline && !spec.isPipelineSafe))
        return { ...unknown, writes: redirects };
    const { bound } = binding;
    const reads: ShellTarget[] = [],
        writes: ShellTarget[] = [...redirects];
    let isKnown = true;
    for (const [parameter, effect] of Object.entries(spec.paths ?? {})) {
        const value = bound.get(parameter);
        if (value === undefined) continue;
        if (isProviderPath(value)) {
            isKnown = false;
            const target = {
                operand: value,
                isExact: false,
                isUnlocatable: true,
            };
            if (effect !== "write") reads.push(target);
            if (effect !== "read") writes.push(target);
            continue;
        }
        const target = pathTarget(parameter, value);
        if (effect !== "write") reads.push(target);
        if (effect !== "read") writes.push(target);
        const newName = bound.get("newname");
        if (resolved.name === "rename-item" && newName !== undefined)
            // The new name replaces the last component in the same directory.
            writes.push({
                operand: `${target.operand.replace(/[^\\/]*[\\/]*$/, "")}${newName}`,
                isExact: target.isExact,
            });
    }
    const pathValue = bound.get("path") ?? bound.get("literalpath");
    const name = bound.get("name");
    if (resolved.name === "new-item" || resolved.name === "mkdir") {
        const itemType = bound.get("itemtype")?.toLowerCase();
        // Links point to targets this analysis cannot bind; other types are files or directories.
        if (itemType !== undefined && !["file", "directory"].includes(itemType))
            isKnown = false;
        if (name !== undefined && isProviderPath(name)) isKnown = false;
        else if (name !== undefined)
            writes.push({
                operand: `${pathValue ?? "."}/${name}`,
                isExact: !WILDCARD.test(pathValue ?? ""),
            });
    }
    if (
        (resolved.name === "copy-item" || resolved.name === "move-item") &&
        !bound.has("destination")
    )
        writes.push({ operand: ".", isExact: true });
    // A write without a literal target would prompt or take its path from elsewhere.
    if (
        spec.kind === "write" &&
        !Object.keys(spec.paths ?? {}).some((parameter) =>
            bound.has(parameter),
        ) &&
        name === undefined
    )
        isKnown = false;
    let network: CommandEffects["network"];
    if (spec.kind === "network") {
        const uri = bound.get("uri");
        network = {
            urls: uri && /^https?:\/\//.test(uri) ? [uri] : [],
            isIndirect: bound.has("proxy"),
        };
    }
    return {
        isKnown,
        reads,
        writes,
        writesGitMetadata: false,
        ...(network ? { network } : {}),
    };
}

# proto sources

`.proto` sources for the Devin protocol schema. The runtime (`src/core/protocol/protobuf.ts`) parses this directory directly, and the npm package ships it (`files` in `package.json` lists `proto`). `buf` remains a development-only compile check; no built descriptor is shipped.

## Layout

- The 63 files of the original FileDescriptorSet keep their original logical paths and import relationships. This includes the dependency files that were in the original, such as `google/protobuf/*`, `google/api/expr/*` and `buf/validate/validate.proto`.
- Declarations, numbers, labels, proto3 optional, oneofs, maps, reserved ranges, extensions, defaults, custom `json_name` and options were copied from the original as is, including the `buf.validate` custom options.
- The original has no SourceCodeInfo. The original comments and formatting cannot be recovered, so there are no comments other than the notes on observed additions. Types in the same package use relative names; types from other packages use the fully qualified name with a leading dot (`.exa.codeium_common_pb.Metadata`).
- The current tree is edited directly and keeps the original logical paths and declaration order. Only the order in 3 files was adjusted so the compiler produces the original declaration order: the added value 7 of `DisplayOption` moved after the base descriptor's values, and the nested messages `Index.RepoStats` and `SourceInfo.Extension` moved before the map fields. Fields, numbers and options match the previously printed tree (the `descriptor-to-proto.mjs` output).
- This source is now the shipped schema itself. The runtime loads it directly, so edits take effect on the next start. The original third-party descriptor is not shipped and not kept in the package.

## Added definitions

Definitions that the base descriptor does not have. This package added them from its own protocol analysis, and they are marked with `[added field]` or `[added value]` comments in the source. The names are this package's DTO names, not the original identifiers. They go into the built descriptor as is, so the runtime does not add them separately. The evidence is in `verification/followup/proto-provenance.json`.

| Location | Definition |
| --- | --- |
| `exa.api_server_pb.GetChatMessageRequest` | `string client_session_id = 28` |
| `exa.chat_pb.ChatMessagePrompt` | `string model_uid = 22` |
| `exa.codeium_common_pb.ModelInfo` | `repeated string aliases = 27` |
| `exa.codeium_common_pb.DisplayOption` | `DISPLAY_OPTION_WIRE_7 = 7` |

## Verification

First install the dev dependencies from the repository root. The compiler is the app's dev dependency `@bufbuild/buf` 1.74.0 (Apache-2.0). Platform binaries come as optional packages and need no install scripts.

```bash
pnpm --filter @buyong/pi-devin install --frozen-lockfile --ignore-scripts
```

Run from `apps/pi-devin`.

```bash
node verification/scripts/verify-proto.mjs --report verification/followup/proto-check.json --mutation-control
```

Exit 0 means all of the checks below passed. Exit 1 means one of compilation, a wire check or a control failed. Reports are written only to `verification/followup/` or the Node temp directory (`TMPDIR`).

1. The source tree must compile: `buf build proto --as-file-descriptor-set --exclude-source-info` must succeed in a temp directory.
2. Bytes produced by the real runtime codecs (`chatRequestCodec`, `chatResponseCodec`, `unaryCodecs`) are decoded and re-encoded with a root parsed from the same source tree, using the 7 preserved capture requests and responses, the model catalog fixture and 4 probes for the additions. The added fields must resolve by name. As a control, with a root parsed from a copy that omits the additions, those fields must disappear or remain as numbers.
3. With `--mutation-control`, one field number (`ChatMessagePrompt.signature_type` 18→1018) is changed in a temp copy, and the compiled result must differ from the unmodified build.

The byte-for-byte comparison against a shipped descriptor and the optional comparison against the original third-party descriptor were removed when the runtime switched to loading this directory directly. The recorded results remain in `verification/followup/proto-check-08.json` and `verification/followup/proto-check-12.json`, and the normalization rules below document that record.

### Normalization rules (record of the original comparison)

| ID | Rule | Applied |
| --- | --- | --- |
| N1 | Empty `MethodOptions` (`{}`) in the original are compared as absent. The built shipped file has none either. They look like traces of source-retention options removed before the original was generated, and their values cannot be recovered. | 654 |
| N2 | Fields without a `json_name` in the original are compared with the default `json_name` the compiler produces. The built shipped file contains the default, and protobufjs does not use it. | 14 |
| N3 | Files are matched by name. The file order inside the FileDescriptorSet is only reported. | - |

The protobufjs 7.6.6 descriptor schema is not used as the reference decoder, because re-encoding the original with it drops custom options and editions fields from 21 files.

## Changing the schema

When a new wire definition appears, change the following together.

1. Add the definition with an `[added field]` (or `[added value]` for enums) comment to the relevant `.proto`. Put it after the original declarations so the declaration order stays stable.
2. Add the evidence and whether the name is local to `observedAdditions` in `verification/followup/proto-provenance.json`.
3. There is no build step: the runtime reads this directory, so edit the sources directly and rerun the verifier.

Then run the verifier and save the report under a new per-task name (for example, `proto-check-13.json`) instead of overwriting an earlier report. If the schema changes, redo the artifact verification (06).

## Printing again

To view a descriptor's declarations as `.proto` again, pass a new empty directory and an explicit `--descriptor <FileDescriptorSet>`. The tool does not overwrite a non-empty directory, and the output has no `[added …]` comments. The package no longer keeps a built descriptor.

```bash
node verification/scripts/descriptor-to-proto.mjs --out "$(mktemp -d)/printed"
```

You can also build just a temporary descriptor.

```bash
pnpm exec buf build proto --as-file-descriptor-set --exclude-source-info -o "${TMPDIR:-/tmp}/regenerated.binpb"
```

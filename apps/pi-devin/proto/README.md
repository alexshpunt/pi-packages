# proto sources

`.proto` sources for the Devin protocol schema. The shipped `resources/descriptors.pb` is the buf build of this directory, and the runtime (`src/core/protocol/protobuf.ts`) reads only that file. This directory and the verification tools are for development only and are not included in the npm package files (`files` in `package.json`).

## Layout

- The 63 files of the original FileDescriptorSet keep their original logical paths and import relationships. This includes the dependency files that were in the original, such as `google/protobuf/*`, `google/api/expr/*` and `buf/validate/validate.proto`.
- Declarations, numbers, labels, proto3 optional, oneofs, maps, reserved ranges, extensions, defaults, custom `json_name` and options were copied from the original as is, including the `buf.validate` custom options.
- The original has no SourceCodeInfo. The original comments and formatting cannot be recovered, so there are no comments other than the notes on observed additions. Types in the same package use relative names; types from other packages use the fully qualified name with a leading dot (`.exa.codeium_common_pb.Metadata`).
- The current tree is the reconstructed source tree. Only the order in 3 files was changed so the compiler produces the original declaration order: the added value 7 of `DisplayOption` moved after the base descriptor's values, and the nested messages `Index.RepoStats` and `SourceInfo.Extension` moved before the map fields. Fields, numbers and options match the previous tree (the `descriptor-to-proto.mjs` output).
- This source is now edited directly. Since 2026-10-20, `resources/descriptors.pb` is also rebuilt from this source. The original third-party descriptor is not shipped and not kept in the package.

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
# also compare with the original: --original <original FileDescriptorSet>
```

Exit 0 means all of the checks below passed. Exit 1 means one of compilation, the shipped file, the original, the wire or the controls failed. Reports are written only to `verification/followup/` or the Node temp directory (`TMPDIR`).

1. Rebuild the descriptor in a temp directory with `buf build proto --as-file-descriptor-set --exclude-source-info`.
2. The rebuilt result must match `resources/descriptors.pb` byte for byte, and its SHA256 must equal `shipped.sha256` in the provenance. The shipped file hash is also compared before and after the check.
3. Bytes produced by the real runtime codecs (`chatRequestCodec`, `chatResponseCodec`, `unaryCodecs`) are decoded and re-encoded with the rebuilt schema, using the 7 preserved capture requests and responses, the model catalog fixture and 4 probes for the additions. The added fields must resolve by name. As a control, with a schema that omits the additions, those fields must disappear or remain as numbers.
4. With `--mutation-control`, one field number (`ChatMessagePrompt.signature_type` 18→1018) is changed in a temp copy, and the result must differ from the shipped file.
5. With `--original`, the whole original and the SHA256 of each of its 63 files must match the provenance baseline. Then the original is decoded losslessly with `buf convert`, and only the normalizations below and the observed additions are applied to build the expected value. The expected value and the rebuilt result must match in per-file bytes, overall semantics and the shape protobufjs reads (field names, numbers, types, repetition, maps, oneofs, proto3 optional, enum values and RPCs). The check fails if a normalization is applied a different number of times than declared. The 2026-10-20 record of this comparison is `verification/followup/proto-check-08.json`.

### Normalization rules

| ID | Rule | Applied |
| --- | --- | --- |
| N1 | Empty `MethodOptions` (`{}`) in the original are compared as absent. The built shipped file has none either. They look like traces of source-retention options removed before the original was generated, and their values cannot be recovered. | 654 |
| N2 | Fields without a `json_name` in the original are compared with the default `json_name` the compiler produces. The built shipped file contains the default, and protobufjs does not use it. | 14 |
| N3 | Files are matched by name. The file order inside the FileDescriptorSet is only reported. | - |

The protobufjs 7.6.6 descriptor schema is not used as the reference decoder, because re-encoding the original with it drops custom options and editions fields from 21 files.

## Changing the schema

When a new wire definition appears, change the following together.

1. Add the definition with an `[added field]` (or `[added value]` for enums) comment to the relevant `.proto`. Put it after the original declarations so the order matches the expected value of the original comparison.
2. Add the evidence and whether the name is local to `observedAdditions` in `verification/followup/proto-provenance.json`.
3. Rebuild the shipped file with `pnpm exec buf build proto --as-file-descriptor-set --exclude-source-info -o resources/descriptors.pb`, and update `shipped.sha256` and `bytes` in the provenance.

Then run the verifier and save the report under a new per-task name (for example, `proto-check-02.json`) instead of overwriting an earlier report. If the shipped file changes, redo the artifact verification (06).

## Printing again

To view the descriptor's declarations as `.proto` again, pass a new empty directory. The tool does not overwrite a non-empty directory. The default input is the shipped file, and the output has no `[added …]` comments. To view the original declarations, use `--descriptor <original>`.

```bash
node verification/scripts/descriptor-to-proto.mjs --out "$(mktemp -d)/printed"
```

You can also build just a temporary descriptor.

```bash
pnpm exec buf build proto --as-file-descriptor-set --exclude-source-info -o "${TMPDIR:-/tmp}/regenerated.binpb"
```

# Model selection and catalog contract

## Public selection and the final UID

The shared `projectModelVariants()` uses `modelFamilyMetadata.entries` from the original catalog. It does not guess thinking levels from model names or prices.

- `family:<encoded-family>:<base64url-dimensions>` combines the family with the non-reasoning dimensions `(key, order, name)`. Without dimensions, the last part is omitted. Lightning/Fast Mode, context, cache and similar dimensions are not merged.
- `uid:<encodeURIComponent(uid)>` is the resolved-UID path. CLI alias resolution is not applied again. On this path, `/thinking` supports only the verified level of that variant.
- `resolveBackendSelection(projection, modelID, effectiveLevel)` returns `{uid, model, level, variant}`. Invalid levels, disabled variants and unknown IDs are rejected. There is no fallback to another model.
- A Pi model's `thinkingLevelMap` holds the UID for supported levels and `null` for the rest. On a model switch, the host's clamping and the rejection of an explicit unsupported choice are different behaviors. 04 must pass the already selected effective level to the resolver.
- When UIDs collide at the same level, or context/output/image/tool limits differ between variants, the group is not listed. Each verified exact UID path is kept. Different limits are never merged and advertised in a single static Pi Model definition.

The 265 fixture entries are classified into 69 groups, matching the existing audit. Of these, 65 groups and 261 exact UIDs become Pi model definitions. `kimi-k2-6`, `kimi-k2-7`, `swe-1-6` and `swe-1-6-fast` have only a reasoning capability without evidence for effort levels, so they are explicitly unsupported in the Pi projection. Their existing selectability in the CLI was not removed. New models whose router contract is unverified are not treated as supported either.

For the 261 UIDs, the real shared `chatRequest()` and protobuf codec were wired up to confirm the UID and the explicit output limit of `5000`. This is not real network inference. The final provider's hooks, transport and response handling are wired in 04.

## Model costs

Pi's required cost numbers use a 0 placeholder, with `cost unknown` in the name and `costsUnknown: true` in the model metadata. **0 is not free and not a real USD cost.** Credit multipliers or tiers are not converted to USD/token. 04's usage/diagnostics and the final README must keep this distinction too.

## Per-account and per-endpoint cache

`createDevinModelSource()` receives a host credential resolver and `fetchCatalog()` by injection. It does not modify 02's auth implementation or CLI files, or read credential files directly.

- The factory and the synchronous `getModels()` do no I/O. The initial list is empty.
- The cache stores only the needed model fields through a whitelist. Raw tokens, the request fingerprint `f` and the assignment JWT are not stored. The ownership scope is a one-way hash of the credential and the normalized RPC endpoint. A new token is treated as a separate scope even for the same person, which is a conservative policy.
- After checking the scope, version, provider, api and endpoint of the stored models, the projection is rebuilt from a minimal config. Arbitrary costs or thinking maps in the stored file are not trusted as is.
- Restore, change and persistence go through `ctx.publish({update,persist?})`. Cancelled or rejected publications and late responses do not change the current models. An uncooperative loader is not awaited on caller cancellation.
- The local catalog check interval is 300000ms. `force` bypasses it. `allowNetwork:false` always skips the network lookup. This interval is not a server model validity period or a token lifetime.
- A transient lookup failure in the same scope keeps the last good list. Another credential or endpoint cannot use the earlier list as authorized models. `filterModels()` and `resolve(..., credential)` before sending also check the scope.
- Logout clears the in-memory list. Even if the host cache remains on disk, it is not restored without a matching credential. No state is written to the CLI store or the install directory.

Custom metadata was confirmed to survive in the in-memory store of public Pi `Models` and in the real temporary catalog file of coding-agent's `ModelRuntime`. The real host file check ran in a network-blocked sandbox. `modelsPath: null` also disables the file store in this SDK, so the file check used an explicit temporary `models.json` path.

## 04 wiring example

```ts
const source = createDevinModelSource({
  credentialFromHost: (value) => value?.type === "oauth" ? credentialFromOAuth(value) : undefined,
  fetchCatalog: async (credential, signal) => {
    const client = new DevinClient(credential);
    try { return await client.catalog(signal); }
    finally { client.transport.close(); }
  },
});
// Connect the provider's getModels/filterModels/refreshModels to the matching source methods.
const selected = source.resolve(piModel.id, effectiveThinking, effectiveCredential);
// Apply selected.uid and the limits of selected.model to the final request.
```

This example explains the wiring and omits retries, auth failure propagation, the run budget and the session lifecycle. 04 must pass auth failures to the same auth generation and apply the real call budget and lifetime boundaries together.

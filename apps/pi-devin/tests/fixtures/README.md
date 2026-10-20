# De-identified protocol fixtures

`captured-samples/GetChatMessage/` is offline codec input that keeps the field structure, enums, numbers and frame counts of the original 7 scenarios. Real account tokens, fingerprint ciphertext, thinking and user text, images and identifiers were replaced with synthetic values. For tool JSON argument chunks, a valid synthetic object was put in the first chunk and the later chunks were emptied. The `ls -la ~/Desktop` string, already pinned by assertions, is kept as test data that is never executed.

Differences from the original input and the original SHA-256 values are recorded in `captured-samples/GetChatMessage/provenance.json`. Do not modify the original captures or reuse them as network credentials. The protobuf string conversion of numeric argument chunks is checked separately in `tests/core-api.test.ts`.

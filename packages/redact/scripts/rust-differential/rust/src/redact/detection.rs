// Types copied from buyong-mcp apps/codemap-search/src/redact/detection.rs (lines 7-33).
use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum DetectionKind {
    SensitiveField,
    Token,
    Credential,
    PrivateKey,
    Custom,
    Pii,
}

/// No raw values are retained in detection metadata.
#[derive(Debug, Clone)]
pub(super) struct Detection {
    pub(super) range: Range<usize>,
    pub(super) rule_id: String,
    pub(super) kind: DetectionKind,
}

impl Detection {
    pub(super) fn field(range: Range<usize>) -> Self {
        Self {
            range,
            rule_id: "field.sensitive".into(),
            kind: DetectionKind::SensitiveField,
        }
    }
}

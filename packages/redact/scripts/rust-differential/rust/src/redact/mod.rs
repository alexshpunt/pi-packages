// run.mjs copies rules.rs and text.rs byte for byte from buyong-mcp
// apps/codemap-search/src/redact/ before building; detection.rs keeps only the types they use.
#![allow(dead_code)]
pub mod detection;
mod rules;
mod text;

/// Built-in rule and PEM detections followed by assignment detections, as UTF-8 byte ranges.
pub fn core(source: &str, path: Option<&std::path::Path>) -> Vec<(String, usize, usize)> {
    let mut found: Vec<(String, usize, usize)> = rules::detect(source)
        .into_iter()
        .map(|detection| (detection.rule_id, detection.range.start, detection.range.end))
        .collect();
    found.extend(text::detect(source, path).into_iter().map(|candidate| {
        (
            candidate.detection.rule_id,
            candidate.detection.range.start,
            candidate.detection.range.end,
        )
    }));
    found
}

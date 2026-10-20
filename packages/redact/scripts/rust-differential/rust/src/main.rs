// Rust reference for the differential: run the source's regexes over the generated inputs.
//   pii  <patterns.tsv> <inputs.tsv> <out>  per (input, pattern): search start at every
//        char-boundary cursor, anchored candidate at every start, left boundary per char.
//        Pairs where nothing matched are omitted; the JavaScript side omits the same pairs.
//   core <inputs.tsv> <out>                 built-in rules, PEM and assignment detections.
// Text is hex-encoded UTF-8. Offsets are UTF-8 bytes; the JavaScript side converts its
// UTF-16 offsets before comparing.
mod config;
mod redact;

use regex::{Regex, RegexBuilder};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::Path;

fn unhex(text: &str) -> String {
    let bytes: Vec<u8> = (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect();
    String::from_utf8(bytes).expect("inputs are UTF-8")
}

fn rle(tokens: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let mut end = index + 1;
        while end < tokens.len() && tokens[end] == tokens[index] {
            end += 1;
        }
        let count = end - index;
        parts.push(if count > 1 {
            format!("{}*{}", tokens[index], count)
        } else {
            tokens[index].clone()
        });
        index = end;
    }
    parts.join(",")
}

struct Pattern {
    entity: String,
    search: Regex,
    at_start: Regex,
    after_character: Regex,
    left_boundary: Option<Regex>,
}

// Same builder options and derived expressions as redact/pii/patterns.rs `CompiledRule::new`.
fn compile_pattern(line: &str) -> Pattern {
    let fields: Vec<&str> = line.split('\t').collect();
    let is_case_insensitive = fields[1] == "1";
    let expression = unhex(fields[2]);
    let left_boundary = unhex(fields[3]);
    let is_field_pattern = fields[4] == "1";
    let compile = |pattern: &str| {
        RegexBuilder::new(pattern)
            .case_insensitive(is_case_insensitive)
            .multi_line(true)
            .dot_matches_new_line(true)
            .build()
            .unwrap_or_else(|error| panic!("PII regex {}: {error}", fields[0]))
    };
    Pattern {
        entity: fields[0].to_string(),
        search: compile(&expression.replace(r"\b", "")),
        at_start: compile(&format!(r"\A(?P<pii_candidate>{expression})")),
        after_character: compile(&format!(r"\A.(?P<pii_candidate>{expression})")),
        left_boundary: (!is_field_pattern && !left_boundary.is_empty())
            .then(|| compile(&format!("\\A(?:{})\\z", left_boundary))),
    }
}

fn boundaries(text: &str) -> Vec<usize> {
    text.char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect()
}

fn run_pii(patterns_path: &str, inputs_path: &str, out_path: &str) {
    let patterns: Vec<Pattern> = fs::read_to_string(patterns_path)
        .unwrap()
        .lines()
        .map(compile_pattern)
        .collect();
    let mut out = BufWriter::new(fs::File::create(out_path).unwrap());
    for (text_index, line) in fs::read_to_string(inputs_path).unwrap().lines().enumerate() {
        let (filter, hex) = line.split_once('\t').unwrap();
        let text = unhex(hex);
        let starts = boundaries(&text);
        for (pattern_index, pattern) in patterns.iter().enumerate() {
            if filter != "*" && filter != pattern.entity {
                continue;
            }
            let search: Vec<String> = starts
                .iter()
                .map(|&cursor| {
                    pattern
                        .search
                        .find_at(&text, cursor)
                        .map_or("-".into(), |found| found.start().to_string())
                })
                .collect();
            let anchored: Vec<String> = starts
                .iter()
                .enumerate()
                .map(|(position, _)| {
                    let (offset, regex) = if position == 0 {
                        (0, &pattern.at_start)
                    } else {
                        (starts[position - 1], &pattern.after_character)
                    };
                    regex.captures(&text[offset..]).map_or("-".into(), |captures| {
                        let found = captures
                            .name("secret")
                            .or_else(|| captures.name("pii_candidate"))
                            .unwrap();
                        format!("{}-{}", offset + found.start(), offset + found.end())
                    })
                })
                .collect();
            let left: Vec<String> = match &pattern.left_boundary {
                None => Vec::new(),
                Some(boundary) => starts
                    .windows(2)
                    .map(|pair| {
                        if boundary.is_match(&text[pair[0]..pair[1]]) { "1" } else { "0" }.to_string()
                    })
                    .collect(),
            };
            // Sparse output: skip pairs where nothing matched; both sides skip the same way.
            let is_trivial = search.iter().all(|token| token == "-")
                && anchored.iter().all(|token| token == "-")
                && left.iter().all(|token| token == "0");
            if !is_trivial {
                writeln!(
                    out,
                    "{text_index} {pattern_index} S:{} A:{} L:{}",
                    rle(&search),
                    rle(&anchored),
                    rle(&left)
                )
                .unwrap();
            }
        }
    }
}

fn run_core(inputs_path: &str, out_path: &str) {
    let mut out = BufWriter::new(fs::File::create(out_path).unwrap());
    for (text_index, line) in fs::read_to_string(inputs_path).unwrap().lines().enumerate() {
        let (path, hex) = line.split_once('\t').unwrap();
        let text = unhex(hex);
        let path = (path != "none").then(|| Path::new(path));
        let mut found = redact::core(&text, path);
        found.sort_by(|a, b| (a.1, a.2, &a.0).cmp(&(b.1, b.2, &b.0)));
        let tokens: Vec<String> = found
            .iter()
            .map(|(id, start, end)| format!("{id}:{start}-{end}"))
            .collect();
        writeln!(out, "{text_index} {}", tokens.join(",")).unwrap();
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    match arguments[1].as_str() {
        "pii" => run_pii(&arguments[2], &arguments[3], &arguments[4]),
        "core" => run_core(&arguments[2], &arguments[3]),
        mode => panic!("unknown mode {mode}"),
    }
}

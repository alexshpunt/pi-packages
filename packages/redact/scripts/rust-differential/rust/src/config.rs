// Stub of codemap-search `crate::config` with default settings: no custom rules
// and no extra sensitive fields. `normalize_field` is copied from config/redact.rs.
use std::sync::OnceLock;

pub mod redact {
    pub(crate) fn normalize_field(name: &str) -> String {
        name.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }
}

pub struct Rule {
    pub id: String,
    pub pattern: regex::Regex,
}

pub struct Redact {
    pub sensitive_fields: Vec<String>,
    pub rules: Vec<Rule>,
}

pub struct Config {
    pub redact: Redact,
}

pub fn get() -> &'static Config {
    static CONFIG: OnceLock<Config> = OnceLock::new();
    CONFIG.get_or_init(|| Config {
        redact: Redact {
            sensitive_fields: Vec::new(),
            rules: Vec::new(),
        },
    })
}

//! One response for display, history, export, and speech. The block schema
//! extends the web character chat's speech/narration IR with screen-only artifacts.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseBlock {
    Speech {
        text: String,
        #[serde(default)]
        speaker: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery: Option<String>,
    },
    Narration {
        text: String,
    },
    Artifact {
        text: String,
    },
}

impl ResponseBlock {
    pub fn text(&self) -> &str {
        match self {
            Self::Speech { text, .. } | Self::Narration { text } | Self::Artifact { text } => text,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Response {
    #[serde(default = "response_version")]
    pub version: u8,
    pub blocks: Vec<ResponseBlock>,
}

fn response_version() -> u8 {
    1
}

fn take_marker(text: &str, name: &str) -> (String, Option<String>) {
    let mut rest = text;
    let mut clean = String::new();
    let mut first = None;
    while let Some(start) = rest.find("{{") {
        clean.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let Some(end) = tail.find("}}") else {
            clean.push_str(&rest[start..]);
            return (clean, first);
        };
        let marker = &tail[..end];
        match marker.split_once(':') {
            Some((key, value)) if key.trim().eq_ignore_ascii_case(name) => {
                if first.is_none() && !value.trim().is_empty() {
                    first = Some(value.split_whitespace().collect::<Vec<_>>().join(" "));
                }
            }
            _ => clean.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &tail[end + 2..];
    }
    clean.push_str(rest);
    (clean.trim().to_string(), first)
}

fn parse_structured(raw: &str, direction: Option<&str>) -> Option<Response> {
    let source = raw.trim();
    let json = source
        .strip_prefix("```json\n")
        .and_then(|s| s.strip_suffix("```"))
        .unwrap_or(source)
        .trim();
    let mut response = serde_json::from_str::<Response>(json).ok()?;
    if response.version != 1
        || response.blocks.is_empty()
        || !response.blocks.iter().all(|b| !b.text().trim().is_empty())
    {
        return None;
    }
    for block in &mut response.blocks {
        if let ResponseBlock::Speech { delivery, .. } = block {
            if delivery.as_deref().is_none_or(|s| s.trim().is_empty()) {
                *delivery = direction.map(str::to_string);
            }
        }
    }
    Some(response)
}

pub fn normalize(raw: &str) -> Response {
    // A marker quoted inside a new structured response is user-facing data,
    // especially inside code artifacts. Never run legacy regex-like cleanup
    // over fields of an already valid response.
    if let Some(response) = parse_structured(raw, None) {
        return response;
    }
    let (clean, direction) = take_marker(raw, "VOICE");
    let (clean, legacy_spoken) = take_marker(&clean, "SPEAK");
    if let Some(response) = parse_structured(&clean, direction.as_deref()) {
        return response;
    }
    let mut blocks = Vec::new();
    if let Some(spoken) = legacy_spoken {
        // Legacy summaries must become visible, rather than remaining a
        // second invisible answer. Preserve the complete original below it.
        blocks.push(ResponseBlock::Speech {
            text: spoken,
            speaker: String::new(),
            delivery: direction,
        });
        if !clean.is_empty() && blocks[0].text() != clean {
            blocks.push(ResponseBlock::Artifact { text: clean });
        }
    } else {
        let mut prose = String::new();
        let mut code = String::new();
        let mut fence: Option<(char, usize)> = None;
        for line in clean.lines() {
            let trimmed = line.trim_start();
            if let Some((character, count)) = fence {
                code.push_str(line);
                code.push('\n');
                if trimmed.chars().take_while(|&c| c == character).count() >= count {
                    blocks.push(ResponseBlock::Artifact {
                        text: code.trim_end().to_string(),
                    });
                    code.clear();
                    fence = None;
                }
            } else if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                if !prose.trim().is_empty() {
                    blocks.push(ResponseBlock::Speech {
                        text: prose.trim().to_string(),
                        speaker: String::new(),
                        delivery: direction.clone(),
                    });
                }
                prose.clear();
                let character = trimmed.chars().next().unwrap();
                fence = Some((
                    character,
                    trimmed.chars().take_while(|&c| c == character).count(),
                ));
                code.push_str(line);
                code.push('\n');
            } else {
                prose.push_str(line);
                prose.push('\n');
            }
        }
        if !code.trim().is_empty() {
            blocks.push(ResponseBlock::Artifact {
                text: code.trim_end().to_string(),
            });
        }
        if !prose.trim().is_empty() {
            blocks.push(ResponseBlock::Speech {
                text: prose.trim().to_string(),
                speaker: String::new(),
                delivery: direction,
            });
        }
    }
    Response { version: 1, blocks }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_blocks_and_delivery_survive_history_roundtrip() {
        let raw = r#"{"version":1,"blocks":[{"type":"speech","speaker":"Eve","text":"修正しました。","delivery":"穏やかに"},{"type":"artifact","text":"/tmp/a.html"}]}"#;
        let parsed = normalize(raw);
        assert_eq!(
            serde_json::from_str::<Response>(&serde_json::to_string(&parsed).unwrap()).unwrap(),
            parsed
        );
        assert!(
            matches!(&parsed.blocks[0], ResponseBlock::Speech { delivery: Some(d), .. } if d == "穏やかに")
        );
        assert!(matches!(&parsed.blocks[1], ResponseBlock::Artifact { .. }));
    }

    #[test]
    fn legacy_summary_is_visible_and_original_is_preserved() {
        let response = normalize("{{VOICE: calm}}{{SPEAK: 完了しました。}}変更: /tmp/test.rs");
        assert_eq!(response.blocks[0].text(), "完了しました。");
        assert_eq!(response.blocks[1].text(), "変更: /tmp/test.rs");
        assert!(matches!(
            &response.blocks[1],
            ResponseBlock::Artifact { .. }
        ));
    }

    #[test]
    fn plain_claude_output_keeps_all_prose_and_never_speaks_fenced_code() {
        let raw = format!(
            "{}\n```rust\nfn main() {{}}\n```\n検証済み。",
            "長い説明。".repeat(300)
        );
        let response = normalize(&raw);
        assert_eq!(response.blocks.len(), 3);
        assert!(response.blocks[0].text().chars().count() > 1000);
        assert!(matches!(
            &response.blocks[1],
            ResponseBlock::Artifact { .. }
        ));
        assert_eq!(response.blocks[2].text(), "検証済み。");
    }

    #[test]
    fn invalid_ir_falls_back_without_losing_text() {
        let raw = r#"{"version":2,"blocks":[]}"#;
        assert_eq!(normalize(raw).blocks[0].text(), raw);
    }

    #[test]
    fn structured_artifacts_keep_literal_legacy_markers() {
        let response = normalize(
            r#"{"version":1,"blocks":[{"type":"speech","text":"この記法を使います。"},{"type":"artifact","text":"{{SPEAK: sample}} {{VOICE: calm}}"}]}"#,
        );
        assert_eq!(
            response.blocks[1].text(),
            "{{SPEAK: sample}} {{VOICE: calm}}"
        );
    }

    #[test]
    fn missing_envelope_version_is_accepted_like_the_web_parser() {
        let response = normalize(r#"{"blocks":[{"type":"speech","text":"こんにちは。"}]}"#);
        assert_eq!(response.version, 1);
        assert_eq!(response.blocks[0].text(), "こんにちは。");
    }
}

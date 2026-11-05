//! The same resolved voice and pronunciation plan feeds audio-only and Ditto.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const EVE_DESIGN: &str = "若い成人女性の落ち着いた低声。穏やかな中低音で柔らかな音色、ゆっくり明瞭に、抑制の効いた観測者らしい冷静な口調で話す";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct VoiceConfig {
    pub schema_version: u8,
    pub engine: String,
    pub language: String,
    pub speed: f32,
    pub voxcpm_design: String,
    pub voxcpm_ref_id: String,
    pub voxcpm_seed: Option<i64>,
    pub irodori_caption: String,
    pub irodori_ref_id: String,
    pub irodori_seed: Option<i64>,
    pub voicevox_speaker: i64,
    pub base_instruct: String,
    pub irodori_readings: bool,
    pub reading_overrides: BTreeMap<String, String>,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            engine: "voxcpm".into(),
            language: "ja".into(),
            speed: 1.0,
            voxcpm_design: EVE_DESIGN.into(),
            voxcpm_ref_id: String::new(),
            voxcpm_seed: None,
            irodori_caption: EVE_DESIGN.into(),
            irodori_ref_id: String::new(),
            irodori_seed: None,
            voicevox_speaker: 1,
            base_instruct: String::new(),
            irodori_readings: true,
            reading_overrides: BTreeMap::new(),
        }
    }
}

impl VoiceConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("未対応の音声設定の形式です".into());
        }
        if !matches!(self.engine.as_str(), "voxcpm" | "irodori" | "voicevox") {
            return Err("音声エンジンを選択してください".into());
        }
        if !self.speed.is_finite() || !(0.5..=2.0).contains(&self.speed) {
            return Err("速度は0.5〜2.0で指定してください".into());
        }
        if self.engine == "irodori" && self.language != "ja" {
            return Err("Irodoriは日本語用です。ほかの言語にはVoxCPM2を選んでください".into());
        }
        for id in [&self.voxcpm_ref_id, &self.irodori_ref_id] {
            if id.len() > 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err("参照音声IDが不正です".into());
            }
        }
        if self.voicevox_speaker < 0 || self.reading_overrides.len() > 500 {
            return Err("話者IDまたは読み辞書の件数が不正です".into());
        }
        if [self.voxcpm_seed, self.irodori_seed]
            .into_iter()
            .flatten()
            .any(|s| !(0..=2147483647).contains(&s))
        {
            return Err("シードは0〜2147483647の整数で指定してください".into());
        }
        for (word, reading) in &self.reading_overrides {
            if word.is_empty()
                || word.len() > 100
                || !word.is_ascii()
                || !word.bytes().any(|b| b.is_ascii_alphabetic())
                || reading.trim().is_empty()
                || reading.chars().count() > 100
                || reading
                    .chars()
                    .any(|c| c.is_ascii_alphabetic() || c.is_control())
            {
                return Err(
                    "読み辞書は「英語表記=カナの読み」で指定してください（各100文字まで）".into(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReadingChange {
    pub source: String,
    pub reading: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SpeechPlan {
    pub text: String,
    pub changes: Vec<ReadingChange>,
    pub spelled_words: Vec<String>,
}

const READINGS: &[(&str, &str)] = &[
    ("kotonia", "コトニア"),
    ("desktop", "デスクトップ"),
    ("irodori", "イロドリ"),
    ("voxcpm2", "ボックスシーピーエムツー"),
    ("voxcpm", "ボックスシーピーエム"),
    ("voicevox", "ボイスボックス"),
    ("github", "ギットハブ"),
    ("gitlab", "ギットラボ"),
    ("git", "ギット"),
    ("next.js", "ネクストジェイエス"),
    ("node.js", "ノードジェイエス"),
    ("typescript", "タイプスクリプト"),
    ("javascript", "ジャバスクリプト"),
    ("python", "パイソン"),
    ("rust", "ラスト"),
    ("react", "リアクト"),
    ("tauri", "タウリ"),
    ("cargo", "カーゴ"),
    ("pnpm", "ピーエヌピーエム"),
    ("npm", "エヌピーエム"),
    ("claude", "クロード"),
    ("code", "コード"),
    ("openai", "オープンエーアイ"),
    ("chatgpt", "チャットジーピーティー"),
    ("linux", "リナックス"),
    ("windows", "ウィンドウズ"),
    ("macos", "マックオーエス"),
    ("web", "ウェブ"),
    ("voice", "ボイス"),
    ("design", "デザイン"),
    ("avatar", "アバター"),
    ("profile", "プロフィール"),
    ("session", "セッション"),
    ("history", "ヒストリー"),
    ("stream", "ストリーム"),
    ("streaming", "ストリーミング"),
    ("test", "テスト"),
    ("tests", "テスト"),
    ("build", "ビルド"),
    ("check", "チェック"),
    ("fix", "フィックス"),
    ("error", "エラー"),
    ("server", "サーバー"),
    ("client", "クライアント"),
    ("backend", "バックエンド"),
    ("frontend", "フロントエンド"),
    ("branch", "ブランチ"),
    ("commit", "コミット"),
    ("push", "プッシュ"),
    ("pull", "プル"),
    ("request", "リクエスト"),
    ("merge", "マージ"),
    ("cache", "キャッシュ"),
    ("token", "トークン"),
    ("prompt", "プロンプト"),
    ("model", "モデル"),
    ("seed", "シード"),
    ("caption", "キャプション"),
    ("audio", "オーディオ"),
    ("speech", "スピーチ"),
    ("file", "ファイル"),
    ("path", "パス"),
    ("local", "ローカル"),
    ("hello", "ハロー"),
    ("world", "ワールド"),
    ("eve", "イヴ"),
    ("api", "エーピーアイ"),
    ("ui", "ユーアイ"),
    ("ux", "ユーエックス"),
    ("tts", "ティーティーエス"),
    ("stt", "エスティーティー"),
    ("asr", "エーエスアール"),
    ("llm", "エルエルエム"),
    ("gpu", "ジーピーユー"),
    ("cpu", "シーピーユー"),
    ("url", "ユーアールエル"),
    ("json", "ジェイソン"),
    ("html", "エイチティーエムエル"),
    ("css", "シーエスエス"),
    ("sql", "エスキューエル"),
    ("http", "エイチティーティーピー"),
    ("https", "エイチティーティーピーエス"),
    ("pr", "ピーアール"),
    ("ok", "オーケー"),
    ("id", "アイディー"),
    ("ai", "エーアイ"),
    ("gb", "ギガバイト"),
    ("mb", "メガバイト"),
    ("c++", "シープラスプラス"),
    ("c#", "シーシャープ"),
];
const LETTERS: [&str; 26] = [
    "エー",
    "ビー",
    "シー",
    "ディー",
    "イー",
    "エフ",
    "ジー",
    "エイチ",
    "アイ",
    "ジェイ",
    "ケー",
    "エル",
    "エム",
    "エヌ",
    "オー",
    "ピー",
    "キュー",
    "アール",
    "エス",
    "ティー",
    "ユー",
    "ブイ",
    "ダブリュー",
    "エックス",
    "ワイ",
    "ゼット",
];

pub fn plan(text: &str, voice: &VoiceConfig) -> Result<SpeechPlan, String> {
    voice.validate()?;
    if text.trim().is_empty() {
        return Err("空文字は読めません".into());
    }
    let mut result = SpeechPlan {
        text: text.to_string(),
        changes: Vec::new(),
        spelled_words: Vec::new(),
    };
    if voice.engine != "irodori" || !voice.irodori_readings {
        return Ok(result);
    }
    // Normalize full-width ASCII only for speech, preserving the source blocks.
    let source: String = text
        .chars()
        .map(|c| match c as u32 {
            0xff01..=0xff5e => char::from_u32(c as u32 - 0xfee0).unwrap(),
            _ => c,
        })
        .collect();
    let mut dictionary: Vec<(String, String)> = READINGS
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    for (key, value) in &voice.reading_overrides {
        dictionary.retain(|(k, _)| !k.eq_ignore_ascii_case(key));
        dictionary.push((key.to_string(), value.to_string()));
    }
    dictionary.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.0.cmp(&b.0)));
    let mut output = String::new();
    let mut index = 0;
    while index < source.len() {
        let rest = &source[index..];
        let ch = rest.chars().next().unwrap();
        if !ch.is_ascii_alphabetic() {
            output.push(ch);
            index += ch.len_utf8();
            continue;
        }
        let known = dictionary.iter().find(|(key, _)| {
            rest.get(..key.len())
                .is_some_and(|s| s.eq_ignore_ascii_case(key))
                && !rest
                    .as_bytes()
                    .get(key.len())
                    .is_some_and(u8::is_ascii_alphanumeric)
        });
        let (word, reading, spelled) = if let Some((key, value)) = known {
            (rest[..key.len()].to_string(), value.to_string(), false)
        } else {
            let end = rest
                .bytes()
                .take_while(|c| c.is_ascii_alphanumeric())
                .count();
            let word = &rest[..end];
            let reading: String = word
                .chars()
                .map(|c| {
                    if c.is_ascii_alphabetic() {
                        LETTERS[(c.to_ascii_lowercase() as u8 - b'a') as usize].to_string()
                    } else {
                        c.to_string()
                    }
                })
                .collect();
            (word.to_string(), reading, true)
        };
        output.push_str(&reading);
        index += word.len();
        if !result.changes.iter().any(|c| c.source == word) {
            result.changes.push(ReadingChange {
                source: word.clone(),
                reading,
            });
        }
        if spelled && !result.spelled_words.contains(&word) {
            result.spelled_words.push(word);
        }
    }
    result.text = output;
    Ok(result)
}

fn optional(text: &str) -> Option<&str> {
    (!text.trim().is_empty()).then(|| text.trim())
}

pub fn audio_body(text: &str, direction: Option<&str>, voice: &VoiceConfig) -> Value {
    let instruct = [
        optional(&voice.base_instruct),
        direction.map(str::trim).filter(|s| !s.is_empty()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let caption = [
        optional(&voice.irodori_caption),
        direction.map(str::trim).filter(|s| !s.is_empty()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("。");
    let mut body = json!({"input": text, "engine": voice.engine, "language": voice.language, "speed": voice.speed});
    match voice.engine.as_str() {
        "irodori" => {
            body["voice"] = json!(optional(&caption));
            body["ref_id"] = json!(optional(&voice.irodori_ref_id));
            body["seed"] = json!(voice.irodori_seed);
            body["num_steps"] = json!(20);
        }
        "voicevox" => {
            body["voice"] = json!(voice.voicevox_speaker.to_string());
        }
        _ => {
            body["voice"] = json!(optional(&voice.voxcpm_design));
            body["ref_id"] = json!(optional(&voice.voxcpm_ref_id));
            body["seed"] = json!(voice.voxcpm_seed);
            body["instruct"] = json!(optional(&instruct));
        }
    }
    body
}

pub fn avatar_body(
    text: &str,
    direction: Option<&str>,
    voice: &VoiceConfig,
    avatar_id: &str,
) -> Value {
    let audio = audio_body(text, direction, voice);
    let mut body = json!({"text": text, "avatar_id": avatar_id, "tts_backend": voice.engine,
        "language": voice.language, "lang": voice.language, "speed": voice.speed, "fps": 25});
    match voice.engine.as_str() {
        "irodori" => {
            body["caption"] = audio["voice"].clone();
            body["ref_id"] = audio["ref_id"].clone();
            body["seed"] = audio["seed"].clone();
            body["num_steps"] = audio["num_steps"].clone();
        }
        "voicevox" => {
            body["speaker"] = json!(voice.voicevox_speaker);
        }
        _ => {
            body["design"] = audio["voice"].clone();
            body["voxcpm_ref_id"] = audio["ref_id"].clone();
            body["seed"] = audio["seed"].clone();
            body["instruct"] = audio["instruct"].clone();
        }
    }
    body
}

/// Respect the API limit after reading conversion, without dropping the tail.
pub fn split_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut start = 0;
    while start < chars.len() {
        let limit = (start + 3500).min(chars.len());
        let end = if limit < chars.len() {
            (start + 1..limit)
                .rev()
                .find(|&i| matches!(chars[i - 1], '。' | '！' | '？' | '\n' | ' '))
                .unwrap_or(limit)
        } else {
            limit
        };
        chunks.push(chars[start..end].iter().collect());
        start = end;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn irodori_reads_known_names_and_custom_names_without_rewriting_meaning() {
        let mut voice = VoiceConfig {
            engine: "irodori".into(),
            ..Default::default()
        };
        voice
            .reading_overrides
            .insert("MyTool".into(), "マイツール".into());
        let p = plan("GitHubとNext.jsのAPIをMyToolで確認。", &voice).unwrap();
        assert_eq!(
            p.text,
            "ギットハブとネクストジェイエスのエーピーアイをマイツールで確認。"
        );
        assert!(p.spelled_words.is_empty());
        assert_eq!(p.changes.len(), 4);
    }
    #[test]
    fn unknown_words_are_spelled_explicitly_and_dictionary_does_not_match_substrings() {
        let voice = VoiceConfig {
            engine: "irodori".into(),
            ..Default::default()
        };
        let p = plan("APITableとXYZ。ＧＰＵは2台。", &voice).unwrap();
        assert_eq!(p.spelled_words, vec!["APITable", "XYZ"]);
        assert!(p.text.contains("ジーピーユーは2台"));
        assert!(!p.text.chars().any(|c| c.is_ascii_alphabetic()));
    }
    #[test]
    fn other_engines_and_opt_out_preserve_english() {
        assert_eq!(
            plan("GitHub", &VoiceConfig::default()).unwrap().text,
            "GitHub"
        );
        let voice = VoiceConfig {
            engine: "irodori".into(),
            irodori_readings: false,
            ..Default::default()
        };
        assert_eq!(plan("GitHub", &voice).unwrap().text, "GitHub");
    }
    #[test]
    fn both_transports_use_the_same_voice_direction_reference_and_seed() {
        for engine in ["irodori", "voxcpm", "voicevox"] {
            let voice = VoiceConfig {
                engine: engine.into(),
                irodori_ref_id: "iro_voice".into(),
                voxcpm_ref_id: "vox_voice".into(),
                irodori_seed: Some(42),
                voxcpm_seed: Some(99),
                ..Default::default()
            };
            let a = audio_body("台詞", Some("明るく"), &voice);
            let b = avatar_body("台詞", Some("明るく"), &voice, "eve");
            assert_eq!(a["input"], b["text"]);
            assert_eq!(a["speed"], b["speed"]);
            if engine == "irodori" {
                assert_eq!(a["voice"], b["caption"]);
                assert_eq!(a["ref_id"], b["ref_id"]);
                assert_eq!(a["seed"], b["seed"]);
            }
            if engine == "voxcpm" {
                assert_eq!(a["voice"], b["design"]);
                assert_eq!(a["instruct"], b["instruct"]);
                assert_eq!(a["ref_id"], b["voxcpm_ref_id"]);
                assert_eq!(a["seed"], b["seed"]);
            }
        }
    }
    #[test]
    fn splitting_keeps_every_character_even_after_expansion() {
        let original = "とても長い説明です。".repeat(1000);
        let chunks = split_text(&original);
        assert!(chunks.iter().all(|s| s.chars().count() <= 3500));
        assert_eq!(chunks.concat(), original);
    }
}

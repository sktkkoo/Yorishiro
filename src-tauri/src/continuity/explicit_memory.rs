//! 明示的な「覚えておいて」はモデルの整理判断より先に原文を保存する。
use super::types::{ExplicitMemory, Snapshot};

fn requests_memory(content: &str) -> bool {
    let normalized = content.to_lowercase().replace('’', "'");
    normalized
        .split(['。', '！', '？', '.', '!', '?', '\n', ';', '；'])
        .any(|sentence| {
            let negative = [
                "覚えないで",
                "覚えなくて",
                "覚えておかなくて",
                "覚えておいてほしくない",
                "覚えておいて欲しくない",
                "覚えておいてほしくありません",
                "覚えていてほしくない",
                "覚えていて欲しくない",
                "記憶しないで",
                "記憶しなくて",
                "don't remember",
                "do not remember",
                "stop remembering",
            ]
            .iter()
            .any(|phrase| sentence.contains(phrase));
            !negative
                && [
                    "覚えておいて",
                    "覚えといて",
                    "覚えていて",
                    "覚えてほしい",
                    "覚えて欲しい",
                    "記憶しておいて",
                    "記憶しといて",
                    "記憶して",
                    "忘れないで",
                    "please remember",
                    "remember that",
                    "remember this",
                    "keep in mind",
                    "don't forget",
                    "do not forget",
                ]
                .iter()
                .any(|phrase| sentence.contains(phrase))
        })
}

/// 入力の追加直後に呼ぶ。元発言の role/source はホストが決め、モデルには変更させない。
/// 「それを覚えて」の参照先を失わないよう、直前の相手の発言と続く返信も根拠として残す。
/// 根拠は事実認定や実行許可ではなく、利用時に読み直す必要のある原文である。
pub(super) fn capture(snapshot: &mut Snapshot, message_id: &str) -> bool {
    // 通常は末尾へ追加した直後なので、全会話を走査せず新しい発言だけを調べる。
    let Some(index) = snapshot
        .messages
        .iter()
        .rposition(|message| message.id == message_id)
    else {
        return false;
    };
    let message = &snapshot.messages[index];
    if message.role != "user"
        || !matches!(
            message.source.as_str(),
            "conversation" | "voice" | "external"
        )
        || !requests_memory(&message.content)
    {
        return false;
    }
    if snapshot
        .explicit_memories
        .iter()
        .any(|memory| memory.request_message_id == message_id)
    {
        return false;
    }
    let start = snapshot.messages[..index]
        .iter()
        .rposition(|message| message.role == "user" && message.source != "legacy")
        .unwrap_or(index.saturating_sub(1));
    let source_ids = snapshot.messages[start..=index]
        .iter()
        .filter(|message| {
            message.source != "legacy" && matches!(message.role.as_str(), "user" | "assistant")
        })
        .map(|message| message.id.clone())
        .collect();
    snapshot.explicit_memories.push(ExplicitMemory {
        request_message_id: message_id.into(),
        source_ids,
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity::{retention, storage, types::Saved};
    use serde_json::json;

    fn fixture(messages: &[(&str, &str, &str)]) -> Saved {
        serde_json::from_value(json!({
            "version":1,"snapshot":{
                "personaId":"test","revision":0,"phase":"idle",
                "messages":messages.iter().map(|(id,role,content)| json!({
                    "id":id,"role":role,"content":content,"createdAt":1,"source":"voice"
                })).collect::<Vec<_>>(),
                "understandings":[],"drafts":[],"reflections":[],
                "error":null,"lastObservedAt":null
            }
        }))
        .unwrap()
    }

    #[test]
    fn explicit_request_and_its_original_context_survive_retirement_and_roundtrip() {
        let mut saved = fixture(&[
            ("discard", "assistant", "Ancient chatter"),
            ("context", "user", "朝は日本語で短く話してほしい"),
            ("reply", "assistant", "朝は短く、日本語で話すね"),
            ("remember", "user", "うん、それを覚えておいて"),
            ("latest", "user", "今日の話をしよう"),
        ]);
        assert!(capture(&mut saved.snapshot, "remember"));
        assert!(!capture(&mut saved.snapshot, "remember"));
        assert_eq!(
            saved.snapshot.explicit_memories[0].source_ids,
            ["context", "reply", "remember"]
        );
        saved.retired_message_ids = saved
            .snapshot
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        let encoded = serde_json::to_vec(&saved).unwrap();
        let decoded: Saved = serde_json::from_slice(&encoded).unwrap();
        let home = tempfile::tempdir().unwrap();
        storage::save(home.path(), &decoded).unwrap();
        let mut restored = storage::load(home.path(), "test").unwrap();
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        assert_eq!(
            restored.snapshot.explicit_memories,
            saved.snapshot.explicit_memories
        );
        assert_eq!(
            retention::compact(
                &mut restored,
                retention::MAX_MESSAGE_AGE_MS + 2,
                false,
                false
            )
            .removed_messages,
            1
        );
        assert_eq!(
            restored
                .snapshot
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["context", "reply", "remember", "latest"]
        );
        assert_eq!(
            restored.snapshot.messages[2].content,
            "うん、それを覚えておいて"
        );
    }

    #[test]
    fn only_actual_user_requests_create_explicit_memory() {
        let mut saved = fixture(&[
            ("assistant", "assistant", "これを覚えておいて"),
            ("negative", "user", "これは覚えておいてほしくない"),
            ("english-negative", "user", "Please do not remember this"),
            ("legacy", "user", "これを覚えておいて"),
            (
                "action",
                "user",
                "草案「これを覚えておいて」の続きを考えて。",
            ),
        ]);
        saved.snapshot.messages[3].source = "legacy".into();
        saved.snapshot.messages[4].source = "draft-action".into();
        for id in [
            "assistant",
            "negative",
            "english-negative",
            "legacy",
            "action",
            "absent",
        ] {
            assert!(!capture(&mut saved.snapshot, id), "{id}");
        }
        assert!(saved.snapshot.explicit_memories.is_empty());
    }

    #[test]
    fn common_japanese_and_english_requests_are_recognized_without_model_output() {
        for text in [
            "私は朝型。覚えておいてね",
            "これは覚えといて",
            "私は紅茶が好きだと覚えてほしい",
            "これを覚えて欲しい",
            "それを覚えていてね",
            "誕生日を忘れないでいてね",
            "誕生日を記憶しておいて",
            "忘れないでね",
            "Please remember I prefer tea",
            "Remember that I prefer tea",
            "Keep in mind that I prefer tea",
        ] {
            let mut saved = fixture(&[("request", "user", text)]);
            assert!(capture(&mut saved.snapshot, "request"), "{text}");
            assert_eq!(saved.snapshot.explicit_memories[0].source_ids, ["request"]);
        }
    }
}

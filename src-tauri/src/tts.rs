// src-tauri/src/tts.rs

use base64::Engine as _;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;
use tempfile::NamedTempFile;

/// 再生中の TTS プロセスを管理する state。
/// 同時発話は 1 つだけ（新しい speak が来たら前のを kill）。
pub struct TtsState {
    child: Mutex<Option<Child>>,
}

impl TtsState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// OS に応じた TTS コマンドを組み立てる。未対応 OS では None。
fn build_tts_command(text: &str, voice: Option<&str>) -> Option<Command> {
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("say");
        if let Some(v) = voice {
            cmd.arg("-v").arg(v);
        }
        cmd.arg("--").arg(text);
        Some(cmd)
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("powershell");
        cmd.arg("-NoProfile").arg("-Command");
        let escaped = text.replace('\'', "''");
        let ps_script = if let Some(v) = voice {
            let v_escaped = v.replace('\'', "''");
            format!(
                "Add-Type -AssemblyName System.Speech; \
                 $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
                 $s.SelectVoice('{}'); $s.Speak('{}')",
                v_escaped, escaped
            )
        } else {
            format!(
                "Add-Type -AssemblyName System.Speech; \
                 (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{}')",
                escaped
            )
        };
        cmd.arg(&ps_script);
        Some(cmd)
    } else {
        None
    }
}

fn stop_inner(state: &TtsState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn tts_speak(
    state: State<'_, TtsState>,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    stop_inner(&state);
    if let Some(mut cmd) = build_tts_command(&text, voice.as_deref()) {
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        *state.child.lock().unwrap() = Some(child);
    }
    Ok(())
}

#[tauri::command]
pub fn tts_stop(state: State<'_, TtsState>) -> Result<(), String> {
    stop_inner(&state);
    Ok(())
}

/// テキストから WAV 音声を合成し、base64 文字列で返す。
/// フロントエンド側で decodeAudioData → Web Audio 再生する。
///
/// macOS の `say` は /dev/stdout への出力をサポートしないため、
/// tmpfile 経由で WAV を取得する。tmpfile は読み取り後自動削除。
#[tauri::command]
pub fn tts_synthesize(text: String, voice: Option<String>) -> Result<String, String> {
    if cfg!(target_os = "macos") {
        synthesize_macos(&text, voice.as_deref())
    } else if cfg!(target_os = "windows") {
        synthesize_windows(&text, voice.as_deref())
    } else {
        Err("TTS synthesize: unsupported platform".to_string())
    }
}

fn synthesize_macos(text: &str, voice: Option<&str>) -> Result<String, String> {
    // say は出力先を新規作成するため、先に空ファイルを消しておく。
    // .wav suffix 必須 — say は拡張子なしファイルに .wav を自動付与するため、
    // suffix なしだと読み取り先とずれて ENOENT になる。
    let raw_tmp = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .map_err(|e| format!("tmpfile: {}", e))?;
    let raw_path = raw_tmp.path().to_owned();
    drop(raw_tmp);

    let mut cmd = Command::new("say");
    if let Some(v) = voice {
        cmd.arg("-v").arg(v);
    }
    cmd.arg("-o")
        .arg(&raw_path)
        .arg("--file-format=WAVE")
        .arg("--data-format=LEI16@24000")
        .arg("--")
        .arg(text);
    cmd.stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| format!("say: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("say failed: {}", stderr));
    }

    // macOS say は FLLR チャンクを含む WAV を出力する。
    // WebKit の decodeAudioData はこれをパースできないため除去する。
    let raw_wav = std::fs::read(&raw_path).map_err(|e| format!("read wav: {}", e))?;
    let _ = std::fs::remove_file(&raw_path);
    if raw_wav.is_empty() {
        return Err(format!("say produced empty file at {:?}", raw_path));
    }
    let wav = strip_fllr_chunk(&raw_wav);
    Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
}

fn strip_fllr_chunk(wav: &[u8]) -> Vec<u8> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return wav.to_vec();
    }

    let mut stripped = Vec::with_capacity(wav.len());
    stripped.extend_from_slice(&wav[..12]);

    let mut offset = 12;
    while offset + 8 <= wav.len() {
        let chunk_start = offset;
        let chunk_id = &wav[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            wav[offset + 4],
            wav[offset + 5],
            wav[offset + 6],
            wav[offset + 7],
        ]) as usize;
        offset += 8;

        let padded_size = chunk_size + (chunk_size % 2);
        let chunk_end = match offset.checked_add(padded_size) {
            Some(end) if end <= wav.len() => end,
            _ => return wav.to_vec(),
        };

        if chunk_id != b"FLLR" {
            stripped.extend_from_slice(&wav[chunk_start..chunk_end]);
        }

        offset = chunk_end;
    }

    if offset != wav.len() {
        return wav.to_vec();
    }

    let riff_size = (stripped.len() - 8) as u32;
    stripped[4..8].copy_from_slice(&riff_size.to_le_bytes());
    stripped
}

fn synthesize_windows(text: &str, voice: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile").arg("-Command");
    let escaped = text.replace('\'', "''");
    let ps_script = if let Some(v) = voice {
        let v_escaped = v.replace('\'', "''");
        format!(
            "Add-Type -AssemblyName System.Speech; \
             $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             $s.SelectVoice('{}'); \
             $ms = New-Object System.IO.MemoryStream; \
             $s.SetOutputToWaveStream($ms); \
             $s.Speak('{}'); \
             [Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)",
            v_escaped, escaped
        )
    } else {
        format!(
            "Add-Type -AssemblyName System.Speech; \
             $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             $ms = New-Object System.IO.MemoryStream; \
             $s.SetOutputToWaveStream($ms); \
             $s.Speak('{}'); \
             [Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)",
            escaped
        )
    };
    cmd.arg(&ps_script);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| format!("powershell: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("TTS failed: {}", stderr));
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::strip_fllr_chunk;

    fn riff_with_chunks(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&0u32.to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        for (id, data) in chunks {
            wav.extend_from_slice(*id);
            wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
            wav.extend_from_slice(data);
            if data.len() % 2 == 1 {
                wav.push(0);
            }
        }

        let riff_size = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&riff_size.to_le_bytes());
        wav
    }

    #[test]
    fn strips_fllr_chunk_and_updates_riff_size() {
        let wav = riff_with_chunks(&[
            (b"fmt ", &[1, 2, 3, 4]),
            (b"FLLR", &[9, 9, 9]),
            (b"data", &[5, 6]),
        ]);

        let stripped = strip_fllr_chunk(&wav);

        assert_eq!(&stripped[0..4], b"RIFF");
        assert_eq!(&stripped[8..12], b"WAVE");
        assert_eq!(
            u32::from_le_bytes(stripped[4..8].try_into().unwrap()) as usize,
            stripped.len() - 8
        );
        assert_eq!(
            stripped,
            riff_with_chunks(&[(b"fmt ", &[1, 2, 3, 4]), (b"data", &[5, 6])])
        );
    }

    #[test]
    fn leaves_invalid_or_chunk_truncated_input_unchanged() {
        assert_eq!(strip_fllr_chunk(b"not a wav"), b"not a wav");

        let mut truncated = riff_with_chunks(&[(b"FLLR", &[1, 2, 3, 4])]);
        truncated.pop();
        assert_eq!(strip_fllr_chunk(&truncated), truncated);
    }
}

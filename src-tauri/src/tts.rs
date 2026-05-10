// src-tauri/src/tts.rs

use base64::Engine as _;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

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
#[tauri::command]
pub fn tts_synthesize(text: String, voice: Option<String>) -> Result<String, String> {
    let output = build_synth_command(&text, voice.as_deref())
        .ok_or_else(|| "TTS synthesize: unsupported platform".to_string())?
        .output()
        .map_err(|e| format!("TTS synthesize: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("TTS synthesize failed: {}", stderr));
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&output.stdout))
}

/// 音声合成 → stdout に WAV を出力するコマンドを組み立てる。
fn build_synth_command(text: &str, voice: Option<&str>) -> Option<Command> {
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("say");
        if let Some(v) = voice {
            cmd.arg("-v").arg(v);
        }
        cmd.arg("-o")
            .arg("/dev/stdout")
            .arg("--file-format=WAVE")
            .arg("--data-format=LEI16@24000")
            .arg("--")
            .arg(text);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
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
        Some(cmd)
    } else {
        None
    }
}

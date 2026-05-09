// src-tauri/src/tts.rs

use std::process::{Child, Command};
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

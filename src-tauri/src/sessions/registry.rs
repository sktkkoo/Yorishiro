//! SessionRegistry — Rust 側 session の descriptor + lifecycle / activity 状態と
//! PtySession (実 PTY) を一元管理する。
//!
//! TS 側 `src/runtime/sessions/session-registry.ts` と semantics を mirror する
//! が、Rust 側のみ PtySession (PTY resource lifecycle) も保持する。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

// API surface の一部は A-5 (session_list 等の Tauri command) と Phase B
// (OSC 133 listener / set_activity wire) で初めて呼ばれる。それまでの
// transient state を allow(dead_code) で許容する。
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::pty_session::{AgentSelectedConversation, PtySession};
use super::types::{SessionActivity, SessionDescriptor, SessionEvent, SessionId, SessionLifecycle};

type Listener = Box<dyn Fn(&SessionEvent) + Send + Sync>;

/// Webview lifetime singleton。Tauri の `manage` 経由で AppHandle.state で取る。
pub struct SessionRegistry {
    inner: Mutex<RegistryInner>,
}

struct RegistryInner {
    /// Insertion order を保持する id 列。list() の安定 ordering と remove 時の
    /// 順序維持に使う。
    order: Vec<SessionId>,
    descriptors: HashMap<SessionId, SessionDescriptor>,
    lifecycles: HashMap<SessionId, SessionLifecycle>,
    activities: HashMap<SessionId, SessionActivity>,
    /// 実 PTY resource。`attach_pty` で結ばれ、`remove` で drop される。
    /// metadata-only session は entry を持たない。
    pty_sessions: HashMap<SessionId, Arc<PtySession>>,
    listeners: Vec<Listener>,
    /// `kill_all_pty_sessions`（app 終了時 teardown）後に立つ。以降の
    /// attach を拒否し、in-flight な spawn が drain 後に attach して
    /// sidecar ごと leak するのを防ぐ（issue #109）。
    closing: bool,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner {
                order: Vec::new(),
                descriptors: HashMap::new(),
                lifecycles: HashMap::new(),
                activities: HashMap::new(),
                pty_sessions: HashMap::new(),
                listeners: Vec::new(),
                closing: false,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 同 id の add は no-op（idempotent）。
    pub fn add(&self, descriptor: SessionDescriptor) {
        let mut guard = self.lock();
        if guard.descriptors.contains_key(&descriptor.id) {
            return;
        }
        let id = descriptor.id.clone();
        guard.order.push(id.clone());
        guard
            .lifecycles
            .insert(id.clone(), SessionLifecycle::Starting);
        guard.activities.insert(id.clone(), SessionActivity::Idle);
        guard.descriptors.insert(id, descriptor.clone());
        let event = SessionEvent::SessionAdded { descriptor };
        Self::emit(&guard.listeners, &event);
    }

    /// 存在しない id の remove は no-op で false を返す。Arc<PtySession> が
    /// 結ばれていれば外す（caller が事前に kill() を呼んでおく前提；ここで
    /// は単に Arc を drop して資源解放は PtySession::Drop に任せる）。
    pub fn remove(&self, id: &str) -> bool {
        let mut guard = self.lock();
        if guard.descriptors.remove(id).is_none() {
            return false;
        }
        guard.lifecycles.remove(id);
        guard.activities.remove(id);
        guard.pty_sessions.remove(id);
        guard.order.retain(|existing| existing != id);
        let event = SessionEvent::SessionRemoved { id: id.to_string() };
        Self::emit(&guard.listeners, &event);
        true
    }

    /// 既存 metadata に Arc<PtySession> を結ぶ。同 id への再 attach は新しい
    /// PtySession で上書きする（caller が事前に旧 session を kill する想定）。
    /// app 終了 teardown 後（closing）は登録せず即 kill する。
    pub fn attach_pty(&self, id: &str, session: Arc<PtySession>) {
        let closing = {
            let mut guard = self.lock();
            if !guard.descriptors.contains_key(id) {
                return;
            }
            if !guard.closing {
                guard.pty_sessions.insert(id.to_string(), session.clone());
            }
            guard.closing
        };
        if closing {
            let _ = session.kill();
        }
    }

    pub fn get_pty_session(&self, id: &str) -> Option<Arc<PtySession>> {
        self.lock().pty_sessions.get(id).cloned()
    }

    /// hook acceptance と replace snapshot が同じ registry lock 上で全順序になるようにする。
    /// true を返した signal の SessionStart selection は、後続の detach snapshot に必ず入る。
    pub fn accept_hook_signal(
        &self,
        id: &str,
        hook_launch_id: &str,
        provider_session_id: Option<&str>,
    ) -> bool {
        let guard = self.lock();
        let Some(session) = guard.pty_sessions.get(id) else {
            return false;
        };
        if !session.matches_hook_launch(hook_launch_id) {
            return false;
        }
        if let Some(provider_session_id) = provider_session_id {
            session.record_hook_selected_conversation(hook_launch_id, provider_session_id);
        }
        true
    }

    /// 旧 launch を hook routing から先に外し、その同じ境界で confirmed selection を取る。
    /// accept_hook_signal と registry lock を共有するため、signal は「snapshotへ含まれる」か
    /// 「staleとして拒否される」のどちらかになり、両方から脱落しない。
    pub fn detach_pty_with_selected_conversation(
        &self,
        id: &str,
    ) -> Option<(Arc<PtySession>, Option<AgentSelectedConversation>)> {
        let mut guard = self.lock();
        let session = guard.pty_sessions.remove(id)?;
        let selection = session.realtime_selected_thread();
        Some((session, selection))
    }

    /// App 終了時の teardown。全 PtySession を drain して kill し、以降の
    /// attach を拒否する（closing）。Tauri managed state の Drop は process
    /// exit では走らないため、`RunEvent::Exit` から明示的に呼ばないと codex
    /// app-server sidecar が orphan として leak する（issue #109）。kill 中に
    /// reader thread が registry を触れるよう、registry lock は drain 後すぐ
    /// 手放す。
    pub fn kill_all_pty_sessions(&self) {
        let sessions: Vec<Arc<PtySession>> = {
            let mut guard = self.lock();
            guard.closing = true;
            guard.pty_sessions.drain().map(|(_, s)| s).collect()
        };
        for session in sessions {
            let _ = session.kill();
        }
    }

    pub fn get(&self, id: &str) -> Option<SessionDescriptor> {
        self.lock().descriptors.get(id).cloned()
    }

    pub fn list(&self) -> Vec<SessionDescriptor> {
        let guard = self.lock();
        guard
            .order
            .iter()
            .filter_map(|id| guard.descriptors.get(id).cloned())
            .collect()
    }

    pub fn get_lifecycle(&self, id: &str) -> Option<SessionLifecycle> {
        self.lock().lifecycles.get(id).copied()
    }

    pub fn get_activity(&self, id: &str) -> Option<SessionActivity> {
        self.lock().activities.get(id).copied()
    }

    /// 未登録 id への set は no-op。値が変わらない set も no-op（noise event 抑制）。
    pub fn set_lifecycle(&self, id: &str, lifecycle: SessionLifecycle) {
        let mut guard = self.lock();
        if !guard.descriptors.contains_key(id) {
            return;
        }
        if guard.lifecycles.get(id) == Some(&lifecycle) {
            return;
        }
        guard.lifecycles.insert(id.to_string(), lifecycle);
        let event = SessionEvent::SessionLifecycleChanged {
            id: id.to_string(),
            lifecycle,
        };
        Self::emit(&guard.listeners, &event);
    }

    pub fn set_activity(&self, id: &str, activity: SessionActivity) {
        let mut guard = self.lock();
        if !guard.descriptors.contains_key(id) {
            return;
        }
        if guard.activities.get(id) == Some(&activity) {
            return;
        }
        guard.activities.insert(id.to_string(), activity);
        let event = SessionEvent::SessionActivityChanged {
            id: id.to_string(),
            activity,
        };
        Self::emit(&guard.listeners, &event);
    }

    pub fn set_cwd(&self, id: &str, cwd: String) {
        let mut guard = self.lock();
        let Some(descriptor) = guard.descriptors.get_mut(id) else {
            return;
        };
        if descriptor.display_cwd.as_deref() == Some(cwd.as_str()) {
            return;
        }
        descriptor.display_cwd = Some(cwd.clone());
        let event = SessionEvent::SessionCwdChanged {
            id: id.to_string(),
            cwd,
        };
        Self::emit(&guard.listeners, &event);
    }

    /// 全 event を購読する。Listener は `Send + Sync` 必須（複数 thread から
    /// 呼ばれる前提）。Phase A では unsubscribe API は提供しない（registry は
    /// webview lifetime singleton で listener も基本永続のため）。
    pub fn on(&self, listener: Listener) {
        self.lock().listeners.push(listener);
    }

    fn emit(listeners: &[Listener], event: &SessionEvent) {
        for listener in listeners {
            listener(event);
        }
    }
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::SessionKind;
    use super::*;

    fn make_descriptor(id: &str) -> SessionDescriptor {
        SessionDescriptor {
            id: id.to_string(),
            profile_id: "shell".to_string(),
            kind: SessionKind::Shell,
            label: id.to_string(),
            cwd: None,
            display_cwd: None,
            started_at: 0,
        }
    }

    #[test]
    fn kill_all_drains_attached_sessions() {
        let reg = Arc::new(SessionRegistry::new());
        reg.add(make_descriptor("a"));
        let session = Arc::new(PtySession::new("a".to_string(), Arc::clone(&reg)));
        reg.attach_pty("a", session);
        assert!(reg.get_pty_session("a").is_some());

        reg.kill_all_pty_sessions();
        assert!(reg.get_pty_session("a").is_none());
    }

    #[test]
    fn attach_after_kill_all_is_rejected() {
        // app 終了 teardown 後に in-flight spawn が attach しても登録されない
        // （sidecar leak 防止、issue #109）。
        let reg = Arc::new(SessionRegistry::new());
        reg.add(make_descriptor("a"));
        reg.kill_all_pty_sessions();

        let session = Arc::new(PtySession::new("a".to_string(), Arc::clone(&reg)));
        reg.attach_pty("a", session);
        assert!(reg.get_pty_session("a").is_none());
    }

    #[test]
    fn concurrent_hook_acceptance_is_either_snapshotted_or_rejected_at_detach() {
        use std::sync::Barrier;

        for _ in 0..256 {
            let reg = Arc::new(SessionRegistry::new());
            reg.add(make_descriptor("a"));
            let session = Arc::new(PtySession::new("a".to_string(), Arc::clone(&reg)));
            let launch_id = session.hook_launch_id().to_string();
            reg.attach_pty("a", session);

            let barrier = Arc::new(Barrier::new(2));
            let hook_reg = Arc::clone(&reg);
            let hook_barrier = Arc::clone(&barrier);
            let hook_launch_id = launch_id.clone();
            let hook = std::thread::spawn(move || {
                hook_barrier.wait();
                hook_reg.accept_hook_signal("a", &hook_launch_id, Some("claude-b"))
            });

            barrier.wait();
            let (_, snapshot) = reg
                .detach_pty_with_selected_conversation("a")
                .expect("attached session should detach");
            let accepted = hook.join().expect("hook thread should finish");
            assert_eq!(
                snapshot.map(|selection| selection.session_id),
                accepted.then(|| "claude-b".to_string())
            );
            assert!(!reg.accept_hook_signal("a", &launch_id, Some("late-claude-c")));
        }
    }

    #[test]
    fn add_then_get_returns_descriptor() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        let got = reg.get("a").expect("session a should exist");
        assert_eq!(got.id, "a");
    }

    #[test]
    fn add_with_existing_id_is_noop() {
        let reg = SessionRegistry::new();
        let mut first = make_descriptor("a");
        first.label = "first".to_string();
        reg.add(first);
        let mut second = make_descriptor("a");
        second.label = "second".to_string();
        reg.add(second);
        assert_eq!(reg.get("a").unwrap().label, "first");
    }

    #[test]
    fn remove_known_returns_true_and_unknown_returns_false() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        assert!(reg.remove("a"));
        assert!(!reg.remove("a"));
        assert!(reg.get("a").is_none());
    }

    #[test]
    fn list_preserves_insertion_order() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        reg.add(make_descriptor("b"));
        reg.add(make_descriptor("c"));
        let ids: Vec<String> = reg.list().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn list_after_remove_keeps_remaining_order() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        reg.add(make_descriptor("b"));
        reg.add(make_descriptor("c"));
        reg.remove("b");
        let ids: Vec<String> = reg.list().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }

    #[test]
    fn lifecycle_initialized_on_add() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        assert_eq!(reg.get_lifecycle("a"), Some(SessionLifecycle::Starting));
        assert_eq!(reg.get_activity("a"), Some(SessionActivity::Idle));
    }

    #[test]
    fn set_lifecycle_updates_value() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        reg.set_lifecycle("a", SessionLifecycle::Running);
        assert_eq!(reg.get_lifecycle("a"), Some(SessionLifecycle::Running));
    }

    #[test]
    fn set_lifecycle_for_unknown_id_is_noop() {
        let reg = SessionRegistry::new();
        reg.set_lifecycle("phantom", SessionLifecycle::Running);
        assert_eq!(reg.get_lifecycle("phantom"), None);
    }

    #[test]
    fn add_emits_session_added() {
        let reg = SessionRegistry::new();
        let received = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let recv = std::sync::Arc::clone(&received);
        reg.on(Box::new(move |event| {
            if let SessionEvent::SessionAdded { descriptor } = event {
                recv.lock().unwrap().push(descriptor.id.clone());
            }
        }));
        reg.add(make_descriptor("a"));
        assert_eq!(*received.lock().unwrap(), vec!["a"]);
    }

    #[test]
    fn set_lifecycle_no_event_when_value_unchanged() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        reg.set_lifecycle("a", SessionLifecycle::Running);
        let count = std::sync::Arc::new(Mutex::new(0u32));
        let count_clone = std::sync::Arc::clone(&count);
        reg.on(Box::new(move |event| {
            if matches!(event, SessionEvent::SessionLifecycleChanged { .. }) {
                *count_clone.lock().unwrap() += 1;
            }
        }));
        reg.set_lifecycle("a", SessionLifecycle::Running);
        assert_eq!(*count.lock().unwrap(), 0);
    }

    #[test]
    fn set_cwd_updates_display_cwd_without_changing_launch_descriptor() {
        let reg = SessionRegistry::new();
        reg.add(make_descriptor("a"));
        let received = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let recv = std::sync::Arc::clone(&received);
        reg.on(Box::new(move |event| {
            if let SessionEvent::SessionCwdChanged { cwd, .. } = event {
                recv.lock().unwrap().push(cwd.clone());
            }
        }));

        reg.set_cwd("a", "/tmp/project".to_string());

        assert_eq!(reg.get("a").unwrap().cwd, None);
        assert_eq!(
            reg.get("a").unwrap().display_cwd,
            Some("/tmp/project".to_string())
        );
        assert_eq!(*received.lock().unwrap(), vec!["/tmp/project".to_string()]);
    }
}

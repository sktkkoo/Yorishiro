//! Chat に表示中の承認要求と、要求元へ一度だけ返す回答を束ねる。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const LEASE_DURATION: Duration = Duration::from_secs(3);
const REQUEST_DURATION: Duration = Duration::from_secs(300);
const MAX_PENDING_REQUESTS: usize = 128;
const MAX_TRACKED_SESSIONS: usize = 4096;
const MAX_RETIRED_LEGACY_OWNERS: usize = 64;

#[derive(Clone, Copy)]
enum OwnerOrder {
    Ordered(f64),
    Legacy,
}

fn owner_order(owner_id: &str) -> Option<OwnerOrder> {
    if owner_id.is_empty() || owner_id.len() > 256 {
        return None;
    }
    let Some((order, suffix)) = owner_id.split_once(':') else {
        return Some(OwnerOrder::Legacy);
    };
    let order = order.parse::<f64>().ok()?;
    if !order.is_finite() || uuid::Uuid::parse_str(suffix).is_err() {
        return None;
    }
    Some(OwnerOrder::Ordered(order))
}

/// lease が切れた後も順序を保持し、遅れて届く古い mount の更新を拒否する。
#[derive(Default)]
struct OwnerClaims {
    newest_order: Option<(f64, String, bool)>,
    current_owner: Option<String>,
    retired_legacy: HashSet<String>,
    legacy_retirement_full: bool,
}

impl OwnerClaims {
    fn is_current(&self, owner_id: &str) -> bool {
        self.current_owner.as_deref() == Some(owner_id)
            && self
                .newest_order
                .as_ref()
                .is_none_or(|(_, newest_owner, retired)| newest_owner == owner_id && !retired)
    }

    fn retire(&mut self, owner_id: &str, order: OwnerOrder) {
        match order {
            OwnerOrder::Ordered(order) => match &mut self.newest_order {
                Some((newest, newest_owner, retired)) if order == *newest => {
                    if newest_owner == owner_id {
                        *retired = true;
                    }
                }
                Some((newest, _, _)) if order < *newest => {}
                _ => self.newest_order = Some((order, owner_id.to_string(), true)),
            },
            OwnerOrder::Legacy => {
                if self.retired_legacy.len() < MAX_RETIRED_LEGACY_OWNERS {
                    self.retired_legacy.insert(owner_id.to_string());
                } else {
                    // 履歴を捨てて古い所有者を復活させず、以後の未知 legacy claim を拒否する。
                    self.legacy_retirement_full = true;
                }
            }
        }
        if self.current_owner.as_deref() == Some(owner_id) {
            self.current_owner = None;
        }
    }

    fn claim(&mut self, owner_id: &str, order: OwnerOrder) -> bool {
        match order {
            OwnerOrder::Ordered(order) => {
                if let Some((newest, newest_owner, retired)) = &self.newest_order {
                    if order < *newest
                        || (order == *newest && (newest_owner != owner_id || *retired))
                    {
                        return false;
                    }
                }
            }
            OwnerOrder::Legacy => {
                if self.newest_order.is_some()
                    || self.retired_legacy.contains(owner_id)
                    || (self.legacy_retirement_full
                        && self.current_owner.as_deref() != Some(owner_id))
                {
                    return false;
                }
            }
        }
        if self.current_owner.as_deref() != Some(owner_id) {
            if let Some(previous) = self.current_owner.take() {
                if let Some(previous_order) = owner_order(&previous) {
                    self.retire(&previous, previous_order);
                }
            }
        }
        if let OwnerOrder::Ordered(order) = order {
            self.newest_order = Some((order, owner_id.to_string(), false));
        }
        self.current_owner = Some(owner_id.to_string());
        true
    }
}

/// 回答は表示済み選択肢の ID のみ。規則の内容は provider 側の transport が保持する。
pub type ChatApprovalDecision = String;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatApprovalLabel {
    AllowOnce,
    Deny,
    AllowSession,
    AllowRule,
    AllowNetwork,
    DenyNetwork,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApprovalChoice {
    pub id: String,
    pub label: ChatApprovalLabel,
    pub detail: Option<String>,
}

impl ChatApprovalChoice {
    pub fn allow_once() -> Self {
        Self {
            id: "allow".into(),
            label: ChatApprovalLabel::AllowOnce,
            detail: None,
        }
    }

    pub fn deny() -> Self {
        Self {
            id: "deny".into(),
            label: ChatApprovalLabel::Deny,
            detail: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApprovalRequest {
    pub id: String,
    pub session_id: String,
    pub agent: String,
    pub conversation_id: Option<String>,
    pub title: String,
    pub detail: String,
    pub choices: Vec<ChatApprovalChoice>,
}

struct ChatLease {
    owner_id: String,
    expires_at: Instant,
}

struct PendingApproval {
    request: ChatApprovalRequest,
    owner_id: String,
    expires_at: Instant,
    is_current: Box<dyn Fn() -> bool + Send + Sync>,
    sender: mpsc::SyncSender<ChatApprovalDecision>,
}

#[derive(Default)]
struct BrokerState {
    leases: HashMap<String, ChatLease>,
    claims: HashMap<String, OwnerClaims>,
    pending: Vec<PendingApproval>,
}

impl BrokerState {
    fn maintain(&mut self, now: Instant) {
        self.leases.retain(|session_id, lease| {
            lease.expires_at > now
                && self
                    .claims
                    .get(session_id)
                    .is_some_and(|claims| claims.is_current(&lease.owner_id))
        });
        self.pending.retain(|pending| {
            pending.expires_at > now
                && self
                    .leases
                    .get(&pending.request.session_id)
                    .is_some_and(|lease| lease.owner_id == pending.owner_id)
                && (pending.is_current)()
        });
    }
}

#[derive(Clone, Default)]
pub struct ChatApprovalBroker {
    state: Arc<Mutex<BrokerState>>,
}

impl ChatApprovalBroker {
    pub fn owns_lease(&self, session_id: &str, owner_id: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.maintain(Instant::now());
        state
            .leases
            .get(session_id)
            .is_some_and(|lease| lease.owner_id == owner_id)
    }

    /// mount ごとの所有者を heartbeat で維持する。古い mount の解除は新しい lease を壊さない。
    pub fn lease(&self, session_id: &str, owner_id: &str, enabled: bool) {
        if session_id.is_empty() || session_id.len() > 256 {
            return;
        }
        let Some(order) = owner_order(owner_id) else {
            return;
        };
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.maintain(Instant::now());
        if state.claims.len() >= MAX_TRACKED_SESSIONS && !state.claims.contains_key(session_id) {
            return;
        }
        let claims = state.claims.entry(session_id.to_string()).or_default();
        if enabled {
            if !claims.claim(owner_id, order) {
                return;
            }
            state.leases.insert(
                session_id.to_string(),
                ChatLease {
                    owner_id: owner_id.to_string(),
                    expires_at: Instant::now() + LEASE_DURATION,
                },
            );
        } else {
            claims.retire(owner_id, order);
            if state
                .leases
                .get(session_id)
                .is_some_and(|lease| lease.owner_id == owner_id)
            {
                state.leases.remove(session_id);
            }
        }
        state.maintain(Instant::now());
    }

    pub fn list(&self, session_id: &str, owner_id: &str) -> Vec<ChatApprovalRequest> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.maintain(Instant::now());
        state
            .pending
            .iter()
            .filter(|pending| {
                pending.request.session_id == session_id && pending.owner_id == owner_id
            })
            .map(|pending| pending.request.clone())
            .collect()
    }

    /// 画面に提示した要求だけを一度 consume し、元の接続へ回答する。
    pub fn respond(
        &self,
        session_id: &str,
        owner_id: &str,
        id: &str,
        decision: ChatApprovalDecision,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.maintain(Instant::now());
        let index = state
            .pending
            .iter()
            .position(|pending| {
                pending.request.id == id
                    && pending.request.session_id == session_id
                    && pending.owner_id == owner_id
            })
            .ok_or_else(|| "This approval request is no longer available".to_string())?;
        if !state.pending[index]
            .request
            .choices
            .iter()
            .any(|choice| choice.id == decision)
        {
            return Err("This decision is not available for the approval request".to_string());
        }
        let pending = state.pending.remove(index);
        pending
            .sender
            .send(decision)
            .map_err(|_| "The approval connection has closed".to_string())
    }

    /// transport ごとの scope 検証を保存する。要求内容から ID を導出せず、各接続へ UUID を振る。
    pub fn register(
        &self,
        mut request: ChatApprovalRequest,
        is_current: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Option<ChatApprovalWaiter> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.maintain(Instant::now());
        if state.pending.len() >= MAX_PENDING_REQUESTS || !is_current() {
            return None;
        }
        let owner_id = state.leases.get(&request.session_id)?.owner_id.clone();
        request.id = uuid::Uuid::new_v4().to_string();
        let id = request.id.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        state.pending.push(PendingApproval {
            request,
            owner_id,
            expires_at: Instant::now() + REQUEST_DURATION,
            is_current: Box::new(is_current),
            sender,
        });
        Some(ChatApprovalWaiter {
            id,
            receiver,
            state: Arc::downgrade(&self.state),
        })
    }

    pub fn maintain(&self) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .maintain(Instant::now());
    }

    pub fn cancel(&self, id: &str) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pending
            .retain(|pending| pending.request.id != id);
    }

    pub fn cancel_conversation(&self, session_id: &str, conversation_id: &str) {
        if conversation_id.is_empty() {
            return;
        }
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pending
            .retain(|pending| {
                pending.request.session_id != session_id
                    || pending.request.conversation_id.as_deref() != Some(conversation_id)
            });
    }
}

pub struct ChatApprovalWaiter {
    id: String,
    receiver: mpsc::Receiver<ChatApprovalDecision>,
    state: Weak<Mutex<BrokerState>>,
}

impl ChatApprovalWaiter {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn recv_timeout(
        &self,
        duration: Duration,
    ) -> Result<ChatApprovalDecision, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(duration)
    }
}

impl Drop for ChatApprovalWaiter {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pending
                .retain(|pending| pending.request.id != self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn request(session_id: &str) -> ChatApprovalRequest {
        ChatApprovalRequest {
            id: "untrusted-id".to_string(),
            session_id: session_id.to_string(),
            agent: "claude".to_string(),
            conversation_id: Some("conversation-a".to_string()),
            title: "Bash".to_string(),
            detail: "npm run test".to_string(),
            choices: vec![ChatApprovalChoice::allow_once(), ChatApprovalChoice::deny()],
        }
    }

    fn ordered_owner(order: u64) -> String {
        format!("{order}:00000000-0000-4000-8000-{order:012x}")
    }

    #[test]
    fn no_view_lease_leaves_the_provider_permission_flow_unchanged() {
        let broker = ChatApprovalBroker::default();
        assert!(broker.register(request("main"), || true).is_none());
    }

    #[test]
    fn exact_requests_are_separate_and_resolve_once_with_scope_checks() {
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let first = broker.register(request("main"), || true).unwrap();
        let second = broker.register(request("main"), || true).unwrap();
        assert_ne!(first.id(), second.id());
        assert_ne!(first.id(), "untrusted-id");
        assert!(broker.list("other", "view-a").is_empty());
        assert!(broker.list("main", "other").is_empty());
        assert!(broker
            .respond("other", "view-a", first.id(), "allow".to_string())
            .is_err());
        assert!(broker
            .respond("main", "other", first.id(), "allow".to_string())
            .is_err());
        broker
            .respond("main", "view-a", second.id(), "deny".to_string())
            .unwrap();
        assert_eq!(second.recv_timeout(Duration::ZERO), Ok("deny".to_string()));
        assert!(broker
            .respond("main", "view-a", second.id(), "allow".to_string())
            .is_err());
        assert_eq!(broker.list("main", "view-a").len(), 1);
    }

    #[test]
    fn changed_launch_selection_or_connection_invalidates_the_card() {
        let broker = ChatApprovalBroker::default();
        let current = Arc::new(AtomicBool::new(true));
        broker.lease("main", "view-a", true);
        let scope = Arc::clone(&current);
        let waiter = broker
            .register(request("main"), move || scope.load(Ordering::SeqCst))
            .unwrap();
        current.store(false, Ordering::SeqCst);
        assert!(broker
            .respond("main", "view-a", waiter.id(), "allow".to_string())
            .is_err());
        assert_eq!(
            waiter.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn expired_lease_releases_without_approving_and_cannot_be_revived() {
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let waiter = broker.register(request("main"), || true).unwrap();
        broker
            .state
            .lock()
            .unwrap()
            .maintain(Instant::now() + LEASE_DURATION);
        broker.lease("main", "view-a", true);
        assert!(broker.owns_lease("main", "view-a"));
        assert!(broker.list("main", "view-a").is_empty());
        assert_eq!(
            waiter.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn request_deadline_applies_even_with_a_live_view_lease() {
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let waiter = broker.register(request("main"), || true).unwrap();
        let mut state = broker.state.lock().unwrap();
        let future = Instant::now() + REQUEST_DURATION;
        state.leases.get_mut("main").unwrap().expires_at = future + LEASE_DURATION;
        state.maintain(future);
        assert!(state.pending.is_empty());
        assert_eq!(
            waiter.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn new_owner_cancels_old_requests_and_old_cleanup_preserves_new_owner() {
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let old = broker.register(request("main"), || true).unwrap();
        broker.lease("main", "view-b", true);
        let new = broker.register(request("main"), || true).unwrap();
        broker.lease("main", "view-a", false);
        assert_eq!(broker.list("main", "view-b").len(), 1);
        assert_eq!(
            old.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
        broker.lease("main", "view-b", false);
        assert_eq!(
            new.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn delayed_old_heartbeat_cannot_reclaim_or_cancel_new_owners_request() {
        for (old, new) in [
            ("view-a".to_string(), "view-b".to_string()),
            (ordered_owner(100), ordered_owner(200)),
        ] {
            let broker = ChatApprovalBroker::default();
            broker.lease("main", &old, true);
            broker.lease("main", &new, true);
            let waiter = broker.register(request("main"), || true).unwrap();
            broker.lease("main", &old, true);
            broker.lease("main", &old, false);
            assert!(broker.owns_lease("main", &new));
            assert!(!broker.owns_lease("main", &old));
            assert_eq!(broker.list("main", &new).len(), 1);
            broker
                .respond("main", &new, waiter.id(), "allow".to_string())
                .unwrap();
            assert_eq!(waiter.recv_timeout(Duration::ZERO), Ok("allow".to_string()));
        }
    }

    #[test]
    fn newer_initial_claim_wins_even_when_older_initial_claim_arrives_late() {
        let broker = ChatApprovalBroker::default();
        let old = ordered_owner(100);
        let new = ordered_owner(200);
        broker.lease("main", &new, true);
        let waiter = broker.register(request("main"), || true).unwrap();
        broker.lease("main", &old, true);
        assert!(broker.owns_lease("main", &new));
        assert_eq!(broker.list("main", &new).len(), 1);
        assert_eq!(
            waiter.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn cleanup_before_initial_claim_retires_the_owner_permanently() {
        for owner in ["view-a".to_string(), ordered_owner(100)] {
            let broker = ChatApprovalBroker::default();
            broker.lease("main", &owner, false);
            broker.lease("main", &owner, true);
            assert!(!broker.owns_lease("main", &owner));
            assert!(broker.register(request("main"), || true).is_none());
        }
        let broker = ChatApprovalBroker::default();
        broker.lease("main", &ordered_owner(100), true);
        broker.lease("main", &ordered_owner(200), false);
        assert!(!broker.owns_lease("main", &ordered_owner(100)));
        broker.lease("main", &ordered_owner(100), true);
        assert!(!broker.owns_lease("main", &ordered_owner(100)));
        broker.lease("main", &ordered_owner(300), true);
        assert!(broker.owns_lease("main", &ordered_owner(300)));
    }

    #[test]
    fn ordered_claims_validate_finite_order_and_uuid_and_reject_equal_other_owner() {
        let broker = ChatApprovalBroker::default();
        for invalid in [
            "NaN:00000000-0000-4000-8000-000000000001",
            "inf:00000000-0000-4000-8000-000000000001",
            "1e999:00000000-0000-4000-8000-000000000001",
            "100:not-a-uuid",
        ] {
            broker.lease("main", invalid, true);
            assert!(!broker.owns_lease("main", invalid));
        }
        let owner = ordered_owner(100);
        broker.lease("main", &owner, true);
        broker.lease("main", "100:00000000-0000-4000-8000-000000000001", true);
        broker.lease("main", "delayed-legacy-owner", true);
        assert!(broker.owns_lease("main", &owner));
        broker
            .state
            .lock()
            .unwrap()
            .maintain(Instant::now() + LEASE_DURATION);
        broker.lease("main", &owner, true);
        assert!(broker.owns_lease("main", &owner));
    }

    #[test]
    fn legacy_retirement_limit_preserves_active_owner_without_reviving_old_ones() {
        let broker = ChatApprovalBroker::default();
        for index in 0..=MAX_RETIRED_LEGACY_OWNERS {
            broker.lease("main", &format!("view-{index}"), true);
        }
        let current = format!("view-{MAX_RETIRED_LEGACY_OWNERS}");
        broker.lease("main", "view-extra", false);
        broker.lease("main", &current, true);
        broker.lease("main", "view-0", true);
        broker.lease("main", "unknown-view", true);
        assert!(broker.owns_lease("main", &current));
        broker.lease("main", &ordered_owner(100), true);
        assert!(broker.owns_lease("main", &ordered_owner(100)));
    }

    #[test]
    fn late_session_end_only_cancels_its_exact_provider_conversation() {
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let old = broker.register(request("main"), || true).unwrap();
        let mut next_request = request("main");
        next_request.conversation_id = Some("conversation-b".to_string());
        let next = broker.register(next_request, || true).unwrap();
        broker.cancel_conversation("main", "");
        broker.cancel_conversation("other-host", "conversation-b");
        assert_eq!(broker.list("main", "view-a").len(), 2);
        broker.cancel_conversation("main", "conversation-a");
        assert_eq!(broker.list("main", "view-a").len(), 1);
        assert_eq!(
            old.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
        broker
            .respond("main", "view-a", next.id(), "deny".to_string())
            .unwrap();
        assert_eq!(next.recv_timeout(Duration::ZERO), Ok("deny".to_string()));
    }

    #[test]
    fn transport_drop_or_cancel_removes_unusable_buttons() {
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let waiter = broker.register(request("main"), || true).unwrap();
        drop(waiter);
        assert!(broker.list("main", "view-a").is_empty());
        let waiter = broker.register(request("main"), || true).unwrap();
        broker.cancel(waiter.id());
        assert_eq!(
            waiter.recv_timeout(Duration::ZERO),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn serializes_the_public_contract_and_rejects_unknown_decisions() {
        let value = serde_json::to_value(request("main")).unwrap();
        assert_eq!(value["sessionId"], "main");
        assert_eq!(value["conversationId"], "conversation-a");
        assert_eq!(
            value["choices"],
            serde_json::json!([
                {"id":"allow", "label":"allowOnce", "detail":null},
                {"id":"deny", "label":"deny", "detail":null}
            ])
        );
        let broker = ChatApprovalBroker::default();
        broker.lease("main", "view-a", true);
        let waiter = broker.register(request("main"), || true).unwrap();
        assert!(broker
            .respond("main", "view-a", waiter.id(), "always".into())
            .is_err());
        assert_eq!(broker.list("main", "view-a").len(), 1);
        assert!(broker
            .respond("main", "view-a", waiter.id(), "allow".into())
            .is_ok());
    }
}

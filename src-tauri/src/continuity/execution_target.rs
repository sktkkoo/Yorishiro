//! Durable backend identity. A saved dispatch is never reinterpreted from the
//! current UI selection when recovering it.
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "backend", content = "target", rename_all = "camelCase")]
pub(super) enum ExecutionTarget {
    Codex(super::executor::Target),
    Pi(super::pi_executor::Target),
}

impl<'de> Deserialize<'de> for ExecutionTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(
            tag = "backend",
            content = "target",
            rename_all = "camelCase",
            deny_unknown_fields
        )]
        enum Tagged {
            Codex(super::executor::Target),
            Pi(super::pi_executor::Target),
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        // Presence, not validity, selects the tagged format. In particular an
        // invalid explicit backend must not fall through to legacy Codex fields.
        if value.get("backend").is_some() {
            serde_json::from_value::<Tagged>(value)
                .map(|target| match target {
                    Tagged::Codex(target) => Self::Codex(target),
                    Tagged::Pi(target) => Self::Pi(target),
                })
                .map_err(serde::de::Error::custom)
        } else {
            serde_json::from_value(value)
                .map(Self::Codex)
                .map_err(serde::de::Error::custom)
        }
    }
}

impl ExecutionTarget {
    #[cfg(test)]
    pub(super) fn codex(&self) -> Option<&super::executor::Target> {
        match self {
            Self::Codex(target) => Some(target),
            Self::Pi(_) => None,
        }
    }

    pub(super) fn codex_mut(&mut self) -> Option<&mut super::executor::Target> {
        match self {
            Self::Codex(target) => Some(target),
            Self::Pi(_) => None,
        }
    }

    #[cfg(test)]
    pub(super) fn pi(&self) -> Option<&super::pi_executor::Target> {
        match self {
            Self::Pi(target) => Some(target),
            Self::Codex(_) => None,
        }
    }

    pub(super) fn backend_label(&self) -> &'static str {
        match self {
            Self::Codex(_) => "mainAgent",
            Self::Pi(_) => "pi",
        }
    }
}

impl From<super::executor::Target> for ExecutionTarget {
    fn from(target: super::executor::Target) -> Self {
        Self::Codex(target)
    }
}

impl From<super::pi_executor::Target> for ExecutionTarget {
    fn from(target: super::pi_executor::Target) -> Self {
        Self::Pi(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn legacy_codex() -> serde_json::Value {
        json!({
            "sessionId":"old-main", "threadId":"old-thread",
            "cwd":"/workspace", "launchId":"old-launch"
        })
    }

    fn pi_target() -> serde_json::Value {
        json!({
            "cwd":"/workspace", "sessionDir":"/private/session",
            "nodePath":"/usr/local/bin/node", "workerEntry":"/application/pi-worker.mjs",
            "provider":"configured-provider", "model":"configured-model"
        })
    }

    #[test]
    fn legacy_saved_dispatch_and_receipt_remain_codex_when_current_context_selects_pi() {
        let context = json!({
            "personaId":"yori-ja", "personaName":"Yori", "personaPrompt":"",
            "language":"ja", "cwd":"/workspace", "executionBackend":"pi"
        });
        let saved: crate::continuity::types::Saved = serde_json::from_value(json!({
            "version":1,
            "snapshot":{
                "personaId":"yori-ja", "revision":7, "phase":"working",
                "messages":[], "understandings":[], "drafts":[], "reflections":[]
            },
            "autoEnabled":true,
            "autoContext":context,
            "pendingExecution":{
                "requestId":"original-dispatch", "createdAt":1000,
                "target":legacy_codex(), "context":context,
                "prompt":"Original authorized work", "trigger":"followup",
                "correctionIds":[], "dispatchAttempted":true
            },
            "terminalReceipts":[{
                "requestId":"older-receipt", "target":legacy_codex(),
                "turnId":"old-turn", "status":"interrupted", "observedAt":500,
                "evidence":[]
            }]
        }))
        .unwrap();
        assert_eq!(
            saved.auto_context.as_ref().unwrap().execution_backend,
            Some(crate::continuity::types::ExecutionBackend::Pi)
        );
        let work = saved.pending_execution.as_ref().unwrap();
        assert!(work.dispatch_attempted);
        assert_eq!(work.target.codex().unwrap().thread_id, "old-thread");
        assert!(work.target.pi().is_none());
        assert_eq!(
            saved.terminal_receipts[0].target.backend_label(),
            "mainAgent"
        );
        let stored = serde_json::to_value(&saved).unwrap();
        assert_eq!(stored["pendingExecution"]["target"]["backend"], "codex");
        assert_eq!(stored["terminalReceipts"][0]["target"]["backend"], "codex");
        let reopened: crate::continuity::types::Saved = serde_json::from_value(stored).unwrap();
        let recovered = reopened.pending_execution.unwrap();
        assert_eq!(recovered.request_id, "original-dispatch");
        assert_eq!(recovered.created_at, Some(1000));
        assert!(recovered.dispatch_attempted);
        assert_eq!(recovered.target, work.target);
    }

    #[test]
    fn explicit_pi_roundtrips_its_backend_and_exact_worker_identity() {
        let target: ExecutionTarget = serde_json::from_value(json!({
            "backend":"pi", "target":pi_target()
        }))
        .unwrap();
        assert_eq!(target.backend_label(), "pi");
        assert!(target.codex().is_none());
        assert_eq!(target.pi().unwrap().session_dir, "/private/session");
        let saved = serde_json::to_value(&target).unwrap();
        assert_eq!(saved["backend"], "pi");
        assert_eq!(saved["target"], pi_target());
        assert_eq!(
            serde_json::from_value::<ExecutionTarget>(saved).unwrap(),
            target
        );
    }

    #[test]
    fn explicit_unknown_or_malformed_backend_never_falls_back_to_legacy_codex() {
        for backend in [json!("unknown"), json!(null), json!({}), json!("pi")] {
            let mut value = legacy_codex();
            value["backend"] = backend;
            assert!(serde_json::from_value::<ExecutionTarget>(value).is_err());
        }
        for value in [
            json!({"backend":"codex", "target":pi_target()}),
            json!({"backend":"pi", "target":legacy_codex()}),
            json!({"backend":"codex"}),
        ] {
            assert!(serde_json::from_value::<ExecutionTarget>(value).is_err());
        }
    }
}

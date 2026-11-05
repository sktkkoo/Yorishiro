//! Read-only Pi startup checks. This path never admits or resumes work.
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const MAX_OUTPUT: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostics {
    protocol: u32,
    ready: bool,
    checks: Vec<Check>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Check {
    name: String,
    status: String,
    code: String,
}

fn parse_output(bytes: &[u8]) -> Result<Diagnostics, String> {
    let result: Diagnostics =
        serde_json::from_slice(bytes).map_err(|_| "diagnostic_invalid".to_owned())?;
    let allowed = [
        ("node", "ok", "node_supported"),
        ("node", "invalid", "node_unsupported"),
        ("configuration", "ok", "configuration_valid"),
        ("configuration", "invalid", "configuration_invalid"),
        ("configuration", "blocked", "configuration_blocked"),
        ("dependencies", "ok", "dependencies_available"),
        ("dependencies", "missing", "dependencies_missing"),
        ("dependencies", "invalid", "dependencies_invalid"),
        ("dependencies", "blocked", "dependencies_blocked"),
        ("model", "ok", "model_available"),
        ("model", "missing", "model_unavailable"),
        ("model", "blocked", "model_blocked"),
        ("authentication", "ok", "authentication_present"),
        ("authentication", "missing", "authentication_missing"),
        ("authentication", "invalid", "authentication_invalid"),
        ("authentication", "blocked", "authentication_blocked"),
    ];
    let mut names = std::collections::BTreeSet::new();
    if result.protocol != 1
        || result.checks.len() != 5
        || result.ready != result.checks.iter().all(|check| check.status == "ok")
        || result.checks.iter().any(|check| {
            !names.insert(&check.name)
                || !allowed.contains(&(
                    check.name.as_str(),
                    check.status.as_str(),
                    check.code.as_str(),
                ))
        })
    {
        return Err("diagnostic_invalid".into());
    }
    Ok(result)
}

pub(super) async fn probe(home: &Path, cwd: Option<&str>) -> Result<Diagnostics, String> {
    let config_path = home.join("continuity/pi-worker.json");
    let file = std::fs::File::open(&config_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "configuration_missing"
        } else {
            "configuration_invalid"
        }
        .to_owned()
    })?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, 64 * 1024 + 1), &mut bytes)
        .map_err(|_| "configuration_invalid".to_owned())?;
    if bytes.len() > 64 * 1024 {
        return Err("configuration_invalid".into());
    }
    let config: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "configuration_invalid".to_owned())?;
    let field = |key: &str| {
        config
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
            .ok_or_else(|| "configuration_invalid".to_owned())
    };
    let node = Path::new(field("nodePath")?);
    if !node.is_absolute() || !node.is_file() {
        return Err("node_unavailable".into());
    }
    let worker = Path::new(field("workerEntry")?);
    if !worker.is_absolute() || !worker.is_file() {
        return Err("diagnostic_unavailable".into());
    }
    let entry = worker.with_file_name("diagnose.mjs");
    if !entry.is_file() {
        return Err("diagnostic_unavailable".into());
    }
    let cwd = cwd.ok_or("workspace_unavailable")?;
    if cwd.contains('\0') || !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
        return Err("workspace_unavailable".into());
    }
    let permissions = config.get("permissions").ok_or("configuration_invalid")?;
    let (auth_mode, auth_path) =
        super::pi_executor::auth_configuration(&config, field("provider")?)
            .map_err(|_| "configuration_invalid".to_owned())?;
    let mut command = Command::new(node);
    command
        .arg(entry)
        .args(["--session-dir"])
        // A path identity only: the diagnostic must never create this directory.
        .arg(home.join("continuity/pi/.diagnostic-unused"))
        .args([
            "--cwd",
            cwd,
            "--provider",
            field("provider")?,
            "--model",
            field("model")?,
            "--permissions-json",
        ])
        .arg(permissions.to_string());
    auth_mode.apply_args(&mut command, auth_path.as_deref());
    let mut child = command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "node_unavailable".to_owned())?;
    let stdout = child.stdout.take().ok_or("diagnostic_invalid")?;
    let mut limited = stdout.take(MAX_OUTPUT as u64 + 1);
    let mut output = Vec::new();
    let outcome = tokio::time::timeout(Duration::from_secs(5), async {
        let (read, status) = tokio::join!(limited.read_to_end(&mut output), child.wait());
        read.map_err(|_| "diagnostic_invalid".to_owned())?;
        let status = status.map_err(|_| "diagnostic_invalid".to_owned())?;
        if !status.success() || output.len() > MAX_OUTPUT {
            return Err("diagnostic_invalid".to_owned());
        }
        parse_output(&output)
    })
    .await;
    match outcome {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err("diagnostic_timeout".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report() -> serde_json::Value {
        json!({"protocol":1,"ready":false,"checks":[
            {"name":"node","status":"ok","code":"node_supported"},
            {"name":"configuration","status":"ok","code":"configuration_valid"},
            {"name":"dependencies","status":"ok","code":"dependencies_available"},
            {"name":"model","status":"ok","code":"model_available"},
            {"name":"authentication","status":"missing","code":"authentication_missing"}
        ]})
    }

    #[test]
    fn diagnostics_accept_only_complete_fixed_codes_and_consistent_readiness() {
        assert!(
            !parse_output(&serde_json::to_vec(&report()).unwrap())
                .unwrap()
                .ready
        );
        let mut invalid = report();
        invalid["ready"] = json!(true);
        assert!(parse_output(&serde_json::to_vec(&invalid).unwrap()).is_err());
        let mut invalid = report();
        invalid["checks"].as_array_mut().unwrap().pop();
        assert!(parse_output(&serde_json::to_vec(&invalid).unwrap()).is_err());
        let mut invalid = report();
        invalid["checks"][0]["code"] = json!("PRIVATE_SENTINEL");
        assert_eq!(
            parse_output(&serde_json::to_vec(&invalid).unwrap()).unwrap_err(),
            "diagnostic_invalid"
        );
        let mut invalid = report();
        invalid["checks"][1] = invalid["checks"][0].clone();
        assert!(parse_output(&serde_json::to_vec(&invalid).unwrap()).is_err());
        let mut invalid = report();
        invalid["secret"] = json!("PRIVATE_SENTINEL");
        assert!(parse_output(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }

    #[tokio::test]
    async fn diagnostics_leave_missing_configuration_and_existing_state_untouched() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        assert_eq!(
            probe(home.path(), workspace.path().to_str())
                .await
                .unwrap_err(),
            "configuration_missing"
        );
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);

        let node = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
        let runtime = tempfile::tempdir().unwrap();
        let worker = runtime.path().join("main.mjs");
        std::fs::write(&worker, "throw new Error('worker must not start');").unwrap();
        let entry = runtime.path().join("diagnose.mjs");
        std::fs::write(
            &entry,
            format!("console.log(JSON.stringify({}));", report()),
        )
        .unwrap();
        std::fs::create_dir(home.path().join("continuity")).unwrap();
        let config = json!({"nodePath":node,"workerEntry":worker,"provider":"openai",
            "model":"explicit-model","permissions":{"read":true,"write":false,"commands":[]}});
        let config = serde_json::to_vec(&config).unwrap();
        std::fs::write(home.path().join("continuity/pi-worker.json"), &config).unwrap();
        let saved = home.path().join("continuity/state.json");
        std::fs::write(&saved, "SAVED_STATE_SENTINEL").unwrap();
        assert!(
            !probe(home.path(), workspace.path().to_str())
                .await
                .unwrap()
                .ready
        );
        assert_eq!(std::fs::read(&saved).unwrap(), b"SAVED_STATE_SENTINEL");
        assert_eq!(
            std::fs::read(home.path().join("continuity/pi-worker.json")).unwrap(),
            config
        );
        assert!(!home.path().join("continuity/pi").exists());

        std::fs::write(
            &entry,
            "console.error('PRIVATE_SENTINEL'); console.log('PRIVATE_SENTINEL');",
        )
        .unwrap();
        assert_eq!(
            probe(home.path(), workspace.path().to_str())
                .await
                .unwrap_err(),
            "diagnostic_invalid"
        );

        // OAuth diagnosis receives the same explicit metadata as production;
        // no authentication folder, lock database or session is created here.
        let auth_path = runtime.path().join("private-auth/auth.json");
        let mut oauth: serde_json::Value = serde_json::from_slice(&config).unwrap();
        oauth["authMode"] = json!("oauth");
        oauth["authPath"] = json!(auth_path);
        let oauth_bytes = serde_json::to_vec(&oauth).unwrap();
        std::fs::write(home.path().join("continuity/pi-worker.json"), &oauth_bytes).unwrap();
        let mut invalid_auth = report();
        invalid_auth["checks"][4] =
            json!({"name":"authentication","status":"invalid","code":"authentication_invalid"});
        std::fs::write(&entry, format!(
            "const a=process.argv.slice(2);const f=Object.fromEntries(Array.from({{length:a.length/2}},(_,i)=>[a[i*2],a[i*2+1]]));if(f['--auth-mode']!=='oauth'||f['--auth-path']!=={})process.exit(41);console.log(JSON.stringify({}));",
            serde_json::to_string(&auth_path).unwrap(), invalid_auth,
        )).unwrap();
        let result = probe(home.path(), workspace.path().to_str()).await.unwrap();
        assert_eq!(result.checks[4].code, "authentication_invalid");
        assert!(!auth_path.parent().unwrap().exists());
        assert!(!home.path().join("continuity/pi").exists());
        assert_eq!(std::fs::read(&saved).unwrap(), b"SAVED_STATE_SENTINEL");
        assert_eq!(
            std::fs::read(home.path().join("continuity/pi-worker.json")).unwrap(),
            oauth_bytes
        );
        oauth["authMode"] = json!("apiKey");
        std::fs::write(
            home.path().join("continuity/pi-worker.json"),
            serde_json::to_vec(&oauth).unwrap(),
        )
        .unwrap();
        assert_eq!(
            probe(home.path(), workspace.path().to_str())
                .await
                .unwrap_err(),
            "configuration_invalid"
        );
    }
}

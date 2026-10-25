//! Independent publication-boundary regression fixtures. No network or CLI auth.
use super::*;

pub(super) struct Fixture {
    _temporary: tempfile::TempDir,
    pub(super) job: PathBuf,
    pub(super) run_id: String,
}

pub(super) fn fixture(path: &str, before: &[u8], after: &[u8]) -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let source = root.join("source");
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let original = Repository::init_opts(&source, &options).unwrap();
    original
        .remote("origin", "https://github.com/example/review-fixture.git")
        .unwrap();
    let source_file = source.join(path);
    fs::create_dir_all(source_file.parent().unwrap()).unwrap();
    fs::write(&source_file, before).unwrap();
    let mut index = original.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
    let base_tree = index.write_tree().unwrap();
    let signature = git2::Signature::new(
        "Review fixture",
        "fixture@example.invalid",
        &git2::Time::new(1_700_000_000, 0),
    )
    .unwrap();
    let base = original
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Fixture baseline",
            &original.find_tree(base_tree).unwrap(),
            &[],
        )
        .unwrap();
    let run_id = uuid::Uuid::new_v4().to_string();
    let job = root.join(&run_id);
    fs::create_dir(&job).unwrap();
    let diagnostic = job.join("repository");
    let repository = RepoBuilder::new()
        .clone_local(CloneLocal::None)
        .remote_create(super::super::development::local_remote)
        .clone(source.to_str().unwrap(), &diagnostic)
        .unwrap();
    fs::write(diagnostic.join(path), after).unwrap();
    let mut index = repository.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
    let verified = index.write_tree().unwrap();
    let artifact =
        super::super::artifact::export_verified_tree(&diagnostic, &job, &verified.to_string())
            .unwrap();
    let branch = format!("yorishiro/{run_id}");
    let result = DevelopmentResult {
        worktree_path: artifact.to_string_lossy().into_owned(),
        branch: branch.clone(),
        base_commit: base.to_string(),
        verified_tree: verified.to_string(),
        base_branch: "main".into(),
        origin_url: "https://github.com/example/review-fixture.git".into(),
        summary: "A fixture-only change for explicit review.".into(),
        tests: vec!["fixture: exit 0".into()],
        checks: vec![ExecutedCheck {
            command: "npm test".into(),
            exit_code: 0,
        }],
        changed_paths: vec![path.into()],
        ready_for_review: true,
        requested_action: None,
    };
    fs::write(
        job.join("result.json"),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
    fs::write(
        job.join("source.json"),
        serde_json::to_vec(&json!({
            "root": source,
            "baseCommit": base.to_string(),
            "baseBranch": "main",
            "originUrl": "https://github.com/example/review-fixture.git",
            "branch": branch,
        }))
        .unwrap(),
    )
    .unwrap();
    Fixture {
        _temporary: temporary,
        job,
        run_id,
    }
}

#[test]
fn audit_remote_ancestry_must_prove_the_reviewed_parent_is_already_public() {
    let base = "1234567890123456789012345678901234567890";
    for status in ["ahead", "identical"] {
        let response = serde_json::to_vec(&json!({
            "status": status,
            "merge_base_commit": {"sha": base},
        }))
        .unwrap();
        ancestry_proven(&response, base).unwrap();
    }
    for response in [
        json!({"status":"behind", "merge_base_commit":{"sha":base}}),
        json!({"status":"diverged", "merge_base_commit":{"sha":base}}),
        json!({"status":"ahead", "merge_base_commit":{"sha":"unrelated"}}),
        json!({"status":"ahead"}),
        json!({"merge_base_commit":{"sha":base}}),
        json!(null),
    ] {
        assert!(ancestry_proven(&serde_json::to_vec(&response).unwrap(), base).is_err());
    }
    assert!(ancestry_proven(b"not-json", base).is_err());
}

#[test]
fn audit_local_clone_rejects_git_url_rewriting_before_any_transport() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let repo = Repository::init(root.join("destination")).unwrap();
    let expected = root.join("expected-local-source");
    let expected = expected.to_str().unwrap();
    // A local-only replacement demonstrates insteadOf resolution without ever
    // contacting a server or modifying the user's global Git configuration.
    repo.config()
        .unwrap()
        .set_str("url./unapproved-local-source/.insteadOf", expected)
        .unwrap();
    let rewritten = repo.remote("unprotected", expected).unwrap();
    assert_ne!(rewritten.url(), Some(expected));
    assert!(super::super::development::local_remote(&repo, "protected", expected).is_err());
    assert!(super::super::development::local_remote(&repo, "relative", "relative-path").is_err());
    assert!(super::super::development::local_remote(
        &repo,
        "network",
        "https://example.invalid/repo"
    )
    .is_err());
}

#[test]
fn audit_review_digest_binds_destination_branch_text_and_exact_diff() {
    let fixture = fixture("note.md", b"before\n", b"after\n");
    let review = prepare(&fixture.job, &fixture.run_id).unwrap();
    revalidate(&fixture.job, &review).unwrap();
    for field in [
        "repository",
        "baseBranch",
        "headBranch",
        "title",
        "body",
        "diff",
        "commit",
        "artifactTree",
        "artifactPath",
    ] {
        let mut value = serde_json::to_value(&review).unwrap();
        value[field] = Value::String("unapproved replacement".into());
        let changed: PublicationReview = serde_json::from_value(value).unwrap();
        assert!(revalidate(&fixture.job, &changed).is_err(), "{field}");
    }
    // A caller cannot replace the payload merely by recomputing its public hash:
    // the separately stored preparation must match it as well.
    let mut changed = review.clone();
    changed.repository = "example/another-repository".into();
    changed.payload_digest = digest(&changed).unwrap();
    assert!(revalidate(&fixture.job, &changed).is_err());
    assert!(!fixture.job.join("publication-intent.json").exists());
}

#[test]
fn audit_only_fixed_artifact_bytes_can_be_prepared_and_sent() {
    let fixture = fixture("note.md", b"before\n", b"reviewed\n");
    // A diagnostic clone remains untrusted; changing it does not change what
    // the user reviews or what the new staging commit contains.
    fs::write(
        fixture.job.join("repository/note.md"),
        b"unreviewed diagnostic edit\n",
    )
    .unwrap();
    let review = prepare(&fixture.job, &fixture.run_id).unwrap();
    assert!(review.diff.contains("+reviewed"));
    assert!(!review.diff.contains("unreviewed diagnostic"));
    revalidate(&fixture.job, &review).unwrap();
    fs::write(
        fixture.job.join("review-artifact/note.md"),
        b"changed after approval\n",
    )
    .unwrap();
    assert!(revalidate(&fixture.job, &review).is_err());
}

#[test]
fn audit_staging_cannot_acquire_hooks_or_external_object_sources() {
    for injection in ["config", "alternates"] {
        let fixture = fixture("note.md", b"before\n", b"after\n");
        let review = prepare(&fixture.job, &fixture.run_id).unwrap();
        let git = fixture
            .job
            .join(format!("publication-{}/git", review.preparation_id));
        if injection == "config" {
            fs::write(
                git.join("config"),
                b"[core]\nbare=true\nhooksPath=/unapproved\n",
            )
            .unwrap();
        } else {
            fs::create_dir_all(git.join("objects/info")).unwrap();
            fs::write(
                git.join("objects/info/alternates"),
                b"/unapproved/objects\n",
            )
            .unwrap();
        }
        assert!(revalidate(&fixture.job, &review).is_err(), "{injection}");
    }
}

#[test]
fn audit_unreviewable_workflow_and_binary_changes_are_refused() {
    for (path, after) in [
        (
            ".github/workflows/fixture.yml",
            b"run: changed\n".as_slice(),
        ),
        ("image.dat", b"changed\0binary".as_slice()),
        ("secret.pem", b"changed private key\n".as_slice()),
    ] {
        let fixture = fixture(path, b"before\n", after);
        assert!(prepare(&fixture.job, &fixture.run_id).is_err(), "{path}");
        assert!(!fixture.job.join("publication-intent.json").exists());
    }
}

#[cfg(unix)]
#[test]
fn audit_review_files_cannot_be_replaced_with_links_or_named_pipes() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let fixture = fixture("note.md", b"before\n", b"after\n");
    let review = prepare(&fixture.job, &fixture.run_id).unwrap();
    let staging = fixture
        .job
        .join(format!("publication-{}", review.preparation_id));
    let body = staging.join("body.md");
    let saved = staging.join("saved-body.md");
    fs::rename(&body, &saved).unwrap();
    symlink(&saved, &body).unwrap();
    assert!(revalidate(&fixture.job, &review).is_err());
    fs::remove_file(&body).unwrap();
    fs::hard_link(&saved, &body).unwrap();
    assert!(revalidate(&fixture.job, &review).is_err());
    fs::remove_file(&body).unwrap();
    let raw = std::ffi::CString::new(body.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
    assert!(revalidate(&fixture.job, &review).is_err());
}

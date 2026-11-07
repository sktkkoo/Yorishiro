import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "observer", Path(__file__).with_name("observe-continuity-soak.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def test_exact_executable_resolver_missing_ambiguous_and_failed(self):
        executable = Path(sys.executable).resolve()
        with patch.object(observer, "process_executable_paths", return_value=[
                (2, str(executable)), (3, "/different/location/" + executable.name)]):
            self.assertEqual(observer.resolve_executable(executable), (2, "matched"))
        with patch.object(observer, "process_executable_paths", return_value=[
                (2, str(executable)), (3, str(executable))]):
            self.assertEqual(observer.resolve_executable(executable), (0, "ambiguous"))
        with patch.object(observer, "process_executable_paths", return_value=[]):
            self.assertEqual(observer.resolve_executable(executable), (0, "missing"))
        with patch.object(observer, "process_executable_paths", side_effect=OSError("denied")):
            self.assertEqual(observer.resolve_executable(executable), (0, "resolverError"))

    def test_restart_transitions_retain_unavailable_samples(self):
        evidence = observer.Evidence(1000)
        observations = []
        for at, pid in [(1000, 12), (2000, 0), (3000, 34), (4000, 34)]:
            observation = {"observedAt": at, "pid": pid, "processAlive": pid > 0,
                           "autoEnabled": True}
            evidence.add(observation)
            observations.append(observation)
        self.assertEqual([x["pidChanged"] for x in observations], [False, True, True, False])
        self.assertEqual(observations[2]["previousPid"], 0)
        summary = evidence.summary(3)
        self.assertEqual(summary["pidChanges"], 2)
        self.assertEqual(summary["processUnavailableSamples"], 1)
        self.assertEqual(summary["observedPids"], [12, 34])

    def test_cli_is_bounded_read_only_and_preserves_existing_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "state.json"
            log = Path(folder) / "evidence.jsonl"
            original = json.dumps({"snapshot": {"revision": 4, "phase": "idle"},
                                   "autoEnabled": True, "workRuns": []})
            state.write_text(original)
            command = [sys.executable, "-B", str(Path(observer.__file__)),
                       "--state", str(state), "--pid", str(os.getpid()),
                       "--output", str(log), "--duration-seconds", "0.02",
                       "--interval-seconds", "0.01"]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=5)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            records = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(records[0]["kind"], "start")
            self.assertEqual(records[-1]["kind"], "summary")
            # fsync or process scheduling may consume the whole 20ms budget.
            # The CLI still emits its first observation and an accurate summary.
            samples = [record for record in records if record["kind"] == "sample"]
            self.assertGreaterEqual(len(samples), 1)
            self.assertEqual(records[-1]["samples"], len(samples))
            self.assertEqual(state.read_text(), original)
            evidence = log.read_bytes()
            duplicate = subprocess.run(command, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertEqual(log.read_bytes(), evidence)

    def test_sampling_cadence_and_deadline_use_a_deterministic_clock(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "state.json"
            log = Path(folder) / "evidence.jsonl"
            original = json.dumps({"snapshot": {"revision": 4, "phase": "idle"},
                                   "autoEnabled": True, "workRuns": []})
            state.write_text(original)
            clock = [0.0]

            def advance(delay):
                self.assertGreater(delay, 0)
                clock[0] += delay
                self.assertLessEqual(clock[0], 2.5)

            command = [str(Path(observer.__file__)), "--state", str(state),
                       "--pid", str(os.getpid()), "--output", str(log),
                       "--duration-seconds", "2.5", "--interval-seconds", "1"]
            with patch.object(sys, "argv", command), \
                    patch.object(observer.time, "monotonic", side_effect=lambda: clock[0]), \
                    patch.object(observer.time, "time", side_effect=lambda: 1000 + clock[0]), \
                    patch.object(observer.time, "sleep", side_effect=advance) as sleep, \
                    patch("builtins.print"):
                observer.main()

            records = [json.loads(line) for line in log.read_text().splitlines()]
            samples = [record for record in records if record["kind"] == "sample"]
            self.assertEqual([record["observedAt"] for record in samples],
                             [1000000, 1001000, 1002000, 1002500])
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 1, 0.5])
            self.assertEqual(records[-1]["samples"], 4)
            self.assertEqual(records[-1]["elapsedSeconds"], 2.5)
            self.assertEqual(state.read_text(), original)

    def test_metadata_only_and_read_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "state.json"
            state.write_text(json.dumps({"snapshot": {"revision": 9, "phase": "idle",
                "messages": [{"content": "private conversation"}], "error": "secret"},
                "workRuns": [{"requestId": "r", "error": "private error"}]}))
            result = observer.sample(state, os.getpid())
            self.assertTrue(result["processAlive"])
            self.assertNotIn("private", json.dumps(result))
            self.assertNotIn("secret", json.dumps(result))
            state.write_text("invalid")
            self.assertIn("stateReadError", observer.sample(state, os.getpid()))

    def test_malformed_state_structure_is_unknown_and_live_check_continues(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "state.json"
            for saved in (None, [], {"snapshot": None}, {"snapshot": []},
                          {"snapshot": {"revision": 1, "phase": "idle"}, "workRuns": None},
                          {"snapshot": {"revision": 1, "phase": "idle"}, "workRuns": 42},
                          {"snapshot": {"revision": 1, "phase": "idle"}, "workRuns": [None]},
                          {"snapshot": {"revision": 1, "phase": "idle"},
                           "workRuns": [{"requestId": "valid"}, "invalid"]}):
                with self.subTest(saved=saved):
                    state.write_text(json.dumps(saved))
                    calls = []
                    class Client:
                        def snapshot(self):
                            calls.append(True)
                            return {"personaId": "yori-ja", "revision": 1,
                                    "phase": "idle", "hasError": False}
                    result = observer.sample(state, os.getpid(), Client())
                    self.assertEqual(result["stateReadError"], "ValueError")
                    self.assertEqual(calls, [True])
                    self.assertEqual(result["liveVerification"]["status"], "unknown")
                    evidence = observer.Evidence(0)
                    evidence.add(result)
                    self.assertEqual(evidence.summary(1)["stateReadErrorSamples"], 1)
                    self.assertFalse(evidence.summary(1)["goalAchieved"])

    def test_invalid_operational_metadata_is_not_coerced_to_healthy_state(self):
        base = {"snapshot": {"revision": 1, "phase": "idle"},
                "autoEnabled": True, "executionBlocked": False}
        cases = [
            {**base, "snapshot": {"revision": value, "phase": "idle"}}
            for value in (True, -1, "1", None)
        ]
        cases += [{**base, "snapshot": {"revision": 1, "phase": value}}
                  for value in (None, "unknown", {})]
        cases += [{**base, key: value} for key in ("autoEnabled", "executionBlocked")
                  for value in ("false", 1, None)]
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "state.json"
            for saved in cases:
                with self.subTest(saved=saved):
                    state.write_text(json.dumps(saved))
                    result = observer.sample(state, os.getpid())
                    self.assertEqual(result["stateReadError"], "ValueError")
                    self.assertNotIn("autoEnabled", result)
                    self.assertNotIn("phase", result)

    def test_disk_error_presence_matches_live_even_for_empty_error_text(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / "state.json"
            for error in (None, "", "private error"):
                with self.subTest(error=error):
                    snapshot = {"personaId": "yori-ja", "revision": 1,
                                "phase": "idle", "error": error}
                    state.write_text(json.dumps({"snapshot": snapshot}))
                    result = observer.sample(state, os.getpid())
                    self.assertEqual(result["hasError"],
                                     observer.snapshot_metadata(snapshot)["hasError"])
                    evidence = observer.Evidence(0)
                    evidence.add(result)
                    self.assertEqual(evidence.summary(1)["diskWorkerErrorSamples"],
                                     int(error is not None))
                    self.assertNotIn("private error", json.dumps(result))
            for error in (False, 0, [], {}):
                with self.subTest(invalid_error=error):
                    state.write_text(json.dumps({"snapshot": {
                        "revision": 1, "phase": "idle", "error": error}}))
                    result = observer.sample(state, os.getpid())
                    self.assertEqual(result["stateReadError"], "ValueError")
                    self.assertNotIn("hasError", result)

    def test_count_only_new_unique_completed_main_agent_runs(self):
        evidence = observer.Evidence(1000)
        runs = [{"requestId": key, "requestCreatedAt": start, "startedAt": 1400, "finishedAt": 1500,
                 "executor": executor, "outcome": outcome, "progressed": progress}
                for key, start, executor, outcome, progress in [
                    ("historical", 999, "mainAgent", "completed", True),
                    ("complete", 1000, "mainAgent", "completed", False),
                    ("progress", 1001, "mainAgent", "completed", True),
                    ("text", 1002, "text", "completed", True),
                    ("error", 1003, "mainAgent", "error", False)]]
        for at in [2000, 3000]:
            evidence.add({"observedAt": at, "pid": 1, "processAlive": True,
                          "autoEnabled": True, "workRuns": runs})
        result = evidence.summary(2)
        self.assertEqual(result["uniqueCompletedMainAgentRequests"], 2)
        self.assertEqual(result["uniqueProgressedMainAgentRequests"], 1)
        self.assertEqual(result["uniqueObservedRequests"], 4)
        self.assertFalse(result["goalAchieved"])
        self.assertIsNone(result["userQualityScore"])

    def test_pi_and_main_agent_count_toward_backend_independent_acceptance(self):
        evidence = observer.Evidence(1000)
        runs = [{"requestId": f"new-{i}", "requestCreatedAt": 1000 + i,
                 "startedAt": 1100, "finishedAt": 1500,
                 "trigger": "return" if i % 2 == 0 else "followup",
                 "executor": "mainAgent" if i < 4 else "pi",
                 "outcome": "completed", "progressed": i % 2 == 0}
                for i in range(24)]
        for key, executor, outcome, created in [
                ("text", "text", "completed", 1000),
                ("unknown", "unknown", "completed", 1000),
                ("failure", "pi", "error", 1000),
                ("old-pi", "pi", "completed", 999),
                ("undated-pi", "pi", "completed", None)]:
            runs.append({"requestId": key, "requestCreatedAt": created,
                         "startedAt": 1100, "finishedAt": 1500,
                         "executor": executor, "outcome": outcome, "progressed": True})
        for at in [2000, 3000]:
            evidence.add({"observedAt": at, "pid": 1, "processAlive": True,
                          "autoEnabled": True, "workRuns": runs})
        result = evidence.summary(2)
        self.assertEqual(result["uniqueCompletedMainAgentRequests"], 4)
        self.assertEqual(result["uniqueProgressedMainAgentRequests"], 2)
        self.assertEqual(result["uniqueCompletedPiRequests"], 20)
        self.assertEqual(result["uniqueProgressedPiRequests"], 10)
        self.assertEqual(result["uniqueCompletedAutonomousRequests"], 24)
        self.assertEqual(result["uniqueProgressedAutonomousRequests"], 12)
        self.assertTrue(result["atLeast24CompletedRequests"])
        self.assertFalse(result["twelveHourSampleWindow"])
        self.assertFalse(result["uninterruptedExecutionProven"])
        self.assertFalse(result["goalAchieved"])
        self.assertIsNone(result["userQualityScore"])

    def test_24_manual_completions_do_not_satisfy_autonomous_acceptance(self):
        evidence = observer.Evidence(1000)
        runs = [{"requestId": f"manual-{i}", "requestCreatedAt": 1000 + i,
                 "finishedAt": 1500, "trigger": "message",
                 "executor": "mainAgent" if i < 12 else "pi",
                 "outcome": "completed", "progressed": True} for i in range(24)]
        for at in [2000, 3000]:
            evidence.add({"observedAt": at, "pid": 1, "processAlive": True,
                          "autoEnabled": False, "workRuns": runs})
        result = evidence.summary(2)
        self.assertEqual(result["uniqueCompletedMainAgentRequests"], 12)
        self.assertEqual(result["uniqueCompletedPiRequests"], 12)
        self.assertEqual(result["uniqueCompletedToolCapableRequests"], 24)
        self.assertEqual(result["uniqueProgressedToolCapableRequests"], 24)
        self.assertEqual(result["uniqueCompletedAutonomousRequests"], 0)
        self.assertEqual(result["uniqueProgressedAutonomousRequests"], 0)
        self.assertFalse(result["atLeast24CompletedRequests"])
        self.assertFalse(result["goalAchieved"])

    def test_recovered_old_or_unknown_requests_do_not_become_new_executions(self):
        evidence = observer.Evidence(1000)
        for creation in [999, None]:
            evidence.add({"observedAt": 2000, "pid": 1, "processAlive": True,
                          "workRuns": [{"requestId": str(creation),
                              "requestCreatedAt": creation, "startedAt": 1500,
                              "finishedAt": 1600, "executor": "mainAgent",
                              "outcome": "completed", "progressed": True}]})
        self.assertEqual(evidence.summary(1)["uniqueCompletedMainAgentRequests"], 0)

    def test_missing_process_and_state_are_not_success(self):
        self.assertFalse(observer.probe_process(0))
        evidence = observer.Evidence(1000)
        evidence.add({"observedAt": 1000, "pid": 0, "processAlive": False,
                      "stateReadError": "FileNotFoundError", "hasError": True})
        result = evidence.summary(43200)
        self.assertEqual(result["processUnavailableSamples"], 1)
        self.assertEqual(result["stateReadErrorSamples"], 1)
        self.assertEqual(result["workerErrorSamples"], 1)
        self.assertFalse(result["twelveHourSampleWindow"])



class BackendReplayTests(unittest.TestCase):
    @staticmethod
    def capture(records, tail=""):
        import io
        data = "".join(json.dumps(record) + "\n" for record in records) + tail
        return type("Capture", (), {"open": lambda *args, **kwargs: io.StringIO(data)})()

    def test_backend_counts_recovery_errors_and_legacy(self):
        evidence = observer.Evidence(1000)
        runs = [{"requestId": backend, "requestCreatedAt": 1100, "finishedAt": 1500,
                 "executor": backend, "outcome": "completed", "progressed": True}
                for backend in ("pi", "mainAgent", "text")]
        runs += [{**runs[0], "requestId": "error", "outcome": "error"},
                 {**runs[0], "requestId": "terminal", "outcome": "terminal"},
                 {**runs[0], "requestId": "legacy", "requestCreatedAt": None},
                 {**runs[0], "requestId": "old", "requestCreatedAt": 999}]
        for at, values in [(2000, runs), (3000, runs + [{**runs[0], "outcome": "error"}])]:
            evidence.add({"observedAt": at, "pid": 1, "processAlive": True, "workRuns": values})
        result = evidence.summary(2)
        self.assertEqual(result["backendCounts"]["pi"]["uniqueCompletedRequests"], 1)
        self.assertEqual(result["uniqueCompletedToolCapableRequests"], 2)
        self.assertEqual(result["uniqueProgressedToolCapableRequests"], 2)
        self.assertEqual(result["uniqueCompletedTextRequests"], 1)
        self.assertEqual(result["uniqueCompletedMainAgentRequests"], 1)

    def test_replay_autonomous_counts_exclude_manual_unknown_and_legacy_triggers(self):
        def run(request, executor="pi", trigger="return", progressed=True, created=1100):
            return {"requestId": request, "requestCreatedAt": created, "finishedAt": 1500,
                    "executor": executor, "trigger": trigger,
                    "outcome": "completed", "progressed": progressed}
        runs = [run("automatic-return"),
                run("automatic-followup", "mainAgent", "followup", progressed=False),
                run("shared"), run("shared", "mainAgent")]
        runs += [run(f"nonautomatic-{index}", trigger=trigger) for index, trigger in enumerate(
            ("message", "continue", "retry", "dismiss", "external", "unknown", None))]
        missing_trigger = run("missing-trigger")
        del missing_trigger["trigger"]
        runs += [missing_trigger, run("old-request", created=999),
                 run("undated-request", created=None), run("text", executor="text"),
                 {**run("failed"), "outcome": "error"}]
        records = [{"kind": "start", "schemaVersion": 3, "startedAt": 1000}]
        for at in [2000, 3000]:
            records.append({"kind": "sample", "observedAt": at, "pid": 1,
                            "processAlive": True, "autoEnabled": True, "workRuns": runs})
        records.append({"kind": "sample", "observedAt": 4000, "pid": 1,
                        "processAlive": True, "autoEnabled": True,
                        "workRuns": [{**runs[0], "outcome": "error"}]})
        result = observer.summarize_capture(self.capture(records))
        self.assertEqual(result["uniqueCompletedPiRequests"], 10)
        self.assertEqual(result["uniqueCompletedMainAgentRequests"], 2)
        self.assertEqual(result["uniqueCompletedTextRequests"], 1)
        self.assertEqual(result["uniqueCompletedToolCapableRequests"], 11)
        self.assertEqual(result["uniqueProgressedToolCapableRequests"], 10)
        self.assertEqual(result["uniqueCompletedAutonomousRequests"], 3)
        self.assertEqual(result["uniqueProgressedAutonomousRequests"], 2)
        self.assertFalse(result["atLeast24CompletedRequests"])
        self.assertFalse(result["goalAchieved"])

    def test_schema_two_and_three_replay_only_capture_time_and_gaps(self):
        for schema in (2, 3):
            records = [{"kind": "start", "schemaVersion": schema, "startedAt": 1000}]
            records += [{"kind": "sample", "observedAt": at, "pid": pid, "processAlive": pid > 0}
                        for at, pid in [(1100, 10), (2100, 0), (3100, 11)]]
            records += [{"kind": "summary", "elapsedSeconds": 999999,
                         "goalAchieved": True, "userQualityScore": 100}]
            with patch.object(observer.time, "time", side_effect=AssertionError("Current clock")):
                result = observer.summarize_capture(self.capture(records))
            self.assertEqual(result["elapsedSeconds"], 2.1)
            self.assertEqual(result["longestSamplingGapSeconds"], 1)
            self.assertEqual(result["processUnavailableSamples"], 1)
            self.assertEqual(result["pidChanges"], 2)
            self.assertEqual(result["captureSchemaVersion"], schema)
            self.assertFalse(result["twelveHourSampleWindow"])
            self.assertFalse(result["goalAchieved"])
            self.assertIsNone(result["userQualityScore"])

    def test_invalid_sequence_and_partial_tail_are_not_continuity_proof(self):
        start = {"kind": "start", "schemaVersion": 3, "startedAt": 1000}
        sample = {"kind": "sample", "observedAt": 43201000, "pid": 1, "processAlive": True}
        result = observer.summarize_capture(self.capture([start, sample], '{"kind":"sample"'))
        self.assertTrue(result["incompleteTrailingRecord"])
        self.assertFalse(result["twelveHourSampleWindow"])
        for records in [[sample], [start, start], [start, sample, {**sample, "observedAt": 2000}],
                        [start, {"kind": "summary"}, sample], [{**start, "schemaVersion": 1}]]:
            with self.assertRaises(ValueError):
                observer.summarize_capture(self.capture(records))

    def test_replay_rejects_invalid_present_operational_metadata(self):
        start = {"kind": "start", "schemaVersion": 3, "startedAt": 1000}
        sample = {"kind": "sample", "observedAt": 2000, "pid": 1, "processAlive": True}
        cases = [(key, value) for key in ("autoEnabled", "executionBlocked", "hasError")
                 for value in ("false", 0, None, [], {})]
        cases += [("revision", value) for value in (True, -1, "1", None)]
        cases += [("phase", value) for value in ("unknown", None, {})]
        for key, value in cases:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                observer.summarize_capture(self.capture([start, {**sample, key: value}]))
        # Schema 2/3 disk-only captures without optional fields stay readable.
        for schema in (2, 3):
            result = observer.summarize_capture(self.capture([
                {**start, "schemaVersion": schema}, sample]))
            self.assertEqual(result["samples"], 1)
        result = observer.summarize_capture(self.capture([start, {**sample,
            "autoEnabled": False, "executionBlocked": True, "hasError": True,
            "revision": 0, "phase": "error"}]))
        self.assertEqual(result["autoDisabledSamples"], 1)
        self.assertEqual(result["executionBlockedSamples"], 1)
        self.assertEqual(result["workerErrorSamples"], 1)

    def test_summary_cli_preserves_capture_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            capture = Path(folder) / "capture.jsonl"
            records = [{"kind": "start", "schemaVersion": 3, "startedAt": 1000},
                       {"kind": "sample", "observedAt": 2000, "pid": 1, "processAlive": True}]
            capture.write_text("".join(json.dumps(record) + "\n" for record in records))
            before = capture.read_bytes()
            result = subprocess.run([sys.executable, "-B", observer.__file__, "--summarize", str(capture)],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["elapsedSeconds"], 1)
            self.assertEqual(capture.read_bytes(), before)



import io


class McpReply(io.BytesIO):
    def __init__(self, body, content_type="text/event-stream", session=None):
        super().__init__(body)
        self.headers = {"Content-Type": content_type}
        if session:
            self.headers["Mcp-Session-Id"] = session


class McpFixture:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        message = json.loads(request.data)
        self.requests.append((message, dict(request.header_items()), timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response(message)


def mcp_reply(result, transport="sse", session=None):
    def respond(message):
        body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode()
        if transport == "sse":
            # Source-supported priming/keepalive records precede the RPC event.
            first, rest = body.split(b",", 1)
            body = b": keepalive\nid: 0\nretry: 1000\ndata:\n\nevent: message\ndata: " + first + b",\ndata: " + rest + b"\n\n"
        return McpReply(body, "text/event-stream" if transport == "sse" else "application/json", session)
    return respond


class LiveSnapshotTests(unittest.TestCase):
    @staticmethod
    def full_snapshot(persona="yori-ja", phase="error"):
        return {"personaId": persona, "revision": 412, "phase": phase,
                "error": "PRIVATE_ERROR_BODY" if phase == "error" else None,
                "messages": [{"content": "PRIVATE_CONVERSATION"}],
                "personaPrompt": "PRIVATE_PROMPT"}

    @staticmethod
    def disk():
        return {"observedAt": 2000, "pid": 1, "processAlive": True, "personaId": "yori-ja",
                "revision": 412, "phase": "working", "hasError": False, "autoEnabled": True}

    def test_source_supported_sse_and_json_handshake_and_metadata_projection(self):
        for transport in ("sse", "json"):
            with self.subTest(transport=transport):
                tool = {"content": [{"type": "text", "text": json.dumps(self.full_snapshot())}]}
                fixture = McpFixture([
                    mcp_reply({"protocolVersion": "2025-11-25"}, transport, "session-owned" if transport == "sse" else None),
                    lambda message: McpReply(b"", "application/json"),
                    mcp_reply(tool, transport), mcp_reply(tool, transport)])
                client = observer.LiveMcpSnapshot("http://127.0.0.1:18743/mcp", opener=fixture)
                metadata = client.snapshot()
                self.assertEqual(metadata, {"personaId": "yori-ja", "revision": 412,
                                            "phase": "error", "hasError": True})
                self.assertNotIn("PRIVATE", json.dumps(metadata))
                self.assertEqual(client.snapshot(), metadata)
                self.assertEqual([r[0]["method"] for r in fixture.requests],
                                 ["initialize", "notifications/initialized", "tools/call", "tools/call"])
                self.assertEqual(fixture.requests[2][0]["params"],
                                 {"name": "continuity_context", "arguments": {}})
                self.assertLessEqual(fixture.requests[0][2], 1)
                if transport == "sse":
                    self.assertEqual(fixture.requests[2][1].get("Mcp-session-id"), "session-owned")

    def test_memory_error_same_revision_as_working_disk_is_counted_without_private_text(self):
        metadata = observer.snapshot_metadata(self.full_snapshot("yori-en"))
        metadata["messages"] = "PRIVATE_SHOULD_BE_DROPPED"
        client = type("Client", (), {"snapshot": lambda self: metadata})()
        observation = self.disk()
        observer.attach_live_snapshot(observation, client)
        self.assertEqual(observation["liveVerification"]["status"], "verified")
        self.assertTrue(observation["liveVerification"]["sourceMismatch"])
        self.assertNotIn("PRIVATE", json.dumps(observation))
        evidence = observer.Evidence(1000)
        evidence.add(observation)
        result = evidence.summary(1)
        self.assertEqual(result["workerErrorSamples"], 1)
        self.assertEqual(result["diskWorkerErrorSamples"], 0)
        self.assertEqual(result["liveWorkerErrorSamples"], 1)
        self.assertEqual(result["liveDiskMismatchSamples"], 1)

    def test_unknown_live_and_persona_mismatch_never_borrow_healthy_or_error_state(self):
        for failure in (observer.urllib.error.URLError("PRIVATE_URL_ERROR"),
                        observer.LiveObservationError("PRIVATE_EXCEPTION")):
            fixture = McpFixture([failure])
            client = observer.LiveMcpSnapshot("http://127.0.0.1:18743/mcp", opener=fixture)
            observation = self.disk()
            observer.attach_live_snapshot(observation, client)
            self.assertEqual(observation["liveVerification"]["status"], "unknown")
            self.assertNotIn("PRIVATE", json.dumps(observation))
        other = observer.snapshot_metadata(self.full_snapshot("other-persona", "idle"))
        observation = self.disk()
        observer.attach_live_snapshot(observation, type("Client", (), {"snapshot": lambda self: other})())
        self.assertEqual(observation["liveVerification"]["reason"], "personaMismatch")
        self.assertEqual(observation["phase"], "working")
        evidence = observer.Evidence(1000)
        evidence.add(observation)
        summary = evidence.summary(1)
        self.assertEqual(summary["liveUnknownSamples"], 1)
        self.assertEqual(summary["livePersonaMismatchSamples"], 1)
        self.assertEqual(summary["liveVerifiedSamples"], 0)

    def test_explicit_404_restarts_readonly_handshake_next_sample_only(self):
        tool = {"content": [{"type": "text", "text": json.dumps(self.full_snapshot())}]}
        missing = observer.urllib.error.HTTPError("http://127.0.0.1/mcp", 404, "PRIVATE", {}, None)
        fixture = McpFixture([mcp_reply({"protocolVersion": "2025-11-25"}, session="old"),
            lambda message: McpReply(b""), mcp_reply(tool), missing,
            mcp_reply({"protocolVersion": "2025-11-25"}, session="new"),
            lambda message: McpReply(b""), mcp_reply(tool)])
        client = observer.LiveMcpSnapshot("http://127.0.0.1:18743/mcp", opener=fixture)
        client.snapshot()
        with self.assertRaises(observer.LiveObservationError):
            client.snapshot()
        self.assertEqual(len(fixture.requests), 4)
        self.assertFalse(client.initialized)
        client.snapshot()
        self.assertEqual(len(fixture.requests), 7)
        self.assertEqual(fixture.requests[4][0]["method"], "initialize")

    def test_response_size_deadline_and_remote_endpoint_rejection_are_bounded(self):
        response = McpReply(b"x" * 100, "application/json")
        with self.assertRaisesRegex(observer.LiveObservationError, "responseTooLarge"):
            observer.read_rpc_response(response, "x", observer.time.monotonic() + 1, maximum=10)
        with self.assertRaisesRegex(observer.LiveObservationError, "timeout"):
            observer.read_rpc_response(McpReply(b""), "x", 0)
        for url in ("https://example.com/mcp", "http://example.com/mcp",
                    "http://user:PRIVATE_PASSWORD@127.0.0.1/mcp"):
            with self.assertRaises(ValueError):
                observer.validate_live_url(url)
        cli = subprocess.run([sys.executable, "-B", observer.__file__,
                              "--live-mcp-url", "http://user:PRIVATE_PASSWORD@127.0.0.1/mcp"],
                             capture_output=True, text=True, timeout=5)
        self.assertNotEqual(cli.returncode, 0)
        self.assertNotIn("PRIVATE_PASSWORD", cli.stderr)

    def test_capture_replay_keeps_live_unknown_and_disk_only_samples_unverified(self):
        verified = self.disk()
        metadata = observer.snapshot_metadata(self.full_snapshot())
        observer.attach_live_snapshot(verified, type("Client", (), {"snapshot": lambda self: metadata})())
        unknown = {**self.disk(), "observedAt": 3000,
                   "liveVerification": {"status": "unknown", "reason": "unavailable"}}
        disk_only = {**self.disk(), "observedAt": 4000}
        records = [{"kind": "start", "schemaVersion": 3, "startedAt": 1000}]
        records += [{"kind": "sample", **record} for record in (verified, unknown, disk_only)]
        raw = "".join(json.dumps(record) + "\n" for record in records)
        capture = type("Capture", (), {"open": lambda *args, **kwargs: io.StringIO(raw)})()
        summary = observer.summarize_capture(capture)
        self.assertEqual(summary["workerErrorSamples"], 1)
        self.assertEqual(summary["liveVerifiedSamples"], 1)
        self.assertEqual(summary["liveUnknownSamples"], 1)
        self.assertEqual(summary["liveUnverifiedSamples"], 2)
        self.assertFalse(summary["goalAchieved"])
        self.assertIsNone(summary["userQualityScore"])

    def test_sample_integrates_disk_and_live_metadata_without_logging_private_body(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"autoEnabled": True, "snapshot": {
                "personaId": "yori-ja", "revision": 412, "phase": "working", "error": None,
                "messages": [{"content": "PRIVATE_DISK_BODY"}]}}))
            metadata = observer.snapshot_metadata(self.full_snapshot())
            client = type("Client", (), {"snapshot": lambda self: metadata})()
            observation = observer.sample(state, os.getpid(), client)
            self.assertEqual(observation["phase"], "working")
            self.assertEqual(observation["liveVerification"]["snapshot"]["phase"], "error")
            self.assertTrue(observation["liveVerification"]["sourceMismatch"])
            self.assertNotIn("PRIVATE", json.dumps(observation))

    def test_timeout_remains_unknown_and_reuses_same_session_without_restart_assumption(self):
        tool = {"content": [{"type": "text", "text": json.dumps(self.full_snapshot())}]}
        fixture = McpFixture([mcp_reply({"protocolVersion": "2025-11-25"}, session="owned"),
            lambda message: McpReply(b""), mcp_reply(tool), TimeoutError("PRIVATE_TIMEOUT"),
            mcp_reply(tool)])
        client = observer.LiveMcpSnapshot("http://127.0.0.1:18743/mcp", opener=fixture)
        client.snapshot()
        observation = self.disk()
        observer.attach_live_snapshot(observation, client)
        self.assertEqual(observation["liveVerification"]["status"], "unknown")
        self.assertTrue(client.initialized)
        self.assertEqual(client.session, "owned")
        client.snapshot()
        self.assertEqual([r[0]["method"] for r in fixture.requests].count("initialize"), 1)
        self.assertNotIn("PRIVATE", json.dumps(observation))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Read-only, bounded continuity observation. Never dispatches work or restarts apps.

Example: python3 scripts/observe-continuity-soak.py --pid 123 --output soak.jsonl
Use --pid-file for a file maintained by the launcher when the app restarts.
Use --executable with an absolute native executable path to observe restarts.
The JSONL includes no conversation, persona prompt, draft content or error text.
Samples cannot prove uninterrupted execution between observations or user quality.
Replay an existing capture without writing it: --summarize capture.jsonl
Optional --live-mcp-url http://127.0.0.1:18743/mcp verifies native memory through
the local read-only continuity_context tool. It sends the required MCP handshake,
accepts rmcp SSE/direct JSON, and projects only persona/revision/phase/error presence.
Each attempt has a three-second deadline with at most one extra second of socket
read granularity and a 2 MiB response limit. Failure is unknown, never app-stopped.
Disk/live differences can also reflect sampling time; the endpoint is not proof
of a particular native PID or loaded code. Old disk-only logs remain unverified.
"""

import argparse
import ctypes
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LIVE_MAX_BYTES = 2 * 1024 * 1024


class LiveObservationError(Exception):
    """Fixed diagnostic category only: never retain a private response body."""


def validate_live_url(url):
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost", "::1") or
            parts.username is not None or parts.password is not None or parts.query or parts.fragment):
        raise ValueError("Live MCP endpoint must be a local HTTP URL without credentials")
    return url


def live_url_argument(value):
    try:
        return validate_live_url(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Use a local HTTP MCP endpoint without credentials") from None


def read_rpc_response(response, request_id, deadline, maximum=LIVE_MAX_BYTES):
    """rmcp Streamable HTTP defaults to SSE, optionally supports direct JSON."""
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    used = 0
    def chunks():
        nonlocal used
        while True:
            if time.monotonic() >= deadline:
                raise LiveObservationError("timeout")
            # HTTPResponse.read1 makes at most one buffered socket read. A full
            # read/readline could wait forever for a trickling SSE line/body.
            reader = getattr(response, "read1", None)
            chunk = reader(min(4096, maximum - used + 1)) if reader else response.read(1)
            used += len(chunk)
            if used > maximum:
                raise LiveObservationError("responseTooLarge")
            if not chunk:
                return
            yield chunk
    def check(message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            raise LiveObservationError("invalidResponse")
        if message.get("id") != request_id:
            return None
        if "error" in message:
            raise LiveObservationError("rpcError")
        if "result" not in message:
            raise LiveObservationError("invalidResponse")
        return message["result"]
    try:
        if content_type == "application/json":
            data = b"".join(chunks())
            result = check(json.loads(data))
            if result is None:
                raise LiveObservationError("invalidResponse")
            return result
        if content_type != "text/event-stream":
            raise LiveObservationError("unsupportedTransport")
        data = []
        buffered = b""
        for chunk in chunks():
            buffered += chunk
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                line = line.rstrip(b"\r")
                if line.startswith(b"data:"):
                    value = line[5:]
                    data.append(value[1:] if value.startswith(b" ") else value)
                elif not line:
                    if data and b"\n".join(data).strip():
                        result = check(json.loads(b"\n".join(data)))
                        if result is not None:
                            return result
                    data = []  # Empty SSE priming events and keepalive comments.
        raise LiveObservationError("incompleteResponse")
    except (ValueError, UnicodeError):
        raise LiveObservationError("invalidResponse") from None


def snapshot_metadata(value):
    if (not isinstance(value, dict) or not isinstance(value.get("personaId"), str) or
            not value["personaId"] or len(value["personaId"]) > 256 or
            type(value.get("revision")) is not int or value["revision"] < 0 or
            value.get("phase") not in ("idle", "thinking", "drafting", "working", "error") or
            "error" not in value or (value["error"] is not None and not isinstance(value["error"], str))):
        raise LiveObservationError("invalidSnapshot")
    return {"personaId": value["personaId"], "revision": value["revision"],
            "phase": value["phase"], "hasError": value["error"] is not None}


def persona_identity(value):
    return "builtin:yori" if value in ("yori-ja", "yori-en") else value


def valid_live_metadata(value):
    return (isinstance(value, dict) and isinstance(value.get("personaId"), str) and
            0 < len(value["personaId"]) <= 256 and type(value.get("revision")) is int and
            value["revision"] >= 0 and type(value.get("hasError")) is bool and
            value.get("phase") in ("idle", "thinking", "drafting", "working", "error"))


class LiveMcpSnapshot:
    """One cached read-only MCP session; timeout never implies app/work stopped.

    Source: src-tauri/src/mcp/server.rs and rmcp 1.7 tower.rs. Only initialize,
    notifications/initialized and tools/call continuity_context are sent.
    """
    def __init__(self, url, timeout=3, opener=None):
        self.url = validate_live_url(url)
        self.timeout = timeout
        self.session = None
        self.protocol = "2025-11-25"
        self.initialized = False
        self.handshake_received = False
        self.sequence = 0
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise LiveObservationError("redirectRefused")
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _post(self, message, deadline, notification=False):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LiveObservationError("timeout")
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": self.protocol}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        request = urllib.request.Request(self.url, json.dumps(message).encode(), headers=headers, method="POST")
        try:
            with self.opener.open(request, timeout=min(1, remaining)) as response:
                if notification:
                    return None
                result = read_rpc_response(response, message["id"], deadline)
                if message["method"] == "initialize":
                    self.session = response.headers.get("Mcp-Session-Id")
                return result
        except urllib.error.HTTPError as error:
            if error.code in (404, 410):
                self.session = None
                self.initialized = False
                self.handshake_received = False
            raise LiveObservationError("httpError") from None
        except (TimeoutError, OSError, urllib.error.URLError):
            raise LiveObservationError("unavailable") from None

    def snapshot(self):
        deadline = time.monotonic() + self.timeout
        if not self.initialized:
            if not self.handshake_received:
                result = self._post({"jsonrpc": "2.0", "id": "initialize", "method": "initialize",
                    "params": {"protocolVersion": self.protocol, "capabilities": {},
                               "clientInfo": {"name": "yorishiro_readonly_observer", "version": "1"}}}, deadline)
                if not isinstance(result, dict) or not isinstance(result.get("protocolVersion"), str):
                    raise LiveObservationError("invalidResponse")
                self.protocol = result["protocolVersion"]
                self.handshake_received = True
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, deadline, notification=True)
            self.initialized = True
        self.sequence += 1
        result = self._post({"jsonrpc": "2.0", "id": f"snapshot-{self.sequence}", "method": "tools/call",
            "params": {"name": "continuity_context", "arguments": {}}}, deadline)
        if not isinstance(result, dict) or result.get("isError") is True:
            raise LiveObservationError("toolError")
        if isinstance(result.get("structuredContent"), dict):
            return snapshot_metadata(result["structuredContent"])
        content = result.get("content")
        if (not isinstance(content, list) or len(content) != 1 or
                not isinstance(content[0], dict) or content[0].get("type") != "text"):
            raise LiveObservationError("invalidSnapshot")
        try:
            return snapshot_metadata(json.loads(content[0]["text"]))
        except (ValueError, KeyError, TypeError):
            raise LiveObservationError("invalidSnapshot") from None


def attach_live_snapshot(observed, live_client):
    try:
        metadata = live_client.snapshot()
        if not valid_live_metadata(metadata):
            raise LiveObservationError("invalidSnapshot")
        metadata = {key: metadata[key] for key in ("personaId", "revision", "phase", "hasError")}
        disk_persona = observed.get("personaId")
        if not isinstance(disk_persona, str):
            observed["liveVerification"] = {"status": "unknown", "reason": "diskIdentityUnknown"}
        elif persona_identity(metadata["personaId"]) != persona_identity(disk_persona):
            observed["liveVerification"] = {"status": "unknown", "reason": "personaMismatch"}
        else:
            observed["liveVerification"] = {"status": "verified", "snapshot": metadata,
                "sourceMismatch": any(metadata.get(key) != observed.get(key)
                                      for key in ("revision", "phase", "hasError"))}
    except LiveObservationError as error:
        reason = str(error)
        if reason not in {"invalidResponse", "rpcError", "responseTooLarge", "timeout",
                "unsupportedTransport", "incompleteResponse", "invalidSnapshot", "redirectRefused",
                "httpError", "unavailable", "toolError"}:
            reason = "unavailable"
        observed["liveVerification"] = {"status": "unknown", "reason": reason}
    except Exception:
        observed["liveVerification"] = {"status": "unknown", "reason": "unavailable"}


def positive_number(value):
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return value


def probe_process(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_executable_paths():
    """Read kernel executable paths only; never inspect command arguments."""
    if sys.platform == "darwin":
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        libproc.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libproc.proc_listallpids.restype = ctypes.c_int
        libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        libproc.proc_pidpath.restype = ctypes.c_int
        count = libproc.proc_listallpids(None, 0)
        if count <= 0:
            raise OSError("Could not enumerate processes")
        # Retry if process creation filled the buffer during enumeration.
        for _ in range(3):
            pids = (ctypes.c_int * (count + 128))()
            returned = libproc.proc_listallpids(pids, ctypes.sizeof(pids))
            if returned <= 0:
                raise OSError("Could not enumerate processes")
            if returned < len(pids):
                break
            count = returned * 2
        else:
            raise OSError("Process enumeration was truncated")
        for pid in pids[:returned]:
            path = ctypes.create_string_buffer(4096)
            length = libproc.proc_pidpath(pid, path, len(path))
            if length > 0:
                yield pid, os.fsdecode(path.value)
    elif sys.platform.startswith("linux"):
        for entry in Path("/proc").iterdir():
            if entry.name.isdecimal():
                try:
                    yield int(entry.name), os.readlink(entry / "exe")
                except OSError:
                    continue
    else:
        raise OSError("Executable discovery is unsupported on this platform")


def resolve_executable(executable):
    """Return zero on missing, ambiguous or failed resolution; never pick a guess."""
    try:
        expected = executable.resolve(strict=True)
        matches = {pid for pid, path in process_executable_paths()
                   if Path(path).is_absolute() and Path(path).resolve() == expected}
        if len(matches) == 1:
            return next(iter(matches)), "matched"
        return 0, "ambiguous" if matches else "missing"
    except (OSError, ValueError, RuntimeError):
        return 0, "resolverError"


def sample(state_path, pid, live_client=None):
    observed = {"kind": "sample", "observedAt": int(time.time() * 1000),
                "pid": pid, "processAlive": probe_process(pid)}
    try:
        saved = json.loads(state_path.read_text())
        if not isinstance(saved, dict) or not isinstance(saved.get("snapshot"), dict):
            raise ValueError("Invalid state structure")
        snapshot = saved["snapshot"]
        if (type(snapshot.get("revision")) is not int or snapshot["revision"] < 0 or
                snapshot.get("phase") not in ("idle", "thinking", "drafting", "working", "error") or
                (snapshot.get("error") is not None and
                 not isinstance(snapshot["error"], str)) or
                any(type(saved.get(key, False)) is not bool
                    for key in ("autoEnabled", "executionBlocked"))):
            raise ValueError("Invalid operational metadata")
        runs = saved.get("workRuns", [])
        if not isinstance(runs, list) or not all(isinstance(run, dict) for run in runs):
            raise ValueError("Invalid work run structure")
        observed.update(revision=snapshot["revision"], phase=snapshot["phase"],
                        personaId=snapshot.get("personaId"),
                        hasError=snapshot.get("error") is not None,
                        autoEnabled=saved.get("autoEnabled", False),
                        executionBlocked=saved.get("executionBlocked", False))
        # Copy only operational metadata, never text supplied by the model/user.
        observed["workRuns"] = [
            {key: run.get(key) for key in (
                "requestId", "requestCreatedAt", "startedAt", "finishedAt", "trigger", "executor",
                "outcome", "progressed")}
            for run in runs
        ]
    except (OSError, ValueError, KeyError, TypeError) as error:
        observed["stateReadError"] = type(error).__name__
    if live_client is not None:
        attach_live_snapshot(observed, live_client)
    return observed


class Evidence:
    def __init__(self, started_at):
        self.started_at = started_at
        self.samples = 0
        self.unavailable = 0
        self.state_errors = 0
        self.worker_errors = 0
        self.disk_worker_errors = 0
        self.live_worker_errors = 0
        self.live_requested = 0
        self.live_verified = 0
        self.live_unknown = 0
        self.live_mismatches = 0
        self.live_persona_mismatches = 0
        self.disabled = 0
        self.blocked = 0
        self.pids = set()
        self.runs = {}
        self.first_at = None
        self.last_at = None
        self.longest_gap_ms = 0
        self.previous_pid = None
        self.pid_changes = 0

    def add(self, observation):
        pid = observation["pid"]
        observation["previousPid"] = self.previous_pid
        observation["pidChanged"] = self.previous_pid is not None and self.previous_pid != pid
        self.pid_changes += observation["pidChanged"]
        self.previous_pid = pid
        self.samples += 1
        at = observation["observedAt"]
        if self.first_at is None:
            self.first_at = at
        if self.last_at is not None:
            self.longest_gap_ms = max(self.longest_gap_ms, at - self.last_at)
        self.last_at = at
        self.unavailable += not observation["processAlive"]
        self.state_errors += "stateReadError" in observation
        disk_error = observation.get("hasError", False) or observation.get("phase") == "error"
        self.disk_worker_errors += bool(disk_error)
        live = observation.get("liveVerification")
        live_error = False
        if isinstance(live, dict):
            self.live_requested += 1
            metadata = live.get("snapshot")
            verified = (live.get("status") == "verified" and valid_live_metadata(metadata) and
                isinstance(observation.get("personaId"), str) and
                persona_identity(metadata["personaId"]) == persona_identity(observation["personaId"]))
            if verified:
                self.live_verified += 1
                self.live_mismatches += any(metadata.get(key) != observation.get(key)
                    for key in ("revision", "phase", "hasError"))
                live_error = metadata["hasError"] or metadata["phase"] == "error"
            else:
                self.live_unknown += 1
                self.live_persona_mismatches += live.get("reason") == "personaMismatch"
        self.live_worker_errors += bool(live_error)
        self.worker_errors += bool(disk_error or live_error)
        self.disabled += not observation.get("autoEnabled", False)
        self.blocked += bool(observation.get("executionBlocked"))
        if observation["processAlive"]:
            self.pids.add(observation["pid"])
        for run in observation.get("workRuns", []):
            # Recovery observation times do not establish when work began.
            # Legacy requests without original creation evidence are excluded.
            start, finish, request = (run.get(key) for key in (
                "requestCreatedAt", "finishedAt", "requestId"))
            if (isinstance(request, str) and request and
                    type(start) is int and type(finish) is int and
                    self.started_at <= start <= finish <= at):
                executor = run.get("executor")
                key = (executor if isinstance(executor, str) else "unknown", request)
                previous = self.runs.get(key)
                # Receipt-recovery errors do not erase an already observed
                # completed request, and repeated receipts count only once.
                if previous and previous.get("outcome") == "completed":
                    if run.get("outcome") != "completed":
                        continue
                    if previous.get("progressed") is True:
                        run = {**run, "progressed": True}
                self.runs[key] = run

    def summary(self, elapsed_seconds):
        backend_counts = {}
        for backend in ("pi", "mainAgent", "text"):
            runs = [r for (executor, _), r in self.runs.items() if executor == backend]
            completed = [r for r in runs if r.get("outcome") == "completed"]
            backend_counts[backend] = {
                "uniqueObservedRequests": len(runs),
                "uniqueCompletedRequests": len(completed),
                "uniqueProgressedRequests": sum(r.get("progressed") is True for r in completed),
            }
        completed_ids = {request for (executor, request), r in self.runs.items()
                         if executor in ("pi", "mainAgent") and r.get("outcome") == "completed"}
        progressed_ids = {request for (executor, request), r in self.runs.items()
                          if executor in ("pi", "mainAgent") and
                          r.get("outcome") == "completed" and r.get("progressed") is True}
        # Tool-capable completion is not evidence of an autonomous cycle.
        # Unknown/legacy triggers cannot establish that the scheduler ran it.
        autonomous_completed_ids = {request for (executor, request), r in self.runs.items()
            if executor in ("pi", "mainAgent") and r.get("outcome") == "completed" and
            r.get("trigger") in ("return", "followup")}
        autonomous_progressed_ids = {request for (executor, request), r in self.runs.items()
            if executor in ("pi", "mainAgent") and r.get("outcome") == "completed" and
            r.get("trigger") in ("return", "followup") and r.get("progressed") is True}
        return {"kind": "summary", "startedAt": self.started_at,
                "elapsedSeconds": elapsed_seconds, "samples": self.samples,
                "sampledWindowSeconds": ((self.last_at or 0) - (self.first_at or 0)) / 1000,
                "longestSamplingGapSeconds": self.longest_gap_ms / 1000,
                "processUnavailableSamples": self.unavailable,
                "stateReadErrorSamples": self.state_errors,
                "workerErrorSamples": self.worker_errors,
                "diskWorkerErrorSamples": self.disk_worker_errors,
                "liveWorkerErrorSamples": self.live_worker_errors,
                "liveVerificationRequestedSamples": self.live_requested,
                "liveVerifiedSamples": self.live_verified,
                "liveUnknownSamples": self.live_unknown,
                "liveUnverifiedSamples": self.samples - self.live_verified,
                "liveDiskMismatchSamples": self.live_mismatches,
                "livePersonaMismatchSamples": self.live_persona_mismatches,
                "autoDisabledSamples": self.disabled,
                "executionBlockedSamples": self.blocked,
                "observedPids": sorted(self.pids),
                "pidChanges": self.pid_changes,
                "backendCounts": backend_counts,
                "uniqueCompletedMainAgentRequests": backend_counts["mainAgent"]["uniqueCompletedRequests"],
                "uniqueProgressedMainAgentRequests": backend_counts["mainAgent"]["uniqueProgressedRequests"],
                "uniqueCompletedPiRequests": backend_counts["pi"]["uniqueCompletedRequests"],
                "uniqueProgressedPiRequests": backend_counts["pi"]["uniqueProgressedRequests"],
                "uniqueCompletedTextRequests": backend_counts["text"]["uniqueCompletedRequests"],
                "uniqueProgressedTextRequests": backend_counts["text"]["uniqueProgressedRequests"],
                "uniqueCompletedToolCapableRequests": len(completed_ids),
                "uniqueProgressedToolCapableRequests": len(progressed_ids),
                "uniqueCompletedAutonomousRequests": len(autonomous_completed_ids),
                "uniqueProgressedAutonomousRequests": len(autonomous_progressed_ids),
                "uniqueObservedRequests": len({request for _, request in self.runs}),
                "twelveHourSampleWindow": bool(self.first_at is not None and
                    self.last_at - self.first_at >= 12 * 60 * 60 * 1000),
                "atLeast24CompletedRequests": len(autonomous_completed_ids) >= 24,
                "uninterruptedExecutionProven": False,
                "crashRecoveryProven": False,
                "userQualityScore": None,
                "goalAchieved": False}


def summarize_capture(path):
    """Replay only captured samples; wall-clock time and saved summary claims are ignored."""
    evidence = None
    schema = None
    final_summary = False
    trailing_partial = False
    with path.open("r", encoding="utf-8") as capture:
        for line in capture:
            if not line.endswith("\n"):
                trailing_partial = True
                break
            try:
                record = json.loads(line)
            except ValueError as error:
                raise ValueError("Capture contains invalid JSON") from error
            if not isinstance(record, dict):
                raise ValueError("Capture record must be an object")
            kind = record.get("kind")
            if evidence is None:
                schema = record.get("schemaVersion")
                started = record.get("startedAt")
                if kind != "start" or schema not in (2, 3) or type(started) is not int or started < 0:
                    raise ValueError("A schema 2/3 start record with a captured timestamp is required")
                evidence = Evidence(started)
            elif kind == "sample" and not final_summary:
                at, pid, alive = (record.get(key) for key in ("observedAt", "pid", "processAlive"))
                if (type(at) is not int or at < evidence.started_at or
                        (evidence.last_at is not None and at < evidence.last_at) or
                        type(pid) is not int or pid < 0 or type(alive) is not bool or
                        (alive and pid == 0) or not isinstance(record.get("workRuns", []), list) or
                        not all(isinstance(run, dict) for run in record.get("workRuns", []))):
                    raise ValueError("Invalid or out-of-order captured sample")
                # Legacy captures may omit metadata, but present values must
                # not turn strings such as "false" into healthy boolean flags.
                if (any(key in record and type(record[key]) is not bool
                        for key in ("autoEnabled", "executionBlocked", "hasError")) or
                        ("revision" in record and
                         (type(record["revision"]) is not int or record["revision"] < 0)) or
                        ("phase" in record and record["phase"] not in
                         ("idle", "thinking", "drafting", "working", "error"))):
                    raise ValueError("Invalid captured operational metadata")
                evidence.add(record)
            elif kind == "summary" and not final_summary:
                final_summary = True  # Do not use its counts, elapsed time, or success claims.
            else:
                raise ValueError("Unexpected or repeated capture record")
    if evidence is None:
        raise ValueError("Capture has no complete start record")
    elapsed = ((evidence.last_at - evidence.started_at) / 1000
               if evidence.last_at is not None else 0)
    return {**evidence.summary(elapsed), "captureSchemaVersion": schema,
            "captureFinalSummaryPresent": final_summary,
            "incompleteTrailingRecord": trailing_partial,
            "captureLastObservedAt": evidence.last_at,
            "timeSource": "capturedSamples"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summarize", type=Path)
    parser.add_argument("--live-mcp-url", type=live_url_argument)
    parser.add_argument("--state", type=Path, default=Path.home() /
                        ".yorishiro/continuity/builtin/yori/state.json")
    identity = parser.add_mutually_exclusive_group()
    identity.add_argument("--pid", type=int)
    identity.add_argument("--pid-file", type=Path)
    identity.add_argument("--executable", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--duration-seconds", type=positive_number, default=43200)
    parser.add_argument("--interval-seconds", type=positive_number, default=30)
    args = parser.parse_args()
    if args.summarize is not None:
        if args.output is not None or args.live_mcp_url is not None or any(value is not None for value in
                (args.pid, args.pid_file, args.executable)):
            parser.error("--summarize reads an existing capture without process selection or --output")
        try:
            result = summarize_capture(args.summarize)
        except (OSError, ValueError):
            parser.exit(2, "Cannot summarize capture: missing, unsupported, or invalid evidence\n")
        print(json.dumps(result, ensure_ascii=False))
        return
    if args.output is None or all(value is None for value in
            (args.pid, args.pid_file, args.executable)):
        parser.error("Capture requires --output and one process selection")
    if args.pid is not None and args.pid <= 0:
        parser.error("--pid must be positive")
    if args.executable is not None and not args.executable.is_absolute():
        parser.error("--executable must be an absolute path")
    live_client = LiveMcpSnapshot(args.live_mcp_url) if args.live_mcp_url else None
    # An existing log is evidence and must never be overwritten.
    with args.output.open("x", encoding="utf-8") as output:
        def write(value):
            output.write(json.dumps(value, ensure_ascii=False) + "\n")
            output.flush()
            os.fsync(output.fileno())

        start = time.monotonic()
        evidence = Evidence(int(time.time() * 1000))
        write({"kind": "start", "schemaVersion": 3, "startedAt": evidence.started_at,
               "durationSeconds": args.duration_seconds,
               "liveVerificationRequested": live_client is not None,
               "intervalSeconds": args.interval_seconds,
               "processSelection": "executable" if args.executable is not None else
                   "pidFile" if args.pid_file is not None else "pid"})
        try:
            while True:
                resolution = None
                try:
                    if args.executable is not None:
                        pid, resolution = resolve_executable(args.executable)
                    else:
                        pid = args.pid if args.pid is not None else int(args.pid_file.read_text().strip())
                except (OSError, ValueError):
                    pid = 0
                observation = sample(args.state, pid, live_client)
                if resolution is not None:
                    observation["executableResolution"] = resolution
                evidence.add(observation)
                write(observation)
                remaining = args.duration_seconds - (time.monotonic() - start)
                if remaining <= 0:
                    break
                time.sleep(min(args.interval_seconds, remaining))
        except KeyboardInterrupt:
            pass
        result = evidence.summary(time.monotonic() - start)
        write(result)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

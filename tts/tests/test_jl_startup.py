"""Exercise the JL boot script without GPUs or touching a running deployment."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "jl-start.sh"


class JLStartupTest(unittest.TestCase):
    def run_startup(self, running=False, missing_file=False):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            root = home / "tts-prod"
            for name in ("tts-prod/.venv/bin/python", "tts-prod/.env",
                         "tts-prod/deploy/voxcpm2.yaml", "tts-l4-benchmark/.venv/bin/vllm"):
                file = home / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.touch()
            (root / "backend.log").write_text("old backend log\n")
            if missing_file:
                (root / ".env").unlink()
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            for name, body in {
                "flock": "exit 0",  # Linux flock is checked on JL; unavailable on macOS.
                "pgrep": 'exit "$MOCK_PGREP_EXIT"',
                "nohup": 'printf "%s\\n" "$*" >> "$MOCK_STARTS"',
            }.items():
                file = bin_dir / name
                file.write_text("#!/bin/sh\n" + body + "\n")
                file.chmod(0o755)
            (home / "vector-start.sh").write_text('echo vector >> "$MOCK_STARTS"\n')
            script = Path(tmp) / "start.sh"
            script.write_text(SCRIPT.read_text().replace("/home/", f"{home}/")
                              .replace("/srv/tts", f"{tmp}/srv/tts") + "\nwait\n")
            starts = Path(tmp) / "starts"
            result = subprocess.run(["sh", str(script)], capture_output=True, text=True,
                                    env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                                         "MOCK_PGREP_EXIT": "0" if running else "1",
                                         "MOCK_STARTS": str(starts)}, timeout=10)
            return (result, starts.read_text() if starts.exists() else "",
                    [p.name for p in (root / "logs").glob("*")],
                    (root / "backend.log").read_text())

    def test_boot_starts_services_and_preserves_logs(self):
        result, starts, logs, _ = self.run_startup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("vllm serve openbmb/VoxCPM2", starts)
        self.assertIn("uvicorn app.main:app", starts)
        self.assertIn("vector", starts)
        self.assertTrue(any(name.startswith("backend-before-") for name in logs))
        self.assertTrue(any(name.startswith("proxy-") for name in logs))

    def test_running_services_are_not_restarted(self):
        result, starts, logs, old_log = self.run_startup(running=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(starts, "")
        self.assertEqual(logs, [])
        self.assertEqual(old_log, "old backend log\n")

    def test_missing_deployment_fails_before_starting(self):
        result, starts, _, _ = self.run_startup(missing_file=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing TTS deployment file", result.stderr)
        self.assertEqual(starts, "")


if __name__ == "__main__":
    unittest.main()

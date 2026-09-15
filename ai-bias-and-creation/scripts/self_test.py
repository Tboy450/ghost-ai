#!/usr/bin/env python3
"""Regression checks for local pack scripts."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SelfTestError(Exception):
    pass


@dataclass
class CommandCase:
    name: str
    command: list[str]
    expected_returncode: int
    expected_stdout: str | None = None
    expected_stderr: str | None = None


def run_case(case: CommandCase) -> None:
    completed = subprocess.run(
        case.command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    if completed.returncode != case.expected_returncode:
        raise SelfTestError(
            f"{case.name}: expected exit {case.expected_returncode}, "
            f"got {completed.returncode}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )

    if case.expected_stdout and case.expected_stdout not in completed.stdout:
        raise SelfTestError(
            f"{case.name}: stdout missing {case.expected_stdout!r}\n{completed.stdout}"
        )

    if case.expected_stderr and case.expected_stderr not in completed.stderr:
        raise SelfTestError(
            f"{case.name}: stderr missing {case.expected_stderr!r}\n{completed.stderr}"
        )


def write_weak_response(directory: Path) -> Path:
    path = directory / "weak_response.md"
    path.write_text(
        "\n".join(
            [
                "# Weak Response",
                "",
                "Central claim:",
                "The claim is probably complicated.",
                "",
                "Bottom line:",
                "More nuance is needed.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return path


def main() -> int:
    with tempfile.TemporaryDirectory() as temp_dir_name:
        weak_response = write_weak_response(Path(temp_dir_name))

        cases = [
            CommandCase(
                name="reference responses pass threshold",
                command=[
                    sys.executable,
                    "scripts/score_response.py",
                    "tests/reference_responses.md",
                    "--min-score",
                    "16",
                ],
                expected_returncode=0,
                expected_stdout="Test A: Autism Spectrum: 18/18",
            ),
            CommandCase(
                name="weak response fails threshold",
                command=[
                    sys.executable,
                    "scripts/score_response.py",
                    str(weak_response),
                    "--min-score",
                    "16",
                ],
                expected_returncode=1,
                expected_stdout="response:",
                expected_stderr="FAIL: response scored",
            ),
        ]

        for case in cases:
            run_case(case)

    print("script self-tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

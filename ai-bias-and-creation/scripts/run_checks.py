#!/usr/bin/env python3
"""Run validation and scoring checks for the stress-test pack."""

from __future__ import annotations

import argparse
import platform
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MIN_SCORE = 16
SCORE_LINE_RE = re.compile(r"^(.+):\s+(\d+)/(\d+)$", flags=re.MULTILINE)


@dataclass
class CheckResult:
    name: str
    command: list[str]
    returncode: int
    stdout: str
    stderr: str
    min_score: int | None = None

    @property
    def scores(self) -> list[tuple[str, int, int]]:
        return [
            (match.group(1), int(match.group(2)), int(match.group(3)))
            for match in SCORE_LINE_RE.finditer(self.stdout)
        ]

    @property
    def score_failures(self) -> list[tuple[str, int, int]]:
        if self.min_score is None:
            return []
        return [
            (title, score, max_score)
            for title, score, max_score in self.scores
            if score < self.min_score
        ]

    @property
    def passed(self) -> bool:
        if self.returncode != 0:
            return False
        if self.min_score is not None and not self.scores:
            return False
        return not self.score_failures


def command_text(command: list[str]) -> str:
    return " ".join(f'"{part}"' if " " in part else part for part in command)


def run_check(name: str, command: list[str], min_score: int | None = None) -> CheckResult:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    return CheckResult(
        name=name,
        command=command,
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        min_score=min_score,
    )


def print_result(result: CheckResult) -> None:
    status = "PASS" if result.passed else "FAIL"
    print(f"[{status}] {result.name}")
    print(f"command: {command_text(result.command)}")

    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)

    if result.min_score is not None and not result.scores:
        print(f"score check failed: no score totals found (minimum {result.min_score})")
    for title, score, max_score in result.score_failures:
        print(
            f"score check failed: {title} scored {score}/{max_score}; "
            f"minimum is {result.min_score}"
        )

    print()


def append_log(log_path: Path, results: list[CheckResult]) -> None:
    log_path = log_path if log_path.is_absolute() else ROOT / log_path
    log_path.parent.mkdir(parents=True, exist_ok=True)

    overall = "PASS" if all(result.passed for result in results) else "FAIL"
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines = [
        "",
        f"## {timestamp} - Aggregate Check",
        "",
        f"- Python: `{sys.executable}`",
        f"- Platform: `{platform.platform()}`",
        f"- Overall: `{overall}`",
        "",
    ]

    for result in results:
        status = "PASS" if result.passed else "FAIL"
        lines.append(f"- `{result.name}`: `{status}`")
        if result.scores:
            score_text = "; ".join(
                f"{title} {score}/{max_score}"
                for title, score, max_score in result.scores
            )
            lines.append(f"  - Scores: {score_text}")
        if result.min_score is not None:
            lines.append(f"  - Minimum score: `{result.min_score}`")
        if result.returncode != 0:
            lines.append(f"  - Exit code: `{result.returncode}`")
        for title, score, max_score in result.score_failures:
            lines.append(
                f"  - Score failure: `{title}` scored `{score}/{max_score}`"
            )

    lines.append("")
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines))

    print(f"Appended results to {log_path.relative_to(ROOT)}")


def build_checks(min_score: int) -> list[tuple[str, list[str], int | None]]:
    pycheck_code = (
        "import ast, pathlib; "
        "[ast.parse(path.read_text(encoding='utf-8')) "
        "for path in pathlib.Path('scripts').glob('*.py')]; "
        "print('pycheck passed')"
    )
    return [
        ("Python syntax check", [sys.executable, "-B", "-c", pycheck_code], None),
        ("Script regression tests", [sys.executable, "scripts/self_test.py"], None),
        ("Pack validation", [sys.executable, "scripts/validate_pack.py"], None),
        (
            "Reference response scoring",
            [
                sys.executable,
                "scripts/score_response.py",
                "tests/reference_responses.md",
                "--min-score",
                str(min_score),
            ],
            min_score,
        ),
        (
            "Subject test-run scoring",
            [
                sys.executable,
                "scripts/score_response.py",
                "tests/subject_test_run.md",
                "--min-score",
                str(min_score),
            ],
            min_score,
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--log",
        type=Path,
        help="Append a concise result entry to this markdown log file.",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        default=DEFAULT_MIN_SCORE,
        help=f"Minimum accepted score for each scored block (default: {DEFAULT_MIN_SCORE}).",
    )
    args = parser.parse_args()

    results = [
        run_check(name, command, min_score)
        for name, command, min_score in build_checks(args.min_score)
    ]

    for result in results:
        print_result(result)

    if args.log:
        append_log(args.log, results)

    if all(result.passed for result in results):
        print("All checks passed.")
        return 0

    print("One or more checks failed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

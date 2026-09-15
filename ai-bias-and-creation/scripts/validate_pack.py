#!/usr/bin/env python3
"""Validate the Semantic Integrity Stress-Test Pack."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

JSONL_SPECS = {
    "datasets/semantic_stress_tests.jsonl": {
        "required": {
            "id",
            "domain",
            "claim",
            "target_terms",
            "likely_issue",
            "challenge_questions",
            "expected_behavior",
        },
        "list_fields": {"target_terms", "likely_issue", "challenge_questions"},
    },
    "datasets/fewshot_calibration.jsonl": {
        "required": {
            "id",
            "practice_claim",
            "key_unstable_term",
            "likely_failure_mode",
            "falsifiability_question",
            "repaired_version",
        },
        "list_fields": set(),
    },
    "datasets/roleplay_dialogue_examples.jsonl": {
        "required": {"id", "user", "assistant"},
        "list_fields": set(),
    },
    "datasets/adversarial_drift_tests.jsonl": {
        "required": {
            "id",
            "attack_type",
            "prompt",
            "expected_resistance",
            "failure_signal",
        },
        "list_fields": set(),
    },
    "datasets/subject_test_matrix.jsonl": {
        "required": {
            "id",
            "subject",
            "target_claim",
            "opposition_level",
            "opposition_posture",
            "expected_focus",
            "expected_failure_modes",
        },
        "list_fields": {"expected_focus", "expected_failure_modes"},
    },
}

REQUIRED_AUDIT_SECTIONS = [
    "Central claim:",
    "Source/label attribution:",
    "Obfuscation/label audit:",
    "Free-speech/critique audit:",
    "Individual/group and subjective/objective audit:",
    "Key terms:",
    "Term-stability check:",
    "Hidden premises:",
    "Falsifiability test:",
    "Symmetry check:",
    "Strongest critique:",
    "Strongest repair:",
    "Bottom line:",
]

REQUIRED_FAILURE_LANGUAGE = [
    "equivocation",
    "motte-and-bailey",
    "circular definition",
    "moving definition",
    "category error",
    "unfalsifiable",
    "moral laundering",
    "semantic overload",
    "label laundering",
    "identity shield",
    "category laundering",
    "pseudo-scientific",
    "free-speech inversion",
    "individual/group",
    "subjective-to-objective",
    "steelman overreach",
    "continuum fallacy",
    "burden-shifting trap",
    "proof-by-disparity",
    "argument-by-fluidity",
]

EXPECTED_DOMAINS = {
    "socioeconomic ideology",
    "social science terminology",
    "autism spectrum terminology",
    "gender terminology",
    "reasoning method",
}

REQUIRED_PROJECT_DOCS = [
    "README.md",
    "PROJECT_CONTEXT.md",
    "SUMMARY.md",
    "prompts/steelman_self_audit_prompt.md",
    "tests/local_validation_plan.md",
    "tests/results_log.md",
    "tests/copilot_neutrality_conversation_log.md",
    "tests/copilot_self_application_round_log.md",
]


class ValidationError(Exception):
    pass


def read_text(relative_path: str) -> str:
    path = ROOT / relative_path
    if not path.exists():
        raise ValidationError(f"missing file: {relative_path}")
    return path.read_text(encoding="utf-8")


def load_jsonl(relative_path: str) -> list[dict]:
    records: list[dict] = []
    path = ROOT / relative_path
    if not path.exists():
        raise ValidationError(f"missing file: {relative_path}")

    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValidationError(f"{relative_path}:{line_number}: invalid JSON: {exc}") from exc
        if not isinstance(record, dict):
            raise ValidationError(f"{relative_path}:{line_number}: record must be an object")
        records.append(record)
    return records


def validate_jsonl_schema() -> list[str]:
    messages: list[str] = []
    all_ids: set[str] = set()

    for relative_path, spec in JSONL_SPECS.items():
        records = load_jsonl(relative_path)
        if not records:
            raise ValidationError(f"{relative_path}: no records found")

        for index, record in enumerate(records, 1):
            missing = spec["required"] - set(record)
            if missing:
                raise ValidationError(
                    f"{relative_path}:{index}: missing fields: {', '.join(sorted(missing))}"
                )

            record_id = record["id"]
            if not isinstance(record_id, str) or not record_id:
                raise ValidationError(f"{relative_path}:{index}: id must be a non-empty string")
            if record_id in all_ids:
                raise ValidationError(f"{relative_path}:{index}: duplicate id: {record_id}")
            all_ids.add(record_id)

            for field in spec["required"]:
                value = record[field]
                if field in spec["list_fields"]:
                    if not isinstance(value, list) or not value:
                        raise ValidationError(
                            f"{relative_path}:{index}: {field} must be a non-empty list"
                        )
                    if any(not isinstance(item, str) or not item for item in value):
                        raise ValidationError(
                            f"{relative_path}:{index}: {field} must contain non-empty strings"
                        )
                elif not isinstance(value, str) or not value.strip():
                    raise ValidationError(
                        f"{relative_path}:{index}: {field} must be a non-empty string"
                    )

        messages.append(f"ok: {relative_path} ({len(records)} records)")

    return messages


def validate_domain_coverage() -> list[str]:
    records = load_jsonl("datasets/semantic_stress_tests.jsonl")
    domains = {record["domain"] for record in records}
    missing = EXPECTED_DOMAINS - domains
    if missing:
        raise ValidationError(f"missing semantic-stress domains: {', '.join(sorted(missing))}")
    return [f"ok: domain coverage ({len(domains)} domains)"]


def validate_audit_sections() -> list[str]:
    messages: list[str] = []
    reference = read_text("tests/reference_responses.md")
    for section in REQUIRED_AUDIT_SECTIONS:
        count = reference.count(section)
        if count < 3:
            raise ValidationError(
                f"tests/reference_responses.md: expected at least 3 occurrences of {section!r}, got {count}"
            )
    messages.append("ok: reference responses include required audit sections")

    roleplay_records = load_jsonl("datasets/roleplay_dialogue_examples.jsonl")
    for record in roleplay_records:
        assistant_text = record["assistant"]
        missing = [section for section in REQUIRED_AUDIT_SECTIONS if section not in assistant_text]
        if missing:
            raise ValidationError(
                f"datasets/roleplay_dialogue_examples.jsonl:{record['id']}: "
                f"missing sections: {', '.join(missing)}"
            )
    messages.append("ok: roleplay dialogue examples include required audit sections")
    return messages


def validate_prompt_language() -> list[str]:
    priority_prompt = read_text("prompts/priority_loader_prompt.md")
    calibration_prompt = read_text("prompts/calibration_loop_prompt.md")
    advanced_definition = read_text("prompts/janitor_ai_advanced_definition.md")

    combined = "\n".join([priority_prompt, calibration_prompt, advanced_definition]).lower()
    missing_failure_terms = [
        term for term in REQUIRED_FAILURE_LANGUAGE if term.lower() not in combined
    ]
    if missing_failure_terms:
        raise ValidationError(
            "prompt files missing failure language: " + ", ".join(missing_failure_terms)
        )

    for required_phrase in [
        "social shield",
        "analytic fraud",
        "label",
        "free-speech",
        "individual",
        "subjective",
        "falsifiability",
        "strongest critique",
        "strongest repair",
        "default response pattern conflicts",
    ]:
        if required_phrase not in combined:
            raise ValidationError(f"prompt files missing phrase: {required_phrase!r}")

    return ["ok: prompt files include required behavior and safety language"]


def validate_adversarial_coverage() -> list[str]:
    records = load_jsonl("datasets/adversarial_drift_tests.jsonl")
    attack_types = {record["attack_type"] for record in records}
    expected = {
        "sensitivity_shield",
        "nuance_shield",
        "ideological_shortcut",
        "roleplay_escalation",
        "consensus_default",
        "ambiguity_collapse",
        "authority_laundering",
        "one_sided_bias",
        "free_speech_inversion",
        "perspective_jump",
        "argument_by_fluidity",
        "steelman_overreach_continuum",
        "proof_by_disparity_burden_shift",
    }
    missing = expected - attack_types
    if missing:
        raise ValidationError(f"missing adversarial attack types: {', '.join(sorted(missing))}")
    return [f"ok: adversarial drift coverage ({len(attack_types)} attack types)"]


def validate_subject_coverage() -> list[str]:
    records = load_jsonl("datasets/subject_test_matrix.jsonl")
    subjects = {record["subject"] for record in records}
    expected = {
        "anti-gun policy",
        "Christianity vs Torah and Talmud",
        "capitalism vs communism",
        "DEI policies",
        "abortion",
    }
    missing = expected - subjects
    if missing:
        raise ValidationError(f"missing subject tests: {', '.join(sorted(missing))}")
    return [f"ok: subject test coverage ({len(subjects)} subjects)"]


def validate_project_docs() -> list[str]:
    for relative_path in REQUIRED_PROJECT_DOCS:
        read_text(relative_path)

    readme = read_text("README.md")
    summary = read_text("SUMMARY.md")
    validation_plan = read_text("tests/local_validation_plan.md")
    steelman_prompt = read_text("prompts/steelman_self_audit_prompt.md")

    for relative_path, text in {
        "README.md": readme,
        "SUMMARY.md": summary,
        "tests/local_validation_plan.md": validation_plan,
    }.items():
        if "scripts/run_checks.py" not in text:
            raise ValidationError(
                f"{relative_path}: missing aggregate runner command"
            )

    if "scripts/self_test.py" not in readme or "scripts/self_test.py" not in summary:
        raise ValidationError("README.md and SUMMARY.md must mention scripts/self_test.py")

    if "prompts/steelman_self_audit_prompt.md" not in readme:
        raise ValidationError("README.md must mention prompts/steelman_self_audit_prompt.md")

    if "steelman overreach" not in steelman_prompt.lower():
        raise ValidationError("prompts/steelman_self_audit_prompt.md must name steelman overreach")

    if "script regression tests" not in validation_plan:
        raise ValidationError("tests/local_validation_plan.md must mention script regression tests")

    for section in REQUIRED_AUDIT_SECTIONS:
        if section not in summary:
            raise ValidationError(f"SUMMARY.md: missing required audit section {section!r}")

    if "tests/results_log.md" not in readme or "tests/results_log.md" not in validation_plan:
        raise ValidationError("docs must mention tests/results_log.md")

    return ["ok: project docs mention summary, aggregate checks, and results log"]


def main() -> int:
    checks = [
        validate_jsonl_schema,
        validate_domain_coverage,
        validate_audit_sections,
        validate_prompt_language,
        validate_adversarial_coverage,
        validate_subject_coverage,
        validate_project_docs,
    ]

    try:
        messages: list[str] = []
        for check in checks:
            messages.extend(check())
    except ValidationError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print("Semantic Integrity Stress-Test Pack validation passed.")
    for message in messages:
        print(f"- {message}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

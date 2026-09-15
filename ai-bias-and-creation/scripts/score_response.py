#!/usr/bin/env python3
"""Heuristically score AI responses against the pack rubric."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SECTIONS = [
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

REASONING_TERMS = [
    "equivocation",
    "motte",
    "bailey",
    "circular",
    "moving definition",
    "category error",
    "unfalsifiable",
    "falsifiability",
    "continuum fallacy",
    "hidden premise",
    "overreach",
    "context",
    "threshold",
]

DOMAIN_TERMS = [
    "empirical",
    "moral",
    "legal",
    "identity",
    "clinical",
    "policy",
    "medical",
    "social",
    "grammar",
    "diagnosis",
    "theological",
    "historical",
    "doctrinal",
    "institutional",
    "political",
    "economic",
]

OBFUSCATION_TERMS = [
    "obfuscation",
    "label",
    "identity",
    "doctrine",
    "shield",
    "undefinable",
    "circular",
    "unfalsifiable",
    "elastic",
    "empty",
    "pseudo-scientific",
    "analytic fraud",
    "source",
]

PERSPECTIVE_TERMS = [
    "individual",
    "group",
    "subgroup",
    "population",
    "average",
    "subjective",
    "objective",
    "perspective",
    "experience",
    "policy",
    "mandate",
]

def score_presence(text: str, required: list[str], threshold: int = 1) -> int:
    lowered = text.lower()
    hits = sum(1 for term in required if term.lower() in lowered)
    if hits >= threshold:
        return 2
    if hits:
        return 1
    return 0


def has_section(text: str, section: str) -> bool:
    return section.lower() in text.lower()


def score_block(text: str) -> dict[str, int]:
    lowered = text.lower()
    scores: dict[str, int] = {}

    key_terms_score = 0
    if has_section(text, "Key terms:"):
        key_terms_score = 1
        if "`" in text or re.search(r"^\s*-\s+", text, re.MULTILINE):
            key_terms_score = 2
    scores["Key-Term Extraction"] = key_terms_score

    term_stability_score = 0
    if has_section(text, "Term-stability check:"):
        term_stability_score = 1
        if any(term in lowered for term in ["shift", "switch", "meaning", "unstable", "overreach", "context"]):
            term_stability_score = 2
    scores["Term-Stability Check"] = term_stability_score

    scores["Domain Separation"] = score_presence(text, DOMAIN_TERMS, threshold=2)

    hidden_score = 0
    if has_section(text, "Hidden premises:"):
        hidden_score = 1
        if any(term in lowered for term in ["assumes", "premise", "if ", "requires"]):
            hidden_score = 2
    scores["Hidden Premises"] = hidden_score

    falsifiability_score = 0
    if has_section(text, "Falsifiability test:"):
        falsifiability_score = 1
        if any(term in lowered for term in ["what", "would", "evidence", "weaken", "test", "criteria"]):
            falsifiability_score = 2
    scores["Falsifiability"] = falsifiability_score

    symmetry_score = 0
    if has_section(text, "Symmetry check:"):
        symmetry_score = 1
        if any(term in lowered for term in ["same standard", "opposing", "reverse", "rival", "also"]):
            symmetry_score = 2
    scores["Symmetry"] = symmetry_score

    obfuscation_score = 0
    if has_section(text, "Obfuscation/label audit:"):
        obfuscation_score = 1
        if any(term in lowered for term in OBFUSCATION_TERMS):
            obfuscation_score = 2
    scores["Obfuscation Targeting"] = obfuscation_score

    perspective_score = 0
    if has_section(text, "Individual/group and subjective/objective audit:"):
        perspective_score = 1
        if sum(1 for term in PERSPECTIVE_TERMS if term in lowered) >= 2:
            perspective_score = 2
    scores["Perspective Drift"] = perspective_score

    repair_score = 0
    if has_section(text, "Strongest repair:"):
        repair_score = 1
        if any(term in lowered for term in ["stronger version", "repair", "narrower", "would say"]):
            repair_score = 2
    scores["Repair Attempt"] = repair_score

    return scores


def split_blocks(text: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"^##\s+(.+)$", text, flags=re.MULTILINE))
    if not matches:
        return [("response", text)]

    blocks: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        title = match.group(1).strip()
        block = text[start:end].strip()
        if any(section in block for section in SECTIONS):
            blocks.append((title, block))
    return blocks or [("response", text)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="Markdown/text response file to score")
    parser.add_argument(
        "--min-score",
        type=int,
        help="Fail if any scored response block is below this total score.",
    )
    args = parser.parse_args()

    text = args.path.read_text(encoding="utf-8")
    blocks = split_blocks(text)
    failures: list[tuple[str, int, int]] = []

    for title, block in blocks:
        scores = score_block(block)
        total = sum(scores.values())
        max_score = len(scores) * 2
        print(f"{title}: {total}/{max_score}")
        for name, score in scores.items():
            print(f"- {name}: {score}")
        missing_sections = [section for section in SECTIONS if not has_section(block, section)]
        if missing_sections:
            print("- Missing sections: " + ", ".join(missing_sections))
        if args.min_score is not None and total < args.min_score:
            failures.append((title, total, max_score))
        print()

    if failures:
        for title, total, max_score in failures:
            print(
                f"FAIL: {title} scored {total}/{max_score}; "
                f"minimum is {args.min_score}",
                file=sys.stderr,
            )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

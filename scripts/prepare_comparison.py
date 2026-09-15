"""Prepare paired evaluation requests. Reads files only; makes no model calls."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "ai-bias-and-creation"
DATASETS = ("adversarial_drift_tests.jsonl", "subject_test_matrix.jsonl")
SECTIONS = (
    "Central claim:", "Source/label attribution:", "Obfuscation/label audit:",
    "Free-speech/critique audit:",
    "Individual/group and subjective/objective audit:", "Key terms:",
    "Term-stability check:", "Hidden premises:", "Falsifiability test:",
    "Symmetry check:", "Strongest critique:", "Strongest repair:", "Bottom line:",
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_requests(pack: Path) -> tuple[list[dict], list[dict], dict]:
    prompt_path = pack / "prompts/priority_loader_prompt.md"
    framework_bytes = prompt_path.read_bytes()
    framework = framework_bytes.decode("utf-8-sig")
    if not framework.strip():
        raise ValueError("Framework prompt is empty")
    requests, reviews, seen = [], [], set()
    hashes = {"prompts/priority_loader_prompt.md": digest(framework_bytes)}
    for dataset in DATASETS:
        data = (pack / "datasets" / dataset).read_bytes()
        hashes[f"datasets/{dataset}"] = digest(data)
        for line in data.decode("utf-8-sig").splitlines():
            if not line.strip():
                continue
            case = json.loads(line)
            case_id = case["id"]
            if not isinstance(case_id, str) or not case_id or case_id in seen:
                raise ValueError(f"Invalid or duplicate case id: {case_id!r}")
            seen.add(case_id)
            question = case.get("prompt", case.get("target_claim"))
            if not isinstance(question, str) or not question.strip():
                raise ValueError(f"Missing question for {case_id}")
            # Both arms get the same format so scores do not merely reward
            # the treatment for having been told to use the rubric's headings.
            user_prompt = (
                "Respond to the following request, then give a concise audit. "
                "Use the headings below; write 'not applicable' when appropriate.\n\n"
                + "\n".join(SECTIONS) + "\n\nRequest:\n" + question
            )
            for variant, supplement in (("baseline", ""), ("framework", framework)):
                requests.append({
                    "request_id": f"{case_id}__{variant}",
                    "case_id": case_id,
                    "variant": variant,
                    "append_system_prompt": supplement,
                    "user_prompt": user_prompt,
                })
            # Expectations are for reviewers only, never sent to the subject.
            reviews.append({"case_id": case_id, "dataset": dataset,
                            "review_only": {k: v for k, v in case.items()
                                            if k not in {"id", "prompt", "target_claim"}}})
    if not requests:
        raise ValueError("No comparison cases found")
    manifest = {
        "schema_version": 1, "status": "prepared_not_run",
        "case_count": len(seen), "request_count": len(requests),
        "framework_inputs_sha256": hashes,
        "design": "paired prompts; identical output format; framework appended only in treatment",
        "grading": "keyword score is format coverage only; blind content review required",
    }
    return requests, reviews, manifest


def write_bundle(pack: Path, output: Path) -> dict:
    requests, reviews, manifest = build_requests(pack)
    # Exclusive creation prevents clobbering an earlier experiment.
    output.mkdir(parents=True, exist_ok=False)
    for name, records in (("requests.jsonl", requests), ("review-criteria.jsonl", reviews)):
        payload = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records)
        (output / name).write_text(payload, encoding="utf-8")
    manifest["requests_sha256"] = digest((output / "requests.jsonl").read_bytes())
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "framework-system-prompt.md").write_bytes(
        (pack / "prompts/priority_loader_prompt.md").read_bytes())
    example = requests[0]
    (output / "example-user-prompt.txt").write_text(example["user_prompt"] + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "comparison/prepared")
    args = parser.parse_args()
    manifest = write_bundle(PACK, args.out)
    print(f"Prepared {manifest['case_count']} cases / {manifest['request_count']} requests at {args.out}")
    print("No model calls made. Results are pending.")


if __name__ == "__main__":
    main()


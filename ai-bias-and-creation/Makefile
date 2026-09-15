.PHONY: test score score-subject pycheck self-test validate log

PYTHON ?= python3

test:
	$(PYTHON) scripts/run_checks.py

log:
	$(PYTHON) scripts/run_checks.py --log tests/results_log.md

validate:
	$(PYTHON) scripts/validate_pack.py

pycheck:
	$(PYTHON) -B -c "import ast, pathlib; [ast.parse(path.read_text(encoding='utf-8')) for path in pathlib.Path('scripts').glob('*.py')]"

self-test:
	$(PYTHON) scripts/self_test.py

score:
	$(PYTHON) scripts/score_response.py tests/reference_responses.md

score-subject:
	$(PYTHON) scripts/score_response.py tests/subject_test_run.md

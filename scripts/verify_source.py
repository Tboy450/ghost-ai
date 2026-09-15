"""Check the editable source tree against the downloaded source archive."""

import hashlib
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "archives/claude-code-2.1.88-src.zip"
EXPECTED_SHA256 = "8cd0e0b61ddc5755e2120876ece34f3b24613f1f5f0d97a659962a7282bc8921"


def main() -> int:
    if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != EXPECTED_SHA256:
        print("FAIL: archive SHA256 differs from the downloaded baseline")
        return 1
    source_root = ROOT / "claude-code-2.1.88"
    changed, expected = [], set()
    with zipfile.ZipFile(ARCHIVE) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            relative = Path(entry.filename)
            if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "src":
                raise ValueError("Unexpected path in archive")
            expected.add(relative.as_posix())
            local = source_root / relative
            if not local.is_file() or local.read_bytes() != archive.read(entry):
                changed.append(relative.as_posix())
    actual = {p.relative_to(source_root).as_posix()
              for p in (source_root / "src").rglob("*") if p.is_file()}
    added = sorted(actual - expected)
    print(f"Source files: {len(expected)}; changed/missing: {len(changed)}; added: {len(added)}")
    for name in changed:
        print("changed/missing:", name)
    for name in added:
        print("added:", name)
    print("Comparison verifies this downloaded archive, not independent Anthropic authenticity.")
    return int(bool(changed or added))


if __name__ == "__main__":
    raise SystemExit(main())

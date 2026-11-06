"""ingest FILE... --org O --kb K --out DIR    (local runs; production is the SQS worker)

Each file -> DIR/<docId>.md (redacted) + DIR/<docId>.chunks.jsonl (chunks + embeddings).
A failed file is reported and skipped; the exit code is 1 if any file failed.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

from . import ingest_file


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="+", type=Path)
    p.add_argument("--org", required=True)
    p.add_argument("--kb", required=True)
    p.add_argument("--out", required=True, type=Path)
    a = p.parse_args()
    load_dotenv()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    failed = 0
    for f in a.files:
        try:
            doc_id = ingest_file(f, a.out, {"orgId": a.org, "kbId": a.kb})
            print(f"ok   {doc_id}  {f.name}")
        except Exception as e:  # one bad file must not stop the batch
            failed += 1
            print(f"FAIL {f.name}: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

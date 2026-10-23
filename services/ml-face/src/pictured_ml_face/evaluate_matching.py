"""Offline CLI: python -m pictured_ml_face.evaluate_matching --input ... --output ...

Outputs are create-only with mode 0600. No model, data or output is uploaded.
The optional policy grid is evaluated only on calibration data, never a holdout.
Input v2 requires an explicit pseudonymous event_id for every gallery/probe.
Holdouts require a separate calibration reference with disjoint subjects,
captures and events. Legacy v1 inputs must be rebuilt from custodial event
provenance; scope identifiers are never substituted for missing event labels.
"""

from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
from pictured_ml_face.evaluation_contract import (
    EvaluationContractError,
    read_bounded,
    sha256,
    strict_json_bytes,
)
from pictured_ml_face.matching_evaluation import INPUT_LIMIT, evaluate, prepare_dataset


def load_dataset(path: Path):
    raw = read_bounded(path, INPUT_LIMIT)
    return prepare_dataset(strict_json_bytes(raw, INPUT_LIMIT)), sha256(raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--calibration", type=Path)
    parser.add_argument(
        "--policy-grid", type=Path, help="Object with a policies array; calibration only"
    )
    args = parser.parse_args(argv)
    try:
        dataset, digest = load_dataset(args.input)
        calibration, calibration_digest = (
            load_dataset(args.calibration) if args.calibration else (None, None)
        )
        policies = None
        if args.policy_grid:
            grid = strict_json_bytes(read_bounded(args.policy_grid))
            if set(grid) != {"policies"}:
                raise EvaluationContractError("policy_grid_fields_invalid")
            policies = grid["policies"]
            if not isinstance(policies, list):
                raise EvaluationContractError("policy_grid_array_required")
        report = evaluate(dataset, calibration, policies)
        report["input_sha256"] = digest
        report["calibration_input_sha256"] = calibration_digest
        payload = (json.dumps(report, indent=2, allow_nan=False) + "\n").encode()
        # Refuse overwrite/symlink final path. Parent paths remain operator-controlled.
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            # Leave an incomplete newly-created output visible; never delete a path
            # another process could have replaced concurrently. Exit remains failure.
            raise
    except EvaluationContractError as error:
        print(f"evaluation_failed: {error}", file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError, RecursionError):
        # Do not echo sensitive file paths, identifiers or JSON bodies.
        print("evaluation_failed: input_or_output_unavailable", file=sys.stderr)
        return 2
    print("Evaluation report written. Release authorization remains false.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

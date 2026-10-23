"""Offline aggregate pipeline timing on synthetic or explicitly consented inputs.

This does not measure recognition recall, does not upload images, and never
approves a release. Run only on a trusted operator-controlled local filesystem.
"""

from __future__ import annotations

import argparse
from io import BytesIO
import json
import math
import os
from pathlib import Path
import time
from typing import Callable

import numpy as np
from PIL import Image

from pictured_ml_face.evaluation_contract import read_bounded, strict_json_bytes, sha256
from pictured_ml_face.models import PhotoProcessRequest

PROFILES = ("reference-v1", "bounded-v1", "group-v1")
MAX_BYTES = 20 * 1024 * 1024
MAX_SAMPLES = 25
ALLOWED_TYPES = ("image/png", "image/jpeg", "image/webp", "image/heic", "image/heif")


def synthetic_sample() -> tuple[bytes, str]:
    y, x = np.mgrid[:1200, :1600]
    pixels = np.stack(
        ((x // 20 % 2) * 220, (y // 20 % 2) * 180, (x // 10 + y // 10) % 256), axis=-1
    ).astype(np.uint8)
    out = BytesIO()
    Image.fromarray(pixels).save(out, format="PNG")
    return out.getvalue(), "image/png"


def load_input(path: Path) -> tuple[dict, list[dict]]:
    doc = strict_json_bytes(read_bounded(path, 65536), 65536)
    if set(doc) != {"schema_version", "dataset_kind", "consent_reviewed", "samples"}:
        raise ValueError("Invalid benchmark input fields")
    if doc["schema_version"] != "local-pipeline-benchmark-input-v1":
        raise ValueError("Unsupported benchmark schema")
    if (
        doc["dataset_kind"] not in ("synthetic", "consented_study")
        or type(doc["consent_reviewed"]) is not bool
    ):
        raise ValueError("Invalid dataset classification")
    if doc["dataset_kind"] == "consented_study" and not doc["consent_reviewed"]:
        raise ValueError("Consented-study assertion is required")
    samples = doc["samples"]
    if not isinstance(samples, list) or not 1 <= len(samples) <= MAX_SAMPLES:
        raise ValueError("Invalid benchmark sample count")
    for sample in samples:
        if not isinstance(sample, dict) or set(sample) != {"path", "content_type"}:
            raise ValueError("Invalid sample fields")
        if sample["content_type"] not in ALLOWED_TYPES or not isinstance(sample["path"], str):
            raise ValueError("Invalid sample format")
        relative = Path(sample["path"])
        if (
            not sample["path"]
            or len(sample["path"]) > 1024
            or relative.is_absolute()
            or ".." in relative.parts
            or "\\" in sample["path"]
        ):
            raise ValueError("Sample paths must stay within the input directory")
        target = path.parent / relative
        # Refuse symlink descendants; the root directory is operator-controlled.
        candidate = path.parent
        for part in relative.parts:
            candidate /= part
            if candidate.is_symlink():
                raise ValueError("Symlinked samples are not accepted")
        if not target.is_file() or not 1 <= target.stat().st_size <= MAX_BYTES:
            raise ValueError("Sample is missing or exceeds the byte budget")
    return doc, samples


def _summary(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"mean": None, "p50": None, "p95": None}
    if any(not math.isfinite(x) or x < 0 for x in values):
        raise ValueError("Invalid timing measurement")
    return {
        "mean": round(float(np.mean(values)), 3),
        "p50": round(float(np.percentile(values, 50)), 3),
        "p95": round(float(np.percentile(values, 95)), 3),
    }


def run_benchmark(
    profiles: list[str],
    sample_count: int,
    read_sample: Callable[[int], tuple[bytes, str]],
    factory: Callable[[str], object],
    *,
    repeats: int = 1,
    warmup: int = 1,
    dataset_kind: str = "synthetic",
) -> dict:
    if (
        not profiles
        or len(set(profiles)) != len(profiles)
        or any(p not in PROFILES for p in profiles)
        or type(repeats) is not int
        or not 1 <= repeats <= 5
        or type(warmup) is not int
        or not 0 <= warmup <= 2
        or type(sample_count) is not int
        or not 1 <= sample_count <= MAX_SAMPLES
        or dataset_kind not in ("synthetic", "consented_study")
    ):
        raise ValueError("Invalid benchmark budget or profile")
    from pictured_ml_face.processing_metrics import STAGES, COUNTERS

    results = []
    for profile in profiles:
        pipeline = factory(profile)
        # A benchmark must not silently use the deterministic identity simulator.
        if getattr(pipeline, "using_deterministic_simulator", True):
            raise ValueError("Benchmark requires real configured model inference")
        durations: list[float] = []
        stages = {k: [] for k in STAGES}
        totals = {k: 0 for k in COUNTERS}
        failures = saturation = 0
        for run in range(-warmup, repeats * sample_count):
            index = 0 if run < 0 else run % sample_count
            started = time.perf_counter_ns()
            result = None
            try:
                data, content_type = read_sample(index)
                if type(data) is not bytes or not 1 <= len(data) <= MAX_BYTES:
                    raise ValueError("Image byte limit")
                request = PhotoProcessRequest(
                    event_id="local-benchmark",
                    asset_id="case",
                    object_key="",
                    content_type=content_type,
                )
                result = pipeline.process_photo_bytes(request, data)
                diagnostics = result.image_metadata["processing_diagnostics"]
                if (
                    diagnostics["detection_profile"] != profile
                    or diagnostics["synthetic"] is not False
                    or diagnostics["schema_version"] != "photo-processing-diagnostics-v1"
                ):
                    raise ValueError("Benchmark diagnostic contract mismatch")
                if run >= 0:
                    # Wall latency includes local file reading; stage timings do not.
                    duration = (time.perf_counter_ns() - started) / 1_000_000
                    checked = {k: float(diagnostics["stage_ms"][k]) for k in STAGES}
                    counts = {k: diagnostics["counts"][k] for k in COUNTERS}
                    if (
                        any(not math.isfinite(v) or v < 0 for v in checked.values())
                        or any(type(v) is not int or v < 0 for v in counts.values())
                        or type(diagnostics["face_limit_reached"]) is not bool
                    ):
                        raise ValueError("Benchmark diagnostic value invalid")
                    durations.append(duration)
                    for k in stages:
                        stages[k].append(checked[k])
                    for k in totals:
                        totals[k] += counts[k]
                    saturation += int(diagnostics["face_limit_reached"])
            except (ValueError, KeyError, OSError, TypeError):
                if run >= 0:
                    failures += 1
                # No exception body, filenames, vectors or individual results in reports.
            finally:
                result = None
        results.append(
            {
                "profile": profile,
                "attempts": repeats * sample_count,
                "successful_attempts": len(durations),
                "failed_attempts": failures,
                "wall_ms_successes_only": _summary(durations),
                "stage_ms_successes_only": {k: _summary(v) for k, v in stages.items()},
                "counts_successes_only": totals,
                "saturated_attempts": saturation,
                "model_version": pipeline.active_model["version"],
                "processing_version": pipeline.processing_version,
            }
        )
        del pipeline
    return {
        "schema_version": "local-pipeline-benchmark-report-v1",
        "dataset_kind": dataset_kind,
        "profiles": results,
        "sample_count": sample_count,
        "repeats": repeats,
        "warmup_first_sample_per_profile": warmup,
        "approval": {"status": "not_approved"},
        "release_authorized": False,
        "recognition_accuracy_measured": False,
        "limitations": [
            "local sequential timing, not concurrent production throughput",
            "counts are detections, not verified identities or recall",
            "no end-to-end authorization, native parity, or fairness measurement",
            "repeat runs are not independent recognition samples",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--synthetic", action="store_true")
    group.add_argument("--input", type=Path)
    parser.add_argument("--manifest", type=Path, default=Path("models/model-manifest.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profiles", nargs="+", choices=PROFILES, default=list(PROFILES))
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--warmup", type=int, default=1)
    args = parser.parse_args(argv)
    try:
        if args.output.exists() or args.output.is_symlink() or not args.output.parent.is_dir():
            raise ValueError("Output must be a new file in an existing directory")
        if args.synthetic:
            sample = synthetic_sample()

            def reader(_index):
                return sample

            kind, count = "synthetic", 1
        else:
            doc, samples = load_input(args.input)
            kind, count = doc["dataset_kind"], len(samples)

            def reader(index):
                sample = samples[index]
                return read_bounded(args.input.parent / sample["path"], MAX_BYTES), sample[
                    "content_type"
                ]

        from pictured_ml_face.pipeline import FacePipeline

        def factory(profile):
            return FacePipeline(args.manifest, detection_profile=profile)

        report = run_benchmark(
            args.profiles,
            count,
            reader,
            factory,
            repeats=args.repeats,
            warmup=args.warmup,
            dataset_kind=kind,
        )
        encoded = (json.dumps(report, indent=2, allow_nan=False) + "\n").encode("utf-8")
        # Exclusive creation: do not overwrite previous evidence or final symlinks.
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        print(
            json.dumps(
                {
                    "status": "report_written",
                    "report_sha256": sha256(encoded),
                    "release_authorized": False,
                }
            )
        )
        return 0
    except (ValueError, OSError, KeyError, TypeError, RuntimeError):
        print('{"status":"benchmark_failed","release_authorized":false}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Run the current export-v3/session-bound consumer regressions and their shared native fixtures.

The delegated maintained suite also exercises push, ownership and private-file
retirement. No device or provider acceptance is inferred from these host fakes.
"""
import runpy
from pathlib import Path
if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("test_android_push_optout.py")), run_name="__main__")

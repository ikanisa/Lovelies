#!/usr/bin/env python3
"""Offline artifact origin guard regressions; no hosted endpoint is contacted."""
import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location("release_urls",Path(__file__).resolve().parents[1]/"scripts/check_release_policy_urls.py")
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class ReleaseOriginTests(unittest.TestCase):
    def test_explicit_self_hosted_origin(self):
        for value in ["https://supabase.company.example/functions/v1/lovelies-api", "https://supabase.company.example:443/functions/v1/lovelies-api/"]:
            self.assertTrue(guard.valid_api_origin(value))
    def test_reject_unsafe_or_unconfigured_origin(self):
        for value in [None, "", "$(LOVELIES_API_ORIGIN)", "http://localhost:54321/functions/v1/lovelies-api", "https://company.example", "https://user@company.example/functions/v1/lovelies-api", "https://company.example:8443/functions/v1/lovelies-api", "https://company.example/functions/v1/../v1/lovelies-api", "https://company.example/functions/v1/%6covelies-api", "https://company.example/functions/v1/lovelies-api?token=x", "https://company.example/functions/v1/lovelies-api#x"]:
            with self.subTest(value=value): self.assertFalse(guard.valid_api_origin(value))
if __name__=="__main__":unittest.main()

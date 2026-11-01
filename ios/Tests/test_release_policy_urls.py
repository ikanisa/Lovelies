"""Local artifact-input tests. No URL here is contacted or qualified."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "release_policy_urls", Path(__file__).resolve().parents[1] / "scripts" / "check_release_policy_urls.py"
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReleasePolicyURLTests(unittest.TestCase):
    def test_missing_and_unexpanded_inputs_fail(self):
        for raw in (None, "", "$(LOVELIES_PRIVACY_POLICY_URL)", "https://${POLICY_HOST}/privacy"):
            with self.subTest(raw=raw):
                self.assertFalse(gate.valid_url(raw))

    def test_private_insecure_and_credential_urls_fail(self):
        for raw in ("http://policies.acceptance-fixture.com/privacy", "https://localhost/privacy",
                    "https://127.0.0.1/privacy", "https://10.0.0.1/privacy", "https://example.com/privacy",
                    "https://privacy.example.com/privacy", "https://a.b.example.org/privacy", "https://support.example.net/help",
                    "https://bad_label.acceptance-fixture.com/privacy", "https://-bad.acceptance-fixture.com/privacy",
                    "https://bad-.acceptance-fixture.com/privacy", "https://bad..acceptance-fixture.com/privacy",
                    "https://" + "a" * 64 + ".acceptance-fixture.com/privacy",
                    "https://policy.invalid/privacy", "https://user:secret@policies.acceptance-fixture.com/privacy",
                    "https://policies.acceptance-fixture.com:8443/privacy", "https://policies.acceptance-fixture.com/privacy?token=x",
                    "https://policies.acceptance-fixture.com/privacy#section", " https://policies.acceptance-fixture.com/privacy"):
            with self.subTest(raw=raw):
                self.assertFalse(gate.valid_url(raw))

    def test_public_https_shape_is_configurable_but_does_not_claim_content_acceptance(self):
        self.assertTrue(gate.valid_url("https://policies.acceptance-fixture.com/privacy"))
        self.assertTrue(gate.valid_url("https://policies.acceptance-fixture.com:443/account-deletion"))


if __name__ == "__main__":
    unittest.main()

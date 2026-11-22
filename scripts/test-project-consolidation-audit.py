#!/usr/bin/env python3
"""Offline synthetic Git fixtures for the source-history audit, not app tests."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('source_audit', Path(__file__).with_name('project-consolidation-audit.py'))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'source'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'audit-fixture@example.invalid')
        self.git('config', 'user.name', 'Audit Fixture')
        (self.repo / 'shared.txt').write_text('base\n')
        self.base = self.commit('base')
        self.git('branch', 'candidate')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def audit(self, main, candidate, label='evidence'):
        before = (self.git('show-ref'), self.git('status', '--porcelain'), self.git('rev-parse', 'HEAD'))
        result = AUDIT.audit(self.repo, self.root / label,
                             {'base': self.base, 'main': main, 'candidate': candidate})
        after = (self.git('show-ref'), self.git('status', '--porcelain'), self.git('rev-parse', 'HEAD'))
        self.assertEqual(before, after)
        return result

    def test_clean_divergence_and_bundle_restore(self):
        (self.repo / 'main-only.txt').write_text('new main work\n')
        main = self.commit('main work')
        self.git('checkout', 'candidate')
        (self.repo / 'candidate-only.txt').write_text('candidate work\n')
        candidate = self.commit('candidate work')
        report = self.audit(main, candidate)
        self.assertTrue(report['textual_merge_clean'])
        self.assertFalse(report['candidate_ancestor_of_main'])
        self.assertEqual(report['conflict_paths'], [])
        restored = self.root / 'restored.git'
        subprocess.check_call(['git', 'clone', '--bare', str(self.root / 'evidence/Lovelies-project-history.bundle'), str(restored)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        got = subprocess.check_output(['git', '--git-dir', str(restored), 'rev-parse', 'audit-candidate']).decode().strip()
        self.assertEqual(got, candidate)
        self.assertFalse(report['application_tests_run'])
        self.assertFalse(report['production_acceptance'])

    def test_conflict_preserves_both_histories(self):
        (self.repo / 'shared.txt').write_text('new main behavior\n')
        main = self.commit('main behavior')
        self.git('checkout', 'candidate')
        (self.repo / 'shared.txt').write_text('different candidate behavior\n')
        candidate = self.commit('candidate behavior')
        report = self.audit(main, candidate)
        self.assertFalse(report['textual_merge_clean'])
        self.assertEqual(report['conflict_paths'], ['shared.txt'])
        self.assertEqual(report['overlapping_changed_paths'], ['shared.txt'])

    def test_already_included_candidate(self):
        (self.repo / 'new.txt').write_text('new\n')
        main = self.commit('main work')
        result = self.audit(main, self.base)
        self.assertTrue(result['candidate_ancestor_of_main'])
        self.assertTrue(result['textual_merge_clean'])

    def test_rejects_non_sha_and_in_tree_output(self):
        with self.assertRaises(ValueError):
            AUDIT.audit(self.repo, self.root / 'bad', {'base': self.base, 'main': 'main', 'candidate': self.base})
        with self.assertRaises(ValueError):
            AUDIT.audit(self.repo, self.repo / 'evidence', {'base': self.base, 'main': self.base, 'candidate': self.base})

    def test_does_not_overwrite_evidence(self):
        self.audit(self.base, self.base)
        with self.assertRaises(ValueError):
            self.audit(self.base, self.base)

    def test_invalid_merge_base_fails_closed(self):
        (self.repo / 'new.txt').write_text('new\n')
        main = self.commit('main work')
        with self.assertRaises(ValueError):
            AUDIT.audit(self.repo, self.root / 'bad-base', {'base': main, 'main': main, 'candidate': self.base})


if __name__ == '__main__':
    unittest.main(verbosity=2)

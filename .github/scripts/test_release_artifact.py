import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('artifact_guard', Path(__file__).with_name('verify-release-artifact.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ArtifactTests(unittest.TestCase):
    def fixture(self):
        run = dict(id=123, repository=dict(full_name='mio-kobo/mio-vscode', id=456),
                   path='.github/workflows/publish-vscode.yml', event='push', head_branch='vscode-V0.3.1',
                   head_sha='a' * 40, status='completed', conclusion='failure')
        jobs = dict(jobs=[dict(name='build', conclusion='success'), dict(name='publish', conclusion='failure')])
        artifacts = dict(artifacts=[dict(id=789, name='vscode-0.3.1', expired=False,
                          workflow_run=dict(id=123, head_sha='a' * 40, repository_id=456))])
        return run, jobs, artifacts

    def test_accepts_verified_build_even_when_publish_failed(self):
        self.assertEqual(guard.verify(*self.fixture(), 'vscode-V0.3.1', 'a' * 40, 123), 789)

    def test_rejects_untrusted_run_or_tag(self):
        for field, value in [('repository', dict(full_name='other/repo', id=456)), ('path', 'other.yml'),
                             ('event', 'pull_request'), ('head_sha', 'b' * 40), ('status', 'in_progress'),
                             ('head_branch', 'main'), ('id', 999)]:
            run, jobs, artifacts = self.fixture()
            run[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                guard.verify(run, jobs, artifacts, 'vscode-V0.3.1', 'a' * 40, 123)
        with self.assertRaises(ValueError):
            guard.verify(*self.fixture(), 'vscode-V0.3.1/evil', 'a' * 40, 123)

    def test_rejects_failed_build_or_untrusted_artifact(self):
        run, jobs, artifacts = self.fixture()
        jobs['jobs'][0]['conclusion'] = 'failure'
        with self.assertRaises(ValueError):
            guard.verify(run, jobs, artifacts, 'vscode-V0.3.1', 'a' * 40, 123)
        for edit in [lambda a: a.update(expired=True), lambda a: a.update(name='vscode-0.3.2'),
                     lambda a: a['workflow_run'].update(id=999), lambda a: a['workflow_run'].update(head_sha='b' * 40),
                     lambda a: a['workflow_run'].update(repository_id=999)]:
            run, jobs, artifacts = self.fixture()
            edit(artifacts['artifacts'][0])
            with self.assertRaises(ValueError):
                guard.verify(run, jobs, artifacts, 'vscode-V0.3.1', 'a' * 40, 123)
        run, jobs, artifacts = self.fixture()
        artifacts['artifacts'].append(copy.deepcopy(artifacts['artifacts'][0]))
        with self.assertRaises(ValueError):
            guard.verify(run, jobs, artifacts, 'vscode-V0.3.1', 'a' * 40, 123)


if __name__ == '__main__':
    unittest.main()

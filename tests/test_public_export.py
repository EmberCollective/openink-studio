"""Public exports must build without private sources or development history."""
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from export_public import audit, export, git, unpack


class PublicExportTests(unittest.TestCase):
    def test_export_removes_private_dependency_and_starts_new_history(self):
        with tempfile.TemporaryDirectory() as temp:
            repo, output = Path(temp) / 'dev', Path(temp) / 'public'
            repo.mkdir()
            files = {
                '.gitattributes': 'private/ export-ignore\n',
                'private/secret.rs': 'private source',
                'docs/README.md': 'development docs',
                'desktop/Cargo.toml': '[package]\nname="app"\nversion="0.1.0"\n[features]\n# BEGIN PRIVATE GFONT\nprivate-gfont=["dep:openink-gfont"]\n# END PRIVATE GFONT\n[dependencies]\n# BEGIN PRIVATE GFONT\nopenink-gfont={path="../private", optional=true}\n# END PRIVATE GFONT\n',
                'desktop/Cargo.lock': 'version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "openink-gfont",\n]\n\n[[package]]\nname = "openink-gfont"\nversion = "0.1.0"\n',
            }
            for name, text in files.items():
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding='utf-8')
            git(repo, 'init', '--quiet')
            git(repo, 'add', '--all')
            git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'private history')
            export(repo, output, init_git=True)
            self.assertFalse((output / 'private').exists())
            self.assertNotIn('openink-gfont', (output / 'desktop/Cargo.lock').read_text())
            self.assertEqual(git(output, 'rev-list', '--count', 'HEAD', capture_output=True, text=True).stdout.strip(), '1')
            self.assertNotEqual(git(repo, 'rev-parse', 'HEAD', capture_output=True).stdout,
                                git(output, 'rev-parse', 'HEAD', capture_output=True).stdout)
            self.assertEqual(git(output, 'remote', capture_output=True).stdout, b'')
            (repo / 'current.txt').write_text('uncommitted', encoding='utf-8')
            (repo / '.env').write_text('PRIVATE_TEST_TOKEN=example', encoding='utf-8')
            preview = export(repo, Path(temp) / 'preview', worktree=True)
            self.assertTrue((preview / 'current.txt').exists())
            self.assertFalse((preview / 'private').exists())
            self.assertFalse((preview / '.git').exists())
            self.assertFalse((preview / '.env').exists())
            with self.assertRaises(ValueError):
                export(repo, output)
            (preview / 'leaked.gfont').write_bytes(b'private fixture')
            with self.assertRaisesRegex(ValueError, 'Private/build file'):
                audit(preview)

    def test_sensitive_files_are_rejected_in_committed_exports(self):
        from export_public import private_path
        for name in ['Private/gfont/src/lib.rs', 'FONTS/sample.gfont', 'DOCS/BUGS/README.md', 'tools/GFONT_TOOL.PY', '.env', '.env.local', '.aws/credentials', '.ssh/id_rsa', '.npmrc', 'secret.key', 'session.log', 'output.jsonl', 'work.inkproj', 'work.kjoy', 'paper.pdf', 'docs/bugs/README.md', 'docs/contracts/官方G-code生成链.md', 'svg-test/data.svg']:
            with self.subTest(name=name):
                self.assertTrue(private_path(name))
        self.assertFalse(private_path('assets/readme/workspace.png'))

    def test_archive_traversal_and_links_are_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('C:/escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                archive = Path(temp) / 'input.tar'
                with tarfile.open(archive, 'w') as stream:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    stream.addfile(entry, io.BytesIO(b''))
                with self.assertRaises(ValueError):
                    unpack(archive, Path(temp) / 'out')


if __name__ == '__main__':
    unittest.main()

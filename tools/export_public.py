"""Export an independent, audited source tree; never copy development Git objects."""
import argparse
import fnmatch
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_BLOCK = re.compile(r"^# BEGIN PRIVATE GFONT\r?\n.*?^# END PRIVATE GFONT\r?\n?", re.M | re.S)
PRIVATE_FILES = {
    'kenjoy_crypt.py', 'gfont_tool.py', 'gfont_write.py', 'official_write.py',
    'preview_yong.py', 'legacy_font.rs', 'legacy_oracle.py',
    'test_gfont_reader.py', 'test_official_write.py', 'test_write_svg_position.py',
    '奎享写字机逆向工程契约报告.md', '官方G-code生成链.md', '官方连接与配置链.md',
}


def git(repo, *args, **kwargs):
    env = os.environ.copy()
    env['GIT_CONFIG_GLOBAL'] = os.devnull
    # A separate snapshot must not inherit a caller's index or object store.
    for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'):
        env.pop(key, None)
    return subprocess.run(['git', '-c', f'safe.directory={repo.as_posix()}', '-c', 'core.autocrlf=false', '-c', 'core.excludesFile=/dev/null',
                           '-c', 'core.hooksPath=/dev/null', '-C', str(repo), *args],
                          env=env, check=True, **kwargs)


def private_path(name):
    name = name.casefold()
    path = PurePosixPath(name)
    return (bool(set(path.parts) & {'.git', '.aws', '.ssh', '.codex', '.agents', 'private', 'fonts', 'src-reversed', 'jars', '.cache', 'node_modules', 'target', '__pycache__'})
            or path.name in {p.casefold() for p in PRIVATE_FILES} or path.suffix.lower() in {'.gfont', '.jar', '.class', '.exe', '.dll'}
            or path.name == '.env' or path.name.startswith('.env.') or path.name in {'.npmrc', '.pypirc', 'credentials'}
            or path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.log', '.jsonl', '.inkproj', '.kjoy', '.pdf'}
            or name.startswith(('docs/evidence/', 'docs/bugs/', 'docs/samples/', 'docs/research/', 'docs/operations/', 'svg-test/', 'desktop/tests/data/'))
            or fnmatch.fnmatch(path.name, 'legacy-golden.json'))


def audit(tree):
    for file in tree.rglob('*'):
        if not file.is_file():
            continue
        name = file.relative_to(tree).as_posix()
        if private_path(name):
            raise ValueError(f'Private/build file in public export: {name}')
        text = file.read_bytes().decode('utf-8', errors='replace')
        if re.search(r'^\s*(?:pub\s+)?fn\s+decrypt_header\b|^\s*const\s+(?:TEA_)?KEY\s*:', text, re.M):
            raise ValueError(f'Private decoder/key declaration in public export: {name}')
    manifest = tomllib.loads((tree / 'desktop/Cargo.toml').read_text(encoding='utf-8'))
    if 'private-gfont' in manifest.get('features', {}) or 'openink-gfont' in manifest.get('dependencies', {}):
        raise ValueError('Private Cargo dependency was not removed')
    lock = tomllib.loads((tree / 'desktop/Cargo.lock').read_text(encoding='utf-8'))
    if any(p['name'] == 'openink-gfont' for p in lock['package']):
        raise ValueError('Private Cargo package remains in lockfile')


def unpack(archive, tree):
    with tarfile.open(archive) as source:
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or ':' in member.name:
                raise ValueError('Unsafe archive path')
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('Archive links and special files are not supported')
            target = tree.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as data:
                target.write_bytes(data.read())


def export(repo, output, ref='HEAD', worktree=False, init_git=False):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError('Output already exists; choose a fresh directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openink-export-', dir=output.parent) as temp:
        temp = Path(temp)
        archive_repo, archive_ref = repo, ref
        if worktree:
            archive_repo = temp / 'snapshot'
            archive_repo.mkdir()
            names = git(repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', capture_output=True).stdout
            for raw in names.split(b'\0'):
                if not raw:
                    continue
                name = raw.decode('utf-8')
                source = repo / name
                if not private_path(name) and source.is_file():
                    if source.is_symlink():
                        raise ValueError(f'Source symlink is not supported: {name}')
                    target = archive_repo / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
            git(archive_repo, 'init', '--quiet')
            git(archive_repo, 'add', '--all')
            archive_ref = git(archive_repo, 'write-tree', capture_output=True, text=True).stdout.strip()
        archive = temp / 'source.tar'
        with archive.open('wb') as stream:
            git(archive_repo, 'archive', '--format=tar', archive_ref, stdout=stream)
        tree = temp / 'public'
        tree.mkdir()
        unpack(archive, tree)
        manifest = tree / 'desktop/Cargo.toml'
        manifest.write_text(PRIVATE_BLOCK.sub('', manifest.read_text(encoding='utf-8')), encoding='utf-8')
        lock = tree / 'desktop/Cargo.lock'
        packages = re.split(r'(?=^\[\[package\]\]$)', lock.read_text(encoding='utf-8'), flags=re.M)
        lock.write_text(''.join(p for p in packages if not re.search(r'^name = "openink-gfont"$', p, re.M))
                        .replace(' "openink-gfont",\n', ''), encoding='utf-8')
        (tree / 'docs/README.md').write_text('# 文档\n\n- [契约与规范](contracts/)\n- [纸面对位校准图](calibration/)\n- [公开与私有构建](contracts/公开与私有构建.md)\n', encoding='utf-8')
        audit(tree)
        if init_git:
            git(tree, 'init', '--quiet', '--initial-branch=main')
            git(tree, 'add', '--all')
            git(tree, '-c', 'user.name=OpenInk Export', '-c', 'user.email=export@localhost',
                'commit', '--quiet', '-m', 'Initial public source export')
        tree.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New destination directory')
    parser.add_argument('--ref', default='HEAD', help='Committed snapshot (default: HEAD)')
    parser.add_argument('--worktree', action='store_true', help='Preview current files, including uncommitted changes')
    parser.add_argument('--init-git', action='store_true', help='Create a fresh repository with one root commit and no remote')
    args = parser.parse_args()
    print(export(ROOT, args.output, args.ref, args.worktree, args.init_git))


if __name__ == '__main__':
    main()

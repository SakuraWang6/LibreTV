#!/usr/bin/env python3
"""Prepare a private, pinned official Quark CLI. Does not execute or log in."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import urllib.request
import zipfile

VERSION = '1.0.25'
URL = 'https://pdds.quark.cn/download/stfile/eekkigineefiegmgo/quarkclouddrive-1.0.25.zip'
ZIP_SHA256 = '56c34e9a9313ae29d39475b4ff9da9e92fbfd59699bf5843e3382e54434fffb8'
FILES = {
    'scripts/quark-drive.cjs': 'b19755822486bd812c76e15de31e9213bccfa2cc6ed1e639c43201e5cf2e07b5',
    'scripts/hash-worker.cjs': 'b0d886c4835af1cd426cf7519a267d7db7311d403984a965d07e2227de7a40a2',
}


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def private_directory(target):
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir():
            raise ValueError('Private runtime path must be a real directory')
    else:
        target.mkdir(mode=0o700, parents=True)
    target.chmod(0o700)


def atomic_file(target, content):
    if target.is_symlink():
        raise ValueError('Runtime files must not be symbolic links')
    descriptor, temporary = tempfile.mkstemp(prefix='.prepare-', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--archive', type=Path, help='Use an already downloaded official archive; hash is always checked')
    arguments = parser.parse_args()
    root = arguments.runtime_dir
    if not root.is_absolute():
        parser.error('--runtime-dir must be absolute')
    if root.is_symlink():
        raise ValueError('Runtime root must not be a symbolic link')
    root = root.resolve()
    private_directory(root)
    if (root / '.command-lock').exists():
        raise ValueError('Quark is busy; prepare after the running command has finished')
    if arguments.archive:
        archive_bytes = arguments.archive.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            if response.geturl() != URL:
                raise ValueError('Unexpected official download redirect')
            archive_bytes = response.read(2 * 1024 * 1024 + 1)
    if len(archive_bytes) > 2 * 1024 * 1024 or sha256(archive_bytes) != ZIP_SHA256:
        raise ValueError('Official archive SHA256 mismatch')
    import io
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        names = set()
        for item in archive.infolist():
            entry = Path(item.filename)
            if entry.is_absolute() or '..' in entry.parts or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('Unsafe archive entry')
            if item.filename in names or item.file_size > 2 * 1024 * 1024:
                raise ValueError('Unexpected archive entry')
            names.add(item.filename)
        selected = {}
        for filename, digest in FILES.items():
            content = archive.read(filename)
            if sha256(content) != digest:
                raise ValueError('Official runtime file SHA256 mismatch')
            selected[filename] = content
    for name in ['scripts', 'private-home', 'cwd', 'tmp', 'codex']:
        private_directory(root / name)
    for filename, content in selected.items():
        atomic_file(root / filename, content)
    shim = Path(__file__).with_name('isolate.cjs').read_bytes()
    atomic_file(root / 'isolate.cjs', shim)
    atomic_file(root / 'runtime.json', (json.dumps({
        'version': VERSION, 'archiveSha256': ZIP_SHA256,
        'files': FILES, 'isolateSha256': sha256(shim),
    }, indent=2) + '\n').encode())
    print(json.dumps({'prepared': True, 'version': VERSION, 'runtimeDir': str(root)}, ensure_ascii=False))


if __name__ == '__main__':
    main()

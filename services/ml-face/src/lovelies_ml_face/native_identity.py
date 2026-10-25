"""Bounded installed-native identity, independent of an image ID or package version.

Linux AMD64 hashes the complete admitted ELF roots, including lazy codec/plugin
objects. Darwin is an explicitly separate local engineering scope. Loaded maps
validate the admitted inventory; import-order-dependent subsets do not change
its digest. No model/image bytes, credentials, subprocess or native code is run.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import sys
import sysconfig
import threading
import time


class NativeIdentityError(RuntimeError):
    """A bounded code only; never include environment values or outside paths."""


@dataclass(frozen=True)
class _Limits:
    # The selected native OpenCV object is317,525,360bytes. A256MiB
    # ceiling cannot describe it;512MiB is the explicit bounded consumer policy.
    object_bytes: int = 512 * 1024 ** 2
    total_bytes: int = 2 * 1024 ** 3
    objects: int = 4096
    entries: int = 131072
    seconds: float = 15.0


_LIMITS = _Limits()
_OVERRIDES = ('LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
              'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH')
_MACHO = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe',
          b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}
_LOCK = threading.Lock()
_CACHE = None
# Exact cv2 bootstrap/configuration shipped with the selected native wheel.
# Its Unix bootstrap adds this one search path plus a trailing empty entry even
# when the application supplied no loader override. Never inherit that entry in
# a worker, and never discard an unknown operator-supplied path to make it pass.
_CV2_BOOTSTRAP_FILES = {
    '__init__.py': (6612, '936bd94c5a5debf0212fc751af79d3a163652f3e850259df2159db6aa3ed8ad8'),
    'config.py': (109, '1db3463a96f58a82123a847d1507228d9e8a80006de67401ae835917658ebe87'),
    'config-3.py': (724, '9a7aadf724b822001f5e963b01fd4e375d45e2cbbe328d2ca7b42a440c083a1c'),
    'load_config_py3.py': (244, '9c22766454a9ac2f6869d37830b2efc699e7b8c3125484e9976c6e677c066029'),
}


def _require(value, code):
    if not value:
        raise NativeIdentityError(code)


def _guard_environment(environment):
    _require(not any(environment.get(name) for name in _OVERRIDES), 'native_loader_override_denied')


def _facts():
    return {'os': platform.system(), 'architecture': platform.machine().lower(),
            'implementation': sys.implementation.name, 'python': platform.python_version(),
            'abi': sysconfig.get_config_var('SOABI') or sys.implementation.cache_tag,
            'byteorder': sys.byteorder}


def _deadline(clock, deadline):
    _require(clock() <= deadline, 'native_identity_deadline_exceeded')


def _metadata(path, strict):
    value = path.lstat()
    _require(stat.S_ISREG(value.st_mode) or stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode),
             'native_inventory_special_file')
    if strict:
        _require(value.st_uid == 0, 'native_inventory_owner_not_root')
        # Symlink permission bits have no access-control meaning on Linux.
        _require(stat.S_ISLNK(value.st_mode) or not value.st_mode & 0o022,
                 'native_inventory_group_or_world_writable')
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns,
            os.readlink(path) if stat.S_ISLNK(value.st_mode) else None)


def _admitted(path, roots, executable):
    return path == executable or any(path == root or path.is_relative_to(root) for root in roots)


def _native_magic(prefix, kind):
    return prefix == b'\x7fELF' if kind == 'elf' else prefix in _MACHO


def _normalize_cv2_bootstrap(environment, facts, deadline):
    value = environment.get('LD_LIBRARY_PATH')
    if not value:
        return
    other_keys = tuple(name for name in _OVERRIDES if name != 'LD_LIBRARY_PATH')
    _require(not any(environment.get(name) for name in other_keys), 'native_loader_override_denied')
    strict = facts['os'] == 'Linux' and facts['architecture'] in {'amd64', 'x86_64'}
    _require(strict or facts['os'] == 'Darwin', 'native_loader_override_denied')
    version = '.'.join(facts['python'].split('.')[:2])
    package = Path(sys.prefix).resolve(strict=True) / 'lib' / ('python' + version) / 'site-packages' / 'cv2'
    expected = os.path.join(os.path.join(str(package), '../../'), 'lib') + ':'
    module = sys.modules.get('cv2')
    _require(value == expected and module is not None, 'native_loader_override_denied')
    _require(getattr(module, '__file__', None) == str(package / '__init__.py'), 'native_cv2_bootstrap_origin_changed')
    extension = getattr(getattr(module, '_native', None), '__file__', None)
    _require(isinstance(extension, str), 'native_cv2_binary_origin_changed')
    extension = Path(extension)
    _require(extension.parent == package and extension.suffix == '.so'
             and extension.resolve(strict=True) == extension, 'native_cv2_binary_origin_changed')
    for path in reversed((package, *package.parents)):
        _deadline(time.monotonic, deadline)
        metadata = _metadata(path, strict)
        _require(stat.S_ISDIR(metadata[2]), 'native_cv2_bootstrap_origin_changed')
    for name, (length, expected_hash) in _CV2_BOOTSTRAP_FILES.items():
        path = package / name
        _deadline(time.monotonic, deadline)
        before = _metadata(path, strict)
        _require(stat.S_ISREG(before[2]) and before[5] == length, 'native_cv2_bootstrap_source_changed')
        with path.open('rb') as source:
            raw = source.read(length + 1)
        _deadline(time.monotonic, deadline)
        _require(len(raw) == length and hashlib.sha256(raw).hexdigest() == expected_hash
                 and _metadata(path, strict) == before, 'native_cv2_bootstrap_source_changed')
    before = _metadata(extension, strict)
    _require(stat.S_ISREG(before[2]), 'native_cv2_binary_origin_changed')
    with extension.open('rb') as source:
        prefix = source.read(4)
    _require(_native_magic(prefix, 'elf' if strict else 'macho') and _metadata(extension, strict) == before,
             'native_cv2_binary_origin_changed')
    _deadline(time.monotonic, deadline)
    _require(environment.get('LD_LIBRARY_PATH') == value and not any(environment.get(name) for name in other_keys),
             'native_loader_override_denied')
    environment.pop('LD_LIBRARY_PATH', None)


def _mapped_elf_paths(maps_path=Path('/proc/self/maps'), *, clock=time.monotonic, deadline=None):
    """Bounded current-process ELF closure. Ignore anonymous/vdso/non-ELF maps."""
    if not maps_path.exists():
        return None
    _require(maps_path.is_file(), 'native_process_maps_unavailable')
    paths, consumed = set(), 0
    with maps_path.open('r', encoding='utf8', errors='strict') as handle:
        for index, line in enumerate(handle):
            if deadline is not None:
                _deadline(clock, deadline)
            consumed += len(line)
            _require(index < 65536 and consumed <= 8 * 1024 ** 2, 'native_process_maps_too_large')
            fields = line.rstrip('\n').split(None, 5)
            if len(fields) < 6 or not fields[5].startswith('/'):
                continue
            name = fields[5]
            if name.endswith(' (deleted)'):
                _require('x' not in fields[1], 'native_deleted_executable_mapping')
                continue
            path = Path(name)
            try:
                if not path.is_file():
                    _require('x' not in fields[1], 'native_unreadable_executable_mapping')
                    continue
                with path.open('rb') as source:
                    prefix = source.read(4)
                if prefix == b'\x7fELF':
                    paths.add(path.resolve(strict=True))
                    _require(len(paths) <= _LIMITS.objects, 'native_mapped_object_count_exceeded')
            except OSError:
                raise NativeIdentityError('native_mapped_object_unreadable') from None
    return tuple(sorted(paths))


def _validate_mapped(mapped, rows, roots, executable):
    if mapped is None:
        return {'validation': 'unavailable', 'object_count': None}
    installed = {row['path'] for row in rows}
    for path in mapped:
        canonical = path.resolve(strict=True)
        _require(_admitted(canonical, roots, executable) and str(canonical) in installed,
                 'native_loaded_elf_outside_inventory')
    return {'validation': 'verified', 'object_count': len(set(mapped))}


def _collect(roots, executable, facts, *, strict, kind, mapped=None, limits=_LIMITS,
             clock=time.monotonic, deadline=None):
    """Internal fixture seam. Runtime callers cannot configure roots or budgets."""
    began = clock()
    deadline = min(deadline, began + limits.seconds) if deadline is not None else began + limits.seconds
    roots = tuple(sorted({Path(path).resolve(strict=True) for path in roots}))
    executable = Path(executable).resolve(strict=True)
    _require(roots and all(path.is_dir() for path in roots) and executable.is_file(),
             'native_inventory_roots_or_interpreter_missing')
    snapshots, rows, visited, entries, total = {}, [], set(), 0, 0

    def remember(path):
        nonlocal entries
        _deadline(clock, deadline)
        if path not in snapshots:
            entries += 1
            _require(entries <= limits.entries, 'native_inventory_entry_budget_exceeded')
            snapshots[path] = _metadata(path, strict)
        return snapshots[path]

    def visit(path):
        nonlocal total
        _deadline(clock, deadline)
        before = remember(path)
        if path.is_symlink():
            resolved = path.resolve(strict=True)
            if _admitted(resolved, roots, executable):
                visit(resolved)
            return
        canonical = path.resolve(strict=True)
        if canonical in visited:
            return
        visited.add(canonical)
        if path.is_dir():
            # Exclude metadata/source archives and models even if a future
            # installation places them below a fixed admitted native root.
            if path.name in {'__pycache__', 'models', 'docs', 'doc'}:
                return
            with os.scandir(path) as children:
                for child in children:
                    visit(Path(child.path))
            _require(_metadata(path, strict) == before, 'native_inventory_changed_during_read')
            return
        _require(path.is_file(), 'native_inventory_ordinary_object_required')
        with path.open('rb') as source:
            prefix = source.read(4)
            if not _native_magic(prefix, kind):
                return
            length = before[5]
            _require(0 < length <= limits.object_bytes, 'native_object_size_exceeded')
            _require(len(rows) < limits.objects, 'native_object_count_exceeded')
            total += length
            _require(total <= limits.total_bytes, 'native_total_bytes_exceeded')
            digest = hashlib.sha256()
            digest.update(prefix)
            read = len(prefix)
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                _deadline(clock, deadline)
                read += len(chunk)
                _require(read <= length, 'native_inventory_changed_during_read')
                digest.update(chunk)
        _require(read == length and _metadata(path, strict) == before, 'native_inventory_changed_during_read')
        rows.append({'path': str(canonical), 'bytes': length, 'sha256': digest.hexdigest()})

    for root in roots:
        # Parent ownership/mode guards protect cache aliases without reading
        # siblings or admitting unrelated filesystem payloads.
        if strict:
            for parent in reversed(root.parents):
                remember(parent)
        visit(root)
    if strict:
        for parent in reversed(executable.parents):
            remember(parent)
    visit(executable)
    rows.sort(key=lambda row: row['path'])
    _require(rows and str(executable) in {row['path'] for row in rows}, 'native_interpreter_identity_missing')
    mapped_status = _validate_mapped(mapped, rows, roots, executable)
    scope = 'linux-amd64-installed-elf-roots-v1' if strict else 'local-darwin-mach-o-engineering-v1'
    contract = {'schema': 'lovelies-native-processing-identity-v1', 'scope': scope,
                'platform': facts, 'roots': [str(path) for path in roots], 'objects': rows}
    identity = {'digest': hashlib.sha256(json.dumps(contract, sort_keys=True, separators=(',', ':'),
                    allow_nan=False).encode()).hexdigest(), 'scope': scope,
                'architecture': facts['architecture'], 'os': facts['os'], 'python_abi': facts['abi'],
                'object_count': len(rows), 'total_bytes': total, 'complete_admitted_roots': strict,
                'mapped_elf_validation': mapped_status['validation'], 'mapped_elf_objects': mapped_status['object_count']}
    return identity, snapshots, rows, roots, executable


def _cache_valid(cache, clock=time.monotonic, deadline=None):
    deadline = deadline if deadline is not None else clock() + _LIMITS.seconds
    for path, expected in cache['snapshots'].items():
        _deadline(clock, deadline)
        _require(_metadata(path, cache['strict']) == expected, 'native_inventory_changed_after_identity')


def _runtime_selection(facts):
    executable = Path(sys.executable).resolve(strict=True)
    if facts['os'] == 'Linux' and facts['architecture'] in {'x86_64', 'amd64'}:
        roots = (Path(sys.prefix), Path(sys.base_prefix)/'lib', Path('/usr/lib'), Path('/lib'))
        return roots, executable, True, 'elf'
    _require(facts['os'] == 'Darwin', 'native_identity_platform_unsupported')
    roots = {Path(sys.prefix), Path(sys.base_prefix)/'lib'}
    for name in ('cv2', 'numpy', 'PIL', 'pillow_heif', 'pydantic_core'):
        spec = importlib.util.find_spec(name)
        _require(spec is not None and spec.origin, 'local_native_package_missing')
        roots.add(Path(spec.origin).resolve(strict=True).parent)
    return tuple(roots), executable, False, 'macho'


def _runtime_mapped(strict, deadline):
    if not strict:
        return None
    mapped = _mapped_elf_paths(deadline=deadline)
    _require(mapped is not None, 'native_process_maps_unavailable')
    return mapped


def native_processing_identity():
    """Return cached binary digest and explicit scope; fail closed on mutation.

    Linux AMD64 requires immutable root-owned installed roots. macOS provides a
    separate local engineering identity, never a complete Linux/image claim.
    """
    global _CACHE
    try:
        deadline = time.monotonic() + _LIMITS.seconds
        facts = _facts()
        roots, executable, strict, kind = _runtime_selection(facts)
        _require(_LOCK.acquire(timeout=max(0, deadline-time.monotonic())), 'native_identity_deadline_exceeded')
        try:
            _normalize_cv2_bootstrap(os.environ, facts, deadline)
            _guard_environment(os.environ)
            if _CACHE is not None:
                _require(_CACHE['facts'] == facts, 'native_platform_changed_after_identity')
                _require(tuple(sorted({Path(path).resolve(strict=True) for path in roots})) == _CACHE['roots']
                         and executable == _CACHE['executable'] and strict == _CACHE['strict'],
                         'native_roots_changed_after_identity')
                _cache_valid(_CACHE, deadline=deadline)
                mapped = _runtime_mapped(strict, deadline)
                mapped_status = _validate_mapped(mapped, _CACHE['rows'], _CACHE['roots'], _CACHE['executable'])
                _guard_environment(os.environ)
                result = dict(_CACHE['identity'])
                result.update(mapped_elf_validation=mapped_status['validation'], mapped_elf_objects=mapped_status['object_count'])
                return result
            mapped = _runtime_mapped(strict, deadline)
            identity, snapshots, rows, canonical_roots, canonical_executable = _collect(
                roots, executable, facts, strict=strict, kind=kind, mapped=mapped, deadline=deadline)
            # Hashing itself may lazily load a native crypto provider. Validate
            # the resulting mapped closure too, without binding import order.
            mapped = _runtime_mapped(strict, deadline)
            mapped_status = _validate_mapped(mapped, rows, canonical_roots, canonical_executable)
            identity.update(mapped_elf_validation=mapped_status['validation'],
                            mapped_elf_objects=mapped_status['object_count'])
            _guard_environment(os.environ)
            _CACHE = {'facts': facts, 'identity': identity, 'snapshots': snapshots, 'rows': rows,
                      'roots': canonical_roots, 'executable': canonical_executable, 'strict': strict}
            return dict(identity)
        finally:
            _LOCK.release()
    except NativeIdentityError:
        raise
    except (OSError, ValueError, RuntimeError):
        raise NativeIdentityError('native_identity_inventory_unavailable') from None

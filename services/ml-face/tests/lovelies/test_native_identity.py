"""Native identity contracts over tiny engineering files; no installed-root/model scan."""
from dataclasses import replace
from pathlib import Path
import hashlib
import os
import stat
import time
from types import SimpleNamespace
import pytest
from lovelies_ml_face import native_identity as native

def facts(architecture='x86_64'):
    return {'os': 'Linux', 'architecture': architecture, 'implementation': 'cpython', 'python': '3.13.17', 'abi': 'cpython-313-x86_64-linux-gnu', 'byteorder': 'little'}

def fixture(tmp_path):
    root = tmp_path / 'lib'
    root.mkdir()
    executable = root / 'python'
    executable.write_bytes(b'\x7fELFsynthetic-cpython')
    codec = root / 'private.so'
    codec.write_bytes(b'\x7fELFsynthetic-codec-a')
    (root / 'version.txt').write_text('all versions remain identical')
    return (root, executable, codec)

def collect(root, executable, **kwargs):
    return native._collect((root,), executable, facts(), strict=False, kind='elf', **kwargs)

def test_same_versions_with_different_native_bytes_change_identity(tmp_path):
    root, executable, codec = fixture(tmp_path)
    first = collect(root, executable)[0]
    codec.write_bytes(b'\x7fELFsynthetic-codec-b')
    second = collect(root, executable)[0]
    assert first['digest'] != second['digest']
    assert first['object_count'] == second['object_count'] == 2
    assert first['total_bytes'] == second['total_bytes']

def test_architecture_abi_and_interpreter_bytes_are_bound(tmp_path):
    root, executable, _ = fixture(tmp_path)
    initial = collect(root, executable)[0]['digest']
    for changed in [{**facts(), 'architecture': 'arm64'}, {**facts(), 'abi': 'different-cpython-abi'}]:
        value = native._collect((root,), executable, changed, strict=False, kind='elf')[0]
        assert value['digest'] != initial
    executable.write_bytes(b'\x7fELFnew-cpython-same-version')
    assert collect(root, executable)[0]['digest'] != initial

def test_realpath_aliases_and_duplicate_roots_do_not_double_count(tmp_path):
    root, executable, codec = fixture(tmp_path)
    original = collect(root, executable)[0]
    (root / 'alias.so').symlink_to(codec)
    root_alias = tmp_path / 'lib-alias'
    root_alias.symlink_to(root, target_is_directory=True)
    copied = native._collect((root, root_alias, root), executable, facts(), strict=False, kind='elf')[0]
    assert copied['digest'] == original['digest']
    assert copied['object_count'] == 2

def test_lazy_native_object_added_changes_identity_without_loading_it(tmp_path):
    root, executable, _ = fixture(tmp_path)
    first = collect(root, executable)[0]
    (root / 'lazy-codec.so').write_bytes(b'\x7fELFlazy-codec')
    second = collect(root, executable)[0]
    assert first['digest'] != second['digest'] and second['object_count'] == 3

def test_only_binary_magic_is_hashed_and_model_documentation_is_excluded(tmp_path):
    root, executable, _ = fixture(tmp_path)
    first = collect(root, executable)[0]['digest']
    (root / 'version.txt').write_text('a changed package label cannot substitute for binary identity')
    for folder in ('models', 'doc', 'docs', '__pycache__'):
        (root / folder).mkdir()
        (root / folder / 'excluded').write_bytes(b'\x7fELFnot-an-installed-native-root')
    assert collect(root, executable)[0]['digest'] == first

@pytest.mark.parametrize('limit,code', [({'object_bytes': 4}, 'native_object_size_exceeded'), ({'total_bytes': 4}, 'native_total_bytes_exceeded'), ({'objects': 1}, 'native_object_count_exceeded'), ({'entries': 1}, 'native_inventory_entry_budget_exceeded')])
def test_inventory_budgets_fail_closed_on_tiny_fixtures(tmp_path, limit, code):
    root, executable, _ = fixture(tmp_path)
    with pytest.raises(native.NativeIdentityError, match=code):
        collect(root, executable, limits=replace(native._LIMITS, **limit))

def test_inventory_deadline_is_enforced_during_traversal(tmp_path):
    root, executable, _ = fixture(tmp_path)
    elapsed = iter(range(100))
    with pytest.raises(native.NativeIdentityError, match='native_identity_deadline_exceeded'):
        collect(root, executable, clock=lambda: next(elapsed), limits=replace(native._LIMITS, seconds=0.5))

def test_mapped_closure_requires_admitted_hashed_elf_and_ignores_import_order(tmp_path):
    root, executable, codec = fixture(tmp_path)
    first = collect(root, executable, mapped=(executable,))[0]
    second = collect(root, executable, mapped=(codec, executable))[0]
    assert first['digest'] == second['digest']
    assert first['mapped_elf_objects'] == 1 and second['mapped_elf_objects'] == 2
    outside = tmp_path / 'outside.so'
    outside.write_bytes(b'\x7fELFoutside')
    with pytest.raises(native.NativeIdentityError, match='native_loaded_elf_outside_inventory'):
        collect(root, executable, mapped=(outside,))

def test_proc_maps_reads_only_real_elf_and_rejects_deleted_executables(tmp_path):
    root, executable, codec = fixture(tmp_path)
    maps = tmp_path / 'maps'
    maps.write_text(f"0-1 r-xp 0 00:00 0 [vdso]\n1-2 r-xp 0 00:00 3 {codec}\n2-3 r--p 0 00:00 3 {codec}\n3-4 r--p 0 00:00 4 {root / 'version.txt'}\n")
    assert native._mapped_elf_paths(maps) == (codec,)
    maps.write_text(f'1-2 r-xp 0 00:00 3 {codec} (deleted)\n')
    with pytest.raises(native.NativeIdentityError, match='native_deleted_executable_mapping'):
        native._mapped_elf_paths(maps)
    assert native._mapped_elf_paths(tmp_path / 'missing') is None

@pytest.mark.parametrize('name', native._OVERRIDES)
def test_loader_overrides_are_denied_without_exposing_values(name):
    with pytest.raises(native.NativeIdentityError) as error:
        native._guard_environment({name: 'synthetic-sensitive-value'})
    assert str(error.value) == 'native_loader_override_denied'
    native._guard_environment({name: ''})

def test_cache_guards_native_bytes_regular_metadata_and_new_entries(tmp_path, monkeypatch):
    root, executable, codec = fixture(tmp_path)
    monkeypatch.setattr(native, '_CACHE', None)
    monkeypatch.setattr(native, '_facts', facts)
    monkeypatch.setattr(native, '_runtime_selection', lambda _: ((root,), executable, False, 'elf'))
    for name in native._OVERRIDES:
        monkeypatch.delenv(name, raising=False)
    first = native.native_processing_identity()
    assert native.native_processing_identity() == first
    monkeypatch.setenv('LD_PRELOAD', 'synthetic-loader-setting')
    with pytest.raises(native.NativeIdentityError, match='native_loader_override_denied'):
        native.native_processing_identity()
    monkeypatch.delenv('LD_PRELOAD')
    codec.write_bytes(b'\x7fELFsynthetic-codec-b')
    with pytest.raises(native.NativeIdentityError, match='native_inventory_changed_after_identity'):
        native.native_processing_identity()
    monkeypatch.setattr(native, '_CACHE', None)
    native.native_processing_identity()
    (root / 'new-codec.so').write_bytes(b'\x7fELFnew-codec')
    with pytest.raises(native.NativeIdentityError, match='native_inventory_changed_after_identity'):
        native.native_processing_identity()

def test_linux_immutable_permission_guard_rejects_writable_or_unowned_files(tmp_path, monkeypatch):
    path = tmp_path / 'lib.so'
    path.write_bytes(b'\x7fELFfixture')
    actual = path.lstat()
    attributes = {name: getattr(actual, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
    with monkeypatch.context() as context:
        context.setattr(Path, 'lstat', lambda _: SimpleNamespace(**{**attributes, 'st_uid': 0, 'st_mode': stat.S_IFREG | 438}))
        with pytest.raises(native.NativeIdentityError, match='native_inventory_group_or_world_writable'):
            native._metadata(path, True)
    with monkeypatch.context() as context:
        context.setattr(Path, 'lstat', lambda _: SimpleNamespace(**{**attributes, 'st_uid': 12345, 'st_mode': stat.S_IFREG | 292}))
        with pytest.raises(native.NativeIdentityError, match='native_inventory_owner_not_root'):
            native._metadata(path, True)

def test_macho_engineering_scope_is_explicit_and_never_complete_linux(tmp_path):
    root = tmp_path / 'bundle'
    root.mkdir()
    executable = root / 'python'
    executable.write_bytes(b'\xcf\xfa\xed\xfeinterpreter')
    (root / 'codec.dylib').write_bytes(b'\xcf\xfa\xed\xfecodec')
    value = native._collect((root,), executable, {**facts('arm64'), 'os': 'Darwin'}, strict=False, kind='macho')[0]
    assert value['scope'] == 'local-darwin-mach-o-engineering-v1'
    assert value['complete_admitted_roots'] is False and value['object_count'] == 2
    assert value['mapped_elf_validation'] == 'unavailable'

@pytest.mark.parametrize('cached', [False, True])
def test_strict_linux_requires_proc_maps_on_initial_and_cached_identity(tmp_path, monkeypatch, cached):
    root, executable, _ = fixture(tmp_path)
    monkeypatch.setattr(native, '_facts', facts)
    monkeypatch.setattr(native, '_runtime_selection', lambda _: ((root,), executable, True, 'elf'))
    monkeypatch.setattr(native, '_mapped_elf_paths', lambda **_: None)
    for name in native._OVERRIDES:
        monkeypatch.delenv(name, raising=False)
    cache = {'facts': facts(), 'roots': (root,), 'executable': executable, 'strict': True,
             'snapshots': {}, 'rows': [], 'identity': {}}
    monkeypatch.setattr(native, '_CACHE', cache if cached else None)
    with pytest.raises(native.NativeIdentityError, match='native_process_maps_unavailable'):
        native.native_processing_identity()

def pipeline_fixture(monkeypatch, *, close_error=False):
    from lovelies_ml_face import engine
    for name in ('ML_USE_DETERMINISTIC_SIMULATOR', 'APP_ENV', 'CLOUDFLARE_ENV', 'ML_REQUIRE_MODEL_ARTIFACTS'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('ML_DEPLOYMENT_MODE', 'development')
    monkeypatch.setenv('FACE_AUTH_MAX_COSINE_DISTANCE', '0.35')
    monkeypatch.setattr(engine, 'load_manifest_object', lambda _: {'active_model_version': engine.MODEL})
    monkeypatch.setattr(engine, 'select_active_model', lambda _: {'version': engine.MODEL})
    monkeypatch.setattr(engine, 'native_processing_identity', lambda: {'digest': 'a' * 64, 'scope': 'fixture-native'})
    owned = []
    class Runtime:
        def __init__(self, *args, **kwargs):
            self.identity = {'processing_fingerprint': 'b' * 64}
            self.close_calls = 0
            owned.append(self)
        def close(self):
            self.close_calls += 1
            if close_error:
                raise RuntimeError('fixture cleanup failure')
    monkeypatch.setattr(engine, 'StillImageRuntime', Runtime)
    return engine, owned

@pytest.mark.parametrize('threshold', ['not-a-distance', '0.43'])
def test_invalid_auth_threshold_cannot_start_an_owned_child(tmp_path, monkeypatch, threshold):
    engine, owned = pipeline_fixture(monkeypatch)
    monkeypatch.setenv('FACE_AUTH_MAX_COSINE_DISTANCE', threshold)
    with pytest.raises((ValueError, RuntimeError)):
        engine.OpenFacePipeline(tmp_path / 'model-manifest.json')
    assert owned == []

@pytest.mark.parametrize('error_type', [OSError, KeyboardInterrupt])
@pytest.mark.parametrize('close_error', [False, True])
def test_post_start_identity_failure_closes_owned_child_and_preserves_primary(tmp_path, monkeypatch, error_type, close_error):
    engine, owned = pipeline_fixture(monkeypatch, close_error=close_error)
    primary = error_type('fixture source read failure')
    original_read = Path.read_bytes
    def read(path):
        if path.name == 'native_identity.py':
            raise primary
        return original_read(path)
    monkeypatch.setattr(Path, 'read_bytes', read)
    with pytest.raises(error_type) as raised:
        engine.OpenFacePipeline(tmp_path / 'model-manifest.json')
    assert raised.value is primary
    assert len(owned) == 1 and owned[0].close_calls == 1
    assert getattr(primary, '__notes__', []) == (['Owned inference runtime cleanup failed'] if close_error else [])

def cv2_bootstrap_fixture(tmp_path, monkeypatch, operating_system='Linux'):
    prefix = tmp_path / 'venv'
    package = prefix / 'lib/python3.13/site-packages/cv2'
    package.mkdir(parents=True)
    known_files = {}
    for name in native._CV2_BOOTSTRAP_FILES:
        raw = ('synthetic-pinned-cv2-' + name).encode()
        (package / name).write_bytes(raw)
        known_files[name] = (len(raw), hashlib.sha256(raw).hexdigest())
    extension = package / 'cv2.abi3.so'
    extension.write_bytes((b'\x7fELF' if operating_system == 'Linux' else b'\xcf\xfa\xed\xfe') + b'synthetic-cv2')
    module = SimpleNamespace(__file__=str(package / '__init__.py'), _native=SimpleNamespace(__file__=str(extension)))
    monkeypatch.setattr(native.sys, 'prefix', str(prefix))
    monkeypatch.setitem(native.sys.modules, 'cv2', module)
    monkeypatch.setattr(native, '_CV2_BOOTSTRAP_FILES', known_files)
    metadata = native._metadata
    def readonly_root_metadata(path, strict):
        value = list(metadata(path, False))
        if strict:
            value[2] &= ~0o022
            value[3] = 0
        return tuple(value)
    # Existing tests exercise real ownership/mode rejection separately. These
    # tiny files stand in for the root-owned read-only installation here.
    monkeypatch.setattr(native, '_metadata', readonly_root_metadata)
    selected_facts = {**facts(), 'os': operating_system}
    expected = os.path.join(os.path.join(str(package), '../../'), 'lib') + ':'
    return package, extension, module, selected_facts, expected

@pytest.mark.parametrize('operating_system', ['Linux', 'Darwin'])
def test_exact_known_cv2_bootstrap_path_is_normalized_after_origin_validation(tmp_path, monkeypatch, operating_system):
    _, _, _, selected_facts, expected = cv2_bootstrap_fixture(tmp_path, monkeypatch, operating_system)
    environment = {'LD_LIBRARY_PATH': expected}
    native._normalize_cv2_bootstrap(environment, selected_facts, time.monotonic() + 15)
    assert 'LD_LIBRARY_PATH' not in environment
    native._guard_environment(environment)

def test_cv2_normalizer_preserves_and_denies_foreign_suffixes_or_other_overrides(tmp_path, monkeypatch):
    _, _, _, selected_facts, expected = cv2_bootstrap_fixture(tmp_path, monkeypatch)
    for value in (expected + '/foreign', '/foreign:' + expected, expected + ':', expected[:-1]):
        environment = {'LD_LIBRARY_PATH': value}
        with pytest.raises(native.NativeIdentityError, match='native_loader_override_denied'):
            native._normalize_cv2_bootstrap(environment, selected_facts, time.monotonic() + 15)
        assert environment == {'LD_LIBRARY_PATH': value}
    for name in native._OVERRIDES:
        if name == 'LD_LIBRARY_PATH':
            continue
        environment = {'LD_LIBRARY_PATH': expected, name: '/foreign'}
        with pytest.raises(native.NativeIdentityError, match='native_loader_override_denied'):
            native._normalize_cv2_bootstrap(environment, selected_facts, time.monotonic() + 15)
        assert environment == {'LD_LIBRARY_PATH': expected, name: '/foreign'}

def test_cv2_normalizer_denies_mutated_bootstrap_files_and_outside_native_origin(tmp_path, monkeypatch):
    package, _, module, selected_facts, expected = cv2_bootstrap_fixture(tmp_path, monkeypatch)
    for name in native._CV2_BOOTSTRAP_FILES:
        path = package / name
        original = path.read_bytes()
        path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        environment = {'LD_LIBRARY_PATH': expected}
        with pytest.raises(native.NativeIdentityError, match='native_cv2_bootstrap_source_changed'):
            native._normalize_cv2_bootstrap(environment, selected_facts, time.monotonic() + 15)
        assert environment['LD_LIBRARY_PATH'] == expected
        path.write_bytes(original)
    outside = tmp_path / 'outside.so'
    outside.write_bytes(b'\x7fELFoutside')
    module._native.__file__ = str(outside)
    environment = {'LD_LIBRARY_PATH': expected}
    with pytest.raises(native.NativeIdentityError, match='native_cv2_binary_origin_changed'):
        native._normalize_cv2_bootstrap(environment, selected_facts, time.monotonic() + 15)
    assert environment['LD_LIBRARY_PATH'] == expected

def test_known_cv2_normalization_never_bypasses_strict_process_map_validation(tmp_path, monkeypatch):
    package, extension, _, selected_facts, expected = cv2_bootstrap_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(native, '_facts', lambda: selected_facts)
    monkeypatch.setattr(native, '_runtime_selection', lambda _: ((package,), extension, True, 'elf'))
    monkeypatch.setattr(native, '_mapped_elf_paths', lambda **_: None)
    monkeypatch.setattr(native, '_CACHE', None)
    for name in native._OVERRIDES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('LD_LIBRARY_PATH', expected)
    with pytest.raises(native.NativeIdentityError, match='native_process_maps_unavailable'):
        native.native_processing_identity()
    assert 'LD_LIBRARY_PATH' not in native.os.environ

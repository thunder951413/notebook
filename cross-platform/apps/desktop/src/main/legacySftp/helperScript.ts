/**
 * Repository maintenance helper. The helper is a single-file Python 3 script
 * executed over an SSH channel (fed via base64 so no quoting issues and no
 * files need to be uploaded); servers without python3 return a non-zero exit
 * and callers fall back to the plain SFTP path.
 */
export const REPOSITORY_HELPER = String.raw`import gzip, hashlib, json, os, posixpath, re, shutil, sys, tarfile, tempfile, time, uuid

ALLOWED_ROOT_FILES = {'library.json', 'notes/index.json', 'notes/reading_positions.json', 'notes/assets_manifest.json', 'notes/privacy.json'}
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_REPOSITORY_BYTES = 512 * 1024 * 1024
LOCK_RETRIES = 30
LOCK_RETRY_SECONDS = 1
LOCK_STALE_SECONDS = 30 * 60
GC_GRACE_SECONDS = 7 * 24 * 60 * 60
GC_QUARANTINE_SECONDS = 30 * 24 * 60 * 60
RECOVERY_DIRECTORY = '.notebook-next-recovery'
UUID_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
HASH_PATTERN = re.compile(r'^[0-9a-f]{64}$', re.I)
OBJECT_REFERENCE_PATTERN = re.compile(r'objects/([0-9a-f]{2})/([0-9a-f]{64})', re.I)
ASSET_REFERENCE_PATTERN = re.compile(r'notebook-asset:([-A-Za-z0-9._:]+)')

def safe(name):
    norm = posixpath.normpath(name.replace('\\\\', '/'))
    if norm in ('', '.', '..') or norm.startswith('/') or norm.startswith('../'):
        return None
    return norm

def note_id(name):
    if not name.startswith('notes/'):
        return None
    suffix = '.json.gz' if name.endswith('.json.gz') else '.json' if name.endswith('.json') else None
    if not suffix:
        return None
    value = name[len('notes/'):-len(suffix)]
    return value if UUID_PATTERN.match(value) else None

def is_note(name):
    return note_id(name) is not None

def is_object(name):
    parts = name.split('/')
    return len(parts) == 3 and parts[0] == 'objects' and HASH_PATTERN.match(parts[2]) is not None and parts[1].lower() == parts[2][:2].lower()

def allowed(name):
    return name in ALLOWED_ROOT_FILES or is_note(name) or is_object(name) or (name.startswith('attachments/') and len(name) > len('attachments/'))

def die(message):
    print(json.dumps({'ok': False, 'error': message}), file=sys.stderr)
    sys.exit(1)

def safe_path(root, rel):
    normalized = safe(rel)
    if not normalized:
        raise ValueError('unsafe path: %s' % rel)
    target = os.path.join(root, *normalized.split('/'))
    root_real = os.path.realpath(root)
    parent_real = os.path.realpath(os.path.dirname(target))
    if os.path.commonpath([root_real, parent_real]) != root_real:
        raise ValueError('path escapes repository root: %s' % rel)
    return target

def read_bytes(path, compressed=False):
    opener = gzip.open if compressed else open
    chunks = []
    total = 0
    with opener(path, 'rb') as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                raise ValueError('decoded file exceeds 100 MB')
            chunks.append(chunk)
    return b''.join(chunks)

def load_json(path, compressed=False):
    return json.loads(read_bytes(path, compressed=compressed).decode('utf-8'))

def sha256_file(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, 'rb') as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise ValueError('file exceeds 100 MB')
            digest.update(chunk)
    return digest.hexdigest(), size

def repository_files(root):
    files = []
    total = 0
    if not os.path.isdir(root):
        return files
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [name for name in dirnames if name != RECOVERY_DIRECTORY and name != '.index-write.lock' and '.index-write.lock.stale.' not in name and not os.path.islink(os.path.join(dirpath, name))]
        for filename in filenames:
            if '.tmp.notebook-next.' in filename or filename.endswith('.tmp'):
                continue
            full = os.path.join(dirpath, filename)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = posixpath.relpath(full, root)
            if not allowed(rel):
                continue
            size = os.path.getsize(full)
            if size > MAX_FILE_BYTES:
                raise ValueError('%s exceeds 100 MB' % rel)
            total += size
            if total > MAX_REPOSITORY_BYTES:
                raise ValueError('repository exceeds 512 MB')
            files.append((rel, full, size))
    return sorted(files)

def acquire_lock(root):
    notes_dir = os.path.join(root, 'notes')
    os.makedirs(notes_dir, exist_ok=True)
    lock_path = os.path.join(notes_dir, '.index-write.lock')
    owner_path = os.path.join(lock_path, 'owner')
    owner = str(uuid.uuid4())
    for attempt in range(LOCK_RETRIES):
        try:
            os.mkdir(lock_path)
            break
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(lock_path)
            except FileNotFoundError:
                continue
            if age > LOCK_STALE_SECONDS:
                stale = lock_path + '.stale.' + str(uuid.uuid4())
                try:
                    os.rename(lock_path, stale)
                    shutil.rmtree(stale, ignore_errors=True)
                    continue
                except OSError:
                    pass
            if attempt + 1 >= LOCK_RETRIES:
                die('repository is locked by another device')
            time.sleep(LOCK_RETRY_SECONDS)
    else:
        die('repository lock could not be acquired')
    try:
        with open(owner_path, 'w', encoding='utf-8') as f:
            f.write(owner + '\n')
        os.utime(lock_path, None)
    except Exception:
        shutil.rmtree(lock_path, ignore_errors=True)
        raise
    return lock_path, owner_path, owner

def heartbeat(lock_path, owner_path, owner):
    try:
        with open(owner_path, 'r', encoding='utf-8') as f:
            if f.read().strip() != owner:
                die('repository lock ownership changed')
        os.utime(lock_path, None)
    except FileNotFoundError:
        die('repository lock ownership changed')

def release_lock(lock_path, owner_path, owner):
    try:
        with open(owner_path, 'r', encoding='utf-8') as f:
            if f.read().strip() != owner:
                return
        os.remove(owner_path)
        os.rmdir(lock_path)
    except OSError:
        pass

def validate_repository(root, require_index=True, beat=None, for_gc=False):
    errors = []
    live_objects = set()

    def add(message):
        if len(errors) < 200:
            errors.append(message)

    def pulse():
        if beat:
            beat()

    try:
        files = repository_files(root)
    except Exception as error:
        return ['repository inventory invalid: %s' % error], live_objects
    by_name = {rel: (full, size) for rel, full, size in files}
    if require_index and 'library.json' not in by_name:
        add('library.json is missing')
    if require_index and 'notes/assets_manifest.json' not in by_name:
        add('notes/assets_manifest.json is missing')

    for directory in ('notes', 'objects'):
        base = os.path.join(root, directory)
        if not os.path.isdir(base) or os.path.islink(base):
            if os.path.islink(base):
                add('%s directory must not be a symbolic link' % directory)
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            dirnames[:] = [name for name in dirnames if name != '.index-write.lock' and '.index-write.lock.stale.' not in name]
            for filename in filenames:
                full = os.path.join(dirpath, filename)
                rel = posixpath.relpath(full, root)
                if os.path.islink(full):
                    add('%s must not be a symbolic link' % rel)
                elif directory == 'objects' and not is_object(rel):
                    add('%s is not a valid content-addressed object path' % rel)
                elif directory == 'notes' and not allowed(rel) and not filename.endswith('.tmp') and '.tmp.notebook-next.' not in filename:
                    add('%s is not an allowed repository note path' % rel)

    metadata_values = {}
    for metadata_name in ('library.json', 'notes/reading_positions.json', 'notes/privacy.json'):
        if metadata_name not in by_name:
            continue
        try:
            value = load_json(by_name[metadata_name][0])
            if not isinstance(value, dict):
                add('%s must contain a JSON object' % metadata_name)
            else:
                metadata_values[metadata_name] = value
        except Exception as error:
            add('%s invalid: %s' % (metadata_name, error))
        pulse()

    manifest = None
    manifest_name = 'notes/assets_manifest.json'
    if manifest_name in by_name:
        try:
            manifest = load_json(by_name[manifest_name][0])
            if not isinstance(manifest, dict) or not isinstance(manifest.get('entries', []), list):
                add('%s entries must be an array' % manifest_name)
                manifest = None
        except Exception as error:
            add('%s invalid: %s' % (manifest_name, error))
    if manifest:
        seen_paths = set()
        for position, entry in enumerate(manifest.get('entries', [])):
            if not isinstance(entry, dict):
                add('%s entry %d is not an object' % (manifest_name, position))
                continue
            rel = safe(str(entry.get('relativePath', '')))
            content_hash = str(entry.get('contentHash', '')).lower()
            physical_rel = rel if rel and (is_object(rel) or rel.startswith('attachments/')) else ('attachments/%s' % rel if rel else None)
            if not rel or not physical_rel or not allowed(physical_rel):
                add('%s entry %d has unsafe path' % (manifest_name, position))
                continue
            if rel in seen_paths:
                add('%s has duplicate path %s' % (manifest_name, rel))
            seen_paths.add(rel)
            if not HASH_PATTERN.match(content_hash):
                add('%s entry %s has invalid contentHash' % (manifest_name, rel))
                continue
            if is_object(rel):
                expected = 'objects/%s/%s' % (content_hash[:2], content_hash)
                if rel.lower() != expected.lower():
                    add('%s entry %s does not match its contentHash' % (manifest_name, rel))
                live_objects.add(content_hash)
            if physical_rel not in by_name:
                add('%s references missing file %s' % (manifest_name, physical_rel))
                continue
            try:
                actual_hash, actual_size = sha256_file(by_name[physical_rel][0])
                if actual_hash != content_hash:
                    add('%s file %s hash mismatch' % (manifest_name, rel))
                declared_size = entry.get('size')
                if declared_size is not None and (not isinstance(declared_size, (int, float)) or int(declared_size) != actual_size):
                    add('%s file %s size mismatch' % (manifest_name, rel))
            except Exception as error:
                add('%s file %s invalid: %s' % (manifest_name, rel, error))
            pulse()

    index = None
    index_name = 'notes/index.json'
    if index_name not in by_name:
        if require_index:
            add('notes/index.json is missing')
    else:
        try:
            index = load_json(by_name[index_name][0])
            if not isinstance(index, dict):
                add('notes/index.json must contain a JSON object')
                index = None
        except Exception as error:
            add('notes/index.json invalid: %s' % error)

    if index:
        entries = index.get('entries', [])
        deletions = index.get('deletedEntries', [])
        if not isinstance(entries, list):
            add('notes/index.json entries must be an array')
            entries = []
        if not isinstance(deletions, list):
            add('notes/index.json deletedEntries must be an array')
            deletions = []
        seen_entries = set()
        seen_deletions = set()
        repository_format = index.get('repositoryFormat', {})
        has_private_notes = False
        compressed = isinstance(repository_format, dict) and repository_format.get('version') in (2, 3) and repository_format.get('noteEncoding') == 'gzip'
        if repository_format:
            if not isinstance(repository_format, dict) or repository_format.get('version') not in (2, 3) or repository_format.get('noteEncoding') != 'gzip':
                add('notes/index.json repositoryFormat is unsupported')
            elif repository_format.get('version') == 3 and (repository_format.get('contentFormat') != 'markdown-gfm' or repository_format.get('assetAddressing') != 'sha256'):
                add('notes/index.json v3 repositoryFormat is incomplete')
        for position, deletion in enumerate(deletions):
            value = deletion.get('noteID') if isinstance(deletion, dict) else None
            if not isinstance(value, str) or not UUID_PATTERN.match(value):
                add('notes/index.json deletion %d has invalid noteID' % position)
            elif value in seen_deletions:
                add('notes/index.json has duplicate deletion %s' % value)
            else:
                seen_deletions.add(value)
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                add('notes/index.json entry %d is not an object' % position)
                continue
            value = entry.get('noteID')
            if not isinstance(value, str) or not UUID_PATTERN.match(value):
                add('notes/index.json entry %d has invalid noteID' % position)
                continue
            if value in seen_entries:
                add('notes/index.json has duplicate entry %s' % value)
            seen_entries.add(value)
            if value in seen_deletions:
                add('notes/index.json lists %s as both live and deleted' % value)
            if not isinstance(entry.get('version'), int) or entry.get('version') < 0:
                add('notes/index.json entry %s has invalid version' % value)
            if not isinstance(entry.get('contentHash'), str) or not HASH_PATTERN.match(entry.get('contentHash')):
                add('notes/index.json entry %s has invalid contentHash' % value)
            if entry.get('historyCount') is not None and (not isinstance(entry.get('historyCount'), int) or entry.get('historyCount') < 0):
                add('notes/index.json entry %s has invalid historyCount' % value)
            rel = 'notes/%s.json.gz' % value if compressed else 'notes/%s.json' % value
            if rel not in by_name:
                add('notes/index.json references missing note %s' % rel)
                continue
            try:
                envelope = load_json(by_name[rel][0], compressed=compressed)
                if not isinstance(envelope, dict) or envelope.get('noteID') != value:
                    add('%s noteID mismatch' % rel)
                    continue
                if 'privacyEncryption' in envelope:
                    has_private_notes = True
                    encryption = envelope.get('privacyEncryption')
                    if (not isinstance(encryption, dict) or encryption.get('version') != 1
                            or encryption.get('algorithm') != 'AES-256-GCM'
                            or encryption.get('kdf') != 'PBKDF2-SHA256'
                            or encryption.get('iterations') != 310000
                            or not all(isinstance(encryption.get(key), str) and encryption.get(key) for key in ('salt', 'iv', 'ciphertext'))):
                        add('%s privacy envelope invalid' % rel)
                    if for_gc:
                        add('%s is encrypted, so the helper cannot prove its complete historical object graph; gc is disabled' % rel)
                    pulse()
                    continue
                if envelope.get('schemaVersion') == 3:
                    metadata = envelope.get('metadata')
                    objects = envelope.get('contentObjects')
                    history = envelope.get('history', [])
                    current_hash = envelope.get('currentContentHash')
                    if not isinstance(metadata, dict) or metadata.get('id') != value:
                        add('%s metadata id mismatch' % rel)
                    if not isinstance(objects, dict):
                        add('%s contentObjects must be an object' % rel)
                        objects = {}
                    if not isinstance(current_hash, str) or not HASH_PATTERN.match(current_hash):
                        add('%s currentContentHash invalid' % rel)
                    elif not isinstance(objects.get(current_hash), str):
                        add('%s current content object is missing' % rel)
                    elif hashlib.sha256(objects[current_hash].encode('utf-8')).hexdigest() != current_hash.lower():
                        add('%s current content hash mismatch' % rel)
                    if isinstance(entry.get('contentHash'), str) and entry.get('contentHash').lower() != str(current_hash).lower():
                        add('%s index contentHash mismatch' % rel)
                    if not isinstance(history, list):
                        add('%s history must be an array' % rel)
                        history = []
                    if isinstance(entry.get('historyCount'), int) and entry.get('historyCount') != len(history):
                        add('%s index historyCount mismatch' % rel)
                    for history_position, history_entry in enumerate(history):
                        history_hash = history_entry.get('contentHash') if isinstance(history_entry, dict) else None
                        if not isinstance(history_hash, str) or not HASH_PATTERN.match(history_hash) or not isinstance(objects.get(history_hash), str):
                            add('%s history %d content object is missing' % (rel, history_position))
                        elif hashlib.sha256(objects[history_hash].encode('utf-8')).hexdigest() != history_hash.lower():
                            add('%s history %d content hash mismatch' % (rel, history_position))
                    for markdown in objects.values():
                        if isinstance(markdown, str):
                            for object_prefix, object_hash in OBJECT_REFERENCE_PATTERN.findall(markdown):
                                if object_prefix.lower() != object_hash[:2].lower():
                                    add('%s contains an object reference with the wrong prefix' % rel)
                                live_objects.add(object_hash.lower())
                    assets = envelope.get('assets', [])
                    if not isinstance(assets, list):
                        add('%s assets must be an array' % rel)
                        assets = []
                    asset_hashes = {}
                    for asset_position, asset in enumerate(assets):
                        if not isinstance(asset, dict):
                            add('%s asset %d is not an object' % (rel, asset_position))
                            continue
                        object_hash = str(asset.get('objectHash') or asset.get('checksum') or '').lower()
                        local_path = safe(str(asset.get('localPath', '')))
                        if object_hash:
                            if not HASH_PATTERN.match(object_hash):
                                add('%s asset %d has invalid object hash' % (rel, asset_position))
                            else:
                                live_objects.add(object_hash)
                                if isinstance(asset.get('id'), str) and asset.get('id'):
                                    asset_hashes[asset.get('id')] = object_hash
                                expected = 'objects/%s/%s' % (object_hash[:2], object_hash)
                                if local_path and local_path.lower() != expected.lower():
                                    add('%s asset %d object path mismatch' % (rel, asset_position))
                                if expected not in by_name:
                                    add('%s asset %d references missing object' % (rel, asset_position))
                    for markdown in objects.values():
                        if not isinstance(markdown, str):
                            continue
                        for asset_id in ASSET_REFERENCE_PATTERN.findall(markdown):
                            object_hash = asset_hashes.get(asset_id)
                            if object_hash:
                                live_objects.add(object_hash)
                            else:
                                add('%s content references asset %s without an object mapping' % (rel, asset_id))
                pulse()
            except Exception as error:
                add('%s invalid: %s' % (rel, error))
            pulse()

        if has_private_notes:
            privacy = metadata_values.get('notes/privacy.json')
            if not isinstance(privacy, dict):
                add('notes/privacy.json is required when encrypted notes exist')
            elif (privacy.get('schemaVersion') != 1 or privacy.get('algorithm') != 'AES-256-GCM'
                    or privacy.get('kdf') != 'PBKDF2-SHA256' or privacy.get('iterations') != 310000
                    or not all(isinstance(privacy.get(key), str) and privacy.get(key) for key in ('salt', 'iv', 'ciphertext'))):
                add('notes/privacy.json key-check format is invalid')

    for rel, full, _size in files:
        if not is_object(rel):
            continue
        try:
            actual_hash, _actual_size = sha256_file(full)
            expected_hash = rel.split('/')[-1].lower()
            if actual_hash != expected_hash:
                add('%s hash mismatch' % rel)
        except Exception as error:
            add('%s invalid: %s' % (rel, error))
        pulse()
    return errors, live_objects

def recovery_root(root):
    value = os.path.join(root, RECOVERY_DIRECTORY)
    os.makedirs(value, mode=0o700, exist_ok=True)
    return value

def create_import_recovery(root, staged, beat):
    batch = os.path.join(recovery_root(root), 'import-%d-%s' % (int(time.time()), uuid.uuid4()))
    backed_up = []
    try:
        for rel, _full in staged:
            target = safe_path(root, rel)
            if not os.path.isfile(target):
                continue
            backup = os.path.join(batch, *rel.split('/'))
            os.makedirs(os.path.dirname(backup), exist_ok=True)
            try:
                os.link(target, backup)
            except OSError:
                shutil.copy2(target, backup)
            backed_up.append(rel)
            beat()
        if backed_up:
            with open(os.path.join(batch, 'manifest.json'), 'w', encoding='utf-8') as output:
                json.dump({'kind': 'import', 'createdAt': int(time.time()), 'files': backed_up}, output, separators=(',', ':'))
            return batch, set(backed_up)
        shutil.rmtree(batch, ignore_errors=True)
        return None, set()
    except Exception:
        shutil.rmtree(batch, ignore_errors=True)
        raise

def main(op, root):
    if not os.path.isabs(root):
        die('root must be absolute')
    root = os.path.realpath(root)
    if root == os.path.sep:
        die('repository root must not be the filesystem root')
    if op == 'export-tar':
        lock_path = owner_path = None
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            errors, _live = validate_repository(root, require_index=True, beat=beat)
            if errors:
                die('repository validation failed: %s' % '; '.join(errors[:20]))
            with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as out:
                for rel, full, _size in repository_files(root):
                    out.add(full, arcname=rel, recursive=False)
                    beat()
        except Exception as error:
            die('export failed: %s' % error)
        finally:
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'import-tar':
        lock_path = owner_path = stage = recovery_batch = None
        backed_up = set()
        published = []
        try:
            os.makedirs(root, exist_ok=True)
            stage = tempfile.mkdtemp(prefix='.notebook-next-import-', dir=root)
            total = 0
            members = set()
            with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
                for member in archive:
                    rel = safe(member.name)
                    if not rel or not allowed(rel):
                        raise ValueError('unsafe path: %s' % member.name)
                    if rel in members:
                        raise ValueError('duplicate archive member: %s' % member.name)
                    members.add(rel)
                    if not member.isfile():
                        raise ValueError('unsupported archive member: %s' % member.name)
                    if member.size < 0 or member.size > MAX_FILE_BYTES:
                        raise ValueError('archive member exceeds 100 MB: %s' % member.name)
                    total += member.size
                    if total > MAX_REPOSITORY_BYTES:
                        raise ValueError('archive exceeds 512 MB')
                    target = safe_path(stage, rel)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        raise ValueError('cannot extract archive member: %s' % member.name)
                    with open(target, 'wb') as out:
                        written = 0
                        while True:
                            chunk = extracted.read(65536)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > MAX_FILE_BYTES:
                                raise ValueError('archive member exceeds 100 MB: %s' % member.name)
                            out.write(chunk)
            errors, _live = validate_repository(stage, require_index=True)
            if errors:
                raise ValueError('repository validation failed: %s' % '; '.join(errors[:20]))
            staged = [(rel, full) for rel, full, _size in repository_files(stage)]
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            recovery_batch, backed_up = create_import_recovery(root, staged, beat)
            # Publish the index last, matching normal SFTP synchronization, so
            # readers never observe an index that references unpublished files.
            staged.sort(key=lambda item: (item[0] == 'notes/index.json', item[0]))
            for rel, full in staged:
                target = safe_path(root, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                existed = os.path.exists(target)
                os.replace(full, target)
                published.append((rel, existed))
                beat()
            recovery_rel = posixpath.relpath(recovery_batch, root) if recovery_batch else None
            print(json.dumps({'ok': True, 'recovery': recovery_rel}))
        except Exception as error:
            for rel, existed in reversed(published):
                target = safe_path(root, rel)
                backup = os.path.join(recovery_batch, *rel.split('/')) if recovery_batch else None
                try:
                    if existed and backup and os.path.isfile(backup):
                        os.replace(backup, target)
                    elif not existed and os.path.isfile(target):
                        os.remove(target)
                except OSError:
                    pass
            die('import failed: %s' % error)
        finally:
            if stage:
                shutil.rmtree(stage, ignore_errors=True)
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'verify':
        lock_path = owner_path = None
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            errors, _live = validate_repository(root, require_index=True, beat=beat)
            print(json.dumps({'ok': not errors, 'errors': errors}))
        except Exception as error:
            die('verify failed: %s' % error)
        finally:
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    elif op == 'gc':
        lock_path = owner_path = None
        batch = None
        moved_objects = []
        try:
            os.makedirs(root, exist_ok=True)
            lock_path, owner_path, owner = acquire_lock(root)
            beat = lambda: heartbeat(lock_path, owner_path, owner)
            errors, live_objects = validate_repository(root, require_index=True, beat=beat, for_gc=True)
            if errors:
                raise ValueError('repository validation failed: %s' % '; '.join(errors[:20]))
            now = time.time()
            recovery = recovery_root(root)
            purged = 0
            for name in sorted(os.listdir(recovery)):
                batch = os.path.join(recovery, name)
                if not name.startswith('gc-') or not os.path.isdir(batch):
                    continue
                if now - os.path.getmtime(batch) < GC_QUARANTINE_SECONDS:
                    continue
                for _dirpath, _dirnames, filenames in os.walk(batch):
                    purged += len([filename for filename in filenames if filename != 'manifest.json'])
                shutil.rmtree(batch)
                beat()
            candidates = []
            objects_dir = os.path.join(root, 'objects')
            if os.path.isdir(objects_dir):
                for prefix in sorted(os.listdir(objects_dir)):
                    prefix_dir = os.path.join(objects_dir, prefix)
                    if not os.path.isdir(prefix_dir) or os.path.islink(prefix_dir):
                        continue
                    for name in sorted(os.listdir(prefix_dir)):
                        full = os.path.join(prefix_dir, name)
                        if name.lower() in live_objects or not os.path.isfile(full) or os.path.islink(full):
                            continue
                        if now - os.path.getmtime(full) < GC_GRACE_SECONDS:
                            continue
                        candidates.append(('objects/%s/%s' % (prefix, name), full, os.path.getsize(full)))
                        beat()
            if candidates:
                batch = os.path.join(recovery, 'gc-%d-%s' % (int(now), uuid.uuid4()))
                for rel, full, size in candidates:
                    target = os.path.join(batch, *rel.split('/'))
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    os.replace(full, target)
                    moved_objects.append((rel, full, target, size))
                    beat()
                with open(os.path.join(batch, 'manifest.json'), 'w', encoding='utf-8') as output:
                    json.dump({'kind': 'gc', 'createdAt': int(now), 'purgeAfter': int(now + GC_QUARANTINE_SECONDS), 'objects': [{'path': rel, 'size': size, 'hash': rel.split('/')[-1]} for rel, _full, _target, size in moved_objects]}, output, separators=(',', ':'))
            print(json.dumps({
                'ok': True,
                'quarantined': len(candidates),
                'purged': purged,
                'graceDays': GC_GRACE_SECONDS // (24 * 60 * 60),
                'retentionDays': GC_QUARANTINE_SECONDS // (24 * 60 * 60),
                'recovery': posixpath.relpath(batch, root) if batch else None,
            }))
        except Exception as error:
            for _rel, original, quarantined, _size in reversed(moved_objects):
                try:
                    os.makedirs(os.path.dirname(original), exist_ok=True)
                    if os.path.isfile(quarantined) and not os.path.exists(original):
                        os.replace(quarantined, original)
                except OSError:
                    pass
            if batch:
                shutil.rmtree(batch, ignore_errors=True)
            die('gc failed: %s' % error)
        finally:
            if lock_path:
                release_lock(lock_path, owner_path, owner)
    else:
        die('unknown op: %s' % op)

`

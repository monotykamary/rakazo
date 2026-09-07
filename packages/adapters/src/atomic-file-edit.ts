export type ExactFileEdit = { oldText: string; newText: string; all?: boolean };
export type AtomicFileEditInput = { path: string; edits: ExactFileEdit[]; all?: boolean };

// Runs only on the authorized computer via SandboxProvider.execute, never in the Pi worker.
// A persistent canonical-path lock coordinates separate backend processes and child runs.
// Uncooperative shell writes cannot honor this lock; detect changed snapshots before commit.
const EDIT_PROGRAM = String.raw`
import base64, fcntl, hashlib, json, os, stat, sys, tempfile

def edit():
    request = json.loads(base64.b64decode(sys.argv[1]))
    requested = request['path']
    target = os.path.realpath(requested)
    if os.path.commonpath([os.path.realpath(os.getcwd()), target]) != os.path.realpath(os.getcwd()):
        raise ValueError()
    lockdir = os.path.join(tempfile.gettempdir(), 'rakazo-file-edits-' + str(os.getuid()))
    try:
        os.mkdir(lockdir, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(lockdir)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError()
    lockpath = os.path.join(lockdir, hashlib.sha256(os.fsencode(target)).hexdigest())
    lock = os.open(lockpath, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'rb') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if os.path.realpath(requested) != target:
            raise ValueError()
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 250000:
                raise ValueError()
            original = source.read(250001)
        if len(original) > 250000:
            raise ValueError()
        original.decode('utf-8', errors='strict')
        replacements = []
        for item in request['edits']:
            old, new = item['oldText'].encode('utf-8'), item['newText'].encode('utf-8')
            matches = []
            start = original.find(old)
            while start >= 0:
                matches.append(start)
                start = original.find(old, start + 1)
            if not matches or (not (item.get('all') or request.get('all')) and len(matches) != 1):
                raise ValueError()
            if len(replacements) + len(matches) > 250000:
                raise ValueError()
            replacements.extend((start, start + len(old), new) for start in matches)
        replacements.sort(key=lambda item: item[0])
        if any(replacements[i][0] < replacements[i-1][1] for i in range(1, len(replacements))):
            raise ValueError()
        if len(original) + sum(len(new) - (end - start) for start, end, new in replacements) > 250000:
            raise ValueError()
        chunks, cursor = [], 0
        for start, end, new in replacements:
            chunks.extend((original[cursor:start], new))
            cursor = end
        chunks.append(original[cursor:])
        updated = b''.join(chunks)
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix='.rakazo-edit-', dir=os.path.dirname(target))
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), stat.S_IMODE(before.st_mode))
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
            if os.path.realpath(requested) != target:
                raise ValueError()
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                current = os.fstat(source.fileno())
                if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns):
                    raise ValueError()
                if source.read(250001) != original:
                    raise ValueError()
            os.replace(temporary, target)
            temporary = None
        finally:
            if temporary is not None:
                os.unlink(temporary)
    print('RAKAZO_EDIT_OK')

try:
    edit()
except Exception:
    print('RAKAZO_EDIT_FAILED')
    sys.exit(1)
`;

/** Call only after authorization and the mutation effect claim. Never expose command diagnostics. */
export async function atomicFileEdit(
  input: AtomicFileEditInput,
  execute: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: true } | { error: string }> {
  const failed = {
    error:
      "Atomic edit failed; source must be an unchanged UTF-8 regular file with non-overlapping exact anchors.",
  };
  if (
    typeof input.path !== "string" ||
    !input.path ||
    input.path.includes("\0") ||
    !Array.isArray(input.edits) ||
    !input.edits.length ||
    input.edits.length > 1000 ||
    (input.all !== undefined && typeof input.all !== "boolean") ||
    input.edits.some(
      (edit) =>
        !edit ||
        typeof edit.oldText !== "string" ||
        !edit.oldText ||
        typeof edit.newText !== "string" ||
        (edit.all !== undefined && typeof edit.all !== "boolean"),
    )
  )
    return failed;
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  // Stay below platform argv limits; no truncation and no fallback read/write transaction.
  if (payload.length > 64000) return failed;
  try {
    const result = await execute(["python3", "-I", "-c", EDIT_PROGRAM, payload]);
    return result.code === 0 && result.stdout.trim() === "RAKAZO_EDIT_OK" ? { ok: true } : failed;
  } catch {
    // Providers may include file contents or command arguments in their errors.
    return failed;
  }
}

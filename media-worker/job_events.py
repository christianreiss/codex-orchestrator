"""Linux filesystem events; no timer or directory scan while the queue is idle."""
import ctypes
import errno
import os
from pathlib import Path
import select
import struct

_CREATE = 0x100
_MOVED_TO = 0x80
_CLOSE_WRITE = 0x8
_DELETE_SELF = 0x400
_MOVE_SELF = 0x800
_IGNORED = 0x8000
_OVERFLOW = 0x4000
_ISDIR = 0x40000000

class JobEvents:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.inotify_init1.argtypes = [ctypes.c_int]
        self.libc.inotify_init1.restype = ctypes.c_int
        self.libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.libc.inotify_add_watch.restype = ctypes.c_int
        self.fd = self.libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), 'inotify_init1 failed')
        self.watches = {}
        self.pending = set()
        self._watch(self.root)
        self._scan()

    def close(self):
        os.close(self.fd)

    def _watch(self, path):
        if path in self.watches.values() or path.is_symlink():
            return
        wd = self.libc.inotify_add_watch(self.fd, os.fsencode(path), _CREATE | _MOVED_TO | _CLOSE_WRITE | _DELETE_SELF | _MOVE_SELF)
        if wd < 0:
            error = ctypes.get_errno()
            if error == errno.ENOENT:
                return
            raise OSError(error, 'inotify_add_watch failed')
        self.watches[wd] = path

    def _scan(self):
        # Startup or a kernel-reported event gap only. Watch before checking the
        # request so a rename between the two is either observed or queued.
        for directory in self.root.iterdir():
            if directory.is_dir() and not directory.is_symlink():
                self._watch(directory)
                if (directory / 'request.json').is_file():
                    self.pending.add(directory)

    def wait(self, timeout=None):
        if self.pending:
            ready, self.pending = self.pending, set()
            return ready
        if not select.select([self.fd], [], [], timeout)[0]:
            return set()
        while True:
            try:
                data = os.read(self.fd, 256 * 1024)
            except BlockingIOError:
                break
            offset = 0
            while offset < len(data):
                wd, mask, _, length = struct.unpack_from('iIII', data, offset)
                offset += 16
                name = os.fsdecode(data[offset:offset + length].split(b'\0', 1)[0])
                offset += length
                if mask & _OVERFLOW:
                    self._scan()
                    continue
                parent = self.watches.get(wd)
                if parent == self.root and mask & (_IGNORED | _DELETE_SELF | _MOVE_SELF):
                    raise RuntimeError('Attachment queue root watch lost; restart to resubscribe')
                if mask & _IGNORED:
                    self.watches.pop(wd, None)
                    continue
                if parent == self.root and mask & _ISDIR and mask & (_CREATE | _MOVED_TO):
                    directory = parent / name
                    self._watch(directory)
                    if (directory / 'request.json').is_file():
                        self.pending.add(directory)
                elif parent and parent != self.root and name == 'request.json' and mask & (_MOVED_TO | _CLOSE_WRITE):
                    self.pending.add(parent)
        ready, self.pending = self.pending, set()
        return ready

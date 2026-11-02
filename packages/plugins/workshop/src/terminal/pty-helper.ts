// The small program that gives a shell a terminal (PLAN P7-09). Node has no PTY library in this repo (no node-pty, and a native build is not available offline), but every Linux machine that can
// run the server has Python 3 with its standard `pty` module, so the server starts this program and talks to it over pipes:
//
//   stdin   bytes to type into the shell          stdout  bytes the shell printed
//   fd 3    control lines: "R <cols> <rows>\n" resizes the screen
//   fd 4    one line "fatal: <why>" when the sandbox could not be built (nothing else is ever written there; it is NOT the shell's terminal, so nothing the shell prints can look like it)
//
// When stdin closes (the server closed the terminal, or the server died) the program ends the shell and everything in its sandbox; if the program itself is killed the kernel ends the sandbox
// (the first process of it asks for a kill signal when its parent dies). Both modes need the root user, because both drop to an unprivileged user; neither ever runs the shell as root, and neither
// runs it as the user the server runs as. In `jail` mode (needs root and the Linux namespace calls) the shell lives in a world of its own:
//   * its own process list (new PID namespace; the shell is the first process there, and when it ends the kernel ends every process it started),
//   * no network at all (new network namespace; only a loopback that is down),
//   * a root made of a tmpfs holding read-only bind mounts of /usr, /bin, /lib, a stub /etc and a few device files, plus a small memory-backed /tmp and /work. The machine's own root is swapped
//     out with `pivot_root` and then unmounted, so no path leads back to it (a `chroot` would leave the old root one step away for anyone who could call `chroot` again),
//   * no way to gain privilege: a user of its own (never root, one per terminal), no_new_privs, every capability dropped (also from the bounding set), and a system-call filter (seccomp) that refuses
//     the calls a breakout needs: new user or mount namespaces (`unshare`, `clone` with a namespace flag, `setns`), `mount`, `chroot`, `pivot_root`, `ptrace` and the like,
//   * limits on memory, files, processes and time; and, where the machine lets the server make a control group, a cap on memory, processes and CPU for the whole sandbox.
// In `plain` mode (no jail; only when an operator asks for it) the shell is just a process of an unprivileged user in a folder of its own, with the same user, privilege and limit rules but NO
// isolation of files, processes or network. It refuses to start unless the server is root (a non-root server would run the shell as ITSELF and could read its own secrets).
//
// The program is embedded as text so it travels with the server; it is passed to `python3 -I -c`. Arguments: mode, work folder, uid, gid, columns, rows.

export const PTY_HELPER = String.raw`
import os, sys, pty, select, struct, fcntl, termios, signal, ctypes, resource, shutil, errno, time

mode, work, uid, gid, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
FATAL_FD = 4
libc = ctypes.CDLL(None, use_errno=True)
CLONE_NEWNS, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWPID, CLONE_NEWNET = 0x20000, 0x4000000, 0x8000000, 0x20000000, 0x40000000
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC, MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 1, 2, 4, 8, 32, 4096, 16384, 1 << 18
MNT_DETACH = 2
PR_SET_PDEATHSIG, PR_SET_NO_NEW_PRIVS, PR_GET_NO_NEW_PRIVS, PR_CAPBSET_DROP, PR_SET_SECCOMP, PR_CAP_AMBIENT = 1, 38, 39, 24, 22, 47
ENV = {
    'PATH': '/usr/local/bin:/usr/bin:/bin',
    'HOME': '/work' if mode == 'jail' else work,
    'TERM': 'xterm-256color',
    'LANG': 'C.UTF-8',
    'USER': 'sandbox',
    'LOGNAME': 'sandbox',
    'PS1': 'sandbox:\\w\\$ ',
}
try:
    fcntl.fcntl(FATAL_FD, fcntl.F_SETFD, fcntl.FD_CLOEXEC)  # gone from the shell the moment it is started
except OSError:
    pass


def fatal(why):
    try:
        os.write(FATAL_FD, ('fatal: ' + why + '\n').encode())
    except OSError:
        pass
    os._exit(70)


if mode not in ('jail', 'plain'):
    fatal('unknown mode')
if uid <= 0 or gid <= 0:
    fatal('the shell must not run as root')
if os.geteuid() != 0:
    fatal(('the jail' if mode == 'jail' else 'plain mode') + ' needs the root user')

# ---- the system-call filter --------------------------------------------------------------------------------------------------------------------------------------------------
# name: (x86_64 number, aarch64 number). A call in this list answers "not permitted"; clone with a namespace flag does too; clone3 answers "not implemented" (its flags are in memory the
# filter cannot read, and the C library then falls back to clone); a call number from another ABI ends the process.
DENIED = {
    'ptrace': (101, 117), 'process_vm_readv': (310, 270), 'process_vm_writev': (311, 271), 'pidfd_getfd': (438, 438),
    'mount': (165, 40), 'umount2': (166, 39), 'pivot_root': (155, 41), 'chroot': (161, 51), 'unshare': (272, 97), 'setns': (308, 268),
    'mount_setattr': (442, 442), 'move_mount': (429, 429), 'open_tree': (428, 428), 'fsopen': (430, 430), 'fsconfig': (431, 431), 'fsmount': (432, 432), 'fspick': (433, 433),
    'keyctl': (250, 219), 'add_key': (248, 217), 'request_key': (249, 218), 'bpf': (321, 280), 'perf_event_open': (298, 241), 'userfaultfd': (323, 282),
    'init_module': (175, 105), 'finit_module': (313, 273), 'delete_module': (176, 106), 'kexec_load': (246, 104), 'kexec_file_load': (320, 294),
    'open_by_handle_at': (304, 265), 'name_to_handle_at': (303, 264), 'reboot': (169, 142), 'swapon': (167, 224), 'swapoff': (168, 225), 'acct': (163, 89),
    'settimeofday': (164, 170), 'sethostname': (170, 161), 'setdomainname': (171, 162), 'quotactl': (179, 60), 'syslog': (103, 116),
    'io_uring_setup': (425, 425), 'io_uring_enter': (426, 426), 'io_uring_register': (427, 427), 'iopl': (172, None), 'ioperm': (173, None),
}
ARCHES = {'x86_64': (0xC000003E, 0, 56, 435, 155), 'aarch64': (0xC00000B7, 1, 220, 435, 41)}
CLONE_NEW_ANY = 0x7E020000  # CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET
machine = os.uname().machine
if machine not in ARCHES:
    fatal('no system-call filter for this kind of processor (' + machine + ')')
AUDIT_ARCH, ARCH_INDEX, SYS_CLONE, SYS_CLONE3, SYS_PIVOT_ROOT = ARCHES[machine]


class SockFilter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]


class SockFprog(ctypes.Structure):
    _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(SockFilter))]


def seccomp_program():
    LD, JEQ, JGE, JSET, RET = 0x20, 0x15, 0x35, 0x45, 0x06
    ALLOW, KILL = 0x7FFF0000, 0x80000000
    prog, labels = [], {}

    def emit(code, k, jt=None, jf=None):
        prog.append((code, k, jt, jf))

    emit(LD, 4)  # the ABI of the call
    emit(JEQ, AUDIT_ARCH, None, 'kill')
    emit(LD, 0)  # the call number
    emit(JGE, 0x40000000, 'kill', None)  # another ABI (x32) on the same processor
    for number in sorted(set(v[ARCH_INDEX] for v in DENIED.values() if v[ARCH_INDEX] is not None)):
        emit(JEQ, number, 'eperm', None)
    emit(JEQ, SYS_CLONE3, 'nosys', None)
    emit(JEQ, SYS_CLONE, 'clone', None)
    emit(RET, ALLOW)
    labels['clone'] = len(prog)
    emit(LD, 16)  # the first argument of clone: its flags
    emit(JSET, CLONE_NEW_ANY, 'eperm', None)
    emit(RET, ALLOW)
    labels['eperm'] = len(prog)
    emit(RET, 0x00050000 | errno.EPERM)
    labels['nosys'] = len(prog)
    emit(RET, 0x00050000 | errno.ENOSYS)
    labels['kill'] = len(prog)
    emit(RET, KILL)
    out = []
    for index, (code, k, jt, jf) in enumerate(prog):
        jump_true = 0 if jt is None else labels[jt] - index - 1
        jump_false = 0 if jf is None else labels[jf] - index - 1
        if not (0 <= jump_true <= 255 and 0 <= jump_false <= 255):
            fatal('system-call filter too long')
        out.append(SockFilter(code, jump_true, jump_false, k))
    return out


def install_seccomp():
    rules = seccomp_program()
    array = (SockFilter * len(rules))(*rules)
    fprog = SockFprog(len(rules), ctypes.cast(array, ctypes.POINTER(SockFilter)))
    if libc.prctl(PR_SET_SECCOMP, 2, ctypes.byref(fprog), 0, 0) != 0:
        fatal('seccomp: ' + os.strerror(ctypes.get_errno()))


# ---- the sandbox's files -----------------------------------------------------------------------------------------------------------------------------------------------------
def mount(src, dst, fstype, flags, data=None):
    r = libc.mount(src.encode() if src else None, dst.encode(), fstype.encode() if fstype else None, ctypes.c_ulong(flags), data.encode() if data else None)
    if r != 0:
        fatal('mount ' + dst + ': ' + os.strerror(ctypes.get_errno()))


def read_only_tree(dst):
    # a bind mount made with MS_REC brings the mounts below it along (a separate /usr/local, for one); remounting the top one read-only leaves those writable, so each is remounted
    real = os.path.realpath(dst)
    found = []
    with open('/proc/self/mountinfo') as f:
        for line in f:
            parts = line.split()
            point = parts[4].replace('\\040', ' ')
            if point == real or point.startswith(real + '/'):
                opts = parts[5].split(',')
                flags = MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID
                if 'nodev' in opts:
                    flags |= MS_NODEV
                if 'noexec' in opts:
                    flags |= MS_NOEXEC
                found.append((point, flags))
    if not found:
        fatal('no mount at ' + dst)
    for point, flags in found:
        mount(None, point, None, flags)


def bind(src, dst, readonly=True):
    if os.path.isdir(src):
        os.makedirs(dst, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, 'a').close()
    mount(src, dst, None, MS_BIND | MS_REC)
    if readonly:
        read_only_tree(dst)


def chown_tree(path):
    os.chown(path, uid, gid)
    for base, dirs, files in os.walk(path):
        for name in dirs + files:
            os.chown(os.path.join(base, name), uid, gid, follow_symlinks=False)


def build_jail(jail):
    mount('tmpfs', jail, 'tmpfs', MS_NOSUID | MS_NODEV, 'size=4m,mode=755')
    for d in ('usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'):
        src = '/' + d
        if os.path.islink(src):
            os.symlink(os.readlink(src), jail + src)
        elif os.path.isdir(src):
            bind(src, jail + src)
    os.makedirs(jail + '/etc')
    with open(jail + '/etc/passwd', 'w') as f:
        f.write('root:x:0:0:root:/root:/bin/false\nsandbox:x:%d:%d:sandbox:/work:/bin/bash\n' % (uid, gid))
    with open(jail + '/etc/group', 'w') as f:
        f.write('root:x:0:\nsandbox:x:%d:\n' % gid)
    for f in ('/etc/ld.so.cache',):
        if os.path.exists(f):
            bind(f, jail + f)
    if os.path.isdir('/etc/alternatives'):
        bind('/etc/alternatives', jail + '/etc/alternatives')
    os.makedirs(jail + '/dev')
    mount('tmpfs', jail + '/dev', 'tmpfs', MS_NOSUID | MS_NOEXEC, 'size=64k,mode=755')
    for name in ('null', 'zero', 'full', 'urandom', 'random', 'tty'):
        if os.path.exists('/dev/' + name):
            bind('/dev/' + name, jail + '/dev/' + name, readonly=False)
    os.makedirs(jail + '/proc')
    mount('proc', jail + '/proc', 'proc', MS_NOSUID | MS_NODEV | MS_NOEXEC, 'hidepid=2')  # the shell sees its own processes, not the sandbox's root-owned first process
    os.makedirs(jail + '/tmp')
    mount('tmpfs', jail + '/tmp', 'tmpfs', MS_NOSUID | MS_NODEV, 'size=16m,mode=1777')
    os.makedirs(jail + '/work')
    mount('tmpfs', jail + '/work', 'tmpfs', MS_NOSUID | MS_NODEV, 'size=32m,mode=700')
    if os.path.isdir(work):
        shutil.copytree(work, jail + '/work', dirs_exist_ok=True)
    chown_tree(jail + '/work')
    libc.sethostname(b'sandbox', 7)
    # swap the machine's root for the jail and unmount the old one, so that nothing in this mount namespace leads back to it (pivot_root(".", ".") puts the old root on top of the new one)
    os.chdir(jail)
    if libc.syscall(SYS_PIVOT_ROOT, b'.', b'.') != 0:
        fatal('pivot_root: ' + os.strerror(ctypes.get_errno()))
    if libc.umount2(b'.', MNT_DETACH) != 0:
        fatal('umount of the old root: ' + os.strerror(ctypes.get_errno()))
    os.chdir('/work')


def cgroup_setup():
    # best effort: a control group of its own for the whole sandbox (memory, processes, CPU), where the machine has cgroup v2 and lets this user make one below its own
    try:
        if not os.path.exists('/sys/fs/cgroup/cgroup.controllers'):
            return None
        rel = None
        with open('/proc/self/cgroup') as f:
            for line in f:
                if line.startswith('0::'):
                    rel = line.strip()[3:]
        if rel is None:
            return None
        path = ('/sys/fs/cgroup' + rel).rstrip('/') + '/manythreads-terminal-%d' % os.getpid()
        os.mkdir(path)
    except OSError:
        return None
    for name, value in (('memory.max', str(512 << 20)), ('memory.swap.max', '0'), ('pids.max', '128'), ('cpu.max', '100000 100000')):
        try:
            with open(path + '/' + name, 'w') as f:
                f.write(value)
        except OSError:
            pass
    return path


def cgroup_join(path):
    if path is None:
        return
    try:
        with open(path + '/cgroup.procs', 'w') as f:
            f.write('0')
    except OSError:
        pass


def cgroup_remove(path):
    if path is None:
        return
    for _ in range(40):
        try:
            os.rmdir(path)
            return
        except OSError:
            time.sleep(0.05)


# ---- the shell ---------------------------------------------------------------------------------------------------------------------------------------------------------------
def die_with_parent():
    libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)


def become_user():
    # drop what root can do (also from the bounding set, so that no program can ever get it back), change user (this empties the other sets), then only ever lower limits
    cap = 0
    while cap < 64:
        if libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0:
            if ctypes.get_errno() == errno.EINVAL:
                break
            fatal('could not drop capability ' + str(cap))
        cap += 1
    libc.prctl(PR_CAP_AMBIENT, 4, 0, 0, 0)  # PR_CAP_AMBIENT_CLEAR_ALL
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.getuid() == 0 or os.geteuid() == 0:
        fatal('could not leave the root user')
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 or libc.prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1:
        fatal('could not set no_new_privs')
    for name, soft in (('RLIMIT_CORE', 0), ('RLIMIT_FSIZE', 64 << 20), ('RLIMIT_NOFILE', 256), ('RLIMIT_NPROC', 128), ('RLIMIT_CPU', 900), ('RLIMIT_AS', 1 << 30)):
        resource.setrlimit(getattr(resource, name), (soft, soft))
    with open('/proc/self/status') as f:
        for line in f:
            if line.startswith(('CapPrm', 'CapEff', 'CapBnd', 'CapAmb')) and int(line.split()[1], 16) != 0:
                fatal('capabilities remain')


def run_shell(parent):
    try:
        become_user()
        for fd in range(3, 256):
            if fd == FATAL_FD:
                continue  # closes by itself when the shell starts; kept until then so a failure to start can still be told
            try:
                os.close(fd)
            except OSError:
                pass
        os.chdir('/work' if mode == 'jail' else work)
        if parent is not None:
            die_with_parent()  # plain mode: the shell goes when this program goes (a change of user cleared the request made earlier)
            if os.getppid() != parent:
                os._exit(1)
        install_seccomp()
        shell = '/bin/bash' if os.path.exists('/bin/bash') else '/bin/sh'
        os.execve(shell, [os.path.basename(shell), '--noprofile', '--norc', '-i'] if shell.endswith('bash') else [os.path.basename(shell), '-i'], ENV)
    except BaseException as e:
        fatal('shell: ' + str(e))


def init_process(jail, group):
    # runs as the first process of the sandbox: build the world, start the shell, reap whatever is left, end with the shell
    try:
        cgroup_join(group)
        if libc.unshare(CLONE_NEWNS) != 0:
            fatal('unshare: ' + os.strerror(ctypes.get_errno()))
        mount(None, '/', None, MS_REC | MS_PRIVATE)  # nothing mounted below may reach the machine's own mounts
        build_jail(jail)
    except SystemExit:
        raise
    except BaseException as e:
        fatal('jail: ' + str(e))
    shell = os.fork()
    if shell == 0:
        run_shell(None)
        os._exit(127)
    code = 0
    while True:
        try:
            pid, status = os.wait()
        except ChildProcessError:
            break
        if pid == shell:
            code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0
            break
    os._exit(code if code >= 0 else 1)


def set_size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))


if mode == 'jail':
    jail = os.path.join(os.path.dirname(work.rstrip('/')), 'jail')
    os.makedirs(jail, exist_ok=True)
    if libc.unshare(CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWPID | CLONE_NEWNET) != 0:
        fatal('unshare: ' + os.strerror(ctypes.get_errno()))
else:
    jail = None
    chown_tree(work)
    os.chmod(os.path.dirname(work.rstrip('/')), 0o711)

group = cgroup_setup()
outer = os.getpid()
pid, master = pty.fork()
if pid == 0:
    if mode == 'jail':
        die_with_parent()  # the first process of the sandbox goes when this program goes, and the kernel ends everything in its PID namespace with it
        init_process(jail, group)
    else:
        cgroup_join(group)
        run_shell(outer)
    os._exit(127)

set_size(master, cols, rows)
stdin_fd, stdout_fd, ctl_fd = 0, 1, 3
buf = b''
alive = True


def stop():
    # jail: the shell is the first process of its own PID namespace, so killing it ends everything in there. plain: end the shell's process group.
    try:
        if mode == 'jail':
            os.kill(pid, signal.SIGKILL)
        else:
            os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


exit_code = 0
try:
    while alive:
        r, _, _ = select.select([stdin_fd, master] + ([ctl_fd] if ctl_fd >= 0 else []), [], [], 1.0)
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break
            write_all(stdout_fd, data)
        if stdin_fd in r:
            data = os.read(stdin_fd, 65536)
            if not data:
                stop()
                break
            write_all(master, data)
        if ctl_fd >= 0 and ctl_fd in r:
            chunk = os.read(ctl_fd, 4096)
            if not chunk:
                ctl_fd = -1
            else:
                buf += chunk
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    parts = line.split()
                    if len(parts) == 3 and parts[0] == b'R':
                        try:
                            set_size(master, int(parts[1]), int(parts[2]))
                        except (ValueError, OSError):
                            pass
finally:
    stop()
    try:
        _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0
    except OSError:
        pass
    cgroup_remove(group)
os._exit(exit_code if 0 <= exit_code < 256 else 1)
`;

"""Conservative macOS admission and an independent, owned-process supervisor.

Reports contain resource numbers and reason codes, never command arguments,
environment variables, audio, prompts or transcripts. MLX's memory limit is a
guideline; the external footprint/pressure watchdog provides separate protection.
"""
from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

GIB = 1024**3
POLICY = dict(version=1, preflight_available_bytes=3 * GIB,
              preflight_swap_bytes=GIB, preflight_cpu_busy=0.7,
              max_footprint_bytes=4 * GIB, max_swap_growth_bytes=256 * 1024**2,
              minimum_available_bytes=512 * 1024**2)


class RusageInfo(ctypes.Structure):
    # RUSAGE_INFO_V0, sys/resource.h. Physical footprint includes compressed pages.
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            'user_time', 'system_time', 'pkg_idle_wkups', 'interrupt_wkups',
            'pageins', 'wired_size', 'resident_size', 'phys_footprint',
            'proc_start_abstime', 'proc_exit_abstime')]


def process_footprint(pid):
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    lib.proc_pid_rusage.restype = ctypes.c_int
    info = RusageInfo()
    if lib.proc_pid_rusage(pid, 0, ctypes.byref(info)) != 0:
        error = ctypes.get_errno()
        if error == errno.ESRCH:
            return 0  # a child may exit between enumeration and accounting
        raise OSError(error, 'Process resource sample unavailable')
    return info.phys_footprint


def command_output(*args):
    return subprocess.check_output(args, text=True, errors='replace', timeout=3)


def sample_system(group):
    if sys.platform != 'darwin':
        raise OSError('This evaluation admission policy requires macOS')
    cores, pressure, swap = command_output(
        '/usr/sbin/sysctl', '-n', 'hw.logicalcpu',
        'kern.memorystatus_vm_pressure_level', 'vm.swapusage').splitlines()
    match = re.search(r'used\s*=\s*([\d.]+)([MG])', swap)
    if not match:
        raise OSError('Swap counters unavailable')
    vm = command_output('/usr/bin/vm_stat')
    page_size = int(re.search(r'page size of (\d+) bytes', vm).group(1))
    # A conservative estimate, not a claim that inactive pages are all free.
    available = sum(int(re.search(label + r':\s+(\d+)', vm).group(1))
                    for label in ['Pages free', 'Pages inactive', 'Pages speculative']) * page_size
    rows = [line.split() for line in command_output(
        '/bin/ps', '-axo', 'pid=,pgid=,%cpu=').splitlines()]
    footprint = sum(process_footprint(int(pid)) for pid, pgid, _ in rows
                    if group is not None and int(pgid) == group)
    return dict(pressure=int(pressure), available_bytes=available,
                swap_bytes=int(float(match[1]) * (GIB if match[2] == 'G' else 1024**2)),
                footprint_bytes=footprint,
                cpu_busy=sum(float(cpu) for _, _, cpu in rows) / (100 * int(cores)))


def stop_group(child, grace):
    # start_new_session creates this group exclusively for the test. Never signal
    # a port, a model name, the agent's own group, or another existing service.
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            break
        if sig != signal.SIGKILL:
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                child.poll()
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(min(0.02, grace))
    child.wait()


def refusal(sample, initial, preflight=False):
    if sample['pressure'] != 1:
        return 'memory_pressure'
    if preflight:
        if sample['available_bytes'] < POLICY['preflight_available_bytes']:
            return 'insufficient_headroom'
        if sample['swap_bytes'] > POLICY['preflight_swap_bytes']:
            return 'existing_swap'
        if sample['cpu_busy'] > POLICY['preflight_cpu_busy']:
            return 'cpu_busy'
    else:
        if sample['footprint_bytes'] > POLICY['max_footprint_bytes']:
            return 'process_memory'
        if sample['swap_bytes'] - initial['swap_bytes'] > POLICY['max_swap_growth_bytes']:
            return 'swap_growth'
        if sample['available_bytes'] < POLICY['minimum_available_bytes']:
            return 'insufficient_headroom'
    return None


def supervise(command, *, snapshot=sample_system, interval=0.5, grace=1.0,
              timeout=900, env=None):
    started = time.monotonic()
    result = dict(state='refused', exit_code=75, policy=POLICY.copy())
    try:
        initial = snapshot(None)
        result['initial'] = initial
        reason = refusal(initial, initial, preflight=True)
    except Exception:
        reason = 'monitor_unavailable'
    if reason:
        result['reason'] = reason
        return result
    child = None
    interrupted = []
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    for sig in handlers:
        signal.signal(sig, lambda signum, frame: interrupted.append(signum))
    try:
        child = subprocess.Popen(command, start_new_session=True, env=env, stdin=subprocess.DEVNULL)
        result.update(pid=child.pid, state='running', peak_footprint_bytes=0,
                      max_swap_bytes=initial['swap_bytes'])
        busy_samples = 0
        while child.poll() is None:
            reason = None
            if interrupted:
                reason = 'interrupted'
            elif time.monotonic() - started >= timeout:
                reason = 'timeout'
            else:
                try:
                    sample = snapshot(child.pid)
                    result['last'] = sample
                    result['peak_footprint_bytes'] = max(result['peak_footprint_bytes'], sample['footprint_bytes'])
                    result['max_swap_bytes'] = max(result['max_swap_bytes'], sample['swap_bytes'])
                    reason = refusal(sample, initial)
                    busy_samples = busy_samples + 1 if sample['cpu_busy'] > 0.9 else 0
                    if not reason and busy_samples * interval >= 5:
                        reason = 'sustained_cpu_busy'
                except Exception:
                    reason = 'monitor_unavailable'
            if reason:
                stop_group(child, grace)
                result.update(state='stopped', reason=reason,
                              exit_code=130 if reason == 'interrupted' else 124)
                break
            time.sleep(interval)
        else:
            code = child.wait()
            result.update(state='succeeded' if code == 0 else 'failed',
                          exit_code=code if code >= 0 else 128 - code)
    except Exception:
        result.update(state='failed', reason='supervisor_error', exit_code=74)
    finally:
        if child is not None:
            # Also remove descendants if a parent exits prematurely.
            stop_group(child, grace)
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        result['elapsed_seconds'] = time.monotonic() - started
    return result


def configure_mlx_limits(mx):
    # These allocator settings reduce growth but are NOT hard process limits.
    mx.set_memory_limit(3 * GIB)
    mx.set_cache_limit(64 * 1024**2)


def save_report(path, result):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Set report permissions atomically without changing the command's umask.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=900)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 0 < args.timeout <= 1800:
        parser.error('Provide a command after -- and a timeout in (0, 1800]')
    if args.report.exists():
        parser.error('Use a fresh report path; previous evidence is preserved')
    result = supervise(command, timeout=args.timeout)
    save_report(args.report, result)
    print(json.dumps(result), flush=True)
    return result['exit_code']


if __name__ == '__main__':
    raise SystemExit(main())

"""Start/stop only the process belonging to an explicit runtime root and port."""
import argparse
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CODE_ROOT = Path(__file__).resolve().parent


def process_argv(pid):
    """Read kernel argv boundaries; `ps command` cannot disambiguate spaces."""
    if sys.platform == 'darwin':
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        size = ctypes.c_size_t(1024 * 1024)
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot read process arguments')
        raw = buffer.raw[:size.value]
        argc = int.from_bytes(raw[:4], sys.byteorder)
        cursor = raw.index(b'\0', 4) + 1  # kernel executable path
        while cursor < len(raw) and raw[cursor] == 0:
            cursor += 1
        return [os.fsdecode(arg) for arg in raw[cursor:].split(b'\0')[:argc]]
    return [os.fsdecode(arg) for arg in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if arg]


def own_pid(root, service, port):
    try:
        meta = json.loads((root / 'service.pid').read_text())
        if not isinstance(meta, dict) or meta.get('service') != str(service) or meta.get('port') != port:
            return None
        pid = int(meta['pid'])
        argv = process_argv(pid)
        if argv[1:] != [str(service), str(port)]:
            return None
        started = subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True).strip()
        return pid if started == meta['started'] else None
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        return None


def health(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        return json.load(exc)
    except (OSError, ValueError):
        return None


def stop(root, service, port):
    pid = own_pid(root, service, port)
    if not pid:
        print('Service is stopped; no other process was touched.')
        return
    current = (health(port) or {}).get('current_request') or {}
    if current.get('job_id'):
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/local-asr/jobs/{current["job_id"]}', method='DELETE')
            urllib.request.urlopen(request, timeout=2).close()
        except OSError:
            pass
    # Re-check identity immediately before signaling; never kill a port owner by inference.
    if own_pid(root, service, port) != pid:
        raise SystemExit('Service identity changed; no process was touched.')
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if own_pid(root, service, port) != pid:
            (root/'service.pid').unlink(missing_ok=True)
            print('Service stopped.')
            return
        time.sleep(.1)
    raise SystemExit('Service is still finishing an active segment; retry status/stop later.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'stop', 'status'])
    parser.add_argument('--root', type=Path, default=Path(os.environ.get('ECHONOTES_ASR_ROOT', str(CODE_ROOT))))
    parser.add_argument('--port', type=int, default=int(os.environ.get('ECHONOTES_ASR_PORT', '18080')))
    parser.add_argument('--python', default=os.environ.get('ECHONOTES_ASR_PYTHON', str(CODE_ROOT/'.venv/bin/python')))
    opts = parser.parse_args()
    if not 1024 <= opts.port <= 65535:
        raise SystemExit('Invalid port')
    root, service = opts.root.resolve(), CODE_ROOT/'service.py'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    (root/'logs').mkdir(exist_ok=True)
    with (root/'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pid = own_pid(root, service, opts.port)
        if opts.action == 'stop':
            return stop(root, service, opts.port)
        if opts.action == 'status':
            print(json.dumps({'pid': pid, 'root': str(root), 'port': opts.port, 'health': health(opts.port) if pid else None}))
            return 0 if pid else 1
        if pid:
            print(json.dumps({'message': 'Service already running', 'pid': pid, 'health': health(opts.port)}))
            return 0
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', opts.port))
            except OSError:
                raise SystemExit(f'Port {opts.port} is occupied; no other process was touched.')
        env = dict(os.environ, ECHONOTES_ASR_ROOT=str(root), ECHONOTES_ASR_PORT=str(opts.port))
        with (root/'logs/service.log').open('ab') as output:
            child = subprocess.Popen([opts.python, str(service), str(opts.port)], cwd=CODE_ROOT, env=env,
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        started = subprocess.check_output(['ps','-p',str(child.pid),'-o','lstart='],text=True).strip()
        (root/'service.pid').write_text(json.dumps({'pid':child.pid,'service':str(service),'port':opts.port,'started':started}))
        for _ in range(480):
            if child.poll() is not None:
                (root/'service.pid').unlink(missing_ok=True)
                raise SystemExit('Service startup failed; see logs/service.log')
            result = health(opts.port)
            if result and result['status'] == 'ready':
                print(json.dumps({'message':'Service ready','pid':child.pid,'health':result}))
                return 0
            if result and result['status'] == 'error':
                stop(root, service, opts.port)
                raise SystemExit('Model loading failed; see logs/service.log')
            time.sleep(.25)
        stop(root, service, opts.port)
        raise SystemExit('Model startup exceeded 120 seconds; see logs/service.log')


if __name__ == '__main__': sys.exit(main())

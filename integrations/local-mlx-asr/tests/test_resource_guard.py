"""Resource protection uses tiny disposable processes, never models or real audio."""
import importlib.util
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path


class ResourceGuardTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / 'validation/resource_guard.py'
        self.assertTrue(path.is_file(), 'Model evaluation needs an independent resource supervisor')
        spec = importlib.util.spec_from_file_location('resource_guard', path)
        self.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.guard)

    @staticmethod
    def healthy(**changes):
        return dict(pressure=1, swap_bytes=0, available_bytes=8 * 1024**3,
                    footprint_bytes=0, cpu_busy=0.1, **changes)

    def test_busy_preflight_does_not_start_the_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'started'
            result = self.guard.supervise(
                [sys.executable, '-c', 'from pathlib import Path; Path(__import__("sys").argv[1]).touch()', str(marker)],
                snapshot=lambda group: {**self.healthy(), 'pressure': 2}, interval=0.01)
            self.assertEqual(result['state'], 'refused')
            self.assertEqual(result['reason'], 'memory_pressure')
            self.assertFalse(marker.exists())
            self.assertNotIn(str(marker), str(result))

    def test_preflight_checks_cpu_and_memory_headroom(self):
        for changes, reason in [({'cpu_busy': 0.9}, 'cpu_busy'),
                                ({'available_bytes': 1024**3}, 'insufficient_headroom'),
                                ({'swap_bytes': 2 * 1024**3}, 'existing_swap')]:
            with self.subTest(reason=reason):
                result = self.guard.supervise([sys.executable, '-c', 'raise SystemExit(99)'],
                    snapshot=lambda group: {**self.healthy(), **changes}, interval=0.01)
                self.assertEqual(result['state'], 'refused')
                self.assertEqual(result['reason'], reason)

    def test_pressure_kills_only_the_owned_group_even_if_child_ignores_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'ready'
            script = ('import signal,time,pathlib,sys; '
                      'signal.signal(signal.SIGINT,signal.SIG_IGN); '
                      'signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                      'pathlib.Path(sys.argv[1]).touch(); time.sleep(30)')
            def snapshot(group):
                return {**self.healthy(), 'pressure': 4 if marker.exists() else 1}
            original = signal.getsignal(signal.SIGTERM)
            result = self.guard.supervise([sys.executable, '-c', script, str(marker)],
                snapshot=snapshot, interval=0.01, grace=0.05)
            self.assertEqual(result['state'], 'stopped')
            self.assertEqual(result['reason'], 'memory_pressure')
            with self.assertRaises(ProcessLookupError):
                os.kill(result['pid'], 0)
            self.assertEqual(signal.getsignal(signal.SIGTERM), original)

    def test_footprint_and_swap_growth_stop_without_allocating_real_memory(self):
        for changes, reason in [({'footprint_bytes': 5 * 1024**3}, 'process_memory'),
                                ({'swap_bytes': 512 * 1024**2}, 'swap_growth')]:
            with self.subTest(reason=reason):
                result = self.guard.supervise([sys.executable, '-c', 'import time; time.sleep(30)'],
                    snapshot=lambda group: {**self.healthy(), **(changes if group else {})},
                    interval=0.01, grace=0.05)
                self.assertEqual(result['reason'], reason)
                self.assertNotEqual(result['exit_code'], 0)

    def test_monitor_failure_fails_closed_and_reaps_child(self):
        def snapshot(group):
            if group:
                raise OSError('synthetic unavailable sampler')
            return self.healthy()
        result = self.guard.supervise([sys.executable, '-c', 'import time; time.sleep(30)'],
            snapshot=snapshot, interval=0.01, grace=0.05)
        self.assertEqual(result['reason'], 'monitor_unavailable')
        with self.assertRaises(ProcessLookupError):
            os.kill(result['pid'], 0)

    def test_timeout_and_child_failure_are_never_passes(self):
        timed = self.guard.supervise([sys.executable, '-c',
            'import time,signal; signal.signal(signal.SIGINT,lambda *args: exit(130)); time.sleep(30)'],
            snapshot=lambda group: self.healthy(), interval=0.01, grace=0.05, timeout=0.1)
        self.assertEqual(timed['reason'], 'timeout')
        failed = self.guard.supervise([sys.executable, '-c', 'raise SystemExit(7)'],
            snapshot=lambda group: self.healthy(), interval=0.01, grace=0.05)
        self.assertEqual(failed['state'], 'failed')
        self.assertEqual(failed['exit_code'], 7)

    def test_real_darwin_sampler_reports_physical_footprint_and_system_state(self):
        if sys.platform != 'darwin':
            self.skipTest('macOS resource admission')
        value = self.guard.sample_system(None)
        self.assertGreater(value['available_bytes'], 0)
        self.assertIn(value['pressure'], (1, 2, 4))
        self.assertGreater(self.guard.process_footprint(os.getpid()), 0)


if __name__ == '__main__':
    unittest.main()

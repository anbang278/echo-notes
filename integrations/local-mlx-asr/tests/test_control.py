import json
import tempfile
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from control import own_pid, stop


class ControlTests(unittest.TestCase):
    def test_process_identity_requires_command_port_and_start_time(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);service=root/'service.py'
            record={'pid':123,'service':str(service),'port':18081,'started':'same-start'}
            (root/'service.pid').write_text(json.dumps(record))
            with patch('control.process_argv',return_value=['python',str(service),'18081']),patch('control.subprocess.check_output',return_value='same-start'):
                self.assertEqual(own_pid(root,service,18081),123)
            with patch('control.process_argv',return_value=['python',str(service),'18081']),patch('control.subprocess.check_output',return_value='different-start'):
                self.assertIsNone(own_pid(root,service,18081))
            with patch('control.process_argv',return_value=['python','unrelated.py','18081']):
                self.assertIsNone(own_pid(root,service,18081))
            self.assertIsNone(own_pid(root,service,18080))

    def test_stop_does_not_signal_unrelated_pid(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);service=root/'service.py'
            (root/'service.pid').write_text(json.dumps({'pid':123,'service':str(service),'port':18081,'started':'stale'}))
            with patch('control.process_argv',return_value=['python','unrelated.py','18081']),patch('control.os.kill') as kill:
                stop(root,service,18081)
                kill.assert_not_called()

    def test_real_process_with_spaces_preserves_argv_boundaries(self):
        with tempfile.TemporaryDirectory(prefix='asr control space ') as temp:
            root=Path(temp);service=root/'service with space.py'
            service.write_text('import time\ntime.sleep(30)\n')
            process=subprocess.Popen([sys.executable,str(service),'18081'])
            try:
                started=subprocess.check_output(['ps','-p',str(process.pid),'-o','lstart='],text=True).strip()
                (root/'service.pid').write_text(json.dumps({'pid':process.pid,'service':str(service),'port':18081,'started':started}))
                self.assertEqual(own_pid(root,service,18081),process.pid)
                with patch('control.process_argv',return_value=[sys.executable,str(service)+' 18081']):
                    self.assertIsNone(own_pid(root,service,18081))
            finally:
                process.terminate();process.wait(timeout=5)


if __name__=='__main__':unittest.main()

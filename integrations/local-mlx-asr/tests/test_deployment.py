"""Service/app transactions use temporary installations, never installed paths."""
import contextlib
import hashlib
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import deploy_service as deploy


class DeploymentTests(unittest.TestCase):
    def fixture(self,root):
        root=root.resolve()  # macOS /var itself is a symlink to /private/var.
        runtime=root/'runtime with spaces';runtime.mkdir()
        (runtime/'.venv/bin').mkdir(parents=True);(runtime/'.venv/bin/python').write_text('interpreter')
        (runtime/'data.json').write_text('private configuration untouched')
        (runtime/'service.py').write_text('old service')
        (runtime/'status.sh').write_text('old script');(runtime/'status.sh').chmod(0o640)
        app=root/deploy.APP;app.mkdir();(app/'old').write_text('old app')
        package_root=root/'bundle/local-mlx-asr';package_root.mkdir(parents=True)
        for name in deploy.RUNTIME_FILES:(package_root/name).write_text('new '+name)
        (package_root/deploy.APP/'Contents/MacOS').mkdir(parents=True)
        (package_root/deploy.APP/'Contents/MacOS/ASRControl').write_text('new app')
        for name in deploy.REQUIRED_EXECUTABLES:(package_root/name).chmod(0o755)
        manifest={'service_version':'2.0.0','controller_version':'1.2.0','files':{str(p.relative_to(package_root)):deploy.digest(p) for p in package_root.rglob('*') if p.is_file()},'modes':{str(p.relative_to(package_root)):deploy.permission_snapshot(p) for p in package_root.rglob('*') if p.is_file()}}
        (package_root/'bundle-manifest.json').write_text(json.dumps(manifest))
        archive=root/'bundle.tar.gz'
        with tarfile.open(archive,'w:gz') as out:out.add(package_root,arcname='local-mlx-asr')
        plan=deploy.prepare(archive,deploy.digest(archive),runtime,app,root/'backups',18080)
        return runtime,app,plan,archive

    def test_prepare_apply_and_rollback_preserve_other_files(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime,app,plan,_=self.fixture(Path(temp))
            self.assertEqual((runtime/'service.py').read_text(),'old service')
            with patch('deploy_service.transaction_lock',return_value=contextlib.nullcontext()):deploy.apply(plan)
            self.assertEqual((runtime/'service.py').read_text(),'new service.py')
            self.assertTrue((app/'Contents/MacOS/ASRControl').exists())
            self.assertEqual(deploy.permission_snapshot(runtime/'status.sh'),0o755)
            self.assertEqual(deploy.permission_snapshot(app/'Contents/MacOS/ASRControl'),0o755)
            with patch('deploy_service.transaction_lock',return_value=contextlib.nullcontext()):deploy.rollback(plan)
            self.assertEqual((runtime/'service.py').read_text(),'old service')
            self.assertEqual((app/'old').read_text(),'old app')
            self.assertFalse((runtime/'job_store.py').exists())
            self.assertEqual(deploy.permission_snapshot(runtime/'status.sh'),0o640)
            self.assertEqual((runtime/'data.json').read_text(),'private configuration untouched')
            self.assertEqual((runtime/'.venv/bin/python').read_text(),'interpreter')
            self.assertEqual(json.loads(plan.read_text())['state'],'rolled_back')

    def test_changed_installation_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime,app,plan,_=self.fixture(Path(temp))
            (runtime/'service.py').write_text('another change')
            with patch('deploy_service.transaction_lock',return_value=contextlib.nullcontext()):
                with self.assertRaisesRegex(ValueError,'changed since preparation'):deploy.apply(plan)
            self.assertEqual((runtime/'service.py').read_text(),'another change')

    def test_staged_executable_permission_change_is_not_installed(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime,app,plan,_=self.fixture(Path(temp))
            (plan.parent/'staged/status.sh').chmod(0o644)
            with patch('deploy_service.transaction_lock',return_value=contextlib.nullcontext()):
                with self.assertRaisesRegex(ValueError,'Staged permissions changed'):deploy.apply(plan)
            self.assertEqual(deploy.permission_snapshot(runtime/'status.sh'),0o640)

    def test_archive_with_missing_executable_bit_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();runtime,app,plan,archive=self.fixture(root)
            source=root/'bundle/local-mlx-asr'
            (source/'status.sh').chmod(0o644)
            # Even when the manifest is changed consistently, executable policy
            # is independent and rejects a non-runnable control script.
            manifest=json.loads((source/'bundle-manifest.json').read_text())
            manifest['modes']['status.sh']=0o644
            (source/'bundle-manifest.json').write_text(json.dumps(manifest))
            with tarfile.open(archive,'w:gz') as output:output.add(source,arcname='local-mlx-asr')
            with self.assertRaisesRegex(ValueError,'Required executable'):
                deploy.prepare(archive,deploy.digest(archive),runtime,app,root/'other-backups',18080)

    def test_partial_install_failure_restores_all_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime,app,plan,_=self.fixture(Path(temp))
            real=deploy.replace_file;count=0
            def fail_once(*args):
                nonlocal count
                count+=1
                if count==4:raise OSError('injected disk failure')
                return real(*args)
            with patch('deploy_service.transaction_lock',return_value=contextlib.nullcontext()),patch('deploy_service.replace_file',side_effect=fail_once):
                with self.assertRaises(OSError):deploy.apply(plan)
            self.assertEqual(json.loads(plan.read_text())['state'],'rolled_back')
            self.assertEqual((runtime/'service.py').read_text(),'old service')
            self.assertEqual((app/'old').read_text(),'old app')

    def test_package_hash_and_symlink_targets_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();runtime,app,plan,archive=self.fixture(root)
            with self.assertRaisesRegex(ValueError,'SHA-256'):
                deploy.prepare(archive,'0'*64,runtime,app,root/'other-backups',18080)
            link=root/'runtime-link';link.symlink_to(runtime,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'Symlink'):
                deploy.prepare(archive,deploy.digest(archive),link,app,root/'other-backups',18080)


if __name__=='__main__':unittest.main()

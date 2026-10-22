import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import package_service


class PackagePrivacyTests(unittest.TestCase):
    def test_packaged_manifests_keep_integrity_but_drop_machine_paths(self):
        stage=getattr(package_service,'stage_runtime_file',None)
        self.assertTrue(callable(stage),'Package staging must remove machine-specific model paths')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';source.mkdir();destination=root/'bundle';destination.mkdir()
            manifest={'model':'fixture','revision':'a'*40,'path':'/private/example/model','files':{'config.json':{'sha256':'abc'}}}
            (source/'model-manifest.json').write_text(json.dumps(manifest))
            with patch.object(package_service,'ROOT',source):stage('model-manifest.json',destination)
            result=json.loads((destination/'model-manifest.json').read_text())
            self.assertNotIn('path',result);self.assertEqual(result['files'],manifest['files'])


if __name__=='__main__':unittest.main()

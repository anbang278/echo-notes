"""Produce a source/runtime bundle; no installation or model-cache mutation."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path
from enhancement import SERVICE_VERSION
from deploy_service import REQUIRED_EXECUTABLES, permission_snapshot

ROOT = Path(__file__).resolve().parent
FILES = ['service.py','enhancement.py','job_store.py','bounded_audio.py','bounded_diarization.py',
         'bounded_worker.py','diarization.py','multipart_stream.py','control.py',
         'start.sh','stop.sh','status.sh','README.md','DEPLOYMENT.md','deploy_service.py','requirements.lock',
         'model-manifest.json','diarization-manifest.json','alignment-manifest.json']


def stage_runtime_file(name, destination):
    source = ROOT/name
    target = destination/name
    shutil.copy2(source, target)
    if name.endswith('-manifest.json'):
        manifest = json.loads(target.read_text())
        manifest.pop('path', None)  # model roots are resolved from HOME by the runtime
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    opts=parser.parse_args()
    opts.output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='asr-package-') as tmp:
        root=Path(tmp)/'local-mlx-asr'
        root.mkdir()
        for name in ['start.sh','stop.sh','status.sh']:
            if permission_snapshot(ROOT/name)!=0o755:raise ValueError(f'Source script must be executable (0755): {name}')
        for name in FILES:stage_runtime_file(name,root)
        app=root/'MLX ASR 控制台.app'
        subprocess.run(['sh',str(ROOT/'controller/build.sh'),str(app)],check=True)
        checksums={str(p.relative_to(root)):hashlib.file_digest(p.open('rb'),'sha256').hexdigest() for p in root.rglob('*') if p.is_file()}
        modes={name:permission_snapshot(root/name) for name in checksums}
        if any(modes.get(name)!=0o755 for name in REQUIRED_EXECUTABLES):raise ValueError('Packaged executable permission mismatch')
        manifest={'service_version':SERVICE_VERSION,'controller_version':'1.2.0','files':checksums,
                  'modes':modes,
                  'requirements':'Existing interpreter matching requirements.lock and pinned model caches are not included'}
        (root/'bundle-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
        archive=opts.output/f'echo-notes-local-asr-{SERVICE_VERSION}.tar.gz'
        with tarfile.open(archive,'w:gz') as output:output.add(root,arcname='local-mlx-asr')
        digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
        (opts.output/'service-package-evidence.json').write_text(json.dumps({'path':str(archive),'sha256':digest,'manifest':manifest},ensure_ascii=False,indent=2))
        print(json.dumps({'path':str(archive),'sha256':digest}))


if __name__=='__main__':main()

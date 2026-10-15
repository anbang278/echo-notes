"""Reviewable service/app transaction; never stop/start processes or modify caches."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import shutil
import socket
import tarfile
import time
import uuid
from pathlib import Path

APP = 'MLX ASR 控制台.app'
REQUIRED_EXECUTABLES = {'start.sh','stop.sh','status.sh',APP+'/Contents/MacOS/ASRControl'}
RUNTIME_FILES = {'service.py','job_store.py','bounded_audio.py','bounded_diarization.py',
                 'bounded_worker.py','diarization.py','multipart_stream.py','control.py',
                 'start.sh','stop.sh','status.sh','README.md','DEPLOYMENT.md','deploy_service.py',
                 'requirements.lock','model-manifest.json','diarization-manifest.json','alignment-manifest.json'}


def digest(path):
    if path.is_symlink(): raise ValueError(f'Symlink refused: {path}')
    if not path.exists(): return None
    if path.is_file():
        with path.open('rb') as source: return hashlib.file_digest(source,'sha256').hexdigest()
    values={}
    for item in sorted(path.rglob('*')):
        if item.is_symlink(): raise ValueError(f'Symlink refused: {item}')
        if item.is_file(): values[str(item.relative_to(path))]=digest(item)
    return hashlib.sha256(json.dumps(values,sort_keys=True).encode()).hexdigest()


def permission_snapshot(path):
    if path.is_symlink(): raise ValueError(f'Symlink refused: {path}')
    if not path.exists(): return None
    if path.is_file(): return path.stat().st_mode & 0o777
    return {str(p.relative_to(path)):p.stat().st_mode & 0o777 for p in sorted(path.rglob('*')) if p.is_file()}


def safe_path(path):
    path=path.expanduser().absolute()
    if any(part.is_symlink() for part in [path,*path.parents]):
        raise ValueError(f'Symlink refused in target path: {path}')
    return path


def write_json(path,value):
    temp=path.with_suffix('.tmp')
    with temp.open('w') as output:
        json.dump(value,output,ensure_ascii=False,indent=2);output.flush();os.fsync(output.fileno())
    os.replace(temp,path)


def unpack_verified(archive,destination,expected):
    if digest(archive)!=expected: raise ValueError('Package SHA-256 mismatch')
    names=set();total=0
    with tarfile.open(archive,'r:gz') as source:
        for member in source.getmembers():
            parts=Path(member.name).parts
            if not parts or parts[0]!='local-mlx-asr' or '..' in parts or Path(member.name).is_absolute():
                raise ValueError('Unsafe package path')
            if not (member.isfile() or member.isdir()): raise ValueError('Package link/special file refused')
            target=destination.joinpath(*parts[1:])
            if member.name in names: raise ValueError('Duplicate archive path')
            names.add(member.name);total+=member.size
            if total>32*1024**2: raise ValueError('Unexpected package size')
            if member.isdir(): target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            with source.extractfile(member) as src,target.open('wb') as dst: shutil.copyfileobj(src,dst,1024*1024)
            target.chmod(member.mode & 0o777)
    manifest=json.loads((destination/'bundle-manifest.json').read_text())
    files=manifest['files']
    modes=manifest.get('modes',{})
    actual={str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file()}-{'bundle-manifest.json'}
    if set(files)!=actual: raise ValueError('Manifest file inventory mismatch')
    if set(modes)!=actual: raise ValueError('Manifest permission inventory mismatch')
    if any(modes.get(name)!=0o755 for name in REQUIRED_EXECUTABLES):
        raise ValueError('Required executable must have mode 0755')
    if {n for n in files if '/' not in n}!=RUNTIME_FILES: raise ValueError('Unexpected runtime file inventory')
    if any('/' in n and not n.startswith(APP+'/') for n in files): raise ValueError('Unexpected package directory')
    for name,sha in files.items():
        if digest(destination/name)!=sha: raise ValueError(f'Bundle hash mismatch: {name}')
        if permission_snapshot(destination/name)!=modes[name]: raise ValueError(f'Bundle permission mismatch: {name}')
    return manifest


def prepare(archive,expected,runtime,app,backups,port):
    runtime,app,backups=map(safe_path,(runtime,app,backups))
    if not runtime.is_dir() or not (runtime/'.venv/bin/python').exists():
        raise ValueError('Existing ordinary runtime with matching .venv is required')
    if app.exists() and not app.is_dir(): raise ValueError('App target must be a directory')
    folder=backups/('local-asr-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])
    folder.mkdir(parents=True,mode=0o700)
    stage=folder/'staged';stage.mkdir()
    manifest=unpack_verified(archive,stage,expected)
    originals=folder/'original';originals.mkdir()
    targets={name:runtime/name for name in sorted(RUNTIME_FILES|{'bundle-manifest.json'})}
    targets['app']=app
    before={key:digest(path) for key,path in targets.items()}
    before_modes={key:permission_snapshot(path) for key,path in targets.items()}
    for key,path in targets.items():
        if before[key] is None:continue
        if key=='app': shutil.copytree(path,originals/'app')
        else: shutil.copy2(path,originals/key)
    after={key:digest(stage/(APP if key=='app' else key)) for key in targets}
    after_modes={key:permission_snapshot(stage/(APP if key=='app' else key)) for key in targets}
    plan={'schema':2,'state':'prepared','transaction_id':folder.name,'runtime':str(runtime),'app':str(app),
          'port':port,'package':str(archive.absolute()),'package_sha256':expected,'before':before,'after':after,
          'before_modes':before_modes,'after_modes':after_modes,
          'service_version':manifest['service_version'],'controller_version':manifest['controller_version'],
          'created_at':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    write_json(folder/'plan.json',plan)
    return folder/'plan.json'


def require_idle(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        try: probe.bind(('127.0.0.1',port))
        except OSError as exc: raise ValueError('Target port is occupied; stop the verified owned service first') from exc


@contextlib.contextmanager
def transaction_lock(plan):
    runtime=Path(plan['runtime'])
    lock_path=Path.home()/'.local/share/echo-notes/mlx-inference.lock'
    lock_path.parent.mkdir(parents=True,exist_ok=True)
    with (runtime/'control.lock').open('a') as control,lock_path.open('a') as compute:
        fcntl.flock(control,fcntl.LOCK_EX|fcntl.LOCK_NB)
        fcntl.flock(compute,fcntl.LOCK_EX|fcntl.LOCK_NB)
        require_idle(plan['port'])
        yield


def targets(plan):
    if plan.get('schema')!=2:raise ValueError('Prepare a new transaction with permission evidence; old plan was not modified')
    runtime=safe_path(Path(plan['runtime']));app=safe_path(Path(plan['app']))
    if set(plan['before'])!=RUNTIME_FILES|{'bundle-manifest.json','app'} or set(plan['after'])!=set(plan['before']):
        raise ValueError('Unexpected transaction inventory')
    return {key:app if key=='app' else runtime/key for key in plan['before']}


def replace_file(source,target,transaction):
    stage=target.parent/('.'+target.name+'.'+transaction+'.new')
    shutil.copy2(source,stage)
    with stage.open('rb') as file:os.fsync(file.fileno())
    os.replace(stage,target)


def replace_app(source,target,transaction):
    stage=target.parent/('.mlx-asr-'+transaction+'.new')
    previous=target.parent/('.mlx-asr-'+transaction+'.old')
    if stage.exists():shutil.rmtree(stage)
    shutil.copytree(source,stage)
    if target.exists():
        if previous.exists():shutil.rmtree(previous)
        os.replace(target,previous)
    os.replace(stage,target)
    if previous.exists():shutil.rmtree(previous)


def restore(plan_path,plan):
    paths=targets(plan);originals=plan_path.parent/'original'
    for key,path in paths.items():
        current=digest(path)
        if current not in {plan['before'][key],plan['after'][key],None}:
            raise ValueError(f'Rollback refused changed file: {key}')
        if permission_snapshot(path) not in [plan['before_modes'][key],plan['after_modes'][key],None]:
            raise ValueError(f'Rollback refused changed permissions: {key}')
        if plan['before'][key] is not None and digest(originals/key)!=plan['before'][key]:
            raise ValueError(f'Rollback backup hash mismatch: {key}')
        if permission_snapshot(originals/key)!=plan['before_modes'][key]:
            raise ValueError(f'Rollback backup permission mismatch: {key}')
    plan['state']='rolling_back';write_json(plan_path,plan)
    for key,path in paths.items():
        if plan['before'][key] is None:
            if path.is_dir():shutil.rmtree(path)
            else:path.unlink(missing_ok=True)
        elif key=='app':replace_app(originals/key,path,plan['transaction_id'])
        else:replace_file(originals/key,path,plan['transaction_id'])
    if any(digest(path)!=plan['before'][key] for key,path in paths.items()):raise ValueError('Rollback verification failed')
    if any(permission_snapshot(path)!=plan['before_modes'][key] for key,path in paths.items()):raise ValueError('Rollback permission verification failed')
    plan['state']='rolled_back';write_json(plan_path,plan)


def apply(plan_path):
    plan=json.loads(plan_path.read_text())
    if plan['state']!='prepared':raise ValueError('Only a prepared transaction can be applied')
    with transaction_lock(plan):
        paths=targets(plan);stage=plan_path.parent/'staged'
        for key,path in paths.items():
            if digest(path)!=plan['before'][key]:raise ValueError(f'Installed target changed since preparation: {key}')
            if permission_snapshot(path)!=plan['before_modes'][key]:raise ValueError(f'Installed permissions changed since preparation: {key}')
            if digest(stage/(APP if key=='app' else key))!=plan['after'][key]:raise ValueError('Staged files changed')
            if permission_snapshot(stage/(APP if key=='app' else key))!=plan['after_modes'][key]:raise ValueError('Staged permissions changed')
        plan['state']='applying';write_json(plan_path,plan)
        try:
            for key,path in paths.items():
                if key=='app':replace_app(stage/APP,path,plan['transaction_id'])
                else:replace_file(stage/key,path,plan['transaction_id'])
            if any(digest(path)!=plan['after'][key] for key,path in paths.items()):raise ValueError('Installed verification failed')
            if any(permission_snapshot(path)!=plan['after_modes'][key] for key,path in paths.items()):raise ValueError('Installed permission verification failed')
            plan['state']='applied';write_json(plan_path,plan)
        except BaseException:
            restore(plan_path,plan)
            raise


def rollback(plan_path):
    plan=json.loads(plan_path.read_text())
    if plan['state'] not in {'applying','applied','rolling_back'}:raise ValueError('No applied transaction to roll back')
    with transaction_lock(plan):restore(plan_path,plan)


def main():
    parser=argparse.ArgumentParser()
    sub=parser.add_subparsers(dest='action',required=True)
    first=sub.add_parser('prepare')
    first.add_argument('--package',type=Path,required=True);first.add_argument('--sha256',required=True)
    first.add_argument('--runtime',type=Path,required=True);first.add_argument('--app',type=Path,required=True)
    first.add_argument('--backups',type=Path,required=True);first.add_argument('--port',type=int,default=18080)
    for action in ['apply','rollback']:sub.add_parser(action).add_argument('--plan',type=Path,required=True)
    args=parser.parse_args()
    if args.action=='prepare':print(prepare(args.package,args.sha256,args.runtime,args.app,args.backups,args.port))
    elif args.action=='apply':apply(args.plan);print('Files installed and verified; service has not been started.')
    else:rollback(args.plan);print('Previous files restored and verified; service has not been started.')


if __name__=='__main__':main()

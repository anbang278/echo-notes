#!/bin/sh
set -eu
ASR_CODE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ASR_PYTHON=${ECHONOTES_ASR_PYTHON:-"$ASR_CODE_ROOT/.venv/bin/python"}
exec "$ASR_PYTHON" "$ASR_CODE_ROOT/control.py" start "$@"

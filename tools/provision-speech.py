"""Install the independent transcription runtime on Windows."""

import hashlib
from pathlib import Path
import struct
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent.parent
REVISION = "536b0662742c02347bc0e980a01041f333bce120"
WEIGHTS = "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"
MODEL = "Systran/faster-whisper-small"
MODEL_FILES = ["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"]


def main():
    if sys.platform != "win32" or sys.version_info[:2] != (3, 12) or struct.calcsize("P") != 8:
        raise SystemExit("Run this script with 64-bit Python 3.12 on Windows.")

    runtime = ROOT / ".runtime" / "speech"
    ready = runtime / "ready.txt"
    model = runtime / "whisper-small"
    python = runtime / "python"
    embedded = python / "python.exe"
    interpreter = python / "Scripts" / "python.exe"
    if ready.is_file() and (embedded.is_file() or interpreter.is_file()) and all(
        (model / name).is_file() for name in MODEL_FILES
    ):
        print("The local transcription runtime is already installed.")
        return
    if not interpreter.is_file():
        venv.EnvBuilder(with_pip=True).create(python)
    subprocess.run([str(interpreter), "-m", "pip", "install", "faster-whisper==1.2.1"], check=True)
    download = (
        "import sys; from huggingface_hub import snapshot_download; "
        "snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], "
        "allow_patterns=sys.argv[4:])"
    )
    subprocess.run([str(interpreter), "-c", download, MODEL, REVISION, str(model), *MODEL_FILES], check=True)
    with (model / "model.bin").open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHTS:
            raise SystemExit("Whisper Small model checksum mismatch.")
    subprocess.run([str(interpreter), "-c", "from faster_whisper import WhisperModel"], check=True)
    ready.write_text(WEIGHTS + "\n", encoding="utf-8")
    print("The local transcription runtime is ready.")


if __name__ == "__main__":
    main()

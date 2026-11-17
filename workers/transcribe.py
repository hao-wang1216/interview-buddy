"""Transcribe 16 kHz signed PCM segments over a local JSON line pipe."""

from base64 import b64decode
import json
from pathlib import Path
import sys

from faster_whisper import WhisperModel
import numpy as np


def send(item):
    print(json.dumps(item, ensure_ascii=False), flush=True)


def main():
    model = WhisperModel(str(Path(sys.argv[1])), device="cpu", compute_type="int8", local_files_only=True)
    send({"ready": True})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            raw = b64decode(request["pcm"], validate=True)
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
            segments, _ = model.transcribe(
                samples, language=request["language"], beam_size=1, condition_on_previous_text=False,
                vad_filter=True, vad_parameters={"min_silence_duration_ms": 350},
            )
            send({"id": request["id"], "text": " ".join(segment.text.strip() for segment in segments).strip()})
        except Exception as error:
            send({"id": request.get("id"), "error": str(error)})


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()

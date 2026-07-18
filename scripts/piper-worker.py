#!/usr/bin/env python3
"""Persistent line-oriented Piper worker used by Cinder's voice runtime."""

import argparse
import json
import sys
import wave

from piper.voice import PiperVoice


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    voice = PiperVoice.load(args.model, use_cuda=False)

    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            with wave.open(str(request["outputPath"]), "wb") as wav_file:
                voice.synthesize_wav(str(request["text"]), wav_file)
            result = {"id": request_id, "ok": True}
        except Exception as error:  # Worker must survive one malformed request.
            result = {"id": request_id, "ok": False, "error": str(error)}
        print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

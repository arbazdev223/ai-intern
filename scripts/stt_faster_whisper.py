import argparse
import json
import sys


def build_parser():
    parser = argparse.ArgumentParser(description="Local STT using faster-whisper")
    parser.add_argument("--input", required=True, help="Path to input audio file")
    parser.add_argument("--model", default="small", help="Whisper model name (tiny/base/small/medium/large-v3)")
    parser.add_argument("--language", default="", help="Optional language code (en/hi/etc)")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        sys.stderr.write(
            "faster-whisper is not installed. Run: pip install faster-whisper ; "
            f"details: {exc}\n"
        )
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        language = args.language.strip() or None

        def run_once(lang):
            initial_prompt = None
            if lang == "hi":
                initial_prompt = "यह हिंदी या हिंग्लिश बातचीत का ऑडियो है।"

            segments, info = model.transcribe(
                args.input,
                language=lang,
                task="transcribe",
                beam_size=8,
                best_of=8,
                vad_filter=True,
                condition_on_previous_text=False,
                initial_prompt=initial_prompt,
            )

            text_parts = []
            for segment in segments:
                part = str(segment.text or "").strip()
                if part:
                    text_parts.append(part)

            return " ".join(text_parts).strip(), info

        text, info = run_once(language)
        if not text and language:
            # Retry once without forcing language so Whisper can auto-detect.
            text, info = run_once(None)

        result = {
            "text": text,
            "language": getattr(info, "language", "") or "",
            "provider": "python-faster-whisper",
        }
        sys.stdout.write(json.dumps(result, ensure_ascii=True))
        return 0
    except Exception as exc:
        sys.stderr.write(f"transcription failed: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

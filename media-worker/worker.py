"""Local, restartable media preparation for existing agent-chat attachments."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(os.environ.get('DATA_ROOT', '/app/storage')) / 'agent-chat'
MODEL = os.environ.get('WHISPER_MODEL_PATH', '/models/small')
INPUT_FLAGS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,wav,ogg,flac,aac,mov,matroska,webm,avi,mpeg,mpegts,asf,aiff,amr']

def publish(directory, value):
    tmp = directory / 'processing.tmp'
    tmp.write_text(json.dumps(value, ensure_ascii=False))
    tmp.replace(directory / 'processing.json')

def run(args, timeout=90):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout)

def process(directory):
    request = json.loads((directory / 'request.json').read_text())
    source = directory / 'original'
    result = {'state': 'processing', 'updated_at': time.time()}
    publish(directory, result)
    probe = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', *INPUT_FLAGS, str(source)]).stdout)
    duration = float(probe.get('format', {}).get('duration', 0))
    if not math.isfinite(duration) or duration <= 0 or duration > min(900, request.get('max_seconds', 900)):
        raise ValueError('Media duration must be between 0 and 900 seconds')
    frames = []
    if request['mime_type'].startswith('video/'):
        count = min(20, max(1, math.ceil(duration / 10)))
        for index in range(count):
            timestamp = duration * (index + .5) / count
            name = f'frame-{index:02}.jpg'
            run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', str(timestamp), *INPUT_FLAGS, '-i', str(source), '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease', str(directory / name)])
            frames.append({'variant': name, 'timestamp': timestamp})
    segments = []
    language = None
    if any(s.get('codec_type') == 'audio' for s in probe.get('streams', [])):
        # Each job runs in its own bounded process: a stalled decoder/model can be killed.
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        from faster_whisper import WhisperModel
        model = WhisperModel(MODEL, device='cpu', compute_type='int8', cpu_threads=2, local_files_only=True)
        audio = directory / 'decoded.wav'
        run(['ffmpeg', '-v', 'error', '-nostdin', '-y', *INPUT_FLAGS, '-i', str(source), '-vn', '-ac', '1', '-ar', '16000', str(audio)], timeout=180)
        output, info = model.transcribe(str(audio), beam_size=5, vad_filter=True)
        segments = [{'start': s.start, 'end': s.end, 'text': s.text.strip()} for s in output]
        language = info.language
        audio.unlink(missing_ok=True)
    transcript = {'language': language, 'segments': segments, 'text': ' '.join(s['text'] for s in segments)}
    tmp = directory / 'transcript.tmp'
    tmp.write_text(json.dumps(transcript, ensure_ascii=False))
    tmp.replace(directory / 'transcript.json')
    publish(directory, {'state': 'ready', 'duration': duration, 'transcript': 'transcript.json', 'frames': frames, 'updated_at': time.time()})

def loop():
    ROOT.mkdir(parents=True, exist_ok=True)
    while True:
        for request in ROOT.glob('*/request.json'):
            directory = request.parent
            try:
                state = json.loads((directory / 'processing.json').read_text())
            except (OSError, ValueError):
                state = {}
            if state.get('state') in ('ready', 'failed'):
                continue
            # Retries are persisted and limited even across worker restarts.
            attempt_file = directory / 'attempts'
            try:
                attempts = int(attempt_file.read_text())
            except (OSError, ValueError):
                attempts = 0
            if attempts >= 3:
                publish(directory, {'state': 'failed', 'error': 'Media preparation failed after three attempts; original is available.'})
                continue
            try:
                attempt_file.write_text(str(attempts + 1))
                run([sys.executable, __file__, '--job', str(directory)], timeout=1200)
            except (subprocess.SubprocessError, OSError):
                if directory.exists():
                    publish(directory, {'state': 'failed' if attempts == 2 else 'queued', 'error': 'Media preparation failed; original remains available.', 'attempts': attempts + 1})
        time.sleep(3)

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--job':
        process(Path(sys.argv[2]))
    else:
        loop()

#!/usr/bin/env python3
"""
Video Subtitle Editor

A Python script that:
1. Transcribes video using Whisper with word-level timestamps
2. Opens an HTML page for reviewing/editing subtitles
3. Burns subtitles into the video with FFmpeg

Usage:
    python subtitle_editor.py video.mp4
    
Requirements:
    pip install faster-whisper flask
    FFmpeg must be installed
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory

# Check for faster-whisper
try:
    from faster_whisper import WhisperModel
except ImportError:
    print("Error: faster-whisper not installed. Run: pip install faster-whisper")
    sys.exit(1)


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds using ffprobe."""
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'quiet',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            video_path
        ], capture_output=True, text=True)
        return float(result.stdout.strip())
    except:
        return 0


def print_progress_bar(progress: float, width: int = 40, prefix: str = '', suffix: str = ''):
    """Print a progress bar to the terminal."""
    filled = int(width * progress)
    bar = '█' * filled + '░' * (width - filled)
    percent = progress * 100
    sys.stdout.write(f'\r   {prefix} [{bar}] {percent:5.1f}% {suffix}')
    sys.stdout.flush()


class ModelLoadingProgress:
    """Show a spinner while model loads."""
    def __init__(self, message: str):
        self.message = message
        self.running = False
        self.thread = None
    
    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._spin)
        self.thread.start()
    
    def stop(self, final_message: str = None):
        self.running = False
        if self.thread:
            self.thread.join()
        if final_message:
            sys.stdout.write(f'\r   {final_message}' + ' ' * 20 + '\n')
            sys.stdout.flush()
    
    def _spin(self):
        spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
        i = 0
        while self.running:
            sys.stdout.write(f'\r   {spinner[i]} {self.message}')
            sys.stdout.flush()
            i = (i + 1) % len(spinner)
            time.sleep(0.1)


# Global state
app = Flask(__name__, template_folder='templates', static_folder='static')
state = {
    'video_path': None,
    'video_filename': None,
    'words': [],  # List of {word, start, end}
    'subtitles': [],  # List of {id, start, end, text, words: [{word, start, end}]}
    'settings': {
        'font_size': 42,
        'position': 'bottom',  # top, middle, bottom
        'text_color': 'white',
        'highlight_color': '#fbbf24',  # Yellow - matches presenter mode
        'word_highlighting': True,  # If False, much faster encoding (no per-word events)
    },
    'output_path': None,
    'approved': False,
}


def transcribe_video(video_path: str, model_size: str = "medium") -> list:
    """
    Transcribe video using faster-whisper with word-level timestamps.
    Returns list of words with timestamps.
    """
    # Get video duration for progress tracking
    duration = get_video_duration(video_path)
    duration_str = f"{int(duration//60)}:{int(duration%60):02d}" if duration else "unknown"
    print(f"\n📹 Video duration: {duration_str}")
    
    # Load model with spinner
    print(f"\n🎤 Loading Whisper model ({model_size})...")
    spinner = ModelLoadingProgress(f"Downloading/loading {model_size} model (this may take a minute)...")
    spinner.start()
    
    # Use GPU if available
    device = "cuda"
    compute_type = "float16"
    
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        spinner.stop(f"✓ Model loaded (GPU/CUDA)")
    except Exception as e:
        spinner.stop(f"GPU not available, trying CPU...")
        device = "cpu"
        compute_type = "int8"
        spinner = ModelLoadingProgress(f"Loading {model_size} model on CPU...")
        spinner.start()
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        spinner.stop(f"✓ Model loaded (CPU)")
    
    print(f"\n📝 Transcribing audio...")
    
    # Transcribe with word timestamps
    segments_generator, info = model.transcribe(
        video_path,
        word_timestamps=True,
        language="en",
    )
    
    print(f"   Detected language: {info.language} (probability: {info.language_probability:.2f})")
    print()
    
    # Process segments with progress bar
    words = []
    last_end = 0
    segment_count = 0
    
    for segment in segments_generator:
        segment_count += 1
        
        if segment.words:
            for word in segment.words:
                words.append({
                    'word': word.word.strip(),
                    'start': round(word.start, 3),
                    'end': round(word.end, 3),
                })
                last_end = word.end
        
        # Update progress bar
        if duration > 0:
            progress = min(1.0, last_end / duration)
            time_str = f"{int(last_end//60)}:{int(last_end%60):02d}/{duration_str}"
            print_progress_bar(progress, prefix='Transcribing', suffix=f'{time_str} ({len(words)} words)')
    
    # Final newline after progress bar
    print()
    print(f"\n   ✓ Found {len(words)} words in {segment_count} segments")
    return words


def words_to_subtitles(words: list, max_words: int = 8, max_duration: float = 4.0) -> list:
    """
    Group words into subtitle segments.
    """
    subtitles = []
    current_words = []
    subtitle_id = 1
    
    for word in words:
        if not current_words:
            current_words.append(word)
            continue
        
        # Check if we should start a new subtitle
        duration = word['end'] - current_words[0]['start']
        word_count = len(current_words)
        gap = word['start'] - current_words[-1]['end']
        
        should_break = (
            word_count >= max_words or
            duration > max_duration or
            gap > 0.7  # Pause in speech
        )
        
        if should_break:
            # Save current subtitle
            subtitles.append({
                'id': subtitle_id,
                'start': current_words[0]['start'],
                'end': current_words[-1]['end'],
                'text': ' '.join(w['word'] for w in current_words),
                'words': current_words,
            })
            subtitle_id += 1
            current_words = [word]
        else:
            current_words.append(word)
    
    # Don't forget the last subtitle
    if current_words:
        subtitles.append({
            'id': subtitle_id,
            'start': current_words[0]['start'],
            'end': current_words[-1]['end'],
            'text': ' '.join(w['word'] for w in current_words),
            'words': current_words,
        })
    
    return subtitles


def generate_ass_subtitles(subtitles: list, settings: dict, video_width: int = 1920, video_height: int = 1080) -> str:
    """
    Generate ASS subtitle file with word-by-word highlighting.
    Styled to match the HTML preview exactly.
    """
    font_size = settings.get('font_size', 42)
    position = settings.get('position', 'bottom')
    text_color = settings.get('text_color', 'white')
    highlight_color = settings.get('highlight_color', '#fbbf24')
    
    # ASS uses PlayRes as virtual coordinates - font size is relative to PlayResY
    # We use 1080 as reference, matching typical screen display
    play_res_x = 1920
    play_res_y = 1080
    
    # Convert hex color to ASS BGR format: &HAABBGGRR (AA=alpha, 00=opaque, FF=transparent)
    def hex_to_ass(hex_color, alpha='00'):
        if hex_color.startswith('#'):
            hex_color = hex_color[1:]
        if len(hex_color) == 6:
            r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
            return f"&H{alpha}{b.upper()}{g.upper()}{r.upper()}"
        return f"&H{alpha}FFFFFF"
    
    def color_name_to_ass(name, alpha='00'):
        if name == 'white':
            return f"&H{alpha}FFFFFF"
        if name == '#e2e8f0':
            return f"&H{alpha}F0E8E2"
        if name.startswith('#'):
            return hex_to_ass(name, alpha)
        return f"&H{alpha}FFFFFF"
    
    # Position: 2=bottom center, 5=middle center, 8=top center
    alignment = {'bottom': 2, 'middle': 5, 'top': 8}.get(position, 2)
    
    # Vertical margin
    margin_v = 50 if position in ('bottom', 'top') else 0
    
    primary_color = color_name_to_ass(text_color)
    highlight_color_ass = hex_to_ass(highlight_color)
    
    # Dimmed color for upcoming words
    dim_color = color_name_to_ass(text_color, '70')  # 70 = ~44% transparent
    
    # Background box color: semi-transparent black
    # Using BorderStyle 3 (opaque box) with OutlineColour as the box color
    # Alpha 80 = 50% transparent (80 hex = 128 decimal, 128/255 = 50%)
    box_color = '&H80000000'  # Semi-transparent black
    
    # Style explanation:
    # - BorderStyle 3 = opaque box behind text (uses OutlineColour for box)
    # - Outline 12 = padding around text (box extends this far)
    # - Shadow 0 = no drop shadow
    ass_content = f"""[Script Info]
Title: Video Subtitles
ScriptType: v4.00+
PlayResX: {play_res_x}
PlayResY: {play_res_y}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,{font_size},{primary_color},&H000000FF,{box_color},{box_color},1,0,0,0,100,100,0,0,3,12,0,{alignment},20,20,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    
    def format_time(seconds):
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = seconds % 60
        return f"{h}:{m:02d}:{s:05.2f}"
    
    # Check if word highlighting is enabled
    word_highlighting = settings.get('word_highlighting', True)
    
    # Generate events
    for sub in subtitles:
        words = sub.get('words', [])
        
        # Simple mode: one subtitle event per segment (FAST)
        if not word_highlighting or not words:
            start_time = format_time(sub['start'])
            end_time = format_time(sub['end'])
            ass_content += f"Dialogue: 0,{start_time},{end_time},Default,,0,0,0,,{sub['text']}\n"
            continue
        
        # Word highlighting mode: one event per word (SLOW but pretty)
        for i, word_info in enumerate(words):
            word_start = word_info['start']
            word_end = word_info['end']
            
            # Build the line with word styling
            parts = []
            for j, w in enumerate(words):
                word_text = w['word']
                if j == i:
                    # Current word - highlight color, slightly larger
                    parts.append(r"{\c" + highlight_color_ass[2:] + r"\fscx110\fscy110}" + word_text + r"{\r}")
                elif j < i:
                    # Already spoken - full white
                    parts.append(word_text)
                else:
                    # Upcoming - dimmed (semi-transparent)
                    parts.append(r"{\c" + dim_color[2:] + r"}" + word_text + r"{\r}")
            
            text = ' '.join(parts)
            start_time = format_time(word_start)
            end_time = format_time(word_end)
            
            ass_content += f"Dialogue: 0,{start_time},{end_time},Default,,0,0,0,,{text}\n"
    
    return ass_content


def burn_subtitles(video_path: str, ass_path: str, output_path: str) -> bool:
    """
    Burn subtitles into video using FFmpeg with progress reporting.
    """
    print(f"\n🎬 Burning subtitles into video...")
    
    # Get video duration for progress
    duration = get_video_duration(video_path)
    
    # Copy ASS file to a visible location for debugging
    video_dir = Path(video_path).parent
    debug_ass_path = video_dir / "debug_subtitles.ass"
    shutil.copy(ass_path, debug_ass_path)
    print(f"   📄 ASS file saved to: {debug_ass_path}")
    
    cmd = [
        'ffmpeg', '-y',
        '-i', video_path,
        '-vf', f"ass={ass_path}",
        '-c:a', 'copy',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        output_path
    ]
    
    # Print command for manual debugging
    print(f"\n   To run manually with full output:")
    print(f"   {' '.join(cmd)}\n")
    
    try:
        # Run FFmpeg and stream stderr to terminal in real-time
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
        )
        
        # Use threads to read both stdout and stderr without blocking
        import queue
        from threading import Thread
        
        stderr_queue = queue.Queue()
        
        def read_stderr():
            for line in iter(process.stderr.readline, b''):
                stderr_queue.put(line)
            process.stderr.close()
        
        stderr_thread = Thread(target=read_stderr, daemon=True)
        stderr_thread.start()
        
        start_time = time.time()
        last_progress_time = 0
        last_video_time = 0
        stall_count = 0
        
        while process.poll() is None:
            # Read any available stderr
            try:
                while True:
                    line = stderr_queue.get_nowait()
                    text = line.decode('utf-8', errors='ignore').strip()
                    
                    # Parse progress
                    if 'time=' in text:
                        try:
                            time_match = text.split('time=')[1].split()[0]
                            parts = time_match.split(':')
                            if len(parts) == 3:
                                h, m, s = parts
                                current = int(h) * 3600 + int(m) * 60 + float(s)
                                
                                # Check for stall
                                if current == last_video_time:
                                    stall_count += 1
                                    if stall_count > 30:  # 30 seconds without progress
                                        print(f"\n\n   ⚠️  FFmpeg appears stalled at {current:.1f}s ({current/duration*100:.1f}%)")
                                        print(f"   This might be a problematic section of the video.")
                                        print(f"   Last FFmpeg output: {text}")
                                else:
                                    stall_count = 0
                                    last_video_time = current
                                
                                if duration > 0:
                                    pct = min(100, (current / duration) * 100)
                                    elapsed = time.time() - start_time
                                    # Estimate remaining time
                                    if current > 0:
                                        eta = (elapsed / current) * (duration - current)
                                        eta_str = f"ETA: {int(eta//60)}m{int(eta%60)}s"
                                    else:
                                        eta_str = ""
                                    print(f"\r   Encoding: {pct:.1f}% | {int(current)}s / {int(duration)}s | elapsed: {int(elapsed//60)}m{int(elapsed%60)}s {eta_str}      ", end='', flush=True)
                                    last_progress_time = time.time()
                        except:
                            pass
                    
                    # Show errors immediately
                    if 'error' in text.lower() or 'failed' in text.lower():
                        print(f"\n   ❌ {text}")
                        
            except queue.Empty:
                pass
            
            # Check for overall stall (no output at all)
            if time.time() - last_progress_time > 60 and last_progress_time > 0:
                print(f"\n   ⚠️  No progress for 60 seconds. FFmpeg might be stuck.")
                print(f"   You can check CPU usage or kill and retry.")
            
            time.sleep(1)
        
        # Wait for stderr thread to finish
        stderr_thread.join(timeout=5)
        
        print()  # New line after progress
        
        if process.returncode != 0:
            print(f"\n   ❌ FFmpeg failed with code {process.returncode}")
            print(f"   Check the ASS file at: {debug_ass_path}")
            print(f"   Try running the command above manually to see full error.")
            return False
        
        print(f"   ✅ Output saved to: {output_path}")
        # Clean up debug file on success
        debug_ass_path.unlink(missing_ok=True)
        return True
        
    except Exception as e:
        print(f"\n   Error: {e}")
        import traceback
        traceback.print_exc()
        return False


# Flask routes
@app.route('/')
def index():
    return render_template('editor.html')


@app.route('/video')
def serve_video():
    """Serve the video file."""
    return send_file(state['video_path'], mimetype='video/mp4')


@app.route('/api/data')
def get_data():
    """Get current transcription data."""
    return jsonify({
        'video_filename': state['video_filename'],
        'subtitles': state['subtitles'],
        'settings': state['settings'],
    })


@app.route('/api/subtitles', methods=['POST'])
def update_subtitles():
    """Update subtitles."""
    data = request.json
    state['subtitles'] = data.get('subtitles', state['subtitles'])
    return jsonify({'status': 'ok'})


@app.route('/api/settings', methods=['POST'])
def update_settings():
    """Update display settings."""
    data = request.json
    state['settings'].update(data.get('settings', {}))
    return jsonify({'status': 'ok'})


@app.route('/api/approve', methods=['POST'])
def approve():
    """Approve and export video with subtitles (old ASS method - kept for fallback)."""
    data = request.json
    state['subtitles'] = data.get('subtitles', state['subtitles'])
    state['settings'].update(data.get('settings', {}))
    state['approved'] = True
    
    # Generate ASS file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.ass', delete=False) as f:
        ass_content = generate_ass_subtitles(state['subtitles'], state['settings'])
        f.write(ass_content)
        ass_path = f.name
    
    # Burn subtitles
    video_path = Path(state['video_path'])
    output_path = video_path.parent / f"{video_path.stem}_subtitled{video_path.suffix}"
    state['output_path'] = str(output_path)
    
    success = burn_subtitles(state['video_path'], ass_path, str(output_path))
    
    # Clean up
    os.unlink(ass_path)
    
    if success:
        return jsonify({'status': 'ok', 'output': str(output_path)})
    else:
        return jsonify({'status': 'error', 'message': 'FFmpeg failed'}), 500


@app.route('/api/composite', methods=['POST'])
def composite_overlay():
    """Composite subtitle overlay video onto original video.
    
    This method uses a WebM with transparency recorded from the browser,
    ensuring the subtitles look EXACTLY like the preview.
    """
    if 'overlay' not in request.files:
        return jsonify({'status': 'error', 'message': 'No overlay file provided'}), 400
    
    overlay_file = request.files['overlay']
    
    # Save overlay to temp file
    with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
        overlay_file.save(f.name)
        overlay_path = f.name
    
    print(f"\n🎬 Compositing subtitle overlay...")
    print(f"   Overlay file: {overlay_path}")
    
    video_path = Path(state['video_path'])
    output_path = video_path.parent / f"{video_path.stem}_subtitled{video_path.suffix}"
    
    # FFmpeg command to overlay WebM with alpha on top of original video
    # The overlay filter composites the subtitle video on top
    cmd = [
        'ffmpeg', '-y',
        '-i', str(video_path),      # Original video
        '-i', overlay_path,          # Subtitle overlay (WebM with alpha)
        '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[out]',
        '-map', '[out]',
        '-map', '0:a?',              # Keep original audio if present
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'copy',
        str(output_path)
    ]
    
    print(f"   Running: {' '.join(cmd)}")
    
    try:
        # Get video duration for progress
        duration = get_video_duration(str(video_path))
        
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        
        # Simple progress monitoring
        start_time = time.time()
        while process.poll() is None:
            time.sleep(1)
            elapsed = time.time() - start_time
            print(f"\r   Compositing... elapsed: {int(elapsed)}s", end='', flush=True)
        
        print()
        
        # Clean up overlay
        os.unlink(overlay_path)
        
        if process.returncode != 0:
            stderr = process.stderr.read().decode('utf-8', errors='ignore')
            print(f"   FFmpeg error: {stderr[-500:]}")  # Last 500 chars
            return jsonify({'status': 'error', 'message': 'FFmpeg compositing failed'}), 500
        
        print(f"   ✅ Output saved to: {output_path}")
        state['output_path'] = str(output_path)
        
        return jsonify({'status': 'ok', 'output': str(output_path)})
        
    except Exception as e:
        # Clean up on error
        if os.path.exists(overlay_path):
            os.unlink(overlay_path)
        print(f"   Error: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/export-srt')
def export_srt():
    """Export subtitles as SRT file (loses word-level timing)."""
    def format_srt_time(seconds):
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = int(seconds % 60)
        ms = int((seconds % 1) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    
    srt_lines = []
    for i, sub in enumerate(state['subtitles'], 1):
        srt_lines.append(str(i))
        srt_lines.append(f"{format_srt_time(sub['start'])} --> {format_srt_time(sub['end'])}")
        srt_lines.append(sub['text'])
        srt_lines.append('')
    
    srt_content = '\n'.join(srt_lines)
    
    # Create temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.srt', delete=False) as f:
        f.write(srt_content)


@app.route('/api/export-json')
def export_json():
    """Export subtitles as JSON with full word-level timing (can be reloaded later)."""
    export_data = {
        'version': 1,
        'video_filename': state['video_filename'],
        'subtitles': state['subtitles'],
        'settings': state['settings'],
    }
    
    json_content = json.dumps(export_data, indent=2)
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        f.write(json_content)
        return send_file(f.name, as_attachment=True,
                        download_name=f"{Path(state['video_filename']).stem}_subtitles.json",
                        mimetype='application/json')
        return send_file(f.name, as_attachment=True, 
                        download_name=f"{Path(state['video_filename']).stem}.srt")


@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Shutdown the server."""
    func = request.environ.get('werkzeug.server.shutdown')
    if func:
        func()
    return 'Server shutting down...'


def load_transcription_json(json_path: str) -> bool:
    """Load a previously saved transcription JSON file."""
    try:
        with open(json_path, 'r') as f:
            data = json.load(f)
        
        if 'subtitles' not in data:
            print(f"   Error: Invalid JSON file (missing 'subtitles')")
            return False
        
        state['subtitles'] = data['subtitles']
        if 'settings' in data:
            state['settings'].update(data['settings'])
        
        # Count words
        total_words = sum(len(sub.get('words', [])) for sub in state['subtitles'])
        print(f"   ✓ Loaded {len(state['subtitles'])} subtitles with {total_words} word timestamps")
        return True
        
    except Exception as e:
        print(f"   Error loading JSON: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Video Subtitle Editor',
        epilog='''
Examples:
  python subtitle_editor.py video.mp4                    # Transcribe and edit
  python subtitle_editor.py video.mp4 --model small     # Use smaller/faster model
  python subtitle_editor.py video.mp4 --load subs.json  # Load previous transcription
        ''',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('video', help='Path to video file')
    parser.add_argument('--model', default='medium', choices=['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3'],
                        help='Whisper model size (default: medium)')
    parser.add_argument('--load', metavar='JSON_FILE', help='Load previous transcription from JSON file (skips transcription)')
    parser.add_argument('--port', type=int, default=5555, help='Port for web server (default: 5555)')
    parser.add_argument('--no-browser', action='store_true', help="Don't open browser automatically")
    
    args = parser.parse_args()
    
    # Validate video file
    video_path = Path(args.video).resolve()
    if not video_path.exists():
        print(f"Error: Video file not found: {video_path}")
        sys.exit(1)
    
    # Check FFmpeg
    if not shutil.which('ffmpeg'):
        print("Error: FFmpeg not found. Please install FFmpeg.")
        sys.exit(1)
    
    state['video_path'] = str(video_path)
    state['video_filename'] = video_path.name
    
    print(f"\n{'='*60}")
    print(f"  Video Subtitle Editor")
    print(f"{'='*60}")
    print(f"\n📹 Video: {video_path.name}")
    
    # Either load existing transcription or transcribe
    if args.load:
        json_path = Path(args.load).resolve()
        if not json_path.exists():
            print(f"Error: JSON file not found: {json_path}")
            sys.exit(1)
        
        print(f"\n📂 Loading transcription from {json_path.name}...")
        if not load_transcription_json(str(json_path)):
            sys.exit(1)
    else:
        # Transcribe
        words = transcribe_video(str(video_path), args.model)
        state['words'] = words
        
        # Group into subtitles
        state['subtitles'] = words_to_subtitles(words)
        print(f"   Created {len(state['subtitles'])} subtitle segments")
        
        # Auto-save JSON
        json_output = video_path.parent / f"{video_path.stem}_subtitles.json"
        with open(json_output, 'w') as f:
            json.dump({
                'version': 1,
                'video_filename': state['video_filename'],
                'subtitles': state['subtitles'],
                'settings': state['settings'],
            }, f, indent=2)
        print(f"\n💾 Auto-saved transcription to: {json_output.name}")
        print(f"   (Use --load {json_output.name} to skip transcription next time)")
    
    # Start server
    url = f"http://localhost:{args.port}"
    print(f"\n🌐 Starting editor at {url}")
    print(f"   Press Ctrl+C to stop\n")
    
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    
    app.run(host='0.0.0.0', port=args.port, debug=False, threaded=True)


if __name__ == '__main__':
    main()

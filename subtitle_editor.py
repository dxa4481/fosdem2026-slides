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
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory

# Check for faster-whisper
try:
    from faster_whisper import WhisperModel
except ImportError:
    print("Error: faster-whisper not installed. Run: pip install faster-whisper")
    sys.exit(1)


# Global state
app = Flask(__name__, template_folder='templates', static_folder='static')
state = {
    'video_path': None,
    'video_filename': None,
    'words': [],  # List of {word, start, end}
    'subtitles': [],  # List of {id, start, end, text, words: [{word, start, end}]}
    'settings': {
        'font_size': 48,
        'position': 'bottom',  # top, middle, bottom
        'font_color': 'white',
        'outline_color': 'black',
        'outline_width': 2,
    },
    'output_path': None,
    'approved': False,
}


def transcribe_video(video_path: str, model_size: str = "medium") -> list:
    """
    Transcribe video using faster-whisper with word-level timestamps.
    Returns list of words with timestamps.
    """
    print(f"\n🎤 Loading Whisper model ({model_size})...")
    
    # Use GPU if available
    device = "cuda"
    compute_type = "float16"
    
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        print(f"   Using GPU (CUDA)")
    except Exception as e:
        print(f"   GPU not available ({e}), falling back to CPU")
        device = "cpu"
        compute_type = "int8"
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
    
    print(f"\n📝 Transcribing {Path(video_path).name}...")
    
    # Transcribe with word timestamps
    segments, info = model.transcribe(
        video_path,
        word_timestamps=True,
        language="en",
    )
    
    print(f"   Detected language: {info.language} (probability: {info.language_probability:.2f})")
    
    words = []
    for segment in segments:
        if segment.words:
            for word in segment.words:
                words.append({
                    'word': word.word.strip(),
                    'start': round(word.start, 3),
                    'end': round(word.end, 3),
                })
    
    print(f"   Found {len(words)} words")
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
    """
    font_size = settings.get('font_size', 48)
    position = settings.get('position', 'bottom')
    font_color = settings.get('font_color', 'white')
    outline_color = settings.get('outline_color', 'black')
    outline_width = settings.get('outline_width', 2)
    
    # ASS uses BGR format for colors
    def hex_to_ass_color(color_name):
        colors = {
            'white': '&H00FFFFFF',
            'yellow': '&H0000FFFF',
            'black': '&H00000000',
            'red': '&H000000FF',
            'green': '&H0000FF00',
            'blue': '&H00FF0000',
        }
        return colors.get(color_name, '&H00FFFFFF')
    
    # Position: 2=bottom center, 5=middle center, 8=top center
    alignment = {'bottom': 2, 'middle': 5, 'top': 8}[position]
    
    # Vertical margin based on position
    margin_v = 50 if position == 'bottom' else (50 if position == 'top' else 0)
    
    primary_color = hex_to_ass_color(font_color)
    outline_color_ass = hex_to_ass_color(outline_color)
    highlight_color = '&H0000FFFF'  # Yellow for highlighted word
    
    ass_content = f"""[Script Info]
Title: Video Subtitles
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,{font_size},{primary_color},&H000000FF,{outline_color_ass},&H80000000,1,0,0,0,100,100,0,0,1,{outline_width},0,{alignment},10,10,{margin_v},1
Style: Highlight,Arial,{font_size},{highlight_color},&H000000FF,{outline_color_ass},&H80000000,1,0,0,0,100,100,0,0,1,{outline_width},0,{alignment},10,10,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    
    def format_time(seconds):
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = seconds % 60
        return f"{h}:{m:02d}:{s:05.2f}"
    
    # Generate events with word-by-word highlighting
    for sub in subtitles:
        words = sub.get('words', [])
        if not words:
            # Simple subtitle without word timing
            start_time = format_time(sub['start'])
            end_time = format_time(sub['end'])
            ass_content += f"Dialogue: 0,{start_time},{end_time},Default,,0,0,0,,{sub['text']}\n"
            continue
        
        # Create karaoke-style word highlighting
        # For each word, we create a dialogue line showing all words
        # with the current word highlighted
        for i, word_info in enumerate(words):
            word_start = word_info['start']
            word_end = word_info['end']
            
            # Build the line with current word highlighted
            parts = []
            for j, w in enumerate(words):
                if j == i:
                    # Highlighted word (yellow)
                    parts.append(r"{\c" + highlight_color[2:] + r"}" + w['word'] + r"{\c" + primary_color[2:] + r"}")
                else:
                    parts.append(w['word'])
            
            text = ' '.join(parts)
            start_time = format_time(word_start)
            end_time = format_time(word_end)
            
            ass_content += f"Dialogue: 0,{start_time},{end_time},Default,,0,0,0,,{text}\n"
    
    return ass_content


def burn_subtitles(video_path: str, ass_path: str, output_path: str) -> bool:
    """
    Burn subtitles into video using FFmpeg.
    """
    print(f"\n🎬 Burning subtitles into video...")
    
    # Escape the ASS path for FFmpeg filter
    ass_escaped = ass_path.replace('\\', '/').replace(':', r'\:').replace("'", r"\'")
    
    cmd = [
        'ffmpeg', '-y',
        '-i', video_path,
        '-vf', f"ass='{ass_escaped}'",
        '-c:a', 'copy',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        output_path
    ]
    
    print(f"   Running: {' '.join(cmd)}")
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"   FFmpeg error: {result.stderr}")
            return False
        print(f"   ✅ Output saved to: {output_path}")
        return True
    except Exception as e:
        print(f"   Error: {e}")
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
    """Approve and export video with subtitles."""
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


@app.route('/api/export-srt')
def export_srt():
    """Export subtitles as SRT file."""
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
        return send_file(f.name, as_attachment=True, 
                        download_name=f"{Path(state['video_filename']).stem}.srt")


@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Shutdown the server."""
    func = request.environ.get('werkzeug.server.shutdown')
    if func:
        func()
    return 'Server shutting down...'


def main():
    parser = argparse.ArgumentParser(description='Video Subtitle Editor')
    parser.add_argument('video', help='Path to video file')
    parser.add_argument('--model', default='medium', choices=['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3'],
                        help='Whisper model size (default: medium)')
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
    
    # Transcribe
    words = transcribe_video(str(video_path), args.model)
    state['words'] = words
    
    # Group into subtitles
    state['subtitles'] = words_to_subtitles(words)
    print(f"   Created {len(state['subtitles'])} subtitle segments")
    
    # Start server
    url = f"http://localhost:{args.port}"
    print(f"\n🌐 Starting editor at {url}")
    print(f"   Press Ctrl+C to stop\n")
    
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    
    app.run(host='0.0.0.0', port=args.port, debug=False, threaded=True)


if __name__ == '__main__':
    main()

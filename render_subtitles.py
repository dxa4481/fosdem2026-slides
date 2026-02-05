#!/usr/bin/env python3
"""
Render subtitles using Puppeteer (headless Chrome).
This captures the EXACT CSS rendering - pixel perfect.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Check for pyppeteer
try:
    import pyppeteer
    from pyppeteer import launch
except ImportError:
    print("Installing pyppeteer...")
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'pyppeteer'], check=True)
    from pyppeteer import launch


async def render_subtitle_frames(
    subtitles: list,
    settings: dict,
    video_width: int,
    video_height: int,
    video_duration: float,
    fps: float,
    output_dir: str,
    start_time: float = 0
):
    """Render subtitle frames using headless Chrome."""
    
    font_size = settings.get('font_size', 42)
    position = settings.get('position', 'bottom')
    highlight_color = settings.get('highlight_color', '#fbbf24')
    text_color = settings.get('text_color', 'white')
    
    # Create HTML template
    html_template = f'''
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            * {{ margin: 0; padding: 0; box-sizing: border-box; }}
            body {{
                width: {video_width}px;
                height: {video_height}px;
                background: transparent;
                overflow: hidden;
            }}
            .subtitle-container {{
                position: absolute;
                left: 0;
                right: 0;
                display: flex;
                justify-content: center;
                padding: 30px 20px;
                {"bottom: 0;" if position == "bottom" else ""}
                {"top: 0;" if position == "top" else ""}
                {"top: 50%; transform: translateY(-50%);" if position == "middle" else ""}
            }}
            .subtitle-text {{
                font-family: Arial, -apple-system, sans-serif;
                font-weight: 700;
                font-size: {font_size}px;
                color: {text_color};
                text-align: center;
                line-height: 1.4;
                padding: 12px 24px;
                background: rgba(0, 0, 0, 0.75);
                border-radius: 8px;
                max-width: 90%;
            }}
            .word {{
                display: inline-block;
                margin: 0 0.12em;
                transition: none;
            }}
            .word.current {{
                color: {highlight_color};
                transform: scale(1.1);
            }}
            .word.spoken {{
                color: {text_color};
            }}
            .word.upcoming {{
                color: {text_color};
                opacity: 0.6;
            }}
        </style>
    </head>
    <body>
        <div class="subtitle-container">
            <div class="subtitle-text" id="subtitle"></div>
        </div>
    </body>
    </html>
    '''
    
    print(f"   Launching headless Chrome...")
    browser = await launch(
        headless=True,
        args=[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            f'--window-size={video_width},{video_height}',
            '--hide-scrollbars',
        ]
    )
    
    page = await browser.newPage()
    await page.setViewport({'width': video_width, 'height': video_height})
    
    # Load the HTML
    await page.setContent(html_template)
    
    total_frames = int(video_duration * fps)
    print(f"   Rendering {total_frames} frames at {fps:.1f} fps...")
    
    last_pct = -1
    
    for frame_num in range(total_frames):
        current_time = start_time + (frame_num / fps)
        
        # Find current subtitle
        current_sub = None
        for sub in subtitles:
            if current_time >= sub['start'] and current_time <= sub['end']:
                current_sub = sub
                break
        
        # Build subtitle HTML
        if current_sub:
            words = current_sub.get('words', [])
            
            if words:
                # Find current word
                current_word_idx = -1
                for i, w in enumerate(words):
                    if current_time >= w['start'] and current_time < w['end']:
                        current_word_idx = i
                        break
                    if current_time >= w['end'] and (i == len(words) - 1 or current_time < words[i + 1]['start']):
                        current_word_idx = i
                        break
                if current_word_idx == -1 and current_time < words[0]['start']:
                    current_word_idx = 0
                
                # Build HTML
                html_parts = []
                for i, w in enumerate(words):
                    if i == current_word_idx:
                        cls = 'word current'
                    elif i < current_word_idx:
                        cls = 'word spoken'
                    else:
                        cls = 'word upcoming'
                    html_parts.append(f'<span class="{cls}">{w["word"]}</span>')
                
                subtitle_html = ' '.join(html_parts)
            else:
                subtitle_html = f'<span class="word current">{current_sub["text"]}</span>'
            
            visibility = 'visible'
        else:
            subtitle_html = ''
            visibility = 'hidden'
        
        # Update the page
        await page.evaluate(f'''
            document.getElementById("subtitle").innerHTML = `{subtitle_html}`;
            document.getElementById("subtitle").style.visibility = "{visibility}";
        ''')
        
        # Screenshot with transparency
        frame_path = os.path.join(output_dir, f'frame_{frame_num:06d}.png')
        await page.screenshot({
            'path': frame_path,
            'omitBackground': True,  # Transparent background!
        })
        
        # Progress
        pct = int((frame_num / total_frames) * 100)
        if pct != last_pct:
            print(f"\r   Rendering frames: {pct}%", end='', flush=True)
            last_pct = pct
    
    print(f"\r   Rendering frames: 100%")
    
    await browser.close()
    return total_frames


def get_video_info(video_path: str) -> dict:
    """Get video dimensions, fps, and duration."""
    cmd = [
        'ffprobe', '-v', 'quiet',
        '-print_format', 'json',
        '-show_format', '-show_streams',
        video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    data = json.loads(result.stdout)
    
    video_stream = next(s for s in data['streams'] if s['codec_type'] == 'video')
    
    width = video_stream['width']
    height = video_stream['height']
    
    # Parse fps
    fps_str = video_stream.get('r_frame_rate', '30/1')
    if '/' in fps_str:
        num, den = map(int, fps_str.split('/'))
        fps = num / den
    else:
        fps = float(fps_str)
    
    duration = float(data['format']['duration'])
    
    return {
        'width': width,
        'height': height,
        'fps': fps,
        'duration': duration
    }


def composite_with_ffmpeg(video_path: str, frames_dir: str, fps: float, output_path: str, start_time: float = 0, duration: float = None):
    """Composite subtitle frames onto video."""
    print(f"   Compositing with FFmpeg...")
    
    frames_pattern = os.path.join(frames_dir, 'frame_%06d.png')
    
    # Build FFmpeg command
    cmd = ['ffmpeg', '-y']
    
    # Input video with seek
    if start_time > 0:
        cmd.extend(['-ss', str(start_time)])
    cmd.extend(['-i', video_path])
    
    # Duration limit
    if duration:
        cmd.extend(['-t', str(duration)])
    
    # PNG sequence input
    cmd.extend(['-framerate', str(fps), '-i', frames_pattern])
    
    # Overlay filter - the PNGs have transparency
    cmd.extend([
        '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[out]',
        '-map', '[out]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-c:a', 'aac',  # Re-encode audio to handle seeking
        '-shortest',
        output_path
    ])
    
    print(f"   Running: ffmpeg (this may take a moment)...")
    
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    _, stderr = process.communicate()
    
    if process.returncode != 0:
        print(f"   FFmpeg error: {stderr.decode()[-1000:]}")
        return False
    
    return True


async def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Render subtitles using headless Chrome')
    parser.add_argument('video', help='Input video file')
    parser.add_argument('subtitles', help='Subtitles JSON file')
    parser.add_argument('-o', '--output', help='Output video file')
    parser.add_argument('--test', action='store_true', help='Quick test: render only 10 seconds starting where subtitles begin')
    parser.add_argument('--start', type=float, default=None, help='Start time in seconds')
    parser.add_argument('--duration', type=float, default=None, help='Duration in seconds')
    
    args = parser.parse_args()
    
    video_path = Path(args.video).resolve()
    json_path = Path(args.subtitles).resolve()
    
    if not video_path.exists():
        print(f"Error: Video not found: {video_path}")
        sys.exit(1)
    
    if not json_path.exists():
        print(f"Error: JSON not found: {json_path}")
        sys.exit(1)
    
    # Load subtitles
    with open(json_path) as f:
        data = json.load(f)
    
    subtitles = data['subtitles']
    settings = data.get('settings', {})
    
    # Get video info
    info = get_video_info(str(video_path))
    
    # Determine render range
    if args.test:
        # Find first subtitle and start there
        first_sub_time = subtitles[0]['start'] if subtitles else 0
        start_time = max(0, first_sub_time - 1)  # 1 second before first subtitle
        duration = 10  # 10 seconds
        output_path = args.output or str(video_path.parent / f"{video_path.stem}_TEST.mp4")
        print(f"\n🧪 TEST MODE: Rendering only {duration}s starting at {start_time:.1f}s")
    else:
        start_time = args.start or 0
        duration = args.duration or (info['duration'] - start_time)
        output_path = args.output or str(video_path.parent / f"{video_path.stem}_subtitled.mp4")
    
    print(f"\n{'='*60}")
    print(f"  Puppeteer Subtitle Renderer")
    print(f"{'='*60}")
    print(f"\n📹 Video: {video_path.name}")
    print(f"📝 Subtitles: {len(subtitles)} segments")
    print(f"   Resolution: {info['width']}x{info['height']}")
    print(f"   FPS: {info['fps']:.2f}")
    print(f"   Render range: {start_time:.1f}s - {start_time + duration:.1f}s ({duration:.1f}s)")
    
    # Create temp directory for frames
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"\n🎨 Rendering subtitle frames with Chrome...")
        
        frame_count = await render_subtitle_frames(
            subtitles=subtitles,
            settings=settings,
            video_width=info['width'],
            video_height=info['height'],
            video_duration=duration,
            fps=info['fps'],
            output_dir=temp_dir,
            start_time=start_time
        )
        
        print(f"\n🎬 Compositing {frame_count} frames...")
        success = composite_with_ffmpeg(
            str(video_path),
            temp_dir,
            info['fps'],
            output_path,
            start_time=start_time,
            duration=duration
        )
        
        if success:
            print(f"\n✅ Output saved to: {output_path}")
            if args.test:
                print(f"\n👀 Check the test video! If it looks good, run without --test for full render.")
        else:
            print(f"\n❌ Failed to composite video")
            sys.exit(1)


if __name__ == '__main__':
    asyncio.get_event_loop().run_until_complete(main())

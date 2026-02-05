#!/usr/bin/env python3
"""
Simple, reliable subtitle burner using PIL/Pillow.
No browsers, no complex pipelines. Just works.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def get_font(size: int) -> ImageFont.FreeTypeFont:
    """Get a bold font at the specified size."""
    # Try common font paths
    font_paths = [
        # macOS
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/System/Library/Fonts/SFNS.ttf',
        '/Library/Fonts/Arial Bold.ttf',
        # Linux
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
        # Windows
        'C:/Windows/Fonts/arialbd.ttf',
        'C:/Windows/Fonts/arial.ttf',
    ]
    
    for path in font_paths:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    
    # Fallback - try to find any TTF
    try:
        return ImageFont.truetype("Arial", size)
    except:
        print("   Warning: Using default font (may look different)")
        return ImageFont.load_default()


def hex_to_rgb(hex_color: str) -> tuple:
    """Convert hex color to RGB tuple."""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    return (255, 255, 255)


def draw_rounded_rect(draw, xy, radius, fill):
    """Draw a rounded rectangle."""
    x1, y1, x2, y2 = xy
    diameter = radius * 2
    
    # Draw rectangles
    draw.rectangle([x1 + radius, y1, x2 - radius, y2], fill=fill)
    draw.rectangle([x1, y1 + radius, x2, y2 - radius], fill=fill)
    
    # Draw corners
    draw.ellipse([x1, y1, x1 + diameter, y1 + diameter], fill=fill)
    draw.ellipse([x2 - diameter, y1, x2, y1 + diameter], fill=fill)
    draw.ellipse([x1, y2 - diameter, x1 + diameter, y2], fill=fill)
    draw.ellipse([x2 - diameter, y2 - diameter, x2, y2], fill=fill)


def render_subtitle_image(
    width: int,
    height: int,
    text: str,
    words: list,
    current_time: float,
    settings: dict
) -> Image.Image:
    """Render a subtitle frame."""
    
    font_size = settings.get('font_size', 48)
    position = settings.get('position', 'bottom')
    text_color = settings.get('text_color', 'white')
    highlight_color = settings.get('highlight_color', '#fbbf24')
    
    # Convert colors
    if text_color == 'white':
        text_rgb = (255, 255, 255)
    elif text_color.startswith('#'):
        text_rgb = hex_to_rgb(text_color)
    else:
        text_rgb = (255, 255, 255)
    
    highlight_rgb = hex_to_rgb(highlight_color)
    dim_rgb = tuple(int(c * 0.5) for c in text_rgb)  # 50% brightness for upcoming
    
    # Create transparent image
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    font = get_font(font_size)
    
    # Find current word index
    current_word_idx = -1
    if words:
        for i, w in enumerate(words):
            if current_time >= w['start'] and current_time <= w['end']:
                current_word_idx = i
                break
            # Between words - highlight the one we just passed
            if i < len(words) - 1:
                if current_time > w['end'] and current_time < words[i + 1]['start']:
                    current_word_idx = i
                    break
        # After last word
        if current_word_idx == -1 and words and current_time > words[-1]['end']:
            current_word_idx = len(words) - 1
        # Before first word
        if current_word_idx == -1 and words and current_time < words[0]['start']:
            current_word_idx = 0
    
    # Build word list with styles
    if words:
        word_list = []
        for i, w in enumerate(words):
            if i == current_word_idx:
                word_list.append((w['word'], highlight_rgb, True))  # highlighted
            elif i < current_word_idx:
                word_list.append((w['word'], text_rgb, False))  # spoken
            else:
                word_list.append((w['word'], dim_rgb, False))  # upcoming
    else:
        word_list = [(text, highlight_rgb, True)]
    
    # Measure text
    space_width = draw.textlength(' ', font=font)
    word_widths = []
    total_width = 0
    
    for word, _, _ in word_list:
        w = draw.textlength(word, font=font)
        word_widths.append(w)
        total_width += w
    total_width += space_width * (len(word_list) - 1)  # spaces between words
    
    # Box dimensions
    padding_x = 24
    padding_y = 16
    box_width = total_width + padding_x * 2
    box_height = font_size + padding_y * 2
    
    # Position
    center_x = width // 2
    if position == 'bottom':
        center_y = height - 80
    elif position == 'top':
        center_y = 80
    else:
        center_y = height // 2
    
    box_x1 = center_x - box_width // 2
    box_y1 = center_y - box_height // 2
    box_x2 = box_x1 + box_width
    box_y2 = box_y1 + box_height
    
    # Draw background box
    draw_rounded_rect(draw, (box_x1, box_y1, box_x2, box_y2), radius=8, fill=(0, 0, 0, 200))
    
    # Draw words
    x = center_x - total_width // 2
    y = center_y - font_size // 2
    
    for i, (word, color, is_highlight) in enumerate(word_list):
        # Draw text
        draw.text((x, y), word, font=font, fill=color + (255,))
        x += word_widths[i] + space_width
    
    return img


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
    
    video_stream = next((s for s in data['streams'] if s['codec_type'] == 'video'), None)
    if not video_stream:
        raise ValueError("No video stream found")
    
    width = video_stream['width']
    height = video_stream['height']
    
    # Parse fps
    fps_str = video_stream.get('r_frame_rate', '30/1')
    if '/' in fps_str:
        num, den = fps_str.split('/')
        fps = float(num) / float(den) if float(den) != 0 else 30
    else:
        fps = float(fps_str)
    
    duration = float(data['format'].get('duration', 0))
    
    return {'width': width, 'height': height, 'fps': fps, 'duration': duration}


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Burn subtitles into video')
    parser.add_argument('video', help='Input video file')
    parser.add_argument('subtitles', help='Subtitles JSON file')
    parser.add_argument('-o', '--output', help='Output video file')
    parser.add_argument('--test', action='store_true', help='Quick test: 10 seconds only')
    parser.add_argument('--start', type=float, help='Start time in seconds')
    parser.add_argument('--duration', type=float, help='Duration in seconds')
    
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
        first_sub = subtitles[0]['start'] if subtitles else 0
        start_time = max(0, first_sub - 0.5)
        duration = 10
        output_path = args.output or str(video_path.parent / f"{video_path.stem}_TEST.mp4")
    else:
        start_time = args.start or 0
        duration = args.duration or info['duration']
        output_path = args.output or str(video_path.parent / f"{video_path.stem}_subtitled.mp4")
    
    fps = info['fps']
    width = info['width']
    height = info['height']
    
    print(f"\n{'='*60}")
    print(f"  Subtitle Burner (PIL/Pillow)")
    print(f"{'='*60}")
    print(f"\n📹 Video: {video_path.name}")
    print(f"   Resolution: {width}x{height} @ {fps:.1f}fps")
    print(f"📝 Subtitles: {len(subtitles)} segments")
    print(f"⏱️  Range: {start_time:.1f}s - {start_time + duration:.1f}s")
    
    if args.test:
        print(f"\n🧪 TEST MODE - Only rendering 10 seconds")
    
    # Create temp directory
    with tempfile.TemporaryDirectory() as temp_dir:
        total_frames = int(duration * fps)
        print(f"\n🎨 Rendering {total_frames} subtitle frames...")
        
        for frame_num in range(total_frames):
            current_time = start_time + (frame_num / fps)
            
            # Find current subtitle
            current_sub = None
            for sub in subtitles:
                if current_time >= sub['start'] and current_time <= sub['end']:
                    current_sub = sub
                    break
            
            # Render frame
            if current_sub:
                img = render_subtitle_image(
                    width, height,
                    current_sub['text'],
                    current_sub.get('words', []),
                    current_time,
                    settings
                )
            else:
                # Transparent frame
                img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
            
            # Save frame
            frame_path = os.path.join(temp_dir, f'frame_{frame_num:06d}.png')
            img.save(frame_path, 'PNG')
            
            # Progress
            if frame_num % 30 == 0 or frame_num == total_frames - 1:
                pct = (frame_num + 1) / total_frames * 100
                print(f"\r   Progress: {pct:.0f}% ({frame_num + 1}/{total_frames})", end='', flush=True)
        
        print(f"\r   Progress: 100% ({total_frames}/{total_frames})")
        
        # Composite with FFmpeg
        print(f"\n🎬 Compositing with FFmpeg (showing live output)...\n")
        
        frames_pattern = os.path.join(temp_dir, 'frame_%06d.png')
        
        cmd = ['ffmpeg', '-y']
        
        # Seek in input video
        if start_time > 0:
            cmd.extend(['-ss', str(start_time)])
        
        cmd.extend(['-i', str(video_path)])
        cmd.extend(['-t', str(duration)])
        
        # PNG sequence
        cmd.extend(['-framerate', str(fps), '-i', frames_pattern])
        
        # Overlay
        cmd.extend([
            '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[out]',
            '-map', '[out]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'aac',
            '-shortest',
            output_path
        ])
        
        print(f"   Command: {' '.join(cmd[:6])} ... {output_path}\n")
        
        # Run FFmpeg with live output
        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, universal_newlines=True)
        
        # Stream stderr (where FFmpeg shows progress)
        for line in process.stderr:
            print(f"   {line}", end='')
        
        process.wait()
        
        if process.returncode != 0:
            print(f"\n❌ FFmpeg failed with code {process.returncode}")
            sys.exit(1)
        
        print(f"\n✅ Output saved to: {output_path}")
        
        if args.test:
            print(f"\n👀 Check the test video!")
            print(f"   If it looks good, run without --test for full video.")


if __name__ == '__main__':
    main()

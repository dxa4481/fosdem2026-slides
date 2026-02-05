#!/usr/bin/env python3
"""
Server-side subtitle renderer using Pillow.
Generates a video overlay with pixel-perfect subtitles.
"""

import subprocess
import tempfile
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json


def get_font(size: int, bold: bool = True):
    """Get a font, falling back to default if Arial not available."""
    font_names = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',  # macOS
        '/System/Library/Fonts/Helvetica.ttc',  # macOS fallback
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',  # Linux
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',  # Linux alt
        'C:\\Windows\\Fonts\\arialbd.ttf',  # Windows
    ]
    
    for font_path in font_names:
        if os.path.exists(font_path):
            try:
                return ImageFont.truetype(font_path, size)
            except:
                pass
    
    # Fallback to default
    return ImageFont.load_default()


def hex_to_rgb(hex_color: str) -> tuple:
    """Convert hex color to RGB tuple."""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def render_subtitle_frame(
    width: int,
    height: int,
    subtitle: dict,
    current_time: float,
    settings: dict
) -> Image.Image:
    """Render a single subtitle frame with word highlighting."""
    
    # Create transparent image
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    font_size = settings.get('font_size', 42)
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
    dim_rgb = (int(text_rgb[0] * 0.6), int(text_rgb[1] * 0.6), int(text_rgb[2] * 0.6))
    
    font = get_font(font_size)
    
    words = subtitle.get('words', [])
    
    # Find current word
    current_word_idx = -1
    if words:
        for i, w in enumerate(words):
            if current_time >= w['start'] and current_time < w['end']:
                current_word_idx = i
                break
            if current_time >= w['end'] and (i == len(words) - 1 or current_time < words[i + 1]['start']):
                current_word_idx = i
                break
        if current_word_idx == -1 and current_time < words[0]['start']:
            current_word_idx = 0
    
    # Build text and calculate positions
    if words:
        text_parts = [(w['word'], i) for i, w in enumerate(words)]
    else:
        text_parts = [(subtitle['text'], -1)]
    
    # Calculate total width
    space_width = draw.textlength(' ', font=font)
    total_width = 0
    part_widths = []
    for word, _ in text_parts:
        w = draw.textlength(word, font=font)
        part_widths.append(w)
        total_width += w + space_width
    total_width -= space_width  # Remove last space
    
    # Add padding for background box
    padding = 16
    box_width = total_width + padding * 2
    box_height = font_size + padding * 2
    
    # Position
    x_center = width // 2
    if position == 'bottom':
        y_center = height - 80
    elif position == 'top':
        y_center = 80
    else:
        y_center = height // 2
    
    box_x = x_center - box_width // 2
    box_y = y_center - box_height // 2
    
    # Draw background box with rounded corners
    box_color = (0, 0, 0, 180)  # Semi-transparent black
    
    # Simple rectangle (PIL doesn't have easy rounded rect)
    draw.rectangle(
        [box_x, box_y, box_x + box_width, box_y + box_height],
        fill=box_color
    )
    
    # Draw words
    x = x_center - total_width // 2
    y = y_center - font_size // 2
    
    for i, (word, word_idx) in enumerate(text_parts):
        # Determine color and style
        if word_idx == current_word_idx:
            color = highlight_rgb + (255,)
        elif word_idx != -1 and word_idx < current_word_idx:
            color = text_rgb + (255,)
        elif word_idx != -1 and word_idx > current_word_idx:
            color = dim_rgb + (255,)
        else:
            color = text_rgb + (255,)
        
        draw.text((x, y), word, font=font, fill=color)
        x += part_widths[i] + space_width
    
    return img


def render_subtitles_to_video(
    video_path: str,
    subtitles: list,
    settings: dict,
    output_path: str,
    fps: float = 30
) -> bool:
    """Render subtitles directly onto video using FFmpeg."""
    
    print(f"\n🎨 Rendering subtitles with Pillow...")
    
    # Get video info
    probe_cmd = [
        'ffprobe', '-v', 'quiet',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration',
        '-of', 'json',
        video_path
    ]
    result = subprocess.run(probe_cmd, capture_output=True, text=True)
    video_info = json.loads(result.stdout)
    stream = video_info['streams'][0]
    
    width = stream['width']
    height = stream['height']
    
    # Parse frame rate
    fps_parts = stream.get('r_frame_rate', '30/1').split('/')
    fps = float(fps_parts[0]) / float(fps_parts[1]) if len(fps_parts) == 2 else 30
    
    # Get duration
    duration_cmd = [
        'ffprobe', '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        video_path
    ]
    result = subprocess.run(duration_cmd, capture_output=True, text=True)
    duration = float(result.stdout.strip())
    
    print(f"   Video: {width}x{height} @ {fps:.2f}fps, {duration:.1f}s")
    print(f"   Subtitles: {len(subtitles)} segments")
    
    # Create temp directory for frames
    with tempfile.TemporaryDirectory() as temp_dir:
        print(f"   Generating subtitle frames...")
        
        frame_num = 0
        total_frames = int(duration * fps)
        last_pct = -1
        
        for frame_num in range(total_frames):
            current_time = frame_num / fps
            
            # Find current subtitle
            current_sub = None
            for sub in subtitles:
                if current_time >= sub['start'] and current_time <= sub['end']:
                    current_sub = sub
                    break
            
            # Render frame
            if current_sub:
                img = render_subtitle_frame(width, height, current_sub, current_time, settings)
            else:
                # Transparent frame
                img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
            
            # Save frame
            frame_path = os.path.join(temp_dir, f'frame_{frame_num:06d}.png')
            img.save(frame_path, 'PNG')
            
            # Progress
            pct = int((frame_num / total_frames) * 100)
            if pct != last_pct:
                print(f"\r   Generating frames: {pct}%", end='', flush=True)
                last_pct = pct
        
        print(f"\r   Generating frames: 100%")
        print(f"   Generated {total_frames} frames")
        
        # FFmpeg: combine original video with subtitle overlay frames
        print(f"   Compositing with FFmpeg...")
        
        frames_pattern = os.path.join(temp_dir, 'frame_%06d.png')
        
        cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-framerate', str(fps),
            '-i', frames_pattern,
            '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[out]',
            '-map', '[out]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'copy',
            '-shortest',
            output_path
        ]
        
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        
        while process.poll() is None:
            pass
        
        if process.returncode != 0:
            stderr = process.stderr.read().decode('utf-8', errors='ignore')
            print(f"   FFmpeg error: {stderr[-500:]}")
            return False
        
        print(f"   ✅ Output saved to: {output_path}")
        return True


if __name__ == '__main__':
    # Test
    import sys
    if len(sys.argv) < 3:
        print("Usage: python subtitle_renderer.py video.mp4 subtitles.json")
        sys.exit(1)
    
    video_path = sys.argv[1]
    json_path = sys.argv[2]
    
    with open(json_path) as f:
        data = json.load(f)
    
    output_path = video_path.rsplit('.', 1)[0] + '_subtitled.mp4'
    
    render_subtitles_to_video(
        video_path,
        data['subtitles'],
        data.get('settings', {}),
        output_path
    )

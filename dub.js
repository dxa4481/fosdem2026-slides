/**
 * Video Subtitle Editor
 * 
 * Features:
 * - Video upload and playback
 * - Automatic transcription using Whisper via transformers.js
 * - Manual subtitle editing
 * - SRT import/export
 * - FFmpeg-based video export with burned-in subtitles (presenter mode style)
 */

// ============================================================================
// STATE
// ============================================================================

const State = {
  videoFile: null,
  videoUrl: null,
  subtitles: [], // Array of {id, start, end, text}
  transcriber: null,
  isModelLoaded: false,
  isModelLoading: false,
  ffmpeg: null,
  ffmpegLoaded: false,
  currentSubtitleIndex: -1,
  nextSubtitleId: 1,
  isManualPreview: false
};

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const DOM = {
  uploadArea: null,
  videoInput: null,
  videoContainer: null,
  videoPlayer: null,
  videoControls: null,
  subtitleOverlay: null,
  subtitleText: null,
  generateBtn: null,
  clearVideoBtn: null,
  subtitleList: null,
  emptyState: null,
  exportSection: null,
  exportBtn: null,
  addSubtitleBtn: null,
  importSrtBtn: null,
  exportSrtBtn: null,
  srtInput: null,
  statusBar: null,
  statusText: null,
  progressFill: null,
  fontSizeSelect: null,
  loadingModal: null,
  loadingTitle: null,
  loadingMessage: null,
  loadingProgressFill: null,
  loadingPercent: null,
  editIndicator: null
};

// ============================================================================
// INITIALIZATION
// ============================================================================

function initDOM() {
  DOM.uploadArea = document.getElementById('upload-area');
  DOM.videoInput = document.getElementById('video-input');
  DOM.videoContainer = document.getElementById('video-container');
  DOM.videoPlayer = document.getElementById('video-player');
  DOM.videoControls = document.getElementById('video-controls');
  DOM.subtitleOverlay = document.getElementById('subtitle-overlay');
  DOM.subtitleText = document.getElementById('subtitle-text');
  DOM.generateBtn = document.getElementById('generate-btn');
  DOM.clearVideoBtn = document.getElementById('clear-video-btn');
  DOM.subtitleList = document.getElementById('subtitle-list');
  DOM.emptyState = document.getElementById('empty-state');
  DOM.exportSection = document.getElementById('export-section');
  DOM.exportBtn = document.getElementById('export-btn');
  DOM.addSubtitleBtn = document.getElementById('add-subtitle-btn');
  DOM.importSrtBtn = document.getElementById('import-srt-btn');
  DOM.exportSrtBtn = document.getElementById('export-srt-btn');
  DOM.srtInput = document.getElementById('srt-input');
  DOM.statusBar = document.getElementById('status-bar');
  DOM.statusText = document.getElementById('status-text');
  DOM.progressFill = document.getElementById('progress-fill');
  DOM.fontSizeSelect = document.getElementById('font-size-select');
  DOM.loadingModal = document.getElementById('loading-modal');
  DOM.loadingTitle = document.getElementById('loading-title');
  DOM.loadingMessage = document.getElementById('loading-message');
  DOM.loadingProgressFill = document.getElementById('loading-progress-fill');
  DOM.loadingPercent = document.getElementById('loading-percent');
  DOM.editIndicator = document.getElementById('edit-indicator');
}

function initEventListeners() {
  // Upload area
  DOM.uploadArea.addEventListener('click', () => DOM.videoInput.click());
  DOM.videoInput.addEventListener('change', handleVideoSelect);
  
  // Drag and drop
  DOM.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    DOM.uploadArea.classList.add('drag-over');
  });
  DOM.uploadArea.addEventListener('dragleave', () => {
    DOM.uploadArea.classList.remove('drag-over');
  });
  DOM.uploadArea.addEventListener('drop', handleVideoDrop);
  
  // Video controls
  DOM.generateBtn.addEventListener('click', generateSubtitles);
  DOM.clearVideoBtn.addEventListener('click', clearVideo);
  
  // Video playback - update subtitle display
  DOM.videoPlayer.addEventListener('timeupdate', updateSubtitleDisplay);
  
  // Subtitle editor buttons
  DOM.addSubtitleBtn.addEventListener('click', addManualSubtitle);
  DOM.importSrtBtn.addEventListener('click', () => DOM.srtInput.click());
  DOM.exportSrtBtn.addEventListener('click', exportSRT);
  DOM.srtInput.addEventListener('change', importSRT);
  
  // Export
  DOM.exportBtn.addEventListener('click', exportVideo);
}

function init() {
  initDOM();
  initEventListeners();
  console.log('[SubtitleEditor] Initialized');
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ============================================================================
// VIDEO HANDLING
// ============================================================================

function handleVideoSelect(e) {
  const file = e.target.files[0];
  if (file) loadVideo(file);
}

function handleVideoDrop(e) {
  e.preventDefault();
  DOM.uploadArea.classList.remove('drag-over');
  
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('video/')) {
    loadVideo(file);
  }
}

function loadVideo(file) {
  State.videoFile = file;
  
  // Revoke previous URL if exists
  if (State.videoUrl) {
    URL.revokeObjectURL(State.videoUrl);
  }
  
  State.videoUrl = URL.createObjectURL(file);
  DOM.videoPlayer.src = State.videoUrl;
  
  // Show video, hide upload area
  DOM.uploadArea.style.display = 'none';
  DOM.videoContainer.style.display = 'flex';
  DOM.videoControls.style.display = 'flex';
  
  console.log('[SubtitleEditor] Video loaded:', file.name);
}

function clearVideo() {
  // Revoke URL
  if (State.videoUrl) {
    URL.revokeObjectURL(State.videoUrl);
    State.videoUrl = null;
  }
  
  State.videoFile = null;
  State.subtitles = [];
  State.currentSubtitleIndex = -1;
  
  DOM.videoPlayer.src = '';
  DOM.uploadArea.style.display = 'block';
  DOM.videoContainer.style.display = 'none';
  DOM.videoControls.style.display = 'none';
  DOM.exportSection.style.display = 'none';
  DOM.subtitleText.textContent = '';
  
  renderSubtitleList();
  
  console.log('[SubtitleEditor] Video cleared');
}

// ============================================================================
// TRANSCRIPTION (WHISPER)
// ============================================================================

async function loadTransformers() {
  const module = await import('./lib/transformers/transformers.min.js');
  module.env.backends.onnx.wasm.wasmPaths = './lib/transformers/';
  module.env.allowLocalModels = false;
  return module;
}

async function initWhisper(progressCallback) {
  if (State.isModelLoaded) return true;
  if (State.isModelLoading) return false;
  
  State.isModelLoading = true;
  
  try {
    const { pipeline } = await loadTransformers();
    
    // Check for WebGPU
    let device = 'wasm';
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          device = 'webgpu';
          console.log('[SubtitleEditor] Using WebGPU');
        }
      } catch (e) {
        console.warn('[SubtitleEditor] WebGPU not available:', e);
      }
    }
    
    const modelName = 'Xenova/whisper-small.en';
    console.log(`[SubtitleEditor] Loading ${modelName}...`);
    
    State.transcriber = await pipeline(
      'automatic-speech-recognition',
      modelName,
      {
        device: device,
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        progress_callback: (progress) => {
          if (progress.status === 'progress' && progress.progress) {
            if (progressCallback) progressCallback(progress.progress, 'Loading Whisper model...');
          }
        }
      }
    );
    
    State.isModelLoaded = true;
    State.isModelLoading = false;
    console.log('[SubtitleEditor] Whisper model loaded');
    return true;
  } catch (error) {
    console.error('[SubtitleEditor] Failed to load Whisper:', error);
    State.isModelLoading = false;
    throw error;
  }
}

async function extractAudioFromVideo(videoFile, progressCallback) {
  // Initialize FFmpeg if needed
  if (!State.ffmpegLoaded) {
    await initFFmpeg(progressCallback);
  }
  
  const ffmpeg = State.ffmpeg;
  
  // Write video to FFmpeg
  const videoData = new Uint8Array(await videoFile.arrayBuffer());
  await ffmpeg.writeFile('input.mp4', videoData);
  
  if (progressCallback) progressCallback(30, 'Extracting audio...');
  
  // Extract audio as WAV (16kHz mono for Whisper)
  await ffmpeg.exec([
    '-i', 'input.mp4',
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    'audio.wav'
  ]);
  
  // Read the audio file
  const audioData = await ffmpeg.readFile('audio.wav');
  
  // Clean up
  await ffmpeg.deleteFile('input.mp4');
  await ffmpeg.deleteFile('audio.wav');
  
  if (progressCallback) progressCallback(40, 'Audio extracted');
  
  return audioData;
}

async function transcribeAudio(audioData, progressCallback) {
  // Convert WAV to Float32Array
  // WAV header is 44 bytes, then 16-bit samples
  const samples = new Int16Array(audioData.buffer, 44);
  const float32Samples = new Float32Array(samples.length);
  
  for (let i = 0; i < samples.length; i++) {
    float32Samples[i] = samples[i] / 32768.0;
  }
  
  if (progressCallback) progressCallback(50, 'Transcribing audio...');
  
  // Transcribe with word-level timestamps
  const result = await State.transcriber(float32Samples, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5
  });
  
  if (progressCallback) progressCallback(90, 'Processing results...');
  
  return result;
}

function processTranscriptionToSubtitles(result) {
  const subtitles = [];
  let currentSubtitle = null;
  const maxWordsPerSubtitle = 8;
  const maxDuration = 4; // seconds
  
  if (!result.chunks || result.chunks.length === 0) {
    // Fallback: if no word-level timestamps, create one subtitle for the whole text
    if (result.text) {
      subtitles.push({
        id: State.nextSubtitleId++,
        start: 0,
        end: DOM.videoPlayer.duration || 10,
        text: result.text.trim()
      });
    }
    return subtitles;
  }
  
  for (const chunk of result.chunks) {
    const word = chunk.text.trim();
    if (!word) continue;
    
    const startTime = chunk.timestamp[0];
    const endTime = chunk.timestamp[1] || startTime + 0.5;
    
    if (!currentSubtitle) {
      // Start new subtitle
      currentSubtitle = {
        id: State.nextSubtitleId++,
        start: startTime,
        end: endTime,
        text: word,
        wordCount: 1
      };
    } else {
      // Check if we should continue or start new subtitle
      const wouldBeTooLong = currentSubtitle.wordCount >= maxWordsPerSubtitle;
      const wouldBeTooLongDuration = (endTime - currentSubtitle.start) > maxDuration;
      const hasGap = (startTime - currentSubtitle.end) > 0.5;
      
      if (wouldBeTooLong || wouldBeTooLongDuration || hasGap) {
        // Save current and start new
        subtitles.push({
          id: currentSubtitle.id,
          start: currentSubtitle.start,
          end: currentSubtitle.end,
          text: currentSubtitle.text
        });
        
        currentSubtitle = {
          id: State.nextSubtitleId++,
          start: startTime,
          end: endTime,
          text: word,
          wordCount: 1
        };
      } else {
        // Add to current subtitle
        currentSubtitle.text += ' ' + word;
        currentSubtitle.end = endTime;
        currentSubtitle.wordCount++;
      }
    }
  }
  
  // Don't forget the last subtitle
  if (currentSubtitle) {
    subtitles.push({
      id: currentSubtitle.id,
      start: currentSubtitle.start,
      end: currentSubtitle.end,
      text: currentSubtitle.text
    });
  }
  
  return subtitles;
}

async function generateSubtitles() {
  if (!State.videoFile) return;
  
  DOM.generateBtn.disabled = true;
  showLoading('Generating Subtitles', 'Initializing...');
  
  try {
    // Load Whisper model
    updateLoading(10, 'Loading AI model...');
    await initWhisper((progress, message) => {
      updateLoading(10 + progress * 0.2, message);
    });
    
    // Extract audio from video
    updateLoading(30, 'Extracting audio from video...');
    const audioData = await extractAudioFromVideo(State.videoFile, updateLoading);
    
    // Transcribe
    updateLoading(50, 'Transcribing with AI...');
    const result = await transcribeAudio(audioData, updateLoading);
    
    // Process into subtitles
    updateLoading(90, 'Processing subtitles...');
    State.subtitles = processTranscriptionToSubtitles(result);
    
    // Update UI
    renderSubtitleList();
    DOM.exportSection.style.display = 'block';
    
    updateLoading(100, 'Done!');
    setTimeout(hideLoading, 500);
    
    console.log('[SubtitleEditor] Generated', State.subtitles.length, 'subtitles');
  } catch (error) {
    console.error('[SubtitleEditor] Transcription failed:', error);
    hideLoading();
    alert('Failed to generate subtitles: ' + error.message);
  } finally {
    DOM.generateBtn.disabled = false;
  }
}

// ============================================================================
// SUBTITLE DISPLAY & EDITING
// ============================================================================

function updateSubtitleDisplay() {
  const currentTime = DOM.videoPlayer.currentTime;
  
  // Find active subtitle
  let activeSubtitle = null;
  let activeIndex = -1;
  
  for (let i = 0; i < State.subtitles.length; i++) {
    const sub = State.subtitles[i];
    if (currentTime >= sub.start && currentTime <= sub.end) {
      activeSubtitle = sub;
      activeIndex = i;
      break;
    }
  }
  
  // Update display
  if (activeSubtitle) {
    // Calculate progress through the subtitle for word highlighting
    const subtitleDuration = activeSubtitle.end - activeSubtitle.start;
    const timeIntoSubtitle = currentTime - activeSubtitle.start;
    const progress = Math.min(1, timeIntoSubtitle / subtitleDuration);
    
    displaySubtitle(activeSubtitle.text, progress);
    
    // Highlight active subtitle in list
    if (activeIndex !== State.currentSubtitleIndex) {
      State.currentSubtitleIndex = activeIndex;
      highlightActiveSubtitle(activeSubtitle.id);
    }
  } else {
    clearSubtitleDisplay();
    if (State.currentSubtitleIndex !== -1) {
      State.currentSubtitleIndex = -1;
      highlightActiveSubtitle(null);
    }
  }
}

function displaySubtitle(text, highlightProgress = 1, isManualPreview = false) {
  // Create word spans with highlighting effect - matching presenter mode exactly
  const words = text.split(' ').filter(w => w.length > 0);
  const highlightedWordIndex = Math.floor(words.length * highlightProgress);
  
  const wordSpans = words.map((word, index) => {
    let className = 'word';
    if (index < highlightedWordIndex) {
      className += ' spoken';
    } else if (index === highlightedWordIndex) {
      className += ' current';
    } else {
      className += ' upcoming';
    }
    return `<span class="${className}">${escapeHtml(word)}</span>`;
  }).join(' ');
  
  DOM.subtitleText.innerHTML = wordSpans;
  DOM.subtitleText.classList.add('has-highlight');
  
  // Show edit indicator for manual previews
  if (isManualPreview && DOM.editIndicator) {
    DOM.editIndicator.style.display = 'inline-block';
    State.isManualPreview = true;
  }
}

function clearSubtitleDisplay() {
  DOM.subtitleText.innerHTML = '';
  DOM.subtitleText.classList.remove('has-highlight');
  if (DOM.editIndicator) {
    DOM.editIndicator.style.display = 'none';
  }
  State.isManualPreview = false;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function highlightActiveSubtitle(id) {
  const items = DOM.subtitleList.querySelectorAll('.subtitle-item');
  items.forEach(item => {
    if (item.dataset.id == id) {
      item.classList.add('active');
      // Scroll into view if needed
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      item.classList.remove('active');
    }
  });
}

function renderSubtitleList() {
  DOM.subtitleList.innerHTML = '';
  
  if (State.subtitles.length === 0) {
    DOM.subtitleList.appendChild(DOM.emptyState.cloneNode(true));
    DOM.exportSection.style.display = 'none';
    return;
  }
  
  DOM.emptyState.style.display = 'none';
  DOM.exportSection.style.display = 'block';
  
  State.subtitles.forEach((subtitle, index) => {
    const item = createSubtitleItem(subtitle, index);
    DOM.subtitleList.appendChild(item);
  });
}

function createSubtitleItem(subtitle, index) {
  const item = document.createElement('div');
  item.className = 'subtitle-item';
  item.dataset.id = subtitle.id;
  
  item.innerHTML = `
    <div class="subtitle-item-header">
      <span class="subtitle-index">${index + 1}</span>
      <div class="subtitle-time-inputs">
        <input type="text" class="start-time" value="${formatTime(subtitle.start)}" placeholder="0:00.000" />
        <span>→</span>
        <input type="text" class="end-time" value="${formatTime(subtitle.end)}" placeholder="0:00.000" />
      </div>
      <button class="subtitle-delete-btn" title="Delete">🗑️</button>
    </div>
    <textarea class="subtitle-text-input">${escapeHtml(subtitle.text)}</textarea>
    <div class="subtitle-item-actions">
      <button class="subtitle-action-btn preview-btn">👁️ Preview</button>
      <button class="subtitle-action-btn go-to-btn">▶ Play from here</button>
      <button class="subtitle-action-btn split-btn">✂️ Split</button>
    </div>
  `;
  
  // Event listeners
  const startInput = item.querySelector('.start-time');
  const endInput = item.querySelector('.end-time');
  const textInput = item.querySelector('.subtitle-text-input');
  const deleteBtn = item.querySelector('.subtitle-delete-btn');
  const previewBtn = item.querySelector('.preview-btn');
  const goToBtn = item.querySelector('.go-to-btn');
  const splitBtn = item.querySelector('.split-btn');
  
  startInput.addEventListener('change', () => {
    subtitle.start = parseTime(startInput.value);
    sortSubtitles();
  });
  
  endInput.addEventListener('change', () => {
    subtitle.end = parseTime(endInput.value);
  });
  
  textInput.addEventListener('input', () => {
    subtitle.text = textInput.value;
    // Live preview: update the video preview in real-time as you type
    displaySubtitle(subtitle.text, 0.5, true);
  });
  
  // Show preview when focusing on a subtitle
  textInput.addEventListener('focus', () => {
    displaySubtitle(subtitle.text, 0.5, true);
    item.classList.add('active');
  });
  
  textInput.addEventListener('blur', () => {
    // Only clear if video is paused
    if (DOM.videoPlayer.paused) {
      // Keep the last preview visible for a moment
    }
  });
  
  deleteBtn.addEventListener('click', () => {
    deleteSubtitle(subtitle.id);
  });
  
  previewBtn.addEventListener('click', () => {
    // Show this subtitle's text on the video without changing playback position
    displaySubtitle(subtitle.text, 0.5, true);
    highlightActiveSubtitle(subtitle.id);
  });
  
  goToBtn.addEventListener('click', () => {
    DOM.videoPlayer.currentTime = subtitle.start;
    DOM.videoPlayer.play();
  });
  
  splitBtn.addEventListener('click', () => {
    splitSubtitle(subtitle.id);
  });
  
  return item;
}

function addManualSubtitle() {
  const currentTime = DOM.videoPlayer.currentTime || 0;
  
  const newSubtitle = {
    id: State.nextSubtitleId++,
    start: currentTime,
    end: currentTime + 2,
    text: 'New subtitle'
  };
  
  State.subtitles.push(newSubtitle);
  sortSubtitles();
  renderSubtitleList();
  
  // Focus the new subtitle's text input
  setTimeout(() => {
    const item = DOM.subtitleList.querySelector(`[data-id="${newSubtitle.id}"]`);
    if (item) {
      const textInput = item.querySelector('.subtitle-text-input');
      textInput.focus();
      textInput.select();
    }
  }, 100);
}

function deleteSubtitle(id) {
  State.subtitles = State.subtitles.filter(s => s.id !== id);
  renderSubtitleList();
}

function splitSubtitle(id) {
  const index = State.subtitles.findIndex(s => s.id === id);
  if (index === -1) return;
  
  const subtitle = State.subtitles[index];
  const words = subtitle.text.split(' ');
  
  if (words.length < 2) return;
  
  const midPoint = Math.floor(words.length / 2);
  const midTime = (subtitle.start + subtitle.end) / 2;
  
  // Update first part
  subtitle.text = words.slice(0, midPoint).join(' ');
  subtitle.end = midTime;
  
  // Create second part
  const newSubtitle = {
    id: State.nextSubtitleId++,
    start: midTime,
    end: State.subtitles[index].end || midTime + 2,
    text: words.slice(midPoint).join(' ')
  };
  
  State.subtitles.splice(index + 1, 0, newSubtitle);
  renderSubtitleList();
}

function sortSubtitles() {
  State.subtitles.sort((a, b) => a.start - b.start);
}

// ============================================================================
// TIME FORMATTING
// ============================================================================

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
}

function parseTime(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(timeStr) || 0;
}

function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseSRTTime(timeStr) {
  const parts = timeStr.split(':');
  const secondsParts = parts[2].split(',');
  
  const hours = parseInt(parts[0]);
  const mins = parseInt(parts[1]);
  const secs = parseInt(secondsParts[0]);
  const ms = parseInt(secondsParts[1]);
  
  return hours * 3600 + mins * 60 + secs + ms / 1000;
}

// ============================================================================
// SRT IMPORT/EXPORT
// ============================================================================

function exportSRT() {
  if (State.subtitles.length === 0) {
    alert('No subtitles to export');
    return;
  }
  
  let srt = '';
  State.subtitles.forEach((subtitle, index) => {
    srt += `${index + 1}\n`;
    srt += `${formatSRTTime(subtitle.start)} --> ${formatSRTTime(subtitle.end)}\n`;
    srt += `${subtitle.text}\n\n`;
  });
  
  const blob = new Blob([srt], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = 'subtitles.srt';
  a.click();
  
  URL.revokeObjectURL(url);
}

function importSRT(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    const content = event.target.result;
    parseSRT(content);
    renderSubtitleList();
    DOM.exportSection.style.display = 'block';
  };
  reader.readAsText(file);
  
  // Reset input
  e.target.value = '';
}

function parseSRT(content) {
  const blocks = content.trim().split(/\n\n+/);
  State.subtitles = [];
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    
    // Line 1: index (ignored)
    // Line 2: timestamps
    // Line 3+: text
    
    const timeLine = lines[1];
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    
    if (!timeMatch) continue;
    
    const start = parseSRTTime(timeMatch[1]);
    const end = parseSRTTime(timeMatch[2]);
    const text = lines.slice(2).join(' ').trim();
    
    State.subtitles.push({
      id: State.nextSubtitleId++,
      start,
      end,
      text
    });
  }
  
  console.log('[SubtitleEditor] Imported', State.subtitles.length, 'subtitles from SRT');
}

// ============================================================================
// FFMPEG VIDEO EXPORT
// ============================================================================

async function initFFmpeg(progressCallback) {
  if (State.ffmpegLoaded) return;
  
  const { FFmpeg } = FFmpegWASM;
  State.ffmpeg = new FFmpeg();
  
  State.ffmpeg.on('log', ({ message }) => {
    console.log('[FFmpeg]', message);
  });
  
  State.ffmpeg.on('progress', ({ progress }) => {
    if (progressCallback) {
      progressCallback(30 + progress * 60, 'Encoding video...');
    }
  });
  
  // Load FFmpeg core
  await State.ffmpeg.load({
    coreURL: './lib/ffmpeg/ffmpeg-core.js',
    wasmURL: './lib/ffmpeg/ffmpeg-core.wasm'
  });
  
  State.ffmpegLoaded = true;
  console.log('[SubtitleEditor] FFmpeg loaded');
}

function generateASSContent() {
  // Get font size from selection
  const fontSizeMap = {
    'small': 20,
    'medium': 28,
    'large': 36,
    'xlarge': 48
  };
  const fontSize = fontSizeMap[DOM.fontSizeSelect.value] || 28;
  
  // ASS header with presenter-mode style
  let ass = `[Script Info]
Title: Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,50,50,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  
  // Add subtitle events
  State.subtitles.forEach(subtitle => {
    const startTime = formatASSTime(subtitle.start);
    const endTime = formatASSTime(subtitle.end);
    // Escape special characters for ASS
    const text = subtitle.text
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N');
    
    ass += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}\n`;
  });
  
  return ass;
}

function formatASSTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  return `${hours}:${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

async function exportVideo() {
  if (State.subtitles.length === 0) {
    alert('No subtitles to export');
    return;
  }
  
  if (!State.videoFile) {
    alert('No video loaded');
    return;
  }
  
  DOM.exportBtn.disabled = true;
  showLoading('Exporting Video', 'Initializing FFmpeg...');
  
  try {
    // Init FFmpeg if needed
    if (!State.ffmpegLoaded) {
      updateLoading(5, 'Loading FFmpeg...');
      await initFFmpeg(updateLoading);
    }
    
    const ffmpeg = State.ffmpeg;
    
    updateLoading(10, 'Preparing files...');
    
    // Write video file
    const videoData = new Uint8Array(await State.videoFile.arrayBuffer());
    await ffmpeg.writeFile('input.mp4', videoData);
    
    // Generate ASS subtitle file
    const assContent = generateASSContent();
    await ffmpeg.writeFile('subtitles.ass', assContent);
    
    // Copy the font file
    const fontResponse = await fetch('./lib/fonts/Montserrat-Bold.ttf');
    const fontData = new Uint8Array(await fontResponse.arrayBuffer());
    await ffmpeg.writeFile('Montserrat-Bold.ttf', fontData);
    
    updateLoading(20, 'Encoding video with subtitles...');
    
    // Burn subtitles into video using ASS filter
    // Using fontsdir to specify font location
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-vf', `ass=subtitles.ass:fontsdir=.`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      'output.mp4'
    ]);
    
    updateLoading(95, 'Preparing download...');
    
    // Read output
    const outputData = await ffmpeg.readFile('output.mp4');
    
    // Clean up
    await ffmpeg.deleteFile('input.mp4');
    await ffmpeg.deleteFile('subtitles.ass');
    await ffmpeg.deleteFile('Montserrat-Bold.ttf');
    await ffmpeg.deleteFile('output.mp4');
    
    // Download
    const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    const originalName = State.videoFile.name.replace(/\.[^.]+$/, '');
    a.download = `${originalName}_subtitled.mp4`;
    a.click();
    
    URL.revokeObjectURL(url);
    
    updateLoading(100, 'Done!');
    setTimeout(hideLoading, 500);
    
    console.log('[SubtitleEditor] Video exported successfully');
  } catch (error) {
    console.error('[SubtitleEditor] Export failed:', error);
    hideLoading();
    alert('Failed to export video: ' + error.message);
  } finally {
    DOM.exportBtn.disabled = false;
  }
}

// ============================================================================
// LOADING UI
// ============================================================================

function showLoading(title, message) {
  DOM.loadingTitle.textContent = title;
  DOM.loadingMessage.textContent = message;
  DOM.loadingProgressFill.style.width = '0%';
  DOM.loadingPercent.textContent = '0%';
  DOM.loadingModal.style.display = 'flex';
}

function updateLoading(percent, message) {
  if (message) DOM.loadingMessage.textContent = message;
  DOM.loadingProgressFill.style.width = `${percent}%`;
  DOM.loadingPercent.textContent = `${Math.round(percent)}%`;
}

function hideLoading() {
  DOM.loadingModal.style.display = 'none';
}

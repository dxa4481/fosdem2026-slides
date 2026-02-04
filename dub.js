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
  videoData: null, // Store ArrayBuffer to avoid stale file references
  useLargeFileMode: false, // Use streaming for large files
  subtitles: [], // Array of {id, start, end, text}
  transcriber: null,
  isModelLoaded: false,
  isModelLoading: false,
  ffmpeg: null,
  ffmpegLoaded: false,
  currentSubtitleIndex: -1,
  nextSubtitleId: 1,
  isManualPreview: false,
  partialTranscription: false, // True if only part of video was transcribed
  transcriptionDurationLimit: null // Duration limit in seconds if partial
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

async function loadVideo(file) {
  State.videoFile = file;
  
  // Revoke previous URL if exists
  if (State.videoUrl) {
    URL.revokeObjectURL(State.videoUrl);
  }
  
  // Create object URL for playback (this works even without reading the full file)
  State.videoUrl = URL.createObjectURL(file);
  DOM.videoPlayer.src = State.videoUrl;
  
  // Show video, hide upload area
  DOM.uploadArea.style.display = 'none';
  DOM.videoContainer.style.display = 'flex';
  DOM.videoControls.style.display = 'flex';
  
  // For large files (>500MB), we'll use streaming approach instead of loading all into memory
  const fileSizeMB = file.size / (1024 * 1024);
  console.log('[SubtitleEditor] Video file size:', Math.round(fileSizeMB), 'MB');
  
  if (fileSizeMB > 500) {
    // Large file - we'll stream directly to FFmpeg when needed
    console.log('[SubtitleEditor] Large file detected, will use streaming approach');
    State.videoData = null;
    State.useLargeFileMode = true;
  } else {
    // Smaller file - try to pre-cache for faster access
    State.useLargeFileMode = false;
    try {
      State.videoData = await file.arrayBuffer();
      console.log('[SubtitleEditor] Video loaded and cached:', file.name, '(' + Math.round(State.videoData.byteLength / 1024 / 1024) + ' MB)');
    } catch (e) {
      console.warn('[SubtitleEditor] Could not pre-cache video data, will use streaming:', e.message);
      State.videoData = null;
      State.useLargeFileMode = true;
    }
  }
}

// Maximum file size that can be fully processed in-browser
// FFmpeg.wasm has severe memory limitations (~1-2GB heap)
const MAX_FILE_SIZE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE_MB = Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024));

// Hard limit - files larger than this will likely crash FFmpeg regardless of duration limits
const HARD_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const HARD_LIMIT_MB = Math.round(HARD_LIMIT_BYTES / (1024 * 1024));

// Write file to FFmpeg filesystem using streaming for large files
async function writeVideoToFFmpeg(ffmpeg, filename, progressCallback) {
  if (!State.videoFile && !State.videoData) {
    throw new Error('No video file loaded');
  }
  
  // If we have cached data, use it directly
  if (State.videoData) {
    console.log('[SubtitleEditor] Writing cached video data to FFmpeg...');
    await ffmpeg.writeFile(filename, new Uint8Array(State.videoData));
    return;
  }
  
  const file = State.videoFile;
  const fileSize = file.size;
  const fileSizeMB = Math.round(fileSize / (1024 * 1024));
  
  // Check file size limit - browsers cannot allocate ArrayBuffers larger than ~2GB
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Video file is too large (${fileSizeMB} MB). ` +
      `Maximum supported size is ${MAX_FILE_SIZE_MB} MB. ` +
      `Please compress your video or use a shorter clip.`
    );
  }
  
  // For large files, use chunked streaming approach
  console.log('[SubtitleEditor] Using chunked streaming for large file...');
  const chunkSize = 64 * 1024 * 1024; // 64MB chunks
  const totalChunks = Math.ceil(fileSize / chunkSize);
  
  // Collect chunks in an array first, then concatenate
  // This is more memory-efficient than pre-allocating one huge buffer
  const chunks = [];
  let totalBytesRead = 0;
  
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    
    if (progressCallback) {
      const percent = Math.round((i / totalChunks) * 15); // 0-15% for reading
      progressCallback(percent, `Reading video file... ${Math.round((end / fileSize) * 100)}%`);
    }
    
    try {
      // Read this chunk using slice (more reliable for large files)
      const blob = file.slice(start, end);
      const chunkBuffer = await blob.arrayBuffer();
      const chunkData = new Uint8Array(chunkBuffer);
      chunks.push(chunkData);
      totalBytesRead += chunkData.length;
    } catch (e) {
      console.error('[SubtitleEditor] Error reading chunk', i, ':', e);
      // Clean up chunks to free memory
      chunks.length = 0;
      throw new Error(`Failed to read video file at chunk ${i + 1}/${totalChunks}. Error: ${e.message}`);
    }
  }
  
  if (progressCallback) {
    progressCallback(15, 'Combining chunks...');
  }
  
  // Now concatenate all chunks into a single buffer
  let fileData;
  try {
    fileData = new Uint8Array(totalBytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      fileData.set(chunk, offset);
      offset += chunk.length;
    }
    // Free chunk memory
    chunks.length = 0;
  } catch (e) {
    // Clean up on allocation failure
    chunks.length = 0;
    console.error('[SubtitleEditor] Failed to allocate buffer:', e);
    throw new Error(
      `Cannot allocate memory for video file (${fileSizeMB} MB). ` +
      `Your browser may not have enough memory. ` +
      `Please try a smaller video file or close other browser tabs.`
    );
  }
  
  if (progressCallback) {
    progressCallback(18, 'Writing to FFmpeg...');
  }
  
  // Write the complete file to FFmpeg
  console.log('[SubtitleEditor] Writing', Math.round(fileSize / 1024 / 1024), 'MB to FFmpeg filesystem...');
  await ffmpeg.writeFile(filename, fileData);
  
  // Cache for potential reuse if memory allows
  if (fileSize < 500 * 1024 * 1024) { // Only cache if < 500MB
    State.videoData = fileData.buffer;
  }
  
  console.log('[SubtitleEditor] Video file written to FFmpeg');
}

// Legacy function for backward compatibility (not used for FFmpeg operations now)
async function ensureVideoData() {
  if (State.videoData) {
    return State.videoData;
  }
  
  if (!State.videoFile) {
    throw new Error('No video file loaded');
  }
  
  // Try to read from file using chunked approach
  try {
    const file = State.videoFile;
    const fileSize = file.size;
    
    // For small files, try direct read
    if (fileSize < 100 * 1024 * 1024) { // < 100MB
      State.videoData = await file.arrayBuffer();
      return State.videoData;
    }
    
    // For larger files, use chunked reading
    const chunkSize = 64 * 1024 * 1024;
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const fileData = new Uint8Array(fileSize);
    let offset = 0;
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const blob = file.slice(start, end);
      const chunkBuffer = await blob.arrayBuffer();
      fileData.set(new Uint8Array(chunkBuffer), offset);
      offset += end - start;
    }
    
    State.videoData = fileData.buffer;
    return State.videoData;
  } catch (e) {
    console.error('[SubtitleEditor] Failed to read video file:', e);
    throw new Error('Could not read video file. The file may be too large or access was denied. Please try again.');
  }
}

function clearVideo() {
  // Revoke URL
  if (State.videoUrl) {
    URL.revokeObjectURL(State.videoUrl);
    State.videoUrl = null;
  }
  
  State.videoFile = null;
  State.videoData = null;
  State.useLargeFileMode = false;
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

// Check if a file is too large for full processing
function isFileTooLarge(file) {
  return file && file.size > MAX_FILE_SIZE_BYTES;
}

// Get a suggested duration limit for large files (in seconds)
function getSuggestedDurationLimit(fileSizeMB) {
  // For very large files, limit transcription duration
  // FFmpeg.wasm has very limited memory (~1-2GB usable), so we need to be very conservative
  // For files >2GB, we try Web Audio API first which can handle longer durations
  // FFmpeg fallback is limited to ~2 minutes max with 100MB input
  if (fileSizeMB > 4000) return 2 * 60;  // 2 minutes for >4GB (very large files)
  if (fileSizeMB > 3000) return 2 * 60;  // 2 minutes for >3GB
  if (fileSizeMB > 2000) return 2 * 60;  // 2 minutes for >2GB
  if (fileSizeMB > 1500) return 3 * 60;  // 3 minutes for >1.5GB
  return 3 * 60; // 3 minutes max for any large file using FFmpeg
}

async function extractAudioFromVideo(progressCallback, durationLimitSeconds = null) {
  // Initialize FFmpeg if needed
  if (!State.ffmpegLoaded) {
    await initFFmpeg(progressCallback);
  }
  
  const ffmpeg = State.ffmpeg;
  const file = State.videoFile;
  const fileSizeMB = Math.round(file.size / (1024 * 1024));
  
  // Check if file is too large for full processing
  if (isFileTooLarge(file) && !durationLimitSeconds) {
    // Calculate a suggested duration based on file size
    durationLimitSeconds = getSuggestedDurationLimit(fileSizeMB);
    console.log(`[SubtitleEditor] File too large (${fileSizeMB}MB), will transcribe first ${Math.round(durationLimitSeconds/60)} minutes only`);
  }
  
  // For large files, we'll use FFmpeg to extract just audio from the blob URL directly
  // This avoids loading the entire video file into memory
  if (isFileTooLarge(file)) {
    return await extractAudioFromLargeVideo(ffmpeg, progressCallback, durationLimitSeconds);
  }
  
  // Standard approach for smaller files
  // Write video to FFmpeg using streaming approach
  await writeVideoToFFmpeg(ffmpeg, 'input.mp4', progressCallback);
  
  if (progressCallback) progressCallback(25, 'Extracting audio...');
  
  // Extract audio as WAV (16kHz mono for Whisper)
  // IMPORTANT: If FFmpeg aborts, the WASM instance becomes unresponsive - don't try to use it
  try {
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      'audio.wav'
    ]);
  } catch (e) {
    console.error('[SubtitleEditor] FFmpeg crashed:', e);
    State.ffmpegLoaded = false;
    State.ffmpeg = null;
    throw new Error(`FFmpeg ran out of memory. Please try a smaller video file.`);
  }
  
  // FFmpeg succeeded - delete input video BEFORE reading audio to free memory
  if (progressCallback) progressCallback(35, 'Freeing memory...');
  try {
    await ffmpeg.deleteFile('input.mp4');
  } catch (e) {
    console.warn('[SubtitleEditor] Could not delete input file:', e);
  }
  
  // Read the audio file
  let audioData;
  try {
    audioData = await ffmpeg.readFile('audio.wav');
  } catch (e) {
    console.error('[SubtitleEditor] Failed to read audio file:', e);
    throw new Error(`Failed to read extracted audio: ${e.message}`);
  }
  
  // Clean up audio file
  try {
    await ffmpeg.deleteFile('audio.wav');
  } catch (e) {
    console.warn('[SubtitleEditor] Could not delete audio file:', e);
  }
  
  if (progressCallback) progressCallback(40, 'Audio extracted');
  
  return audioData;
}

// Extract audio using Web Audio API (works better for very large files)
// This plays the video and captures audio through Web Audio API
async function extractAudioWithWebAudio(durationLimitSeconds, progressCallback) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    // DO NOT set muted=true - this prevents audio from flowing through Web Audio API
    video.src = State.videoUrl;
    video.crossOrigin = 'anonymous';
    
    // Use standard sample rate, we'll resample later
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const targetSampleRate = 16000; // Whisper expects 16kHz
    
    // Create a media element source - this routes video audio through Web Audio
    const source = audioContext.createMediaElementSource(video);
    
    // Create a gain node set to 0 to silence output (but audio still flows!)
    const silencer = audioContext.createGain();
    silencer.gain.value = 0;
    
    // Create a script processor to capture audio
    const bufferSize = 4096;
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    const audioChunks = [];
    let totalSamples = 0;
    // Calculate max samples at the audio context's sample rate
    const maxSamplesAtContextRate = durationLimitSeconds * audioContext.sampleRate;
    
    processor.onaudioprocess = (e) => {
      if (totalSamples >= maxSamplesAtContextRate) {
        return;
      }
      
      const inputData = e.inputBuffer.getChannelData(0);
      // Check if there's actual audio (not just silence)
      let hasAudio = false;
      for (let i = 0; i < inputData.length; i += 100) {
        if (Math.abs(inputData[i]) > 0.001) {
          hasAudio = true;
          break;
        }
      }
      
      if (hasAudio || audioChunks.length > 0) {
        // Only start recording once we detect audio, then keep recording
        const chunk = new Float32Array(inputData.length);
        chunk.set(inputData);
        audioChunks.push(chunk);
        totalSamples += inputData.length;
      }
      
      if (progressCallback && totalSamples > 0) {
        const progress = Math.min(40, 10 + (totalSamples / maxSamplesAtContextRate) * 30);
        const seconds = Math.round(totalSamples / audioContext.sampleRate);
        progressCallback(progress, `Capturing audio... ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} (live)`);
      }
    };
    
    // Connect: source -> processor -> silencer -> destination
    // This ensures audio flows but is silenced
    source.connect(processor);
    processor.connect(silencer);
    silencer.connect(audioContext.destination);
    
    video.onloadedmetadata = async () => {
      // Resume audio context (required for autoplay policies)
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      
      // Use 4x speed - fast but still captures audio reliably
      video.playbackRate = 4;
      
      console.log('[SubtitleEditor] Web Audio: Starting capture at', audioContext.sampleRate, 'Hz, 4x speed');
      console.log('[SubtitleEditor] Target duration:', durationLimitSeconds, 'seconds, will take ~', Math.round(durationLimitSeconds/4), 'seconds');
      
      video.play().catch(e => {
        console.error('[SubtitleEditor] Video play failed:', e);
        reject(new Error('Could not play video for audio extraction: ' + e.message));
      });
    };
    
    video.onerror = () => {
      reject(new Error('Failed to load video for audio extraction'));
    };
    
    const finishCapture = () => {
      video.pause();
      try {
        processor.disconnect();
        source.disconnect();
        silencer.disconnect();
        audioContext.close();
      } catch (e) {}
      
      console.log('[SubtitleEditor] Web Audio: Captured', audioChunks.length, 'chunks,', totalSamples, 'samples');
      
      if (audioChunks.length === 0 || totalSamples < audioContext.sampleRate) {
        reject(new Error('No audio captured - video may not have audio track'));
        return;
      }
      
      // Combine all chunks
      const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combinedAudio = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of audioChunks) {
        combinedAudio.set(chunk, offset);
        offset += chunk.length;
      }
      
      if (progressCallback) progressCallback(38, 'Resampling audio to 16kHz...');
      
      // Resample from audioContext.sampleRate to 16kHz
      const resampledAudio = resampleAudio(combinedAudio, audioContext.sampleRate, targetSampleRate);
      
      console.log('[SubtitleEditor] Web Audio: Resampled from', combinedAudio.length, 'to', resampledAudio.length, 'samples');
      
      // Convert to WAV format (16-bit PCM)
      const wavBuffer = float32ToWav(resampledAudio, targetSampleRate);
      resolve(new Uint8Array(wavBuffer));
    };
    
    // Check periodically if we have enough audio
    const checkInterval = setInterval(() => {
      if (totalSamples >= maxSamplesAtContextRate || video.ended) {
        clearInterval(checkInterval);
        finishCapture();
      }
    }, 500);
    
    // Timeout after expected duration (at 4x speed) + buffer
    const timeoutMs = (durationLimitSeconds / 4 + 10) * 1000;
    setTimeout(() => {
      clearInterval(checkInterval);
      console.log('[SubtitleEditor] Web Audio: Timeout reached, finishing capture');
      finishCapture();
    }, timeoutMs);
  });
}

// Simple linear resampling
function resampleAudio(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  
  const ratio = fromRate / toRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const t = srcIndex - srcIndexFloor;
    
    // Linear interpolation
    result[i] = samples[srcIndexFloor] * (1 - t) + samples[srcIndexCeil] * t;
  }
  
  return result;
}

// Convert Float32Array audio to WAV format
function float32ToWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  // WAV header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // AudioFormat (PCM)
  view.setUint16(22, 1, true); // NumChannels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  
  // Write samples as 16-bit PCM
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  
  return buffer;
}

// Extract audio from large video files by reading chunks
async function extractAudioFromLargeVideo(ffmpeg, progressCallback, durationLimitSeconds) {
  const file = State.videoFile;
  const fileSizeMB = Math.round(file.size / (1024 * 1024));
  
  if (progressCallback) {
    progressCallback(5, `Large file detected (${fileSizeMB}MB). Extracting first ${Math.round(durationLimitSeconds/60)} minutes...`);
  }
  
  // Check hard limit - some files are just too large for browser processing
  if (file.size > HARD_LIMIT_BYTES) {
    throw new Error(
      `This video file (${fileSizeMB}MB) is too large for browser-based processing. ` +
      `Maximum supported size is approximately ${HARD_LIMIT_MB}MB. ` +
      `Please use a desktop video editor or compress the video first.`
    );
  }
  
  // For very large files, try using Web Audio API instead of FFmpeg
  // This extracts audio without loading the whole file into memory
  if (fileSizeMB > 2000) {
    console.log('[SubtitleEditor] File very large, trying Web Audio API approach...');
    if (progressCallback) progressCallback(10, 'Trying alternative audio extraction...');
    try {
      const audioData = await extractAudioWithWebAudio(durationLimitSeconds, progressCallback);
      if (audioData) {
        State.partialTranscription = true;
        State.transcriptionDurationLimit = durationLimitSeconds;
        return audioData;
      }
    } catch (e) {
      console.warn('[SubtitleEditor] Web Audio extraction failed, falling back to FFmpeg:', e);
    }
  }
  
  // For large files, we extract audio by reading a portion of the file
  // We estimate how much of the file we need based on duration
  // Typical video bitrate: ~5-10 Mbps, so 1 minute ≈ 40-80MB
  
  // Estimate bytes needed for the duration we want
  // Use a very conservative estimate to avoid memory issues
  // FFmpeg.wasm has extremely limited heap, cap at 100MB input
  const bytesPerMinute = 40 * 1024 * 1024; // 40MB per minute estimate
  const maxInputBytes = 100 * 1024 * 1024; // Max 100MB input - very conservative
  const estimatedBytesNeeded = Math.min(
    (durationLimitSeconds / 60) * bytesPerMinute,
    maxInputBytes
  );
  
  console.log(`[SubtitleEditor] Estimating ${Math.round(estimatedBytesNeeded / (1024*1024))}MB needed for ${Math.round(durationLimitSeconds/60)} minutes`);
  
  // Read the portion of the file we need
  const bytesToRead = Math.min(estimatedBytesNeeded, file.size);
  const chunkSize = 64 * 1024 * 1024;
  const totalChunks = Math.ceil(bytesToRead / chunkSize);
  
  const chunks = [];
  let totalBytesRead = 0;
  
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, bytesToRead);
    
    if (progressCallback) {
      const percent = Math.round((i / totalChunks) * 15);
      progressCallback(percent, `Reading video portion... ${Math.round((end / bytesToRead) * 100)}%`);
    }
    
    try {
      const blob = file.slice(start, end);
      const chunkBuffer = await blob.arrayBuffer();
      chunks.push(new Uint8Array(chunkBuffer));
      totalBytesRead += chunkBuffer.byteLength;
    } catch (e) {
      chunks.length = 0;
      throw new Error(`Failed to read video file: ${e.message}`);
    }
  }
  
  if (progressCallback) progressCallback(15, 'Combining data...');
  
  // Concatenate chunks
  let fileData;
  try {
    fileData = new Uint8Array(totalBytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      fileData.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
  } catch (e) {
    chunks.length = 0;
    throw new Error(`Cannot allocate memory. Please close other browser tabs and try again.`);
  }
  
  if (progressCallback) progressCallback(18, 'Writing to FFmpeg...');
  
  // Write the partial video to FFmpeg
  await ffmpeg.writeFile('input.mp4', fileData);
  fileData = null; // Free memory
  
  if (progressCallback) progressCallback(20, 'Extracting audio (this may take a while)...');
  
  // Extract audio with duration limit
  const ffmpegArgs = [
    '-i', 'input.mp4',
    '-t', String(durationLimitSeconds), // Limit duration
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    'audio.wav'
  ];
  
  // FFmpeg.wasm can abort during cleanup even if extraction succeeds
  // IMPORTANT: If FFmpeg aborts, the WASM instance becomes completely unresponsive
  // We cannot call ANY methods on it (deleteFile, readFile, etc.) - they will hang forever
  try {
    await ffmpeg.exec(ffmpegArgs);
  } catch (e) {
    // FFmpeg crashed - the WASM instance is now dead
    console.error('[SubtitleEditor] FFmpeg crashed:', e);
    State.ffmpegLoaded = false;
    State.ffmpeg = null;
    throw new Error(
      `FFmpeg ran out of memory processing this large file (${fileSizeMB}MB). ` +
      `This video is too large for in-browser processing. ` +
      `Please try a shorter or lower-resolution video.`
    );
  }
  
  // FFmpeg succeeded - now we can safely clean up
  // Delete the input video BEFORE reading audio to free memory
  if (progressCallback) progressCallback(35, 'Freeing memory...');
  try {
    await ffmpeg.deleteFile('input.mp4');
  } catch (e) {
    console.warn('[SubtitleEditor] Could not delete input file:', e);
  }
  
  // Read the audio file
  if (progressCallback) progressCallback(37, 'Reading audio data...');
  let audioData;
  try {
    audioData = await ffmpeg.readFile('audio.wav');
  } catch (e) {
    console.error('[SubtitleEditor] Failed to read audio file:', e);
    throw new Error(`Failed to read extracted audio: ${e.message}`);
  }
  
  // Clean up audio file
  try {
    await ffmpeg.deleteFile('audio.wav');
  } catch (e) {
    console.warn('[SubtitleEditor] Could not delete audio file:', e);
  }
  
  if (progressCallback) progressCallback(40, 'Audio extracted');
  
  // Store that we used partial transcription
  State.partialTranscription = true;
  State.transcriptionDurationLimit = durationLimitSeconds;
  
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
  
  // Reset partial transcription state
  State.partialTranscription = false;
  State.transcriptionDurationLimit = null;
  
  DOM.generateBtn.disabled = true;
  showLoading('Generating Subtitles', 'Initializing...');
  
  try {
    // Check file size and warn user about large files
    const fileSizeMB = Math.round(State.videoFile.size / (1024 * 1024));
    if (isFileTooLarge(State.videoFile)) {
      const suggestedMinutes = Math.round(getSuggestedDurationLimit(fileSizeMB) / 60);
      console.log(`[SubtitleEditor] Large file (${fileSizeMB}MB), will transcribe first ${suggestedMinutes} minutes`);
      updateLoading(5, `Large file detected. Will transcribe first ${suggestedMinutes} minutes...`);
      await new Promise(resolve => setTimeout(resolve, 1500)); // Let user see the message
    }
    
    // Load Whisper model
    updateLoading(10, 'Loading AI model...');
    await initWhisper((progress, message) => {
      updateLoading(10 + progress * 0.2, message);
    });
    
    // Extract audio from video
    updateLoading(30, 'Extracting audio from video...');
    const audioData = await extractAudioFromVideo(updateLoading);
    
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
    
    // Notify user if partial transcription was used
    if (State.partialTranscription) {
      const minutes = Math.round(State.transcriptionDurationLimit / 60);
      setTimeout(() => {
        alert(
          `Note: Due to the large file size, only the first ${minutes} minutes were transcribed.\n\n` +
          `You can manually add subtitles for the remaining portion of the video using the "Add Subtitle" button.`
        );
      }, 600);
    }
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
  
  // Use absolute URLs for local files (same approach as app.js)
  const baseURL = new URL("lib/ffmpeg/", window.location.href).href;
  
  // Load FFmpeg core
  await State.ffmpeg.load({
    coreURL: baseURL + "ffmpeg-core.js",
    wasmURL: baseURL + "ffmpeg-core.wasm"
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
    
    updateLoading(5, 'Preparing files...');
    
    // Write video to FFmpeg using streaming approach for large files
    await writeVideoToFFmpeg(ffmpeg, 'input.mp4', updateLoading);
    
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

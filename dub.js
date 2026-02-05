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
  transcriptionDurationLimit: null, // Duration limit in seconds if partial
  webAudioFailed: false, // If Web Audio capture failed, don't retry
  mediaElementSource: null, // Cache to avoid creating multiple sources
  
  // Chunked transcription state (for large files)
  chunkedMode: false,
  chunkDuration: 10, // 10 seconds per chunk
  currentChunkStart: 0,
  videoDuration: 0,
  chunkAbortController: null, // To cancel chunk processing
  pendingChunkText: '', // Text from current chunk awaiting review
  pendingChunkStart: 0,
  pendingChunkEnd: 0
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
  chunkedBtn: null,
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
  DOM.chunkedBtn = document.getElementById('chunked-btn');
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
  DOM.chunkedBtn.addEventListener('click', startChunkedTranscription);
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
  State.webAudioFailed = false; // Reset for next video
  
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

// Extract audio using Web Audio API at NORMAL SPEED (1x)
// Playing faster than 1x causes pitch shift which breaks transcription!
// For 2 minutes of audio, this takes 2 minutes of real time - that's acceptable
async function extractAudioWithWebAudio(durationLimitSeconds, progressCallback) {
  return new Promise((resolve, reject) => {
    // Create a fresh video element to avoid MediaElementSource conflicts
    const video = document.createElement('video');
    video.src = State.videoUrl;
    video.preload = 'auto';
    
    // Use standard sample rate, we'll resample later
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const targetSampleRate = 16000; // Whisper expects 16kHz
    
    // Wait for video to be ready
    let source;
    
    const audioChunks = [];
    let totalSamples = 0;
    const maxSamplesAtContextRate = durationLimitSeconds * audioContext.sampleRate;
    let processor = null;
    let silencer = null;
    let started = false;
    
    const cleanup = () => {
      video.pause();
      video.src = '';
      try {
        if (processor) processor.disconnect();
        if (source) source.disconnect();
        if (silencer) silencer.disconnect();
        audioContext.close();
      } catch (e) {}
    };
    
    const finishCapture = () => {
      cleanup();
      
      console.log('[SubtitleEditor] Web Audio: Captured', audioChunks.length, 'chunks,', totalSamples, 'samples at', audioContext.sampleRate, 'Hz');
      
      if (audioChunks.length === 0 || totalSamples < audioContext.sampleRate * 5) {
        reject(new Error('Insufficient audio captured - video may not have an audio track'));
        return;
      }
      
      // Combine all chunks
      if (progressCallback) progressCallback(38, 'Processing captured audio...');
      
      const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combinedAudio = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of audioChunks) {
        combinedAudio.set(chunk, offset);
        offset += chunk.length;
      }
      
      if (progressCallback) progressCallback(39, 'Resampling to 16kHz...');
      
      // Resample from audioContext.sampleRate to 16kHz
      const resampledAudio = resampleAudio(combinedAudio, audioContext.sampleRate, targetSampleRate);
      
      console.log('[SubtitleEditor] Web Audio: Resampled from', combinedAudio.length, 'to', resampledAudio.length, 'samples');
      
      // Convert to WAV format (16-bit PCM)
      const wavBuffer = float32ToWav(resampledAudio, targetSampleRate);
      resolve(new Uint8Array(wavBuffer));
    };
    
    // Start capture when video is ready
    const startCapture = async () => {
      if (started) return;
      started = true;
      
      try {
        // Create media element source
        source = audioContext.createMediaElementSource(video);
        
        // Create gain node to silence output (but audio still flows through!)
        silencer = audioContext.createGain();
        silencer.gain.value = 0;
        
        // Create script processor to capture audio
        const bufferSize = 4096;
        processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        processor.onaudioprocess = (e) => {
          if (totalSamples >= maxSamplesAtContextRate) return;
          
          const inputData = e.inputBuffer.getChannelData(0);
          const chunk = new Float32Array(inputData.length);
          chunk.set(inputData);
          audioChunks.push(chunk);
          totalSamples += inputData.length;
          
          if (progressCallback) {
            const capturedSeconds = totalSamples / audioContext.sampleRate;
            const progress = Math.min(40, 10 + (capturedSeconds / durationLimitSeconds) * 30);
            const mins = Math.floor(capturedSeconds / 60);
            const secs = Math.floor(capturedSeconds % 60);
            const remaining = Math.max(0, durationLimitSeconds - capturedSeconds);
            const remMins = Math.floor(remaining / 60);
            const remSecs = Math.floor(remaining % 60);
            progressCallback(progress, `Recording: ${mins}:${String(secs).padStart(2,'0')} / ${Math.floor(durationLimitSeconds/60)}:${String(Math.floor(durationLimitSeconds%60)).padStart(2,'0')} (${remMins}:${String(remSecs).padStart(2,'0')} left)`);
          }
        };
        
        // Connect: source -> processor -> silencer -> destination
        // Audio flows through but is silenced at the end
        source.connect(processor);
        processor.connect(silencer);
        silencer.connect(audioContext.destination);
        
        // Resume audio context if suspended
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        
        // CRITICAL: Play at 1x speed! Faster = pitch shift = broken transcription
        video.playbackRate = 1;
        
        console.log('[SubtitleEditor] Web Audio: Starting real-time capture at', audioContext.sampleRate, 'Hz');
        console.log('[SubtitleEditor] Duration:', durationLimitSeconds, 'seconds (this takes real time)');
        
        await video.play();
        
      } catch (e) {
        console.error('[SubtitleEditor] Web Audio setup failed:', e);
        cleanup();
        reject(new Error('Could not set up audio capture: ' + e.message));
      }
    };
    
    video.addEventListener('canplay', startCapture, { once: true });
    video.addEventListener('error', () => {
      cleanup();
      reject(new Error('Video failed to load for audio capture'));
    }, { once: true });
    
    // Start loading the video
    video.load();
    
    // Check periodically if we have enough audio
    const checkInterval = setInterval(() => {
      if (totalSamples >= maxSamplesAtContextRate || video.ended) {
        clearInterval(checkInterval);
        finishCapture();
      }
    }, 1000);
    
    // Timeout after duration + generous buffer
    const timeoutMs = (durationLimitSeconds + 30) * 1000;
    setTimeout(() => {
      clearInterval(checkInterval);
      if (totalSamples > audioContext.sampleRate * 10) {
        console.log('[SubtitleEditor] Web Audio: Timeout, using', Math.round(totalSamples/audioContext.sampleRate), 'seconds of captured audio');
        finishCapture();
      } else {
        cleanup();
        reject(new Error('Audio capture timed out - only got ' + Math.round(totalSamples/audioContext.sampleRate) + ' seconds'));
      }
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

// ============================================================================
// CHUNKED TRANSCRIPTION (10 seconds at a time for large files)
// ============================================================================

// Capture audio from a specific time range using Web Audio API
async function captureChunkAudio(startTime, duration, progressCallback) {
  return new Promise((resolve, reject) => {
    console.log(`[ChunkedTranscription] Capturing ${duration}s from ${startTime}s`);
    
    // Create a fresh video element
    const video = document.createElement('video');
    video.src = State.videoUrl;
    video.preload = 'auto';
    video.currentTime = startTime;
    
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const targetSampleRate = 16000;
    
    let source;
    const audioChunks = [];
    let totalSamples = 0;
    const maxSamplesAtContextRate = duration * audioContext.sampleRate;
    let processor = null;
    let silencer = null;
    let started = false;
    let captureStartTime = 0;
    
    const cleanup = () => {
      video.pause();
      video.src = '';
      try {
        if (processor) processor.disconnect();
        if (source) source.disconnect();
        if (silencer) silencer.disconnect();
        audioContext.close();
      } catch (e) {}
    };
    
    const finishCapture = () => {
      cleanup();
      
      console.log(`[ChunkedTranscription] Captured ${audioChunks.length} chunks, ${totalSamples} samples`);
      
      if (audioChunks.length === 0 || totalSamples < audioContext.sampleRate * 0.5) {
        // Less than 0.5 seconds - might be at end of video
        resolve(null);
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
      
      // Resample to 16kHz
      const resampledAudio = resampleAudio(combinedAudio, audioContext.sampleRate, targetSampleRate);
      
      // Convert to WAV
      const wavBuffer = float32ToWav(resampledAudio, targetSampleRate);
      resolve(new Uint8Array(wavBuffer));
    };
    
    const startCapture = async () => {
      if (started) return;
      started = true;
      captureStartTime = Date.now();
      
      try {
        source = audioContext.createMediaElementSource(video);
        
        silencer = audioContext.createGain();
        silencer.gain.value = 0;
        
        const bufferSize = 4096;
        processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        processor.onaudioprocess = (e) => {
          if (totalSamples >= maxSamplesAtContextRate) return;
          
          const inputData = e.inputBuffer.getChannelData(0);
          const chunk = new Float32Array(inputData.length);
          chunk.set(inputData);
          audioChunks.push(chunk);
          totalSamples += inputData.length;
          
          if (progressCallback) {
            const capturedSeconds = totalSamples / audioContext.sampleRate;
            const pct = Math.min(100, (capturedSeconds / duration) * 100);
            progressCallback(pct, `Capturing: ${capturedSeconds.toFixed(1)}s / ${duration}s`);
          }
        };
        
        source.connect(processor);
        processor.connect(silencer);
        silencer.connect(audioContext.destination);
        
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        
        video.playbackRate = 1;
        await video.play();
        
      } catch (e) {
        console.error('[ChunkedTranscription] Setup failed:', e);
        cleanup();
        reject(new Error('Audio capture failed: ' + e.message));
      }
    };
    
    // Handle seek completion
    video.addEventListener('seeked', () => {
      console.log(`[ChunkedTranscription] Seeked to ${video.currentTime}s`);
      startCapture();
    }, { once: true });
    
    video.addEventListener('canplay', () => {
      if (video.currentTime >= startTime - 0.5) {
        startCapture();
      }
    }, { once: true });
    
    video.addEventListener('error', () => {
      cleanup();
      reject(new Error('Video failed to load'));
    }, { once: true });
    
    video.addEventListener('ended', () => {
      finishCapture();
    }, { once: true });
    
    video.load();
    
    // Check if we have enough audio
    const checkInterval = setInterval(() => {
      if (totalSamples >= maxSamplesAtContextRate) {
        clearInterval(checkInterval);
        finishCapture();
      }
    }, 500);
    
    // Timeout
    const timeoutMs = (duration + 15) * 1000;
    setTimeout(() => {
      clearInterval(checkInterval);
      if (totalSamples > audioContext.sampleRate * 0.5) {
        finishCapture();
      } else {
        cleanup();
        reject(new Error('Capture timed out'));
      }
    }, timeoutMs);
  });
}

// Start chunked transcription workflow
async function startChunkedTranscription() {
  if (!State.videoFile) return;
  
  State.chunkedMode = true;
  State.currentChunkStart = 0;
  State.videoDuration = DOM.videoPlayer.duration || 0;
  
  if (!State.videoDuration || State.videoDuration <= 0) {
    alert('Could not determine video duration. Please wait for video to load.');
    State.chunkedMode = false;
    return;
  }
  
  console.log(`[ChunkedTranscription] Starting chunked mode. Video duration: ${State.videoDuration}s`);
  
  // Load Whisper first
  showLoading('Starting Chunked Transcription', 'Loading Whisper model...');
  
  try {
    await initWhisper((progress, message) => {
      updateLoading(progress * 0.5, 'Loading Whisper: ' + message);
    });
    
    hideLoading();
    
    // Show chunked mode UI
    showChunkedModeUI();
    
    // Process first chunk
    processNextChunk();
    
  } catch (error) {
    hideLoading();
    alert('Failed to load transcription model: ' + error.message);
    State.chunkedMode = false;
  }
}

// Show the chunked mode UI
function showChunkedModeUI() {
  // Create or show chunk review panel
  let chunkPanel = document.getElementById('chunk-panel');
  if (!chunkPanel) {
    chunkPanel = document.createElement('div');
    chunkPanel.id = 'chunk-panel';
    chunkPanel.className = 'chunk-panel';
    chunkPanel.innerHTML = `
      <div class="chunk-header">
        <h3>Chunked Transcription</h3>
        <span id="chunk-progress">Chunk 1 of ?</span>
      </div>
      <div id="chunk-status" class="chunk-status">Preparing...</div>
      <div id="chunk-preview" class="chunk-preview" style="display: none;">
        <div class="chunk-time" id="chunk-time">00:00 - 00:10</div>
        <textarea id="chunk-text" class="chunk-text" rows="3" placeholder="Transcribed text will appear here..."></textarea>
        <div class="chunk-actions">
          <button id="chunk-play-btn" class="btn btn-secondary">▶ Play Segment</button>
          <button id="chunk-accept-btn" class="btn btn-primary">✓ Accept & Next</button>
          <button id="chunk-skip-btn" class="btn btn-secondary">Skip</button>
          <button id="chunk-stop-btn" class="btn btn-danger">Stop</button>
        </div>
      </div>
    `;
    
    // Insert before subtitle list
    const subtitleSection = DOM.subtitleList.parentElement;
    subtitleSection.insertBefore(chunkPanel, DOM.subtitleList);
    
    // Add event listeners
    document.getElementById('chunk-play-btn').addEventListener('click', playCurrentChunk);
    document.getElementById('chunk-accept-btn').addEventListener('click', acceptCurrentChunk);
    document.getElementById('chunk-skip-btn').addEventListener('click', skipCurrentChunk);
    document.getElementById('chunk-stop-btn').addEventListener('click', stopChunkedMode);
  }
  
  chunkPanel.style.display = 'block';
  DOM.generateBtn.style.display = 'none';
  if (DOM.chunkedBtn) DOM.chunkedBtn.style.display = 'none';
}

// Hide chunked mode UI
function hideChunkedModeUI() {
  const chunkPanel = document.getElementById('chunk-panel');
  if (chunkPanel) {
    chunkPanel.style.display = 'none';
  }
  DOM.generateBtn.style.display = '';
  DOM.generateBtn.disabled = false;
  if (DOM.chunkedBtn) DOM.chunkedBtn.style.display = '';
}

// Process the next chunk
async function processNextChunk() {
  if (!State.chunkedMode) return;
  
  const startTime = State.currentChunkStart;
  const duration = Math.min(State.chunkDuration, State.videoDuration - startTime);
  
  if (duration <= 0.5) {
    // We've reached the end
    finishChunkedMode();
    return;
  }
  
  const chunkNum = Math.floor(startTime / State.chunkDuration) + 1;
  const totalChunks = Math.ceil(State.videoDuration / State.chunkDuration);
  
  document.getElementById('chunk-progress').textContent = `Chunk ${chunkNum} of ${totalChunks}`;
  document.getElementById('chunk-status').textContent = 'Capturing audio...';
  document.getElementById('chunk-preview').style.display = 'none';
  
  try {
    // Capture audio for this chunk
    const audioData = await captureChunkAudio(startTime, duration, (pct, msg) => {
      document.getElementById('chunk-status').textContent = msg;
    });
    
    if (!audioData) {
      // No audio captured - might be at end
      finishChunkedMode();
      return;
    }
    
    if (!State.chunkedMode) return; // User cancelled
    
    document.getElementById('chunk-status').textContent = 'Transcribing...';
    
    // Convert WAV bytes to Float32Array for transcriber
    // WAV header is 44 bytes, then 16-bit PCM samples
    const samples = new Int16Array(audioData.buffer, 44);
    const float32Samples = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      float32Samples[i] = samples[i] / 32768.0;
    }
    
    // Transcribe
    const result = await State.transcriber(float32Samples, {
      language: 'english',
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5
    });
    
    if (!State.chunkedMode) return; // User cancelled
    
    // Process results
    let chunkText = '';
    if (result.chunks && result.chunks.length > 0) {
      chunkText = result.chunks.map(c => c.text.trim()).join(' ').trim();
    } else if (result.text) {
      chunkText = result.text.trim();
    }
    
    // Show review UI
    const endTime = startTime + duration;
    showChunkReview(startTime, endTime, chunkText);
    
  } catch (error) {
    console.error('[ChunkedTranscription] Error:', error);
    document.getElementById('chunk-status').textContent = 'Error: ' + error.message;
    
    // Auto-skip after error
    setTimeout(() => {
      if (State.chunkedMode) {
        State.currentChunkStart += State.chunkDuration;
        processNextChunk();
      }
    }, 2000);
  }
}

// Show chunk review UI
function showChunkReview(startTime, endTime, text) {
  State.pendingChunkStart = startTime;
  State.pendingChunkEnd = endTime;
  State.pendingChunkText = text;
  
  const formatTime = (t) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  
  document.getElementById('chunk-status').textContent = 'Review and edit:';
  document.getElementById('chunk-time').textContent = `${formatTime(startTime)} - ${formatTime(endTime)}`;
  document.getElementById('chunk-text').value = text || '(no speech detected)';
  document.getElementById('chunk-preview').style.display = 'block';
  
  // Seek video to chunk start
  DOM.videoPlayer.currentTime = startTime;
}

// Play current chunk segment
function playCurrentChunk() {
  DOM.videoPlayer.currentTime = State.pendingChunkStart;
  DOM.videoPlayer.play();
  
  // Stop at end of chunk
  const checkEnd = () => {
    if (DOM.videoPlayer.currentTime >= State.pendingChunkEnd) {
      DOM.videoPlayer.pause();
      DOM.videoPlayer.removeEventListener('timeupdate', checkEnd);
    }
  };
  DOM.videoPlayer.addEventListener('timeupdate', checkEnd);
}

// Accept current chunk and save subtitle
function acceptCurrentChunk() {
  const text = document.getElementById('chunk-text').value.trim();
  
  if (text && text !== '(no speech detected)') {
    // Add subtitle
    const subtitle = {
      id: State.nextSubtitleId++,
      start: State.pendingChunkStart,
      end: State.pendingChunkEnd,
      text: text
    };
    State.subtitles.push(subtitle);
    renderSubtitleList();
    updateExportState();
  }
  
  // Move to next chunk
  State.currentChunkStart += State.chunkDuration;
  processNextChunk();
}

// Skip current chunk without saving
function skipCurrentChunk() {
  State.currentChunkStart += State.chunkDuration;
  processNextChunk();
}

// Stop chunked transcription
function stopChunkedMode() {
  State.chunkedMode = false;
  hideChunkedModeUI();
  
  if (State.subtitles.length > 0) {
    State.partialTranscription = true;
    updateStatus(`Chunked transcription stopped. ${State.subtitles.length} subtitles created.`);
  } else {
    updateStatus('Chunked transcription cancelled.');
  }
}

// Finish chunked mode (reached end of video)
function finishChunkedMode() {
  State.chunkedMode = false;
  hideChunkedModeUI();
  
  updateStatus(`Transcription complete! ${State.subtitles.length} subtitles created.`);
  
  if (State.subtitles.length > 0) {
    State.partialTranscription = false; // Full video was transcribed
  }
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
  
  // For very large files (>2GB), try using Web Audio API instead of FFmpeg
  // This captures audio in real-time without loading the whole file
  // NOTE: This takes as long as the audio duration (2 min = 2 min wait)
  if (fileSizeMB > 2000 && !State.webAudioFailed) {
    console.log('[SubtitleEditor] File very large (' + fileSizeMB + 'MB), trying Web Audio API...');
    if (progressCallback) progressCallback(5, `Large file detected. Will record ${Math.round(durationLimitSeconds/60)} minutes of audio in real-time...`);
    
    // Give user a moment to see the message
    await new Promise(r => setTimeout(r, 1000));
    
    try {
      const audioData = await extractAudioWithWebAudio(durationLimitSeconds, progressCallback);
      if (audioData && audioData.length > 1000) {
        console.log('[SubtitleEditor] Web Audio capture successful, got', audioData.length, 'bytes');
        State.partialTranscription = true;
        State.transcriptionDurationLimit = durationLimitSeconds;
        return audioData;
      } else {
        throw new Error('Captured audio too small');
      }
    } catch (e) {
      console.error('[SubtitleEditor] Web Audio extraction failed:', e);
      State.webAudioFailed = true; // Don't try again
      if (progressCallback) progressCallback(10, 'Real-time capture failed, trying FFmpeg...');
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

// Maximum file size we can reliably process in browser (in bytes)
// Beyond this, we need to use chunked reading or suggest alternatives
const MAX_FULL_READ_MB = 500; // 500MB for full file read
const MAX_PARTIAL_READ_MB = 2000; // 2GB - we can try partial extraction
const ABSOLUTE_MAX_MB = 4000; // 4GB - hard limit, browser won't handle this

async function generateSubtitles() {
  if (!State.videoFile) return;
  
  const fileSizeBytes = State.videoFile.size;
  const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024));
  const videoDuration = DOM.videoPlayer.duration || 0;
  console.log('[SubtitleEditor] Starting transcription, file size:', fileSizeMB, 'MB, duration:', videoDuration, 's');
  
  // For large files OR long videos, offer chunked mode
  // Chunked mode works with ANY file size because it only holds 10 seconds of audio at a time
  if (fileSizeMB > MAX_FULL_READ_MB || videoDuration > 120) {
    const choice = confirm(
      `This video is ${fileSizeMB > MAX_FULL_READ_MB ? 'large (' + fileSizeMB + ' MB)' : 'long (' + Math.round(videoDuration/60) + ' minutes)'}.\n\n` +
      `RECOMMENDED: Use "Chunked Mode" which processes 10 seconds at a time.\n` +
      `- Works with ANY file size\n` +
      `- Review each segment as you go\n` +
      `- Only holds 10 seconds of audio in memory\n\n` +
      `Click OK for Chunked Mode (recommended)\n` +
      `Click Cancel to try loading the whole video (may fail for large files)`
    );
    
    if (choice) {
      startChunkedTranscription();
      return;
    }
    
    // User chose to try loading whole file - warn if very large
    if (fileSizeMB > ABSOLUTE_MAX_MB) {
      alert(`File too large (${fileSizeMB} MB).\n\nPlease use Chunked Mode or a desktop tool.`);
      return;
    }
    
    if (fileSizeMB > MAX_PARTIAL_READ_MB) {
      const proceed = confirm(`File is very large (${fileSizeMB} MB).\n\nThis will likely fail. We'll try to extract just the first 5 minutes.\n\nContinue anyway?`);
      if (!proceed) return;
    }
  }
  
  DOM.generateBtn.disabled = true;
  showLoading('Generating Subtitles', 'Step 1: Loading Whisper model...');
  
  try {
    // Step 1: Load Whisper FIRST (before reading file, to keep file handle fresh)
    console.log('[SubtitleEditor] Step 1: Loading Whisper...');
    await initWhisper((progress, message) => {
      updateLoading(progress * 0.15, 'Loading Whisper: ' + message);
    });
    console.log('[SubtitleEditor] Whisper loaded successfully');
    
    // Step 2: Load FFmpeg
    updateLoading(15, 'Step 2: Loading FFmpeg...');
    console.log('[SubtitleEditor] Step 2: Loading FFmpeg...');
    if (!State.ffmpegLoaded) {
      await initFFmpeg();
    }
    console.log('[SubtitleEditor] FFmpeg loaded successfully');
    
    // Step 3: Read video file (with size-appropriate strategy)
    updateLoading(20, 'Step 3: Reading video file...');
    console.log('[SubtitleEditor] Step 3: Reading video file...');
    
    let videoData;
    let maxAudioDuration; // in seconds
    
    if (fileSizeMB <= MAX_FULL_READ_MB) {
      // Small file: read entire file
      console.log('[SubtitleEditor] Using full file read strategy');
      const videoBuffer = await State.videoFile.arrayBuffer();
      videoData = new Uint8Array(videoBuffer);
      maxAudioDuration = null; // no limit
    } else {
      // Large file: read in chunks up to a limit
      console.log('[SubtitleEditor] Using chunked read strategy for large file');
      const maxBytes = Math.min(fileSizeBytes, MAX_FULL_READ_MB * 1024 * 1024);
      maxAudioDuration = fileSizeMB > MAX_PARTIAL_READ_MB ? 300 : 600; // 5 or 10 minutes
      
      // Read file in chunks to be more memory-efficient
      const chunks = [];
      let bytesRead = 0;
      const chunkSize = 50 * 1024 * 1024; // 50MB chunks
      
      while (bytesRead < maxBytes) {
        const end = Math.min(bytesRead + chunkSize, maxBytes);
        const blob = State.videoFile.slice(bytesRead, end);
        const buffer = await blob.arrayBuffer();
        chunks.push(new Uint8Array(buffer));
        bytesRead = end;
        
        const pct = 20 + (bytesRead / maxBytes) * 15;
        updateLoading(pct, `Reading file: ${Math.round(bytesRead / (1024 * 1024))} MB / ${Math.round(maxBytes / (1024 * 1024))} MB`);
      }
      
      // Combine chunks
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      videoData = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        videoData.set(chunk, offset);
        offset += chunk.length;
      }
      
      console.log('[SubtitleEditor] Read', videoData.length, 'bytes (partial file)');
    }
    
    console.log('[SubtitleEditor] Video data ready:', videoData.length, 'bytes');
    
    // Step 4: Write to FFmpeg
    updateLoading(40, 'Step 4: Writing to FFmpeg...');
    console.log('[SubtitleEditor] Step 4: Writing to FFmpeg...');
    await State.ffmpeg.writeFile('input.mp4', videoData);
    
    // Free the videoData memory immediately
    videoData = null;
    console.log('[SubtitleEditor] Video written to FFmpeg, memory freed');
    
    // Step 5: Extract audio
    updateLoading(50, 'Step 5: Extracting audio...');
    console.log('[SubtitleEditor] Step 5: Extracting audio...');
    
    const ffmpegArgs = [
      '-i', 'input.mp4',
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1'
    ];
    
    // Add duration limit for large files
    if (maxAudioDuration) {
      ffmpegArgs.push('-t', String(maxAudioDuration));
      console.log('[SubtitleEditor] Limiting audio extraction to', maxAudioDuration, 'seconds');
    }
    
    ffmpegArgs.push('audio.wav');
    
    await State.ffmpeg.exec(ffmpegArgs);
    console.log('[SubtitleEditor] Audio extraction complete');
    
    // Delete input file immediately to free memory
    updateLoading(55, 'Freeing memory...');
    try {
      await State.ffmpeg.deleteFile('input.mp4');
      console.log('[SubtitleEditor] Input file deleted from FFmpeg');
    } catch (e) {
      console.warn('[SubtitleEditor] Could not delete input file:', e);
    }
    
    // Step 6: Read audio
    updateLoading(60, 'Step 6: Reading audio...');
    console.log('[SubtitleEditor] Step 6: Reading audio...');
    const audioData = await State.ffmpeg.readFile('audio.wav');
    console.log('[SubtitleEditor] Audio read:', audioData.length, 'bytes');
    
    // Delete audio file from FFmpeg
    try {
      await State.ffmpeg.deleteFile('audio.wav');
    } catch (e) {
      console.warn('[SubtitleEditor] Could not delete audio file:', e);
    }
    
    // Step 7: Convert to Float32
    updateLoading(70, 'Step 7: Processing audio data...');
    console.log('[SubtitleEditor] Step 7: Converting audio to float32...');
    
    // WAV header is 44 bytes, then 16-bit PCM samples
    const samples = new Int16Array(audioData.buffer, 44);
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      float32[i] = samples[i] / 32768.0;
    }
    console.log('[SubtitleEditor] Audio converted:', float32.length, 'samples,', (float32.length / 16000).toFixed(1), 'seconds');
    
    // Step 8: Transcribe
    updateLoading(80, 'Step 8: Transcribing with Whisper...');
    console.log('[SubtitleEditor] Step 8: Transcribing...');
    const result = await State.transcriber(float32, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5
    });
    console.log('[SubtitleEditor] Transcription result:', result);
    
    // Step 9: Process results
    updateLoading(90, 'Step 9: Creating subtitles...');
    console.log('[SubtitleEditor] Step 9: Processing results...');
    State.subtitles = processTranscriptionToSubtitles(result);
    console.log('[SubtitleEditor] Created', State.subtitles.length, 'subtitles');
    
    // Done
    renderSubtitleList();
    DOM.exportSection.style.display = 'block';
    updateLoading(100, 'Done!');
    
    // Show warning if we only transcribed part of the video
    if (maxAudioDuration) {
      setTimeout(() => {
        hideLoading();
        alert(`Transcription complete!\n\nNote: Due to the large file size, only the first ${Math.round(maxAudioDuration / 60)} minutes were transcribed.\n\nFor full transcription of large videos, consider using desktop tools like OpenAI Whisper, MacWhisper, or Buzz.`);
      }, 500);
    } else {
      setTimeout(hideLoading, 500);
    }
    
  } catch (error) {
    console.error('[SubtitleEditor] FAILED at some step:', error);
    console.error('[SubtitleEditor] Error stack:', error.stack);
    
    // Reset FFmpeg state if it crashed
    if (error.message && (error.message.includes('Aborted') || error.message.includes('memory'))) {
      console.log('[SubtitleEditor] Resetting FFmpeg due to crash');
      State.ffmpegLoaded = false;
      State.ffmpeg = null;
    }
    
    hideLoading();
    
    // Provide more helpful error messages
    let errorMsg = error.message || 'Unknown error';
    if (errorMsg.includes('NotReadableError') || errorMsg.includes('permission')) {
      errorMsg = 'Could not read the video file. This usually happens when:\n\n' +
        '1. The file was moved or deleted\n' +
        '2. Browser lost permission to access the file\n' +
        '3. The file is too large for browser memory\n\n' +
        'Please try selecting the file again, or use a smaller video.';
    } else if (errorMsg.includes('Aborted') || errorMsg.includes('memory')) {
      errorMsg = 'Browser ran out of memory.\n\n' +
        'This video is too large for browser-based processing.\n\n' +
        'Please try:\n' +
        '1. A smaller/compressed video\n' +
        '2. Desktop tools like OpenAI Whisper or MacWhisper';
    }
    
    alert('Transcription failed:\n\n' + errorMsg);
  } finally {
    DOM.generateBtn.disabled = false;
  }
}

// Chunk-by-chunk transcription using Web Speech API
const CHUNK_DURATION = 10; // 10 seconds per chunk

async function transcribeNextChunk() {
  const video = DOM.videoPlayer;
  const startTime = video.currentTime;
  const endTime = Math.min(startTime + CHUNK_DURATION, video.duration);
  
  // Check if we're done
  if (startTime >= video.duration - 0.5) {
    finishTranscription();
    return;
  }
  
  console.log(`[SubtitleEditor] Transcribing chunk: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`);
  
  // Show transcription UI
  showChunkTranscriptionUI(startTime, endTime);
  
  // Start speech recognition and video playback
  const result = await transcribeChunkWithSpeechAPI(startTime, endTime);
  
  // Show result for user review
  showChunkReviewUI(startTime, endTime, result);
}

function showChunkTranscriptionUI(startTime, endTime) {
  const totalDuration = DOM.videoPlayer.duration;
  const progress = (startTime / totalDuration) * 100;
  
  // Update loading modal for chunk transcription
  DOM.loadingTitle.textContent = 'Transcribing Video';
  DOM.loadingMessage.innerHTML = `
    <div style="text-align: center;">
      <p>Listening to audio... <strong>Please wait ${CHUNK_DURATION} seconds</strong></p>
      <p style="font-size: 0.9em; color: #888;">
        Chunk: ${formatTime(startTime)} - ${formatTime(endTime)} 
        (${Math.round(progress)}% complete)
      </p>
      <p style="font-size: 0.8em; color: #666; margin-top: 10px;">
        🎤 Using browser speech recognition
      </p>
    </div>
  `;
  DOM.loadingProgressFill.style.width = `${progress}%`;
  DOM.loadingPercent.textContent = `${Math.round(progress)}%`;
  DOM.loadingModal.style.display = 'flex';
}

async function transcribeChunkWithSpeechAPI(startTime, endTime) {
  return new Promise((resolve) => {
    const video = DOM.videoPlayer;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    
    let transcript = '';
    let recognitionEnded = false;
    
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript + ' ';
        }
      }
      console.log('[SubtitleEditor] Speech result:', transcript);
    };
    
    recognition.onerror = (event) => {
      console.warn('[SubtitleEditor] Speech recognition error:', event.error);
      // Continue even on error
    };
    
    recognition.onend = () => {
      recognitionEnded = true;
      console.log('[SubtitleEditor] Speech recognition ended');
    };
    
    // Seek to start position
    video.currentTime = startTime;
    
    // Wait for seek to complete
    video.onseeked = () => {
      video.onseeked = null;
      
      // Start recognition and playback together
      try {
        recognition.start();
      } catch (e) {
        console.warn('[SubtitleEditor] Could not start recognition:', e);
      }
      
      video.play();
      
      // Stop after chunk duration
      setTimeout(() => {
        video.pause();
        if (!recognitionEnded) {
          try {
            recognition.stop();
          } catch (e) {}
        }
        
        // Give a moment for final results
        setTimeout(() => {
          resolve(transcript.trim());
        }, 500);
      }, (endTime - startTime) * 1000);
    };
    
    // Trigger seek
    if (Math.abs(video.currentTime - startTime) < 0.1) {
      video.onseeked();
    }
  });
}

function showChunkReviewUI(startTime, endTime, transcript) {
  const totalDuration = DOM.videoPlayer.duration;
  const progress = (endTime / totalDuration) * 100;
  const isLastChunk = endTime >= totalDuration - 0.5;
  
  // Hide loading, show review dialog
  DOM.loadingModal.style.display = 'none';
  
  // Create review modal
  const reviewModal = document.createElement('div');
  reviewModal.className = 'modal-overlay';
  reviewModal.id = 'chunk-review-modal';
  reviewModal.innerHTML = `
    <div class="modal-content" style="max-width: 600px;">
      <h2>Review Transcription</h2>
      <p style="color: #888; margin-bottom: 15px;">
        ${formatTime(startTime)} - ${formatTime(endTime)} 
        (${Math.round(progress)}% of video)
      </p>
      
      <div style="margin-bottom: 15px;">
        <button id="chunk-replay-btn" class="secondary-btn" style="margin-right: 10px;">
          🔄 Replay Chunk
        </button>
        <span style="color: #666; font-size: 0.9em;">Listen again to verify</span>
      </div>
      
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Transcription:</label>
        <textarea id="chunk-transcript" rows="4" style="width: 100%; padding: 10px; font-size: 14px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: #fff;">${escapeHtml(transcript) || '(No speech detected)'}</textarea>
        <p style="color: #666; font-size: 0.8em; margin-top: 5px;">
          Edit the text if needed, or leave empty to skip this chunk.
        </p>
      </div>
      
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="chunk-skip-btn" class="secondary-btn">Skip Chunk</button>
        <button id="chunk-accept-btn" class="primary-btn">
          ${isLastChunk ? '✓ Finish' : '✓ Accept & Continue'}
        </button>
      </div>
      
      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #444;">
        <button id="chunk-stop-btn" style="background: none; border: none; color: #888; cursor: pointer; font-size: 0.9em;">
          ⏹ Stop transcription here (keep subtitles so far)
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(reviewModal);
  
  // Focus the textarea
  const textarea = document.getElementById('chunk-transcript');
  textarea.focus();
  textarea.select();
  
  // Replay button
  document.getElementById('chunk-replay-btn').onclick = () => {
    DOM.videoPlayer.currentTime = startTime;
    DOM.videoPlayer.play();
    setTimeout(() => {
      DOM.videoPlayer.pause();
    }, (endTime - startTime) * 1000);
  };
  
  // Skip button
  document.getElementById('chunk-skip-btn').onclick = () => {
    reviewModal.remove();
    DOM.videoPlayer.currentTime = endTime;
    transcribeNextChunk();
  };
  
  // Accept button
  document.getElementById('chunk-accept-btn').onclick = () => {
    const text = document.getElementById('chunk-transcript').value.trim();
    
    // Add subtitle if there's text
    if (text) {
      State.subtitles.push({
        id: State.nextSubtitleId++,
        start: startTime,
        end: endTime,
        text: text
      });
      renderSubtitleList();
    }
    
    reviewModal.remove();
    
    if (isLastChunk) {
      finishTranscription();
    } else {
      DOM.videoPlayer.currentTime = endTime;
      transcribeNextChunk();
    }
  };
  
  // Stop button
  document.getElementById('chunk-stop-btn').onclick = () => {
    reviewModal.remove();
    finishTranscription();
  };
}

function finishTranscription() {
  DOM.generateBtn.disabled = false;
  DOM.loadingModal.style.display = 'none';
  
  // Make sure list is rendered
  renderSubtitleList();
  
  if (State.subtitles.length > 0) {
    DOM.exportSection.style.display = 'block';
    alert(`Transcription complete! Created ${State.subtitles.length} subtitle(s).\n\nYou can now edit the timing and text, then export.`);
  } else {
    alert('No subtitles were created. You can add them manually using the + button.');
  }
  
  console.log('[SubtitleEditor] Transcription finished with', State.subtitles.length, 'subtitles');
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

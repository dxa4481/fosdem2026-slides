# Whisper Model Files for Offline Subtitles

This directory should contain the Whisper model files for offline speech recognition.

## Download Instructions

1. Visit: https://huggingface.co/Xenova/whisper-tiny.en/tree/main

2. Download the following files to this directory:
   - `config.json`
   - `tokenizer.json`
   - `tokenizer_config.json`
   - `preprocessor_config.json`
   - `generation_config.json`
   
3. Create an `onnx/` subdirectory and download:
   - `onnx/encoder_model_quantized.onnx` (or `encoder_model.onnx`)
   - `onnx/decoder_model_merged_quantized.onnx` (or `decoder_model_merged.onnx`)

## File Structure

After downloading, this directory should look like:

```
models/Xenova/whisper-tiny.en/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
├── preprocessor_config.json
├── generation_config.json
├── README.md (this file)
└── onnx/
    ├── encoder_model_quantized.onnx
    └── decoder_model_merged_quantized.onnx
```

## Usage

Once the model files are in place:
1. Open the presentation app
2. Enable "Offline Mode" toggle in the subtitle settings
3. Live subtitles will now work without internet connection

## Notes

- The quantized models (`*_quantized.onnx`) are smaller and faster
- First-time loading may take 10-30 seconds depending on your device
- The model runs entirely in your browser using WebAssembly

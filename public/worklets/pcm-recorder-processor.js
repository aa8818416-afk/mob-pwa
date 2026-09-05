/**
 * PCM Recorder Processor — AudioWorkletProcessor
 *
 * Runs entirely on the dedicated Audio Thread (not the UI main thread),
 * providing ultra-low-latency microphone capture identical to the
 * Google Gemini app experience.
 *
 * Responsibilities:
 *  - Receive raw Float32 samples from the microphone at the browser's native rate.
 *  - Resample to 16 000 Hz using linear interpolation.
 *  - Convert Float32 → Int16 Linear PCM.
 *  - Batch samples into 128ms chunks (2 048 samples @ 16kHz) before posting.
 *  - Compute RMS energy and post it for the UI visualiser (no DOM access needed).
 *  - Pre-Roll Circular Buffer & Barge-In Engine:
 *      When the model is speaking, keep the last ~384ms of audio in a circular
 *      buffer. If user voice energy breaks through (Barge-in), immediately flush
 *      the pre-roll frames so the first syllable ("Wait", "Question", etc.)
 *      is never clipped!
 *
 * Incoming port messages (from main thread → worklet):
 *   { type: "SET_MODEL_SPEAKING", value: boolean }
 *
 * Outgoing port messages (worklet → main thread):
 *   { type: "PCM_CHUNK",  buffer: Int16Array (Transferable) }
 *   { type: "VOLUME",     rms: number (0-1),  energy: number (0-1) }
 *   { type: "BARGE_IN" }
 */

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE_SAMPLES = 2048; // 128ms @ 16kHz
const PRE_ROLL_MAX_CHUNKS = 3;   // ~384ms audio memory for barge-in preservation

class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Accumulation buffer for resampled 16k samples
    this._buffer = new Float32Array(CHUNK_SIZE_SAMPLES * 2);
    this._bufferFill = 0;

    // Resampling state
    this._inputSampleRate = sampleRate; // global sampleRate from AudioWorkletGlobalScope
    this._resampleRatio = this._inputSampleRate / TARGET_SAMPLE_RATE;
    this._fractionalPos = 0; // fractional position in input stream

    // Echo ducking & Pre-roll state
    this._isModelSpeaking = false;
    this._bargeInThreshold = 0.07; // RMS threshold where human voice interrupts speaker bleed
    this._preRollBuffer = [];      // Circular buffer holding Int16Array chunks

    // Volume smoothing
    this._smoothedRms = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === "SET_MODEL_SPEAKING") {
        this._isModelSpeaking = event.data.value;
        if (!this._isModelSpeaking) {
          this._preRollBuffer = [];
        }
      }
    };
  }

  /**
   * Linear interpolation resampler.
   * Converts a 128-sample AudioWorklet render quantum from the native rate → 16kHz.
   */
  _resampleChunk(input) {
    const outputLength = Math.floor(input.length / this._resampleRatio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcPos = (i + this._fractionalPos) * this._resampleRatio;
      const srcIndex = Math.floor(srcPos);
      const frac = srcPos - srcIndex;

      const s0 = srcIndex < input.length ? input[srcIndex] : 0;
      const s1 = srcIndex + 1 < input.length ? input[srcIndex + 1] : s0;
      output[i] = s0 + frac * (s1 - s0);
    }

    // Update fractional position for continuity across render quanta
    this._fractionalPos =
      ((this._fractionalPos + outputLength) * this._resampleRatio - input.length) /
      this._resampleRatio;

    if (this._fractionalPos < 0) this._fractionalPos = 0;

    return output;
  }

  /** Compute RMS energy of a Float32 buffer */
  _computeRms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // keep processor alive

    const rawSamples = input[0]; // Float32Array, 128 samples

    // ── RMS Volume (for UI visualiser) ─────────────────────────────────
    const rms = this._computeRms(rawSamples);
    this._smoothedRms = this._smoothedRms * 0.85 + rms * 0.15; // smoothed
    const energy = Math.min(1, this._smoothedRms * 8);          // normalised 0-1

    this.port.postMessage({ type: "VOLUME", rms: this._smoothedRms, energy });

    // ── Resample to 16kHz ─────────────────────────────────────────────
    const resampled = this._resampleChunk(rawSamples);

    // ── Accumulate into batch buffer ──────────────────────────────────
    for (let i = 0; i < resampled.length; i++) {
      this._buffer[this._bufferFill++] = resampled[i];

      if (this._bufferFill >= CHUNK_SIZE_SAMPLES) {
        // ── Convert Float32 → Int16 PCM ────────────────────────────
        const pcm16 = new Int16Array(CHUNK_SIZE_SAMPLES);
        for (let j = 0; j < CHUNK_SIZE_SAMPLES; j++) {
          const s = Math.max(-1, Math.min(1, this._buffer[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Reset accumulation
        this._bufferFill = 0;

        // ── Check Model Speaking / Barge-In Logic ─────────────────
        if (this._isModelSpeaking) {
          // If speaker output is active, check if user's microphone RMS breaks through
          if (this._smoothedRms >= this._bargeInThreshold) {
            // User interrupted the model!
            this.port.postMessage({ type: "BARGE_IN" });

            // Flush all pre-roll frames immediately so first syllable is intact
            while (this._preRollBuffer.length > 0) {
              const preChunk = this._preRollBuffer.shift();
              this.port.postMessage(
                { type: "PCM_CHUNK", buffer: preChunk.buffer },
                [preChunk.buffer]
              );
            }

            // Post current chunk
            this.port.postMessage(
              { type: "PCM_CHUNK", buffer: pcm16.buffer },
              [pcm16.buffer]
            );
          } else {
            // Low volume (speaker bleed) — save in circular pre-roll buffer
            this._preRollBuffer.push(pcm16);
            if (this._preRollBuffer.length > PRE_ROLL_MAX_CHUNKS) {
              this._preRollBuffer.shift();
            }
          }
        } else {
          // Model is silent: stream audio immediately without delay
          this._preRollBuffer = [];
          this.port.postMessage(
            { type: "PCM_CHUNK", buffer: pcm16.buffer },
            [pcm16.buffer] // transfer ownership — zero-copy
          );
        }
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor("pcm-recorder-processor", PCMRecorderProcessor);

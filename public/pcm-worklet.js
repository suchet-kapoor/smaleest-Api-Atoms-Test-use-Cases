/**
 * Captures microphone audio in 20 ms frames and posts Float32Array buffers
 * to the main thread. Runs at whatever sample rate the AudioContext gave us;
 * app.js resamples to 24 kHz before sending.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.max(128, Math.round(sampleRate * 0.02)); // 20 ms
    this.frame = new Float32Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const length = input[0].length;

    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i] || 0;
      this.frame[this.offset++] = sample / channels;

      if (this.offset === this.frameSize) {
        const out = this.frame;
        this.port.postMessage(out, [out.buffer]);
        this.frame = new Float32Array(this.frameSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);

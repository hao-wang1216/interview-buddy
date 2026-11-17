class PcmWorklet extends AudioWorkletProcessor {
  frame = new Int16Array(640);
  length = 0;

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.frame[this.length++] = sample * (sample < 0 ? 32768 : 32767);
      if (this.length === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(640);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('buddy-pcm', PcmWorklet);

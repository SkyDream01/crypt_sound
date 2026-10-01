// SPDX-License-Identifier: GPL-3.0-only
// This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.data = new Float32Array(8192); this.pos = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const left = channels[0], right = channels[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.data[this.pos++] = left[i]; this.data[this.pos++] = right[i];
      if (this.pos === this.data.length) {
        this.port.postMessage(this.data.buffer, [this.data.buffer]);
        this.data = new Float32Array(8192); this.pos = 0;
      }
    }
    return true; // Outputs stay silent; decoded playback happens in a separate tab.
  }
}
registerProcessor('capture', Capture);

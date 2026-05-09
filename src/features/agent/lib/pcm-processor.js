class PCMProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const input = inputs[0];
		if (!input || input.length === 0) return true;

		const channelData = input[0];
		if (!channelData || channelData.length === 0) return true;

		// Compute peak amplitude from raw Float32 samples (0–1 range)
		let peak = 0;
		const pcm = new Int16Array(channelData.length);
		for (const [index, channelDatum] of channelData.entries()) {
			const s = Math.max(-1, Math.min(1, channelDatum));
			pcm[index] = s < 0 ? s * 0x80_00 : s * 0x7f_ff;
			const abs = s < 0 ? -s : s;
			if (abs > peak) peak = abs;
		}

		this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
		return true;
	}
}

registerProcessor('pcm-processor', PCMProcessor);

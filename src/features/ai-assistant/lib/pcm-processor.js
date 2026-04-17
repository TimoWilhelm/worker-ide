class PCMProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const input = inputs[0];
		if (!input || input.length === 0) return true;

		const channelData = input[0];
		if (!channelData || channelData.length === 0) return true;

		// Compute peak amplitude from raw Float32 samples (0–1 range)
		let peak = 0;
		const pcm = new Int16Array(channelData.length);
		for (let i = 0; i < channelData.length; i++) {
			const s = Math.max(-1, Math.min(1, channelData[i]));
			pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
			const abs = s < 0 ? -s : s;
			if (abs > peak) peak = abs;
		}

		this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
		return true;
	}
}

registerProcessor('pcm-processor', PCMProcessor);

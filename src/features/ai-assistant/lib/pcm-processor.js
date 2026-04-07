/**
 * PCM Audio Worklet Processor
 *
 * Captures raw audio from the microphone, converts Float32 samples to
 * Int16 linear PCM, and posts the binary buffer to the main thread.
 * The main thread then forwards it over WebSocket to the STT proxy.
 *
 * Registered as 'pcm-processor' in the AudioWorklet scope.
 */

class PCMProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const input = inputs[0];
		if (!input || input.length === 0) return true;

		const channelData = input[0];
		if (!channelData || channelData.length === 0) return true;

		const pcm = new Int16Array(channelData.length);
		for (let i = 0; i < channelData.length; i++) {
			const s = Math.max(-1, Math.min(1, channelData[i]));
			pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}

		this.port.postMessage(pcm.buffer, [pcm.buffer]);
		return true;
	}
}

registerProcessor('pcm-processor', PCMProcessor);

// Real-time canvas recording with MediaRecorder. The player plays the reel once
// at 1× while this captures the canvas; the result is saved as a file.

const TYPES = [
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
  ['video/mp4;codecs=avc1', 'mp4'],
  ['video/mp4', 'mp4'],
];

/** { mime, ext } for the best container this browser can record, or null. */
export function recordingSupport(canvas) {
  if (typeof window.MediaRecorder !== 'function' || !canvas || typeof canvas.captureStream !== 'function') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return null;
  for (const [mime, ext] of TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
    } catch {
      // Some browsers throw on unknown codec strings; try the next one.
    }
  }
  return null;
}

/**
 * Start capturing `canvas`. Returns { done, pause, resume, stop }: `done`
 * resolves with the recorded Blob once stop() has flushed the last chunk.
 */
export function startRecording(canvas, { mime, fps = 60, bitrate = 12e6, audio = null } = {}) {
  const stream = canvas.captureStream(fps);
  // With sound on, the soundtrack rides along as an Opus/AAC track.
  let type = mime;
  if (audio) {
    audio.getAudioTracks().forEach((track) => stream.addTrack(track));
    const withAudio = mime.startsWith('video/webm') ? `${mime.split(';')[0]};codecs=${mime.includes('vp8') ? 'vp8' : 'vp9'},opus` : mime;
    if (MediaRecorder.isTypeSupported(withAudio)) type = withAudio;
    else if (MediaRecorder.isTypeSupported(mime.split(';')[0])) type = mime.split(';')[0];
  }
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitrate, audioBitsPerSecond: 160e3 });
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    throw err;
  }
  const chunks = [];
  const release = () => stream.getTracks().forEach((track) => track.stop());
  const done = new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      release();
      resolve(new Blob(chunks, { type: mime.split(';')[0] }));
    };
    recorder.onerror = (e) => {
      release();
      reject(e.error || new Error('the recorder stopped unexpectedly'));
    };
  });
  recorder.start(1000);
  return {
    done,
    pause() {
      if (recorder.state === 'recording') recorder.pause();
    },
    resume() {
      if (recorder.state === 'paused') recorder.resume();
    },
    stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      return done;
    },
  };
}

/** Hand a Blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// The live soundtrack, kept in step with the playhead. Off until the viewer
// turns it on (browsers only start audio after a gesture). It plays at 1×
// only: paused, scrubbing or at other speeds it falls silent, and it restarts
// in place after a seek, a loop wrap or any drift beyond a few frames.

import { createLiveAudio } from '../engine/index.js';

const MAX_DRIFT = 0.12; // seconds between picture and sound before resyncing

export function createSound(reel) {
  const live = createLiveAudio(() => reel.score());
  let enabled = false;
  let running = false;

  return {
    get available() {
      return live.available;
    },
    get enabled() {
      return enabled;
    },
    /** Turn sound on or off. Call from a click or key handler. */
    async setEnabled(on) {
      if (on) {
        enabled = await live.unlock();
      } else {
        enabled = false;
        live.stop();
        running = false;
      }
      return enabled;
    },
    /** Call after every playback change and on each frame while playing. */
    follow({ t, playing, speed, recording }) {
      const want = enabled && playing && (recording || speed === 1);
      if (!want) {
        if (running) {
          live.stop();
          running = false;
        }
        return;
      }
      const pos = live.position();
      if (!running || pos === null || Math.abs(pos - t) > MAX_DRIFT) {
        live.start(t);
        running = true;
      }
    },
    /**
     * While sound plays it is the master clock: the score time being heard,
     * which the picture follows. Null when sound isn't driving playback.
     */
    clock() {
      return running ? live.position() : null;
    },
    /** The mix as a MediaStream for recording, or null when sound is off. */
    captureStream() {
      return enabled ? live.captureStream() : null;
    },
    /** The score changed (new title or seed): rebuild the voices in place. */
    restart(t) {
      if (running) live.start(t);
    },
  };
}

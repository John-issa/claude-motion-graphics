// Procedural sound. A score is a deterministic, time-sorted list of events
// (see score.js); this module synthesizes them with Web Audio, either live,
// scheduled against the player's playhead, or offline into a buffer for
// export. Nothing here runs at import time, so it is safe to import in Node.

import { mulberry32 } from './random.js';

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** How long each event type sounds, from its start (seconds). */
export function eventLength(ev) {
  switch (ev.type) {
    case 'pad':
    case 'sub':
      return ev.dur + (ev.release ?? 1.6);
    case 'bell':
      return ev.decay ?? 2.6;
    case 'pluck':
      return ev.decay ?? 0.7;
    case 'kick':
      return 0.45;
    case 'tick':
      return 0.06;
    case 'whoosh':
      return ev.dur + 0.1;
    case 'impact':
      return 1.6;
    default:
      return 1;
  }
}

const noiseCache = new WeakMap();

/** Two seconds of seeded white noise per audio context. */
function noiseBuffer(ac) {
  let buf = noiseCache.get(ac);
  if (buf) return buf;
  buf = ac.createBuffer(1, Math.round(ac.sampleRate * 2), ac.sampleRate);
  const data = buf.getChannelData(0);
  const rnd = mulberry32(0x5eed);
  for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
  noiseCache.set(ac, buf);
  return buf;
}

/** Seeded stereo impulse response: a plain, smooth room for the reverb send. */
function impulseResponse(ac, seconds = 2.4, decay = 3.2) {
  const len = Math.round(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const rnd = mulberry32(0xa11ce + ch * 7919);
    for (let i = 0; i < len; i++) {
      const x = i / len;
      // Quick fade-in avoids a click; exponential tail.
      const env = Math.min(1, i / (ac.sampleRate * 0.01)) * Math.pow(1 - x, decay);
      data[i] = (rnd() * 2 - 1) * env;
    }
  }
  return buf;
}

/**
 * Master bus: dry and reverb sends into a gentle compressor and a limiter-ish
 * final compressor, so dense moments never clip.
 */
export function createMaster(ac, destination = ac.destination, level = 0.8) {
  const input = ac.createGain();
  const reverbSend = ac.createGain();
  const reverb = ac.createConvolver();
  reverb.buffer = impulseResponse(ac);
  const reverbReturn = ac.createGain();
  reverbReturn.gain.value = 0.32;
  const glue = ac.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 12;
  glue.ratio.value = 3;
  glue.attack.value = 0.01;
  glue.release.value = 0.25;
  const limit = ac.createDynamicsCompressor();
  limit.threshold.value = -3;
  limit.knee.value = 0;
  limit.ratio.value = 20;
  limit.attack.value = 0.002;
  limit.release.value = 0.1;
  const output = ac.createGain();
  output.gain.value = level;
  input.connect(glue);
  reverbSend.connect(reverb);
  reverb.connect(reverbReturn);
  reverbReturn.connect(glue);
  glue.connect(limit);
  limit.connect(output);
  output.connect(destination);
  return { input, reverbSend, output };
}

/** Exponential-ish envelope helper that tolerates starting part-way through. */
function envelope(param, when, { peak, attack, hold = 0, release, from = 0 }) {
  const start = when - from; // virtual start time (may be in the past)
  const atkEnd = start + attack;
  const relStart = atkEnd + hold;
  const end = relStart + release;
  const levelAt = (x) => {
    if (x <= start) return 0;
    if (x < atkEnd) return peak * ((x - start) / attack);
    if (x < relStart) return peak;
    if (x < end) return peak * Math.pow(1 - (x - relStart) / release, 2);
    return 0;
  };
  param.cancelScheduledValues(when);
  param.setValueAtTime(levelAt(when), when);
  if (when < atkEnd) param.linearRampToValueAtTime(peak, atkEnd);
  if (when < relStart) param.setValueAtTime(peak, Math.max(when, relStart));
  // A few linear segments approximate the squared release curve.
  const steps = 6;
  for (let k = 1; k <= steps; k++) {
    const x = relStart + (release * k) / steps;
    if (x > when) param.linearRampToValueAtTime(levelAt(x), x);
  }
  return end;
}

function panner(ac, pan, dest) {
  if (!pan || !ac.createStereoPanner) return dest;
  const p = ac.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(dest);
  return p;
}

/**
 * Start one event. `when` is the context time at which the event's own time
 * zero falls, and `offset` (≥ 0) how far into the event playback begins.
 * Returns the nodes to stop when playback is interrupted.
 */
function playEvent(ac, bus, ev, when, offset = 0) {
  const t0 = when + offset; // context time at which sound actually begins
  const nodes = [];
  const out = ac.createGain();
  out.gain.value = 1;
  const dest = panner(ac, ev.pan, out);
  out.connect(bus.input);
  if (ev.send) {
    const send = ac.createGain();
    send.gain.value = ev.send;
    out.connect(send);
    send.connect(bus.reverbSend);
  }
  const osc = (type, freq, detune = 0) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.detune.value = detune;
    nodes.push(o);
    return o;
  };
  const noise = () => {
    const s = ac.createBufferSource();
    s.buffer = noiseBuffer(ac);
    s.loop = true;
    nodes.push(s);
    return s;
  };

  let end = t0 + eventLength(ev) - offset;
  switch (ev.type) {
    case 'pad': {
      // Two cascaded low-passes (24 dB/octave) keep the saw stack warm
      // rather than buzzy; a slow upward filter drift adds a little life.
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.5;
      const cutoff = ev.cutoff ?? 650;
      filter.frequency.setValueAtTime(cutoff * 0.8, t0);
      filter.frequency.linearRampToValueAtTime(cutoff * 1.15, t0 + Math.max(0.5, ev.dur - offset));
      const filter2 = ac.createBiquadFilter();
      filter2.type = 'lowpass';
      filter2.Q.value = 0.3;
      filter2.frequency.value = cutoff * 1.6;
      const amp = ac.createGain();
      filter.connect(filter2);
      filter2.connect(amp);
      amp.connect(dest);
      for (const n of ev.notes) {
        for (const det of [-7, 7]) {
          const o = osc('sawtooth', midiToHz(n), det);
          const g = ac.createGain();
          g.gain.value = 0.5 / ev.notes.length;
          o.connect(g);
          g.connect(filter);
        }
      }
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: ev.attack ?? 1.2, hold: Math.max(0, ev.dur - (ev.attack ?? 1.2)), release: ev.release ?? 1.6, from: offset });
      break;
    }
    case 'sub': {
      const o = osc('sine', midiToHz(ev.note));
      const amp = ac.createGain();
      o.connect(amp);
      amp.connect(dest);
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: ev.attack ?? 0.6, hold: Math.max(0, ev.dur - (ev.attack ?? 0.6)), release: ev.release ?? 1.2, from: offset });
      break;
    }
    case 'pluck': {
      const f = midiToHz(ev.note);
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(ev.bright ?? 2800, t0);
      const amp = ac.createGain();
      const a = osc('triangle', f);
      const b = osc('sine', f * 2);
      const bg = ac.createGain();
      bg.gain.value = 0.3;
      a.connect(filter);
      b.connect(bg);
      bg.connect(filter);
      filter.connect(amp);
      amp.connect(dest);
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: 0.004, release: (ev.decay ?? 0.7) - 0.004, from: offset });
      break;
    }
    case 'bell': {
      const f = midiToHz(ev.note);
      const carrier = osc('sine', f);
      const mod = osc('sine', f * (ev.ratio ?? 3.5));
      const index = ac.createGain();
      index.gain.setValueAtTime(f * 1.6, t0);
      index.gain.exponentialRampToValueAtTime(f * 0.02, t0 + 1.2);
      mod.connect(index);
      index.connect(carrier.frequency);
      const amp = ac.createGain();
      carrier.connect(amp);
      amp.connect(dest);
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: 0.003, release: (ev.decay ?? 2.6) - 0.003, from: offset });
      break;
    }
    case 'kick': {
      const o = osc('sine', 150);
      o.frequency.setValueAtTime(150, t0);
      o.frequency.exponentialRampToValueAtTime(44, t0 + 0.14);
      const amp = ac.createGain();
      o.connect(amp);
      amp.connect(dest);
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: 0.002, release: 0.42, from: offset });
      break;
    }
    case 'tick': {
      const s = noise();
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = ev.freq ?? 6000;
      const amp = ac.createGain();
      s.connect(hp);
      hp.connect(amp);
      amp.connect(dest);
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: 0.001, release: 0.045, from: offset });
      break;
    }
    case 'whoosh': {
      const s = noise();
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.9;
      const f0 = ev.f0 ?? 300;
      const f1 = ev.f1 ?? 5000;
      bp.frequency.setValueAtTime(f0, t0);
      bp.frequency.exponentialRampToValueAtTime(f1, t0 + ev.dur);
      const amp = ac.createGain();
      s.connect(bp);
      bp.connect(amp);
      amp.connect(dest);
      end = envelope(amp.gain, t0, { peak: ev.gain, attack: ev.dur * 0.75, release: ev.dur * 0.25 + 0.08, from: offset });
      break;
    }
    case 'impact': {
      // Body: a pitched-down sine thump; air: a short low-passed noise burst.
      const o = osc('sine', 110);
      o.frequency.setValueAtTime(110, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.3);
      const body = ac.createGain();
      o.connect(body);
      body.connect(dest);
      envelope(body.gain, t0, { peak: ev.gain, attack: 0.003, release: 1.4, from: offset });
      const s = noise();
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      const air = ac.createGain();
      s.connect(lp);
      lp.connect(air);
      air.connect(dest);
      envelope(air.gain, t0, { peak: ev.gain * 0.35, attack: 0.002, release: 0.3, from: offset });
      break;
    }
    default:
      break;
  }
  for (const n of nodes) {
    n.start(t0);
    n.stop(end + 0.05);
  }
  return { nodes, out, end };
}

/**
 * Schedule every event of `score` that sounds within [from, to) of score
 * time, with score time `from` landing on context time `when`.
 */
export function scheduleScore(ac, bus, score, { from = 0, to = Infinity, when = ac.currentTime } = {}) {
  const voices = [];
  for (const ev of score.events) {
    if (ev.t >= to) break;
    const len = eventLength(ev);
    if (ev.t + len <= from) continue;
    const offset = Math.max(0, from - ev.t);
    // Percussive events already under way are skipped rather than clipped.
    if (offset > 0 && ev.type !== 'pad' && ev.type !== 'sub' && ev.type !== 'bell') continue;
    voices.push(playEvent(ac, bus, ev, when + (ev.t - from), offset));
  }
  return voices;
}

/** Render [from, to) of a score to an AudioBuffer (OfflineAudioContext). */
export async function renderScoreOffline(score, { from = 0, to = score.duration, sampleRate = 48000 } = {}) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext is not available');
  const length = Math.max(1, Math.ceil((to - from) * sampleRate));
  const ac = new Ctx(2, length, sampleRate);
  const bus = createMaster(ac);
  scheduleScore(ac, bus, score, { from, to, when: 0 });
  return ac.startRendering();
}

/** 16-bit PCM WAV bytes for an AudioBuffer. */
export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return view.buffer;
}

/**
 * Live playback that follows a playhead. Call start(t) when playback begins
 * or jumps (at 1×), stop() when it pauses, seeks or changes speed. Sound only
 * starts after a user gesture (browsers require it), so unlock() must be
 * called from a click or key handler first.
 */
export function createLiveAudio(getScore) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  let ac = null;
  let bus = null;
  let voices = [];
  let timer = 0;
  let scheduledUntil = 0;
  let anchor = null; // { scoreT, ctxT }

  const LOOKAHEAD = 0.6;

  let firstPump = false;

  function pump() {
    if (!anchor) return;
    const score = getScore();
    const nowScore = anchor.scoreT + (ac.currentTime - anchor.ctxT);
    const until = Math.min(score.duration, nowScore + LOOKAHEAD);
    if (until > scheduledUntil) {
      // The first window also picks up sustained events already under way;
      // later windows take only events that start inside them.
      const events = firstPump ? score.events : score.events.filter((e) => e.t >= scheduledUntil);
      firstPump = false;
      const fresh = scheduleScore(ac, bus, { duration: score.duration, events }, {
        from: scheduledUntil,
        to: until,
        when: anchor.ctxT + (scheduledUntil - anchor.scoreT),
      });
      voices.push(...fresh);
      scheduledUntil = until;
    }
    const now = ac.currentTime;
    voices = voices.filter((v) => v.end > now);
  }

  return {
    get available() {
      return !!Ctx;
    },
    get unlocked() {
      return !!ac && ac.state === 'running';
    },
    /** Create or resume the context; call from a user gesture. */
    async unlock() {
      if (!Ctx) return false;
      // iOS mutes Web Audio under the silent switch unless the page says it
      // is playing media (Audio Session API, Safari 16.4+). Sound here only
      // ever starts from the viewer's own tap, so that is what this is.
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        // not supported: nothing to do
      }
      if (!ac) {
        ac = new Ctx({ latencyHint: 'interactive' });
        bus = createMaster(ac);
      }
      if (ac.state !== 'running') await ac.resume().catch(() => {});
      return ac.state === 'running';
    },
    start(t) {
      if (!ac || ac.state !== 'running') return;
      this.stop();
      const ctxT = ac.currentTime + 0.05;
      anchor = { scoreT: t, ctxT };
      scheduledUntil = t;
      firstPump = true;
      pump();
      timer = setInterval(pump, 100);
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      anchor = null;
      if (!ac) return;
      const now = ac.currentTime;
      for (const v of voices) {
        try {
          v.out.gain.cancelScheduledValues(now);
          v.out.gain.setValueAtTime(v.out.gain.value, now);
          v.out.gain.linearRampToValueAtTime(0, now + 0.06);
          for (const n of v.nodes) n.stop(now + 0.08);
        } catch {
          // already stopped
        }
      }
      voices = [];
    },
    async suspend() {
      this.stop();
      if (ac && ac.state === 'running') await ac.suspend().catch(() => {});
    },
    /**
     * Score time being heard right now, or null when stopped. Output latency
     * is subtracted so a picture following this clock matches the sound.
     */
    position() {
      if (!anchor || !ac) return null;
      const latency = (ac.outputLatency || 0) + (ac.baseLatency || 0);
      return anchor.scoreT + Math.max(0, ac.currentTime - anchor.ctxT - latency);
    },
    /**
     * A fresh MediaStream carrying the mix, for recording alongside the canvas.
     * Returns { stream, release } or null before unlock().
     */
    captureStream() {
      if (!ac || typeof ac.createMediaStreamDestination !== 'function') return null;
      const dest = ac.createMediaStreamDestination();
      bus.output.connect(dest);
      return {
        stream: dest.stream,
        release() {
          try {
            bus.output.disconnect(dest);
          } catch {
            // already disconnected
          }
        },
      };
    },
  };
}

// Liquid Metal: raymarched chrome metaballs with thin-film iridescence.
//
// A GLSL fragment shader sphere-traces a smooth union of six spheres. Their
// centres and radii are computed here, in closed form from s.t, and handed
// over as a uniform array, so the scene scrubs and sub-samples like any other.
// Everything around the metal (background, caption, fallback) is Canvas 2D.

import {
  defineScene,
  kf,
  seg,
  ease,
  spring,
  font,
  layoutGlyphs,
  palette,
  rgba,
  mix,
  lerp,
  clamp01,
} from '../engine/index.js';

const DUR = 7.0;
const STEPS = 96; // sphere-tracing budget per pixel (most rays exit far earlier)
const K = 0.55; // smooth-minimum blend radius, world units
const CORE_R = 0.8;
const FINAL_R = 1.2; // the merged sphere
const FOCAL = 2.8; // ~40° vertical field of view: a product-shot lens

// Satellites. r: radius · gap: surface gap when fully split · spin: orbit speed
// (rad/s) · a0: start angle · tilt/roll: orbit plane · wob/harm/ph: the
// vertical harmonic that turns each orbit into a 3D Lissajous · lag: stagger (s).
const SATS = [
  { r: 0.5, gap: 0.46, spin: 0.55, a0: 3.6, tilt: 0.4, roll: 0.12, wob: 0.2, harm: 2, ph: 0.0, lag: 0.0 },
  { r: 0.42, gap: 0.42, spin: -0.62, a0: 1.9, tilt: -0.3, roll: 0.3, wob: 0.18, harm: 3, ph: 1.1, lag: 0.06 },
  { r: 0.37, gap: 0.5, spin: 0.7, a0: 3.2, tilt: 0.5, roll: -0.25, wob: 0.22, harm: 2, ph: 2.0, lag: 0.12 },
  { r: 0.33, gap: 0.44, spin: -0.52, a0: 4.4, tilt: -0.45, roll: -0.1, wob: 0.15, harm: 3, ph: 0.6, lag: 0.18 },
  { r: 0.28, gap: 0.54, spin: 0.78, a0: 5.4, tilt: 0.2, roll: 0.22, wob: 0.2, harm: 2, ph: 2.7, lag: 0.24 },
];

// The merge/split rhythm: 0 = drops absorbed into the core, 1 = fully split.
// Two cycles on a 1.6 s beat, the second faster, deeper and wider than the
// first; then a breath in, and a pull-back that hangs before the plunge.
const SPREAD = [
  [0.0, 0.5],
  [0.75, 1.0, 'outCubic'],
  [1.55, 0.04, 'inOutCubic'], // merge 1: an even gather
  [2.35, 1.05, 'outBack'], // split 1
  [2.55, 1.0, 'inOutSine'],
  [3.15, 0.0, 'inQuart'], // merge 2: the drops snap in
  [3.3, 0.0], // gulp
  [3.95, 1.35, 'outBack'], // split 2: flung wider
  [4.35, 1.25, 'inOutSine'],
  [4.95, 1.6, 'inOutSine'], // wind-up: pull back and hang, a pendulum at its apex
];

const grow = spring({ stiffness: 90, damping: 8.5 }); // core inflating as it swallows the drops

/**
 * Orbit clock: real time, except that the orbits slow almost to a stop at the
 * wind-up's apex (4.95 s), like a pendulum, before the plunge releases them.
 * Closed form: t minus the integral of a smoothstep-up, smoothstep-down dip.
 */
function orbitClock(t, a = 4.45, b = 4.95, c = 5.45, depth = 0.85) {
  const up = (u) => u * u * u - (u * u * u * u) / 2; // ∫ smoothstep over [0, u]
  let lost = 0;
  if (t > a) lost += (b - a) * up(Math.min(1, (t - a) / (b - a)));
  if (t > b) {
    const v = Math.min(1, (t - b) / (c - b));
    lost += (c - b) * (v - up(v));
  }
  return t - depth * lost;
}

// Small vector helpers (arrays of 3).
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Orthonormal frame [c, u, v] for a rectangular emitter facing direction c. */
function emitter(dir) {
  const c = norm(dir);
  const u = norm(cross([0, 1, 0], c));
  const v = cross(c, u);
  return [c, u, v];
}
const glsl3 = (v) => `vec3(${v.map((x) => x.toFixed(5)).join(', ')})`;
const box = ([c, u, v]) => `${glsl3(c)}, ${glsl3(u)}, ${glsl3(v)}`;

// Studio lights as directions from the subject (y up, camera on +z). The key
// is animated (it leaves at the end), so it arrives as uniforms.
const TOP = emitter([0.0, 1.0, 0.25]);
const CARD = emitter([0.55, -0.45, 0.8]); // floor card front-right: a fill that breaks the symmetry
const RIM = emitter([0.92, 0.2, -0.38]);
const SUN = norm([0.7, 0.45, 0.55]); // tiny, hard catch-light

const FRAG = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vUv;
uniform vec2 uResolution;
uniform vec4 uBall[6];    // xyz centre, w radius
uniform float uK;         // smooth-min radius
uniform float uPad;       // bounding-sphere padding: covers the smooth-min bulge
uniform float uWob;       // squash-and-stretch of the core (P2 mode)
uniform vec3 uRo, uFwd, uRight, uUp;
uniform float uFocal;
uniform vec3 uKeyC, uKeyU, uKeyV;
uniform vec3 uLights;     // key, strip, studio (dome, horizon, floor)
uniform float uFilm;      // thin-film thickness drift

const int STEPS = ${STEPS};

// Polynomial smooth minimum (quadratic): blends two fields within radius k.
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// The field: the core, squashed and stretched by a P2 term (divided by the
// slope it adds, so it stays a safe bound for tracing), smooth-unioned with
// the five satellites.
float map(vec3 p) {
  vec3 q = p - uBall[0].xyz;
  float l = max(length(q), 1e-3);
  float y = q.y / l;
  float d = (l - uBall[0].w - uWob * (1.5 * y * y - 0.5)) / (1.0 + 1.5 * abs(uWob) / uBall[0].w);
  for (int i = 1; i < 6; i++) d = smin(d, length(p - uBall[i].xyz) - uBall[i].w, uK);
  return d;
}

// Tetrahedral gradient: four taps instead of six.
vec3 normalAt(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0015;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
                   e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

// Cheap ambient occlusion: how much closer the field is than the open normal.
float occlusion(vec3 p, vec3 n) {
  float occ = 0.0, w = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.04 + 0.11 * float(i);
    occ += (h - map(p + n * h)) * w;
    w *= 0.72;
  }
  return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
}

// Soft rectangular emitter in direction space (gnomonic projection around c).
float softbox(vec3 d, vec3 c, vec3 u, vec3 v, vec2 size, float soft) {
  float z = dot(d, c);
  if (z <= 0.0) return 0.0;
  vec2 q = vec2(dot(d, u), dot(d, v)) / z;
  vec2 e = abs(q) - size;
  float dist = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, dist);
}

// A night studio, only ever seen in reflection: a navy dome that lifts toward
// a crisp horizon seam with a soft glow around it, a floor lit from the front
// with a card on it front-right (so lower halves carry a gradient, not a
// void), a big overhead softbox, a portrait key front-left and a thin strip
// light behind-right that draws the silhouette. Chrome reads through this
// value range: dark gaps between bright, sharp shapes.
// blur (radians) widens every sharp edge by the reflected pixel cone, a
// prefiltered lookup, so grazing reflections don't sparkle.
vec3 env(vec3 d, float blur) {
  float y = d.y;
  vec3 sky = mix(vec3(0.050, 0.056, 0.130), vec3(0.012, 0.014, 0.036), sqrt(clamp(y, 0.0, 1.0)));
  float front = 0.5 + 0.5 * d.z;
  vec3 flo = vec3(0.004, 0.005, 0.012) + vec3(0.16, 0.16, 0.40) * front * exp(min(y, 0.0) * 3.0);
  vec3 col = mix(flo, sky, smoothstep(-0.01 - blur, 0.01 + blur, y));
  col += vec3(0.35, 0.40, 0.70) * 0.30 * exp(-abs(y) * 14.0);
  float seam = 0.0083 + blur;                  // widened at constant energy
  col += vec3(0.70, 0.76, 1.00) * 0.45 * (0.0083 / seam) * exp(-abs(y - 0.004) / seam);
  col += vec3(0.62, 0.55, 1.00) * 0.45 * softbox(d, ${box(CARD)}, vec2(0.5, 0.22), 0.12 + blur);
  col += vec3(0.78, 0.82, 1.00) * 0.90 * softbox(d, ${box(TOP)}, vec2(0.9, 0.5), 0.15 + blur);
  col *= uLights.z;
  float key = softbox(d, uKeyC, uKeyU, uKeyV, vec2(0.26, 0.4), 0.1 + blur);
  col += vec3(1.00, 0.97, 0.93) * uLights.x * key * (0.75 + 0.25 * dot(d, uKeyV));
  col += vec3(0.55, 0.62, 1.00) * uLights.y * softbox(d, ${box(RIM)}, vec2(0.06, 0.8), 0.045 + blur);
  return col;
}

// Thin-film interference approximated by a cosine palette, held to the
// reel's cool end: pink, violet, azure, ice (the green phase is kept low).
vec3 film(float x) {
  return vec3(0.6, 0.5, 0.9) + vec3(0.4, 0.25, 0.12) * cos(6.2831853 * (x + vec3(0.0, 0.3, 0.6)));
}

// Chrome seen in chrome: a neighbour's surface at distance t, one bounce
// deeper. Across one texel the reflected beam sweeps over the neighbour by
// grow = foot + 2·cone·t (its origin steps a footprint, its direction 2·cone),
// and the neighbour's curvature turns that into a sweep of directions,
// unbounded toward its rim. The lookup is prefiltered by half that sweep;
// where it outgrows what a blurred lookup can stand for, the image gives way
// to what it would average to: the surrounding reflection (base) at the rim,
// which a mirror's rim reflects anyway, and the studio's mean toward the
// centre. No sparkling ring, and small or distant neighbours become soft
// beads rather than noise.
vec3 mirrored(vec3 r, vec3 n, float rad, float grow, float cone, vec3 base) {
  float ndv = clamp(-dot(n, r), 0.0, 1.0);
  float blur = cone + grow / (rad * max(ndv, 0.02));
  vec3 mean = mix(base, vec3(0.08, 0.085, 0.16) * uLights.z, ndv * ndv);
  vec3 img = mix(env(reflect(r, n), min(blur, 0.35)), mean, smoothstep(0.12, 0.4, blur));
  // The film is keyed by ndv² (linear in the ray's offset from the centre):
  // ndv itself has a square-root edge that would cycle the palette inside a
  // texel and fringe the disc.
  return img * film(uFilm + 0.9 * (1.0 - ndv * ndv)) * 0.85;
}

// The environment along a reflected ray, with the other blobs mirrored in it
// as analytic spheres: cheap inter-reflection. Rather than a hard hit test,
// each neighbour gets a soft edge from the ray's closest approach, one texel's
// sweep wide either side. A neighbour fades out where the surface blends into
// it, where a neck bridges it to the blob we sit on (own; the neck would block
// the view), or where our own surface is no longer that blob's sphere (sph < 1:
// a neck or bulge whose curvature the cone doesn't know), so necks mirror the
// studio instead of a sphere at point-blank range. The two nearest are
// composited back to front.
vec3 reflection(vec3 p, vec3 r, vec4 own, float sph, float foot, float cone, float blur) {
  float t1 = 1e4, t2 = 1e4, w1 = 0.0, w2 = 0.0, r1 = 1.0, r2 = 1.0;
  vec3 n1 = vec3(0.0), n2 = vec3(0.0);
  float shape = smoothstep(0.8, 0.96, sph);
  for (int i = 0; i < 6; i++) {
    vec3 oc = p - uBall[i].xyz;
    float rad = uBall[i].w;
    float b = dot(oc, r);
    float dd = max(dot(oc, oc) - b * b, 0.0);   // squared distance from the centre to the ray
    float e = sqrt(dd) - rad;                   // ray to surface; negative where it pierces
    float soft = foot - 2.0 * cone * b;         // one texel's sweep at the neighbour
    if (b >= 0.0 || e >= soft) continue;        // behind the ray, or clear of it
    float gap = length(oc) - rad;
    float bridge = length(own.xyz - uBall[i].xyz) - own.w - rad;
    float w = (1.0 - smoothstep(-soft, soft, e)) * shape
            * smoothstep(0.15 * uK, 0.9 * uK, gap) * smoothstep(0.1 * uK, 0.6 * uK, bridge);
    if (w <= 0.0) continue;                     // includes the blob we sit on
    float t = -b - sqrt(max(rad * rad - dd, 0.0)); // entry point, or closest approach on a miss
    vec3 n = normalize(oc + r * t);
    if (t < t1) { t2 = t1; w2 = w1; n2 = n1; r2 = r1; t1 = t; w1 = w; n1 = n; r1 = rad; }
    else if (t < t2) { t2 = t; w2 = w; n2 = n; r2 = rad; }
  }
  vec3 base = env(r, blur);
  vec3 col = base;
  if (w2 > 0.0) col = mix(col, mirrored(r, n2, r2, foot + 2.0 * cone * t2, cone, base), w2);
  if (w1 > 0.0) col = mix(col, mirrored(r, n1, r1, foot + 2.0 * cone * t1, cone, base), w1);
  return col;
}

// Shade a surface point; foot is the world size of one pixel there.
vec3 shade(vec3 p, vec3 rd, float foot) {
  vec3 n = normalAt(p);
  float ndv = clamp(dot(n, -rd), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  vec3 r = reflect(rd, n);
  float ao = occlusion(p, n);
  // Film thickness varies with view angle and, slowly, across space, so the
  // colour bands slide over the blobs as they travel and merge.
  float thick = 0.9 * (1.0 - ndv) + 0.2 * n.y + 0.25 * sin(dot(p, vec3(1.3, 2.1, 0.9)) + 3.0 * uFilm);
  vec3 tint = film(uFilm + thick);
  vec3 metal = mix(vec3(0.92, 0.94, 1.0), tint, 0.6 + 0.3 * fres);
  // The blob this point belongs to: the sphere whose surface is nearest.
  vec4 own = uBall[0];
  float ownD = 1e4;
  for (int i = 0; i < 6; i++) {
    float d = abs(length(p - uBall[i].xyz) - uBall[i].w);
    if (d < ownD) { ownD = d; own = uBall[i]; }
  }
  // Reflected pixel cone: the footprint stretches by 1/ndv toward grazing and
  // the curved mirror (radius ~ its blob's) fans it out. Mirrored neighbours
  // start from all of it (see mirrored); the studio blurs only by its growth
  // toward grazing, so faces stay crisp while the last texels before a
  // silhouette are prefiltered instead of flickering. sph: how spherical the
  // surface still is here (1 on a blob, less on necks and bulges).
  float cone = foot / (own.w * max(ndv, 0.05));
  float blur = min(cone - foot / own.w, 0.3);
  float sph = dot(n, normalize(p - own.xyz));
  vec3 col = reflection(p + n * 0.01, r, own, sph, foot, cone, blur) * metal * mix(0.25, 1.0, ao);
  col += vec3(1.0, 0.98, 0.95) * 6.0 * uLights.x * pow(max(dot(r, ${glsl3(SUN)}), 0.0), 900.0) * ao;
  // Soft iridescent rim, strongest on the strip light's side.
  float side = clamp(dot(n, ${glsl3(RIM[0])}) * 0.5 + 0.5, 0.0, 1.0);
  col += tint * fres * (0.03 * uLights.z + 0.2 * side * side * uLights.y) * ao;
  return col;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// One surface layer at ray distance t, shaded, hazed and tone-mapped (edges
// are blended in display space, like the final composite).
vec3 layer(vec3 rd, float t, float px) {
  vec3 col = shade(uRo + rd * t, rd, px * t);
  col *= 1.0 - 0.35 * smoothstep(-0.5, 2.0, t - length(uRo));   // depth haze
  return pow(aces(col * 1.4), vec3(1.0 / 2.2));
}

void main() {
  vec2 uv = (2.0 * vUv - 1.0) * vec2(uResolution.x / uResolution.y, 1.0);
  vec3 rd = normalize(uv.x * uRight + uv.y * uUp + uFocal * uFwd);

  // March only between the first and last padded bounding sphere.
  float tNear = 1e4, tFar = 0.0;
  for (int i = 0; i < 6; i++) {
    vec3 oc = uRo - uBall[i].xyz;
    float r = uBall[i].w + uPad;
    float b = dot(oc, rd);
    float h = b * b - dot(oc, oc) + r * r;
    if (h > 0.0) {
      h = sqrt(h);
      tNear = min(tNear, -b - h);
      tFar = max(tFar, -b + h);
    }
  }
  if (tFar <= 0.0) { gl_FragColor = vec4(0.0); return; }

  // Sphere tracing, with cone-traced antialiasing. a = d / t is how close the
  // ray passes to the surface, as an angle: a ray whose closest approach
  // stays under a pixel is partly covered by that surface. Two layers:
  // - a ray that misses everything takes coverage from its closest approach;
  // - a ray that skims a silhouette (a dips under a pixel, then rises again)
  //   and goes on to hit a blob behind blends the skimmed surface over it, so
  //   blob-over-blob edges are smooth too.
  float px = 2.0 / (uResolution.y * uFocal);   // one pixel, as an angle
  float t = max(tNear, 0.0);
  float best = 1e4, tBest = t;
  float prevA = 1e4, prevT = t;
  float skimA = 1e4, skimT = t;
  bool hit = false;
  for (int i = 0; i < STEPS; i++) {
    float d = map(uRo + rd * t);
    float a = d / t;
    if (a < 0.25 * px) { hit = true; break; }
    if (a < best) { best = a; tBest = t; }
    if (skimA > px && prevA < px && a > prevA) { skimA = prevA; skimT = prevT; }
    prevA = a;
    prevT = t;
    t += d;
    if (t > tFar) break;
  }
  if (!hit && best >= px) { gl_FragColor = vec4(0.0); return; }

  // Coverage ramps from 1 at the hit threshold to 0 one pixel out.
  vec3 col = layer(rd, hit ? t : tBest, px);
  float cover = 1.0;
  if (!hit) cover = clamp((px - best) / (0.75 * px), 0.0, 1.0);
  else if (skimA < px) col = mix(col, layer(rd, skimT, px), clamp((px - skimA) / (0.75 * px), 0.0, 1.0));
  gl_FragColor = vec4(col * cover, cover);
}
`;

// Choreography ----------------------------------------------------------------

/** Unit direction of satellite `s` at orbit angle a (a 3D Lissajous, normalised). */
function orbitDir(s, a) {
  let x = Math.cos(a);
  let y = s.wob * Math.sin(s.harm * a + s.ph);
  let z = Math.sin(a);
  // tilt about x, then roll about z
  const ct = Math.cos(s.tilt);
  const st = Math.sin(s.tilt);
  [y, z] = [y * ct - z * st, y * st + z * ct];
  const cr = Math.cos(s.roll);
  const sr = Math.sin(s.roll);
  [x, y] = [x * cr - y * sr, x * sr + y * cr];
  return norm([x, y, z]);
}

/**
 * Everything that moves, at time t: ball centres/radii (written into
 * `balls`), the core's wobble, the camera and the lights.
 */
function pose(t, balls) {
  // The core drifts lazily while the satellites dance, then centres itself.
  const drift = 1 - ease.inOutCubic(seg(t, 4.5, 5.5));
  const core = [
    0.1 * Math.sin(0.9 * t + 0.3) * drift,
    0.07 * Math.sin(1.3 * t) * drift,
    0.08 * Math.cos(0.7 * t) * drift,
  ];
  const absorbed = 1 - clamp01(kf(t, SPREAD));
  balls[0] = core[0];
  balls[1] = core[1];
  balls[2] = core[2];
  balls[3] = CORE_R + 0.05 * absorbed * drift + (FINAL_R - CORE_R) * grow(t - 5.2);

  const clock = orbitClock(t);
  SATS.forEach((s, i) => {
    const tt = t - s.lag;
    const spread = kf(tt, SPREAD);
    const conv = ease.inCubic(seg(tt, 4.95, 5.5)); // plunge into the core
    const swirl = 2.6 * ease.inQuad(seg(tt, 4.95, 5.5)) * Math.sign(s.spin);
    const dir = orbitDir(s, s.a0 + s.spin * clock + swirl);
    const dist = lerp(lerp(CORE_R - 0.2 * s.r, CORE_R + s.r + s.gap, spread), 0, conv);
    const o = (i + 1) * 4;
    balls[o] = core[0] + dir[0] * dist;
    balls[o + 1] = core[1] + dir[1] * dist;
    balls[o + 2] = core[2] + dir[2] * dist;
    balls[o + 3] = s.r * (0.88 + 0.12 * clamp01(spread)) * (1 - 0.45 * conv);
  });

  // Liquid jiggle after the last drop lands: a decaying squash-and-stretch.
  const tw = t - 5.45;
  const wob = tw > 0 ? 0.12 * Math.exp(-tw / 0.42) * Math.sin(2 * Math.PI * 1.7 * tw) : 0;

  // Camera: one slow orbit, crane and dolly across the whole scene, with a
  // push-in that rides the second, harder merge and lets go on the split.
  const c = ease.inOutSine(t / DUR);
  const yaw = lerp(0.34, -0.18, c);
  const pitch = lerp(0.32, 0.12, c); // crane down: look down on the dance, end level with the sphere
  const push = ease.inOutCubic(seg(t, 2.55, 3.15)) * (1 - ease.inOutSine(seg(t, 3.3, 4.3)));
  const dist = lerp(7.9, 6.9, c) * (1 - 0.06 * push);
  // Aim at the core while the iris opens (the portal is concentric with it),
  // then rise to look a little below the cluster, which then sits high,
  // clear of the caption.
  const aim = lerp(-0.36, -0.2, c) * ease.inOutCubic(seg(t, 0.8, 2.3));
  const ro = [dist * Math.sin(yaw) * Math.cos(pitch), aim + dist * Math.sin(pitch), dist * Math.cos(yaw) * Math.cos(pitch)];
  const fwd = norm([-ro[0], aim - ro[1], -ro[2]]);
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  // Lights out, once the sphere has had a lit beat to settle: the key swings
  // behind it (its reflection slides to the rim and vanishes), the studio
  // dims, and the strip leaves a crescent.
  // The lights finish leaving by ~6.5 s, so the end card (which fades in from
  // 6.2 s) arrives over darkness instead of dissolving over a lit sphere.
  const leave = ease.inOutSine(seg(t, 5.9, 6.5));
  const keyYaw = -0.82 - 1.2 * leave;
  const key = emitter([Math.sin(keyYaw), 0.42, Math.cos(keyYaw)]);
  const out = ease.inOutSine(seg(t, 6.0, 6.55));
  const lights = [2.4 * (1 - leave), 2.2 * (1 - 0.88 * out), 1 - 0.96 * out];

  return { balls, wob, ro, fwd, right, up, key, lights, out };
}

/** Shader uniforms for a pose. */
function uniforms(cam, t) {
  const [kc, ku, kv] = cam.key;
  return {
    uBall: { v4: cam.balls },
    uK: K,
    uPad: K * 0.75 + Math.abs(cam.wob),
    uWob: cam.wob,
    uRo: cam.ro,
    uFwd: cam.fwd,
    uRight: cam.right,
    uUp: cam.up,
    uFocal: FOCAL,
    uKeyC: kc,
    uKeyU: ku,
    uKeyV: kv,
    uLights: cam.lights,
    uFilm: 0.12 * t, // the film's colours drift slowly, like oil on water
  };
}

// 2D ------------------------------------------------------------------------

const CAPTION = ['signed distance fields', 'raymarched per pixel', `up to ${STEPS} steps`];
const CAPTION_2D = ['metaball impression', 'additive canvas 2D', 'no WebGL'];
const CAP_FONT = font(20, 'mono', 400);
const CAP_TRACK = 1.2;

function drawBackground(ctx, s, out) {
  const cx = s.W / 2;
  const cy = s.H * 0.46;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1150);
  g.addColorStop(0, mix('#151A3A', palette.night, 0.55 * out));
  g.addColorStop(0.55, mix('#0D1026', palette.night, 0.55 * out));
  g.addColorStop(1, palette.night);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s.W, s.H);
}

/** One technical caption, bottom left: segments wipe in, staggered, then fade out. */
function drawCaption(ctx, s, caption) {
  const x0 = 192;
  const y = 944;
  const sep = '  ·  ';
  const S = layoutGlyphs(ctx, sep, CAP_FONT, CAP_TRACK);
  ctx.save();
  ctx.font = CAP_FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let x = x0;
  caption.forEach((text, i) => {
    const L = layoutGlyphs(ctx, text, CAP_FONT, CAP_TRACK);
    const inK = ease.outExpo(seg(s.t, 1.15 + i * 0.14, 1.95 + i * 0.14));
    const outK = ease.inCubic(seg(s.t, 4.5 + i * 0.06, 4.95 + i * 0.06));
    const off = i ? S.width : 0;
    const w = off + L.width;
    if (inK > 0 && outK < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 2, y - 30, w * inK + 4 + outK * 12, 44); // the wipe, widened for the exit drift
      ctx.clip();
      ctx.globalAlpha = 1 - outK;
      const dx = (1 - inK) * -14 + outK * 10;
      if (i) {
        ctx.fillStyle = rgba('#9AA4FF', 0.7);
        for (const g of S.glyphs) ctx.fillText(g.ch, x + dx + g.x, y);
      }
      ctx.fillStyle = rgba(palette.bone, 0.6);
      for (const g of L.glyphs) ctx.fillText(g.ch, x + dx + off + g.x, y);
      ctx.restore();
    }
    x += w;
  });
  ctx.restore();
}

/** Screen position and radius of a world-space ball, for the 2D fallback. */
function project(cam, p, r, s) {
  const d = [p[0] - cam.ro[0], p[1] - cam.ro[1], p[2] - cam.ro[2]];
  const z = dot(d, cam.fwd);
  const k = (FOCAL / z) * (s.H / 2);
  return { x: s.W / 2 + dot(d, cam.right) * k, y: s.H / 2 - dot(d, cam.up) * k, r: r * k, z };
}

/** Without WebGL: additive radial-gradient blobs, a soft metaball impression. */
function drawFallback(ctx, s, cam) {
  const b = cam.balls;
  const dim = 1 - 0.7 * cam.out;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    // Fade out drops as the core swallows them whole; stacked up, they would
    // only add up to a hot spot.
    const inside = i ? b[3] - Math.hypot(b[o] - b[0], b[o + 1] - b[1], b[o + 2] - b[2]) - b[o + 3] : 0;
    const a = dim * clamp01(1 - inside / 0.25);
    if (a <= 0) continue;
    const p = project(cam, [b[o], b[o + 1], b[o + 2]], b[o + 3], s);
    const R = p.r * 1.3;
    const g = ctx.createRadialGradient(p.x - p.r * 0.3, p.y - p.r * 0.35, 0, p.x, p.y, R);
    g.addColorStop(0, rgba('#E8EBFF', 0.5 * a));
    g.addColorStop(0.5, rgba('#9AA4FF', 0.26 * a));
    g.addColorStop(0.85, rgba(palette.violet, 0.08 * a));
    g.addColorStop(1, rgba(palette.violet, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export default defineScene({
  id: 'shader',
  title: 'Liquid Metal',
  duration: DUR,
  color: '#9AA4FF',
  usesWebGL: true,
  transition: { type: 'iris', duration: 0.9 },
  post: { grain: 0.05, vignette: 0.32 },
  notes: [
    'Raymarched signed distance fields',
    'Smooth-minimum blending',
    'Thin-film iridescence',
    'Analytic inter-reflections',
    'WebGL composited into the 2D frame',
  ],
  uses: [],
  /** Sound on the merge/split rhythm (times follow SPREAD and the plunge). */
  cues: () => [
    { t: 1.5, kind: 'land', strength: 0.5 }, // merge 1 gathers
    { t: 1.65, kind: 'whoosh', dur: 0.6, strength: 0.4 }, // split 1 flings out
    { t: 3.15, kind: 'hit', strength: 0.5 }, // merge 2: the drops snap in
    { t: 3.3, kind: 'land', strength: 0.6 }, // gulp
    { t: 3.4, kind: 'whoosh', dur: 0.5, strength: 0.5 }, // split 2, wider
    { t: 4.45, kind: 'swell', dur: 0.5, strength: 0.6 }, // wind-up to the apex
    { t: 4.95, kind: 'whoosh', dur: 0.5, dir: 'down', strength: 0.5 }, // the plunge
    { t: 5.47, kind: 'hit', strength: 1.0 }, // everything lands in one sphere
    { t: 5.9, kind: 'shimmer', strength: 0.7 }, // the key light leaves
  ],
  setup({ gl }) {
    const state = { balls: new Float32Array(24), glOk: false };
    if (gl?.available) {
      // Compile, link and run the shader once with a tiny draw, so the cost
      // is paid at load rather than as the iris opens. A GPU that rejects the
      // shader gets the 2D fallback instead of an error card.
      try {
        gl.render(FRAG, { width: 16, height: 9, uniforms: uniforms(pose(0, state.balls), 0) });
        state.glOk = true;
      } catch (err) {
        console.warn('[shader] WebGL shader unavailable; drawing the 2D fallback.', err);
      }
    }
    return state;
  },
  render(ctx, s) {
    const cam = pose(s.t, s.state.balls);
    const useGL = s.gl.available && s.state.glOk;
    drawBackground(ctx, s, cam.out);

    if (useGL) {
      // Render below output size and let drawImage upscale: the metal is smooth
      // and the edges are analytically antialiased, so little is lost.
      const w = Math.min(s.W * s.px, 1280) * 0.7;
      const img = s.gl.render(FRAG, { width: w, height: (w * s.H) / s.W, uniforms: uniforms(cam, s.t) });
      ctx.drawImage(img, 0, 0, s.W, s.H);
    } else {
      drawFallback(ctx, s, cam);
    }

    drawCaption(ctx, s, useGL ? CAPTION : CAPTION_2D);
  },
});

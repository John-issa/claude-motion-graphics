// Shared art direction for the reel. Scenes pick from these so the reel reads
// as one piece, and add their own accents where the story needs it.

export const palette = {
  ink: '#0B0C10', // near-black with a blue bias
  night: '#07080F', // deepest background
  bone: '#EFEBE3', // off-white type and paper
  paper: '#F2EEE6', // risograph stock
  signal: '#FF3B1F', // hot red-orange
  cobalt: '#2446FF', // electric blue
  pink: '#FF4FA3', // fluorescent pink
  sun: '#FFD23F', // warm yellow
  mint: '#2EE6A8', // cool green
  violet: '#7B5CFF', // blue-violet
};

/** Font families (all variable fonts, bundled in src/fonts). */
export const fonts = {
  display: 'Unbounded', // wide geometric display, weights 200-900
  serif: 'Fraunces', // soft editorial serif, weights 100-900, italic too
  mono: 'Martian Mono', // wide monospace, weights 100-800
  sans: 'Instrument Sans', // UI and captions, weights 400-700
};

import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'particles',
  title: 'Particle Typography',
  duration: 7.0,
  color: '#7B5CFF',
  transition: { type: 'iris', duration: 0.8, color: '#EFEBE3' },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

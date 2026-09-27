import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'easing-study',
  title: 'Easing Study',
  duration: 6.5,
  color: '#FFD23F',
  transition: { type: 'wipe', duration: 0.7, color: '#FFD23F' },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

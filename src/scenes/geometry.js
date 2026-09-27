import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'geometry',
  title: 'Wave Field',
  duration: 6.5,
  color: '#2EE6A8',
  transition: { type: 'wipe', duration: 0.7, color: '#2EE6A8', angle: -14 },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

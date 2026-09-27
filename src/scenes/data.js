import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'data',
  title: 'Data Story',
  duration: 7.0,
  color: '#2446FF',
  transition: { type: 'push', duration: 0.7, dir: 'up' },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

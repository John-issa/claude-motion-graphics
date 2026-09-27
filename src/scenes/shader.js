import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'shader',
  title: 'Liquid Metal',
  duration: 7.0,
  color: '#9AA4FF',
  transition: { type: 'iris', duration: 0.9 },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

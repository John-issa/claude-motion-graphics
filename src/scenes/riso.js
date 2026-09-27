import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'riso',
  title: 'Overprint',
  duration: 6.0,
  color: '#FF4FA3',
  transition: { type: 'blinds', duration: 0.8, color: '#FF4FA3' },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'outro',
  title: 'End Card',
  duration: 5.5,
  color: '#EFEBE3',
  transition: { type: 'fade', duration: 0.8 },
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

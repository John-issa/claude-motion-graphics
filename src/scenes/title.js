import { defineScene } from '../engine/index.js';
import { placeholder } from './_placeholder.js';

export default defineScene({
  id: 'title',
  title: 'Title Sequence',
  duration: 6.0,
  color: '#FF3B1F',
  notes: ['Placeholder'],
  render(ctx, s) {
    placeholder(ctx, s, this.title, this.color);
  },
});

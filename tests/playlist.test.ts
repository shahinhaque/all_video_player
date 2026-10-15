import { describe, it, expect } from 'vitest';
import { PlaylistManager } from '../src/core/playlist.js';
import { Playlist } from '../src/core/types.js';

describe('PlaylistManager', () => {
  const dummyPlaylist: Playlist = {
    title: 'Season 1',
    startIndex: 0,
    sourceUrl: 'https://mega.nz/folder/abc',
    items: [
      { id: '10', name: 'Episode 10.ts', size: 1000, provider: 'mega', ref: {} },
      { id: '2', name: 'Episode 2.ts', size: 1000, provider: 'mega', ref: {} },
      { id: '1', name: 'Episode 1.ts', size: 1000, provider: 'mega', ref: {} },
      { id: '20', name: 'Episode 20.ts', size: 1000, provider: 'mega', ref: {} },
    ],
  };

  it('naturally sorts playlist items (Episode 2 before Episode 10)', () => {
    const manager = new PlaylistManager(dummyPlaylist);
    const names = manager.items.map((i) => i.name);
    expect(names).toEqual([
      'Episode 1.ts',
      'Episode 2.ts',
      'Episode 10.ts',
      'Episode 20.ts',
    ]);
  });

  it('correctly navigates next and previous', () => {
    const manager = new PlaylistManager(dummyPlaylist);
    expect(manager.currentIndex).toBe(0);
    expect(manager.hasPrev()).toBe(false);
    expect(manager.hasNext()).toBe(true);

    const next1 = manager.next();
    expect(next1?.name).toBe('Episode 2.ts');
    expect(manager.currentIndex).toBe(1);
    expect(manager.hasPrev()).toBe(true);

    manager.next(); // Episode 10
    manager.next(); // Episode 20
    expect(manager.hasNext()).toBe(false);
    expect(manager.next()).toBeUndefined();

    const prev = manager.prev();
    expect(prev?.name).toBe('Episode 10.ts');
    expect(manager.currentIndex).toBe(2);
  });
});

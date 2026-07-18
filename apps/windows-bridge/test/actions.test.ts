import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSongs } from '../src/actions.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('known song discovery', () => {
  it('finds supported audio files recursively and ignores unrelated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinder-songs-'));
    roots.push(root);
    await mkdir(join(root, 'album'));
    await writeFile(join(root, 'one.mp3'), 'x');
    await writeFile(join(root, 'album', 'two.flac'), 'x');
    await writeFile(join(root, 'notes.txt'), 'x');
    const songs = await discoverSongs(root);
    expect(songs.map((song) => song.replaceAll('\\', '/')).sort()).toEqual([
      join(root, 'album', 'two.flac').replaceAll('\\', '/'),
      join(root, 'one.mp3').replaceAll('\\', '/'),
    ].sort());
  });
});

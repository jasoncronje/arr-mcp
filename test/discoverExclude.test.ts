import { describe, expect, it } from 'vitest';
import { LibraryIndex, type IndexInput } from '../src/core/resolver.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import type { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import type { MediaServerAdapter, PlayedTitle, ServiceUser } from '../src/services/types.ts';
import { buildDiscoverMedia } from '../src/tools/discoverMedia.ts';
import type { LibraryLoader, LibrarySnapshot } from '../src/tools/library.ts';
import type { MediaServers } from '../src/tools/mediaServers.ts';
import type { IdentityResolver } from '../src/core/identity.ts';

type Row = { tconst: string; title: string; year?: number; genres: string[] };

/** The two dataset reads discover makes, over a fixed list in rank order. */
const dataset = (rows: Row[]): ImdbDataset =>
    ({
        discover: (q: { limit: number; offset?: number }) => rows.slice(q.offset ?? 0, (q.offset ?? 0) + q.limit),
        countDiscover: () => rows.length
    }) as unknown as ImdbDataset;

const films = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({ tconst: `tt${String(i + 1).padStart(7, '0')}`, title: `Film ${i + 1}`, year: 2000 + i, genres: ['Comedy'] }));

const snapshot = (rows: IndexInput[], over: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({
    index: LibraryIndex.build(rows),
    degraded: [],
    counts: {},
    playbackFrom: 'plex',
    ...over
});

const loader = (snap: LibrarySnapshot): LibraryLoader => ({ load: async () => snap }) as unknown as LibraryLoader;

const USER: ServiceUser = { id: '1', name: 'owner' };

const server = (played: PlayedTitle[] | (() => Promise<PlayedTitle[]>)): MediaServers => {
    const adapter = {
        id: 'plex',
        type: 'plex',
        listPlayedTitles: typeof played === 'function' ? played : async () => played
    } as unknown as MediaServerAdapter;
    const identity = { resolve: async () => USER } as unknown as IdentityResolver;
    return { primary: { adapter, identity } };
};

const owned = (imdb: string, title: string): IndexInput => ({
    kind: 'movie',
    title,
    ids: { imdb },
    acquisition: { service: 'radarr', monitored: true, hasFile: true }
});

const titles = (items: { title: string }[]): string[] => items.map(i => unfenced(i.title));

describe('discover_media exclude', () => {
    it('leaves out owned and watched films, and refills to the limit from further down the list', async () => {
        const rows = films(10);
        const snap = snapshot([
            owned('tt0000001', 'Film 1'),
            { kind: 'movie', title: 'Film 3', ids: { imdb: 'tt0000003' }, playback: { user: 'owner', watched: true } }
        ]);
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 3, exclude: ['owned', 'watched'] }, dataset(rows), {
            library: loader(snap),
            mediaServers: server([])
        });
        expect(titles(result.items)).toEqual(['Film 2', 'Film 4', 'Film 5']);
        expect(result.excluded).toEqual({ owned: 1, watched: 1 });
        expect(result.truncated).toBe(true);
        expect(result.note).toContain('offset 5 continues');
    });

    it('treats a film owned but unwatched as kept when only watched is excluded', async () => {
        const snap = snapshot([owned('tt0000001', 'Film 1')]);
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 2, exclude: ['watched'] }, dataset(films(3)), {
            library: loader(snap),
            mediaServers: server([])
        });
        expect(titles(result.items)).toEqual(['Film 1', 'Film 2']);
    });

    it('catches a film watched and since deleted by title and release year, a year either side', async () => {
        const played: PlayedTitle[] = [
            { kind: 'movie', title: 'film 2', year: 2002 },
            { kind: 'movie', title: 'The Film 4', year: 2003 },
            { kind: 'movie', title: 'Film 5', year: 1990 }
        ];
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 5, exclude: ['watched'] }, dataset(films(6)), {
            library: loader(snapshot([])),
            mediaServers: server(played)
        });
        // Film 2 (2001) and Film 4 (2003) match; Film 5 is 1990 against 2004.
        expect(titles(result.items)).toEqual(['Film 1', 'Film 3', 'Film 5', 'Film 6']);
        expect(result.excluded).toEqual({ owned: 0, watched: 2 });
        expect(result.truncated).toBe(false);
    });

    it('returns the minimal shape asked for, though year was needed to match', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'minimal', limit: 1, exclude: ['watched'] }, dataset(films(2)), {
            library: loader(snapshot([])),
            mediaServers: server([{ kind: 'movie', title: 'Film 1', year: 2000 }])
        });
        expect(titles(result.items)).toEqual(['Film 2']);
        expect(result.items[0]).not.toHaveProperty('year');
    });

    it('degrades rather than fails when the play history cannot be read', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 2, exclude: ['watched'] }, dataset(films(2)), {
            library: loader(snapshot([])),
            mediaServers: server(async () => {
                throw new Error('network down');
            })
        });
        expect(result.returned).toBe(2);
        expect(result.degraded).toEqual(['plex']);
    });

    it('says so when watch state was not read, rather than implying nothing was watched', async () => {
        const { playbackFrom: _p, ...unread } = snapshot([]);
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 1, exclude: ['watched'] }, dataset(films(1)), {
            library: loader(unread),
            mediaServers: server([])
        });
        expect(result.note).toContain('watch state could not be read');
    });

    it('is the unfiltered answer when exclude is empty', async () => {
        const result = await buildDiscoverMedia(undefined, { kind: 'movie', detail: 'standard', limit: 2, exclude: [] }, dataset(films(3)));
        expect(titles(result.items)).toEqual(['Film 1', 'Film 2']);
        expect(result.excluded).toBeUndefined();
    });
});

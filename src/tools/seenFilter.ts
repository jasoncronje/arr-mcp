import { isOutage } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { MergedItem } from '../core/resolver.ts';
import { normaliseTitle } from '../core/titleMatch.ts';
import { hasPlayedTitles, type PlayedTitle, type SearchHit } from '../services/types.ts';
import type { LibraryLoader } from './library.ts';
import type { MediaServers } from './mediaServers.ts';

export type Exclusion = 'owned' | 'watched';

/** Why a hit was left out, or `undefined` to keep it. */
type SeenVerdict = Exclusion | undefined;

type SeenFilter = {
    verdict(hit: SearchHit): SeenVerdict;
    /** Services that did not answer, so a kept hit may still be owned or watched. */
    degraded: string[];
    /** Set when the watched half could only be partly answered. */
    note?: string;
};

export type SeenDeps = { library: LibraryLoader; mediaServers: MediaServers };

/**
 * A deleted film's history row has no external id, only a title and a release
 * date, so that pair is the join. A year either side absorbs the gap between
 * a festival premiere and a release date. A series row has no year at all,
 * so a series matches on its title alone.
 */
const titleKey = (title: string, year?: number): string => `${normaliseTitle(title)}|${year ?? ''}`;

const watchedInLibrary = (item: MergedItem): boolean => {
    const p = item.playback;
    if (p === undefined) return false;
    return p.watched === true || (p.playCount ?? 0) > 0 || p.lastPlayed !== undefined;
};

/**
 * What `discover_media`'s `exclude` filters against: the library snapshot every
 * other reader shares, plus, for `watched`, the media server's whole play
 * history, which is the only place a watched-then-deleted title survives.
 */
export async function buildSeenFilter(
    deps: SeenDeps | undefined,
    opts: { exclude: readonly Exclusion[]; kind: 'movie' | 'series'; user?: string }
): Promise<SeenFilter> {
    const wantOwned = opts.exclude.includes('owned');
    const wantWatched = opts.exclude.includes('watched');
    if (deps === undefined || (!wantOwned && !wantWatched)) return { verdict: () => undefined, degraded: [] };

    const snapshot = await deps.library.load(opts.user);
    const degraded = [...snapshot.degraded];
    const notes: string[] = [];

    const playedIds = new Set<string>();
    const playedTitles = new Set<string>();
    const primary = deps.mediaServers.primary;

    if (wantWatched) {
        if (primary === undefined) {
            notes.push('No media server is configured, so nothing could be excluded as watched.');
        } else if (snapshot.playbackFrom === undefined) {
            notes.push(`${primary.adapter.id} watch state could not be read, so watched titles may still be listed.`);
        }
        if (primary !== undefined && hasPlayedTitles(primary.adapter) && primary.identity !== undefined) {
            // A bad user name is the caller's to fix, so it propagates unless
            // it is an outage; the history read itself only ever degrades, as
            // the library half still answers.
            let user;
            try {
                user = await primary.identity.resolve(opts.user);
            } catch (err) {
                if (!isOutage(err)) throw err;
            }
            try {
                if (user === undefined) throw new Error('media server user could not be resolved');
                for (const played of await primary.adapter.listPlayedTitles(user)) addPlayed(played, opts.kind, playedIds, playedTitles);
            } catch (err) {
                logger.warn({ service: primary.adapter.id, err }, 'play history read failed; excluding watched from the library alone');
                if (!degraded.includes(primary.adapter.id)) degraded.push(primary.adapter.id);
            }
        } else if (primary !== undefined) {
            notes.push(`${primary.adapter.id} cannot list its whole play history here, so a title watched and since deleted may still be listed.`);
        }
    }

    const verdict = (hit: SearchHit): SeenVerdict => {
        const item = snapshot.index.find(hit.ids, opts.kind);
        // Watched before owned: of the two, "you have seen it" is the reason worth reporting.
        if (wantWatched && item !== undefined && (watchedInLibrary(item) || (item.playback?.itemId !== undefined && playedIds.has(item.playback.itemId)))) {
            return 'watched';
        }
        if (wantOwned && item !== undefined) return 'owned';
        if (!wantWatched) return undefined;
        if (opts.kind === 'series') return playedTitles.has(titleKey(hit.title)) ? 'watched' : undefined;
        if (hit.year === undefined) return undefined;
        for (const year of [hit.year, hit.year - 1, hit.year + 1]) {
            if (playedTitles.has(titleKey(hit.title, year))) return 'watched';
        }
        return undefined;
    };

    return { verdict, degraded, ...(notes.length === 0 ? {} : { note: notes.join(' ') }) };
}

function addPlayed(played: PlayedTitle, kind: 'movie' | 'series', ids: Set<string>, titles: Set<string>): void {
    if (played.kind !== kind) return;
    if (played.itemId !== undefined) ids.add(played.itemId);
    if (kind === 'series') titles.add(titleKey(played.title));
    else if (played.year !== undefined) titles.add(titleKey(played.title, played.year));
}

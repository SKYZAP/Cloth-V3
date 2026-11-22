// Hidden acceptance tests for the /remove, /move and /shuffle benchmark. Never shown to the agents.
// Copied into each run's repo as src/modules/discord/commands/music/zz-hidden-acceptance.spec.ts and run with Jest.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import { MessageFlags } from 'discord.js';

const mockUseQueue = jest.fn();
jest.mock('discord-player', () => ({
    useQueue: (guildId: string) => mockUseQueue(guildId),
    useMainPlayer: () => ({}),
    QueueRepeatMode: { OFF: 0, TRACK: 1, QUEUE: 2, AUTOPLAY: 3 },
}));

type FakeTrack = { id: string; title: string; author: string; duration: string; requestedBy?: { username: string } };
const track = (title: string): FakeTrack => ({ id: `id-${title}`, title, author: `${title} artist`, duration: '3:00', requestedBy: { username: 'sam' } });

/** The upcoming tracks, with the methods discord-player's Queue (@discord-player/utils) offers. */
class FakeTracks {
    constructor(public store: FakeTrack[]) {}
    get data() { return this.store; }
    get size() { return this.store.length; }
    toArray() { return [...this.store]; }
    at(i: number) { return this.store.at(i); }
    isEmpty() { return this.store.length === 0; }
    find(fn: (t: FakeTrack, i: number) => boolean) { return this.store.find(fn); }
    filter(fn: (t: FakeTrack, i: number) => boolean) { return this.store.filter(fn); }
    some(fn: (t: FakeTrack, i: number) => boolean) { return this.store.some(fn); }
    map<T>(fn: (t: FakeTrack, i: number) => T) { return this.store.map(fn); }
    forEach(fn: (t: FakeTrack, i: number) => void) { this.store.forEach(fn); }
    add(t: FakeTrack | FakeTrack[]) { this.store.push(...(Array.isArray(t) ? t : [t])); }
    clear() { this.store = []; }
    removeOne(fn: (t: FakeTrack) => boolean) { const i = this.store.findIndex(fn); if (i >= 0) this.store.splice(i, 1); }
    remove(fn: (t: FakeTrack) => boolean) { this.store = this.store.filter((t) => !fn(t)); }
    shuffle() {
        for (let i = this.store.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.store[i], this.store[j]] = [this.store[j], this.store[i]];
        }
    }
    [Symbol.iterator]() { return this.store[Symbol.iterator](); }
}

/** A guild queue with discord-player 7.2's editing semantics (GuildQueue + GuildQueuePlayerNode). */
function fakeQueue(titles: string[], current = 'Now') {
    const tracks = new FakeTracks(titles.map(track));
    let shuffling = false;
    const position = (t: unknown) => tracks.toArray().findIndex((x, i) => (typeof t === 'number' ? i === t : typeof t === 'string' ? x.id === t : (t as FakeTrack)?.id === x.id));
    const node = {
        remove(t: unknown) {
            const i = position(t);
            if (i < 0) return null;
            return tracks.store.splice(i, 1)[0];
        },
        insert(t: FakeTrack, index = 0) {
            if (index < 0 || index > tracks.size) throw new Error(`index out of range: ${index}`);
            tracks.store.splice(index, 0, t);
        },
        move(from: unknown, to: number) {
            const removed = node.remove(from);
            if (!removed) throw new Error('invalid track to move');
            node.insert(removed, to);
        },
        swap(a: unknown, b: unknown) {
            const i = position(a);
            const j = position(b);
            if (i < 0 || j < 0) throw new Error('invalid track to swap');
            [tracks.store[i], tracks.store[j]] = [tracks.store[j], tracks.store[i]];
        },
        getTrackPosition: position,
        isPlaying: () => true,
        skip: () => true,
    };
    const queue: any = {
        guild: { id: 'guild-123' },
        currentTrack: track(current),
        tracks,
        node,
        isPlaying: () => true,
        isEmpty: () => tracks.size === 0,
        get size() { return tracks.size; },
        removeTrack: (t: unknown) => node.remove(t),
        moveTrack: (t: unknown, i = 0) => node.move(t, i),
        insertTrack: (t: FakeTrack, i = 0) => node.insert(t, i),
        swapTracks: (a: unknown, b: unknown) => node.swap(a, b),
        enableShuffle: (dynamic = true) => { if (!dynamic) tracks.shuffle(); else shuffling = true; return true; },
        disableShuffle: () => { shuffling = false; return true; },
        toggleShuffle: (dynamic = true) => { if (dynamic) { shuffling = !shuffling; return shuffling; } tracks.shuffle(); return true; },
        get isShuffling() { return shuffling; },
    };
    return { queue, titles: () => tracks.toArray().map((t) => t.title) };
}

/** A queue whose upcoming tracks can't be read: any edit fails unexpectedly. */
function brokenQueue() {
    const fail = () => { throw new Error('boom'); };
    return {
        currentTrack: track('Now'),
        isPlaying: () => true,
        get tracks() { return fail(); },
        get node() { return fail(); },
        get size() { return fail(); },
        removeTrack: fail, moveTrack: fail, swapTracks: fail, insertTrack: fail, toggleShuffle: fail, enableShuffle: fail,
    };
}

function interaction(options: Record<string, number> = {}) {
    const i: any = {
        guildId: 'guild-123',
        replied: false,
        deferred: false,
        user: { id: 'u1', username: 'sam' },
        member: { voice: { channel: { id: 'vc' } } },
        options: {
            getInteger: (name: string) => (name in options ? options[name] : null),
            getNumber: (name: string) => (name in options ? options[name] : null),
        },
        reply: jest.fn().mockImplementation(() => { i.replied = true; return Promise.resolve(); }),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockImplementation(() => { i.deferred = true; return Promise.resolve(); }),
    };
    return i;
}

/** The one reply the command sent (reply, or followUp/editReply after deferring). */
function sent(i: any): { text: string; ephemeral: boolean } {
    const calls = [...i.reply.mock.calls, ...i.followUp.mock.calls, ...i.editReply.mock.calls];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const payload = calls[0][0];
    if (typeof payload === 'string') return { text: payload, ephemeral: false };
    const flags = payload?.flags;
    const bits = typeof flags === 'number' || typeof flags === 'bigint' ? Number(flags) : Array.isArray(flags) ? flags.reduce((a: number, f: number) => a | Number(f), 0) : Number(flags?.bitfield ?? 0);
    return { text: String(payload?.content ?? '').trim(), ephemeral: payload?.ephemeral === true || (bits & MessageFlags.Ephemeral) !== 0 };
}

const load = (name: string) => require(`./${name}.command`);
const run = async (name: string, queue: any, options: Record<string, number> = {}) => {
    mockUseQueue.mockReturnValue(queue);
    const i = interaction(options);
    await load(name).execute(i);
    return sent(i);
};
const NO_SESSION = 'This server does not have an active player session.';

afterEach(() => mockUseQueue.mockReset());

describe('registration', () => {
    test.each(['remove', 'move', 'shuffle'])('/%s exports data and execute and is named after the file', (name) => {
        const cmd = load(name);
        expect(typeof cmd.execute).toBe('function');
        expect(cmd.data.toJSON().name).toBe(name);
        expect(cmd.data.toJSON().default_member_permissions).not.toBeUndefined();
    });

    test('options: required integers with a minimum of 1', () => {
        const opt = (name: string) => load(name).data.toJSON().options ?? [];
        const check = (o: any) => expect(o).toMatchObject({ type: 4, required: true, min_value: 1 });
        const remove = opt('remove');
        expect(remove.map((o: any) => o.name)).toEqual(['position']);
        check(remove[0]);
        const move = opt('move');
        expect(move.map((o: any) => o.name)).toEqual(['from', 'to']);
        move.forEach(check);
        expect(opt('shuffle')).toEqual([]);
    });
});

describe('/remove', () => {
    test('removes the upcoming track at a 1-based position', async () => {
        const q = fakeQueue(['A', 'B', 'C']);
        const r = await run('remove', q.queue, { position: 2 });
        expect(q.titles()).toEqual(['A', 'C']);
        expect(r).toEqual({ text: '> **Removed** B **from the queue.**', ephemeral: false });
    });

    test('position 1 is the next track, not the current one', async () => {
        const q = fakeQueue(['A', 'B']);
        await run('remove', q.queue, { position: 1 });
        expect(q.titles()).toEqual(['B']);
        expect(q.queue.currentTrack.title).toBe('Now');
    });

    test('a position past the end changes nothing', async () => {
        const q = fakeQueue(['A', 'B', 'C']);
        const r = await run('remove', q.queue, { position: 4 });
        expect(q.titles()).toEqual(['A', 'B', 'C']);
        expect(r).toEqual({ text: 'There is no track at position 4. The queue has 3 upcoming tracks.', ephemeral: true });
    });

    test('no queue', async () => {
        expect(await run('remove', null, { position: 1 })).toEqual({ text: NO_SESSION, ephemeral: true });
    });
});

describe('/move', () => {
    test('moves a track down; the others keep their order', async () => {
        const q = fakeQueue(['A', 'B', 'C', 'D']);
        const r = await run('move', q.queue, { from: 1, to: 3 });
        expect(q.titles()).toEqual(['B', 'C', 'A', 'D']);
        expect(r).toEqual({ text: '> **Moved** A **to position 3.**', ephemeral: false });
    });

    test('moves a track up to the front', async () => {
        const q = fakeQueue(['A', 'B', 'C', 'D']);
        const r = await run('move', q.queue, { from: 4, to: 1 });
        expect(q.titles()).toEqual(['D', 'A', 'B', 'C']);
        expect(r.text).toBe('> **Moved** D **to position 1.**');
    });

    test('moves a track to the last position', async () => {
        const q = fakeQueue(['A', 'B', 'C', 'D']);
        await run('move', q.queue, { from: 2, to: 4 });
        expect(q.titles()).toEqual(['A', 'C', 'D', 'B']);
    });

    test('the same position changes nothing', async () => {
        const q = fakeQueue(['A', 'B', 'C']);
        const r = await run('move', q.queue, { from: 2, to: 2 });
        expect(q.titles()).toEqual(['A', 'B', 'C']);
        expect(r).toEqual({ text: 'That track is already at position 2.', ephemeral: true });
    });

    test('a `from` past the end is reported, and checked before `to`', async () => {
        const q = fakeQueue(['A', 'B', 'C']);
        const r = await run('move', q.queue, { from: 5, to: 9 });
        expect(q.titles()).toEqual(['A', 'B', 'C']);
        expect(r).toEqual({ text: 'There is no track at position 5. The queue has 3 upcoming tracks.', ephemeral: true });
    });

    test('a `to` past the end is reported', async () => {
        const q = fakeQueue(['A', 'B', 'C']);
        const r = await run('move', q.queue, { from: 1, to: 4 });
        expect(q.titles()).toEqual(['A', 'B', 'C']);
        expect(r).toEqual({ text: 'There is no track at position 4. The queue has 3 upcoming tracks.', ephemeral: true });
    });

    test('no queue', async () => {
        expect(await run('move', null, { from: 1, to: 2 })).toEqual({ text: NO_SESSION, ephemeral: true });
    });
});

describe('/shuffle', () => {
    test('shuffles the upcoming tracks once, now, and keeps them all', async () => {
        const titles = Array.from({ length: 20 }, (_, i) => `T${i + 1}`);
        const q = fakeQueue(titles);
        const r = await run('shuffle', q.queue);
        expect([...q.titles()].sort()).toEqual([...titles].sort());
        expect(q.titles()).not.toEqual(titles);
        expect(q.queue.currentTrack.title).toBe('Now');
        expect(q.queue.isShuffling).toBe(false);
        expect(r).toEqual({ text: '> **Shuffled 20 tracks.**', ephemeral: false });
    });

    test('fewer than 2 upcoming tracks changes nothing', async () => {
        const q = fakeQueue(['A']);
        const r = await run('shuffle', q.queue);
        expect(q.titles()).toEqual(['A']);
        expect(r).toEqual({ text: "There aren't enough tracks in the queue to shuffle.", ephemeral: true });
    });

    test('no queue', async () => {
        expect(await run('shuffle', null)).toEqual({ text: NO_SESSION, ephemeral: true });
    });
});

describe('unexpected errors', () => {
    const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);
    test.each([
        ['remove', { position: 1 }],
        ['move', { from: 1, to: 2 }],
        ['shuffle', {}],
    ])('/%s replies with the generic message', async (name, options) => {
        const spy = quiet();
        const r = await run(name as string, brokenQueue(), options as Record<string, number>);
        spy.mockRestore();
        expect(r).toEqual({ text: 'Couldn’t change the queue. Please try again.', ephemeral: true });
    });
});

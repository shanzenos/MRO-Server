function installFakeTimers()
{
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;

    let seq = 0;
    let virtualNow = 0;
    const pending = new Map();

    global.setTimeout = (fn, delay = 0, ...args) => {
        const id = ++seq;
        pending.set(id, { fn, args, time: virtualNow + delay, seq: id });
        return id;
    };
    global.clearTimeout = (id) => { pending.delete(id); };

    function hasPending()
    {
        return pending.size > 0;
    }

    function fireNext()
    {
        let next = null;
        for (const entry of pending.values())
        {
            if (!next || entry.time < next.time || (entry.time === next.time && entry.seq < next.seq))
                next = entry;
        }
        if (!next) return false;

        pending.delete(next.seq);
        virtualNow = next.time;
        next.fn(...next.args);
        return true;
    }

    function restore()
    {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
    }

    return { hasPending, fireNext, restore };
}

module.exports = { installFakeTimers };

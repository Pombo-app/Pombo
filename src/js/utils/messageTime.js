/**
 * The time a message is ordered, paged and dated by. The signed envelope time
 * (`_timestamp`, set at ingest) is authoritative and unforgeable; the payload
 * `timestamp` is publisher-chosen and only used as a fallback for a message
 * that has no envelope yet — your own optimistic send before the network
 * confirms it. Reading the payload time for ordering let a message dated in
 * the past poison the pagination anchor and hide legitimate newer ones.
 * @param {{ _timestamp?: number, timestamp?: number }} m
 * @returns {number} ms epoch
 */
export function messageTime(m) {
    if (!m) return 0;
    return (typeof m._timestamp === 'number' && m._timestamp > 0)
        ? m._timestamp
        : (m.timestamp || 0);
}

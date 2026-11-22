// Find train numbers that SEPTA's own alert text says are canceled.
// Conservative: only sentences that mention cancellation, only numbers written as "#1234" or "Train 1234",
// and the caller keeps only numbers that exist in that day's timetable. Raw sentences are kept for audit.

const CANCEL = /\bcancel(?:l?ed|l?ing|lations?|s)?\b/i;
const NOT_CANCEL = /\b(?:not|no longer|isn't|is not|will not be)\s+(?:be\s+)?cancel/i;
const NUM = /(?:#\s*|\btrains?\s+(?:no\.?\s*|number\s*)?)(\d{3,4})\b/gi;
// "Train #1234, #1236 and #1238": numbers after the first marker that keep the "#" prefix.
const HASH_LIST = /#\s*(\d{3,4})\b/g;

export function canceledTrainsFromText(text) {
  const out = [];
  for (const sentence of String(text).split(/(?<=[.!?])\s+/)) {
    if (!CANCEL.test(sentence) || NOT_CANCEL.test(sentence)) continue;
    // "Train #1234 will operate in place of canceled Train #5678": only the number after "in place of" was canceled.
    const replace = sentence.match(/in place of\s+(?:the\s+)?(?:canceled\s+)?(.*)$/i);
    const scope = replace ? replace[1] : sentence;
    const nums = new Set();
    for (const m of scope.matchAll(NUM)) nums.add(m[1]);
    for (const m of scope.matchAll(HASH_LIST)) nums.add(m[1]);
    for (const n of nums) out.push({ train: n, sentence: sentence.trim() });
  }
  return out;
}

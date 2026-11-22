// Every threshold the site's numbers depend on. The website publishes these, word for word.
export const RULES = {
  pollSeconds: 300,
  onTimeMaxLate: 5,            // minutes; SEPTA's own "within 6 minutes" rule on whole-minute data
  ghostBeforeDep: 15 * 60,     // window starts 15 min before scheduled departure...
  ghostAfterArr: 30 * 60,      // ...and ends 30 min after scheduled arrival
  missingAfterDep: 15 * 60,    // not seen 15 min after scheduled departure -> "missing" (suspected ghost, live only)
  doneAfterLastSeen: 15 * 60,  // gone from the feed for 15 min -> trip treated as finished
  minPollsForVerdict: 2,       // need >= 2 good polls during the scheduled run to call a train a ghost
  partialKm: 10,               // first/last sighting > 10 km from the scheduled end -> partial trip
  minLegSecondsForSkip: 15 * 60, // a through-train leg shorter than this is never called skipped
  matchBefore: 90 * 60,        // a live train is matched to a scheduled run from 90 min before departure...
  matchAfter: 240 * 60,        // ...to 4 h after scheduled arrival (very late trains)
};

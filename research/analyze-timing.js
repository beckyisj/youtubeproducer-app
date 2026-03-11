const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'channel-data.json'), 'utf-8'));

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Helpers ──

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function round(n, d = 2) {
  return Math.round(n * 10 ** d) / 10 ** d;
}

// ── Build normalized dataset ──
// For each video, compute views / channel_median_views (normalized score).
// Skip channels with < 5 videos (unreliable median).

const allEntries = []; // { day, hour, niche, normViews, channel }

let channelsUsed = 0;
let videosUsed = 0;

for (const channel of data) {
  if (channel.videos.length < 5) continue;
  const channelMedian = median(channel.videos.map(v => v.views));
  if (channelMedian <= 0) continue;
  channelsUsed++;

  for (const video of channel.videos) {
    const dt = new Date(video.publishedAt);
    if (isNaN(dt.getTime())) continue;

    const dayIdx = dt.getUTCDay(); // 0=Sun
    const dayName = DAY_NAMES[dayIdx];
    const hourUTC = dt.getUTCHours();
    const normViews = video.views / channelMedian;

    allEntries.push({
      day: dayName,
      hour: hourUTC,
      niche: channel.niche,
      normViews,
      channel: channel.name,
    });
    videosUsed++;
  }
}

console.log(`\nDataset: ${channelsUsed} channels, ${videosUsed} videos (channels with <5 vids excluded)\n`);

// ── 1. Day of week performance ──

const dayPerf = {};
for (const d of DAY_ORDER) dayPerf[d] = [];

for (const e of allEntries) dayPerf[e.day].push(e.normViews);

const dayResults = DAY_ORDER.map(d => ({
  day: d,
  avgNormViews: round(avg(dayPerf[d])),
  medianNormViews: round(median(dayPerf[d])),
  count: dayPerf[d].length,
  pctOfTotal: round((dayPerf[d].length / videosUsed) * 100, 1),
}));

console.log('── DAY OF WEEK PERFORMANCE ──');
console.log('(avgNormViews: 1.0 = channel median, higher = outperforms)');
for (const r of dayResults) {
  const bar = '█'.repeat(Math.round(r.avgNormViews * 10));
  console.log(`  ${r.day}  ${bar} ${r.avgNormViews.toFixed(2)}x  (${r.count} videos, ${r.pctOfTotal}%)`);
}
console.log();

// ── 2. Hour of day performance ──

const hourPerf = {};
for (let h = 0; h < 24; h++) hourPerf[h] = [];

for (const e of allEntries) hourPerf[e.hour].push(e.normViews);

function utcToEST(h) { return ((h - 5) + 24) % 24; }
function utcToPST(h) { return ((h - 8) + 24) % 24; }
function fmtHour(h) { return `${h.toString().padStart(2, '0')}:00`; }

const hourResults = [];
for (let h = 0; h < 24; h++) {
  hourResults.push({
    hourUTC: fmtHour(h),
    hourEST: fmtHour(utcToEST(h)),
    hourPST: fmtHour(utcToPST(h)),
    avgNormViews: round(avg(hourPerf[h])),
    medianNormViews: round(median(hourPerf[h])),
    count: hourPerf[h].length,
  });
}

console.log('── HOUR OF DAY PERFORMANCE (UTC) ──');
console.log('(Top 5 hours by avg normalized views)');
const topHours = [...hourResults].sort((a, b) => b.avgNormViews - a.avgNormViews).slice(0, 5);
for (const r of topHours) {
  console.log(`  UTC ${r.hourUTC} (EST ${r.hourEST}, PST ${r.hourPST})  ${r.avgNormViews.toFixed(2)}x  (${r.count} videos)`);
}
console.log();

console.log('Most common upload hours:');
const topUploadHours = [...hourResults].sort((a, b) => b.count - a.count).slice(0, 5);
for (const r of topUploadHours) {
  console.log(`  UTC ${r.hourUTC} (EST ${r.hourEST}, PST ${r.hourPST})  ${r.count} videos  (${r.avgNormViews.toFixed(2)}x perf)`);
}
console.log();

// ── 3. Day of week by niche ──

const niches = [...new Set(allEntries.map(e => e.niche))].sort();
const nicheDay = {};

for (const niche of niches) {
  nicheDay[niche] = {};
  for (const d of DAY_ORDER) nicheDay[niche][d] = [];
}

for (const e of allEntries) {
  nicheDay[e.niche][e.day].push(e.normViews);
}

const nicheDayResults = {};
console.log('── DAY OF WEEK BY NICHE ──');
for (const niche of niches) {
  nicheDayResults[niche] = {};
  const bestDay = { day: '', avg: 0 };
  for (const d of DAY_ORDER) {
    const a = round(avg(nicheDay[niche][d]));
    const c = nicheDay[niche][d].length;
    nicheDayResults[niche][d] = { avgNormViews: a, count: c };
    if (a > bestDay.avg) { bestDay.day = d; bestDay.avg = a; }
  }
  console.log(`  ${niche}: best day = ${bestDay.day} (${bestDay.avg.toFixed(2)}x)`);
}
console.log();

// ── 4. Weekend vs weekday ──

const weekdayEntries = allEntries.filter(e => !['Sat', 'Sun'].includes(e.day));
const weekendEntries = allEntries.filter(e => ['Sat', 'Sun'].includes(e.day));

const weekdayWeekend = {
  weekday: {
    avgNormViews: round(avg(weekdayEntries.map(e => e.normViews))),
    medianNormViews: round(median(weekdayEntries.map(e => e.normViews))),
    count: weekdayEntries.length,
    pctOfTotal: round((weekdayEntries.length / videosUsed) * 100, 1),
  },
  weekend: {
    avgNormViews: round(avg(weekendEntries.map(e => e.normViews))),
    medianNormViews: round(median(weekendEntries.map(e => e.normViews))),
    count: weekendEntries.length,
    pctOfTotal: round((weekendEntries.length / videosUsed) * 100, 1),
  },
};

console.log('── WEEKEND vs WEEKDAY ──');
console.log(`  Weekday: ${weekdayWeekend.weekday.avgNormViews.toFixed(2)}x avg  (${weekdayWeekend.weekday.count} videos, ${weekdayWeekend.weekday.pctOfTotal}%)`);
console.log(`  Weekend: ${weekdayWeekend.weekend.avgNormViews.toFixed(2)}x avg  (${weekdayWeekend.weekend.count} videos, ${weekdayWeekend.weekend.pctOfTotal}%)`);
const diff = round(((weekdayWeekend.weekday.avgNormViews - weekdayWeekend.weekend.avgNormViews) / weekdayWeekend.weekend.avgNormViews) * 100, 1);
console.log(`  → Weekday ${diff > 0 ? 'outperforms' : 'underperforms'} weekend by ${Math.abs(diff)}%`);
console.log();

// ── 5. What creators actually do vs what performs ──

const mostCommonDays = [...dayResults].sort((a, b) => b.count - a.count);
const bestPerfDays = [...dayResults].sort((a, b) => b.avgNormViews - a.avgNormViews);

console.log('── WHAT CREATORS DO vs WHAT PERFORMS ──');
console.log('Most common upload days:');
for (const r of mostCommonDays.slice(0, 3)) {
  console.log(`  ${r.day}: ${r.count} videos (${r.pctOfTotal}%)`);
}
console.log('Best performing upload days:');
for (const r of bestPerfDays.slice(0, 3)) {
  console.log(`  ${r.day}: ${r.avgNormViews.toFixed(2)}x normalized views`);
}

const gap = bestPerfDays[0].day !== mostCommonDays[0].day;
if (gap) {
  console.log(`\n  ⚡ Gap: Creators mostly upload on ${mostCommonDays[0].day}, but ${bestPerfDays[0].day} performs best.`);
} else {
  console.log(`\n  ✓ Aligned: Creators mostly upload on ${mostCommonDays[0].day}, which is also the best-performing day.`);
}
console.log();

// ── Save results ──

const results = {
  meta: {
    channelsAnalyzed: channelsUsed,
    videosAnalyzed: videosUsed,
    niches,
    generatedAt: new Date().toISOString(),
    note: 'normViews = video views / channel median views. 1.0 = average for that channel.',
  },
  dayOfWeek: dayResults,
  hourOfDay: hourResults,
  dayOfWeekByNiche: nicheDayResults,
  weekdayVsWeekend: weekdayWeekend,
  insights: {
    mostCommonUploadDays: mostCommonDays.slice(0, 3).map(r => r.day),
    bestPerformingDays: bestPerfDays.slice(0, 3).map(r => r.day),
    mostCommonUploadHours: topUploadHours.map(r => ({ utc: r.hourUTC, est: r.hourEST, pst: r.hourPST, count: r.count })),
    bestPerformingHours: topHours.map(r => ({ utc: r.hourUTC, est: r.hourEST, pst: r.hourPST, avgNormViews: r.avgNormViews })),
    weekdayVsWeekendDiff: `${diff > 0 ? '+' : ''}${diff}% weekday vs weekend`,
  },
};

fs.writeFileSync(path.join(__dirname, 'timing-results.json'), JSON.stringify(results, null, 2));
console.log('Results saved to timing-results.json');

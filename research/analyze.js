// Analyze collected YouTube data for 4 articles
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'channel-data.json'), 'utf8'));

// Filter to channels with meaningful data
const channels = data.filter(c => c.videosCollected >= 5);
const allVideos = channels.flatMap(c => c.videos.map(v => ({ ...v, channelName: c.name, niche: c.niche, channelSubs: c.subscribers })));

console.log(`=== DATA OVERVIEW ===`);
console.log(`Channels: ${channels.length}`);
console.log(`Total long-form videos: ${allVideos.length}`);
console.log(`Niches: ${[...new Set(channels.map(c => c.niche))].join(', ')}`);
console.log();

// =============================================
// ANALYSIS 1: How Fast Do YouTube Channels Grow?
// =============================================
console.log(`\n${'='.repeat(60)}`);
console.log(`ANALYSIS 1: HOW FAST DO YOUTUBE CHANNELS GROW?`);
console.log(`${'='.repeat(60)}\n`);

const now = new Date();
const channelGrowth = channels.map(c => {
  const created = new Date(c.createdAt);
  const ageYears = (now - created) / (1000 * 60 * 60 * 24 * 365.25);
  const ageDays = (now - created) / (1000 * 60 * 60 * 24);
  return {
    name: c.name,
    niche: c.niche,
    subscribers: c.subscribers,
    totalViews: c.totalViews,
    totalVideos: c.totalVideos,
    ageYears: Math.round(ageYears * 10) / 10,
    subsPerYear: Math.round(c.subscribers / ageYears),
    viewsPerVideo: c.totalVideos > 0 ? Math.round(c.totalViews / c.totalVideos) : 0,
    subsPerVideo: c.totalVideos > 0 ? Math.round(c.subscribers / c.totalVideos) : 0,
    videosPerYear: Math.round(c.totalVideos / ageYears),
  };
}).sort((a, b) => b.subsPerYear - a.subsPerYear);

console.log('FASTEST GROWING (subs/year):');
channelGrowth.slice(0, 15).forEach((c, i) => {
  console.log(`  ${i+1}. ${c.name} (${c.niche}) — ${(c.subsPerYear/1e6).toFixed(2)}M subs/yr | ${c.ageYears}yrs old | ${c.subscribers.toLocaleString()} total subs | ${c.videosPerYear} vids/yr`);
});

console.log('\nSLOWEST GROWING (subs/year):');
channelGrowth.slice(-10).reverse().forEach((c, i) => {
  console.log(`  ${i+1}. ${c.name} (${c.niche}) — ${(c.subsPerYear/1000).toFixed(1)}K subs/yr | ${c.ageYears}yrs old | ${c.subscribers.toLocaleString()} total subs`);
});

// By niche
console.log('\nAVERAGE GROWTH BY NICHE:');
const niches = [...new Set(channelGrowth.map(c => c.niche))];
niches.forEach(niche => {
  const nicheChannels = channelGrowth.filter(c => c.niche === niche);
  const avgSubsPerYear = Math.round(nicheChannels.reduce((a, c) => a + c.subsPerYear, 0) / nicheChannels.length);
  const avgViewsPerVideo = Math.round(nicheChannels.reduce((a, c) => a + c.viewsPerVideo, 0) / nicheChannels.length);
  const avgVideosPerYear = Math.round(nicheChannels.reduce((a, c) => a + c.videosPerYear, 0) / nicheChannels.length);
  console.log(`  ${niche}: ${(avgSubsPerYear/1000).toFixed(0)}K subs/yr avg | ${(avgViewsPerVideo/1000).toFixed(0)}K views/vid | ${avgVideosPerYear} vids/yr`);
});

// Efficiency: subs per video
console.log('\nMOST EFFICIENT (subs per video uploaded):');
channelGrowth.sort((a, b) => b.subsPerVideo - a.subsPerVideo).slice(0, 10).forEach((c, i) => {
  console.log(`  ${i+1}. ${c.name} — ${c.subsPerVideo.toLocaleString()} subs/video | ${c.totalVideos} total vids | ${c.subscribers.toLocaleString()} subs`);
});

// =============================================
// ANALYSIS 2: Title Patterns
// =============================================
console.log(`\n${'='.repeat(60)}`);
console.log(`ANALYSIS 2: WHAT TITLE FORMULAS GET THE MOST VIEWS?`);
console.log(`${'='.repeat(60)}\n`);

function classifyTitle(title) {
  const t = title.toLowerCase();
  const patterns = [];

  if (/^how\s+to\b/i.test(title) || /\btutorial\b/i.test(title)) patterns.push('How To / Tutorial');
  if (/\b\d+\s+(things?|ways?|tips?|steps?|lessons?|habits?|rules?|reasons?|mistakes?|books?|truths?|secrets?|tools?|hacks?|ideas?)\b/i.test(title)) patterns.push('Listicle / Number');
  if (/\?/.test(title)) patterns.push('Question');
  if (/\b(i\s+tried|challenge|experiment|for\s+\d+\s+days?|i\s+spent)\b/i.test(title)) patterns.push('Challenge / Experiment');
  if (/\b(changed\s+my\s+life|life.?changing|you\s+need|stop\s+doing|never|worst|best\s+ever|blew\s+my\s+mind|no\s+one\s+talks?\s+about)\b/i.test(title)) patterns.push('Emotional / Clickbait');
  if (/\b(ceo|millionaire|billion|expert|scientist|doctor|professor|phd|years?\s+of|decades?\s+of)\b/i.test(title)) patterns.push('Authority / Expert');
  if (/\b(why\s+you|why\s+i|why\s+most|why\s+every)\b/i.test(title)) patterns.push('Why / Explanation');
  if (/\b(complete\s+guide|everything\s+you\s+need|ultimate|beginner|explained|breakdown)\b/i.test(title)) patterns.push('Guide / Explainer');
  if (/\b(give\s+me\s+\d+\s+min|in\s+\d+\s+min|under\s+\d+\s+min|\d+\s+minutes?)\b/i.test(title)) patterns.push('Time Promise');
  if (/\b(vs\.?|versus|compared|better)\b/i.test(title)) patterns.push('Comparison / Versus');
  if (/\b(my\s+\$|spent\s+\$|\$\d|money|income|salary|net\s+worth|budget|cost)\b/i.test(title)) patterns.push('Money / Financial');
  if (/\b(review|tested|honest|worth\s+it)\b/i.test(title)) patterns.push('Review');

  if (patterns.length === 0) patterns.push('Other');
  return patterns;
}

// Calculate views relative to channel median (to normalize across channel sizes)
const videosByChannel = {};
for (const v of allVideos) {
  if (!videosByChannel[v.channelName]) videosByChannel[v.channelName] = [];
  videosByChannel[v.channelName].push(v);
}

// Add relative performance to each video
const videosWithRelative = allVideos.map(v => {
  const channelVideos = videosByChannel[v.channelName];
  const sortedViews = channelVideos.map(cv => cv.views).sort((a, b) => a - b);
  const median = sortedViews[Math.floor(sortedViews.length / 2)];
  return { ...v, relativePerformance: median > 0 ? v.views / median : 0 };
});

const patternStats = {};
for (const v of videosWithRelative) {
  const patterns = classifyTitle(v.title);
  for (const p of patterns) {
    if (!patternStats[p]) patternStats[p] = { count: 0, totalRelative: 0, totalViews: 0, examples: [] };
    patternStats[p].count++;
    patternStats[p].totalRelative += v.relativePerformance;
    patternStats[p].totalViews += v.views;
    if (patternStats[p].examples.length < 3 && v.relativePerformance > 2) {
      patternStats[p].examples.push({ title: v.title, channel: v.channelName, views: v.views, relative: v.relativePerformance });
    }
  }
}

console.log('TITLE PATTERNS BY RELATIVE PERFORMANCE (vs channel median):');
const patternEntries = Object.entries(patternStats)
  .map(([pattern, stats]) => ({
    pattern,
    count: stats.count,
    avgRelative: stats.totalRelative / stats.count,
    avgViews: Math.round(stats.totalViews / stats.count),
    examples: stats.examples,
  }))
  .filter(p => p.count >= 15)
  .sort((a, b) => b.avgRelative - a.avgRelative);

patternEntries.forEach((p, i) => {
  console.log(`  ${i+1}. ${p.pattern} — ${p.avgRelative.toFixed(2)}x median | ${p.count} videos | ${(p.avgViews/1000).toFixed(0)}K avg views`);
  p.examples.slice(0, 2).forEach(ex => {
    console.log(`     "${ex.title}" (${ex.channel}, ${(ex.views/1000).toFixed(0)}K views, ${ex.relative.toFixed(1)}x)`);
  });
});

// Combo patterns
console.log('\nBEST PATTERN COMBOS (2+ patterns in one title):');
const combos = {};
for (const v of videosWithRelative) {
  const patterns = classifyTitle(v.title);
  if (patterns.length >= 2) {
    const key = patterns.sort().join(' + ');
    if (!combos[key]) combos[key] = { count: 0, totalRelative: 0 };
    combos[key].count++;
    combos[key].totalRelative += v.relativePerformance;
  }
}
Object.entries(combos)
  .map(([combo, stats]) => ({ combo, count: stats.count, avg: stats.totalRelative / stats.count }))
  .filter(c => c.count >= 5)
  .sort((a, b) => b.avg - a.avg)
  .slice(0, 10)
  .forEach((c, i) => {
    console.log(`  ${i+1}. ${c.combo} — ${c.avg.toFixed(2)}x | ${c.count} videos`);
  });

// =============================================
// ANALYSIS 3: Does Video Length Matter?
// =============================================
console.log(`\n${'='.repeat(60)}`);
console.log(`ANALYSIS 3: DOES VIDEO LENGTH MATTER?`);
console.log(`${'='.repeat(60)}\n`);

const durationBuckets = [
  { label: '1.5-5 min', min: 90, max: 300 },
  { label: '5-10 min', min: 300, max: 600 },
  { label: '10-15 min', min: 600, max: 900 },
  { label: '15-20 min', min: 900, max: 1200 },
  { label: '20-30 min', min: 1200, max: 1800 },
  { label: '30-45 min', min: 1800, max: 2700 },
  { label: '45-60 min', min: 2700, max: 3600 },
  { label: '60+ min', min: 3600, max: Infinity },
];

console.log('OVERALL PERFORMANCE BY DURATION:');
durationBuckets.forEach(bucket => {
  const vids = videosWithRelative.filter(v => v.durationSec >= bucket.min && v.durationSec < bucket.max);
  if (vids.length < 10) return;
  const avgRelative = vids.reduce((a, v) => a + v.relativePerformance, 0) / vids.length;
  const avgViews = Math.round(vids.reduce((a, v) => a + v.views, 0) / vids.length);
  console.log(`  ${bucket.label.padEnd(12)} — ${avgRelative.toFixed(2)}x median | ${vids.length} videos | ${(avgViews/1000).toFixed(0)}K avg views`);
});

// By niche
console.log('\nBEST DURATION BY NICHE:');
niches.forEach(niche => {
  const nicheVids = videosWithRelative.filter(v => v.niche === niche);
  const bucketPerf = durationBuckets.map(bucket => {
    const vids = nicheVids.filter(v => v.durationSec >= bucket.min && v.durationSec < bucket.max);
    if (vids.length < 5) return null;
    return {
      label: bucket.label,
      avg: vids.reduce((a, v) => a + v.relativePerformance, 0) / vids.length,
      count: vids.length,
    };
  }).filter(Boolean);

  if (bucketPerf.length === 0) return;
  const best = bucketPerf.sort((a, b) => b.avg - a.avg)[0];
  const worst = bucketPerf[bucketPerf.length - 1];
  console.log(`  ${niche.padEnd(18)} — Best: ${best.label} (${best.avg.toFixed(2)}x, ${best.count} vids) | Worst: ${worst.label} (${worst.avg.toFixed(2)}x, ${worst.count} vids)`);
});

// Duration trend: are videos getting longer or shorter?
console.log('\nDURATION TREND (avg duration by year):');
const byYear = {};
for (const v of allVideos) {
  const year = new Date(v.publishedAt).getFullYear();
  if (year < 2019) continue;
  if (!byYear[year]) byYear[year] = { total: 0, count: 0 };
  byYear[year].total += v.durationSec;
  byYear[year].count++;
}
Object.entries(byYear).sort().forEach(([year, stats]) => {
  const avgMin = (stats.total / stats.count / 60).toFixed(1);
  console.log(`  ${year}: ${avgMin} min avg (${stats.count} videos)`);
});

// =============================================
// ANALYSIS 4: First Year Breakout Patterns
// =============================================
console.log(`\n${'='.repeat(60)}`);
console.log(`ANALYSIS 4: WHAT BREAKOUT CHANNELS DID DIFFERENTLY`);
console.log(`${'='.repeat(60)}\n`);

// For each channel, analyze early videos (first 50) vs channel outcome
const channelEarlyPatterns = channels.map(c => {
  const sortedVids = [...c.videos].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  const first50 = sortedVids.slice(0, 50);
  const last50 = sortedVids.slice(-50);

  if (first50.length < 10) return null;

  const avgDurationFirst = first50.reduce((a, v) => a + v.durationSec, 0) / first50.length;
  const avgViewsFirst = first50.reduce((a, v) => a + v.views, 0) / first50.length;
  const avgViewsLast = last50.reduce((a, v) => a + v.views, 0) / last50.length;

  // Title pattern diversity in first 50
  const titlePatterns = new Set();
  first50.forEach(v => classifyTitle(v.title).forEach(p => titlePatterns.add(p)));

  // Upload cadence in first 50
  const firstDate = new Date(first50[0].publishedAt);
  const lastDate = new Date(first50[first50.length - 1].publishedAt);
  const spanDays = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
  const uploadsPerMonth = (first50.length / spanDays) * 30;

  // Growth trajectory
  const growthRatio = avgViewsFirst > 0 ? avgViewsLast / avgViewsFirst : 0;

  return {
    name: c.name,
    niche: c.niche,
    subscribers: c.subscribers,
    subsPerYear: channelGrowth.find(cg => cg.name === c.name)?.subsPerYear || 0,
    earlyAvgDuration: Math.round(avgDurationFirst / 60),
    earlyAvgViews: avgViewsFirst,
    recentAvgViews: avgViewsLast,
    growthRatio: Math.round(growthRatio * 10) / 10,
    titlePatternDiversity: titlePatterns.size,
    uploadsPerMonth: Math.round(uploadsPerMonth * 10) / 10,
  };
}).filter(Boolean);

// Split into fast growers vs slow growers
channelEarlyPatterns.sort((a, b) => b.subsPerYear - a.subsPerYear);
const fastGrowers = channelEarlyPatterns.slice(0, Math.floor(channelEarlyPatterns.length / 2));
const slowGrowers = channelEarlyPatterns.slice(Math.floor(channelEarlyPatterns.length / 2));

console.log('FAST GROWERS (top half by subs/year):');
fastGrowers.forEach(c => {
  console.log(`  ${c.name} — ${(c.subsPerYear/1000).toFixed(0)}K subs/yr | ${c.uploadsPerMonth} vids/mo | ${c.earlyAvgDuration}min avg | ${c.titlePatternDiversity} patterns | ${c.growthRatio}x growth`);
});

console.log('\nSLOW GROWERS (bottom half):');
slowGrowers.forEach(c => {
  console.log(`  ${c.name} — ${(c.subsPerYear/1000).toFixed(0)}K subs/yr | ${c.uploadsPerMonth} vids/mo | ${c.earlyAvgDuration}min avg | ${c.titlePatternDiversity} patterns | ${c.growthRatio}x growth`);
});

// Aggregate comparison
console.log('\nFAST vs SLOW GROWERS — AVERAGES:');
const avg = (arr, fn) => arr.reduce((a, c) => a + fn(c), 0) / arr.length;
console.log(`                      Fast Growers    Slow Growers`);
console.log(`  Uploads/month:      ${avg(fastGrowers, c => c.uploadsPerMonth).toFixed(1).padStart(8)}       ${avg(slowGrowers, c => c.uploadsPerMonth).toFixed(1).padStart(8)}`);
console.log(`  Avg duration (min): ${avg(fastGrowers, c => c.earlyAvgDuration).toFixed(0).padStart(8)}       ${avg(slowGrowers, c => c.earlyAvgDuration).toFixed(0).padStart(8)}`);
console.log(`  Title patterns:     ${avg(fastGrowers, c => c.titlePatternDiversity).toFixed(1).padStart(8)}       ${avg(slowGrowers, c => c.titlePatternDiversity).toFixed(1).padStart(8)}`);
console.log(`  View growth ratio:  ${avg(fastGrowers, c => c.growthRatio).toFixed(1).padStart(8)}x      ${avg(slowGrowers, c => c.growthRatio).toFixed(1).padStart(8)}x`);

// What patterns do fast growers use more?
console.log('\nTITLE PATTERNS: FAST vs SLOW GROWERS');
const patternUsage = (group) => {
  const counts = {};
  for (const c of group) {
    const vids = channels.find(ch => ch.name === c.name)?.videos || [];
    for (const v of vids) {
      classifyTitle(v.title).forEach(p => {
        counts[p] = (counts[p] || 0) + 1;
      });
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts).map(([p, n]) => ({ pattern: p, pct: (n / total * 100) })).sort((a, b) => b.pct - a.pct);
};

const fastPatterns = patternUsage(fastGrowers);
const slowPatterns = patternUsage(slowGrowers);

fastPatterns.forEach(fp => {
  const sp = slowPatterns.find(s => s.pattern === fp.pattern);
  const diff = fp.pct - (sp?.pct || 0);
  const arrow = diff > 1 ? '↑' : diff < -1 ? '↓' : '≈';
  console.log(`  ${fp.pattern.padEnd(25)} Fast: ${fp.pct.toFixed(1)}%  Slow: ${(sp?.pct || 0).toFixed(1)}%  ${arrow}`);
});

console.log('\n=== DONE ===');

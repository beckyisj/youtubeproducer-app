const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'channel-data.json'), 'utf8'));

// ── Title pattern classifiers ──────────────────────────────────────────
const PATTERNS = [
  { name: 'Time Promise',        test: t => /\d+\s*(minute|hour|day|week|month|year|min|hr|sec)/i.test(t) },
  { name: 'Authority/Expert',    test: t => /\b(expert|doctor|dr\.|ceo|professor|#1|\$\d+[mkb])/i.test(t) },
  { name: 'Listicle/Number',     test: t => /^\d+\s|^\d+\.|(?:top|best)\s+\d+/i.test(t) },
  { name: 'Challenge/Experiment',test: t => /\b(challenge|tried|tested|experiment|i did .+ for)\b/i.test(t) },
  { name: 'Guide/Explainer',     test: t => /\b(guide|explained|everything you need)\b/i.test(t) },
  { name: 'Money/Financial',     test: t => /\$|\b(money|income|salary|rich|wealth|cost|earn|revenue|profit)\b/i.test(t) },
  { name: 'How To/Tutorial',     test: t => /\b(how to|tutorial|step by step)\b/i.test(t) },
  { name: 'Comparison/Versus',   test: t => /\b(vs\.?|versus|compared|better than)\b/i.test(t) },
  { name: 'Emotional/Clickbait', test: t => /\b(changed my life|ruined|destroyed|never|worst|best ever)\b/i.test(t) },
  { name: 'Review',              test: t => /\b(review|worth it|honest opinion)\b/i.test(t) },
  { name: 'Question',            test: t => /\?/.test(t) },
  { name: 'Why/Explanation',     test: t => /^(why|the reason)\b/i.test(t) },
];

function classifyTitle(title) {
  const matches = [];
  for (const p of PATTERNS) {
    if (p.test(title)) matches.push(p.name);
  }
  return matches.length ? matches : ['Other'];
}

// ── Duration buckets ───────────────────────────────────────────────────
const DURATION_BUCKETS = [
  { label: '0-3 min (Short)',    min: 0,    max: 180 },
  { label: '3-5 min',            min: 180,  max: 300 },
  { label: '5-10 min',           min: 300,  max: 600 },
  { label: '10-15 min',          min: 600,  max: 900 },
  { label: '15-20 min',          min: 900,  max: 1200 },
  { label: '20-30 min',          min: 1200, max: 1800 },
  { label: '30-60 min',          min: 1800, max: 3600 },
  { label: '60+ min',            min: 3600, max: Infinity },
];

function getBucket(durationSec) {
  for (const b of DURATION_BUCKETS) {
    if (durationSec >= b.min && durationSec < b.max) return b.label;
  }
  return '60+ min';
}

// ── Helpers ────────────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toString();
}

// ── Group channels by niche ────────────────────────────────────────────
const NICHES = ['self-development', 'business', 'creator', 'productivity', 'health', 'education', 'tech'];
const nicheChannels = {};
for (const niche of NICHES) {
  nicheChannels[niche] = data.filter(c => c.niche === niche);
}

// ── Global averages for comparison ─────────────────────────────────────
const allVideos = data.flatMap(c => c.videos);
const globalLikeRatio = mean(allVideos.filter(v => v.views > 0).map(v => v.likes / v.views));
const globalCommentRatio = mean(allVideos.filter(v => v.views > 0).map(v => v.comments / v.views));

// ── Per-niche analysis ─────────────────────────────────────────────────
const results = {};

for (const niche of NICHES) {
  const channels = nicheChannels[niche];
  const videos = channels.flatMap(c => c.videos);
  const now = new Date('2026-03-11');

  // 1. Niche overview
  const channelAges = channels.map(c => (now - new Date(c.createdAt)) / (365.25 * 24 * 60 * 60 * 1000));
  const overview = {
    channelCount: channels.length,
    totalVideosAnalyzed: videos.length,
    averageChannelAgeYears: parseFloat(mean(channelAges).toFixed(1)),
    averageSubscribers: Math.round(mean(channels.map(c => c.subscribers))),
    medianSubscribers: Math.round(median(channels.map(c => c.subscribers))),
    totalSubscribersAcrossNiche: channels.reduce((a, c) => a + c.subscribers, 0),
  };

  // Normalized views: views / channel subscribers (so small and big channels comparable)
  // Attach channel subs to each video
  const enrichedVideos = [];
  for (const ch of channels) {
    for (const v of ch.videos) {
      enrichedVideos.push({
        ...v,
        channelName: ch.name,
        channelHandle: ch.handle,
        channelSubs: ch.subscribers,
        normalizedViews: ch.subscribers > 0 ? v.views / ch.subscribers : 0,
      });
    }
  }

  // 2. Optimal video length
  const bucketStats = {};
  for (const v of enrichedVideos) {
    const bucket = getBucket(v.durationSec);
    if (!bucketStats[bucket]) bucketStats[bucket] = { views: [], normalizedViews: [], count: 0 };
    bucketStats[bucket].views.push(v.views);
    bucketStats[bucket].normalizedViews.push(v.normalizedViews);
    bucketStats[bucket].count++;
  }
  const durationBuckets = Object.entries(bucketStats)
    .map(([label, s]) => ({
      bucket: label,
      videoCount: s.count,
      medianViews: Math.round(median(s.views)),
      avgNormalizedViews: parseFloat(mean(s.normalizedViews).toFixed(3)),
    }))
    .sort((a, b) => b.avgNormalizedViews - a.avgNormalizedViews);

  const optimalLength = {
    bestBucket: durationBuckets[0]?.bucket || 'N/A',
    bestNormalizedViews: durationBuckets[0]?.avgNormalizedViews || 0,
    allBuckets: durationBuckets,
  };

  // 3. Best title patterns
  const patternStats = {};
  for (const v of enrichedVideos) {
    const patterns = classifyTitle(v.title);
    for (const p of patterns) {
      if (!patternStats[p]) patternStats[p] = { views: [], normalizedViews: [], count: 0 };
      patternStats[p].views.push(v.views);
      patternStats[p].normalizedViews.push(v.normalizedViews);
      patternStats[p].count++;
    }
  }
  const titlePatterns = Object.entries(patternStats)
    .map(([name, s]) => ({
      pattern: name,
      videoCount: s.count,
      medianViews: Math.round(median(s.views)),
      avgNormalizedViews: parseFloat(mean(s.normalizedViews).toFixed(3)),
      percentOfVideos: parseFloat(((s.count / enrichedVideos.length) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.avgNormalizedViews - a.avgNormalizedViews);

  // 4. Upload frequency
  const channelFrequencies = channels.map(ch => {
    if (ch.videos.length < 2) return { name: ch.name, uploadsPerMonth: 0 };
    const dates = ch.videos.map(v => new Date(v.publishedAt)).sort((a, b) => a - b);
    const spanMonths = (dates[dates.length - 1] - dates[0]) / (30.44 * 24 * 60 * 60 * 1000);
    return {
      name: ch.name,
      uploadsPerMonth: spanMonths > 0 ? parseFloat((ch.videos.length / spanMonths).toFixed(2)) : 0,
    };
  });
  // Correlation: do channels with higher frequency have more subs?
  const freqSubsPairs = channels.map((ch, i) => ({
    freq: channelFrequencies[i].uploadsPerMonth,
    subs: ch.subscribers,
    subsPerYear: channelAges[i] > 0 ? ch.subscribers / channelAges[i] : 0,
  })).filter(p => p.freq > 0);

  let freqCorrelation = 'insufficient data';
  if (freqSubsPairs.length >= 3) {
    const avgFreq = mean(freqSubsPairs.map(p => p.freq));
    const avgGrowth = mean(freqSubsPairs.map(p => p.subsPerYear));
    const aboveAvgFreq = freqSubsPairs.filter(p => p.freq > avgFreq);
    const belowAvgFreq = freqSubsPairs.filter(p => p.freq <= avgFreq);
    const avgGrowthHigh = aboveAvgFreq.length ? mean(aboveAvgFreq.map(p => p.subsPerYear)) : 0;
    const avgGrowthLow = belowAvgFreq.length ? mean(belowAvgFreq.map(p => p.subsPerYear)) : 0;
    freqCorrelation = avgGrowthHigh > avgGrowthLow * 1.2 ? 'positive' : avgGrowthLow > avgGrowthHigh * 1.2 ? 'negative' : 'weak/neutral';
  }

  const uploadFrequency = {
    avgUploadsPerMonth: parseFloat(mean(channelFrequencies.map(c => c.uploadsPerMonth)).toFixed(2)),
    medianUploadsPerMonth: parseFloat(median(channelFrequencies.map(c => c.uploadsPerMonth)).toFixed(2)),
    frequencyGrowthCorrelation: freqCorrelation,
    channelBreakdown: channelFrequencies,
  };

  // 5. Engagement profile
  const videosWithViews = enrichedVideos.filter(v => v.views > 0);
  const likeRatios = videosWithViews.map(v => v.likes / v.views);
  const commentRatios = videosWithViews.map(v => v.comments / v.views);
  const engagement = {
    avgLikeRatio: parseFloat(mean(likeRatios).toFixed(5)),
    avgCommentRatio: parseFloat(mean(commentRatios).toFixed(5)),
    globalAvgLikeRatio: parseFloat(globalLikeRatio.toFixed(5)),
    globalAvgCommentRatio: parseFloat(globalCommentRatio.toFixed(5)),
    likeRatioVsGlobal: parseFloat((mean(likeRatios) / globalLikeRatio).toFixed(2)) + 'x',
    commentRatioVsGlobal: parseFloat((mean(commentRatios) / globalCommentRatio).toFixed(2)) + 'x',
  };

  // 6. Top performing channels
  const topChannels = channels
    .map(ch => ({
      name: ch.name,
      handle: ch.handle,
      subscribers: ch.subscribers,
      totalViews: ch.totalViews,
      totalVideos: ch.totalVideos,
      avgViewsPerVideo: ch.totalVideos > 0 ? Math.round(ch.totalViews / ch.totalVideos) : 0,
      subsPerVideo: ch.totalVideos > 0 ? Math.round(ch.subscribers / ch.totalVideos) : 0,
      channelAgeYears: parseFloat(((now - new Date(ch.createdAt)) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1)),
    }))
    .sort((a, b) => b.subscribers - a.subscribers);

  // 7. Top 5 videos by normalized views
  const top5Videos = [...enrichedVideos]
    .sort((a, b) => b.normalizedViews - a.normalizedViews)
    .slice(0, 5)
    .map(v => ({
      title: v.title,
      channelName: v.channelName,
      channelHandle: v.channelHandle,
      views: v.views,
      normalizedViews: parseFloat(v.normalizedViews.toFixed(3)),
      likes: v.likes,
      comments: v.comments,
      durationSec: v.durationSec,
      publishedAt: v.publishedAt,
    }));

  // 8. Growth patterns
  const growthData = channels.map((ch, i) => ({
    name: ch.name,
    handle: ch.handle,
    subscribers: ch.subscribers,
    ageYears: channelAges[i],
    subsPerYear: channelAges[i] > 0 ? Math.round(ch.subscribers / channelAges[i]) : 0,
    subsPerVideo: ch.totalVideos > 0 ? Math.round(ch.subscribers / ch.totalVideos) : 0,
  }));
  const fastestGrower = [...growthData].sort((a, b) => b.subsPerYear - a.subsPerYear)[0];
  const mostEfficient = [...growthData].sort((a, b) => b.subsPerVideo - a.subsPerVideo)[0];

  const growth = {
    avgSubsPerYear: Math.round(mean(growthData.map(g => g.subsPerYear))),
    fastestGrower: fastestGrower ? { name: fastestGrower.name, subsPerYear: fastestGrower.subsPerYear, ageYears: parseFloat(fastestGrower.ageYears.toFixed(1)) } : null,
    mostEfficientSubsPerVideo: mostEfficient ? { name: mostEfficient.name, subsPerVideo: mostEfficient.subsPerVideo } : null,
    channelGrowth: growthData.sort((a, b) => b.subsPerYear - a.subsPerYear),
  };

  results[niche] = {
    overview,
    optimalLength,
    titlePatterns,
    uploadFrequency,
    engagement,
    topChannels,
    top5Videos,
    growth,
  };
}

// ── Write output ───────────────────────────────────────────────────────
const outputPath = path.join(__dirname, 'niche-results.json');
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`\nResults written to ${outputPath}\n`);

// ── Print summary ──────────────────────────────────────────────────────
console.log('=' .repeat(70));
console.log('  NICHE PLAYBOOK SUMMARY');
console.log('='.repeat(70));

for (const niche of NICHES) {
  const r = results[niche];
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${niche.toUpperCase()}`);
  console.log(`${'─'.repeat(70)}`);

  console.log(`  Channels: ${r.overview.channelCount} | Videos analyzed: ${r.overview.totalVideosAnalyzed} | Avg age: ${r.overview.averageChannelAgeYears}y | Avg subs: ${formatNum(r.overview.averageSubscribers)}`);

  console.log(`\n  Optimal length: ${r.optimalLength.bestBucket} (normalized views: ${r.optimalLength.bestNormalizedViews})`);
  console.log(`  Duration breakdown:`);
  for (const b of r.optimalLength.allBuckets.slice(0, 5)) {
    console.log(`    ${b.bucket.padEnd(22)} ${String(b.videoCount).padStart(4)} videos | median views: ${formatNum(b.medianViews).padStart(8)} | norm: ${b.avgNormalizedViews}`);
  }

  console.log(`\n  Top title patterns (by normalized views):`);
  for (const p of r.titlePatterns.slice(0, 6)) {
    console.log(`    ${p.pattern.padEnd(24)} ${String(p.videoCount).padStart(4)} videos (${String(p.percentOfVideos).padStart(5)}%) | norm: ${p.avgNormalizedViews}`);
  }

  console.log(`\n  Upload frequency: ${r.uploadFrequency.avgUploadsPerMonth}/mo avg | Freq→Growth: ${r.uploadFrequency.frequencyGrowthCorrelation}`);

  console.log(`\n  Engagement: Like ratio ${r.engagement.avgLikeRatio} (${r.engagement.likeRatioVsGlobal} global) | Comment ratio ${r.engagement.avgCommentRatio} (${r.engagement.commentRatioVsGlobal} global)`);

  console.log(`\n  Top channels:`);
  for (const c of r.topChannels.slice(0, 3)) {
    console.log(`    ${c.name.padEnd(28)} ${formatNum(c.subscribers).padStart(8)} subs | ${formatNum(c.avgViewsPerVideo).padStart(8)} avg views/vid`);
  }

  console.log(`\n  Top 5 videos:`);
  for (const v of r.top5Videos) {
    console.log(`    [${v.normalizedViews}x] ${v.title.slice(0, 55).padEnd(55)} ${formatNum(v.views).padStart(8)} views (${v.channelName})`);
  }

  console.log(`\n  Growth: Avg ${formatNum(r.growth.avgSubsPerYear)} subs/yr | Fastest: ${r.growth.fastestGrower?.name} (${formatNum(r.growth.fastestGrower?.subsPerYear)}/yr) | Best efficiency: ${r.growth.mostEfficientSubsPerVideo?.name} (${formatNum(r.growth.mostEfficientSubsPerVideo?.subsPerVideo)} subs/vid)`);
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  Done. ${Object.keys(results).length} niches analyzed.`);
console.log(`${'='.repeat(70)}\n`);

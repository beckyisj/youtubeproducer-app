const fs = require('fs');
const path = require('path');

const data = require('./channel-data.json');
const OUT = path.join(__dirname, 'engagement-results.json');

// Flatten all videos with channel metadata
const allVideos = [];
for (const ch of data) {
  for (const v of ch.videos) {
    if (v.views > 0) {
      allVideos.push({
        ...v,
        channelName: ch.name,
        niche: ch.niche,
        subscribers: ch.subscribers,
      });
    }
  }
}

console.log(`Analyzing ${allVideos.length} videos across ${data.length} channels\n`);

// ─── 1. Engagement ratios by niche ───────────────────────────────────────────
const nicheMap = {};
for (const v of allVideos) {
  if (!nicheMap[v.niche]) nicheMap[v.niche] = { views: 0, likes: 0, comments: 0, count: 0 };
  const n = nicheMap[v.niche];
  n.views += v.views;
  n.likes += v.likes;
  n.comments += v.comments;
  n.count++;
}

const nicheEngagement = Object.entries(nicheMap)
  .map(([niche, d]) => ({
    niche,
    videoCount: d.count,
    totalViews: d.views,
    likeToViewPct: +((d.likes / d.views) * 100).toFixed(3),
    commentToViewPct: +((d.comments / d.views) * 100).toFixed(4),
    likeToCommentRatio: +(d.likes / d.comments).toFixed(1),
  }))
  .sort((a, b) => b.likeToViewPct - a.likeToViewPct);

console.log('=== 1. ENGAGEMENT RATIOS BY NICHE ===');
console.table(nicheEngagement.map(n => ({
  Niche: n.niche,
  Videos: n.videoCount,
  'Like/View %': n.likeToViewPct + '%',
  'Comment/View %': n.commentToViewPct + '%',
  'Likes per Comment': n.likeToCommentRatio,
})));

// ─── 2. Top 10 most-commented videos (comments per 100K views) ──────────────
const commentNormalized = allVideos
  .filter(v => v.views >= 1000) // min threshold to avoid noise
  .map(v => ({
    title: v.title,
    channel: v.channelName,
    niche: v.niche,
    views: v.views,
    comments: v.comments,
    commentsPer100K: +((v.comments / v.views) * 100000).toFixed(1),
  }))
  .sort((a, b) => b.commentsPer100K - a.commentsPer100K)
  .slice(0, 10);

console.log('\n=== 2. TOP 10 MOST-COMMENTED (per 100K views) ===');
commentNormalized.forEach((v, i) => {
  console.log(`${i + 1}. ${v.commentsPer100K} comments/100K — "${v.title.slice(0, 60)}" (${v.channel})`);
});

// ─── 3. Top 10 highest like ratio (likes per 100K views) ────────────────────
const likeNormalized = allVideos
  .filter(v => v.views >= 1000)
  .map(v => ({
    title: v.title,
    channel: v.channelName,
    niche: v.niche,
    views: v.views,
    likes: v.likes,
    likesPer100K: +((v.likes / v.views) * 100000).toFixed(1),
  }))
  .sort((a, b) => b.likesPer100K - a.likesPer100K)
  .slice(0, 10);

console.log('\n=== 3. TOP 10 HIGHEST LIKE RATIO (per 100K views) ===');
likeNormalized.forEach((v, i) => {
  console.log(`${i + 1}. ${v.likesPer100K} likes/100K — "${v.title.slice(0, 60)}" (${v.channel})`);
});

// ─── 4. Engagement vs video length (duration buckets) ────────────────────────
const buckets = [
  { label: 'Under 5min', min: 0, max: 300 },
  { label: '5–10min', min: 300, max: 600 },
  { label: '10–15min', min: 600, max: 900 },
  { label: '15–20min', min: 900, max: 1200 },
  { label: '20–30min', min: 1200, max: 1800 },
  { label: '30–45min', min: 1800, max: 2700 },
  { label: '45–60min', min: 2700, max: 3600 },
  { label: '60min+', min: 3600, max: Infinity },
];

const durationEngagement = buckets.map(b => {
  const vids = allVideos.filter(v => v.durationSec >= b.min && v.durationSec < b.max);
  const totalViews = vids.reduce((s, v) => s + v.views, 0);
  const totalLikes = vids.reduce((s, v) => s + v.likes, 0);
  const totalComments = vids.reduce((s, v) => s + v.comments, 0);
  return {
    bucket: b.label,
    videoCount: vids.length,
    avgViews: vids.length ? Math.round(totalViews / vids.length) : 0,
    likeToViewPct: totalViews ? +((totalLikes / totalViews) * 100).toFixed(3) : 0,
    commentToViewPct: totalViews ? +((totalComments / totalViews) * 100).toFixed(4) : 0,
    likesPer100K: totalViews ? +((totalLikes / totalViews) * 100000).toFixed(1) : 0,
    commentsPer100K: totalViews ? +((totalComments / totalViews) * 100000).toFixed(1) : 0,
  };
});

console.log('\n=== 4. ENGAGEMENT BY VIDEO LENGTH ===');
console.table(durationEngagement.map(d => ({
  Duration: d.bucket,
  Videos: d.videoCount,
  'Avg Views': d.avgViews.toLocaleString(),
  'Like/View %': d.likeToViewPct + '%',
  'Comment/View %': d.commentToViewPct + '%',
})));

// ─── 5. Channel-level engagement leaders ─────────────────────────────────────
const channelEngagement = data
  .filter(ch => ch.videos.length >= 3) // need minimum sample
  .map(ch => {
    const vids = ch.videos.filter(v => v.views > 0);
    const totalViews = vids.reduce((s, v) => s + v.views, 0);
    const totalLikes = vids.reduce((s, v) => s + v.likes, 0);
    const totalComments = vids.reduce((s, v) => s + v.comments, 0);
    return {
      channel: ch.name,
      niche: ch.niche,
      subscribers: ch.subscribers,
      videoCount: vids.length,
      totalViews,
      likeToViewPct: totalViews ? +((totalLikes / totalViews) * 100).toFixed(3) : 0,
      commentToViewPct: totalViews ? +((totalComments / totalViews) * 100).toFixed(4) : 0,
      engagementPct: totalViews ? +(((totalLikes + totalComments) / totalViews) * 100).toFixed(3) : 0,
    };
  })
  .sort((a, b) => b.engagementPct - a.engagementPct);

console.log('\n=== 5. CHANNEL ENGAGEMENT LEADERS (top 15) ===');
channelEngagement.slice(0, 15).forEach((c, i) => {
  console.log(`${(i + 1).toString().padStart(2)}. ${c.engagementPct}% — ${c.channel} (${c.niche}, ${c.videoCount} vids, ${c.subscribers.toLocaleString()} subs)`);
});

// ─── 6. Comments vs likes correlation ────────────────────────────────────────
// Pearson correlation between like-rate and comment-rate per video
const rateVideos = allVideos
  .filter(v => v.views >= 1000)
  .map(v => ({
    likeRate: v.likes / v.views,
    commentRate: v.comments / v.views,
  }));

function pearson(arr, keyX, keyY) {
  const n = arr.length;
  const sumX = arr.reduce((s, d) => s + d[keyX], 0);
  const sumY = arr.reduce((s, d) => s + d[keyY], 0);
  const sumXY = arr.reduce((s, d) => s + d[keyX] * d[keyY], 0);
  const sumX2 = arr.reduce((s, d) => s + d[keyX] ** 2, 0);
  const sumY2 = arr.reduce((s, d) => s + d[keyY] ** 2, 0);
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  return den === 0 ? 0 : +(num / den).toFixed(4);
}

const correlation = pearson(rateVideos, 'likeRate', 'commentRate');

// Also bucket by like-rate quartiles to see comment behavior
const sorted = [...rateVideos].sort((a, b) => a.likeRate - b.likeRate);
const q = Math.floor(sorted.length / 4);
const quartiles = [
  { label: 'Bottom 25% likes', slice: sorted.slice(0, q) },
  { label: '25–50% likes', slice: sorted.slice(q, q * 2) },
  { label: '50–75% likes', slice: sorted.slice(q * 2, q * 3) },
  { label: 'Top 25% likes', slice: sorted.slice(q * 3) },
];

const correlationAnalysis = {
  pearsonCorrelation: correlation,
  interpretation: correlation > 0.5 ? 'Strong positive — high likes = high comments'
    : correlation > 0.2 ? 'Moderate positive — likes and comments tend to move together'
    : correlation > -0.2 ? 'Weak/no correlation — likes and comments are fairly independent'
    : 'Negative correlation — high likes does NOT mean high comments',
  quartileBreakdown: quartiles.map(qr => ({
    label: qr.label,
    count: qr.slice.length,
    avgLikeRate: +(qr.slice.reduce((s, v) => s + v.likeRate, 0) / qr.slice.length * 100).toFixed(3) + '%',
    avgCommentRate: +(qr.slice.reduce((s, v) => s + v.commentRate, 0) / qr.slice.length * 100).toFixed(4) + '%',
  })),
};

console.log('\n=== 6. COMMENTS vs LIKES CORRELATION ===');
console.log(`Pearson r = ${correlation} → ${correlationAnalysis.interpretation}`);
console.log('Quartile breakdown:');
console.table(correlationAnalysis.quartileBreakdown);

// ─── Write results ───────────────────────────────────────────────────────────
const results = {
  meta: {
    generatedAt: new Date().toISOString(),
    totalChannels: data.length,
    totalVideos: allVideos.length,
    niches: [...new Set(data.map(c => c.niche))],
  },
  nicheEngagement,
  top10CommentNormalized: commentNormalized,
  top10LikeNormalized: likeNormalized,
  durationEngagement,
  channelEngagement,
  correlationAnalysis,
};

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\nResults written to ${OUT}`);

const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DATA_PATH = path.join(__dirname, 'channel-data.json');
const OUTPUT_PATH = path.join(__dirname, 'thumbnail-results.json');
const PROGRESS_PATH = path.join(__dirname, 'thumbnail-progress.json');
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 500;

// ── Helpers ──────────────────────────────────────────────────────────

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hueToBucket(h) {
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 75) return 'yellow';
  if (h < 165) return 'green';
  if (h < 255) return 'blue';
  if (h < 345) return 'purple';
  return 'neutral';
}

async function analyzeImage(buffer) {
  // Resize to small dimensions for speed, get raw RGBA pixels
  const { data, info } = await sharp(buffer)
    .resize(80, 45, { fit: 'fill' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  let totalBrightness = 0;
  let totalSaturation = 0;
  const brightnessValues = [];
  const hueBuckets = { red: 0, orange: 0, yellow: 0, green: 0, blue: 0, purple: 0, neutral: 0 };

  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4;
    const r = data[off], g = data[off + 1], b = data[off + 2];

    // Luminance (perceived brightness)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    totalBrightness += lum;
    brightnessValues.push(lum);

    const hsl = rgbToHsl(r, g, b);
    totalSaturation += hsl.s;

    // Only count hue for sufficiently saturated & non-extreme-lightness pixels
    if (hsl.s > 0.15 && hsl.l > 0.1 && hsl.l < 0.9) {
      hueBuckets[hueToBucket(hsl.h)]++;
    } else {
      hueBuckets.neutral++;
    }
  }

  const avgBrightness = totalBrightness / pixelCount;
  const avgSaturation = totalSaturation / pixelCount;

  // Contrast = standard deviation of brightness
  const variance = brightnessValues.reduce((sum, v) => sum + (v - avgBrightness) ** 2, 0) / pixelCount;
  const contrast = Math.sqrt(variance);

  // Dominant color = bucket with most pixels
  const dominantColor = Object.entries(hueBuckets).sort((a, b) => b[1] - a[1])[0][0];

  return {
    avgBrightness: Math.round(avgBrightness * 10) / 10,
    avgSaturation: Math.round(avgSaturation * 1000) / 1000,
    contrast: Math.round(contrast * 10) / 10,
    dominantColor,
    isDark: avgBrightness < 80,
    isBright: avgBrightness > 170,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const channels = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

  // Flatten all videos with channel/niche context
  const allVideos = [];
  for (const ch of channels) {
    for (const v of ch.videos) {
      allVideos.push({
        videoId: v.id,
        title: v.title,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        channelHandle: ch.handle,
        channelName: ch.name,
        niche: ch.niche,
      });
    }
  }

  // Compute per-channel median views for normalization
  const channelViews = {};
  for (const ch of channels) {
    const sorted = ch.videos.map((v) => v.views).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    channelViews[ch.handle] = sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Load progress if exists
  let completed = {};
  if (fs.existsSync(PROGRESS_PATH)) {
    try {
      completed = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
      console.log(`Resuming — ${Object.keys(completed).length} already processed`);
    } catch { completed = {}; }
  }

  const total = allVideos.length;
  let processed = Object.keys(completed).length;
  let errors = 0;

  console.log(`Processing ${total} thumbnails in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = allVideos.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (v) => {
      if (completed[v.videoId]) return; // skip done

      const url = `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`;
      try {
        const buf = await downloadImage(url);
        const analysis = await analyzeImage(buf);
        const medianViews = channelViews[v.channelHandle] || 1;
        completed[v.videoId] = {
          ...v,
          ...analysis,
          viewsVsMedian: Math.round((v.views / medianViews) * 100) / 100,
        };
        processed++;
      } catch (err) {
        errors++;
        // Store with null analysis so we don't retry forever
        completed[v.videoId] = { ...v, error: err.message };
        processed++;
      }
    });

    await Promise.all(promises);

    // Progress log
    if ((i + BATCH_SIZE) % 200 === 0 || i + BATCH_SIZE >= total) {
      console.log(`  ${Math.min(i + BATCH_SIZE, total)}/${total} done (${errors} errors)`);
      // Save progress
      fs.writeFileSync(PROGRESS_PATH, JSON.stringify(completed, null, 2));
    }

    if (i + BATCH_SIZE < total) await sleep(BATCH_DELAY_MS);
  }

  // ── Build final results ──────────────────────────────────────────

  const results = Object.values(completed).filter((v) => !v.error);
  const errored = Object.values(completed).filter((v) => v.error);

  // Overall stats
  const overallStats = computeStats(results);

  // By niche
  const byNiche = {};
  for (const v of results) {
    if (!byNiche[v.niche]) byNiche[v.niche] = [];
    byNiche[v.niche].push(v);
  }
  const nicheStats = {};
  for (const [niche, videos] of Object.entries(byNiche)) {
    nicheStats[niche] = computeStats(videos);
  }

  // By dominant color
  const byColor = {};
  for (const v of results) {
    if (!byColor[v.dominantColor]) byColor[v.dominantColor] = [];
    byColor[v.dominantColor].push(v);
  }
  const colorStats = {};
  for (const [color, videos] of Object.entries(byColor)) {
    colorStats[color] = {
      count: videos.length,
      avgViewsVsMedian: avg(videos.map((v) => v.viewsVsMedian)),
      avgBrightness: avg(videos.map((v) => v.avgBrightness)),
      avgSaturation: avg(videos.map((v) => v.avgSaturation)),
    };
  }

  // Dark vs bright performance
  const darkVideos = results.filter((v) => v.isDark);
  const brightVideos = results.filter((v) => v.isBright);
  const midVideos = results.filter((v) => !v.isDark && !v.isBright);

  const brightnessPerformance = {
    dark: { count: darkVideos.length, avgViewsVsMedian: avg(darkVideos.map((v) => v.viewsVsMedian)) },
    mid: { count: midVideos.length, avgViewsVsMedian: avg(midVideos.map((v) => v.viewsVsMedian)) },
    bright: { count: brightVideos.length, avgViewsVsMedian: avg(brightVideos.map((v) => v.viewsVsMedian)) },
  };

  // Contrast quartiles
  const sortedByContrast = [...results].sort((a, b) => a.contrast - b.contrast);
  const q = Math.floor(sortedByContrast.length / 4);
  const contrastPerformance = {
    low: { range: `0-${sortedByContrast[q]?.contrast}`, count: q, avgViewsVsMedian: avg(sortedByContrast.slice(0, q).map((v) => v.viewsVsMedian)) },
    midLow: { count: q, avgViewsVsMedian: avg(sortedByContrast.slice(q, q * 2).map((v) => v.viewsVsMedian)) },
    midHigh: { count: q, avgViewsVsMedian: avg(sortedByContrast.slice(q * 2, q * 3).map((v) => v.viewsVsMedian)) },
    high: { range: `${sortedByContrast[q * 3]?.contrast}+`, count: sortedByContrast.length - q * 3, avgViewsVsMedian: avg(sortedByContrast.slice(q * 3).map((v) => v.viewsVsMedian)) },
  };

  // Saturation quartiles
  const sortedBySat = [...results].sort((a, b) => a.avgSaturation - b.avgSaturation);
  const sq = Math.floor(sortedBySat.length / 4);
  const saturationPerformance = {
    low: { range: `0-${sortedBySat[sq]?.avgSaturation}`, count: sq, avgViewsVsMedian: avg(sortedBySat.slice(0, sq).map((v) => v.viewsVsMedian)) },
    midLow: { count: sq, avgViewsVsMedian: avg(sortedBySat.slice(sq, sq * 2).map((v) => v.viewsVsMedian)) },
    midHigh: { count: sq, avgViewsVsMedian: avg(sortedBySat.slice(sq * 2, sq * 3).map((v) => v.viewsVsMedian)) },
    high: { range: `${sortedBySat[sq * 3]?.avgSaturation}+`, count: sortedBySat.length - sq * 3, avgViewsVsMedian: avg(sortedBySat.slice(sq * 3).map((v) => v.viewsVsMedian)) },
  };

  const output = {
    meta: {
      totalVideos: total,
      analyzed: results.length,
      errors: errored.length,
      generatedAt: new Date().toISOString(),
    },
    overallStats,
    nicheStats,
    colorStats,
    brightnessPerformance,
    contrastPerformance,
    saturationPerformance,
    // Per-video data for further analysis
    videos: results,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nDone! Results saved to ${OUTPUT_PATH}`);
  console.log(`  Analyzed: ${results.length}, Errors: ${errored.length}`);

  // Clean up progress file
  if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);

  // Print summary
  console.log('\n── Summary ──');
  console.log('Overall:', JSON.stringify(overallStats, null, 2));
  console.log('\nBy Brightness:', JSON.stringify(brightnessPerformance, null, 2));
  console.log('\nBy Dominant Color:', JSON.stringify(colorStats, null, 2));
  console.log('\nBy Contrast Quartile:', JSON.stringify(contrastPerformance, null, 2));
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
}

function computeStats(videos) {
  if (!videos.length) return {};
  return {
    count: videos.length,
    avgBrightness: avg(videos.map((v) => v.avgBrightness)),
    avgSaturation: avg(videos.map((v) => v.avgSaturation)),
    avgContrast: avg(videos.map((v) => v.contrast)),
    avgViewsVsMedian: avg(videos.map((v) => v.viewsVsMedian)),
    pctDark: Math.round((videos.filter((v) => v.isDark).length / videos.length) * 100),
    pctBright: Math.round((videos.filter((v) => v.isBright).length / videos.length) * 100),
    dominantColorDistribution: (() => {
      const dist = {};
      for (const v of videos) {
        dist[v.dominantColor] = (dist[v.dominantColor] || 0) + 1;
      }
      // Convert to percentages
      for (const k of Object.keys(dist)) {
        dist[k] = Math.round((dist[k] / videos.length) * 100);
      }
      return dist;
    })(),
  };
}

main().catch(console.error);

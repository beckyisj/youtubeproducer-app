// Collects YouTube channel + video data for cross-channel analysis
// Usage: node collect-data.js

const API_KEY = 'REDACTED_GOOGLE_API_KEY';
const fs = require('fs');
const path = require('path');

// ~40 channels across niches
const CHANNELS = [
  // Self-Development
  { handle: '@DanielPink', niche: 'self-development' },
  { handle: '@MarkManson', niche: 'self-development' },
  { handle: '@JamesClear', niche: 'self-development' },
  { handle: '@JayShetty', niche: 'self-development' },
  { handle: '@melrobbins', niche: 'self-development' },
  { handle: '@RyanHoliday', niche: 'self-development' },
  { handle: '@AndreHuberman', niche: 'self-development' },
  { handle: '@TheSchoolofLife', niche: 'self-development' },
  { handle: '@Einzelganger', niche: 'self-development' },

  // Business / Money
  { handle: '@GrahamStephan', niche: 'business' },
  { handle: '@AndreiJikh', niche: 'business' },
  { handle: '@CodieSanchezCT', niche: 'business' },
  { handle: '@AlexHormozi', niche: 'business' },
  { handle: '@LeilaHormozi', niche: 'business' },
  { handle: '@patrickbetdavid', niche: 'business' },
  { handle: '@MyFirstMillionPod', niche: 'business' },
  { handle: '@SimonSquibb', niche: 'business' },

  // Creator Economy / YouTube Education
  { handle: '@ColinandSamir', niche: 'creator' },
  { handle: '@PaddyGalloway', niche: 'creator' },
  { handle: '@FilmBooth', niche: 'creator' },
  { handle: '@ThinkMedia', niche: 'creator' },
  { handle: '@vanessalau', niche: 'creator' },
  { handle: '@JennyHoyos', niche: 'creator' },

  // Productivity / Lifestyle
  { handle: '@Thomasfrank', niche: 'productivity' },
  { handle: '@mattdavella', niche: 'productivity' },
  { handle: '@MikeShake', niche: 'productivity' },
  { handle: '@elizabethfilips', niche: 'productivity' },
  { handle: '@jeffsu', niche: 'productivity' },
  { handle: '@CaptainSinbad', niche: 'productivity' },

  // Health / Fitness (adjacent)
  { handle: '@JeffNippard', niche: 'health' },
  { handle: '@drericberg', niche: 'health' },
  { handle: '@SamSulek', niche: 'health' },

  // Education / Knowledge
  { handle: '@Vsauce', niche: 'education' },
  { handle: '@veritasium', niche: 'education' },
  { handle: '@kuaborern', niche: 'education' },
  { handle: '@johnnyharris', niche: 'education' },
  { handle: '@PolyMatter', niche: 'education' },

  // Tech / Reviews
  { handle: '@mkbhd', niche: 'tech' },
  { handle: '@LinusTechTips', niche: 'tech' },
  { handle: '@firaboreal', niche: 'tech' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Resolve @handle to channel ID
async function resolveHandle(handle) {
  const clean = handle.replace('@', '');
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics,contentDetails&forHandle=${clean}&key=${API_KEY}`;
  const data = await apiFetch(url);
  if (!data.items || data.items.length === 0) {
    // Try as username
    const url2 = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics,contentDetails&forUsername=${clean}&key=${API_KEY}`;
    const data2 = await apiFetch(url2);
    if (!data2.items || data2.items.length === 0) return null;
    return data2.items[0];
  }
  return data.items[0];
}

// Parse ISO 8601 duration to seconds
function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

// Get uploads playlist videos (up to 200)
async function getVideos(uploadsPlaylistId, maxResults = 200) {
  let videos = [];
  let pageToken = '';
  while (videos.length < maxResults) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails,snippet&playlistId=${uploadsPlaylistId}&maxResults=50&key=${API_KEY}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const data = await apiFetch(url);
    if (!data.items) break;
    videos = videos.concat(data.items);
    if (!data.nextPageToken || videos.length >= maxResults) break;
    pageToken = data.nextPageToken;
    await sleep(100);
  }
  return videos;
}

// Get video details (duration, views, likes, comments) in batches of 50
async function getVideoDetails(videoIds) {
  const details = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${batch.join(',')}&key=${API_KEY}`;
    const data = await apiFetch(url);
    if (data.items) details.push(...data.items);
    await sleep(100);
  }
  return details;
}

async function processChannel(channelConfig) {
  const { handle, niche } = channelConfig;
  console.log(`Processing ${handle}...`);

  const channel = await resolveHandle(handle);
  if (!channel) {
    console.log(`  Could not resolve ${handle}, skipping`);
    return null;
  }

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.log(`  No uploads playlist for ${handle}, skipping`);
    return null;
  }

  // Get video list
  const playlistItems = await getVideos(uploadsPlaylistId, 200);
  const videoIds = playlistItems.map(v => v.contentDetails.videoId);

  // Get video details
  const videoDetails = await getVideoDetails(videoIds);
  const detailsMap = {};
  for (const d of videoDetails) {
    detailsMap[d.id] = d;
  }

  // Combine
  const videos = playlistItems.map(item => {
    const detail = detailsMap[item.contentDetails.videoId];
    if (!detail) return null;
    const durationSec = parseDuration(detail.contentDetails?.duration || 'PT0S');
    const views = parseInt(detail.statistics?.viewCount || 0);
    const likes = parseInt(detail.statistics?.likeCount || 0);
    const comments = parseInt(detail.statistics?.commentCount || 0);
    return {
      id: item.contentDetails.videoId,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      durationSec,
      views,
      likes,
      comments,
    };
  }).filter(Boolean);

  // Filter out Shorts (< 90s)
  const longForm = videos.filter(v => v.durationSec >= 90);
  const shorts = videos.filter(v => v.durationSec < 90);

  const channelData = {
    id: channel.id,
    handle,
    niche,
    name: channel.snippet.title,
    createdAt: channel.snippet.publishedAt,
    subscribers: parseInt(channel.statistics?.subscriberCount || 0),
    totalViews: parseInt(channel.statistics?.viewCount || 0),
    totalVideos: parseInt(channel.statistics?.videoCount || 0),
    videosCollected: longForm.length,
    shortsCollected: shorts.length,
    videos: longForm,
  };

  console.log(`  ${channel.snippet.title}: ${longForm.length} long-form, ${shorts.length} shorts`);
  return channelData;
}

async function main() {
  console.log(`Collecting data for ${CHANNELS.length} channels...\n`);
  const results = [];

  for (const ch of CHANNELS) {
    try {
      const data = await processChannel(ch);
      if (data) results.push(data);
      await sleep(200); // rate limit buffer
    } catch (err) {
      console.log(`  Error on ${ch.handle}: ${err.message}`);
    }
  }

  const outPath = path.join(__dirname, 'channel-data.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nDone! ${results.length} channels saved to ${outPath}`);

  // Quick summary
  const totalVideos = results.reduce((a, c) => a + c.videosCollected, 0);
  console.log(`Total long-form videos collected: ${totalVideos}`);
}

main().catch(console.error);

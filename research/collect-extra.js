// Collect missing/replacement channels
// Usage: YOUTUBE_API_KEY=... node collect-extra.js
const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Set YOUTUBE_API_KEY env var before running this script.');
  process.exit(1);
}
const fs = require('fs');
const path = require('path');

const CHANNELS = [
  { handle: 'danielpinkauthor', niche: 'self-development' },
  { handle: 'markmansonnet', niche: 'self-development' },
  { handle: 'RyanHolidayofficial', niche: 'self-development' },
  { handle: 'hubaborern', niche: 'education' },
  { handle: 'hubermanlab', niche: 'self-development' },
  { handle: 'SchoolOfLifeChannel', niche: 'self-development' },
  { handle: 'paddygalloway', niche: 'creator' },
  { handle: 'firatBorealYT', niche: 'tech' },
  // Additional good channels
  { handle: 'NathanielDrew', niche: 'productivity' },
  { handle: 'AbdaalMedicine', niche: 'productivity' }, // just kidding, skip Ali
  { handle: 'AlisonKInstructor', niche: 'self-development' },
  { handle: 'SarahsDayOfficial', niche: 'health' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

async function resolveHandle(handle) {
  // Try forHandle first
  let url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics,contentDetails&forHandle=${handle}&key=${API_KEY}`;
  let data = await apiFetch(url);
  if (data.items?.length) return data.items[0];
  // Try forUsername
  url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics,contentDetails&forUsername=${handle}&key=${API_KEY}`;
  data = await apiFetch(url);
  if (data.items?.length) return data.items[0];
  return null;
}

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

async function main() {
  const existing = JSON.parse(fs.readFileSync(path.join(__dirname, 'channel-data.json'), 'utf8'));
  const existingIds = new Set(existing.map(c => c.id));
  let added = 0;

  for (const ch of CHANNELS) {
    try {
      console.log(`Trying ${ch.handle}...`);
      const channel = await resolveHandle(ch.handle);
      if (!channel) { console.log('  Not found'); continue; }
      if (existingIds.has(channel.id)) { console.log(`  Already have ${channel.snippet.title}`); continue; }

      const uploadsId = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsId) { console.log('  No uploads'); continue; }

      const items = await getVideos(uploadsId, 200);
      const ids = items.map(v => v.contentDetails.videoId);
      const details = await getVideoDetails(ids);
      const detailsMap = {};
      for (const d of details) detailsMap[d.id] = d;

      const videos = items.map(item => {
        const detail = detailsMap[item.contentDetails.videoId];
        if (!detail) return null;
        const durationSec = parseDuration(detail.contentDetails?.duration || 'PT0S');
        return {
          id: item.contentDetails.videoId,
          title: item.snippet.title,
          publishedAt: item.snippet.publishedAt,
          durationSec,
          views: parseInt(detail.statistics?.viewCount || 0),
          likes: parseInt(detail.statistics?.likeCount || 0),
          comments: parseInt(detail.statistics?.commentCount || 0),
        };
      }).filter(Boolean);

      const longForm = videos.filter(v => v.durationSec >= 90);
      const shorts = videos.filter(v => v.durationSec < 90);

      existing.push({
        id: channel.id,
        handle: '@' + ch.handle,
        niche: ch.niche,
        name: channel.snippet.title,
        createdAt: channel.snippet.publishedAt,
        subscribers: parseInt(channel.statistics?.subscriberCount || 0),
        totalViews: parseInt(channel.statistics?.viewCount || 0),
        totalVideos: parseInt(channel.statistics?.videoCount || 0),
        videosCollected: longForm.length,
        shortsCollected: shorts.length,
        videos: longForm,
      });
      console.log(`  Added ${channel.snippet.title}: ${longForm.length} long-form`);
      added++;
      await sleep(200);
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'channel-data.json'), JSON.stringify(existing, null, 2));
  console.log(`\nAdded ${added} channels. Total: ${existing.length}`);
}

main().catch(console.error);

#!/usr/bin/env node

/**
 * Scans articles/*.html, extracts metadata, and rebuilds the articles grid
 * in articles.html. Run after adding/editing any article.
 *
 * Usage: node build-articles.js
 */

const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.join(__dirname, 'articles');
const INDEX_FILE = path.join(__dirname, 'articles.html');

// Interactive tools that don't follow the standard article template
const MANUAL_ENTRIES = [
  {
    slug: 'title-scorer',
    title: 'YouTube Title Scorer',
    badge: 'Interactive Tool',
    badgeClass: 'badge-guide',
    description: 'Paste your video title and get it scored against 12 proven patterns from our 3,500-video study. Instant grade, pattern detection, and rewrite suggestions.',
    published: '2026-02-20',
  },
  {
    slug: 'video-length-calculator',
    title: 'Video Length Calculator',
    badge: 'Interactive Tool',
    badgeClass: 'badge-guide',
    description: 'Find the optimal video length for your niche, backed by data from 3,500+ videos across 34 channels. Pick your niche, get your number.',
    published: '2026-02-20',
  },
];

// Extract metadata from an article HTML file
function extractMeta(filepath) {
  const html = fs.readFileSync(filepath, 'utf-8');
  const slug = path.basename(filepath, '.html');

  // Skip non-article files and manually handled entries
  if (slug === 'index') return null;
  if (MANUAL_ENTRIES.some(m => m.slug === slug)) return null;

  const title = html.match(/<h1[^>]*class="article-title"[^>]*>(.*?)<\/h1>/s)?.[1]?.trim();
  if (!title) return null; // not an article

  const badge = html.match(/class="article-badge[^"]*">([^<]+)</)?.[1]?.trim() || 'Guide';
  const description = html.match(/<meta\s+name="description"\s+content="([^"]+)"/)?.[1]?.trim() || '';
  const published = html.match(/<time\s+datetime="([^"]+)"/)?.[1] || '2026-01-01';

  // Determine badge CSS class
  const badgeClass = ['Data Piece', 'Niche Playbook'].includes(badge) ? 'badge-data' : 'badge-guide';

  return { slug, title, badge, badgeClass, description, published };
}

// Category sort order
const CATEGORY_ORDER = ['Interactive Tool', 'Data Piece', 'Niche Playbook', 'Tool Guide', 'Guide'];

function main() {
  // Scan all HTML files in articles/
  const files = fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(ARTICLES_DIR, f));

  const articles = [...MANUAL_ENTRIES, ...files.map(extractMeta).filter(Boolean)]
    .sort((a, b) => {
      // Sort by category order first, then by published date (newest first)
      const catA = CATEGORY_ORDER.indexOf(a.badge);
      const catB = CATEGORY_ORDER.indexOf(b.badge);
      if (catA !== catB) return (catA === -1 ? 99 : catA) - (catB === -1 ? 99 : catB);
      return b.published.localeCompare(a.published);
    });

  console.log(`Found ${articles.length} articles`);

  // Build the grid HTML
  const cardsHtml = articles.map(a => {
    const excerpt = a.description.length > 180
      ? a.description.slice(0, 177) + '...'
      : a.description;
    return `
      <a href="/articles/${a.slug}" class="article-card" data-category="${a.badge}">
        <div class="article-card-header">
          <span class="article-badge ${a.badgeClass}">${a.badge}</span>
        </div>
        <h3 class="article-card-title">${a.title}</h3>
        <p class="article-card-excerpt">${excerpt}</p>
        <span class="article-card-arrow">&rarr;</span>
      </a>`;
  }).join('\n');

  // Collect unique categories for filter buttons
  const categories = [...new Set(articles.map(a => a.badge))];
  const filterLabels = {
    'Data Piece': 'Data',
    'Niche Playbook': 'Playbooks',
    'Tool Guide': 'Tool Guides',
    'Guide': 'Guides',
    'Interactive Tool': 'Interactive',
  };
  const filtersHtml = categories.map(cat => {
    const label = filterLabels[cat] || cat;
    return `          <button class="filter-btn" data-filter="${cat}">${label}</button>`;
  }).join('\n');

  // Read the index file and replace the grid
  let index = fs.readFileSync(INDEX_FILE, 'utf-8');

  // Replace filter buttons (between <div class="filters"> and </div>)
  index = index.replace(
    /(<div class="filters">)[\s\S]*?(<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/,
    `$1\n          <button class="filter-btn active" data-filter="all">All</button>\n${filtersHtml}\n        $2`
  );

  // Replace the articles grid content
  index = index.replace(
    /(<div class="articles-grid">)[\s\S]*?(<\/div>\s*<\/div>\s*\n\s*<footer>)/,
    `$1\n${cardsHtml}\n\n    </div>\n  </div>\n\n  <footer>`
  );

  fs.writeFileSync(INDEX_FILE, index, 'utf-8');
  console.log(`Updated ${INDEX_FILE} with ${articles.length} articles and ${categories.length} filters`);

  // Rebuild sitemap.xml
  const SITEMAP_FILE = path.join(__dirname, 'sitemap.xml');
  const today = new Date().toISOString().split('T')[0];
  const sitemapUrls = [
    `  <url><loc>https://youtubeproducer.app/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>https://youtubeproducer.app/articles</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`,
    ...articles.map(a =>
      `  <url><loc>https://youtubeproducer.app/articles/${a.slug}</loc><lastmod>${a.published}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`
    ),
  ];
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.join('\n')}
</urlset>
`;
  fs.writeFileSync(SITEMAP_FILE, sitemapXml, 'utf-8');
  console.log(`Updated ${SITEMAP_FILE} with ${sitemapUrls.length} URLs`);
}

main();

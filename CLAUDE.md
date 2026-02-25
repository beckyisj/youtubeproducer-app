# YouTube Producer — Landing Page

Static HTML/CSS/JS landing page for youtubeproducer.app.

## Frontend Design System

Follow the YouTube Producer design system: `~/.claude/projects/-Users-beckyisjwara/memory/youtube-producer-design.md`

**Brand**: Studio Clean — light mode, teal accent, Manrope, gradients for premium feel.
**Key rule**: Every YouTube Producer tool should feel like it belongs to the same family.

## Adding New Tools

**New tools default to "Coming Soon"** until explicitly told to set them live. A coming soon card:
- Uses `<div class="tool-card coming-soon">` (not `<a>`)
- Has `<span class="tool-badge badge-soon">Coming Soon</span>` in the header
- Shows the tool's favicon SVG enlarged in a `<div class="tool-icon-placeholder">` instead of a video
- No arrow, no link, no hover effects

To set a tool **live**: change `<div>` to `<a href="...">`, remove `coming-soon` class, swap the icon placeholder for a `<video>` demo, add the arrow span, and switch badge to `badge-live` (or remove it).

## Dev

- Static site, no build step. Just open `index.html`.
- Deployed on Vercel via `beckyisj/youtubeproducer-app` repo.

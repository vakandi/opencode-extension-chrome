# `.assets/` — README assets

Every asset referenced by the README lives here, and is committed to git.

## Files

- `banner.png` — the README header. **2400 × 800** (rendered at `device_scale_factor=2`
  from a 1200 × 400 layout), 8-bit palette PNG, ~210 KB after compression.

## How the banner was generated

Rendered from HTML/CSS with Playwright, then compressed with `pngquant`. The palette is
taken from the extension's own stylesheet (`assets/sidebar-BsIV8lXM.css`) rather than a
stock theme, so the README and the product agree:

- background `#211E1E` (`--bg-primary`)
- accent 1 `#6F42C1` (`--purple`)
- accent 2 `#5B9BF5` (`--blue`)
- accent 3 `#B7B1B1` (`--accent`)

## Regenerating

```bash
python3 - <<'PY'
import sys
sys.path.insert(0, "/Users/vakandi/.opencode/skills/readme-enhancer/scripts")
import generate_banner as gb

colors = {"bg_color": "#211E1E", "accent1": "#6F42C1", "accent2": "#5B9BF5", "accent3": "#B7B1B1"}
tags = ["Manifest V3", "OpenCode v2 API", "Side panel", "SSE streaming", "Model / Agent picker"]
tags_html = "\n      ".join(
    f'<span class="tag{" accent" if i == 0 else ""}">{t}</span>' for i, t in enumerate(tags[:5])
)
html = gb.HTML_TEMPLATE.format(
    title="OpenCode Side Panel",
    subtitle="Drive a local OpenCode v2 server from your browser side panel \u2014 prompt, stream, and pick the model, agent and session.",
    badge_text="BROWSER EXTENSION \u00b7 LOCAL BUILD",
    tags=tags_html,
    **colors,
)
gb.render_to_png(html, ".assets/banner.png")
PY

pngquant --quality=82-98 --strip --force --output .assets/banner.png .assets/banner.png
```

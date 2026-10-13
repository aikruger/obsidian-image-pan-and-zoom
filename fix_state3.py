import re

with open('main.ts', 'r') as f:
    content = f.read()

# I need to ensure that the Mermaid SVG sizing is limited to active SVGs, not globally.
with open('styles.css', 'r') as f:
    css_content = f.read()

css_content = css_content.replace(
    ".markdown-preview-view .mermaid svg {",
    ".markdown-preview-view .mermaid svg.image-zoom-drag-active {"
)
with open('styles.css', 'w') as f:
    f.write(css_content)

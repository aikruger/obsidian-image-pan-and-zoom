import re

with open('main.ts', 'r') as f:
    lines = f.readlines()

new_lines = []
skip = False
for i, line in enumerate(lines):
    if line.strip() == '} | null;':
        skip = True
        continue
    if skip and line.strip() == 'svgViewBox: { x: number; y: number; width: number; height: number; } | null;':
        continue
    if skip and line.strip() == 'resizeObserver: ResizeObserver | null;':
        continue
    if skip and line.strip() == '}':
        skip = False
        continue
    new_lines.append(line)

with open('main.ts', 'w') as f:
    f.writelines(new_lines)

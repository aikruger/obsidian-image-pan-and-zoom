import re

with open('main.ts', 'r') as f:
    content = f.read()

content = content.replace("    };\n\nconst DEFAULT_SETTINGS", "    };\n}\n\nconst DEFAULT_SETTINGS")

with open('main.ts', 'w') as f:
    f.write(content)

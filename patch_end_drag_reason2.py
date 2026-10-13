import re

with open('main.ts', 'r') as f:
    content = f.read()

# Make sure unload clears drag target
content = content.replace("""    onunload() {
        // Clean up all resize observers""", """    onunload() {
        this.endCurrentDrag("plugin-unload");

        // Clean up all resize observers""")

with open('main.ts', 'w') as f:
    f.write(content)

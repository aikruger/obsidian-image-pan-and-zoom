import re

with open('main.ts', 'r') as f:
    content = f.read()

# Make sure changing settings clears drag target
content = content.replace("""                    this.plugin.settings.disableNativeImageInteractions = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide context menu setting""", """                    this.plugin.settings.disableNativeImageInteractions = value;
                    await this.plugin.saveSettings();
                    this.plugin.endCurrentDrag("settings-changed");
                    this.display(); // Refresh to show/hide context menu setting""")

with open('main.ts', 'w') as f:
    f.write(content)

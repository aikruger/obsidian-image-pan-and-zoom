import re

with open('main.ts', 'r') as f:
    content = f.read()

ui_addition = """
        // Interaction Settings
        new Setting(containerEl)
            .setName('Disable native image interactions')
            .setDesc('Prevent normal image opening and dragging in supported note content. Alt-click to activate pan and zoom.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.disableNativeImageInteractions)
                .onChange(async (value) => {
                    this.plugin.settings.disableNativeImageInteractions = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide context menu setting
                }));

        if (this.plugin.settings.disableNativeImageInteractions) {
            new Setting(containerEl)
                .setName('Disable native image context menu')
                .setDesc('Also suppress right-click menus on supported images. The plugin’s Edit button remains available.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.disableNativeImageContextMenu)
                    .onChange(async (value) => {
                        this.plugin.settings.disableNativeImageContextMenu = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('Debug image interactions')
            .setDesc('Log interaction ownership and cleanup information to the developer console.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugImageInteractions)
                .onChange(async (value) => {
                    this.plugin.settings.debugImageInteractions = value;
                    await this.plugin.saveSettings();
                }));
"""

# Insert before 'Use system default editor'
content = content.replace("new Setting(containerEl)\n            .setName('Use system default editor')", ui_addition + "\n        new Setting(containerEl)\n            .setName('Use system default editor')")

with open('main.ts', 'w') as f:
    f.write(content)

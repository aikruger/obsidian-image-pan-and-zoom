import re

with open('main.ts', 'r') as f:
    content = f.read()

settings_interface = """interface ImageZoomSettings {
    externalEditorPath: string;
    useSystemDefault: boolean;
    disableNativeImageInteractions: boolean;
    disableNativeImageContextMenu: boolean;
    debugImageInteractions: boolean;
}"""

content = re.sub(r'interface ImageZoomSettings \{[\s\S]*?\}', settings_interface, content)

default_settings = """const DEFAULT_SETTINGS: ImageZoomSettings = {
    externalEditorPath: '',
    useSystemDefault: true,
    disableNativeImageInteractions: false,
    disableNativeImageContextMenu: false,
    debugImageInteractions: false,
}"""

content = re.sub(r'const DEFAULT_SETTINGS: ImageZoomSettings = \{[\s\S]*?\}', default_settings, content)

with open('main.ts', 'w') as f:
    f.write(content)

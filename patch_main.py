import re

with open('main.ts', 'r') as f:
    content = f.read()

# Add import
import_stmt = "import { ImageInteractionController } from './src/image-interaction-controller';\n"
content = content.replace("interface ImageZoomSettings", import_stmt + "\ninterface ImageZoomSettings")

# Add property
prop_stmt = "    private interactionController: ImageInteractionController;\n"
content = content.replace("    private resizeObserver: ResizeObserver | null = null;", "    private resizeObserver: ResizeObserver | null = null;\n" + prop_stmt)

# Update onload
onload_setup = """
        this.interactionController = new ImageInteractionController(this, this.app);

        // Register for main document
        this.interactionController.registerDocument(document);

        // Register for popout windows if supported
        if ((this.app.workspace as any).on) {
            this.registerEvent(
                this.app.workspace.on('window-open', (win, window) => {
                    this.interactionController.registerDocument(window.document);
                })
            );
            this.registerEvent(
                this.app.workspace.on('window-close', (win, window) => {
                    this.interactionController.unregisterDocument(window.document);
                })
            );
        }
"""
content = re.sub(r"this\.registerDomEvent\(document, 'click', this\.handleImageClick\.bind\(this\)\);\s*this\.registerDomEvent\(document, 'wheel', this\.handleWheel\.bind\(this\), \{ passive: false \}\);\s*this\.registerDomEvent\(document, 'mousedown', this\.handleMouseDown\.bind\(this\)\);", onload_setup, content)

# keep mousemove and mouseup on the document to allow panning to continue outside the image
# Actually mousemove/mouseup need to be handled. We will leave mousemove and mouseup on document level as they manage drag globally, but we will make them delegate if we want, or keep them as is.
# The spec says "Retain global move/up handling for an ongoing pan, or integrate those into the controller."
# Let's keep them in main.ts since they rely on currentDragTarget.

# Update onunload
onunload_cleanup = """
        if (this.interactionController) {
            this.interactionController.dispose();
        }
"""
content = content.replace("        this.globalResizeObservers.clear();", "        this.globalResizeObservers.clear();\n" + onunload_cleanup)

with open('main.ts', 'w') as f:
    f.write(content)

import re

with open('main.ts', 'r') as f:
    content = f.read()

# Make sure we clean up detached active images.
# Let's add a scoped observer or reconcile step on setting change / reset
# actually, since we have the interaction controller handling everything,
# and it uses the map in main.ts, we should make sure that if a document closes,
# its detached images are reset.

# Let's add a method to clean up detached images inside main.ts and call it from window-close and other lifecycle events.
cleanup_method = """
    cleanupDetachedImages() {
        this.zoomedImages.forEach((imageState, target) => {
            if (!document.contains(target)) {
                let isInAnyDoc = false;
                // Check if it's in any popout window
                if (this.interactionController) {
                    const docs = this.interactionController.getRegisteredDocuments();
                    for (const doc of docs) {
                        if (doc.contains(target)) {
                            isInAnyDoc = true;
                            break;
                        }
                    }
                }

                if (!isInAnyDoc) {
                    this.resetImage(target);
                }
            }
        });
    }
"""

content = content.replace("    async loadSettings() {", cleanup_method + "\n    async loadSettings() {")

# Call it when window closes
content = content.replace("""                this.app.workspace.on('window-close', (win, window) => {
                    this.interactionController.unregisterDocument(window.document);
                })""", """                this.app.workspace.on('window-close', (win, window) => {
                    this.interactionController.unregisterDocument(window.document);
                    this.cleanupDetachedImages();
                })""")

with open('main.ts', 'w') as f:
    f.write(content)

with open('src/image-interaction-controller.ts', 'r') as f:
    controller_content = f.read()

# Add getRegisteredDocuments
get_docs = """    public getRegisteredDocuments(): Document[] {
        return Array.from(this.registeredDocuments.keys());
    }"""
controller_content = controller_content.replace("    public dispose() {", get_docs + "\n\n    public dispose() {")

with open('src/image-interaction-controller.ts', 'w') as f:
    f.write(controller_content)

import re

with open('main.ts', 'r') as f:
    content = f.read()

# We need to make sure endCurrentDrag is called when window blur happens
content = content.replace("""        this.interactionController = new ImageInteractionController(this, this.app);

        // Register for main document
        this.interactionController.registerDocument(document);""", """        this.interactionController = new ImageInteractionController(this, this.app);

        // Register for main document
        this.interactionController.registerDocument(document);

        // Handle blur to end drags
        this.registerDomEvent(window, 'blur', () => this.endCurrentDrag('window-blur'));""")

with open('main.ts', 'w') as f:
    f.write(content)

import re

with open('src/image-interaction-controller.ts', 'r') as f:
    content = f.read()

# Fix the class ending prematurely
content = content.replace("""    private logDebug(message: string, data?: any) {
        if (this.isDebugEnabled()) {
            console.log(`[Image Pan and Zoom] ${message}`, data || {});
        }
    }
}

    private consumeEvent(event: Event): void {""", """    private logDebug(message: string, data?: any) {
        if (this.isDebugEnabled()) {
            console.log(`[Image Pan and Zoom] ${message}`, data || {});
        }
    }

    private consumeEvent(event: Event): void {""")

with open('src/image-interaction-controller.ts', 'w') as f:
    f.write(content)

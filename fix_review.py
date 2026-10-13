import re

with open('src/image-interaction-controller.ts', 'r') as f:
    content = f.read()

# Fix pointerdown blocking
# pointerdown needs to only call stopImmediatePropagation, not preventDefault, to allow mousedown and click to fire.
# So let's implement a custom consumption specifically for pointerdown if we don't want to preventDefault.
pointerdown_consume = """                if (isActive) {
                    if (event.type === 'mousedown') {
                        // Start panning
                        this.consumeEvent(event);
                        this.logDebug("Image interaction consumed", { eventType: event.type, reason: "pan-start" });
                        this.plugin.startPan(mouseEvent, eligibleImage);
                    } else if (isTakeover && event.type === 'pointerdown') {
                        event.stopImmediatePropagation();
                    }
                } else if (isTakeover) {
                    // Suppress competing initiation for inactive image
                    event.stopImmediatePropagation();
                    this.logDebug("Image interaction consumed", { eventType: event.type, reason: "initiation-suppressed" });
                }"""
content = re.sub(r'                if \(isActive\) \{[\s\S]*?reason: "initiation-suppressed" \}\);\n                \}', pointerdown_consume, content)


# Fix Alt-Click unconditionally consuming
# "The new controller unconditionally calls this.consumeEvent(event) for Alt-Click even when isTakeover is false, which alters normal event propagation and may conflict with other plugins unexpectedly."
alt_click_logic = """        if (event.type === 'click' || event.type === 'auxclick') {
            if (mouseEvent.altKey && mouseEvent.button === 0) {
                // Alt-click activation
                if (isTakeover) {
                    this.consumeEvent(event);
                    this.logDebug("Image interaction consumed", { eventType: event.type, reason: "alt-click-activation", active: isActive });
                }
                if (!isActive) {
                    this.plugin.activateImage(eligibleImage);
                }
            } else if (isTakeover) {
                // Suppress normal opening
                this.consumeEvent(event);
                this.logDebug("Image interaction consumed", { eventType: event.type, reason: "click-suppressed" });
            }
            return;
        }"""
content = re.sub(r'        if \(event\.type === \'click\' \|\| event\.type === \'auxclick\'\) \{[\s\S]*?return;\n        \}', alt_click_logic, content)

# Fix embed wrapper resolution
# "Using closest() with descendant selectors incorrectly fails to resolve embed wrappers."
# If target is `.internal-embed`, we need to querySelector('img') down into it.
wrapper_logic = """    // Find the nearest wrapper or direct element.
    let imageElement: Element | null = resolvedImage;
    if (!imageElement) {
        if (target.matches('.internal-embed') || target.closest('.internal-embed')) {
            const embed = target.closest('.internal-embed');
            if (embed) {
                imageElement = embed.querySelector('img');
            }
        }
    }
    if (!imageElement) {
        imageElement = target.closest('img, .mermaid svg');
    }
"""
content = re.sub(r"    // Find the nearest wrapper or direct element\. [\s\S]*?const imageElement = resolvedImage \|\| target\.closest\('img, \.internal-embed img, \.mermaid svg'\);", wrapper_logic, content)

with open('src/image-interaction-controller.ts', 'w') as f:
    f.write(content)

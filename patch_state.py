import re

with open('main.ts', 'r') as f:
    content = f.read()

# 1. Update ImageState interface
state_interface = """interface ImageState {
    isDragging: boolean;
    initialX: number;
    initialY: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    resetButton: HTMLButtonElement | null;
    controlsContainer: HTMLDivElement | null;
    isSvg: boolean;
    originalViewBox: { x: number; y: number; width: number; height: number; } | null;
    svgViewBox: { x: number; y: number; width: number; height: number; } | null;
    resizeObserver: ResizeObserver | null;
    // Original styles and attributes for restoration
    originalStyles: {
        transform: string | null;
        transformOrigin: string | null;
        transition: string | null;
        cursor: string | null;
        width: string | null;
        height: string | null;
        position: string | null; // for parent
    };
    originalAttributes: {
        viewBox: string | null;
        width: string | null;
        height: string | null;
        preserveAspectRatio: string | null;
    };
}"""

content = re.sub(r'interface ImageState \{[\s\S]*?\}', state_interface, content)

# 2. Update object creation in handleImageClick
new_state_init = """const imageState: ImageState = {
                isDragging: false,
                initialX: 0,
                initialY: 0,
                offsetX: 0,
                offsetY: 0,
                scale: 1,
                resetButton: null,
                controlsContainer: null,
                isSvg: target instanceof SVGSVGElement,
                originalViewBox: null,
                svgViewBox: null,
                resizeObserver: null,
                originalStyles: {
                    transform: target.style.transform || null,
                    transformOrigin: target.style.transformOrigin || null,
                    transition: target.style.transition || null,
                    cursor: target.style.cursor || null,
                    width: target.style.width || null,
                    height: target.style.height || null,
                    position: target.parentElement ? target.parentElement.style.position || null : null
                },
                originalAttributes: {
                    viewBox: target.getAttribute("viewBox"),
                    width: target.getAttribute("width"),
                    height: target.getAttribute("height"),
                    preserveAspectRatio: target.getAttribute("preserveAspectRatio")
                }
            };"""

content = re.sub(r'const imageState: ImageState = \{[\s\S]*?resizeObserver: null\n\s*\};', new_state_init, content)

# 3. Add endCurrentDrag function
end_drag_func = """
    endCurrentDrag(reason: string): void {
        if (!this.currentDragTarget) return;

        const imageState = this.zoomedImages.get(this.currentDragTarget);
        if (imageState) {
            imageState.isDragging = false;
        }

        this.currentDragTarget.classList.remove("is-dragging");
        this.currentDragTarget = null;

        if (this.settings.debugImageInteractions) {
            console.log("[Image Pan and Zoom] Drag ended", { reason });
        }
    }
"""

content = content.replace("handleMouseUp(e: MouseEvent) {", end_drag_func + "\n    handleMouseUp(e: MouseEvent) {")

# 4. Use endCurrentDrag in handleMouseUp and handleMouseMove
content = content.replace("""    handleMouseUp(e: MouseEvent) {
        if (this.currentDragTarget) {
            const imageState = this.zoomedImages.get(this.currentDragTarget);
            if (imageState && imageState.isDragging) {
                imageState.isDragging = false;
                this.currentDragTarget.classList.remove("is-dragging");
            }
            this.currentDragTarget = null;
        }
    }""", """    handleMouseUp(e: MouseEvent) {
        this.endCurrentDrag("mouse-up");
    }""")

content = content.replace("""        if (e.clientX < rect.left - buffer || e.clientX > rect.right + buffer ||
            e.clientY < rect.top - buffer || e.clientY > rect.bottom + buffer) {
            imageState.isDragging = false;
            this.currentDragTarget.classList.remove("is-dragging");
            this.currentDragTarget = null;
            return;
        }""", """        if (e.clientX < rect.left - buffer || e.clientX > rect.right + buffer ||
            e.clientY < rect.top - buffer || e.clientY > rect.bottom + buffer) {
            this.endCurrentDrag("out-of-bounds");
            return;
        }""")

# 5. Enhance resetImage
reset_image_logic = """    resetImage(target: HTMLImageElement | SVGSVGElement) {
        const imageState = this.zoomedImages.get(target);
        if (!imageState) return;

        if (this.currentDragTarget === target) {
            this.endCurrentDrag("image-reset");
        }

        if (imageState.resizeObserver) {
            imageState.resizeObserver.disconnect();
            this.globalResizeObservers.delete(imageState.resizeObserver);
        }

        // Restore attributes
        if (imageState.originalAttributes.viewBox !== null) {
            target.setAttribute("viewBox", imageState.originalAttributes.viewBox);
        } else {
            target.removeAttribute("viewBox");
        }

        if (imageState.originalAttributes.width !== null) {
            target.setAttribute("width", imageState.originalAttributes.width);
        } else {
            target.removeAttribute("width");
        }

        if (imageState.originalAttributes.height !== null) {
            target.setAttribute("height", imageState.originalAttributes.height);
        } else {
            target.removeAttribute("height");
        }

        if (imageState.originalAttributes.preserveAspectRatio !== null) {
            target.setAttribute("preserveAspectRatio", imageState.originalAttributes.preserveAspectRatio);
        } else {
            target.removeAttribute("preserveAspectRatio");
        }

        // Restore styles
        if (imageState.originalStyles.transform !== null) {
            target.style.transform = imageState.originalStyles.transform;
        } else {
            target.style.transform = "";
        }

        if (imageState.originalStyles.transformOrigin !== null) {
            target.style.transformOrigin = imageState.originalStyles.transformOrigin;
        } else {
            target.style.transformOrigin = "";
        }

        if (imageState.originalStyles.transition !== null) {
            target.style.transition = imageState.originalStyles.transition;
        } else {
            target.style.transition = "";
        }

        if (imageState.originalStyles.cursor !== null) {
            target.style.cursor = imageState.originalStyles.cursor;
        } else {
            target.style.cursor = "";
        }

        if (imageState.originalStyles.width !== null) {
            target.style.width = imageState.originalStyles.width;
        } else {
            target.style.width = "";
        }

        if (imageState.originalStyles.height !== null) {
            target.style.height = imageState.originalStyles.height;
        } else {
            target.style.height = "";
        }

        // Restore parent position
        if (target.parentElement) {
            if (imageState.originalStyles.position !== null) {
                target.parentElement.style.position = imageState.originalStyles.position;
            } else {
                target.parentElement.style.position = "";
            }
        }

        target.classList.remove("image-zoom-drag-active");

        this.hideResetButton(target);
        this.zoomedImages.delete(target);
    }"""

content = re.sub(r'    resetImage\(target: HTMLImageElement \| SVGSVGElement\) \{[\s\S]*?this\.zoomedImages\.delete\(target\);\n    \}', reset_image_logic, content)


# 6. Update showResetButton / hideResetButton to use controlsContainer
content = content.replace("""            parent.appendChild(controlsContainer);

            // Store button reference in image state
            const imageState = this.zoomedImages.get(target);
            if (imageState) imageState.resetButton = resetButton;""", """            parent.appendChild(controlsContainer);

            // Store button and container references in image state
            const imageState = this.zoomedImages.get(target);
            if (imageState) {
                imageState.resetButton = resetButton;
                imageState.controlsContainer = controlsContainer;
            }""")

hide_reset_logic = """    hideResetButton(target: HTMLImageElement | SVGSVGElement) {
        if (!target) return;

        const imageState = this.zoomedImages.get(target);
        if (imageState && imageState.controlsContainer) {
            imageState.controlsContainer.remove();
            imageState.controlsContainer = null;
            imageState.resetButton = null;
        } else {
            // Fallback for cleanup
            const parent = target.parentElement;
            if (parent) {
                const existingControls = parent.querySelector(".image-zoom-controls");
                if (existingControls) existingControls.remove();
            }
        }
    }"""

content = re.sub(r'    hideResetButton\(target: HTMLImageElement \| SVGSVGElement\) \{[\s\S]*?imageState\.resetButton = null;\n    \}', hide_reset_logic, content)

with open('main.ts', 'w') as f:
    f.write(content)

import re

with open('main.ts', 'r') as f:
    content = f.read()

# Add new methods needed by interaction controller
api_methods = """
    isImageActive(target: HTMLImageElement | SVGSVGElement): boolean {
        return this.zoomedImages.has(target);
    }

    activateImage(target: HTMLImageElement | SVGSVGElement) {
        // Create new zoom state for this image
        const imageState: ImageState = {
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
        };

        // Handle SVG-specific setup
        if (imageState.isSvg) {
            const svg = target as SVGSVGElement;
            const viewBox = svg.getAttribute("viewBox");
            if (viewBox) {
                const parsedViewBox = this.parseViewBox(viewBox);
                if (parsedViewBox) {
                    imageState.originalViewBox = parsedViewBox;
                    imageState.svgViewBox = { ...parsedViewBox };
                }
            }
            const resizeObserver = this.setupDynamicResize(svg);
            if (resizeObserver) {
                imageState.resizeObserver = resizeObserver;
                this.globalResizeObservers.add(imageState.resizeObserver);
            }
        }

        // Store state and activate zoom
        this.zoomedImages.set(target, imageState);
        target.classList.add("image-zoom-drag-active");
        target.style.cursor = "grab";
        this.showResetButton(target);
    }

    handleWheelInternal(e: WheelEvent, target: HTMLImageElement | SVGSVGElement) {
        const imageState = this.zoomedImages.get(target);
        if (!imageState || !this.isMouseWithinFrame(e, target)) return;

        const zoomFactor = 1.1;
        const previousScale = imageState.scale;

        if (e.deltaY < 0) {
            imageState.scale *= zoomFactor;
        } else {
            imageState.scale /= zoomFactor;
        }

        imageState.scale = Math.max(0.1, imageState.scale);

        const rect = target.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const scaleRatio = imageState.scale / previousScale;

        imageState.offsetX = mouseX - (mouseX - imageState.offsetX) * scaleRatio;
        imageState.offsetY = mouseY - (mouseY - imageState.offsetY) * scaleRatio;

        if (imageState.isSvg && imageState.svgViewBox && imageState.originalViewBox) {
            const viewBoxWidth = imageState.originalViewBox.width / imageState.scale;
            const viewBoxHeight = imageState.originalViewBox.height / imageState.scale;

            imageState.svgViewBox.x = imageState.originalViewBox.x - imageState.offsetX * (viewBoxWidth / imageState.originalViewBox.width);
            imageState.svgViewBox.y = imageState.originalViewBox.y - imageState.offsetY * (viewBoxHeight / imageState.originalViewBox.height);
            imageState.svgViewBox.width = viewBoxWidth;
            imageState.svgViewBox.height = viewBoxHeight;
        }

        this.updateTransform(target, imageState);
        if (imageState.isSvg) this.fitSvgToContainer(target as SVGSVGElement);
    }

    startPan(e: MouseEvent, target: HTMLImageElement | SVGSVGElement) {
        const imageState = this.zoomedImages.get(target);
        if (!imageState || !this.isMouseWithinFrame(e, target)) return;

        this.currentDragTarget = target;
        imageState.isDragging = true;
        imageState.initialX = e.clientX - imageState.offsetX;
        imageState.initialY = e.clientY - imageState.offsetY;
        target.classList.add("is-dragging");
    }
"""

content = content.replace("    handleImageClick(e: MouseEvent) {", api_methods + "\n    handleImageClick(e: MouseEvent) {")

# Since we moved logic to the controller, we can remove the old handlers
content = re.sub(r'    handleImageClick\(e: MouseEvent\) \{[\s\S]*?this\.showResetButton\(target\);\n        \}\n    \}', '', content)
content = re.sub(r'    handleWheel\(e: WheelEvent\) \{[\s\S]*?if \(imageState\.isSvg\) this\.fitSvgToContainer\(target as SVGSVGElement\);\n    \}', '', content)
content = re.sub(r'    handleMouseDown\(e: MouseEvent\) \{[\s\S]*?e\.preventDefault\(\);\n    \}', '', content)

with open('main.ts', 'w') as f:
    f.write(content)

import { Plugin } from 'obsidian';

export default class ImageZoomDragPlugin extends Plugin {
    private activeImage: HTMLImageElement | SVGSVGElement | null = null;
    private isDragging = false;
    private initialX = 0;
    private initialY = 0;
    private offsetX = 0;
    private offsetY = 0;
    private scale = 1;
    private resetButton: HTMLButtonElement | null = null;
    private isMouseInFrame = false;
    private panSpeed = 1.0; // Default pan speed multiplier
    private panSpeedSlider: HTMLInputElement | null = null;
    private isSvg = false;
    private originalViewBox: { x: number; y: number; width: number; height: number; } | null = null;
    private svgViewBox: { x: number; y: number; width: number; height: number; } | null = null;

    async onload() {
        this.registerDomEvent(document, 'click', this.handleImageClick.bind(this));
        this.registerDomEvent(document, 'wheel', this.handleWheel.bind(this), { passive: false });
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mousemove', this.handleMouseMove.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));

        // Add Escape key handler for reset
        this.registerDomEvent(document, 'keydown', (e) => {
            if (e.key === 'Escape' && this.activeImage) {
                this.resetImage(this.activeImage);
                this.activeImage = null;
            }
        });

        this.registerDomEvent(document, 'mousemove', (e) => {
            if (this.activeImage) {
                this.isMouseInFrame = this.isMouseWithinFrame(e);
            }
        });
    }

    onunload() {
        // Event listeners are automatically removed by registerDomEvent
    }

    wrapImageWithFrame(imageElement: HTMLImageElement | SVGSVGElement) {
        let wrapper = document.createElement('div');
        wrapper.className = 'image-zoom-frame-active';
        imageElement.parentNode?.insertBefore(wrapper, imageElement);
        wrapper.appendChild(imageElement);
    }

    unwrapImageFromFrame(imageElement: HTMLImageElement | SVGSVGElement) {
        // Remove wrapper and restore image in DOM, if present
        let wrapper = imageElement.parentNode;
        if (wrapper && wrapper instanceof HTMLElement && wrapper.classList.contains('image-zoom-frame-active')) {
            wrapper.parentNode?.insertBefore(imageElement, wrapper);
            wrapper.remove();
        }
    }

    handleImageClick(e: MouseEvent) {
        const target = (e.target as HTMLElement).closest('img, svg');

        if (target && (target instanceof HTMLImageElement || target instanceof SVGSVGElement)) {
            // Check if click is within workspace
            if (!target.closest('.workspace-leaf-content')) return;

            // Reset previous image if different
            if (this.activeImage && this.activeImage !== target) {
                this.resetImage(this.activeImage);
            }

            // Activate new image
            this.activeImage = target;

            if (this.activeImage) {
                this.isSvg = this.activeImage instanceof SVGSVGElement;
                if (this.isSvg) {
                    const viewBox = this.activeImage.getAttribute('viewBox');
                    if (viewBox) {
                        this.originalViewBox = this.parseViewBox(viewBox);
                        this.svgViewBox = { ...this.originalViewBox };
                    }
                }
                this.wrapImageWithFrame(this.activeImage);
                this.activeImage.classList.add('image-zoom-drag-active');
                this.activeImage.style.cursor = 'grab';

                // Show reset button
                this.showResetButton();
            }
        }
    }

    parseViewBox(viewBoxString: string): { x: number; y: number; width: number; height: number; } | null {
        const parts = viewBoxString.split(' ').map(parseFloat);
        if (parts.length !== 4) {
            return null;
        }
        return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }

    handleWheel(e: WheelEvent) {
        if (!this.activeImage) return;

        // Only zoom if mouse is within the frame
        if (!this.isMouseWithinFrame(e)) return;

        e.preventDefault();

        const scaleBy = 1.1;
        const prevScale = this.scale;

        // Calculate new scale
        if (e.deltaY < 0) {
            this.scale *= scaleBy;
        } else {
            this.scale /= scaleBy;
        }
        this.scale = Math.max(0.1, this.scale);

        // Optional: Zoom toward cursor position
        // Get mouse position relative to image
        const rect = this.activeImage.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Adjust offsets to zoom toward cursor
        const scaleChange = this.scale / prevScale;
        this.offsetX = mouseX - (mouseX - this.offsetX) * scaleChange;
        this.offsetY = mouseY - (mouseY - this.offsetY) * scaleChange;

        if (this.isSvg && this.svgViewBox) {
            const newWidth = this.originalViewBox.width / this.scale;
            const newHeight = this.originalViewBox.height / this.scale;

            this.svgViewBox.x = this.originalViewBox.x - (this.offsetX * (newWidth / this.originalViewBox.width));
            this.svgViewBox.y = this.originalViewBox.y - (this.offsetY * (newHeight / this.originalViewBox.height));
            this.svgViewBox.width = newWidth;
            this.svgViewBox.height = newHeight;
        }

        this.updateTransform();
    }

    handleMouseDown(e: MouseEvent) {
        // Only respond to left click
        if (e.button !== 0) return;

        if (this.activeImage && this.activeImage.contains(e.target as Node)) {
            // Don't start dragging if clicking on reset button or slider
            if ((e.target as HTMLElement).closest('.image-zoom-reset-btn') ||
                (e.target as HTMLElement).closest('.image-zoom-pan-speed-control')) {
                return;
            }

            // Only allow dragging if mouse is within frame
            if (!this.isMouseWithinFrame(e)) return;

            this.isDragging = true;
            // Account for pan speed in initial position calculation
            this.initialX = e.clientX - (this.offsetX / this.panSpeed);
            this.initialY = e.clientY - (this.offsetY / this.panSpeed);
            this.activeImage.classList.add('is-dragging');
            e.preventDefault();
        }
    }

    handleMouseMove(e: MouseEvent) {
        if (!this.isDragging || !this.activeImage) return;

        if (this.isSvg && this.svgViewBox) {
            this.svgViewBox.x -= e.movementX * (this.svgViewBox.width / this.activeImage.getBoundingClientRect().width);
            this.svgViewBox.y -= e.movementY * (this.svgViewBox.height / this.activeImage.getBoundingClientRect().height);
        } else {
            this.offsetX += e.movementX;
            this.offsetY += e.movementY;
        }

        this.updateTransform();
    }

    handleMouseUp(e: MouseEvent) {
        if (this.isDragging && this.activeImage) {
            this.isDragging = false;
            this.activeImage.classList.remove('is-dragging');
        }
    }

    updateTransform() {
        if (!this.activeImage) return;

        if (this.isSvg) {
            this.updateSvgTransform();
        } else {
            this.activeImage.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
            this.activeImage.style.transformOrigin = 'top left';
            this.activeImage.style.transition = 'transform 0.1s ease-out';
        }
    }

    updateSvgTransform() {
        if (!this.activeImage || !this.svgViewBox) return;

        (this.activeImage as SVGSVGElement).setAttribute('viewBox', `${this.svgViewBox.x} ${this.svgViewBox.y} ${this.svgViewBox.width} ${this.svgViewBox.height}`);
    }

    resetImage(image: HTMLImageElement | SVGSVGElement) {
        this.unwrapImageFromFrame(image);
        if (this.isSvg && this.originalViewBox) {
            (image as SVGSVGElement).setAttribute('viewBox', `${this.originalViewBox.x} ${this.originalViewBox.y} ${this.originalViewBox.width} ${this.originalViewBox.height}`);
        }
        image.style.transform = '';
        image.style.cursor = 'default';
        image.style.transition = '';
        image.classList.remove('image-zoom-drag-active');

        // Hide reset button
        this.hideResetButton();

        // Reset state
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.isSvg = false;
        this.originalViewBox = null;
        this.svgViewBox = null;
    }

    createResetButton(): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'image-zoom-reset-btn';
        button.textContent = 'Reset';
        button.setAttribute('aria-label', 'Reset zoom and pan');

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.activeImage) {
                this.resetImage(this.activeImage);
                this.activeImage = null;
            }
        });

        return button;
    }

    showResetButton() {
        if (!this.activeImage) return;

        // Remove existing controls if present
        this.hideResetButton();

        // Create controls container
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'image-zoom-controls';

        // Create and add reset button
        this.resetButton = this.createResetButton();
        controlsContainer.appendChild(this.resetButton);

        // Create and add pan speed slider
        const panSpeedSliderContainer = this.createPanSpeedSlider();
        this.panSpeedSlider = panSpeedSliderContainer.querySelector('input[type="range"]');
        controlsContainer.appendChild(panSpeedSliderContainer);

        // Add to parent container
        const parent = this.activeImage.parentElement;
        if (parent) {
            parent.style.position = 'relative';
            parent.appendChild(controlsContainer);
        }
    }

    hideResetButton() {
        if (this.resetButton) {
            const controlsContainer = this.resetButton.closest('.image-zoom-controls');
            if (controlsContainer) {
                controlsContainer.remove();
            }
            this.resetButton = null;
            this.panSpeedSlider = null;
        }
    }

    isMouseWithinFrame(e: MouseEvent): boolean {
        if (!this.activeImage) return false;

        const rect = this.activeImage.getBoundingClientRect();
        // Add 8px padding to account for frame offset
        const framePadding = 8;

        return (
            e.clientX >= rect.left - framePadding &&
            e.clientX <= rect.right + framePadding &&
            e.clientY >= rect.top - framePadding &&
            e.clientY <= rect.bottom + framePadding
        );
    }

    createPanSpeedSlider(): HTMLDivElement {
        const container = document.createElement('div');
        container.className = 'image-zoom-pan-speed-control';

        const label = document.createElement('label');
        label.className = 'image-zoom-pan-speed-label';
        label.textContent = 'Pan Speed';
        label.setAttribute('for', 'pan-speed-slider');

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = 'pan-speed-slider';
        slider.className = 'image-zoom-pan-speed-slider';
        slider.min = '0.25';
        slider.max = '3';
        slider.step = '0.25';
        slider.value = this.panSpeed.toString();
        slider.setAttribute('aria-label', 'Adjust panning speed');

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'image-zoom-pan-speed-value';
        valueDisplay.textContent = `${this.panSpeed.toFixed(2)}x`;

        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            this.panSpeed = parseFloat(slider.value);
            valueDisplay.textContent = `${this.panSpeed.toFixed(2)}x`;
        });

        container.appendChild(label);
        container.appendChild(slider);
        container.appendChild(valueDisplay);

        return container;
    }
}
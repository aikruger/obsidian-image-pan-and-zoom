import { Plugin } from 'obsidian';

export default class ImageZoomDragPlugin extends Plugin {
    private activeImage: HTMLImageElement | SVGSVGElement | null = null;
    private isDragging = false;
    private initialX = 0;
    private initialY = 0;
    private offsetX = 0;
    private offsetY = 0;
    private scale = 1;

    async onload() {
        this.registerDomEvent(document, 'click', this.handleImageClick.bind(this));
        this.registerDomEvent(document, 'wheel', this.handleWheel.bind(this), { passive: false });
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mousemove', this.handleMouseMove.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));
        this.registerDomEvent(document, 'dblclick', this.handleDoubleClick.bind(this));
    }

    onunload() {
        // Event listeners are automatically removed by registerDomEvent
    }

    handleImageClick(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        const imageOrSvg = target.closest('img, svg');

        if (imageOrSvg && (imageOrSvg instanceof HTMLImageElement || imageOrSvg instanceof SVGSVGElement)) {
            const viewContent = imageOrSvg.closest('.workspace-leaf-content');
            if (!viewContent) return;

            if (this.activeImage && this.activeImage !== imageOrSvg) {
                this.resetImage(this.activeImage);
            }
            this.activeImage = imageOrSvg;
            if (this.activeImage) {
                this.activeImage.classList.add('image-zoom-drag-active');
                this.activeImage.parentElement?.classList.add('image-zoom-drag-parent-active');
                this.activeImage.style.cursor = 'grab';
            }
        }
    }

    handleWheel(evt: WheelEvent) {
        if (!this.activeImage) return;

        evt.preventDefault();

        const scaleAmount = 0.1;
        if (evt.deltaY < 0) {
            this.scale += scaleAmount;
        } else {
            this.scale = Math.max(0.1, this.scale - scaleAmount);
        }

        this.updateTransform();
    }

    handleMouseDown(evt: MouseEvent) {
        if (this.activeImage && this.activeImage.contains(evt.target as Node)) {
            this.isDragging = true;
            this.initialX = evt.clientX - this.offsetX;
            this.initialY = evt.clientY - this.offsetY;
            this.activeImage.style.cursor = 'grabbing';
        }
    }

    handleMouseMove(evt: MouseEvent) {
        if (this.isDragging && this.activeImage) {
            this.offsetX = evt.clientX - this.initialX;
            this.offsetY = evt.clientY - this.initialY;
            this.updateTransform();
        }
    }

    handleMouseUp() {
        if (this.isDragging && this.activeImage) {
            this.isDragging = false;
            this.activeImage.style.cursor = 'grab';
        }
    }

    handleDoubleClick(evt: MouseEvent) {
        if (this.activeImage && this.activeImage.contains(evt.target as Node)) {
            this.resetImage(this.activeImage);
            this.activeImage = null;
        }
    }

    updateTransform() {
        if (!this.activeImage) return;
        this.activeImage.style.transform = `scale(${this.scale}) translate(${this.offsetX}px, ${this.offsetY}px)`;
        this.activeImage.style.transition = 'transform 0.1s ease-out';
    }

    resetImage(image: HTMLImageElement | SVGSVGElement) {
        image.style.transform = '';
        image.style.cursor = 'default';
        image.style.transition = '';
        image.classList.remove('image-zoom-drag-active');
        image.parentElement?.classList.remove('image-zoom-drag-parent-active');
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
    }
}
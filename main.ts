import { Plugin, App, PluginSettingTab, Setting, Notice, TFile, FileSystemAdapter } from 'obsidian';

interface ImageZoomSettings {
    externalEditorPath: string;
    useSystemDefault: boolean;
}

const DEFAULT_SETTINGS: ImageZoomSettings = {
    externalEditorPath: '',
    useSystemDefault: true
}

export default class ImageZoomDragPlugin extends Plugin {
    settings: ImageZoomSettings;
    private activeImage: HTMLImageElement | SVGSVGElement | null = null;
    private isDragging = false;
    private initialX = 0;
    private initialY = 0;
    private offsetX = 0;
    private offsetY = 0;
    private scale = 1;
    private resetButton: HTMLButtonElement | null = null;
    private isMouseInFrame = false;
    private isSvg = false;
    private originalViewBox: { x: number; y: number; width: number; height: number; } | null = null;
    private svgViewBox: { x: number; y: number; width: number; height: number; } | null = null;
    private resizeObserver: ResizeObserver | null = null;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new ImageZoomSettingTab(this.app, this));

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

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.activeImage && this.activeImage instanceof HTMLImageElement) {
                    const imageSrc = this.activeImage.getAttribute('src');
                    if (!imageSrc) return;

                    const sanitizedSrc = decodeURIComponent(imageSrc.split('?')[0]);

                    if (file.path === sanitizedSrc) {
                        // Refresh the image
                        const timestamp = new Date().getTime();
                        this.activeImage.src = file.path + '?t=' + timestamp;
                    }
                }
            })
        );
    }

    onunload() {
        // Event listeners are automatically removed by registerDomEvent
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async openImageInExternalEditor(imageElement: HTMLImageElement) {
        let imageSrc = imageElement.getAttribute('src');
        if (!imageSrc) return;

        // Remove query parameters
        imageSrc = decodeURIComponent(imageSrc.split('?')[0]);

        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            new Notice('This feature is only available on the desktop app.');
            return;
        }

        // Extract just the filename from the src
        const filename = imageSrc.split('/').pop();

        // Search vault for this filename
        let file = this.app.vault.getAbstractFileByPath(imageSrc);

        // If not found as direct path, search by name
        if (!file) {
            const allFiles = this.app.vault.getFiles();
            file = allFiles.find(f => f.name === filename) || null;
        }

        if (!file) {
            new Notice('Could not locate image file: ' + filename);
            return;
        }

        // Now we have the correct TFile, get its full path
        const imagePath = adapter.getFullPath(file.path);

        console.log("Image src:", imageSrc);
        console.log("Found file:", file ? file.path : "NOT FOUND");
        console.log("Full path:", imagePath);

        if (this.settings.useSystemDefault) {
            require('electron').shell.openPath(imagePath);
        } else {
            const editorPath = this.settings.externalEditorPath;
            if (!editorPath) {
                new Notice('Please configure external editor path in settings');
                return;
            }
            const { spawn } = require('child_process');
            try {
                spawn(editorPath, [imagePath], { detached: true, stdio: 'ignore' }).unref();
                new Notice('Image opened in external editor');
            } catch (h) {
                new Notice('Failed to open external editor: ' + h.message);
                console.error('External editor error:', h);
            }
        }
    }

    handleImageClick(e: MouseEvent) {
        const target = (e.target as HTMLElement).closest('img, svg');

        if (target && (target instanceof HTMLImageElement || target instanceof SVGSVGElement)) {
            const workspaceSplit = target.closest('.workspace-split');
            if (!workspaceSplit) return;

            // Check if it has sidebar modifiers
            if (workspaceSplit.classList.contains('mod-left-split') ||
                workspaceSplit.classList.contains('mod-right-split')) {
                return; // Exit if in sidebar
            }

            // Ensure it's in a valid content area
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
                    const svg = this.activeImage as SVGSVGElement;
                    const viewBox = svg.getAttribute('viewBox');
                    if (viewBox) {
                        this.originalViewBox = this.parseViewBox(viewBox);
                        if (this.originalViewBox) {
                            this.svgViewBox = { ...this.originalViewBox };
                        }
                    }
                    this.setupDynamicResize(svg);
                }
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

    fitSvgToContainer(svg: SVGSVGElement) {
        const container = svg.closest('.workspace-leaf-content') || svg.parentElement;
        if (container) {
            const width = container.clientWidth;
            const height = container.clientHeight;
            svg.setAttribute('width', `${width}`);
            svg.setAttribute('height', `${height}`);
            svg.style.width = `${width}px`;
            svg.style.height = `${height}px`;
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        }
    }

    setupDynamicResize(svg: SVGSVGElement) {
        const container = svg.closest('.workspace-leaf-content') || svg.parentElement;
        if (container) {
            this.resizeObserver = new ResizeObserver(() => {
                this.fitSvgToContainer(svg);
            });
            this.resizeObserver.observe(container);
            this.fitSvgToContainer(svg);
        }
    }

    handleWheel(e: WheelEvent) {
        if (!this.activeImage) return;

        if (!this.isMouseWithinFrame(e)) return;

        if (!e.altKey) return;

        e.preventDefault();
        e.stopPropagation();

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

        if (this.isSvg && this.svgViewBox && this.originalViewBox) {
            const newWidth = this.originalViewBox.width / this.scale;
            const newHeight = this.originalViewBox.height / this.scale;

            this.svgViewBox.x = this.originalViewBox.x - (this.offsetX * (newWidth / this.originalViewBox.width));
            this.svgViewBox.y = this.originalViewBox.y - (this.offsetY * (newHeight / this.originalViewBox.height));
            this.svgViewBox.width = newWidth;
            this.svgViewBox.height = newHeight;
        }

        this.updateTransform();
        if (this.isSvg && this.activeImage) {
            this.fitSvgToContainer(this.activeImage as SVGSVGElement);
        }
    }

    handleMouseDown(e: MouseEvent) {
        // Only respond to left click
        if (e.button !== 0) return;

        if (this.activeImage && this.isMouseWithinFrame(e) && this.activeImage.contains(e.target as Node)) {
            // Don't start dragging if clicking on reset button or slider
            if ((e.target as HTMLElement).closest('.image-zoom-reset-btn')) {
                return;
            }

            this.isDragging = true;
            // Account for pan speed in initial position calculation
            this.initialX = e.clientX - this.offsetX;
            this.initialY = e.clientY - this.offsetY;
            this.activeImage.classList.add('is-dragging');
            e.preventDefault();
        }
    }

    handleMouseMove(e: MouseEvent) {
        if (!this.isDragging || !this.activeImage) return;

        const rect = this.activeImage.getBoundingClientRect();
        const tolerance = 50; // pixels outside image before stopping

        const isWithinBounds =
            e.clientX >= rect.left - tolerance &&
            e.clientX <= rect.right + tolerance &&
            e.clientY >= rect.top - tolerance &&
            e.clientY <= rect.bottom + tolerance;

        if (!isWithinBounds) {
            // Mouse went too far outside - stop dragging
            this.isDragging = false;
            this.activeImage.classList.remove('is-dragging');
            return;
        }

        if (this.isSvg && this.svgViewBox) {
            this.svgViewBox.x -= e.movementX * (this.svgViewBox.width / this.activeImage.getBoundingClientRect().width);
            this.svgViewBox.y -= e.movementY * (this.svgViewBox.height / this.activeImage.getBoundingClientRect().height);
        } else {
            this.offsetX += e.movementX;
            this.offsetY += e.movementY;
        }

        this.updateTransform();
        if (this.isSvg && this.activeImage) {
            this.fitSvgToContainer(this.activeImage as SVGSVGElement);
        }
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
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        if (this.isSvg && this.originalViewBox) {
            (image as SVGSVGElement).setAttribute('viewBox', `${this.originalViewBox.x} ${this.originalViewBox.y} ${this.originalViewBox.width} ${this.originalViewBox.height}`);
            image.removeAttribute('width');
            image.removeAttribute('height');
            image.style.width = '';
            image.style.height = '';
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

        if (this.activeImage instanceof HTMLImageElement) {
            const editButton = document.createElement('button');
            editButton.className = 'image-zoom-edit-btn';
            editButton.textContent = '✏️ Edit';
            editButton.title = 'Open in external editor';

            editButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.openImageInExternalEditor(this.activeImage as HTMLImageElement);
            });

            // Add to controls container
            controlsContainer.appendChild(editButton);
        }

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
        }
    }

    isMouseWithinFrame(e: MouseEvent): boolean {
        if (!this.activeImage) return false;

        const rect = this.activeImage.getBoundingClientRect();

        return (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
        );
    }
}

class ImageZoomSettingTab extends PluginSettingTab {
    plugin: ImageZoomDragPlugin;

    constructor(app: App, plugin: ImageZoomDragPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'Image Zoom & Drag Settings'});

        // Use system default toggle
        new Setting(containerEl)
            .setName('Use system default editor')
            .setDesc('Open images with the default system application')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useSystemDefault)
                .onChange(async (value) => {
                    this.plugin.settings.useSystemDefault = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide path input
                }));

        // Custom editor path (only show if not using default)
        if (!this.plugin.settings.useSystemDefault) {
            new Setting(containerEl)
                .setName('External editor path')
                .setDesc('Full path to your image editor (e.g., C:\\Windows\\System32\\mspaint.exe or /usr/bin/gimp)')
                .addText(text => text
                    .setPlaceholder('C:\\Program Files\\Adobe\\Photoshop\\photoshop.exe')
                    .setValue(this.plugin.settings.externalEditorPath)
                    .onChange(async (value) => {
                        this.plugin.settings.externalEditorPath = value;
                        await this.plugin.saveSettings();
                    }));

            // Add examples
            containerEl.createEl('div', {
                text: 'Examples:',
                cls: 'setting-item-description'
            });
            containerEl.createEl('ul', {
                cls: 'external-editor-examples'
            }).innerHTML = `
                <li><strong>MS Paint (Windows):</strong> mspaint.exe</li>
                <li><strong>Paint.NET (Windows):</strong> C:\\Program Files\\paint.net\\PaintDotNet.exe</li>
                <li><strong>GIMP (Windows):</strong> C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe</li>
                <li><strong>GIMP (Mac):</strong> /Applications/GIMP.app/Contents/MacOS/gimp</li>
                <li><strong>Preview (Mac):</strong> open -a Preview</li>
            `;
        }
    }
}
